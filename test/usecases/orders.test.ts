import { describe, expect, it } from 'vitest';

import { InstrumentRepository } from '../../src/data/instruments.ts';
import { OrderRepository } from '../../src/data/orders.ts';
import { BrokerAccountRepository } from '../../src/data/broker-accounts.ts';
import { AppError } from '../../src/domain/errors.ts';
import type { StreamEvent } from '../../src/usecases/events.ts';
import type { PlaceInput } from '../../src/usecases/orders.ts';
import { harness } from '../app.ts';
import { FakeKite, FakeUpstox, brokerWorld } from '../fakes.ts';
import { NOW, defined } from '../helpers.ts';

const INSTRUMENT = 'NFO:CE:NIFTY:2026-10-29:2450000';

async function world(env: Record<string, string> = {}) {
  const kite = new FakeKite();
  const upstox = new FakeUpstox();
  const h = await harness({ env: { LIVE_TRADING: 'true', ...env }, fetch: brokerWorld(kite, upstox) });
  const s = h.services;
  const instruments = new InstrumentRepository(s.db);
  const base = { exchange: 'NFO' as const, type: 'CE' as const, underlying: 'NIFTY', expiry: '2026-10-29', strikePaise: 2450000, lotSize: 75, tickPaise: 5 };
  await instruments.upsertFromBroker('zerodha', [{ ...base, symbol: { nativeId: '12345', tradingSymbol: 'NIFTY26O2924500CE', exchange: 'NFO' } }], NOW);
  await instruments.upsertFromBroker('upstox', [{ ...base, symbol: { nativeId: 'NSE_FO|54321', tradingSymbol: 'NIFTY 24500 CE', exchange: 'NSE_FO' } }], NOW);
  const user = await s.identity.registerUser({ phone: '9876543210' });
  const events: StreamEvent[] = [];
  s.events.subscribe(user.id, (e) => events.push(e));

  const tomorrow = new Date(NOW.getTime() + 86_400_000);
  const live = async (broker: string, label: string, credentials: Record<string, string>) => {
    const { account } = await s.brokerAccounts.link(user.id, { broker, label, mode: 'live', credentials });
    await s.gateway.saveToken(account.id, { accessToken: 'AT', refreshToken: null, expiresAt: tomorrow });
    return account.id;
  };
  const kiteA = await live('zerodha', 'Kite A', { apiKey: 'kiteA', apiSecret: 'secretA' });
  const kiteB = await live('zerodha', 'Kite B', { apiKey: 'kiteB', apiSecret: 'secretB' });
  const up = await live('upstox', 'Upstox', { apiKey: 'up', apiSecret: 'upsecret', redirectUri: 'https://x.test/cb' });
  const paper = (await s.brokerAccounts.link(user.id, { broker: 'zerodha', label: 'Paper', mode: 'paper', credentials: {} })).account.id;

  let n = 0;
  const place = async (accountIds: string[], over: Partial<PlaceInput['intent']> = {}) =>
    s.orders.place(user.id, {
      clientId: 'cl_test',
      idempotencyKey: `key-${++n}`,
      accountIds,
      intent: {
        instrumentId: INSTRUMENT,
        side: 'BUY',
        quantity: 150,
        orderType: 'LIMIT',
        product: 'CARRYFORWARD',
        pricePaise: 42000,
        triggerPaise: null,
        referencePricePaise: 41950,
        ...over,
      },
    });
  return { ...h, s, kite, upstox, user, events, kiteA, kiteB, up, paper, place, repo: new OrderRepository(s.db) };
}

const by = <T extends { accountId: string }>(legs: T[], id: string) => defined(legs.find((l) => l.accountId === id));

