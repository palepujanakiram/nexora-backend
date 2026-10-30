import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { BrokerError } from '../../src/domain/broker-error.ts';
import { GrowwAdapter, growwStatus, splitExchange, splitOrderId } from '../../src/brokers/groww/index.ts';
import type { ModifyRequest, PlaceRequest } from '../../src/brokers/adapter.ts';
import { clock, ctx, fakeFetch, json, jsonOf, NOW, text, defined } from '../helpers.ts';

const groww = new GrowwAdapter({ clock });
const SYMBOL = { nativeId: 'SENSEX26O2973100PE', tradingSymbol: 'SENSEX26O2973100PE', exchange: 'BSE:FNO' };

const place = (overrides: Partial<PlaceRequest> = {}): PlaceRequest => ({
  symbol: SYMBOL,
  side: 'BUY',
  quantity: 40,
  orderType: 'LIMIT',
  product: 'CARRYFORWARD',
  pricePaise: 42005,
  triggerPaise: null,
  clientRef: 'NXabcdefgh12345678',
  algoId: null,
  referencePricePaise: null,
  ...overrides,
});

const modify = (overrides: Partial<ModifyRequest> = {}): ModifyRequest => ({
  brokerOrderId: 'FNO:GLTFO123',
  symbol: SYMBOL,
  side: 'BUY',
  product: 'CARRYFORWARD',
  quantity: 60,
  orderType: 'LIMIT',
  pricePaise: 43000,
  triggerPaise: null,
  ...overrides,
});

const ok = (payload: unknown) => json({ status: 'SUCCESS', payload });
const fail = (status: number, message: string) => json({ status: 'FAILURE', error: { code: 'GA000', message } }, status);

async function brokerError(p: Promise<unknown>): Promise<BrokerError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BrokerError) return e;
    throw e;
  }
  throw new Error('expected a BrokerError');
}

describe('GrowwAdapter auth', () => {
  it('describes itself', () => {
    expect(groww.code).toBe('groww');
    expect(groww.label).toBe('Groww');
    expect(groww.instrumentsNeedSession).toBe(false);
    expect(groww.capabilities).toMatchObject({ webhooks: false, headlessRefresh: false, exchanges: ['NSE', 'BSE', 'NFO', 'BFO'] });
    expect(groww.credentialFields.map((f) => f.name)).toEqual(['apiKey', 'apiSecret']);
    expect('parseWebhook' in groww).toBe(false);
  });

  it('asks for an optional TOTP and points at the API keys page', async () => {
    expect(await groww.startLink()).toEqual({
      kind: 'input',
      fields: [{ name: 'totp', label: 'TOTP (optional)', secret: true, required: false }],
      message: 'Approve today\'s API key on Groww\'s API Keys page, then connect (or enter a TOTP).',
      url: 'https://groww.in/trade-api/api-keys',
    });
  });

  it('creates a token from the daily approval with a SHA-256 checksum; the session ends at 06:00 IST', async () => {
    const fetch = fakeFetch(() => json({ token: 'AT1' }));
    const tokens = await groww.completeLink(ctx(fetch), { params: {} });
    expect(tokens).toEqual({ accessToken: 'AT1', refreshToken: null, expiresAt: new Date('2026-10-28T00:30:00Z') });
    const call = defined(fetch.calls[0]);
    expect(`${call.method} ${call.url}`).toBe('POST https://api.groww.in/v1/token/api/access');
    expect(call.headers['Authorization']).toBe('Bearer key123');
    const timestamp = String(NOW.getTime() / 1000);
    expect(jsonOf(call)).toEqual({
      key_type: 'approval',
      checksum: createHash('sha256').update(`secret456${timestamp}`).digest('hex'),
      timestamp,
    });
  });

  it('creates a token from a TOTP, reading it from the payload', async () => {
    const fetch = fakeFetch(() => ok({ token: 'AT2' }));
    const tokens = await groww.completeLink(ctx(fetch), { params: { totp: ' 123456 ' } });
    expect(tokens.accessToken).toBe('AT2');
    expect(jsonOf(fetch.calls[0])).toEqual({ key_type: 'totp', totp: '123456' });
  });

  it('refuses a malformed TOTP without calling Groww', async () => {
    const fetch = fakeFetch(() => json({}));
    const e = await brokerError(groww.completeLink(ctx(fetch), { params: { totp: '12ab' } }));
    expect(e.code).toBe('AUTH_EXPIRED');
    expect(e.message).toContain('6-digit TOTP');
    expect(fetch.calls).toHaveLength(0);
  });

  it('fails the link on an error answer or a missing token, without leaking the secret', async () => {
    const denied = await brokerError(groww.completeLink(ctx(fakeFetch(() => fail(401, 'API key not approved'))), { params: {} }));
    expect(denied.code).toBe('AUTH_EXPIRED');
    expect(denied.message).toBe('Groww: API key not approved');
    expect(JSON.stringify(denied.raw)).not.toContain('secret456');
    const empty = await brokerError(groww.completeLink(ctx(fakeFetch(() => json({ payload: {} }))), { params: {} }));
    expect(empty.code).toBe('AUTH_EXPIRED');
    expect(empty.message).toContain('no access token');
    const bad = await brokerError(groww.completeLink(ctx(fakeFetch(() => fail(400, 'Bad TOTP'))), { params: { totp: '000000' } }));
    expect(bad.code).toBe('UNKNOWN');
  });

  it('always needs the user to refresh', async () => {
    expect(await groww.refreshSession()).toMatchObject({ needsUserAction: true });
  });
});

