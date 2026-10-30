import { describe, expect, it } from 'vitest';

import { BrokerError } from '../../src/domain/broker-error.ts';
import { UpstoxAdapter, upstoxStatus } from '../../src/brokers/upstox/index.ts';
import type { ModifyRequest, PlaceRequest } from '../../src/brokers/adapter.ts';
import { clock, ctx, fakeFetch, formOf, json, jsonOf, text, defined } from '../helpers.ts';

const upstox = new UpstoxAdapter({ clock });
const SYMBOL = { nativeId: 'BSE_FO|1150410', tradingSymbol: 'SENSEX 73100 PE 29 OCT 26', exchange: 'BSE_FO' };
const REDIRECT = { credentials: { extra: { redirectUri: 'https://app.example/cb' } } };

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

const modify = (overrides: Partial<ModifyRequest> = {}): ModifyRequest => ({
  brokerOrderId: '2501',
  symbol: SYMBOL,
  side: 'BUY',
  product: 'CARRYFORWARD',
  quantity: 60,
  orderType: 'LIMIT',
  pricePaise: 43000,
  triggerPaise: null,
  ...overrides,
});

const ok = (data: unknown) => json({ status: 'success', data });
const fail = (status: number, errorCode: string, message: string) =>
  json({ status: 'error', errors: [{ errorCode, message, propertyPath: null, invalidValue: null }] }, status);

async function brokerError(p: Promise<unknown>): Promise<BrokerError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BrokerError) return e;
    throw e;
  }
  throw new Error('expected a BrokerError');
}

describe('UpstoxAdapter metadata', () => {
  it('describes the broker', () => {
    expect(upstox.code).toBe('upstox');
    expect(upstox.label).toBe('Upstox');
    expect(upstox.instrumentsNeedSession).toBe(false);
    expect(upstox.capabilities).toMatchObject({ headlessRefresh: false, webhooks: true, ratePerSecond: 10 });
    expect(upstox.capabilities.orderTypes).toEqual(['MARKET', 'LIMIT', 'SL', 'SL_M']);
    expect(upstox.credentialFields.map((f) => f.name)).toEqual(['apiKey', 'apiSecret', 'redirectUri']);
    expect(upstox.credentialFields.every((f) => f.required)).toBe(true);
  });
});

describe('UpstoxAdapter auth', () => {
  it('starts the Upstox login with the saved redirect URI and our state', async () => {
    const c = ctx(fakeFetch(() => json({})), REDIRECT);
    const challenge = await upstox.startLink({ credentials: c.credentials, state: 'S1', callbackUrl: 'x' });
    expect(challenge.kind).toBe('redirect');
    const url = new URL((challenge as { url: string }).url);
    expect(url.origin + url.pathname).toBe('https://api.upstox.com/v2/login/authorization/dialog');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'key123',
      redirect_uri: 'https://app.example/cb',
      state: 'S1',
    });
    expect(url.toString()).not.toContain('secret456');
  });

  it('refuses to start without a redirect URI', async () => {
    const c = ctx(fakeFetch(() => json({})));
    await expect(upstox.startLink({ credentials: c.credentials, state: 'S1', callbackUrl: 'x' })).rejects.toThrow('no redirect URI');
  });

  it('exchanges the code for a token; the session ends at 03:30 IST next day', async () => {
    const fetch = fakeFetch(() => json({ email: 'x', access_token: 'AT1', user_id: 'U1' }));
    const tokens = await upstox.completeLink(ctx(fetch, REDIRECT), { params: { url: 'https://app.example/cb?code=C0DE&state=S1' } });
    expect(tokens).toEqual({ accessToken: 'AT1', refreshToken: null, expiresAt: new Date('2026-10-27T22:00:00Z') });
    const call = defined(fetch.calls[0]);
    expect(`${call.method} ${call.url}`).toBe('POST https://api.upstox.com/v2/login/authorization/token');
    expect(call.headers['Authorization']).toBeUndefined();
    expect(formOf(call)).toEqual({
      code: 'C0DE',
      client_id: 'key123',
      client_secret: 'secret456',
      redirect_uri: 'https://app.example/cb',
      grant_type: 'authorization_code',
    });
    expect(JSON.stringify(tokens)).not.toContain('secret456');
  });

  it('fails the link on an error, a missing token or a missing code', async () => {
    const e = await brokerError(
      upstox.completeLink(ctx(fakeFetch(() => fail(400, 'UDAPI100069', 'Invalid Auth code')), REDIRECT), { params: { code: 'C' } }),
    );
    expect(e.code).toBe('UNKNOWN');
    expect(e.message).toBe('Upstox: Invalid Auth code');
    expect(e.message).not.toContain('secret456');
    await expect(upstox.completeLink(ctx(fakeFetch(() => json({})), REDIRECT), { params: { code: 'C' } })).rejects.toThrow('no access token');
    await expect(upstox.completeLink(ctx(fakeFetch(() => json({})), REDIRECT), { params: { url: 'not a url' } })).rejects.toThrow('"code"');
  });

  it('always needs the user to refresh', async () => {
    expect(await upstox.refreshSession()).toMatchObject({ needsUserAction: true });
  });
});