describe('fan-out place', () => {
  it('places one order per account and reports every leg on its own', async () => {
    const w = await world();
    w.kite.reject['kiteB'] = 'Insufficient funds. Required margin is 31500.00';
    w.upstox.down = true;

    const result = await w.place([w.kiteA, w.kiteB, w.up]);

    expect(result.status).toBe('IN_PROGRESS');
    expect(by(result.legs, w.kiteA)).toMatchObject({ broker: 'zerodha', status: 'OPEN', quantity: 150, price: '420.00', reconcileScheduled: true });
    expect(by(result.legs, w.kiteA).brokerOrderId).toMatch(/^\d+$/);
    expect(by(result.legs, w.kiteB)).toMatchObject({
      status: 'REJECTED',
      error: { code: 'INSUFFICIENT_FUNDS', message: 'Kite: Insufficient funds. Required margin is 31500.00' },
      reconcileScheduled: false,
    });
    // A 5xx on submit is never a failure: we don't know whether the broker took it.
    expect(by(result.legs, w.up)).toMatchObject({ status: 'UNKNOWN', error: { code: 'BROKER_UNAVAILABLE' }, reconcileScheduled: true });
  });

  it('sends our client reference as the broker tag and keeps the raw exchange without credentials', async () => {
    const w = await world();
    const result = await w.place([w.kiteA]);
    const leg = defined(result.legs[0]);
    const stored = defined(await w.repo.leg(leg.legId));
    expect(defined([...w.kite.orders.values()][0]).tag).toBe(stored.clientRef);
    const events = await w.repo.events(leg.legId);
    expect(events.map((e) => `${e.action}:${e.fromStatus}->${e.toStatus}`)).toEqual([
      'create:null->PENDING_SUBMIT',
      'place:PENDING_SUBMIT->SUBMITTED',
      'reconcile:SUBMITTED->OPEN',
    ]);
    expect(defined(events[1]).rawRequest).toMatchObject({ method: 'POST', url: 'https://api.kite.trade/orders/regular', body: { tag: stored.clientRef, price: '420.00' } });
    const audit = JSON.stringify(events);
    expect(audit).not.toContain('secretA');
    expect(audit).not.toContain('kiteA:AT');
  });

  it('derives COMPLETE when every leg fills, and pushes each change to the user', async () => {
    const w = await world();
    w.kite.fill['kiteA'] = 'filled';
    w.kite.fill['kiteB'] = 'filled';
    const result = await w.place([w.kiteA, w.kiteB]);
    expect(result.status).toBe('COMPLETE');
    expect(result.legs.map((l) => [l.status, l.filledQty, l.avgPrice])).toEqual([
      ['FILLED', 150, '420.00'],
      ['FILLED', 150, '420.00'],
    ]);
    expect(w.events.flatMap((e) => (e.type === 'leg' ? [e.leg['status']] : []))).toContain('FILLED');
  });

  it('derives PARTIAL when some legs fill and others are rejected', async () => {
    const w = await world();
    w.kite.fill['kiteA'] = 'filled';
    w.kite.reject['kiteB'] = 'RMS: Margin Exceeds';
    expect((await w.place([w.kiteA, w.kiteB])).status).toBe('PARTIAL');
  });

  it('derives FAILED when no leg is accepted', async () => {
    const w = await world();
    w.kite.reject['kiteA'] = 'Markets are closed right now.';
    const r = await w.place([w.kiteA]);
    expect(r).toMatchObject({ status: 'FAILED', legs: [{ status: 'REJECTED', error: { code: 'MARKET_CLOSED' } }] });
  });

  it('refuses a leg up front when its broker lacks the instrument mapping, and sends nothing for it', async () => {
    const w = await world();
    await w.s.db.query(`DELETE FROM instrument_mappings WHERE broker = 'upstox'`);
    const r = await w.place([w.kiteA, w.up]);
    expect(by(r.legs, w.up)).toMatchObject({ status: 'REJECTED', error: { code: 'INVALID_SYMBOL' } });
    expect(w.fetch.calls.some((c) => c.url.includes('upstox'))).toBe(false);
    expect(by(r.legs, w.kiteA).status).toBe('OPEN');
  });

  it('fills paper orders against the reference price, without touching any broker', async () => {
    const w = await world();
    const r = await w.place([w.paper], { orderType: 'MARKET', pricePaise: null });
    expect(r).toMatchObject({ status: 'COMPLETE', legs: [{ mode: 'paper', status: 'FILLED', filledQty: 150, avgPrice: '419.50' }] });
    expect(w.fetch.calls).toHaveLength(0);
  });

  it('logs and does not send live writes in dry-run mode', async () => {
    const w = await world({ LIVE_TRADING: 'false' });
    const r = await w.place([w.kiteA]);
    expect(r.legs[0]).toMatchObject({ status: 'REJECTED', error: { code: 'DRY_RUN' } });
    expect(w.kite.orders.size).toBe(0);
    const events = await w.repo.events(defined(r.legs[0]).legId);
    expect(defined(events.at(-1)).rawRequest).toMatchObject({ url: 'https://api.kite.trade/orders/regular', body: { quantity: '150' } });
  });

  it('marks the account for re-linking when its session has expired', async () => {
    const w = await world();
    w.clock.advance(2 * 86_400_000);
    await w.s.risk.setKillSwitch(false, null);
    const r = await w.s.orders.place(w.user.id, {
      clientId: 'c', idempotencyKey: 'k-expired', accountIds: [w.kiteA],
      intent: { instrumentId: INSTRUMENT, side: 'BUY', quantity: 75, orderType: 'LIMIT', product: 'CARRYFORWARD', pricePaise: 42000, triggerPaise: null, referencePricePaise: null },
    });
    expect(r.legs[0]).toMatchObject({ status: 'REJECTED', error: { code: 'AUTH_EXPIRED' } });
    const account = await new BrokerAccountRepository(w.s.db).find(w.kiteA);
    expect(defined(account).tokenState).toBe('needs_user_action');
    expect(w.events).toContainEqual(expect.objectContaining({ type: 'relink_needed', accountId: w.kiteA }));
  });

  it('validates the intent against the instrument', async () => {
    const w = await world();
    const fails = async (over: Partial<PlaceInput['intent']>, message: string) =>
      expect(w.place([w.kiteA], over)).rejects.toThrow(message);
    await fails({ quantity: 100 }, 'multiple of the lot size 75');
    await fails({ pricePaise: 42003 }, 'multiple of the tick size ₹0.05');
    await fails({ orderType: 'MARKET' }, 'MARKET orders take no price');
    await fails({ orderType: 'SL', triggerPaise: null }, 'SL orders need a trigger price');
    await fails({ instrumentId: 'NSE:EQ:NOPE' }, 'Unknown instrument');
    await expect(w.place(['ba_someone_else'])).rejects.toThrow('not found');
  });
});