describe('GrowwAdapter orders', () => {
  it('places an order with our reference, a rupee price and the segment from the symbol', async () => {
    const fetch = fakeFetch(() => ok({ groww_order_id: 'GLTFO123', order_status: 'OPEN', order_reference_id: 'NXabcdefgh12345678' }));
    const ack = await groww.placeOrder(ctx(fetch), place());
    expect(ack.brokerOrderId).toBe('FNO:GLTFO123');
    const call = defined(fetch.calls[0]);
    expect(`${call.method} ${call.url}`).toBe('POST https://api.groww.in/v1/order/create');
    expect(call.headers).toMatchObject({ Authorization: 'Bearer AT', Accept: 'application/json', 'X-API-VERSION': '1.0', 'Content-Type': 'application/json' });
    expect(jsonOf(call)).toEqual({
      trading_symbol: 'SENSEX26O2973100PE',
      quantity: 40,
      price: 420.05,
      validity: 'DAY',
      exchange: 'BSE',
      segment: 'FNO',
      product: 'NRML',
      order_type: 'LIMIT',
      transaction_type: 'BUY',
      order_reference_id: 'NXabcdefgh12345678',
    });
    // The audit record never carries the access token.
    expect(JSON.stringify(ack.raw)).not.toContain('Bearer');
  });

  it('sends a trigger only for stop orders, and price 0 for market', async () => {
    const fetch = fakeFetch(() => ok({ groww_order_id: 'G1' }));
    const cash = { ...SYMBOL, exchange: 'NSE:CASH', tradingSymbol: 'RELIANCE', nativeId: 'RELIANCE' };
    const sl = await groww.placeOrder(ctx(fetch), place({ symbol: cash, orderType: 'SL_M', pricePaise: null, triggerPaise: 100, product: 'INTRADAY', side: 'SELL' }));
    expect(sl.brokerOrderId).toBe('CASH:G1');
    expect(jsonOf(fetch.calls[0])).toMatchObject({ exchange: 'NSE', segment: 'CASH', order_type: 'SL_M', product: 'MIS', price: 0, trigger_price: 1, transaction_type: 'SELL' });
    await groww.placeOrder(ctx(fetch), place({ orderType: 'MARKET', pricePaise: null, triggerPaise: 500, product: 'DELIVERY' }));
    expect(jsonOf(fetch.calls[1])).toMatchObject({ order_type: 'MARKET', price: 0, product: 'CNC' });
    expect(jsonOf(fetch.calls[1])).not.toHaveProperty('trigger_price');
  });

  it('refuses a symbol whose market Groww does not trade', async () => {
    const fetch = fakeFetch(() => ok({}));
    const e = await brokerError(groww.placeOrder(ctx(fetch), place({ symbol: { ...SYMBOL, exchange: 'MCX:COMM' } })));
    expect(e.code).toBe('INVALID_SYMBOL');
    expect(() => splitExchange({ ...SYMBOL, exchange: 'NFO' })).toThrow("can't trade on NFO");
    expect(fetch.calls).toHaveLength(0);
  });

  it('maps Groww errors into the shared taxonomy', async () => {
    const cases: [Response, string][] = [
      [fail(401, 'Token expired'), 'AUTH_EXPIRED'],
      [fail(403, 'Forbidden'), 'AUTH_EXPIRED'],
      [fail(400, 'Insufficient balance to place order'), 'INSUFFICIENT_FUNDS'],
      [json({ message: 'Market is closed' }, 400), 'MARKET_CLOSED'],
      [fail(400, 'Price outside circuit'), 'REJECTED_BY_EXCHANGE'],
      [fail(404, 'Not found'), 'NOT_FOUND'],
      [fail(409, 'Huh'), 'UNKNOWN'],
      [text('<html>', 400), 'REJECTED_BY_EXCHANGE'],
      [json({ status: 'FAILURE' }), 'UNKNOWN'],
      [ok({}), 'UNKNOWN'],
    ];
    for (const [res, code] of cases) {
      expect((await brokerError(groww.placeOrder(ctx(fakeFetch(() => res.clone())), place()))).code).toBe(code);
    }
    expect((await brokerError(groww.placeOrder(ctx(fakeFetch(() => text('<html>', 400))), place()))).message).toBe('Groww: HTTP 400');
  });

  it('treats a 5xx on place as an unknown outcome', async () => {
    const e = await brokerError(groww.placeOrder(ctx(fakeFetch(() => fail(503, 'down'))), place()));
    expect(e.code).toBe('BROKER_UNAVAILABLE');
    expect(e.outcomeUnknown).toBe(true);
  });

  it('modifies and cancels with the segment split out of the order id', async () => {
    const fetch = fakeFetch(() => ok({ order_status: 'MODIFICATION_REQUESTED' }));
    const m1 = await groww.modifyOrder(ctx(fetch), modify());
    const m2 = await groww.modifyOrder(ctx(fetch), modify({ brokerOrderId: 'CASH:G2', orderType: 'SL', pricePaise: 43000, triggerPaise: 42500 }));
    const c = await groww.cancelOrder(ctx(fetch), 'FNO:GLTFO123');
    expect([m1.brokerOrderId, m2.brokerOrderId, c.brokerOrderId]).toEqual(['FNO:GLTFO123', 'CASH:G2', 'FNO:GLTFO123']);
    expect(fetch.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'POST https://api.groww.in/v1/order/modify',
      'POST https://api.groww.in/v1/order/modify',
      'POST https://api.groww.in/v1/order/cancel',
    ]);
    expect(jsonOf(fetch.calls[0])).toEqual({ groww_order_id: 'GLTFO123', segment: 'FNO', quantity: 60, price: 430, order_type: 'LIMIT' });
    expect(jsonOf(fetch.calls[1])).toEqual({ groww_order_id: 'G2', segment: 'CASH', quantity: 60, price: 430, trigger_price: 425, order_type: 'SL' });
    expect(jsonOf(fetch.calls[2])).toEqual({ segment: 'FNO', groww_order_id: 'GLTFO123' });
    expect(defined(fetch.calls[2]).headers['X-API-VERSION']).toBe('1.0');
    await groww.modifyOrder(ctx(fetch), modify({ orderType: 'MARKET', pricePaise: null }));
    expect(jsonOf(fetch.calls[3])).toMatchObject({ price: 0, order_type: 'MARKET' });
  });

  it('refuses order ids without a known segment', async () => {
    const fetch = fakeFetch(() => ok({}));
    for (const id of ['GLTFO123', 'MCX:G1', 'FNO:']) {
      const e = await brokerError(groww.cancelOrder(ctx(fetch), id));
      expect(e.code).toBe('NOT_FOUND');
    }
    expect(splitOrderId('FNO:A:B')).toEqual({ segment: 'FNO', id: 'A:B' });
    expect(fetch.calls).toHaveLength(0);
  });

  it('reads one order by id and segment', async () => {
    const fetch = fakeFetch(() =>
      ok({
        groww_order_id: 'GLTFO123', order_status: 'OPEN', filled_quantity: 20, quantity: 40, price: 421, trigger_price: 0,
        average_fill_price: 420.05, order_type: 'LIMIT', order_reference_id: 'NXabcdefgh12345678', remark: null,
      }),
    );
    expect(await groww.getOrder(ctx(fetch), 'FNO:GLTFO123')).toMatchObject({
      brokerOrderId: 'FNO:GLTFO123', status: 'PARTIALLY_FILLED', quantity: 40, filledQty: 20, avgPricePaise: 42005,
      pricePaise: 42100, triggerPaise: null, orderType: 'LIMIT', clientRef: 'NXabcdefgh12345678', message: null,
    });
    const call = defined(fetch.calls[0]);
    expect(`${call.method} ${call.url}`).toBe('GET https://api.groww.in/v1/order/detail/GLTFO123?segment=FNO');
    expect(call.headers['Authorization']).toBe('Bearer AT');
    await expect(groww.getOrder(ctx(fakeFetch(() => ok({}))), 'CASH:G9')).rejects.toThrow('no order CASH:G9');
    const e = await brokerError(groww.getOrder(ctx(fakeFetch(() => fail(400, 'bad'))), 'CASH:G9'));
    expect(e.code).toBe('UNKNOWN');
  });

  it('lists both segments with segment-encoded ids', async () => {
    const fetch = fakeFetch((url) =>
      url.includes('segment=FNO')
        ? ok({ order_list: [{ groww_order_id: 'F1', order_status: 'REJECTED', remark: 'RMS', order_type: 'SL_M', quantity: 10 }] })
        : ok({ order_list: [{ groww_order_id: 'C1', order_status: 'EXECUTED', filled_quantity: 5, quantity: 5, average_fill_price: '100.5', order_type: 'ODD' }] }),
    );
    const orders = await groww.listOrders(ctx(fetch));
    expect(fetch.calls.map((c) => c.url)).toEqual([
      'https://api.groww.in/v1/order/list?segment=FNO&page=0&page_size=100',
      'https://api.groww.in/v1/order/list?segment=CASH&page=0&page_size=100',
    ]);
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({ brokerOrderId: 'FNO:F1', status: 'REJECTED', message: 'RMS', orderType: 'SL_M', avgPricePaise: null, clientRef: null });
    expect(orders[1]).toMatchObject({ brokerOrderId: 'CASH:C1', status: 'FILLED', avgPricePaise: 10050, orderType: null });
    expect(await groww.listOrders(ctx(fakeFetch(() => ok(null))))).toEqual([]);
  });

  it('maps every Groww status', () => {
    expect(growwStatus('COMPLETED', 40, 40)).toBe('FILLED');
    expect(growwStatus('EXECUTED', 40, 40)).toBe('FILLED');
    expect(growwStatus('EXECUTED', 20, 40)).toBe('PARTIALLY_FILLED');
    expect(growwStatus('EXECUTED', 0, 0)).toBe('FILLED');
    expect(growwStatus('cancelled', 10, 40)).toBe('CANCELLED');
    expect(growwStatus('REJECTED', 0, 40)).toBe('REJECTED');
    expect(growwStatus('FAILED', 0, 40)).toBe('REJECTED');
    for (const s of ['NEW', 'ACKED', 'OPEN', 'TRIGGER_PENDING', 'APPROVED']) {
      expect(growwStatus(s, 0, 40)).toBe('OPEN');
      expect(growwStatus(s, 5, 40)).toBe('PARTIALLY_FILLED');
    }
    expect(growwStatus('CANCELLATION_REQUESTED', 0, 40)).toBe('SUBMITTED');
    expect(growwStatus('MODIFICATION_REQUESTED', 5, 40)).toBe('PARTIALLY_FILLED');
    expect(growwStatus('DELIVERY_AWAITED', 0, 40)).toBe('SUBMITTED');
    expect(growwStatus('SOMETHING_NEW', 0, 40)).toBe('SUBMITTED');
  });

  it('refuses a modify below the filled quantity', () => {
    const current = { brokerOrderId: 'FNO:1', status: 'PARTIALLY_FILLED' as const, quantity: 40, filledQty: 20, avgPricePaise: 1, pricePaise: 1, triggerPaise: null, orderType: 'LIMIT' as const, clientRef: null, message: null, raw: {} };
    expect(groww.modifyProblem(current, modify({ quantity: 20 }))).toContain('20 already filled');
    expect(groww.modifyProblem(current, modify({ quantity: 30 }))).toBeNull();
  });
});

