import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { BrokerError } from '../../src/domain/broker-error.ts';
import { ZerodhaAdapter, kiteStatus } from '../../src/brokers/zerodha/index.ts';
import type { PlaceRequest } from '../../src/brokers/adapter.ts';
import { clock, ctx, fakeFetch, formOf, json, text } from '../helpers.ts';

const kite = new ZerodhaAdapter({ clock });
const SYMBOL = { nativeId: '12345', tradingSymbol: 'SENSEX26O2973100PE', exchange: 'BFO' };

const place = (overrides: Partial<PlaceRequest> = {}): PlaceRequest => ({
  symbol: SYMBOL,
  side: 'BUY',
  quantity: 40,
  orderType: 'LIMIT',
  product: 'CARRYFORWARD',
  pricePaise: 42005,
  triggerPaise: null,
  clientRef: 'NXabc123',
  algoId: null,
  referencePricePaise: null,
  ...overrides,
});

const ok = (data: unknown) => json({ status: 'success', data });
const fail = (status: number, error_type: string, message: string) => json({ status: 'error', error_type, message }, status);

async function brokerError(p: Promise<unknown>): Promise<BrokerError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BrokerError) return e;
    throw e;
  }
  throw new Error('expected a BrokerError');
}

describe('ZerodhaAdapter auth', () => {
  it('starts the Kite login with the state in redirect_params', async () => {
    const challenge = await kite.startLink({ credentials: ctx(fakeFetch(() => json({}))).credentials, state: 'S1', callbackUrl: 'x' });
    expect(challenge.kind).toBe('redirect');
    const url = new URL((challenge as { url: string }).url);
    expect(url.origin + url.pathname).toBe('https://kite.zerodha.com/connect/login');
    expect(url.searchParams.get('api_key')).toBe('key123');
    expect(url.searchParams.get('redirect_params')).toBe('state=S1');
  });

  it('exchanges the request token with a SHA-256 checksum; the session ends at 06:00 IST', async () => {
    const fetch = fakeFetch(() => ok({ access_token: 'AT1' }));
    const tokens = await kite.completeLink(ctx(fetch), { params: { url: 'https://x/cb?request_token=RT&status=success' } });
    expect(tokens).toEqual({ accessToken: 'AT1', refreshToken: null, expiresAt: new Date('2026-10-28T00:30:00Z') });
    expect(fetch.calls[0]!.url).toBe('https://api.kite.trade/session/token');
    expect(formOf(fetch.calls[0])).toEqual({
      api_key: 'key123',
      request_token: 'RT',
      checksum: createHash('sha256').update('key123RTsecret456').digest('hex'),
    });
  });

  it('fails the link without a token in the answer or a request_token in the redirect', async () => {
    await expect(kite.completeLink(ctx(fakeFetch(() => ok({}))), { params: { request_token: 'RT' } })).rejects.toThrow('no access token');
    await expect(kite.completeLink(ctx(fakeFetch(() => ok({}))), { params: { url: 'not a url' } })).rejects.toThrow('request_token');
  });

  it('always needs the user to refresh', async () => {
    expect(await kite.refreshSession()).toMatchObject({ needsUserAction: true });
  });
});