describe('risk guards', () => {
  it('blocks every new order while the kill switch is on', async () => {
    const w = await world();
    await w.s.risk.setKillSwitch(true, 'bad fills');
    await expect(w.place([w.kiteA])).rejects.toMatchObject({ status: 503, code: 'kill_switch' });
    expect(w.kite.orders.size).toBe(0);
  });

  it('refuses outside market hours and on listed holidays', async () => {
    const w = await world();
    w.clock.set(new Date('2026-10-27T11:00:00Z')); // 16:30 IST
    await expect(w.place([w.paper])).rejects.toMatchObject({ code: 'market_closed' });
    w.clock.set(NOW);
    await w.s.settings.addHoliday('2026-10-27', 'Test holiday');
    await expect(w.place([w.paper])).rejects.toMatchObject({ code: 'market_closed' });
  });

  it('caps the value of one order and the orders per day', async () => {
    const w = await world({ RISK_MAX_NOTIONAL_RUPEES: '50000', RISK_MAX_ORDERS_PER_DAY: '2' });
    await expect(w.place([w.paper], { quantity: 150 })).rejects.toMatchObject({ code: 'max_notional' });
    await expect(w.place([w.paper], { orderType: 'MARKET', pricePaise: null, referencePricePaise: null, quantity: 75 })).rejects.toThrow('referencePrice');
    await w.place([w.paper], { quantity: 75 });
    await w.place([w.paper], { quantity: 75 });
    await expect(w.place([w.paper], { quantity: 75 })).rejects.toMatchObject({ status: 429, code: 'daily_order_cap' });
  });
});

