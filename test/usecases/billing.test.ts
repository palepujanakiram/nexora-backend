import { describe, expect, it } from 'vitest';

import { RazorpayClient, toSubscription } from '../../src/brokers/razorpay.ts';
import { BillingRepository, type Plan } from '../../src/data/billing.ts';
import { hmacSha256 } from '../../src/data/crypto.ts';
import { subscriptionStatus } from '../../src/usecases/billing.ts';
import type { StreamEvent } from '../../src/usecases/events.ts';
import { harness } from '../app.ts';
import { fakeFetch, json, jsonOf, NOW } from '../helpers.ts';

const WEBHOOK_SECRET = 'whsec_test';
const BILLING_ENV = {
  BILLING_ENABLED: 'true',
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret',
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

const PRO: Plan = {
  code: 'pro',
  name: 'Pro',
  pricePaise: 99_900,
  interval: 'monthly',
  maxAccounts: 2,
  maxOrdersPerDay: 50,
  maxFanout: 2,
  brokers: ['zerodha', 'upstox'],
  razorpayPlanId: 'plan_rp_pro',
  active: true,
};

/** A tiny Razorpay: create and cancel subscriptions, or fail in a chosen way. */
function razorpay() {
  const state = { mode: 'ok' as 'ok' | 'error' | 'down' | 'html', seq: 0 };
  const fetch = fakeFetch((url) => {
    if (state.mode === 'down') throw new TypeError('fetch failed');
    if (state.mode === 'error') return json({ error: { code: 'BAD_REQUEST_ERROR', description: 'The plan id is invalid' } }, 400);
    if (state.mode === 'html') return new Response('<html>Bad gateway</html>', { status: 400 });
    const cancel = /\/subscriptions\/([^/]+)\/cancel$/.exec(url);
    if (cancel) return json({ id: decodeURIComponent(cancel[1]!), status: 'active', current_end: 1_800_000_000 });
    return json({ id: `sub_rp_${++state.seq}`, status: 'created', short_url: `https://rzp.io/i/${state.seq}` });
  });
  return { state, fetch };
}

async function world(env: Record<string, string> = BILLING_ENV) {
  const rp = razorpay();
  const h = await harness({ env, fetch: rp.fetch });
  const s = h.services;
  const repo = new BillingRepository(s.db);
  await repo.upsertPlan(PRO);
  const user = await s.identity.registerUser({ phone: '9876543210' });
  const events: StreamEvent[] = [];
  s.events.subscribe(user.id, (e) => events.push(e));
  let n = 0;
  const webhook = async (status: string | null, opts: { ref?: string; eventId?: string; currentEnd?: number; event?: string } = {}) => {
    const body = JSON.stringify({
      event: opts.event ?? `subscription.${status}`,
      payload:
        status === null
          ? { payment: { entity: { id: 'pay_1' } } }
          : { subscription: { entity: { id: opts.ref ?? 'sub_rp_1', status, ...(opts.currentEnd ? { current_end: opts.currentEnd } : {}) } } },
    });
    return s.billing.webhook(body, hmacSha256(WEBHOOK_SECRET, body), opts.eventId ?? `evt_${++n}`);
  };
  return { ...h, s, rp, repo, user, events, webhook };
}

describe('subscriptionStatus', () => {
  it('maps every Razorpay status', () => {
    expect(
      Object.fromEntries(['active', 'pending', 'halted', 'paused', 'cancelled', 'completed', 'expired', 'created', 'authenticated', ''].map((s) => [s, subscriptionStatus(s)])),
    ).toEqual({
      active: 'active',
      pending: 'past_due',
      halted: 'halted',
      paused: 'halted',
      cancelled: 'cancelled',
      completed: 'expired',
      expired: 'expired',
      created: 'created',
      authenticated: 'created',
      '': 'created',
    });
  });

  it('reads a Razorpay subscription entity', () => {
    expect(toSubscription({ id: 'sub_1', status: 'active', short_url: 'https://rzp.io/i/x', current_end: 1_800_000_000 })).toEqual({
      id: 'sub_1',
      status: 'active',
      shortUrl: 'https://rzp.io/i/x',
      currentEnd: new Date(1_800_000_000_000),
    });
    expect(toSubscription({ id: 'sub_2' })).toEqual({ id: 'sub_2', status: '', shortUrl: null, currentEnd: null });
  });
});

describe('plans', () => {
  it('lists active plans with limits and price in rupees', async () => {
    const w = await world();
    await w.s.billing.upsertPlan({ ...PRO, code: 'old', active: false });
    expect(await w.s.billing.plans()).toEqual([
      { code: 'pro', name: 'Pro', price: '999.00', interval: 'monthly', limits: { maxAccounts: 2, maxOrdersPerDay: 50, maxFanout: 2, brokers: ['zerodha', 'upstox'] } },
    ]);
  });
});

describe('checkout', () => {
  it('creates a Razorpay subscription and stores it as created', async () => {
    const w = await world();
    const r = await w.s.billing.checkout(w.user.id, 'pro');
    expect(r).toMatchObject({ checkoutUrl: 'https://rzp.io/i/1', status: 'created' });
    const call = w.fetch.calls[0]!;
    expect(call.url).toBe('https://api.razorpay.com/v1/subscriptions');
    expect(call.headers['Authorization']).toBe(`Basic ${Buffer.from('rzp_test_key:rzp_test_secret').toString('base64')}`);
    expect(jsonOf(call)).toEqual({ plan_id: 'plan_rp_pro', total_count: 120, customer_notify: 1, notes: { user_id: w.user.id, plan_code: 'pro' } });
    const sub = await w.repo.latestSubscription(w.user.id);
    expect(sub).toMatchObject({ id: r.subscriptionId, status: 'created', providerRef: 'sub_rp_1', checkoutUrl: 'https://rzp.io/i/1' });
    // Not paid yet: exit-only, with the checkout link to finish.
    expect(await w.s.billing.current(w.user.id)).toMatchObject({
      mode: 'exit_only',
      reason: 'no_subscription',
      plan: { code: 'pro' },
      subscription: { status: 'created', checkoutUrl: 'https://rzp.io/i/1', currentPeriodEnd: null, graceUntil: null, cancelAtPeriodEnd: false },
    });
  });

  it('asks for ten years of a yearly plan', async () => {
    const w = await world();
    await w.repo.upsertPlan({ ...PRO, code: 'yearly', interval: 'yearly', razorpayPlanId: 'plan_rp_y' });
    await w.s.billing.checkout(w.user.id, 'yearly');
    expect(jsonOf(w.fetch.calls[0])['total_count']).toBe(10);
  });

  it('refuses unknown, inactive and unpriced plans', async () => {
    const w = await world();
    await w.repo.upsertPlan({ ...PRO, code: 'retired', active: false });
    await w.repo.upsertPlan({ ...PRO, code: 'draft', razorpayPlanId: null });
    await expect(w.s.billing.checkout(w.user.id, 'nope')).rejects.toMatchObject({ status: 404, message: 'No such plan.' });
    await expect(w.s.billing.checkout(w.user.id, 'retired')).rejects.toMatchObject({ status: 404 });
    await expect(w.s.billing.checkout(w.user.id, 'draft')).rejects.toMatchObject({ status: 400, message: 'This plan has no Razorpay plan id yet.' });
    expect(w.fetch.calls).toHaveLength(0);
  });

  it('refuses a second subscription while one is active, but allows one after cancelling', async () => {
    const w = await world();
    await w.s.billing.checkout(w.user.id, 'pro');
    await w.webhook('active', { currentEnd: NOW.getTime() / 1000 + 30 * 86_400 });
    await expect(w.s.billing.checkout(w.user.id, 'pro')).rejects.toMatchObject({ status: 409, message: 'You already have an active subscription.' });
    await w.s.billing.cancel(w.user.id);
    await expect(w.s.billing.checkout(w.user.id, 'pro')).resolves.toMatchObject({ status: 'created' });
  });

  it('reports Razorpay errors as payment_provider_error', async () => {
    const w = await world();
    w.rp.state.mode = 'error';
    await expect(w.s.billing.checkout(w.user.id, 'pro')).rejects.toMatchObject({ status: 502, code: 'payment_provider_error', message: 'Razorpay: The plan id is invalid' });
    w.rp.state.mode = 'html';
    await expect(w.s.billing.checkout(w.user.id, 'pro')).rejects.toMatchObject({ status: 502, message: 'Razorpay: HTTP 400' });
    w.rp.state.mode = 'down';
    await expect(w.s.billing.checkout(w.user.id, 'pro')).rejects.toMatchObject({ status: 502, message: "Couldn't reach Razorpay. Try again." });
    expect(await w.repo.latestSubscription(w.user.id)).toBeNull();
  });
});

describe('cancel', () => {
  it('cancels at the end of the cycle and keeps trading allowed until then', async () => {
    const w = await world();
    await w.s.billing.checkout(w.user.id, 'pro');
    const end = NOW.getTime() / 1000 + 10 * 86_400;
    await w.webhook('active', { currentEnd: end });
    const r = await w.s.billing.cancel(w.user.id);
    expect(w.fetch.calls.at(-1)).toMatchObject({ url: 'https://api.razorpay.com/v1/subscriptions/sub_rp_1/cancel', method: 'POST' });
    expect(jsonOf(w.fetch.calls.at(-1))).toEqual({ cancel_at_cycle_end: 1 });
    expect(r).toMatchObject({
      mode: 'full',
      reason: 'active',
      warning: 'Your plan ends at the end of this period.',
      subscription: { cancelAtPeriodEnd: true, currentPeriodEnd: new Date(end * 1000).toISOString(), checkoutUrl: null },
    });
  });

  it('refuses when there is nothing to cancel', async () => {
    const w = await world();
    await expect(w.s.billing.cancel(w.user.id)).rejects.toMatchObject({ status: 404, message: 'No subscription to cancel.' });
    await w.s.billing.checkout(w.user.id, 'pro');
    await w.webhook('cancelled');
    await expect(w.s.billing.cancel(w.user.id)).rejects.toMatchObject({ status: 404 });
    await w.webhook('expired', { eventId: 'evt_x' });
    await expect(w.s.billing.cancel(w.user.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('webhook', () => {
  it('activates the subscription, invalidates the cached entitlement and tells the user', async () => {
    const w = await world();
    await w.s.billing.checkout(w.user.id, 'pro');
    expect((await w.s.entitlements.check(w.user.id)).mode).toBe('exit_only');
    const end = NOW.getTime() / 1000 + 30 * 86_400;
    expect(await w.webhook('active', { currentEnd: end })).toEqual({ processed: true });
    expect(await w.repo.latestSubscription(w.user.id)).toMatchObject({ status: 'active', currentPeriodEnd: new Date(end * 1000), graceUntil: null });
    // Cached for 30 s, but the webhook dropped the cache.
    expect((await w.s.entitlements.check(w.user.id)).mode).toBe('full');
    expect(w.events).toEqual([{ type: 'entitlement', mode: 'full' }]);
    const sub = (await w.repo.latestSubscription(w.user.id))!;
    expect((await w.repo.paymentEvents(sub.id)).map((e) => e.type)).toEqual(['subscription.active']);
  });

  it('acknowledges a replayed event without applying it again', async () => {
    const w = await world();
    await w.s.billing.checkout(w.user.id, 'pro');
    expect(await w.webhook('active', { eventId: 'evt_same', currentEnd: NOW.getTime() / 1000 + 86_400 })).toEqual({ processed: true });
    expect(await w.webhook('halted', { eventId: 'evt_same' })).toEqual({ processed: false });
    expect((await w.repo.latestSubscription(w.user.id))!.status).toBe('active');
    expect(w.events).toHaveLength(1);
  });

  it('starts a grace period when a payment fails, keeps it, and clears it once paid', async () => {
    const w = await world();
    await w.s.billing.checkout(w.user.id, 'pro');
    const end = NOW.getTime() / 1000 + 86_400;
    await w.webhook('active', { currentEnd: end });
    await w.webhook('pending');
    const grace = new Date(NOW.getTime() + 3 * 86_400_000);
    expect(await w.repo.latestSubscription(w.user.id)).toMatchObject({ status: 'past_due', graceUntil: grace, currentPeriodEnd: new Date(end * 1000) });
    w.clock.advance(86_400_000);
    await w.webhook('halted');
    // The grace period runs from the first failure, not the latest.
    expect(await w.repo.latestSubscription(w.user.id)).toMatchObject({ status: 'halted', graceUntil: grace });
    expect(w.events.at(-1)).toEqual({ type: 'entitlement', mode: 'full' });
    w.clock.advance(3 * 86_400_000);
    await w.webhook('halted');
    expect(w.events.at(-1)).toEqual({ type: 'entitlement', mode: 'exit_only' });
    await w.webhook('active', { currentEnd: w.clock().getTime() / 1000 + 30 * 86_400 });
    expect(await w.repo.latestSubscription(w.user.id)).toMatchObject({ status: 'active', graceUntil: null });
    expect(w.events.at(-1)).toEqual({ type: 'entitlement', mode: 'full' });
  });

  it('keeps the grace date on states other than active and lapsing', async () => {
    const w = await world();
    await w.s.billing.checkout(w.user.id, 'pro');
    await w.webhook('pending');
    const grace = (await w.repo.latestSubscription(w.user.id))!.graceUntil;
    await w.webhook('cancelled');
    expect(await w.repo.latestSubscription(w.user.id)).toMatchObject({ status: 'cancelled', graceUntil: grace });
    await w.webhook('completed');
    expect((await w.repo.latestSubscription(w.user.id))!.status).toBe('expired');
  });

  it('records events for unknown subscriptions or without one, without applying them', async () => {
    const w = await world();
    expect(await w.webhook('active', { ref: 'sub_rp_unknown' })).toEqual({ processed: true });
    expect(await w.webhook(null, { event: 'payment.captured' })).toEqual({ processed: true });
    const rows = await w.s.db.query<{ type: string; subscription_id: string | null }>('SELECT type, subscription_id FROM payment_events ORDER BY id');
    expect(rows).toEqual([
      { type: 'subscription.active', subscription_id: null },
      { type: 'payment.captured', subscription_id: null },
    ]);
    expect(w.events).toEqual([]);
  });

  it('labels a body without an event name as unknown', async () => {
    const w = await world();
    const body = JSON.stringify({ payload: {} });
    expect(await w.s.billing.webhook(body, hmacSha256(WEBHOOK_SECRET, body), 'evt_1')).toEqual({ processed: true });
    expect(await w.s.db.query('SELECT type FROM payment_events')).toEqual([{ type: 'unknown' }]);
  });

  it('refuses bad signatures, a missing event id and bodies that are not JSON', async () => {
    const w = await world();
    const body = '{"event":"subscription.active"}';
    await expect(w.s.billing.webhook(body, undefined, 'evt_1')).rejects.toMatchObject({ status: 401, code: 'bad_signature' });
    await expect(w.s.billing.webhook(body, hmacSha256('wrong', body), 'evt_1')).rejects.toMatchObject({ status: 401, code: 'bad_signature' });
    await expect(w.s.billing.webhook(body, hmacSha256(WEBHOOK_SECRET, body), undefined)).rejects.toMatchObject({
      status: 400,
      message: 'Missing X-Razorpay-Event-Id.',
    });
    const garbage = 'not json';
    await expect(w.s.billing.webhook(garbage, hmacSha256(WEBHOOK_SECRET, garbage), 'evt_1')).rejects.toMatchObject({
      status: 400,
      message: 'Webhook body is not JSON.',
    });
    expect(await w.s.db.query('SELECT 1 FROM payment_events')).toEqual([]);
  });
});

describe('billing off', () => {
  it('answers 503 billing_unavailable for anything that needs Razorpay', async () => {
    const w = await world({});
    const unavailable = { status: 503, code: 'billing_unavailable' };
    await expect(w.s.billing.checkout(w.user.id, 'pro')).rejects.toMatchObject(unavailable);
    await expect(w.s.billing.cancel(w.user.id)).rejects.toMatchObject(unavailable);
    await expect(w.s.billing.webhook('{}', 'sig', 'evt')).rejects.toMatchObject(unavailable);
    expect(await w.s.billing.current(w.user.id)).toMatchObject({ mode: 'full', reason: 'billing_disabled', subscription: null, plan: { code: 'unlimited' } });
  });
});

describe('RazorpayClient', () => {
  it('checks webhook signatures in constant time', () => {
    const client = new RazorpayClient({ fetch: fakeFetch(() => json({})), keyId: 'k', keySecret: 's', webhookSecret: 'w' });
    expect(client.verifyWebhook('body', hmacSha256('w', 'body'))).toBe(true);
    expect(client.verifyWebhook('body', hmacSha256('w', 'other'))).toBe(false);
  });
});
