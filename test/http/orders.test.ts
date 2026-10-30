import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { sha256 } from '../../src/data/crypto.ts';
import { InstrumentRepository } from '../../src/data/instruments.ts';
import { admin, signIn, testApp } from '../app.ts';
import { FakeKite, brokerWorld } from '../fakes.ts';
import { NOW, defined, anyString, stringMatching, type ErrorBody } from '../helpers.ts';

const INSTRUMENT = 'NFO:CE:NIFTY:2026-10-29:2450000';

async function seedInstrument(t: Awaited<ReturnType<typeof testApp>>) {
  const base = { exchange: 'NFO' as const, type: 'CE' as const, underlying: 'NIFTY', expiry: '2026-10-29', strikePaise: 2450000, lotSize: 75, tickPaise: 5 };
  await new InstrumentRepository(t.services.db).upsertFromBroker(
    'zerodha',
    [{ ...base, symbol: { nativeId: '12345', tradingSymbol: 'NIFTY26O2924500CE', exchange: 'NFO' } }],
    NOW,
  );
}

async function world(opts: { seed?: boolean } = {}) {
  const kite = new FakeKite();
  const t = await testApp({ env: { LIVE_TRADING: 'true' }, fetch: brokerWorld(kite) });
  if (opts.seed !== false) await seedInstrument(t);
  const me = await signIn(t);
  const tomorrow = new Date(NOW.getTime() + 86_400_000);
  const live = async (label: string, apiKey: string, apiSecret: string) => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/broker-accounts',
      headers: me.headers,
      payload: { broker: 'zerodha', label, mode: 'live', credentials: { apiKey, apiSecret } },
    });
    const id = res.json<{ account: { id: string } }>().account.id;
    await t.services.gateway.saveToken(id, { accessToken: 'AT', refreshToken: null, expiresAt: tomorrow });
    return id;
  };
  const kiteA = await live('Kite A', 'kiteA', 'secretA');
  const kiteB = await live('Kite B', 'kiteB', 'secretB');
  const paper = (await t.app.inject({ method: 'POST', url: '/broker-accounts', headers: me.headers, payload: { broker: 'zerodha', label: 'Paper' } })).json<{ account: { id: string } }>()
    .account.id;
  const order = (accountIds: string[], over: Record<string, unknown> = {}) => ({
    instrumentId: INSTRUMENT,
    side: 'BUY',
    quantity: 150,
    orderType: 'LIMIT',
    product: 'CARRYFORWARD',
    price: '420.00',
    referencePrice: '419.50',
    accountIds,
    ...over,
  });
  const post = async (url: string, key: string | null, payload: unknown) =>
    t.app.inject({ method: 'POST', url, headers: key ? { ...me.headers, 'idempotency-key': key } : me.headers, payload: payload as object });
  return { ...t, kite, me, kiteA, kiteB, paper, order, post };
}

interface Leg { legId: string; accountId: string; status: string; brokerOrderId: string | null; error?: { code: string; message: string } }
interface Order {
  parentOrderId: string;
  status: string;
  legs: Leg[];
}
const legOf = (body: { legs: Leg[] }, accountId: string) => defined(body.legs.find((l) => l.accountId === accountId));