describe('cancel', () => {
  it('cancels open legs and reports filled and rejected legs as not cancellable', async () => {
    const w = await world();
    w.kite.fill['kiteB'] = 'filled';
    const placed = await w.place([w.kiteA, w.kiteB, w.paper], { referencePricePaise: 43000 });
    w.kite.reject['x'] = '';
    const r = await w.s.orders.cancel(w.user.id, placed.parentOrderId, null);
    expect(by(r.legs, w.kiteA)).toMatchObject({ status: 'CANCELLED', outcome: 'cancelled' });
    expect(by(r.legs, w.kiteB)).toMatchObject({ status: 'FILLED', outcome: 'not_cancellable', reason: 'Already filled.' });
    expect(by(r.legs, w.paper)).toMatchObject({ status: 'CANCELLED', outcome: 'cancelled' });
    expect(r.status).toBe('PARTIAL');
    const again = await w.s.orders.cancel(w.user.id, placed.parentOrderId, [w.kiteA]);
    expect(again.legs).toEqual([expect.objectContaining({ outcome: 'not_cancellable', reason: 'Already cancelled.' })]);
  });

  it('says so when the leg filled before the cancel arrived', async () => {
    const w = await world();
    const placed = await w.place([w.kiteA]);
    w.kite.fillOrder(defined(by(placed.legs, w.kiteA).brokerOrderId), 419.95);
    const r = await w.s.orders.cancel(w.user.id, placed.parentOrderId, null);
    expect(r.legs[0]).toMatchObject({ status: 'FILLED', outcome: 'not_cancellable', avgPrice: '419.95' });
  });

  it('works while the kill switch is on, and refuses an account that has no leg', async () => {
    const w = await world();
    const placed = await w.place([w.kiteA]);
    await w.s.risk.setKillSwitch(true, null);
    expect(defined((await w.s.orders.cancel(w.user.id, placed.parentOrderId, null)).legs[0]).outcome).toBe('cancelled');
    await expect(w.s.orders.cancel(w.user.id, placed.parentOrderId, [w.up])).rejects.toThrow('no leg on account');
    await expect(w.s.orders.cancel('usr_other', placed.parentOrderId, null)).rejects.toThrow('Order not found');
  });

  it('can\'t cancel an UNKNOWN leg until the broker confirms it has it', async () => {
    const w = await world();
    w.upstox.down = true;
    const placed = await w.place([w.up]);
    const r = await w.s.orders.cancel(w.user.id, placed.parentOrderId, null);
    expect(r.legs[0]).toMatchObject({ status: 'UNKNOWN', outcome: 'unknown' });
  });
});

