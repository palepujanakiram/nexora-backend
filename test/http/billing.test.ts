import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { InstrumentRepository } from '../../src/data/instruments.ts';
import { admin, signIn, testApp } from '../app.ts';
import { NOW, fakeFetch, json } from '../helpers.ts';

const WEBHOOK_SECRET = 'whsec-test';
const BILLING = { BILLING_ENABLED: 'true', RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'rzp_test_secret', RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET };
const INSTRUMENT = 'NFO:CE:NIFTY:2026-10-29:2450000';
const PERIOD_END = Math.floor(NOW.getTime() / 1000) + 30 * 86_400;

async function world(opts: { billing?: boolean } = {}) {
  const razorpay = fakeFetch((url, init) => {
    if (url === 'https://api.razorpay.com/v1/subscriptions' && init.method === 'POST') {
      return json({ id: 'sub_rzp_1', status: 'created', short_url: 'https://rzp.io/i/abc' });
    }
    if (url === 'https://api.razorpay.com/v1/subscriptions/sub_rzp_1/cancel') return json({ id: 'sub_rzp_1', status: 'active', current_end: PERIOD_END });
    return json({ error: { description: 'not found' } }, 404);
  });
  const t = await testApp({ env: opts.billing === false ? {} : BILLING, fetch: razorpay });
  await t.app.inject({
    method: 'POST',
    url: '/admin/plans',
    headers: admin,
    payload: { code: 'pro', name: 'Pro', price: '499', interval: 'monthly', maxAccounts: 5, maxOrdersPerDay: 100, maxFanout: 5, brokers: ['zerodha'], razorpayPlanId: 'plan_rzp_pro' },
  });
  const base = { exchange: 'NFO' as const, type: 'CE' as const, underlying: 'NIFTY', expiry: '2026-10-29', strikePaise: 2450000, lotSize: 75, tickPaise: 5 };
  await new InstrumentRepository(t.services.db).upsertFromBroker('zerodha', [{ ...base, symbol: { nativeId: '12345', tradingSymbol: 'X', exchange: 'NFO' } }], NOW);
  const me = await signIn(t);
  const webhook = (payload: unknown, eventId: string | null, secret = WEBHOOK_SECRET) => {
    const raw = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'),
    };
    if (eventId) headers['x-razorpay-event-id'] = eventId;
    return t.app.inject({ method: 'POST', url: '/webhooks/razorpay', headers, payload: raw });
  };
  const subscriptionEvent = (status: string) => ({
    event: `subscription.${status === 'active' ? 'charged' : status}`,
    payload: { subscription: { entity: { id: 'sub_rzp_1', status, current_end: PERIOD_END } } },
  });
  let n = 0;
  const placeOn = (accountId: string) =>
    t.app.inject({
      method: 'POST',
      url: '/orders',
      headers: { ...me.headers, 'idempotency-key': `key-bill-${++n}-xyz` },
      payload: { instrumentId: INSTRUMENT, side: 'BUY', quantity: 75, orderType: 'MARKET', product: 'INTRADAY', referencePrice: '120', accountIds: [accountId] },
    });
  return { ...t, me, webhook, subscriptionEvent, placeOn, razorpay };
}