describe('UpstoxAdapter orders', () => {
  it('places one unsliced v3 order with our tag, rupee prices and a bearer token', async () => {
    const fetch = fakeFetch(() => ok({ order_ids: ['2501'] }));
    const ack = await upstox.placeOrder(ctx(fetch), place({ orderType: 'SL', triggerPaise: 41000 }));
    expect(ack.brokerOrderId).toBe('2501');
    const call = defined(fetch.calls[0]);
    expect(`${call.method} ${call.url}`).toBe('POST https://api-hft.upstox.com/v3/order/place');
    expect(call.headers['Authorization']).toBe('Bearer AT');
    expect(call.headers['Accept']).toBe('application/json');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(jsonOf(call)).toEqual({
      quantity: 40,
      product: 'D',
      validity: 'DAY',
      price: 420.05,
      tag: 'NXabc123',
      instrument_token: 'BSE_FO|1150410',
      order_type: 'SL',
      transaction_type: 'BUY',
      disclosed_quantity: 0,
      trigger_price: 410,
      is_amo: false,
      slice: false,
    });
    expect(JSON.stringify(ack.raw)).not.toContain('Bearer');
  });

  it('sends zero price and trigger when there are none, and maps products', async () => {
    const fetch = fakeFetch(() => ok({ order_ids: ['1'] }));
    await upstox.placeOrder(ctx(fetch), place({ orderType: 'MARKET', pricePaise: null, product: 'INTRADAY', side: 'SELL' }));
    await upstox.placeOrder(ctx(fetch), place({ orderType: 'SL_M', pricePaise: null, triggerPaise: 100, product: 'DELIVERY' }));
    expect(jsonOf(fetch.calls[0])).toMatchObject({ order_type: 'MARKET', product: 'I', price: 0, trigger_price: 0, transaction_type: 'SELL' });
    expect(jsonOf(fetch.calls[1])).toMatchObject({ order_type: 'SL-M', product: 'D', price: 0, trigger_price: 1 });
  });

  it('sends an empty bearer when the account has no session', async () => {
    const fetch = fakeFetch(() => fail(401, 'UDAPI100050', 'Invalid token used to access API'));
    const e = await brokerError(upstox.placeOrder(ctx(fetch, { token: null }), place()));
    expect(e.code).toBe('AUTH_EXPIRED');
    expect(defined(fetch.calls[0]).headers['Authorization']).toBe('Bearer ');
  });

  it('maps Upstox errors into the shared taxonomy', async () => {
    const cases: [Response, string][] = [
      [fail(401, 'UDAPI100050', 'Invalid token used to access API'), 'AUTH_EXPIRED'],
      [fail(400, 'UDAPI100050', 'Something about the token'), 'AUTH_EXPIRED'],
      [json({ status: 'error', errors: [{ error_code: 'UDAPI100050', message: 'x' }] }, 400), 'AUTH_EXPIRED'],
      [fail(400, 'UDAPI1052', 'Insufficient funds for this order'), 'INSUFFICIENT_FUNDS'],
      [fail(400, 'UDAPI100500', 'Markets are closed right now'), 'MARKET_CLOSED'],
      [fail(400, 'UDAPI1026', 'RMS: blocked by exchange'), 'REJECTED_BY_EXCHANGE'],
      [fail(404, 'UDAPI100060', 'Resource not found'), 'UNKNOWN'],
      [text('<html>', 400), 'REJECTED_BY_EXCHANGE'],
      [json({ status: 'error', errors: [] }, 200), 'UNKNOWN'],
      [ok({}), 'UNKNOWN'],
      [ok({ order_ids: [] }), 'UNKNOWN'],
      [ok(null), 'UNKNOWN'],
    ];
    for (const [res, code] of cases) {
      expect((await brokerError(upstox.placeOrder(ctx(fakeFetch(() => res.clone())), place()))).code).toBe(code);
    }
    const e = await brokerError(upstox.placeOrder(ctx(fakeFetch(() => text('<html>', 400))), place()));
    expect(e.message).toBe('Upstox: HTTP 400');
  });

  it('treats a 5xx on place as an unknown outcome', async () => {
    const e = await brokerError(upstox.placeOrder(ctx(fakeFetch(() => fail(503, 'X', 'down'))), place()));
    expect(e.code).toBe('BROKER_UNAVAILABLE');
    expect(e.outcomeUnknown).toBe(true);
  });

  it('modifies with the full desired state and cancels by order id', async () => {
    const fetch = fakeFetch(() => ok({ order_id: '2501' }));
    expect((await upstox.modifyOrder(ctx(fetch), modify())).brokerOrderId).toBe('2501');
    await upstox.modifyOrder(ctx(fetch), modify({ orderType: 'SL_M', pricePaise: null, triggerPaise: 100 }));
    expect((await upstox.cancelOrder(ctx(fetch), '25 01')).brokerOrderId).toBe('2501');
    expect(fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'PUT https://api-hft.upstox.com/v3/order/modify',
      'PUT https://api-hft.upstox.com/v3/order/modify',
      'DELETE https://api-hft.upstox.com/v3/order/cancel?order_id=25%2001',
    ]);
    expect(jsonOf(fetch.calls[0])).toEqual({
      order_id: '2501', quantity: 60, validity: 'DAY', price: 430, order_type: 'LIMIT', trigger_price: 0, disclosed_quantity: 0,
    });
    expect(jsonOf(fetch.calls[1])).toMatchObject({ order_type: 'SL-M', price: 0, trigger_price: 1 });
    expect(fetch.calls.every((c) => c.headers['Authorization'] === 'Bearer AT')).toBe(true);
  });

  it('maps a rejected modify or cancel and an answer without an order id', async () => {
    const e = await brokerError(upstox.modifyOrder(ctx(fakeFetch(() => fail(400, 'UDAPI100040', 'Order already completed'))), modify()));
    expect(e).toMatchObject({ code: 'REJECTED_BY_EXCHANGE', message: 'Upstox: Order already completed' });
    await expect(upstox.cancelOrder(ctx(fakeFetch(() => ok({ order_id: '' }))), '1')).rejects.toThrow('no order id');
  });

  it('reads one order', async () => {
    const fetch = fakeFetch(() =>
      ok({
        order_id: '2501', status: 'open', filled_quantity: 20, pending_quantity: 20, quantity: 40, average_price: 420.05,
        price: 421, trigger_price: 0, order_type: 'LIMIT', tag: 'NXabc123', status_message: '',
      }),
    );
    expect(await upstox.getOrder(ctx(fetch), '2501')).toMatchObject({
      brokerOrderId: '2501', status: 'PARTIALLY_FILLED', quantity: 40, filledQty: 20, avgPricePaise: 42005, pricePaise: 42100,
      triggerPaise: null, orderType: 'LIMIT', clientRef: 'NXabc123', message: null,
    });
    expect(defined(fetch.calls[0]).url).toBe('https://api.upstox.com/v2/order/details?order_id=2501');
    expect(defined(fetch.calls[0]).method).toBe('GET');
    expect(defined(fetch.calls[0]).headers['Authorization']).toBe('Bearer AT');
  });

  it('reports a missing order as NOT_FOUND and read errors as UNKNOWN', async () => {
    await expect(upstox.getOrder(ctx(fakeFetch(() => ok({}))), '9')).rejects.toThrow('no order 9');
    expect((await brokerError(upstox.getOrder(ctx(fakeFetch(() => ok(null))), '9'))).code).toBe('NOT_FOUND');
    const e = await brokerError(upstox.getOrder(ctx(fakeFetch(() => fail(400, 'UDAPI100010', 'Bad order id'))), '9'));
    expect(e.code).toBe('UNKNOWN');
  });

  it('lists the order book', async () => {
    const fetch = fakeFetch(() =>
      ok([
        { order_id: '1', status: 'rejected', status_message: 'RMS: margin', order_type: 'SL-M', trigger_price: 410, tag: '' },
        { order_id: '2', status: 'complete', filled_quantity: 40, quantity: 40, average_price: '420.05', order_type: 'MARKET' },
        { order_id: '3', status: 'weird', order_type: 'AMO' },
      ]),
    );
    const orders = await upstox.listOrders(ctx(fetch));
    expect(orders[0]).toMatchObject({ status: 'REJECTED', message: 'RMS: margin', orderType: 'SL_M', triggerPaise: 41000, avgPricePaise: null, clientRef: null });
    expect(orders[1]).toMatchObject({ status: 'FILLED', filledQty: 40, avgPricePaise: 42005, orderType: 'MARKET' });
    expect(orders[2]).toMatchObject({ status: 'SUBMITTED', orderType: null, quantity: 0, pricePaise: null });
    expect(defined(fetch.calls[0]).url).toBe('https://api.upstox.com/v2/order/retrieve-all');
    expect(await upstox.listOrders(ctx(fakeFetch(() => ok(null))))).toEqual([]);
    expect(await upstox.listOrders(ctx(fakeFetch(() => json({ status: 'success', data: [{ order_id: '4' }] }))))).toMatchObject([
      { brokerOrderId: '4', status: 'SUBMITTED' },
    ]);
  });

  it('maps every Upstox status', () => {
    expect(upstoxStatus('complete', 40)).toBe('FILLED');
    expect(upstoxStatus('COMPLETE', 40)).toBe('FILLED');
    expect(upstoxStatus('cancelled', 10)).toBe('CANCELLED');
    expect(upstoxStatus('rejected', 0)).toBe('REJECTED');
    expect(upstoxStatus('open', 0)).toBe('OPEN');
    expect(upstoxStatus('trigger pending', 0)).toBe('OPEN');
    expect(upstoxStatus('trigger pending', 5)).toBe('PARTIALLY_FILLED');
    expect(upstoxStatus('validation pending', 0)).toBe('SUBMITTED');
    expect(upstoxStatus('put order req received', 0)).toBe('SUBMITTED');
    expect(upstoxStatus('after market order req received', 0)).toBe('SUBMITTED');
    expect(upstoxStatus('modify pending', 5)).toBe('PARTIALLY_FILLED');
  });

  it('refuses a modify below the filled quantity', () => {
    const current = { brokerOrderId: '1', status: 'PARTIALLY_FILLED' as const, quantity: 40, filledQty: 20, avgPricePaise: 1, pricePaise: 1, triggerPaise: null, orderType: 'LIMIT' as const, clientRef: null, message: null, raw: {} };
    expect(upstox.modifyProblem(current, modify({ quantity: 20 }))).toContain('20 already filled');
    expect(upstox.modifyProblem(current, modify({ quantity: 30 }))).toBeNull();
  });
});