describe('modify', () => {
  it('changes the price on open legs of a chosen subset, confirmed by reading the order back', async () => {
    const w = await world();
    const placed = await w.place([w.kiteA, w.kiteB]);
    const r = await w.s.orders.modify(w.user.id, placed.parentOrderId, { idempotencyKey: 'm1', accountIds: [w.kiteB], pricePaise: 42500 });
    expect(r.legs).toEqual([expect.objectContaining({ accountId: w.kiteB, outcome: 'modified', price: '425.00' })]);
    const a = await w.s.orders.get(w.user.id, placed.parentOrderId);
    expect(by(a.legs, w.kiteA).price).toBe('420.00');
  });

  it('leaves partial-fill rules to the broker adapter', async () => {
    const w = await world();
    w.kite.fill['kiteA'] = 'partial';
    const placed = await w.place([w.kiteA]);
    expect(placed.legs[0]).toMatchObject({ status: 'PARTIALLY_FILLED', filledQty: 75 });
    const r = await w.s.orders.modify(w.user.id, placed.parentOrderId, { idempotencyKey: 'm', accountIds: null, quantity: 75 });
    expect(r.legs[0]).toMatchObject({ outcome: 'not_modifiable', reason: 'Quantity must be more than the 75 already filled.' });
  });

  it('refuses finished legs, bad combinations and empty changes', async () => {
    const w = await world();
    w.kite.fill['kiteA'] = 'filled';
    const placed = await w.place([w.kiteA, w.kiteB]);
    await expect(w.s.orders.modify(w.user.id, placed.parentOrderId, { idempotencyKey: 'm', accountIds: null })).rejects.toThrow('at least one');
    const r = await w.s.orders.modify(w.user.id, placed.parentOrderId, { idempotencyKey: 'm', accountIds: null, orderType: 'SL' });
    expect(by(r.legs, w.kiteA)).toMatchObject({ outcome: 'not_modifiable', reason: 'The order is filled.' });
    expect(by(r.legs, w.kiteB)).toMatchObject({ outcome: 'not_modifiable', reason: 'SL orders need a trigger price.' });
    const lot = await w.s.orders.modify(w.user.id, placed.parentOrderId, { idempotencyKey: 'm', accountIds: [w.kiteB], quantity: 100 });
    expect(defined(lot.legs[0]).reason).toContain('lot size');
  });

  it('stops exit-only users adding quantity, but lets them reduce it', async () => {
    const w = await world({ BILLING_ENABLED: 'true', RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w', ENTITLEMENT_CACHE_SECONDS: '0' });
    await w.s.db.query(`INSERT INTO plans VALUES ('pro', 'Pro', 99900, 'monthly', 10, 100, 10, ARRAY['zerodha','upstox'], 'plan_x', true)`);
    await w.s.db.query(
      `INSERT INTO subscriptions (id, user_id, plan_code, status, current_period_end, created_at, updated_at) VALUES ('sub1', $1, 'pro', 'active', $2, $3, $3)`,
      [w.user.id, new Date(NOW.getTime() + 86_400_000), NOW],
    );
    const placed = await w.place([w.kiteA], { quantity: 150 });
    await w.s.db.query(`UPDATE subscriptions SET status = 'expired'`);
    const more = await w.s.orders.modify(w.user.id, placed.parentOrderId, { idempotencyKey: 'm', accountIds: null, quantity: 225 });
    expect(defined(more.legs[0]).reason).toContain('lapsed');
    const less = await w.s.orders.modify(w.user.id, placed.parentOrderId, { idempotencyKey: 'm2', accountIds: null, quantity: 75 });
    expect(less.legs[0]).toMatchObject({ outcome: 'modified', quantity: 75 });
  });
});

describe('exit', () => {
  it('squares off what each broker says is held, not what the order asked for', async () => {
    const w = await world();
    w.kite.fill['kiteA'] = 'filled';
    w.kite.fill['kiteB'] = 'filled';
    const placed = await w.place([w.kiteA, w.kiteB]);
    // The user already sold 75 on Kite B outside the app.
    w.kite.heldOverride['kiteB'] = 75;
    w.kite.fill['kiteA'] = 'open';
    w.kite.fill['kiteB'] = 'open';

    const r = await w.s.orders.exit(w.user.id, placed.parentOrderId, 'exit-1', 'cl', null);

    expect(r.exitOrderId).toMatch(/^po_/);
    expect(by(r.legs, w.kiteA)).toMatchObject({ outcome: 'exit_placed', heldQty: 150, exitLeg: { quantity: 150, orderType: 'MARKET' } });
    expect(by(r.legs, w.kiteB)).toMatchObject({ outcome: 'exit_placed', heldQty: 75, exitLeg: { quantity: 75 } });
    const sells = [...w.kite.orders.values()].filter((o) => o.transaction_type === 'SELL');
    // Legs go out in parallel, so the broker may see them in either order.
    expect(sells.map((o) => [o.quantity, o.order_type]).sort()).toEqual([
      [150, 'MARKET'],
      [75, 'MARKET'],
    ]);
    const exitOrder = await w.s.orders.get(w.user.id, defined(r.exitOrderId));
    expect(exitOrder).toMatchObject({ kind: 'EXIT', exitOf: placed.parentOrderId, side: 'SELL', quantity: 225 });
  });

  it('never exits twice: a second exit finds nothing left', async () => {
    const w = await world();
    const placed = await w.place([w.paper], { orderType: 'MARKET', pricePaise: null });
    const [first, second] = await Promise.all([
      w.s.orders.exit(w.user.id, placed.parentOrderId, 'e1', 'cl', null),
      w.s.orders.exit(w.user.id, placed.parentOrderId, 'e2', 'cl', null),
    ]);
    const outcomes = [defined(first.legs[0]).outcome, defined(second.legs[0]).outcome].sort();
    expect(outcomes).toEqual(['exit_placed', 'nothing_to_exit']);
    const positions = await w.s.positions.live(w.user.id);
    expect(positions.find((p) => p.accountId === w.paper)).toMatchObject({ positions: [expect.objectContaining({ netQty: 0 })] });
  });

  it('cancels the unfilled remainder first, then exits what filled', async () => {
    const w = await world();
    w.kite.fill['kiteA'] = 'partial';
    const placed = await w.place([w.kiteA]);
    w.kite.fill['kiteA'] = 'open';
    const r = await w.s.orders.exit(w.user.id, placed.parentOrderId, 'e', 'cl', null);
    expect(r.legs[0]).toMatchObject({ outcome: 'exit_placed', cancelledRemainder: true, heldQty: 75, exitLeg: { quantity: 75 } });
  });

  it('reports nothing to exit for unfilled or rejected legs, and works on a lapsed subscription', async () => {
    const w = await world({ BILLING_ENABLED: 'true', RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' });
    await expect(w.place([w.kiteA])).rejects.toMatchObject({ status: 402, code: 'subscription_required' });
    // An order from before the lapse.
    const before = await world();
    before.kite.reject['kiteA'] = 'RMS: blocked';
    const placed = await before.place([before.kiteA]);
    const r = await before.s.orders.exit(before.user.id, placed.parentOrderId, 'e', 'cl', null);
    expect(r).toMatchObject({ exitOrderId: null, legs: [{ outcome: 'nothing_to_exit', reason: 'Nothing was filled.' }] });
  });

  it('exits nothing when the broker shows no position, and only entry orders can be exited', async () => {
    const w = await world();
    w.kite.fill['kiteA'] = 'filled';
    const placed = await w.place([w.kiteA]);
    w.kite.heldOverride['kiteA'] = 0;
    const r = await w.s.orders.exit(w.user.id, placed.parentOrderId, 'e', 'cl', null);
    expect(r.legs[0]).toMatchObject({ outcome: 'nothing_to_exit', heldQty: 0 });

    w.kite.heldOverride = {};
    const done = await w.s.orders.exit(w.user.id, placed.parentOrderId, 'e2', 'cl', null);
    await expect(w.s.orders.exit(w.user.id, defined(done.exitOrderId), 'e3', 'cl', null)).rejects.toThrow('Only entry orders');
  });

  it('is blocked by the kill switch', async () => {
    const w = await world();
    const placed = await w.place([w.paper], { orderType: 'MARKET', pricePaise: null });
    await w.s.risk.setKillSwitch(true, 'halt');
    await expect(w.s.orders.exit(w.user.id, placed.parentOrderId, 'e', 'cl', null)).rejects.toBeInstanceOf(AppError);
  });
});

describe('reconciliation', () => {
  it('resolves an UNKNOWN leg from the broker order book by our client reference', async () => {
    const w = await world();
    w.upstox.down = true;
    const placed = await w.place([w.up]);
    const leg = defined(await w.repo.leg(defined(placed.legs[0]).legId));
    // The order did reach Upstox after all.
    w.upstox.book.push({ order_id: 'UP77', status: 'complete', quantity: 150, filled_quantity: 150, average_price: 420.1, price: 420, tag: leg.clientRef, order_type: 'LIMIT' });
    w.clock.advance(60_000);
    expect(await w.s.reconciler.pollDue()).toBe(1);
    const after = await w.s.orders.get(w.user.id, placed.parentOrderId);
    expect(after).toMatchObject({ status: 'COMPLETE', legs: [{ status: 'FILLED', brokerOrderId: 'UP77', avgPrice: '420.10', reconcileScheduled: false }] });
    expect(after.legs[0]).not.toHaveProperty('error');
  });

  it('marks an UNKNOWN leg REJECTED once the broker clearly never received it', async () => {
    const w = await world();
    w.upstox.down = true;
    const placed = await w.place([w.up]);
    for (let i = 0; i < 6; i++) {
      w.clock.advance(10 * 60_000);
      await w.s.reconciler.pollDue();
    }
    const after = await w.s.orders.get(w.user.id, placed.parentOrderId);
    expect(after).toMatchObject({ status: 'FAILED', legs: [{ status: 'REJECTED', error: { code: 'NOT_FOUND' } }] });
  });

  it('follows open legs until they fill', async () => {
    const w = await world();
    const placed = await w.place([w.kiteA]);
    w.kite.fillOrder(defined(defined(placed.legs[0]).brokerOrderId), 419.8);
    w.clock.advance(5_000);
    await w.s.reconciler.pollDue();
    expect((await w.s.orders.get(w.user.id, placed.parentOrderId)).legs[0]).toMatchObject({ status: 'FILLED', avgPrice: '419.80' });
  });

  it('treats a signed Kite postback as a reason to re-read the order', async () => {
    const w = await world();
    const placed = await w.place([w.kiteA]);
    const id = defined(defined(placed.legs[0]).brokerOrderId);
    w.kite.fillOrder(id, 420);
    const { createHash } = await import('node:crypto');
    const body = { order_id: id, order_timestamp: '2026-10-27 09:31:00', status: 'COMPLETE' };
    const checksum = createHash('sha256').update(`${id}2026-10-27 09:31:00secretA`).digest('hex');
    await expect(w.s.reconciler.webhook('zerodha', { ...body, checksum: 'f'.repeat(64) }, {})).rejects.toMatchObject({ code: 'bad_signature' });
    expect(await w.s.reconciler.webhook('zerodha', { ...body, checksum }, {})).toEqual({ matched: true });
    expect((await w.s.orders.get(w.user.id, placed.parentOrderId)).status).toBe('COMPLETE');
    expect(await w.s.reconciler.webhook('zerodha', { ...body, order_id: '999', checksum }, {})).toEqual({ matched: false });
    await expect(w.s.reconciler.webhook('zerodha', {}, {})).rejects.toThrow('Not an order update');
    await expect(w.s.reconciler.webhook('groww', {}, {})).rejects.toThrow("doesn't send webhooks");
  });

  it('flags end-of-day mismatches for a human and lets the broker win', async () => {
    const w = await world();
    w.kite.fill['kiteA'] = 'filled';
    const placed = await w.place([w.kiteA]);
    // The broker later reports something different from what we recorded.
    const o = defined(w.kite.orders.get(defined(defined(placed.legs[0]).brokerOrderId)));
    o.status = 'CANCELLED';
    o.filled_quantity = 0;
    // And it has an order tagged by us that we have no record of.
    w.kite.orders.set('9999', { ...o, order_id: '9999', tag: 'NXDEADBEEF00000000' });
    w.clock.set(new Date('2026-10-27T10:31:00Z'));
    const result = await w.s.reconciler.endOfDay();
    expect(result).toEqual({ accounts: 1, issues: 2 });
    const issues = await w.s.reconciler.openIssues();
    expect(issues.map((i) => i.kind).sort()).toEqual(['status_mismatch', 'unknown_order']);
    expect(defined((await w.s.orders.get(w.user.id, placed.parentOrderId)).legs[0]).status).toBe('CANCELLED');
    await w.s.reconciler.resolveIssue(defined(issues[0]).id);
    expect(await w.s.reconciler.openIssues()).toHaveLength(1);
    await expect(w.s.reconciler.resolveIssue(defined(issues[0]).id)).rejects.toThrow('No open issue');
  });
});

describe('reads', () => {
  it('lists the user\'s orders newest first with their legs, and shows a leg\'s audit trail', async () => {
    const w = await world();
    const first = await w.place([w.kiteA]);
    w.clock.advance(1000);
    const second = await w.place([w.kiteA, w.kiteB]);
    const list = await w.s.orders.list(w.user.id, 10, null);
    expect(list.map((o) => [o.parentOrderId, o.legs.length])).toEqual([
      [second.parentOrderId, 2],
      [first.parentOrderId, 1],
    ]);
    expect(await w.s.orders.list(w.user.id, 10, new Date(NOW.getTime() + 500))).toHaveLength(1);
    const events = await w.s.orders.events(w.user.id, first.parentOrderId, defined(first.legs[0]).legId);
    expect(events.length).toBeGreaterThan(1);
    await expect(w.s.orders.events(w.user.id, first.parentOrderId, defined(second.legs[0]).legId)).rejects.toThrow('Leg not found');
  });
});