describe('plans and subscription', () => {
  it('lists plans and shows no subscription at first', async () => {
    const w = await world();
    const plans = await w.app.inject({ method: 'GET', url: '/plans', headers: w.me.headers });
    expect(plans.json().plans).toEqual([
      { code: 'pro', name: 'Pro', price: '499.00', interval: 'monthly', limits: { maxAccounts: 5, maxOrdersPerDay: 100, maxFanout: 5, brokers: ['zerodha'] } },
    ]);
    const sub = await w.app.inject({ method: 'GET', url: '/subscription', headers: w.me.headers });
    expect(sub.statusCode).toBe(200);
    expect(sub.json()).toEqual({ mode: 'exit_only', reason: 'no_subscription', warning: null, plan: null, subscription: null });
  });

  it('checks out, activates from a signed webhook, and cancels at period end', async () => {
    const w = await world();
    const checkout = await w.app.inject({ method: 'POST', url: '/subscription/checkout', headers: w.me.headers, payload: { planCode: 'pro' } });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json()).toEqual({ subscriptionId: expect.any(String), checkoutUrl: 'https://rzp.io/i/abc', status: 'created' });
    const call = w.razorpay.calls[0]!;
    expect(call.headers['Authorization']).toBe(`Basic ${Buffer.from('rzp_test_key:rzp_test_secret').toString('base64')}`);
    expect(JSON.parse(call.body!)).toMatchObject({ plan_id: 'plan_rzp_pro', total_count: 120, notes: { user_id: w.me.userId, plan_code: 'pro' } });

    const pending = await w.app.inject({ method: 'GET', url: '/subscription', headers: w.me.headers });
    expect(pending.json().subscription).toMatchObject({ status: 'created', checkoutUrl: 'https://rzp.io/i/abc' });
    expect(pending.json().mode).toBe('exit_only');

    const applied = await w.webhook(w.subscriptionEvent('active'), 'evt_1');
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toEqual({ processed: true });
    const replayed = await w.webhook(w.subscriptionEvent('active'), 'evt_1');
    expect(replayed.json()).toEqual({ processed: false });

    const active = await w.app.inject({ method: 'GET', url: '/subscription', headers: w.me.headers });
    expect(active.json()).toMatchObject({
      mode: 'full',
      reason: 'active',
      plan: { code: 'pro' },
      subscription: { status: 'active', currentPeriodEnd: new Date(PERIOD_END * 1000).toISOString(), checkoutUrl: null, cancelAtPeriodEnd: false },
    });

    const again = await w.app.inject({ method: 'POST', url: '/subscription/checkout', headers: w.me.headers, payload: { planCode: 'pro' } });
    expect(again.statusCode).toBe(409);

    const cancelled = await w.app.inject({ method: 'POST', url: '/subscription/cancel', headers: w.me.headers });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ mode: 'full', warning: 'Your plan ends at the end of this period.', subscription: { cancelAtPeriodEnd: true } });
    expect(w.razorpay.calls.at(-1)!.url).toBe('https://api.razorpay.com/v1/subscriptions/sub_rzp_1/cancel');
  });

  it('refuses checkout for an unknown plan and cancel without a subscription', async () => {
    const w = await world();
    expect((await w.app.inject({ method: 'POST', url: '/subscription/checkout', headers: w.me.headers, payload: { planCode: 'gold' } })).statusCode).toBe(404);
    expect((await w.app.inject({ method: 'POST', url: '/subscription/checkout', headers: w.me.headers, payload: {} })).statusCode).toBe(400);
    const cancel = await w.app.inject({ method: 'POST', url: '/subscription/cancel', headers: w.me.headers });
    expect(cancel.statusCode).toBe(404);
    expect(cancel.json().error.message).toBe('No subscription to cancel.');
  });

  it('answers 503 billing_unavailable when Razorpay is not configured', async () => {
    const w = await world({ billing: false });
    const res = await w.app.inject({ method: 'POST', url: '/subscription/checkout', headers: w.me.headers, payload: { planCode: 'pro' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('billing_unavailable');
    expect((await w.webhook(w.subscriptionEvent('active'), 'evt_1')).statusCode).toBe(503);
  });
});

describe('POST /webhooks/razorpay', () => {
  it('refuses a bad or missing signature, and a missing event id', async () => {
    const w = await world();
    const bad = await w.webhook(w.subscriptionEvent('active'), 'evt_1', 'wrong-secret');
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: { code: 'bad_signature', message: 'Webhook signature does not match.' } });
    const unsigned = await w.app.inject({ method: 'POST', url: '/webhooks/razorpay', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(unsigned.statusCode).toBe(401);
    const noId = await w.webhook(w.subscriptionEvent('active'), null);
    expect(noId.statusCode).toBe(400);
    expect(noId.json().error.message).toBe('Missing X-Razorpay-Event-Id.');
  });

  it('acknowledges an event for a subscription it does not know', async () => {
    const w = await world();
    const res = await w.webhook({ event: 'payment.captured', payload: {} }, 'evt_9');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ processed: true });
  });
});

describe('entitlement in the order path', () => {
  it('needs a subscription to place, but cancel and exit always work', async () => {
    const w = await world();
    const paper = (await w.app.inject({ method: 'POST', url: '/broker-accounts', headers: w.me.headers, payload: { broker: 'zerodha', label: 'Paper' } })).json()
      .account.id;

    const refused = await w.placeOn(paper);
    expect(refused.statusCode).toBe(402);
    expect(refused.json().error).toEqual({
      code: 'subscription_required',
      message: 'Placing new orders needs an active subscription. You can still cancel and exit.',
      details: { mode: 'exit_only', reason: 'no_subscription', required_plan: 'pro', upgrade_url: 'https://nexora.test/plans' },
    });

    await w.app.inject({ method: 'POST', url: '/subscription/checkout', headers: w.me.headers, payload: { planCode: 'pro' } });
    await w.webhook(w.subscriptionEvent('active'), 'evt_1');
    const placed = await w.placeOn(paper);
    expect(placed.statusCode).toBe(207);
    const parentId = placed.json().parentOrderId;

    await w.webhook(w.subscriptionEvent('expired'), 'evt_2');
    expect((await w.placeOn(paper)).statusCode).toBe(402);

    const cancel = await w.app.inject({ method: 'POST', url: `/orders/${parentId}/cancel`, headers: { ...w.me.headers, 'idempotency-key': 'key-bill-cancel' }, payload: {} });
    expect(cancel.statusCode).toBe(207);
    const exit = await w.app.inject({ method: 'POST', url: `/orders/${parentId}/exit`, headers: { ...w.me.headers, 'idempotency-key': 'key-bill-exit1' }, payload: {} });
    expect(exit.statusCode).toBe(207);
    expect(exit.json().legs[0].outcome).toBe('exit_placed');
  });
});