describe('ZerodhaAdapter orders', () => {
  it('places a regular order with our tag and rupee prices', async () => {
    const fetch = fakeFetch(() => ok({ order_id: '2501' }));
    const ack = await kite.placeOrder(ctx(fetch), place({ orderType: 'SL', triggerPaise: 41000 }));
    expect(ack.brokerOrderId).toBe('2501');
    const call = fetch.calls[0]!;
    expect(call.url).toBe('https://api.kite.trade/orders/regular');
    expect(call.headers['Authorization']).toBe('token key123:AT');
    expect(formOf(call)).toEqual({
      tradingsymbol: 'SENSEX26O2973100PE',
      exchange: 'BFO',
      transaction_type: 'BUY',
      order_type: 'SL',
      quantity: '40',
      product: 'NRML',
      validity: 'DAY',
      tag: 'NXabc123',
      price: '420.05',
      trigger_price: '410.00',
    });
    // The audit record never carries the access token.
    expect(JSON.stringify(ack.raw)).not.toContain('AT');
  });

  it('sends market orders without a price', async () => {
    const fetch = fakeFetch(() => ok({ order_id: '1' }));
    await kite.placeOrder(ctx(fetch), place({ orderType: 'SL_M', pricePaise: null, triggerPaise: 100, product: 'INTRADAY' }));
    expect(formOf(fetch.calls[0])).toMatchObject({ order_type: 'SL-M', product: 'MIS', trigger_price: '1.00' });
    expect(formOf(fetch.calls[0])).not.toHaveProperty('price');
  });

  it('maps Kite errors into the shared taxonomy', async () => {
    const cases: [Response, string][] = [
      [fail(403, 'TokenException', 'Incorrect api_key or access_token.'), 'AUTH_EXPIRED'],
      [fail(400, 'OrderException', 'Insufficient funds. Required margin is 95.00'), 'INSUFFICIENT_FUNDS'],
      [fail(400, 'InputException', 'Markets are closed right now.'), 'MARKET_CLOSED'],
      [fail(400, 'OrderException', 'RMS: blocked'), 'REJECTED_BY_EXCHANGE'],
      [fail(400, 'GeneralException', 'Huh'), 'UNKNOWN'],
      [text('<html>', 400), 'UNKNOWN'],
      [ok({}), 'UNKNOWN'],
    ];
    for (const [res, code] of cases) {
      expect((await brokerError(kite.placeOrder(ctx(fakeFetch(() => res.clone())), place()))).code).toBe(code);
    }
  });

  it('treats a 5xx on place as an unknown outcome', async () => {
    const e = await brokerError(kite.placeOrder(ctx(fakeFetch(() => fail(503, 'NetworkException', 'down'))), place()));
    expect(e.code).toBe('BROKER_UNAVAILABLE');
    expect(e.outcomeUnknown).toBe(true);
  });

  it('modifies and cancels by order id', async () => {
    const fetch = fakeFetch(() => ok({ order_id: '2501' }));
    await kite.modifyOrder(ctx(fetch), {
      brokerOrderId: '2501', symbol: SYMBOL, side: 'BUY', product: 'CARRYFORWARD',
      quantity: 60, orderType: 'LIMIT', pricePaise: 43000, triggerPaise: null,
    });
    await kite.modifyOrder(ctx(fetch), {
      brokerOrderId: '2501', symbol: SYMBOL, side: 'BUY', product: 'CARRYFORWARD',
      quantity: 60, orderType: 'SL_M', pricePaise: null, triggerPaise: 100,
    });
    await kite.cancelOrder(ctx(fetch), '2501');
    expect(fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'PUT https://api.kite.trade/orders/regular/2501',
      'PUT https://api.kite.trade/orders/regular/2501',
      'DELETE https://api.kite.trade/orders/regular/2501',
    ]);
    expect(formOf(fetch.calls[0])).toEqual({ quantity: '60', order_type: 'LIMIT', validity: 'DAY', price: '430.00' });
    expect(formOf(fetch.calls[1])).toEqual({ quantity: '60', order_type: 'SL-M', validity: 'DAY', trigger_price: '1.00' });
  });

  it('reads the latest state from the order history', async () => {
    const fetch = fakeFetch(() =>
      ok([
        { order_id: '2501', status: 'OPEN PENDING', filled_quantity: 0, quantity: 40 },
        { order_id: '2501', status: 'OPEN', filled_quantity: 20, quantity: 40, average_price: 420.05, price: 421, trigger_price: 0, order_type: 'LIMIT', tag: 'NXabc123', status_message: null },
      ]),
    );
    expect(await kite.getOrder(ctx(fetch), '2501')).toMatchObject({
      brokerOrderId: '2501', status: 'PARTIALLY_FILLED', filledQty: 20, avgPricePaise: 42005, pricePaise: 42100,
      triggerPaise: null, orderType: 'LIMIT', clientRef: 'NXabc123', message: null,
    });
    await expect(kite.getOrder(ctx(fakeFetch(() => ok([]))), '9')).rejects.toThrow('no order 9');
  });

  it('lists the order book', async () => {
    const fetch = fakeFetch(() => ok([{ order_id: '1', status: 'REJECTED', status_message: 'RMS', order_type: 'SL-M' }]));
    const [o] = await kite.listOrders(ctx(fetch));
    expect(o).toMatchObject({ status: 'REJECTED', message: 'RMS', orderType: 'SL_M', avgPricePaise: null, clientRef: null });
    expect(await kite.listOrders(ctx(fakeFetch(() => ok(null))))).toEqual([]);
  });

  it('maps every Kite status', () => {
    expect(kiteStatus('COMPLETE', 40)).toBe('FILLED');
    expect(kiteStatus('CANCELLED', 10)).toBe('CANCELLED');
    expect(kiteStatus('REJECTED', 0)).toBe('REJECTED');
    expect(kiteStatus('LAPSED', 0)).toBe('EXPIRED');
    expect(kiteStatus('EXPIRED', 0)).toBe('EXPIRED');
    expect(kiteStatus('TRIGGER PENDING', 0)).toBe('OPEN');
    expect(kiteStatus('PUT ORDER REQ RECEIVED', 0)).toBe('SUBMITTED');
    expect(kiteStatus('MODIFY PENDING', 5)).toBe('PARTIALLY_FILLED');
  });

  it('refuses a modify below the filled quantity', () => {
    const current = { brokerOrderId: '1', status: 'PARTIALLY_FILLED' as const, quantity: 40, filledQty: 20, avgPricePaise: 1, pricePaise: 1, triggerPaise: null, orderType: 'LIMIT' as const, clientRef: null, message: null, raw: {} };
    const req = { brokerOrderId: '1', symbol: SYMBOL, side: 'BUY' as const, product: 'CARRYFORWARD' as const, quantity: 20, orderType: 'LIMIT' as const, pricePaise: 1, triggerPaise: null };
    expect(kite.modifyProblem(current, req)).toContain('20 already filled');
    expect(kite.modifyProblem(current, { ...req, quantity: 30 })).toBeNull();
  });
});

