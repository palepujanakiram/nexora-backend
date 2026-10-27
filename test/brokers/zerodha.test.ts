import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { InstrumentCache } from '../../src/brokers/broker-api.ts';
import { ZerodhaApi } from '../../src/brokers/zerodha.ts';
import type { TradePlan } from '../../src/domain/trade.ts';
import { account, clock, fakeFetch, formOf, json, signal, text, type FakeFetch } from '../helpers.ts';

const CSV = [
  'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
  '1,2,SENSEX26O2973100PE,SENSEX,0,2026-10-29,73100,0.05,20,PE,BFO-OPT,BFO',
  '3,4,SENSEX26O2973100CE,SENSEX,0,2026-10-29,73100,0.05,20,CE,BFO-OPT,BFO',
].join('\n');

const api = (fetch: FakeFetch, overrides = {}) =>
  new ZerodhaApi({ account: account(overrides), fetch, clock, cache: new InstrumentCache(), random: () => 0 });

const inst = { symbol: 'SENSEX26O2973100PE', exchange: 'BFO', lotSize: 20, tickSize: 0.05 };
const plan = (overrides: Partial<TradePlan> = {}): TradePlan => ({
  signal: signal(),
  quantity: 40,
  entryPrice: 420,
  product: 'carryForward',
  stopLoss: 300,
  target: 540,
  ...overrides,
});

describe('ZerodhaApi', () => {
  it('logs in through the Kite connect page and catches request_token', () => {
    expect(api(fakeFetch(() => json({}))).login()).toEqual({
      kind: 'redirect',
      url: 'https://kite.zerodha.com/connect/login?v=3&api_key=kitekey123',
      codeParam: 'request_token',
      redirectUri: null,
    });
  });

  it('exchanges the request token with a SHA-256 checksum', async () => {
    const fetch = fakeFetch(() => json({ status: 'success', data: { access_token: 'AT' } }));
    expect(await api(fetch).exchangeToken('https://127.0.0.1/?request_token=RT&status=success')).toBe('AT');
    const call = fetch.calls[0]!;
    expect(call.url).toBe('https://api.kite.trade/session/token');
    expect(formOf(call)).toEqual({
      api_key: 'kitekey123',
      request_token: 'RT',
      checksum: createHash('sha256').update('kitekey123RTkitesecret').digest('hex'),
    });
  });

  it('reports Kite errors and non-JSON replies', async () => {
    await expect(api(fakeFetch(() => json({ status: 'error', message: 'Token is invalid' }, 403))).exchangeToken('RT')).rejects.toThrow(
      'Kite: Token is invalid',
    );
    await expect(api(fakeFetch(() => json({ status: 'error' }, 500))).exchangeToken('RT')).rejects.toThrow('Kite: HTTP 500');
    await expect(api(fakeFetch(() => text('<html>', 502))).exchangeToken('RT')).rejects.toThrow('Kite returned HTTP 502.');
  });

  it('resolves the contract from the cached instrument dump', async () => {
    const fetch = fakeFetch(() => text(CSV));
    const client = api(fetch);
    expect(await client.resolve(signal())).toEqual(inst);
    await client.resolve(signal({ optionType: 'CE' }));
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.url).toBe('https://api.kite.trade/instruments/BFO');
    expect(fetch.calls[0]!.headers['Authorization']).toBe('token kitekey123:tok');
  });

  it('falls back to the signal exchange and default tick size', async () => {
    const csv = 'tradingsymbol,name,expiry,strike,tick_size,lot_size,instrument_type,exchange\nX,SENSEX,2026-10-29,73100,,20,PE,';
    expect(await api(fakeFetch(() => text(csv))).resolve(signal())).toMatchObject({ exchange: 'BFO', tickSize: 0.05 });
  });

  it('explains a missing contract or a failed download', async () => {
    await expect(api(fakeFetch(() => text(CSV))).resolve(signal({ strike: 1 }))).rejects.toThrow(
      'No Kite contract found for SENSEX 29 OCT 2026 1 PE on BFO.',
    );
    await expect(api(fakeFetch(() => text('', 403))).resolve(signal())).rejects.toThrow(
      'Kite instruments download failed (403). Is the session valid?',
    );
  });

  it('places only the entry order without exits', async () => {
    const fetch = fakeFetch(() => json({ status: 'success', data: { order_id: 'O1' } }));
    const orders = await api(fetch).placeTrade(inst, plan({ stopLoss: null, target: null, product: 'intraday' }));
    expect(orders).toEqual([{ kind: 'ENTRY', id: 'O1' }]);
    expect(fetch.calls[0]!.url).toBe('https://api.kite.trade/orders/regular');
    expect(formOf(fetch.calls[0])).toEqual({
      tradingsymbol: 'SENSEX26O2973100PE',
      exchange: 'BFO',
      transaction_type: 'BUY',
      order_type: 'LIMIT',
      quantity: '40',
      price: '420.00',
      product: 'MIS',
      validity: 'DAY',
      tag: 'signal',
    });
  });

  it('adds a GTT OCO with legs in ascending price and a buffered stop-loss limit', async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes('/orders/regular')) return json({ status: 'success', data: { order_id: 'O1' } });
      if (url.includes('/quote/ltp')) return json({ status: 'success', data: { 'BFO:SENSEX26O2973100PE': { last_price: 415 } } });
      return json({ status: 'success', data: { trigger_id: 77 } });
    });
    const orders = await api(fetch).placeTrade(inst, plan());
    expect(orders).toEqual([
      { kind: 'ENTRY', id: 'O1' },
      { kind: 'GTT OCO (SL 300 / TGT 540)', id: '77' },
    ]);
    const gtt = formOf(fetch.calls[2]);
    expect(fetch.calls[2]!.url).toBe('https://api.kite.trade/gtt/triggers');
    expect(JSON.parse(gtt['condition']!)).toEqual({
      exchange: 'BFO',
      tradingsymbol: 'SENSEX26O2973100PE',
      trigger_values: [300, 540],
      last_price: 415,
    });
    const legs = JSON.parse(gtt['orders']!) as { price: number; transaction_type: string; product: string }[];
    expect(legs.map((l) => l.price)).toEqual([285, 540]);
    expect(legs.every((l) => l.transaction_type === 'SELL' && l.product === 'NRML')).toBe(true);
  });

  it('buffers the stop loss upwards for short trades and uses the entry when LTP fails', async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes('/orders/regular')) return json({ status: 'success', data: { order_id: 'O1' } });
      if (url.includes('/quote/ltp')) return text('down', 503);
      return json({ status: 'success', data: { trigger_id: 1 } });
    });
    await api(fetch).placeTrade(inst, plan({ signal: signal({ action: 'SELL' }), stopLoss: 500, target: 300 }));
    const gtt = formOf(fetch.calls[2]);
    expect(JSON.parse(gtt['condition']!).last_price).toBe(420);
    expect((JSON.parse(gtt['orders']!) as { price: number }[]).map((l) => l.price)).toEqual([300, 525]);
  });
});
