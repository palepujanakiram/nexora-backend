import { describe, expect, it } from 'vitest';

import { InstrumentCache } from '../../src/brokers/broker-api.ts';
import { UpstoxApi } from '../../src/brokers/upstox.ts';
import type { TradePlan } from '../../src/domain/trade.ts';
import { account, clock, fakeFetch, formOf, json, jsonOf, signal, text, type FakeFetch } from '../helpers.ts';

const api = (fetch: FakeFetch) =>
  new UpstoxApi({
    account: account({ broker: 'upstox', apiKey: 'upkey', apiSecret: 'upsecret', redirectUri: 'https://127.0.0.1/' }),
    fetch,
    clock,
    cache: new InstrumentCache(),
    random: () => 0,
  });

const inst = { symbol: 'SENSEX 73100 PE 29 OCT 26', exchange: 'BFO', lotSize: 20, instrumentKey: 'BSE_FO|1', tickSize: 0.05 };
const plan = (overrides: Partial<TradePlan> = {}): TradePlan => ({
  signal: signal(),
  quantity: 40,
  entryPrice: 420,
  product: 'carryForward',
  stopLoss: 300,
  target: 540,
  ...overrides,
});

describe('UpstoxApi', () => {
  it('logs in through the authorization dialog with the redirect URI', () => {
    const login = api(fakeFetch(() => json({}))).login();
    expect(login).toMatchObject({ kind: 'redirect', codeParam: 'code', redirectUri: 'https://127.0.0.1/' });
    const url = new URL((login as { url: string }).url);
    expect(url.origin + url.pathname).toBe('https://api.upstox.com/v2/login/authorization/dialog');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'upkey',
      redirect_uri: 'https://127.0.0.1/',
    });
  });

  it('exchanges the code for a token', async () => {
    const fetch = fakeFetch(() => json({ access_token: 'AT' }));
    expect(await api(fetch).exchangeToken('https://127.0.0.1/?code=C0DE')).toBe('AT');
    expect(fetch.calls[0]!.url).toBe('https://api.upstox.com/v2/login/authorization/token');
    expect(formOf(fetch.calls[0])).toEqual({
      code: 'C0DE',
      client_id: 'upkey',
      client_secret: 'upsecret',
      redirect_uri: 'https://127.0.0.1/',
      grant_type: 'authorization_code',
    });
  });

  it('reports token errors', async () => {
    const invalid = { status: 'error', errors: [{ message: 'Invalid Credentials', errorCode: 'UDAPI100016' }] };
    await expect(api(fakeFetch(() => json(invalid, 401))).exchangeToken('C')).rejects.toThrow('Upstox: Invalid Credentials');
    await expect(api(fakeFetch(() => json({}, 200))).exchangeToken('C')).rejects.toThrow('Upstox: HTTP 200');
    await expect(api(fakeFetch(() => text('oops', 500))).exchangeToken('C')).rejects.toThrow('Upstox returned HTTP 500.');
  });

  it('resolves index options from the option contract list', async () => {
    const fetch = fakeFetch(() =>
      json({
        status: 'success',
        data: [
          { instrument_type: 'CE', strike_price: 73100, trading_symbol: 'X', lot_size: 20, instrument_key: 'BSE_FO|2' },
          { instrument_type: 'PE', strike_price: 73100, trading_symbol: inst.symbol, lot_size: 20, instrument_key: 'BSE_FO|1' },
        ],
      }),
    );
    expect(await api(fetch).resolve(signal())).toEqual(inst);
    const url = new URL(fetch.calls[0]!.url);
    expect(url.searchParams.get('instrument_key')).toBe('BSE_INDEX|SENSEX');
    expect(url.searchParams.get('expiry_date')).toBe('2026-10-29');
    expect(fetch.calls[0]!.headers['Authorization']).toBe('Bearer tok');
  });

  it('explains unmapped underlyings and missing contracts', async () => {
    await expect(api(fakeFetch(() => json({}))).resolve(signal({ underlying: 'RELIANCE' }))).rejects.toThrow(
      'Upstox: underlying RELIANCE is not mapped yet (indices only).',
    );
    await expect(api(fakeFetch(() => json({ status: 'success', data: [] }))).resolve(signal())).rejects.toThrow(
      'No Upstox contract found for SENSEX 29 OCT 2026 73100 PE.',
    );
  });

  it('places a plain limit order without exits', async () => {
    const fetch = fakeFetch(() => json({ status: 'success', data: { order_ids: ['A', 'B'] } }));
    const orders = await api(fetch).placeTrade(inst, plan({ stopLoss: null, target: null, product: 'intraday' }));
    expect(orders).toEqual([
      { kind: 'ENTRY', id: 'A' },
      { kind: 'ENTRY', id: 'B' },
    ]);
    expect(fetch.calls[0]!.url).toBe('https://api-hft.upstox.com/v3/order/place');
    expect(jsonOf(fetch.calls[0])).toMatchObject({ product: 'I', price: 420, instrument_token: 'BSE_FO|1', transaction_type: 'BUY' });
  });

  it('places a MULTIPLE GTT with entry, target and stop loss', async () => {
    const gttFetch = (ltp: number) =>
      fakeFetch((url) =>
        url.includes('/market-quote/ltp')
          ? json({ status: 'success', data: { 'BSE_FO:X': { last_price: ltp } } })
          : json({ status: 'success', data: { gtt_order_ids: ['G1'] } }),
      );
    const above = gttFetch(430);
    expect(await api(above).placeTrade(inst, plan())).toEqual([{ kind: 'GTT entry+SL 300+TGT 540', id: 'G1' }]);
    expect(above.calls[1]!.url).toBe('https://api.upstox.com/v3/order/gtt/place');
    expect(jsonOf(above.calls[1])).toMatchObject({
      type: 'MULTIPLE',
      product: 'D',
      rules: [
        { strategy: 'ENTRY', trigger_type: 'BELOW', trigger_price: 420 },
        { strategy: 'TARGET', trigger_type: 'IMMEDIATE', trigger_price: 540 },
        { strategy: 'STOPLOSS', trigger_type: 'IMMEDIATE', trigger_price: 300 },
      ],
    });

    const below = gttFetch(410);
    await api(below).placeTrade(inst, plan());
    expect((jsonOf(below.calls[1])['rules'] as { trigger_type: string }[])[0]!.trigger_type).toBe('IMMEDIATE');

    const sellBelow = gttFetch(410);
    await api(sellBelow).placeTrade(inst, plan({ signal: signal({ action: 'SELL' }) }));
    expect((jsonOf(sellBelow.calls[1])['rules'] as { trigger_type: string }[])[0]!.trigger_type).toBe('ABOVE');

    const sellAbove = gttFetch(430);
    await api(sellAbove).placeTrade(inst, plan({ signal: signal({ action: 'SELL' }) }));
    expect((jsonOf(sellAbove.calls[1])['rules'] as { trigger_type: string }[])[0]!.trigger_type).toBe('IMMEDIATE');
  });

  it('uses the entry price when the LTP lookup fails', async () => {
    const fetch = fakeFetch((url) =>
      url.includes('/market-quote/ltp')
        ? json({ status: 'error', errors: [] }, 500)
        : json({ status: 'success', data: { gtt_order_ids: ['G1'] } }),
    );
    await api(fetch).placeTrade(inst, plan());
    expect((jsonOf(fetch.calls[1])['rules'] as { trigger_type: string }[])[0]!.trigger_type).toBe('IMMEDIATE');
  });
});