describe('ZerodhaAdapter positions, instruments and postbacks', () => {
  it('reads net positions', async () => {
    const fetch = fakeFetch(() =>
      ok({ net: [{ instrument_token: 12345, tradingsymbol: 'SENSEX26O2973100PE', exchange: 'BFO', product: 'NRML', quantity: -20, average_price: 400, last_price: 410.5, pnl: -210 }], day: [] }),
    );
    expect(await kite.getPositions(ctx(fetch))).toEqual([
      { symbol: SYMBOL, product: 'CARRYFORWARD', netQty: -20, avgPricePaise: 40000, lastPricePaise: 41050, pnlPaise: -21000 },
    ]);
    expect(fetch.calls[0]!.url).toBe('https://api.kite.trade/portfolio/positions');
    const odd = fakeFetch(() => ok({ net: [{ instrument_token: 1, tradingsymbol: 'X', exchange: 'NSE', product: 'BO' }] }));
    expect((await kite.getPositions(ctx(odd)))[0]).toMatchObject({ product: 'CARRYFORWARD', netQty: 0 });
    expect(await kite.getPositions(ctx(fakeFetch(() => ok({}))))).toEqual([]);
  });

  it('normalises the instrument dump: strikes and ticks to paise, indices and other segments dropped', async () => {
    const csv = [
      'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
      '12345,1,SENSEX26O2973100PE,SENSEX,0,2026-10-29,73100,0.05,20,PE,BFO-OPT,BFO',
      '738561,2,RELIANCE,RELIANCE INDUSTRIES,0,,0,0.1,1,EQ,NSE,NSE',
      '256265,3,NIFTY 50,NIFTY 50,0,,0,0,0,EQ,INDICES,NSE',
      '9,4,CRUDEOIL,CRUDEOIL,0,2026-11-19,0,1,100,FUT,MCX-FUT,MCX',
      '10,5,NIFTY26OCTFUT,NIFTY,0,2026-10-29,0,0,75,FUT,NFO-FUT,NFO',
    ].join('\n');
    const fetch = fakeFetch(() => text(csv));
    expect(await kite.fetchInstrumentMaster(ctx(fetch))).toEqual([
      { exchange: 'BFO', type: 'PE', underlying: 'SENSEX', expiry: '2026-10-29', strikePaise: 7310000, lotSize: 20, tickPaise: 5, symbol: SYMBOL },
      { exchange: 'NSE', type: 'EQ', underlying: 'RELIANCE', expiry: null, strikePaise: null, lotSize: 1, tickPaise: 10, symbol: { nativeId: '738561', tradingSymbol: 'RELIANCE', exchange: 'NSE' } },
      { exchange: 'NFO', type: 'FUT', underlying: 'NIFTY', expiry: '2026-10-29', strikePaise: null, lotSize: 75, tickPaise: 5, symbol: { nativeId: '10', tradingSymbol: 'NIFTY26OCTFUT', exchange: 'NFO' } },
    ]);
    expect(fetch.calls[0]!.headers['Authorization']).toBe('token key123:AT');
  });

  it('needs a session for the instrument dump', async () => {
    await expect(kite.fetchInstrumentMaster(null)).rejects.toThrow('logged-in account');
    const e = await brokerError(kite.fetchInstrumentMaster(ctx(fakeFetch(() => fail(403, 'TokenException', 'expired')))));
    expect(e.code).toBe('AUTH_EXPIRED');
  });

  it('verifies postback checksums with the API secret', () => {
    const body = { order_id: '2501', order_timestamp: '2026-10-27 09:30:01', status: 'COMPLETE' };
    const checksum = createHash('sha256').update('25012026-10-27 09:30:01secret456').digest('hex');
    const hint = kite.parseWebhook({ ...body, checksum })!;
    expect(hint.brokerOrderId).toBe('2501');
    expect(hint.verify!({ apiKey: 'k', apiSecret: 'secret456', extra: {} })).toBe(true);
    expect(hint.verify!({ apiKey: 'k', apiSecret: 'other', extra: {} })).toBe(false);
    expect(kite.parseWebhook({ ...body, checksum: 'short' })!.verify!({ apiKey: 'k', apiSecret: 'secret456', extra: {} })).toBe(false);
    expect(kite.parseWebhook({ order_id: 1 })).toBeNull();
  });
});