describe('POST /orders', () => {
  it('needs an Idempotency-Key', async () => {
    const w = await world();
    const none = await w.post('/orders', null, w.order([w.kiteA]));
    expect(none.statusCode).toBe(400);
    expect(none.json<ErrorBody>().error.message).toMatch(/Idempotency-Key/);
    expect((await w.post('/orders', 'short', w.order([w.kiteA]))).statusCode).toBe(400);
    expect(w.kite.orders.size).toBe(0);
  });

  it('validates the body before anything else', async () => {
    const w = await world();
    const res = await w.post('/orders', 'key-validate-1', w.order([], {}));
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().error.message).toBe('accountIds: Pick at least one account.');
    const price = await w.post('/orders', 'key-validate-2', w.order([w.kiteA], { price: '0' }));
    expect(price.statusCode).toBe(400);
    expect(price.json<ErrorBody>().error.message).toBe('price: must be more than 0');
  });

  it('fans out and answers 207 with one result per leg', async () => {
    const w = await world();
    w.kite.reject['kiteB'] = 'Insufficient funds. Required margin is 31500.00';
    const res = await w.post('/orders', 'key-place-0001', w.order([w.kiteA, w.kiteB]));
    expect(res.statusCode).toBe(207);
    const body = res.json<Order>();
    expect(body.status).toBe('IN_PROGRESS');
    expect(legOf(body, w.kiteA)).toMatchObject({ broker: 'zerodha', status: 'OPEN', brokerOrderId: stringMatching(/^\d+$/) });
    expect(legOf(body, w.kiteB)).toMatchObject({ status: 'REJECTED', error: { code: 'INSUFFICIENT_FUNDS' } });
    expect(w.kite.orders.size).toBe(1);
  });

  it('replays the stored answer for the same key and body, without a second broker order', async () => {
    const w = await world();
    const first = await w.post('/orders', 'key-replay-0001', w.order([w.kiteA]));
    expect(first.statusCode).toBe(207);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const again = await w.post('/orders', 'key-replay-0001', w.order([w.kiteA]));
    expect(again.statusCode).toBe(207);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(w.kite.orders.size).toBe(1);

    const different = await w.post('/orders', 'key-replay-0001', w.order([w.kiteA], { quantity: 75 }));
    expect(different.statusCode).toBe(422);
    expect(different.json<ErrorBody>().error.code).toBe('idempotency_mismatch');
    expect(w.kite.orders.size).toBe(1);
  });

  it('refuses a key whose first request is still running', async () => {
    const w = await world();
    await w.services.orders.beginIdempotent(w.me.userId, 'key-running-01', 'place', 'whatever');
    // Make the stored hash match this request, as if it were the same request still in flight.
    const body = w.order([w.kiteA]);
    const hash = sha256(JSON.stringify({ operation: 'place', params: {}, body }));
    await w.services.db.query('UPDATE idempotency_keys SET request_hash = $1 WHERE key = $2', [hash, 'key-running-01']);
    const res = await w.post('/orders', 'key-running-01', body);
    expect(res.statusCode).toBe(409);
    expect(res.json<ErrorBody>().error.code).toBe('idempotency_in_progress');
  });

  it('frees the key when the request is refused before reaching a broker', async () => {
    const w = await world({ seed: false });
    const refused = await w.post('/orders', 'key-retry-0001', w.order([w.kiteA]));
    expect(refused.statusCode).toBe(404);
    expect(refused.json<ErrorBody>().error.message).toBe(`Unknown instrument ${INSTRUMENT}. Search /instruments for the id.`);
    await seedInstrument(w);
    const retried = await w.post('/orders', 'key-retry-0001', w.order([w.kiteA]));
    expect(retried.statusCode).toBe(207);
    expect(retried.headers['idempotent-replayed']).toBeUndefined();
  });

  it('stores a 500 for the key when something unexpected fails, so a retry does not resend', async () => {
    const w = await world();
    vi.spyOn(w.services.orders, 'place').mockRejectedValueOnce(new Error('boom'));
    const res = await w.post('/orders', 'key-crash-0001', w.order([w.kiteA]));
    expect(res.statusCode).toBe(500);
    const again = await w.post('/orders', 'key-crash-0001', w.order([w.kiteA]));
    expect(again.statusCode).toBe(500);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual({ error: { code: 'internal', message: 'Check GET /orders before retrying with a new key.' } });
    expect(w.kite.orders.size).toBe(0);
  });

  it('is refused with 503 while the kill switch is on, but cancels still go out', async () => {
    const w = await world();
    const placed = (await w.post('/orders', 'key-kill-0001', w.order([w.kiteA]))).json<Order>();
    await w.app.inject({ method: 'POST', url: '/admin/kill-switch', headers: admin, payload: { on: true, reason: 'test' } });

    const refused = await w.post('/orders', 'key-kill-0002', w.order([w.kiteA]));
    expect(refused.statusCode).toBe(503);
    expect(refused.json<ErrorBody>().error).toEqual({ code: 'kill_switch', message: 'Trading is paused on this server: test. Cancels still work.' });
    expect(w.kite.orders.size).toBe(1);

    const cancelled = await w.post(`/orders/${placed.parentOrderId}/cancel`, 'key-kill-0003', {});
    expect(cancelled.statusCode).toBe(207);
    expect(defined([...w.kite.orders.values()][0]).status).toBe('CANCELLED');
  });
});

describe('reading orders', () => {
  it('lists, pages, gets one and shows a leg audit trail', async () => {
    const w = await world();
    const first = (await w.post('/orders', 'key-read-0001', w.order([w.kiteA]))).json<Order>();
    w.clock.advance(60_000);
    const second = (await w.post('/orders', 'key-read-0002', w.order([w.paper], { orderType: 'MARKET', price: null }))).json<Order>();

    const all = await w.app.inject({ method: 'GET', url: '/orders', headers: w.me.headers });
    expect(all.statusCode).toBe(200);
    expect(all.json<{ orders: Order[] }>().orders.map((o) => o.parentOrderId)).toEqual([second.parentOrderId, first.parentOrderId]);
    const one = await w.app.inject({ method: 'GET', url: '/orders?limit=1', headers: w.me.headers });
    expect(one.json<{ orders: Order[] }>().orders).toHaveLength(1);
    const before = await w.app.inject({ method: 'GET', url: `/orders?before=${encodeURIComponent('2026-10-27T04:00:30.000Z')}`, headers: w.me.headers });
    expect(before.json<{ orders: Order[] }>().orders.map((o) => o.parentOrderId)).toEqual([first.parentOrderId]);
    expect((await w.app.inject({ method: 'GET', url: '/orders?limit=0', headers: w.me.headers })).statusCode).toBe(400);
    expect((await w.app.inject({ method: 'GET', url: '/orders?before=yesterday', headers: w.me.headers })).statusCode).toBe(400);

    const got = await w.app.inject({ method: 'GET', url: `/orders/${first.parentOrderId}`, headers: w.me.headers });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ parentOrderId: first.parentOrderId });
    expect((await w.app.inject({ method: 'GET', url: '/orders/po_nope', headers: w.me.headers })).statusCode).toBe(404);

    const legId = defined(first.legs[0]).legId;
    const events = await w.app.inject({ method: 'GET', url: `/orders/${first.parentOrderId}/legs/${legId}/events`, headers: w.me.headers });
    expect(events.statusCode).toBe(200);
    const list = events.json<{ events: { action: string; at: string }[] }>().events;
    expect(list.map((e) => e.action)).toEqual(['create', 'place', 'reconcile']);
    expect(defined(list[0]).at).toBe('2026-10-27T04:00:00.000Z');
    expect(events.body).not.toContain('secretA');
    const wrong = await w.app.inject({ method: 'GET', url: `/orders/${second.parentOrderId}/legs/${legId}/events`, headers: w.me.headers });
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json<ErrorBody>().error.message).toBe('Leg not found.');
  });
});

