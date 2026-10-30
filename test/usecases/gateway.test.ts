import { describe, expect, it } from 'vitest';

import type { BrokerOrder, ModifyRequest } from '../../src/brokers/adapter.ts';
import { BrokerAccountRepository } from '../../src/data/broker-accounts.ts';
import { BrokerError } from '../../src/domain/broker-error.ts';
import type { StreamEvent } from '../../src/usecases/events.ts';
import { RateLimiter } from '../../src/usecases/gateway.ts';
import { harness } from '../app.ts';
import { fakeFetch, json, jsonOf, text, NOW, defined } from '../helpers.ts';

const ANGEL_REFRESH = 'https://apiconnect.angelone.in/rest/auth/angelbroking/jwt/v1/generateTokens';
const ANGEL_POSITIONS = 'https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getPosition';
const GROWW_CSV = 'https://growwapi-assets.groww.in/instruments/instrument.csv';
const KITE_INSTRUMENTS = 'https://api.kite.trade/instruments';
const HOUR = 3_600_000;

describe('RateLimiter', () => {
  function limiter(maxWaitMs = 3000) {
    let now = 0;
    const slept: number[] = [];
    const l = new RateLimiter({ now: () => now, sleep: async (ms) => void slept.push(ms), maxWaitMs });
    return { l, slept, advance: (ms: number) => (now += ms) };
  }

  it('lets a full bucket through, then waits for the next token', async () => {
    const t = limiter();
    await t.l.acquire('ba_1', 2);
    await t.l.acquire('ba_1', 2);
    expect(t.slept).toEqual([]);
    await t.l.acquire('ba_1', 2);
    expect(t.slept).toEqual([500]);
    // Buckets are per account.
    await t.l.acquire('ba_2', 2);
    expect(t.slept).toEqual([500]);
  });

  it('refills over time, never above the rate', async () => {
    const t = limiter();
    await t.l.acquire('ba_1', 1);
    t.advance(10_000);
    await t.l.acquire('ba_1', 1);
    expect(t.slept).toEqual([]);
    await t.l.acquire('ba_1', 1);
    expect(t.slept).toEqual([1000]);
  });

  it('throws RATE_LIMITED rather than wait longer than maxWaitMs, without spending a token', async () => {
    const t = limiter(2000);
    await t.l.acquire('ba_1', 1);
    await t.l.acquire('ba_1', 1); // wait 1000
    await t.l.acquire('ba_1', 1); // wait 2000
    const e = await t.l.acquire('ba_1', 1).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BrokerError);
    expect(e).toMatchObject({ code: 'RATE_LIMITED', message: 'Too many requests to this broker account. Try again in a moment.' });
    expect(t.slept).toEqual([1000, 2000]);
    // The refused call gave its token back: one second later the wait is 2 s again, not 3.
    t.advance(1000);
    await t.l.acquire('ba_1', 1);
    expect(t.slept).toEqual([1000, 2000, 2000]);
  });
});

/** A broker network where each test sets the answers it needs. */
function network() {
  const routes = new Map<string, () => Response>();
  const fetch = fakeFetch((url) => {
    const route = routes.get(defined(url.split('?')[0]));
    if (!route) throw new Error(`Unexpected network call to ${url}`);
    return route();
  });
  return { routes, fetch };
}

async function world(env: Record<string, string> = {}) {
  const net = network();
  const h = await harness({ env, fetch: net.fetch });
  const s = h.services;
  const user = await s.identity.registerUser({ phone: '9876543210' });
  const events: StreamEvent[] = [];
  s.events.subscribe(user.id, (e) => events.push(e));
  const accounts = new BrokerAccountRepository(s.db);
  const link = async (broker: string, label: string, credentials: Record<string, string>, mode: 'live' | 'paper' = 'live') =>
    (await s.brokerAccounts.link(user.id, { broker, label, mode, credentials })).account.id;
  const angel = async (token: { refreshToken: string | null; expiresAt: Date } | null) => {
    const id = await link('angelone', 'Angel', { apiKey: 'ak', apiSecret: 'as', clientCode: 'A123', pin: '1234' });
    if (token) await s.gateway.saveToken(id, { accessToken: 'JWT1', ...token });
    return id;
  };
  const find = async (id: string) => defined(await accounts.find(id));
  return { ...h, s, net, user, events, accounts, link, angel, find };
}

