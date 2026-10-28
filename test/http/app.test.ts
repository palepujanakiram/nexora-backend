import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { createServices } from '../../src/container.ts';
import { buildApp } from '../../src/http/app.ts';
import { MSG91_BASE } from '../../src/brokers/msg91.ts';
import { EGRESS_IP_URL } from '../../src/http/routes/server.ts';
import { TEST_KEY, clock, fakeFetch, json, text, type FakeFetch } from '../helpers.ts';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

const KITE_CSV = [
  'tradingsymbol,name,expiry,strike,tick_size,lot_size,instrument_type,exchange',
  'SENSEX26O2973100PE,SENSEX,2026-10-29,73100,0.05,20,PE,BFO',
].join('\n');

/** Fake broker world: Kite login, instruments, orders, plus the IP lookup. */
const brokerWorld = () =>
  fakeFetch((url) => {
    if (url === EGRESS_IP_URL) return json({ ip: '203.0.113.7' });
    if (url.endsWith('/session/token')) return json({ status: 'success', data: { access_token: 'AT' } });
    if (url.includes('/instruments/')) return text(KITE_CSV);
    if (url.includes('/orders/regular')) return json({ status: 'success', data: { order_id: 'O1' } });
    return json({ status: 'error', message: 'unexpected' }, 500);
  });

async function setup(env: Record<string, string> = {}, fetch: FakeFetch = brokerWorld()) {
  const config = loadConfig({
    DATABASE_PATH: ':memory:',
    ENCRYPTION_KEY: TEST_KEY,
    SIGNUP_CODE: 'invite',
    LOG_LEVEL: 'silent',
    LIVE_TRADING: 'true',
    ...env,
  });
  const app = await buildApp(createServices(config, { fetch, clock, random: () => 0.5 }));
  apps.push(app);
  return { app, fetch };
}

async function signUp(app: FastifyInstance, email = 'me@example.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'long enough pw', signupCode: 'invite', device: 'test' },
  });
  expect(res.statusCode).toBe(201);
  const token = res.json().token as string;
  return { authorization: `Bearer ${token}` };
}

const zerodha = { broker: 'zerodha', label: 'Main', apiKey: 'kitekey123', apiSecret: 'kitesecret' };
const SIGNAL = 'BUY SENSEX 29 OCT 73100 PUT AT 400-420 WITH SL OF 300 TGT1 540';

/** Fake MSG91: any send succeeds; 123456 is the right code. */
const msg91 = () =>
  fakeFetch((url) => {
    if (url.startsWith(`${MSG91_BASE}/otp/verify`)) {
      const ok = new URL(url).searchParams.get('otp') === '123456';
      return json(ok ? { type: 'success', message: 'OTP verified success' } : { type: 'error', message: 'OTP not match' });
    }
    if (url.startsWith(`${MSG91_BASE}/otp`)) return json({ type: 'success', request_id: 'r1' });
    return json({ type: 'error', message: 'unexpected' }, 500);
  });

const MSG91_ENV = { MSG91_AUTH_KEY: 'AUTHKEY123', MSG91_TEMPLATE_ID: 'TPL1' };

describe('mobile + OTP sign-in', () => {
  it('sends a code through MSG91, verifies it and signs the device in', async () => {
    const { app, fetch } = await setup(MSG91_ENV, msg91());
    const sent = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/send',
      headers: { 'x-forwarded-for': '203.0.113.9' },
      payload: { mobile: '98765 43210', signupCode: 'invite' },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toEqual({ mobile: '+919876543210', newUser: true, expiresInSeconds: 300, resendInSeconds: 30 });
    expect(fetch.calls[0]).toMatchObject({ method: 'POST', headers: { authkey: 'AUTHKEY123' } });
    expect(fetch.calls[0]!.url).toContain('template_id=TPL1&mobile=919876543210');

    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { mobile: '+919876543210', otp: '000000' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: { code: 'otp_invalid', message: 'Wrong code. 4 tries left.' } });

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { mobile: '9876543210', otp: '123456', device: 'Pixel 9' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user).toMatchObject({ email: null, phone: '+919876543210' });
    expect(JSON.stringify(ok.json())).not.toContain('AUTHKEY123');

    const auth = { authorization: `Bearer ${ok.json().token}` };
    const me = await app.inject({ url: '/v1/me', headers: auth });
    expect(me.json()).toMatchObject({ email: null, phone: '+919876543210' });
    expect((await app.inject({ url: '/v1/accounts', headers: auth })).statusCode).toBe(200);
  });

  it('validates the body, asks for the invite code, and is off without MSG91 settings', async () => {
    const { app, fetch } = await setup(MSG91_ENV, msg91());
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });
    expect((await post('/v1/auth/otp/send', {})).json().error.code).toBe('bad_request');
    expect((await post('/v1/auth/otp/send', { mobile: '12345' })).json().error.message).toBe('Enter a 10-digit Indian mobile number.');
    const needsCode = await post('/v1/auth/otp/send', { mobile: '9876543210' });
    expect(needsCode.statusCode).toBe(403);
    expect(needsCode.json().error.code).toBe('signup_code_required');
    expect(fetch.calls).toEqual([]);

    const { app: off } = await setup({}, msg91());
    const res = await off.inject({ method: 'POST', url: '/v1/auth/otp/send', payload: { mobile: '9876543210' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('otp_unavailable');
  });

  it('applies the sign-in rate limit to the OTP endpoints', async () => {
    const { app } = await setup({ ...MSG91_ENV, AUTH_RATE_LIMIT_PER_MINUTE: '2' }, msg91());
    const verify = () => app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { mobile: '9876543210', otp: '123456' } });
    expect((await verify()).statusCode).toBe(401);
    expect((await verify()).statusCode).toBe(401);
    expect((await verify()).statusCode).toBe(429);
  });
});