describe('GrowwAdapter positions and instruments', () => {
  it('reads positions from both segments', async () => {
    const fetch = fakeFetch((url) =>
      url.includes('segment=FNO')
        ? ok({ positions: [{ trading_symbol: 'SENSEX26O2973100PE', segment: 'FNO', exchange: 'BSE', product: 'NRML', quantity: -20, net_price: 400 }] })
        : ok({ positions: [{ trading_symbol: 'RELIANCE', exchange: 'NSE', product: 'XYZ' }] }),
    );
    expect(await groww.getPositions(ctx(fetch))).toEqual([
      { symbol: SYMBOL, product: 'CARRYFORWARD', netQty: -20, avgPricePaise: 40000, lastPricePaise: null, pnlPaise: null },
      {
        symbol: { nativeId: 'RELIANCE', tradingSymbol: 'RELIANCE', exchange: 'NSE:CASH' },
        product: 'CARRYFORWARD', netQty: 0, avgPricePaise: null, lastPricePaise: null, pnlPaise: null,
      },
    ]);
    expect(fetch.calls.map((c) => c.url)).toEqual([
      'https://api.groww.in/v1/positions/user?segment=FNO',
      'https://api.groww.in/v1/positions/user?segment=CASH',
    ]);
    expect(await groww.getPositions(ctx(fakeFetch(() => ok({}))))).toEqual([]);
    const e = await brokerError(groww.getPositions(ctx(fakeFetch(() => fail(401, 'expired')))));
    expect(e.code).toBe('AUTH_EXPIRED');
  });

  it('normalises the public instrument list: strikes and ticks to paise, other markets dropped', async () => {
    const csv = [
      'exchange,exchange_token,trading_symbol,groww_symbol,name,instrument_type,segment,series,isin,underlying_symbol,underlying_exchange_token,expiry_date,strike_price,lot_size,tick_size',
      'BSE,1,SENSEX26O2973100PE,BSE-SENSEX-29Oct26-73100-PE,SENSEX,PE,FNO,,,SENSEX,1,2026-10-29,73100,20,0.05',
      'NSE,2885,RELIANCE,NSE-RELIANCE,"Reliance Industries, Ltd",EQ,CASH,EQ,INE002A01018,,,,,1,0.1',
      'NSE,3,NIFTY,NSE-NIFTY,Nifty 50,IDX,CASH,,,,,,,,',
      'MCX,4,CRUDEOIL26NOVFUT,MCX-CRUDE,Crude,FUT,COMMODITY,,,CRUDEOIL,,2026-11-19,,100,1',
      'NSE,5,NIFTY26OCTFUT,NSE-NIFTY-FUT,Nifty,FUT,FNO,,,NIFTY,26000,2026-10-29,,75,0',
      'BSE,6,TCS,BSE-TCS,TCS,EQ,CASH,A,,,,,,,0.05',
    ].join('\n');
    const fetch = fakeFetch(() => text(csv));
    expect(await groww.fetchInstrumentMaster(ctx(fetch, { token: null }))).toEqual([
      { exchange: 'BFO', type: 'PE', underlying: 'SENSEX', expiry: '2026-10-29', strikePaise: 7310000, lotSize: 20, tickPaise: 5, symbol: SYMBOL },
      { exchange: 'NSE', type: 'EQ', underlying: 'RELIANCE', expiry: null, strikePaise: null, lotSize: 1, tickPaise: 10, symbol: { nativeId: 'RELIANCE', tradingSymbol: 'RELIANCE', exchange: 'NSE:CASH' } },
      { exchange: 'NFO', type: 'FUT', underlying: 'NIFTY', expiry: '2026-10-29', strikePaise: null, lotSize: 75, tickPaise: 5, symbol: { nativeId: 'NIFTY26OCTFUT', tradingSymbol: 'NIFTY26OCTFUT', exchange: 'NSE:FNO' } },
      { exchange: 'BSE', type: 'EQ', underlying: 'TCS', expiry: null, strikePaise: null, lotSize: 1, tickPaise: 5, symbol: { nativeId: 'TCS', tradingSymbol: 'TCS', exchange: 'BSE:CASH' } },
    ]);
    expect(`${defined(fetch.calls[0]).method} ${defined(fetch.calls[0]).url}`).toBe('GET https://growwapi-assets.groww.in/instruments/instrument.csv');
    expect(defined(fetch.calls[0]).headers['Authorization']).toBeUndefined();
  });

  it('needs an http client for the instrument list, and reports download failures', async () => {
    const none = await brokerError(groww.fetchInstrumentMaster(null));
    expect(none.code).toBe('UNKNOWN');
    expect(none.message).toContain('needs an http client');
    const e = await brokerError(groww.fetchInstrumentMaster(ctx(fakeFetch(() => text('nope', 404)))));
    expect(e.code).toBe('NOT_FOUND');
  });
});