describe('UpstoxAdapter positions, instruments and webhooks', () => {
  it('reads short-term positions, telling delivery from carry-forward by segment', async () => {
    const fetch = fakeFetch(() =>
      ok([
        { instrument_token: 'BSE_FO|1150410', trading_symbol: 'SENSEX 73100 PE 29 OCT 26', exchange: 'BFO', product: 'D', quantity: -20, average_price: 400, last_price: 410.5, pnl: -210 },
        { instrument_token: 'NSE_EQ|INE002A01018', tradingsymbol: 'RELIANCE', exchange: 'NSE', product: 'D', quantity: 5, average_price: '2900.1', last_price: null, pnl: '' },
        { instrument_token: 'NSE_EQ|INE002A01018', trading_symbol: 'RELIANCE', exchange: 'NSE', product: 'I', quantity: 1 },
        { instrument_token: 'NSE_EQ|INE002A01018', trading_symbol: 'RELIANCE', exchange: 'NSE', product: 'MTF' },
      ]),
    );
    const positions = await upstox.getPositions(ctx(fetch));
    expect(positions[0]).toEqual({ symbol: SYMBOL, product: 'CARRYFORWARD', netQty: -20, avgPricePaise: 40000, lastPricePaise: 41050, pnlPaise: -21000 });
    expect(positions[1]).toEqual({
      symbol: { nativeId: 'NSE_EQ|INE002A01018', tradingSymbol: 'RELIANCE', exchange: 'NSE_EQ' },
      product: 'DELIVERY', netQty: 5, avgPricePaise: 290010, lastPricePaise: null, pnlPaise: null,
    });
    expect(positions[2]).toMatchObject({ product: 'INTRADAY', netQty: 1 });
    expect(positions[3]).toMatchObject({ product: 'CARRYFORWARD', netQty: 0 });
    expect(defined(fetch.calls[0]).url).toBe('https://api.upstox.com/v2/portfolio/short-term-positions');
    expect(defined(fetch.calls[0]).headers['Authorization']).toBe('Bearer AT');
    expect(await upstox.getPositions(ctx(fakeFetch(() => ok(null))))).toEqual([]);
  });

  it('normalises the instrument master: strikes to paise, ticks in paise, expiries as IST dates', async () => {
    const expiry = Date.UTC(2026, 9, 29, 18, 29, 59); // 29 Oct 2026 23:59:59 IST
    const rows = [
      { segment: 'BSE_FO', name: 'SENSEX', exchange: 'BSE', expiry, instrument_key: 'BSE_FO|1150410', trading_symbol: 'SENSEX 73100 PE 29 OCT 26', tick_size: 5.0, lot_size: 20, instrument_type: 'PE', strike_price: 73100.0, underlying_symbol: 'SENSEX' },
      { segment: 'NSE_EQ', name: 'RELIANCE INDUSTRIES LTD', exchange: 'NSE', instrument_key: 'NSE_EQ|INE002A01018', trading_symbol: 'RELIANCE', tick_size: 10.0, lot_size: 1, instrument_type: 'EQ' },
      { segment: 'NSE_INDEX', name: 'Nifty 50', exchange: 'NSE', instrument_key: 'NSE_INDEX|Nifty 50', trading_symbol: 'NIFTY', instrument_type: 'INDEX' },
      { segment: 'MCX_FO', name: 'CRUDEOIL', exchange: 'MCX', expiry, instrument_key: 'MCX_FO|1', trading_symbol: 'CRUDEOIL FUT', instrument_type: 'FUT' },
      { segment: 'NSE_EQ', name: 'SOME BOND', instrument_key: 'NSE_EQ|X', trading_symbol: 'SGB', instrument_type: 'GB' },
      { segment: 'NSE_FO', name: 'NIFTY', exchange: 'NSE', expiry, instrument_key: 'NSE_FO|2', trading_symbol: 'NIFTY FUT 29 OCT 26', tick_size: 0, lot_size: 0, instrument_type: 'FUT' },
      { segment: 'BSE_EQ', name: 'TCS', instrument_key: 'BSE_EQ|3', trading_symbol: 'TCS', tick_size: 5, lot_size: 1, instrument_type: 'EQ' },
      { segment: 'NSE_FO', name: 'BANKNIFTY', instrument_key: 'NSE_FO|4', trading_symbol: 'BANKNIFTY 50000 CE', tick_size: 5, lot_size: 30, instrument_type: 'CE', strike_price: 50000 },
      'garbage',
    ];
    const fetch = fakeFetch(() => json(rows));
    expect(await upstox.fetchInstrumentMaster(ctx(fetch))).toEqual([
      { exchange: 'BFO', type: 'PE', underlying: 'SENSEX', expiry: '2026-10-29', strikePaise: 7310000, lotSize: 20, tickPaise: 5, symbol: SYMBOL },
      { exchange: 'NSE', type: 'EQ', underlying: 'RELIANCE', expiry: null, strikePaise: null, lotSize: 1, tickPaise: 10, symbol: { nativeId: 'NSE_EQ|INE002A01018', tradingSymbol: 'RELIANCE', exchange: 'NSE_EQ' } },
      { exchange: 'NFO', type: 'FUT', underlying: 'NIFTY', expiry: '2026-10-29', strikePaise: null, lotSize: 1, tickPaise: 5, symbol: { nativeId: 'NSE_FO|2', tradingSymbol: 'NIFTY FUT 29 OCT 26', exchange: 'NSE_FO' } },
      { exchange: 'BSE', type: 'EQ', underlying: 'TCS', expiry: null, strikePaise: null, lotSize: 1, tickPaise: 5, symbol: { nativeId: 'BSE_EQ|3', tradingSymbol: 'TCS', exchange: 'BSE_EQ' } },
      // No underlying_symbol: falls back to the name. No expiry: null.
      { exchange: 'NFO', type: 'CE', underlying: 'BANKNIFTY', expiry: null, strikePaise: 5000000, lotSize: 30, tickPaise: 5, symbol: { nativeId: 'NSE_FO|4', tradingSymbol: 'BANKNIFTY 50000 CE', exchange: 'NSE_FO' } },
    ]);
    const call = defined(fetch.calls[0]);
    expect(`${call.method} ${call.url}`).toBe('GET https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz');
    expect(call.headers['Accept-Encoding']).toBe('gzip');
    // The list is public: no session token goes out.
    expect(call.headers['Authorization']).toBeUndefined();
  });

  it('fails the instrument master without an HTTP client, on an error status or a non-array body', async () => {
    await expect(upstox.fetchInstrumentMaster(null)).rejects.toThrow('needs an HTTP client');
    expect((await brokerError(upstox.fetchInstrumentMaster(ctx(fakeFetch(() => text('nope', 403)))))).code).toBe('UNKNOWN');
    await expect(upstox.fetchInstrumentMaster(ctx(fakeFetch(() => json({}))))).rejects.toThrow('not a JSON array');
    // Works without a session too.
    expect(await upstox.fetchInstrumentMaster(ctx(fakeFetch(() => json([])), { token: null }))).toEqual([]);
  });

  it('turns an order-update webhook into an unsigned hint', () => {
    expect(upstox.parseWebhook({ order_id: '2501', status: 'complete' })).toEqual({ brokerOrderId: '2501', verify: null });
    expect(upstox.parseWebhook({ order_id: 2501 })).toBeNull();
    expect(upstox.parseWebhook({ order_id: '' })).toBeNull();
    expect(upstox.parseWebhook(null)).toBeNull();
  });
});