describe('HTTP API', () => {
  it('reports health without signing in', async () => {
    const { app } = await setup({ LIVE_TRADING: 'false' });
    const res = await app.inject('/health');
    expect(res.json()).toEqual({ status: 'ok', service: 'nexora-backend', version: '1.0.0', liveTrading: false });
  });

  it('requires a bearer token for everything under /v1 except sign-in', async () => {
    const { app } = await setup();
    for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer nope' }]) {
      const res = await app.inject({ url: '/v1/accounts', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('unauthorized');
    }
  });

  it('signs up, shows the user, changes password and signs out', async () => {
    const { app } = await setup();
    const auth = await signUp(app);
    const me = await app.inject({ url: '/v1/me', headers: auth });
    expect(me.json()).toMatchObject({ email: 'me@example.com' });

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'me@example.com', password: 'long enough pw' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.email).toBe('me@example.com');

    const changed = await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: auth,
      payload: { currentPassword: 'long enough pw', newPassword: 'another long pw' },
    });
    const fresh = { authorization: `Bearer ${changed.json().token}` };
    expect((await app.inject({ url: '/v1/me', headers: auth })).statusCode).toBe(401);

    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: fresh });
    expect(out.statusCode).toBe(204);
    expect((await app.inject({ url: '/v1/me', headers: fresh })).statusCode).toBe(401);
  });

  it('returns readable validation errors', async () => {
    const { app } = await setup();
    const missing = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'x' } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toEqual({ code: 'bad_request', message: expect.stringContaining('password') });

    const notJson = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{oops',
    });
    expect(notJson.statusCode).toBe(400);
    expect(notJson.json().error.code).toBe('bad_request');

    const auth = await signUp(app);
    const noAccounts = await app.inject({
      method: 'POST',
      url: '/v1/signals/execute',
      headers: auth,
      payload: { text: SIGNAL, accountIds: [] },
    });
    expect(noAccounts.json().error.message).toBe('accountIds: Pick at least one account.');
    const empty = await app.inject({ method: 'POST', url: '/v1/accounts', headers: auth });
    expect(empty.statusCode).toBe(400);
  });

  it('manages accounts without ever returning secrets', async () => {
    const { app } = await setup();
    const auth = await signUp(app);
    const created = await app.inject({ method: 'POST', url: '/v1/accounts', headers: auth, payload: zerodha });
    expect(created.statusCode).toBe(201);
    const account = created.json();
    expect(account).toMatchObject({
      label: 'Main',
      apiKeyMasked: 'kite••••23',
      paperMode: true,
      lots: 1,
      loggedIn: false,
      login: { kind: 'redirect', url: 'https://kite.zerodha.com/connect/login?v=3&api_key=kitekey123' },
    });
    expect(JSON.stringify(account)).not.toContain('kitesecret');

    const listed = await app.inject({ url: '/v1/accounts', headers: auth });
    expect(listed.json().accounts).toHaveLength(1);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/accounts/${account.id}`,
      headers: auth,
      payload: { lots: 3 },
    });
    expect(patched.json().lots).toBe(3);
    expect((await app.inject({ url: `/v1/accounts/${account.id}`, headers: auth })).json().lots).toBe(3);

    // Another user can't see it.
    const other = await signUp(app, 'other@example.com');
    expect((await app.inject({ url: `/v1/accounts/${account.id}`, headers: other })).statusCode).toBe(404);

    const deleted = await app.inject({ method: 'DELETE', url: `/v1/accounts/${account.id}`, headers: auth });
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({ url: '/v1/accounts', headers: auth })).json().accounts).toEqual([]);
  });

  it('runs the broker login, places a live signal and shares the activity log', async () => {
    const { app, fetch } = await setup();
    const auth = await signUp(app);
    const { id } = (
      await app.inject({ method: 'POST', url: '/v1/accounts', headers: auth, payload: { ...zerodha, paperMode: false } })
    ).json();

    const login = await app.inject({ url: `/v1/accounts/${id}/login`, headers: auth });
    expect(login.json()).toMatchObject({ kind: 'redirect', codeParam: 'request_token' });

    const connected = await app.inject({
      method: 'POST',
      url: `/v1/accounts/${id}/session`,
      headers: auth,
      payload: { input: 'https://127.0.0.1/?request_token=RT' },
    });
    expect(connected.json().loggedIn).toBe(true);

    const preview = await app.inject({ method: 'POST', url: '/v1/signals/parse', headers: auth, payload: { text: SIGNAL } });
    expect(preview.json()).toMatchObject({
      contract: 'SENSEX 29 OCT 2026 73100 PE',
      entry: '400–420',
      exchange: 'BFO',
      signal: { underlying: 'SENSEX', targets: [540] },
    });

    const executed = await app.inject({
      method: 'POST',
      url: '/v1/signals/execute',
      headers: auth,
      payload: { text: SIGNAL, accountIds: [id], settings: { exitMode: 'entryOnly' } },
    });
    const [result] = executed.json().results;
    expect(result).toMatchObject({
      accountId: id,
      success: true,
      paper: false,
      symbol: 'SENSEX26O2973100PE',
      quantity: 20,
      orders: [{ kind: 'ENTRY', id: 'O1' }],
      error: null,
      errorCode: null,
    });
    expect(fetch.calls.some((c) => c.url === 'https://api.kite.trade/orders/regular')).toBe(true);

    const activity = await app.inject({ url: '/v1/activity?limit=5', headers: auth });
    expect(activity.json().results).toEqual([result]);

    const disconnected = await app.inject({ method: 'DELETE', url: `/v1/accounts/${id}/session`, headers: auth });
    expect(disconnected.json().loggedIn).toBe(false);
    expect((await app.inject({ method: 'DELETE', url: '/v1/activity', headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ url: '/v1/activity', headers: auth })).json().results).toEqual([]);
  });

  it('maps signal and broker failures to error codes', async () => {
    const { app } = await setup({}, fakeFetch(() => json({ status: 'error', message: 'Token is invalid' }, 403)));
    const auth = await signUp(app);
    const bad = await app.inject({ method: 'POST', url: '/v1/signals/parse', headers: auth, payload: { text: 'hello' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('invalid_signal');

    const { id } = (await app.inject({ method: 'POST', url: '/v1/accounts', headers: auth, payload: zerodha })).json();
    const failed = await app.inject({
      method: 'POST',
      url: `/v1/accounts/${id}/session`,
      headers: auth,
      payload: { input: 'RT' },
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toEqual({ code: 'broker_error', message: 'Kite: Token is invalid' });
  });

  it('reports the server’s outgoing IP to register with brokers', async () => {
    const { app } = await setup({ LIVE_TRADING: 'false' });
    const auth = await signUp(app);
    expect((await app.inject({ url: '/v1/server/ip', headers: auth })).json()).toEqual({ ip: '203.0.113.7', liveTrading: false });

    const down = await setup({}, fakeFetch(() => text('nope', 500)));
    const downAuth = await signUp(down.app);
    const res = await down.app.inject({ url: '/v1/server/ip', headers: downAuth });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toBe('Could not look up the server IP. Try again.');

    const noIp = await setup({}, fakeFetch(() => json({})));
    const noIpAuth = await signUp(noIp.app);
    expect((await noIp.app.inject({ url: '/v1/server/ip', headers: noIpAuth })).statusCode).toBe(502);
  });

  it('limits sign-in attempts per client', async () => {
    const { app } = await setup({ AUTH_RATE_LIMIT_PER_MINUTE: '2' });
    const attempt = () =>
      app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'x@y.z', password: 'whatever pw' } });
    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(401);
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
  });

  it('answers unknown routes and unexpected failures with JSON', async () => {
    const { app } = await setup();
    const missing = await app.inject('/nope');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');

    const crashing = await setup();
    crashing.app.get('/boom', async () => {
      throw new Error('secret detail');
    });
    const res = await crashing.app.inject('/boom');
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toEqual({ code: 'internal', message: 'Something went wrong on the server.' });
  });

  it('allows only configured web origins', async () => {
    const { app } = await setup({ CORS_ORIGINS: 'https://app.example.com' });
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/v1/accounts',
      headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');
    const other = await app.inject({ url: '/health', headers: { origin: 'https://evil.example.com' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});
