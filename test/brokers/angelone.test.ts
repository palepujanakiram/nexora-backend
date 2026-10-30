import { describe, expect, it } from 'vitest';

import { BrokerError } from '../../src/domain/broker-error.ts';
import { AngelOneAdapter, angelExpiry, angelStatus } from '../../src/brokers/angelone/index.ts';
import type { ModifyRequest, PlaceRequest } from '../../src/brokers/adapter.ts';
import { clock, ctx, fakeFetch, json, jsonOf, text, token, defined, stringContaining } from '../helpers.ts';

const angel = new AngelOneAdapter({ clock });
const SYMBOL = { nativeId: '873210', tradingSymbol: 'SENSEX30OCT2673100PE', exchange: 'BFO' };
const EXTRA = { clientCode: 'A123456', pin: '4321' };
const MIDNIGHT_IST = new Date('2026-10-27T18:30:00Z');

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

const ok = (data: unknown) => json({ status: true, message: 'SUCCESS', errorcode: '', data });
const fail = (errorcode: string, message: string, status = 200) => json({ status: false, message, errorcode, data: null }, status);

async function brokerError(p: Promise<unknown>): Promise<BrokerError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BrokerError) return e;
    throw e;
  }
  throw new Error('expected a BrokerError');
}

describe('AngelOneAdapter auth', () => {
  it('describes itself', () => {
    expect(angel.code).toBe('angelone');
    expect(angel.label).toBe('Angel One (SmartAPI)');
    expect(angel.instrumentsNeedSession).toBe(false);
    expect(angel.capabilities).toMatchObject({ headlessRefresh: true, webhooks: false, ratePerSecond: 10 });
    expect(angel.credentialFields.map((f) => f.name)).toEqual(['apiKey', 'apiSecret', 'clientCode', 'pin']);
    expect(angel.credentialFields.find((f) => f.name === 'pin')).toMatchObject({ secret: true, required: true });
    expect('parseWebhook' in angel).toBe(false);
  });

  it('asks for a TOTP instead of redirecting', async () => {
    const challenge = await angel.startLink();
    expect(challenge).toEqual({
      kind: 'input',
      fields: [{ name: 'totp', label: '6-digit TOTP from your authenticator', secret: true, required: true }],
      message: 'Enter the current TOTP for your Angel One account.',
      url: null,
    });
  });

  it('logs in with client code, MPIN and TOTP; the session ends at midnight IST', async () => {
    const fetch = fakeFetch(() => ok({ jwtToken: 'JWT1', refreshToken: 'RF1', feedToken: 'FT1' }));
    const c = ctx(fetch, { credentials: { extra: EXTRA }, token: null });
    const tokens = await angel.completeLink(c, { params: { totp: ' 123 456 ' } });
    expect(tokens).toEqual({ accessToken: 'JWT1', refreshToken: 'RF1', expiresAt: MIDNIGHT_IST });
    const call = defined(fetch.calls[0]);
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword');
    expect(call.headers).toMatchObject({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': 'key123',
    });
    expect(call.headers).not.toHaveProperty('Authorization');
    expect(jsonOf(call)).toEqual({ clientcode: 'A123456', password: '4321', totp: '123456' });
  });

  it('keeps the MPIN, TOTP and tokens out of the audit record and errors', async () => {
    const fetch = fakeFetch(() => fail('AB1050', 'Invalid totp'));
    const e = await brokerError(angel.completeLink(ctx(fetch, { credentials: { extra: EXTRA } }), { params: { totp: '987654' } }));
    expect(e.code).toBe('UNKNOWN');
    expect(e.message).toBe('Angel One: Invalid totp (AB1050)');
    const raw = JSON.stringify(e.raw);
    expect(raw).not.toContain('4321');
    expect(raw).not.toContain('987654');
    expect(raw).toContain('A123456');

    const okFetch = fakeFetch(() => ok({ jwtToken: 'Bearer JWTSECRET', refreshToken: 'RFSECRET' }));
    const tokens = await angel.completeLink(ctx(okFetch, { credentials: { extra: EXTRA } }), { params: { totp: '111111' } });
    expect(tokens.accessToken).toBe('JWTSECRET');
  });

  it('refuses a bad TOTP or missing client code / MPIN without calling Angel', async () => {
    const fetch = fakeFetch(() => ok({}));
    for (const totp of [undefined, '', '12345', '1234567', 'abcdef']) {
      const params: Record<string, string> = totp === undefined ? {} : { totp };
      const e = await brokerError(angel.completeLink(ctx(fetch, { credentials: { extra: EXTRA } }), { params }));
      expect(e.code).toBe('AUTH_EXPIRED');
      expect(e.message).toContain('6-digit TOTP');
    }
    const e = await brokerError(angel.completeLink(ctx(fetch, { credentials: { extra: { clientCode: 'A1' } } }), { params: { totp: '123456' } }));
    expect(e.code).toBe('AUTH_EXPIRED');
    expect(e.message).toContain('client code and MPIN');
    expect(fetch.calls).toHaveLength(0);
  });

  it('fails the link when Angel returns no JWT', async () => {
    const e = await brokerError(angel.completeLink(ctx(fakeFetch(() => ok({ jwtToken: '' })), { credentials: { extra: EXTRA } }), { params: { totp: '123456' } }));
    expect(e.code).toBe('AUTH_EXPIRED');
    expect(e.message).toContain('no session token');
    const noRefresh = await angel.completeLink(ctx(fakeFetch(() => ok({ jwtToken: 'J' })), { credentials: { extra: EXTRA } }), { params: { totp: '123456' } });
    expect(noRefresh.refreshToken).toBeNull();
  });

  it('refreshes headlessly with the refresh token', async () => {
    const fetch = fakeFetch(() => ok({ jwtToken: 'JWT2', refreshToken: 'RF2' }));
    const result = await angel.refreshSession(ctx(fetch, { token: token({ accessToken: 'JWT1', refreshToken: 'RF1' }) }));
    expect(result).toEqual({ accessToken: 'JWT2', refreshToken: 'RF2', expiresAt: MIDNIGHT_IST });
    const call = defined(fetch.calls[0]);
    expect(call.url).toBe('https://apiconnect.angelone.in/rest/auth/angelbroking/jwt/v1/generateTokens');
    expect(call.method).toBe('POST');
    expect(call.headers['Authorization']).toBe('Bearer JWT1');
    expect(jsonOf(call)).toEqual({ refreshToken: 'RF1' });
  });

  it('needs the user when there is no refresh token or it has expired', async () => {
    const none = fakeFetch(() => ok({}));
    expect(await angel.refreshSession(ctx(none))).toMatchObject({ needsUserAction: true });
    expect(await angel.refreshSession(ctx(none, { token: null }))).toMatchObject({ needsUserAction: true });
    expect(none.calls).toHaveLength(0);

    const expired = fakeFetch(() => fail('AG8002', 'Token Expired'));
    expect(await angel.refreshSession(ctx(expired, { token: token({ refreshToken: 'RF1' }) }))).toMatchObject({
      needsUserAction: true,
      reason: stringContaining('TOTP'),
    });
    const forbidden = fakeFetch(() => fail('', 'Forbidden', 403));
    expect(await angel.refreshSession(ctx(forbidden, { token: token({ refreshToken: 'RF1' }) }))).toMatchObject({ needsUserAction: true });
  });

  it('throws other refresh failures', async () => {
    const down = fakeFetch(() => text('oops', 502));
    expect((await brokerError(angel.refreshSession(ctx(down, { token: token({ refreshToken: 'RF1' }) })))).code).toBe('BROKER_UNAVAILABLE');
    const odd = fakeFetch(() => fail('AB9999', 'Something odd'));
    expect((await brokerError(angel.refreshSession(ctx(odd, { token: token({ refreshToken: 'RF1' }) })))).code).toBe('UNKNOWN');
  });
});

