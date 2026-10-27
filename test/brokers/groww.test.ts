import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { InstrumentCache } from '../../src/brokers/broker-api.ts';
import { GROWW_INSTRUMENTS_URL, GrowwApi } from '../../src/brokers/groww.ts';
import type { TradePlan } from '../../src/domain/trade.ts';
import { NOW, account, clock, fakeFetch, json, jsonOf, signal, text, type FakeFetch } from '../helpers.ts';

const CSV = [
  'exchange,exchange_token,trading_symbol,groww_symbol,name,instrument_type,segment,series,isin,underlying_symbol,underlying_exchange_token,expiry_date,strike_price,lot_size,tick_size',
  'BSE,1,SENSEX26O2973100PE,X,SENSEX,PE,FNO,,,SENSEX,1,2026-10-29,73100,20,0.05',
  'NSE,2,NIFTY26O3024000PE,X,NIFTY,PE,FNO,,,NIFTY,2,2026-10-30,24000,75,',
].join('\n');

const api = (fetch: FakeFetch) =>
  new GrowwApi({
    account: account({ broker: 'groww', apiKey: 'gkey', apiSecret: 'gsecret' }),
    fetch,
    clock,
    cache: new InstrumentCache(),
    random: () => 0.042,
  });

const inst = { symbol: 'SENSEX26O2973100PE', exchange: 'BSE', lotSize: 20, tickSize: 0.05 };
const plan = (overrides: Partial<TradePlan> = {}): TradePlan => ({
  signal: signal(),
  quantity: 40,
  entryPrice: 420,
  product: 'carryForward',
  stopLoss: 300,
  target: 540,
  ...overrides,
});

describe('GrowwApi', () => {
  it('logs in by approving the key on Groww’s API keys page', () => {
    expect(api(fakeFetch(() => json({}))).login()).toEqual({ kind: 'approval', url: 'https://groww.in/trade-api/api-keys' });
  });

  it('creates a token from the daily approval with a checksum of the secret', async () => {
    const fetch = fakeFetch(() => json({ token: 'AT' }));
    expect(await api(fetch).exchangeToken('')).toBe('AT');
    const timestamp = String(NOW.getTime() / 1000);
    expect(fetch.calls[0]!.headers['Authorization']).toBe('Bearer gkey');
    expect(jsonOf(fetch.calls[0])).toEqual({
      key_type: 'approval',
      checksum: createHash('sha256').update(`gsecret${timestamp}`).digest('hex'),
      timestamp,
    });
  });

  it('creates a token from a TOTP code, reading it from the payload too', async () => {
    const fetch = fakeFetch(() => json({ payload: { token: 'AT2' } }));
    expect(await api(fetch).exchangeToken(' 123456 ')).toBe('AT2');
    expect(jsonOf(fetch.calls[0])).toEqual({ key_type: 'totp', totp: '123456' });
  });

  it('rejects other input and reports token errors', async () => {
    await expect(api(fakeFetch(() => json({}))).exchangeToken('abc')).rejects.toThrow('Groww: leave the box empty');
    await expect(api(fakeFetch(() => json({ error: { message: 'Not approved' } }, 403))).exchangeToken('')).rejects.toThrow(
      'Groww: Not approved',
    );
    await expect(api(fakeFetch(() => json({ message: 'No token' }))).exchangeToken('')).rejects.toThrow('Groww: No token');
    await expect(api(fakeFetch(() => json({}))).exchangeToken('')).rejects.toThrow('Groww: HTTP 200');
    await expect(api(fakeFetch(() => text('bad', 500))).exchangeToken('')).rejects.toThrow('Groww returned HTTP 500.');
  });

  it('resolves contracts from the public instrument list, cached for the day', async () => {
    const fetch = fakeFetch(() => text(CSV));
    const client = api(fetch);
    expect(await client.resolve(signal())).toEqual(inst);
    expect(await client.resolve(signal({ underlying: 'NIFTY', expiry: '2026-10-30', strike: 24000 }))).toEqual({
      symbol: 'NIFTY26O3024000PE',
      exchange: 'NSE',
      lotSize: 75,
      tickSize: 0.05,
    });
    expect(fetch.calls.map((c) => c.url)).toEqual([GROWW_INSTRUMENTS_URL]);
  });

  it('explains missing contracts and download failures', async () => {
    await expect(api(fakeFetch(() => text(CSV))).resolve(signal({ strike: 1 }))).rejects.toThrow(
      'No Groww contract found for SENSEX 29 OCT 2026 1 PE on BSE.',
    );
    await expect(api(fakeFetch(() => text('', 404))).resolve(signal())).rejects.toThrow('Groww instruments download failed (404).');
    await expect(api(fakeFetch(() => text('header\n'))).resolve(signal())).rejects.toThrow('Groww instruments list had no F&O contracts.');
  });

  it('places the entry order and notes that exits need the Groww app', async () => {
    const fetch = fakeFetch(() => json({ status: 'SUCCESS', payload: { groww_order_id: 'G1' } }));
    expect(await api(fetch).placeTrade(inst, plan())).toEqual([
      { kind: 'ENTRY', id: 'G1' },
      { kind: 'SL 300 / TGT 540', id: 'not placed: add an OCO in the Groww app after the entry fills' },
    ]);
    expect(fetch.calls[0]!.url).toBe('https://api.groww.in/v1/order/create');
    expect(jsonOf(fetch.calls[0])).toEqual({
      trading_symbol: 'SENSEX26O2973100PE',
      quantity: 40,
      price: 420,
      validity: 'DAY',
      exchange: 'BSE',
      segment: 'FNO',
      product: 'NRML',
      order_type: 'LIMIT',
      transaction_type: 'BUY',
      order_reference_id: `NX${NOW.getTime()}042`,
    });
  });

  it('places intraday entries only, and reports rejections', async () => {
    const ok = fakeFetch(() => json({ status: 'SUCCESS', payload: { groww_order_id: 'G1' } }));
    expect(await api(ok).placeTrade(inst, plan({ stopLoss: null, product: 'intraday' }))).toEqual([{ kind: 'ENTRY', id: 'G1' }]);
    expect(jsonOf(ok.calls[0])['product']).toBe('MIS');
    await expect(api(fakeFetch(() => json({ status: 'FAILURE', error: { message: 'Insufficient margin' } }))).placeTrade(inst, plan())).rejects.toThrow(
      'Groww: Insufficient margin',
    );
  });
});