describe('changing orders', () => {
  it('modifies, cancels and exits with 207, each needing a key', async () => {
    const w = await world();
    const placed = (await w.post('/orders', 'key-change-001', w.order([w.kiteA]))).json<Order>();
    const id = placed.parentOrderId;

    expect((await w.post(`/orders/${id}/modify`, null, { price: '421.00' })).statusCode).toBe(400);
    const empty = await w.post(`/orders/${id}/modify`, 'key-change-002', {});
    expect(empty.statusCode).toBe(400);
    expect(empty.json<ErrorBody>().error.message).toBe('Give at least one of quantity, price, triggerPrice or orderType.');
    // Refused up front, so the key is free again.
    const modified = await w.post(`/orders/${id}/modify`, 'key-change-002', { price: '421.00' });
    expect(modified.statusCode).toBe(207);
    expect(defined([...w.kite.orders.values()][0]).price).toBe(421);

    expect((await w.post(`/orders/${id}/cancel`, null, {})).statusCode).toBe(400);
    const cancelled = await w.post(`/orders/${id}/cancel`, 'key-change-003', { accountIds: [w.kiteA] });
    expect(cancelled.statusCode).toBe(207);
    expect(legOf(cancelled.json<Order>(), w.kiteA).status).toBe('CANCELLED');

    expect((await w.post(`/orders/${id}/exit`, null, {})).statusCode).toBe(400);
    const exited = await w.post(`/orders/${id}/exit`, 'key-change-004', {});
    expect(exited.statusCode).toBe(207);
    expect(exited.json()).toMatchObject({ parentOrderId: id, legs: [{ accountId: w.kiteA, outcome: 'nothing_to_exit', reason: 'Nothing was filled.' }] });

    const subset = await w.post(`/orders/${id}/cancel`, 'key-change-005', { accountIds: [w.kiteB] });
    expect(subset.statusCode).toBe(400);
    expect(subset.json<ErrorBody>().error.message).toBe(`This order has no leg on account ${w.kiteB}.`);
  });

  it('exits a filled paper order', async () => {
    const w = await world();
    const placed = (await w.post('/orders', 'key-exit-0001', w.order([w.paper], { orderType: 'MARKET', price: null }))).json<Order>();
    expect(placed).toMatchObject({ status: 'COMPLETE', legs: [{ status: 'FILLED', filledQty: 150, avgPrice: '419.50' }] });
    const exited = await w.post(`/orders/${placed.parentOrderId}/exit`, 'key-exit-0002', {});
    expect(exited.statusCode).toBe(207);
    expect(exited.json()).toMatchObject({ exitOrderId: anyString(), legs: [{ accountId: w.paper, outcome: 'exit_placed' }] });
  });
});

describe('POST /webhooks/zerodha', () => {
  it('matches a signed postback to its leg, and refuses a bad signature', async () => {
    const w = await world();
    const placed = (await w.post('/orders', 'key-hook-0001', w.order([w.kiteA]))).json<Order>();
    const orderId = defined(defined(placed.legs[0]).brokerOrderId);
    const ts = '2026-10-27 09:31:00';
    w.kite.fillOrder(orderId, 420);

    const bad = await w.app.inject({ method: 'POST', url: '/webhooks/zerodha', payload: { order_id: orderId, order_timestamp: ts, checksum: 'f'.repeat(64) } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json<ErrorBody>().error.code).toBe('bad_signature');

    const checksum = createHash('sha256').update(`${orderId}${ts}secretA`).digest('hex');
    const ok = await w.app.inject({ method: 'POST', url: '/webhooks/zerodha', payload: { order_id: orderId, order_timestamp: ts, checksum } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ matched: true });
    const after = await w.app.inject({ method: 'GET', url: `/orders/${placed.parentOrderId}`, headers: w.me.headers });
    expect(defined(after.json<Order>().legs[0]).status).toBe('FILLED');
  });
});