describe('AngelOneAdapter orders', () => {
  it('places a NORMAL limit order with string rupee prices and our tag', async () => {
    const fetch = fakeFetch(() => ok({ script: 'X', orderid: '201020000000080', uniqueorderid: 'u-1' }));
    const ack = await angel.placeOrder(ctx(fetch), place());
    expect(ack.brokerOrderId).toBe('201020000000080');
    const call = defined(fetch.calls[0]);
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/placeOrder');
    expect(call.headers).toMatchObject({ Authorization: 'Bearer AT', 'X-PrivateKey': 'key123', 'X-UserType': 'USER' });
    expect(jsonOf(call)).toEqual({
      variety: 'NORMAL',
      tradingsymbol: 'SENSEX30OCT2673100PE',
      symboltoken: '873210',
      transactiontype: 'BUY',
      exchange: 'BFO',
      ordertype: 'LIMIT',
      producttype: 'CARRYFORWARD',
      duration: 'DAY',
      price: '420.05',
      triggerprice: '0',
      quantity: '40',
      ordertag: 'NXabc123',
    });
    expect(JSON.stringify(ack.raw)).not.toContain('Bearer');
  });

  it('places stop-loss orders in the STOPLOSS variety; market orders carry price "0"', async () => {
    const fetch = fakeFetch(() => ok({ orderid: '1' }));
    await angel.placeOrder(ctx(fetch), place({ orderType: 'SL', triggerPaise: 41000, product: 'DELIVERY', side: 'SELL' }));
    await angel.placeOrder(ctx(fetch), place({ orderType: 'SL_M', pricePaise: null, triggerPaise: 100, product: 'INTRADAY' }));
    await angel.placeOrder(ctx(fetch), place({ orderType: 'MARKET', pricePaise: null }));
    expect(jsonOf(fetch.calls[0])).toMatchObject({
      variety: 'STOPLOSS', ordertype: 'STOPLOSS_LIMIT', producttype: 'DELIVERY', transactiontype: 'SELL', price: '420.05', triggerprice: '410.00',
    });
    expect(jsonOf(fetch.calls[1])).toMatchObject({
      variety: 'STOPLOSS', ordertype: 'STOPLOSS_MARKET', producttype: 'INTRADAY', price: '0', triggerprice: '1.00',
    });
    expect(jsonOf(fetch.calls[2])).toMatchObject({ variety: 'NORMAL', ordertype: 'MARKET', price: '0', triggerprice: '0' });
  });

  it('maps Angel errors into the shared taxonomy', async () => {
    const cases: [Response, string][] = [
      [fail('AG8001', 'Invalid Token'), 'AUTH_EXPIRED'],
      [fail('AG8002', 'Token Expired'), 'AUTH_EXPIRED'],
      [fail('AG8003', 'Token missing'), 'AUTH_EXPIRED'],
      [fail('AB1010', 'AMX Session Expired'), 'AUTH_EXPIRED'],
      [fail('AB8050', 'Refresh Token Expired'), 'AUTH_EXPIRED'],
      [fail('', 'Unauthorized', 401), 'AUTH_EXPIRED'],
      [fail('', 'Access denied because of exceeding access rate'), 'RATE_LIMITED'],
      [fail('AB4008', 'Insufficient funds'), 'INSUFFICIENT_FUNDS'],
      [fail('AB2000', 'Order rejected by RMS'), 'REJECTED_BY_EXCHANGE'],
      [fail('AB1012', 'Invalid Tradingsymbol'), 'INVALID_SYMBOL'],
      [text('<html>', 400), 'REJECTED_BY_EXCHANGE'],
      [ok({}), 'UNKNOWN'],
      [ok(null), 'UNKNOWN'],
    ];
    for (const [res, code] of cases) {
      expect((await brokerError(angel.placeOrder(ctx(fakeFetch(() => res.clone())), place()))).code, await res.clone().text()).toBe(code);
    }
    const e = await brokerError(angel.placeOrder(ctx(fakeFetch(() => text('<html>', 400))), place()));
    expect(e.message).toBe('Angel One: HTTP 400');
    const noId = await brokerError(angel.placeOrder(ctx(fakeFetch(() => ok({ orderid: '' }))), place()));
    expect(noId.message).toContain('no order id');
  });

  it('treats a 5xx on place as an unknown outcome', async () => {
    const e = await brokerError(angel.placeOrder(ctx(fakeFetch(() => text('down', 503))), place()));
    expect(e.code).toBe('BROKER_UNAVAILABLE');
    expect(e.outcomeUnknown).toBe(true);
  });

  it('modifies with the full desired state and cancels by order id', async () => {
    const fetch = fakeFetch(() => ok({ orderid: '2501' }));
    expect((await angel.modifyOrder(ctx(fetch), modify())).brokerOrderId).toBe('2501');
    await angel.modifyOrder(ctx(fetch), modify({ orderType: 'SL_M', pricePaise: null, triggerPaise: 100 }));
    expect((await angel.cancelOrder(ctx(fetch), '2501')).brokerOrderId).toBe('2501');
    expect(fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/modifyOrder',
      'POST https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/modifyOrder',
      'POST https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/cancelOrder',
    ]);
    expect(jsonOf(fetch.calls[0])).toEqual({
      variety: 'NORMAL',
      orderid: '2501',
      ordertype: 'LIMIT',
      producttype: 'CARRYFORWARD',
      duration: 'DAY',
      price: '430.00',
      quantity: '60',
      tradingsymbol: 'SENSEX30OCT2673100PE',
      symboltoken: '873210',
      exchange: 'BFO',
      triggerprice: '0',
    });
    expect(jsonOf(fetch.calls[1])).toMatchObject({ variety: 'STOPLOSS', ordertype: 'STOPLOSS_MARKET', price: '0', triggerprice: '1.00' });
    expect(jsonOf(fetch.calls[2])).toEqual({ variety: 'NORMAL', orderid: '2501' });
    expect(defined(fetch.calls[2]).headers['Authorization']).toBe('Bearer AT');
  });

  it('maps a rejected modify to REJECTED_BY_EXCHANGE', async () => {
    const e = await brokerError(angel.modifyOrder(ctx(fakeFetch(() => fail('AB2001', 'Order already completed'))), modify()));
    expect(e.code).toBe('REJECTED_BY_EXCHANGE');
  });

  it('finds one order in the order book; numbers arrive as strings', async () => {
    const fetch = fakeFetch(() =>
      ok([
        { orderid: '1', orderstatus: 'complete', filledshares: '40', quantity: '40' },
        {
          orderid: '2501', status: 'open', orderstatus: 'open', filledshares: '20', unfilledshares: '20', averageprice: '420.05',
          quantity: '40', price: '421.0', triggerprice: '0', ordertype: 'LIMIT', ordertag: 'NXabc123', text: '',
          tradingsymbol: 'SENSEX30OCT2673100PE', symboltoken: '873210',
        },
      ]),
    );
    expect(await angel.getOrder(ctx(fetch), '2501')).toMatchObject({
      brokerOrderId: '2501', status: 'PARTIALLY_FILLED', quantity: 40, filledQty: 20, avgPricePaise: 42005, pricePaise: 42100,
      triggerPaise: null, orderType: 'LIMIT', clientRef: 'NXabc123', message: null,
    });
    expect(defined(fetch.calls[0]).method).toBe('GET');
    expect(defined(fetch.calls[0]).url).toBe('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getOrderBook');
    const e = await brokerError(angel.getOrder(ctx(fetch), '9'));
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toContain('no order 9');
  });

  it('lists the order book, including an empty (null) one', async () => {
    const fetch = fakeFetch(() =>
      ok([
        { orderid: '1', orderstatus: 'rejected', text: 'RMS: margin exceeds', ordertype: 'STOPLOSS_MARKET', triggerprice: '410.00' },
        { orderid: '2', status: 'trigger pending', ordertype: 'STOPLOSS_LIMIT', ordertag: '' },
        { orderid: '3', ordertype: 'ROBO' },
      ]),
    );
    const [a, b, c] = await angel.listOrders(ctx(fetch));
    expect(a).toMatchObject({ status: 'REJECTED', message: 'RMS: margin exceeds', orderType: 'SL_M', avgPricePaise: null, triggerPaise: 41000, clientRef: null });
    expect(b).toMatchObject({ status: 'OPEN', orderType: 'SL', clientRef: null, quantity: 0 });
    expect(c).toMatchObject({ status: 'SUBMITTED', orderType: null });
    expect(await angel.listOrders(ctx(fakeFetch(() => ok(null))))).toEqual([]);
    expect((await brokerError(angel.listOrders(ctx(fakeFetch(() => fail('AG8001', 'Invalid Token')))))).code).toBe('AUTH_EXPIRED');
    expect((await brokerError(angel.listOrders(ctx(fakeFetch(() => fail('X', 'weird')))))).code).toBe('UNKNOWN');
  });

  it('maps every Angel status', () => {
    expect(angelStatus('complete', 40)).toBe('FILLED');
    expect(angelStatus('cancelled', 10)).toBe('CANCELLED');
    expect(angelStatus('rejected', 0)).toBe('REJECTED');
    expect(angelStatus('open', 0)).toBe('OPEN');
    expect(angelStatus('Trigger Pending', 0)).toBe('OPEN');
    expect(angelStatus('open', 5)).toBe('PARTIALLY_FILLED');
    for (const s of ['open pending', 'validation pending', 'put order req received', 'modify pending', 'modified', 'after market order req received', 'new thing']) {
      expect(angelStatus(s, 0)).toBe('SUBMITTED');
    }
    expect(angelStatus('modify pending', 5)).toBe('PARTIALLY_FILLED');
  });

  it('refuses a modify below the filled quantity', () => {
    const current = { brokerOrderId: '1', status: 'PARTIALLY_FILLED' as const, quantity: 40, filledQty: 20, avgPricePaise: 1, pricePaise: 1, triggerPaise: null, orderType: 'LIMIT' as const, clientRef: null, message: null, raw: {} };
    expect(angel.modifyProblem(current, modify({ quantity: 20 }))).toContain('20 already filled');
    expect(angel.modifyProblem(current, modify({ quantity: 30 }))).toBeNull();
  });
});