describe('BrokerGateway', () => {
  it('builds a context with decrypted credentials and session, and lists brokers', async () => {
    const w = await world();
    const id = await w.link('zerodha', 'Kite', { apiKey: 'kite_key', apiSecret: 'kite_secret' });
    const expiresAt = new Date(NOW.getTime() + HOUR);
    await w.s.gateway.saveToken(id, { accessToken: 'AT1', refreshToken: null, expiresAt });
    const account = await w.find(id);
    expect(account.credentialsEnc).not.toContain('kite_secret');
    expect(account.tokenEnc).not.toContain('AT1');
    expect(account).toMatchObject({ tokenState: 'valid', tokenMessage: null, lastAuthAt: NOW, tokenExpiresAt: expiresAt });
    const ctx = w.s.gateway.context(account);
    expect(ctx).toMatchObject({
      accountId: id,
      credentials: { apiKey: 'kite_key', apiSecret: 'kite_secret', extra: {} },
      token: { accessToken: 'AT1', refreshToken: null, expiresAt },
    });
    expect(ctx.http.dryRun).toBe(true);
    expect(w.s.gateway.dryRun).toBe(true);
    expect(w.s.gateway.brokers().map((b) => b.code)).toEqual(['zerodha', 'upstox', 'angelone', 'groww']);
    expect(w.s.gateway.adapterFor({ broker: 'zerodha', mode: 'paper' }).code).toBe('paper');
    expect(() => w.s.gateway.brokerAdapter('nope')).toThrow('Unknown broker "nope".');
  });

  it('gives a context without a session when there is no token', async () => {
    const w = await world();
    const id = await w.link('zerodha', 'Kite', { apiKey: 'k', apiSecret: 's' });
    expect(w.s.gateway.context(await w.find(id)).token).toBeNull();
  });

  describe('ensureSession', () => {
    it('is always ready for paper accounts, and for live ones with an unexpired token', async () => {
      const w = await world();
      const paper = await w.link('zerodha', 'Paper', {}, 'paper');
      expect(await w.s.gateway.ensureSession(await w.find(paper))).toBe(true);
      const live = await w.angel({ refreshToken: 'RT1', expiresAt: new Date(NOW.getTime() + HOUR) });
      expect(await w.s.gateway.ensureSession(await w.find(live))).toBe(true);
      expect(w.fetch.calls).toHaveLength(0);
    });

    it('asks the user to log in when there is no token', async () => {
      const w = await world();
      const id = await w.angel(null);
      expect(await w.s.gateway.ensureSession(await w.find(id))).toBe(false);
      expect(await w.find(id)).toMatchObject({ tokenState: 'needs_user_action', tokenMessage: 'Angel One (SmartAPI): log in again to trade on this account.' });
      expect(w.events).toEqual([{ type: 'relink_needed', accountId: id, broker: 'angelone', message: 'Angel One (SmartAPI): log in again to trade on this account.' }]);
    });

    it('asks the user to log in when the broker has no headless refresh', async () => {
      const w = await world();
      const id = await w.link('zerodha', 'Kite', { apiKey: 'k', apiSecret: 's' });
      await w.s.gateway.saveToken(id, { accessToken: 'AT', refreshToken: null, expiresAt: new Date(NOW.getTime() - 1) });
      expect(await w.s.gateway.ensureSession(await w.find(id))).toBe(false);
      expect((await w.find(id)).tokenState).toBe('needs_user_action');
      expect(w.events).toEqual([expect.objectContaining({ type: 'relink_needed', broker: 'zerodha', message: 'Zerodha (Kite Connect): log in again to trade on this account.' })]);
      expect(w.fetch.calls).toHaveLength(0);
    });

    it('renews an expired Angel One session with its refresh token and saves the new one', async () => {
      const w = await world();
      const id = await w.angel({ refreshToken: 'RT1', expiresAt: new Date(NOW.getTime() - 1) });
      w.net.routes.set(ANGEL_REFRESH, () => json({ status: true, message: 'SUCCESS', data: { jwtToken: 'Bearer JWT2', refreshToken: 'RT2' } }));
      expect(await w.s.gateway.ensureSession(await w.find(id))).toBe(true);
      expect(jsonOf(w.fetch.calls[0])).toEqual({ refreshToken: 'RT1' });
      expect(defined(w.fetch.calls[0]).headers['Authorization']).toBe('Bearer JWT1');
      const account = await w.find(id);
      // Angel sessions last until midnight IST.
      expect(account).toMatchObject({ tokenState: 'valid', tokenExpiresAt: new Date('2026-10-27T18:30:00Z') });
      expect(w.s.gateway.context(account).token).toMatchObject({ accessToken: 'JWT2', refreshToken: 'RT2' });
      expect(w.events).toEqual([]);
    });

    it('flags the account for re-linking when Angel One refuses the refresh token', async () => {
      const w = await world();
      const id = await w.angel({ refreshToken: 'RT1', expiresAt: new Date(NOW.getTime() - 1) });
      w.net.routes.set(ANGEL_REFRESH, () => json({ status: false, message: 'Invalid Token', errorcode: 'AG8001', data: null }));
      expect(await w.s.gateway.ensureSession(await w.find(id))).toBe(false);
      expect(await w.find(id)).toMatchObject({ tokenState: 'needs_user_action', tokenMessage: "Angel One's session has ended; log in again with your TOTP." });
      expect(w.events).toEqual([expect.objectContaining({ type: 'relink_needed', accountId: id })]);
    });

    it('flags for re-linking when there is no refresh token to use', async () => {
      const w = await world();
      const id = await w.angel({ refreshToken: null, expiresAt: new Date(NOW.getTime() - 1) });
      expect(await w.s.gateway.ensureSession(await w.find(id))).toBe(false);
      expect((await w.find(id)).tokenMessage).toBe('Angel One needs a fresh login with your TOTP.');
      expect(w.fetch.calls).toHaveLength(0);
    });

    it('marks the session expired, to retry later, when the refresh call fails', async () => {
      const w = await world();
      const id = await w.angel({ refreshToken: 'RT1', expiresAt: new Date(NOW.getTime() - 1) });
      w.net.routes.set(ANGEL_REFRESH, () => text('upstream down', 503));
      expect(await w.s.gateway.ensureSession(await w.find(id))).toBe(false);
      expect(await w.find(id)).toMatchObject({ tokenState: 'expired', tokenMessage: 'Session refresh failed; it will be retried.' });
      expect(w.events).toEqual([]);
    });
  });

  describe('broker calls', () => {
    it('refuses calls for unknown accounts and accounts without a session', async () => {
      const w = await world();
      await expect(w.s.gateway.positions('ba_nope')).rejects.toMatchObject({ status: 404, message: 'Broker account not found.' });
      const id = await w.angel(null);
      await expect(w.s.gateway.positions(id)).rejects.toMatchObject({ code: 'AUTH_EXPIRED', message: 'The broker session has expired. Log in to this account again.' });
    });

    it('uses the renewed session for the call itself', async () => {
      const w = await world();
      const id = await w.angel({ refreshToken: 'RT1', expiresAt: new Date(NOW.getTime() - 1) });
      w.net.routes.set(ANGEL_REFRESH, () => json({ status: true, data: { jwtToken: 'JWT2', refreshToken: 'RT2' } }));
      w.net.routes.set(ANGEL_POSITIONS, () => json({ status: true, data: null }));
      expect(await w.s.gateway.positions(id)).toEqual([]);
      expect(defined(w.fetch.calls[1]).headers['Authorization']).toBe('Bearer JWT2');
    });

    it('flags the account for re-linking when the broker rejects the session mid-call', async () => {
      const w = await world();
      const id = await w.angel({ refreshToken: 'RT1', expiresAt: new Date(NOW.getTime() + HOUR) });
      w.net.routes.set(ANGEL_POSITIONS, () => json({ status: false, message: 'Invalid Token', errorcode: 'AG8001' }));
      await expect(w.s.gateway.positions(id)).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
      expect(await w.find(id)).toMatchObject({ tokenState: 'needs_user_action', tokenMessage: 'Angel One (SmartAPI) rejected the session. Log in again.' });
      expect(w.events).toHaveLength(1);
    });

    it('passes other broker errors through without touching the session', async () => {
      const w = await world();
      const id = await w.angel({ refreshToken: 'RT1', expiresAt: new Date(NOW.getTime() + HOUR) });
      w.net.routes.set(ANGEL_POSITIONS, () => text('down', 502));
      await expect(w.s.gateway.positions(id)).rejects.toMatchObject({ code: 'BROKER_UNAVAILABLE' });
      expect((await w.find(id)).tokenState).toBe('valid');
      expect(w.events).toEqual([]);
    });

    it('serves paper accounts from the paper broker', async () => {
      const w = await world();
      const id = await w.link('zerodha', 'Paper', {}, 'paper');
      expect(await w.s.gateway.listOrders(id)).toEqual([]);
      expect(await w.s.gateway.positions(id)).toEqual([]);
      const current: BrokerOrder = {
        brokerOrderId: 'P1', status: 'PARTIALLY_FILLED', quantity: 150, filledQty: 75, avgPricePaise: 100, pricePaise: 100,
        triggerPaise: null, orderType: 'LIMIT', clientRef: null, message: null, raw: null,
      };
      const req: ModifyRequest = {
        brokerOrderId: 'P1', symbol: { nativeId: '1', tradingSymbol: 'X', exchange: 'NFO' }, side: 'BUY', product: 'INTRADAY',
        quantity: 75, orderType: 'LIMIT', pricePaise: 100, triggerPaise: null,
      };
      expect(await w.s.gateway.modifyProblem(id, current, req)).toBe('Quantity must be more than the 75 already filled.');
      expect(await w.s.gateway.modifyProblem(id, current, { ...req, quantity: 150 })).toBeNull();
    });
  });

  describe('instrumentMaster', () => {
    const KITE_CSV = [
      'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
      '12345,48,NIFTY26O2924500CE,NIFTY,0,2026-10-29,24500,0.05,75,CE,NFO-OPT,NFO',
    ].join('\n');

    it('needs a logged-in live account for Zerodha', async () => {
      const w = await world();
      const expired = await w.link('zerodha', 'Old', { apiKey: 'k1', apiSecret: 's1' });
      await w.s.gateway.saveToken(expired, { accessToken: 'OLD', refreshToken: null, expiresAt: new Date(NOW.getTime() - 1) });
      await w.link('zerodha', 'Paper', {}, 'paper');
      await w.link('zerodha', 'No token', { apiKey: 'k3', apiSecret: 's3' });
      await expect(w.s.gateway.instrumentMaster('zerodha')).rejects.toMatchObject({
        code: 'AUTH_EXPIRED',
        message: 'Zerodha (Kite Connect) needs a logged-in account to download instruments.',
      });
      expect(w.fetch.calls).toHaveLength(0);
    });

    it('downloads with a logged-in Zerodha account', async () => {
      const w = await world();
      const id = await w.link('zerodha', 'Kite', { apiKey: 'kk', apiSecret: 'ks' });
      await w.s.gateway.saveToken(id, { accessToken: 'AT', refreshToken: null, expiresAt: new Date(NOW.getTime() + HOUR) });
      w.net.routes.set(KITE_INSTRUMENTS, () => text(KITE_CSV));
      const rows = await w.s.gateway.instrumentMaster('zerodha');
      expect(rows).toEqual([expect.objectContaining({ type: 'CE', underlying: 'NIFTY', strikePaise: 2_450_000, symbol: { nativeId: '12345', tradingSymbol: 'NIFTY26O2924500CE', exchange: 'NFO' } })]);
      expect(defined(w.fetch.calls[0]).headers['Authorization']).toBe('token kk:AT');
    });

    it('downloads Groww\'s public list without any account', async () => {
      const w = await world();
      w.net.routes.set(GROWW_CSV, () =>
        text(
          [
            'exchange,exchange_token,trading_symbol,groww_symbol,name,instrument_type,segment,series,isin,underlying_symbol,underlying_exchange_token,expiry_date,strike_price,lot_size,tick_size',
            'NSE,2885,RELIANCE,NSE-RELIANCE,Reliance,EQ,CASH,EQ,INE002A01018,,,,,1,0.05',
            'NSE,35001,NIFTY26O2924500CE,NSE-NIFTY-29Oct26-24500-CE,,CE,FNO,,,NIFTY,26000,2026-10-29,24500,75,0.05',
            'MCX,1,GOLD,MCX-GOLD,,FUT,COMM,,,GOLD,,2026-11-05,,1,1',
          ].join('\n'),
        ),
      );
      const rows = await w.s.gateway.instrumentMaster('groww');
      expect(rows.map((r) => [r.type, r.underlying, r.symbol.exchange])).toEqual([
        ['EQ', 'RELIANCE', 'NSE:CASH'],
        ['CE', 'NIFTY', 'NSE:FNO'],
      ]);
      expect(w.fetch.calls).toHaveLength(1);
      expect(defined(w.fetch.calls[0]).url).toBe(GROWW_CSV);
    });
  });
});