describe('AngelOneAdapter positions and instruments', () => {
  it('reads positions from string fields', async () => {
    const fetch = fakeFetch(() =>
      ok([
        { tradingsymbol: 'SENSEX30OCT2673100PE', symboltoken: '873210', exchange: 'BFO', producttype: 'CARRYFORWARD', netqty: '-20', avgnetprice: '400.00', ltp: '410.50', pnl: '-210.00' },
        { tradingsymbol: 'RELIANCE-EQ', symboltoken: '2885', exchange: 'NSE', producttype: 'DELIVERY', netqty: '5', avgnetprice: '', ltp: '2900', pnl: '0' },
        { tradingsymbol: 'X', symboltoken: '1', exchange: 'NSE', producttype: 'BO' },
      ]),
    );
    expect(await angel.getPositions(ctx(fetch))).toEqual([
      { symbol: SYMBOL, product: 'CARRYFORWARD', netQty: -20, avgPricePaise: 40000, lastPricePaise: 41050, pnlPaise: -21000 },
      { symbol: { nativeId: '2885', tradingSymbol: 'RELIANCE-EQ', exchange: 'NSE' }, product: 'DELIVERY', netQty: 5, avgPricePaise: null, lastPricePaise: 290000, pnlPaise: 0 },
      { symbol: { nativeId: '1', tradingSymbol: 'X', exchange: 'NSE' }, product: 'CARRYFORWARD', netQty: 0, avgPricePaise: null, lastPricePaise: null, pnlPaise: null },
    ]);
    expect(defined(fetch.calls[0]).url).toBe('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getPosition');
    expect(defined(fetch.calls[0]).headers['Authorization']).toBe('Bearer AT');
    expect(await angel.getPositions(ctx(fakeFetch(() => ok(null))))).toEqual([]);
  });

  it('normalises the scrip master: strikes and ticks already in paise, other segments dropped', async () => {
    const rows = [
      { token: '873210', symbol: 'SENSEX30OCT2673100PE', name: 'SENSEX', expiry: '30OCT2026', strike: '7310000.000000', lotsize: '20', instrumenttype: 'OPTIDX', exch_seg: 'BFO', tick_size: '5.000000' },
      { token: '2885', symbol: 'RELIANCE-EQ', name: 'RELIANCE', expiry: '', strike: '-1.000000', lotsize: '1', instrumenttype: '', exch_seg: 'NSE', tick_size: '10.000000' },
      { token: '500325', symbol: 'RELIANCE', name: 'RELIANCE', expiry: '', strike: '-1.000000', lotsize: '0', instrumenttype: '', exch_seg: 'BSE', tick_size: '' },
      { token: '35001', symbol: 'NIFTY29OCT26FUT', name: 'NIFTY', expiry: '29OCT2026', strike: '-1.000000', lotsize: '75', instrumenttype: 'FUTIDX', exch_seg: 'NFO', tick_size: '10.000000' },
      { token: '35002', symbol: 'TCS29OCT264000CE', name: 'TCS', expiry: '29OCT2026', strike: '400000.000000', lotsize: '175', instrumenttype: 'OPTSTK', exch_seg: 'NFO', tick_size: '5.000000' },
      // Dropped: an index, an NSE non-EQ series, MCX, a bad expiry, an odd option symbol, another instrument type.
      { token: '99926000', symbol: 'Nifty 50', name: 'NIFTY', expiry: '', strike: '0', lotsize: '1', instrumenttype: 'AMXIDX', exch_seg: 'NSE', tick_size: '' },
      { token: '3', symbol: 'GOLDBEES-BE', name: 'GOLDBEES', expiry: '', strike: '0', lotsize: '1', instrumenttype: '', exch_seg: 'NSE', tick_size: '1' },
      { token: '4', symbol: 'CRUDEOIL19NOV26FUT', name: 'CRUDEOIL', expiry: '19NOV2026', strike: '0', lotsize: '100', instrumenttype: 'FUTCOM', exch_seg: 'MCX', tick_size: '100' },
      { token: '5', symbol: 'NIFTY26FUT', name: 'NIFTY', expiry: '2026-10-29', strike: '0', lotsize: '75', instrumenttype: 'FUTIDX', exch_seg: 'NFO', tick_size: '5' },
      { token: '6', symbol: 'NIFTYXX', name: 'NIFTY', expiry: '29OCT2026', strike: '0', lotsize: '75', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5' },
      { token: '7', symbol: 'NIFTY29OCT2624000CE', name: 'NIFTY', expiry: '29OCT2026', strike: '0', lotsize: '75', instrumenttype: 'UNDIRC', exch_seg: 'NFO', tick_size: '5' },
      null,
    ];
    const fetch = fakeFetch(() => json(rows));
    expect(await angel.fetchInstrumentMaster(ctx(fetch, { token: null }))).toEqual([
      { exchange: 'BFO', type: 'PE', underlying: 'SENSEX', expiry: '2026-10-30', strikePaise: 7310000, lotSize: 20, tickPaise: 5, symbol: { nativeId: '873210', tradingSymbol: 'SENSEX30OCT2673100PE', exchange: 'BFO' } },
      { exchange: 'NSE', type: 'EQ', underlying: 'RELIANCE', expiry: null, strikePaise: null, lotSize: 1, tickPaise: 10, symbol: { nativeId: '2885', tradingSymbol: 'RELIANCE-EQ', exchange: 'NSE' } },
      { exchange: 'BSE', type: 'EQ', underlying: 'RELIANCE', expiry: null, strikePaise: null, lotSize: 1, tickPaise: 5, symbol: { nativeId: '500325', tradingSymbol: 'RELIANCE', exchange: 'BSE' } },
      { exchange: 'NFO', type: 'FUT', underlying: 'NIFTY', expiry: '2026-10-29', strikePaise: null, lotSize: 75, tickPaise: 10, symbol: { nativeId: '35001', tradingSymbol: 'NIFTY29OCT26FUT', exchange: 'NFO' } },
      { exchange: 'NFO', type: 'CE', underlying: 'TCS', expiry: '2026-10-29', strikePaise: 400000, lotSize: 175, tickPaise: 5, symbol: { nativeId: '35002', tradingSymbol: 'TCS29OCT264000CE', exchange: 'NFO' } },
    ]);
    expect(defined(fetch.calls[0]).method).toBe('GET');
    expect(defined(fetch.calls[0]).url).toBe('https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json');
  });

  it('fails the instrument download without an http client or on a bad answer', async () => {
    const e = await brokerError(angel.fetchInstrumentMaster(null));
    expect(e.code).toBe('UNKNOWN');
    expect(e.message).toContain('http client');
    expect((await brokerError(angel.fetchInstrumentMaster(ctx(fakeFetch(() => text('not found', 404)))))).code).toBe('UNKNOWN');
    expect((await brokerError(angel.fetchInstrumentMaster(ctx(fakeFetch(() => json({ oops: 1 })))))).code).toBe('UNKNOWN');
  });

  it('parses expiry dates', () => {
    expect(angelExpiry('30OCT2026')).toBe('2026-10-30');
    expect(angelExpiry('05dec2026')).toBe('2026-12-05');
    expect(angelExpiry('30XYZ2026')).toBeNull();
    expect(angelExpiry('')).toBeNull();
  });
});
