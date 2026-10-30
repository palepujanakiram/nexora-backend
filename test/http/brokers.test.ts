import { describe, expect, it, vi } from 'vitest';

import { signIn, testApp } from '../app.ts';
import { FakeKite, brokerWorld } from '../fakes.ts';
import { fakeFetch, json, type FakeFetch } from '../helpers.ts';

const KITE = { apiKey: 'kite-api-key-123', apiSecret: 'kite-SECRET-xyz' };

async function setup(opts: { fetch?: FakeFetch } = {}) {
  const kite = new FakeKite();
  const t = await testApp({ fetch: opts.fetch ?? brokerWorld(kite) });
  const me = await signIn(t);
  const link = (payload: unknown) => t.app.inject({ method: 'POST', url: '/broker-accounts', headers: me.headers, payload: payload as object });
  return { ...t, kite, me, link };
}

/** The `state` that Kite will hand back, read from the login URL's redirect_params. */
const stateOf = (url: string) => new URLSearchParams(new URL(url).searchParams.get('redirect_params')!).get('state')!;

describe('GET /brokers', () => {
  it('lists every supported broker with capabilities and credential fields', async () => {
    const t = await setup();
    const res = await t.app.inject({ method: 'GET', url: '/brokers', headers: t.me.headers });
    expect(res.statusCode).toBe(200);
    const brokers = res.json().brokers as { code: string; label: string; capabilities: object; credentialFields: { name: string }[] }[];
    expect(brokers.map((b) => b.code).sort()).toEqual(['angelone', 'groww', 'upstox', 'zerodha']);
    for (const b of brokers) {
      expect(b.label).toEqual(expect.any(String));
      expect(b.capabilities).toEqual(expect.any(Object));
      expect(b.credentialFields.map((f) => f.name)).toContain('apiKey');
    }
  });
});

describe('POST /broker-accounts', () => {
  it('links a paper account by default, needing no keys', async () => {
    const t = await setup();
    const res = await t.link({ broker: 'zerodha', label: 'Practice' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      account: {
        id: expect.any(String),
        broker: 'zerodha',
        label: 'Practice',
        mode: 'paper',
        apiKeyMasked: '',
        token: { state: 'valid', expiresAt: null, lastAuthAt: null, message: null },
        createdAt: '2026-10-27T04:00:00.000Z',
      },
      link: { kind: 'input', fields: [], message: 'Paper accounts need no broker login.', url: null },
    });
  });

  it('requires the broker keys for a live account', async () => {
    const t = await setup();
    const res = await t.link({ broker: 'zerodha', label: 'Live', mode: 'live', credentials: { apiKey: 'k' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'bad_request', message: 'Zerodha (Kite Connect) needs API secret.' } });
  });

  it('refuses a duplicate label, an unknown broker and a bad body', async () => {
    const t = await setup();
    expect((await t.link({ broker: 'zerodha', label: 'Main' })).statusCode).toBe(201);
    const dup = await t.link({ broker: 'upstox', label: 'main' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.message).toBe('You already have an account with this name.');
    expect((await t.link({ broker: 'nope', label: 'X' })).statusCode).toBeGreaterThanOrEqual(400);
    const bad = await t.link({ broker: 'zerodha', label: 'Y', mode: 'demo' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/^mode: /);
  });

  it('starts the Kite login for a live account with an encrypted state, and never returns the keys', async () => {
    const t = await setup();
    const res = await t.link({ broker: 'zerodha', label: 'Kite', mode: 'live', credentials: KITE });
    expect(res.statusCode).toBe(201);
    const { account, link } = res.json();
    expect(account).toMatchObject({ mode: 'live', apiKeyMasked: 'ki••••23', token: { state: 'none', expiresAt: null } });
    expect(link.kind).toBe('redirect');
    const url = new URL(link.url);
    expect(url.origin + url.pathname).toBe('https://kite.zerodha.com/connect/login');
    expect(url.searchParams.get('api_key')).toBe(KITE.apiKey);
    const state = stateOf(link.url);
    expect(state.length).toBeGreaterThan(20);
    expect(state).not.toContain(account.id);
    expect(res.body).not.toContain(KITE.apiSecret);

    const list = await t.app.inject({ method: 'GET', url: '/broker-accounts', headers: t.me.headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().accounts.map((a: { id: string }) => a.id)).toEqual([account.id]);
    expect(list.body).not.toContain(KITE.apiSecret);
    expect(list.body).not.toContain(KITE.apiKey);

    const one = await t.app.inject({ method: 'GET', url: `/broker-accounts/${account.id}`, headers: t.me.headers });
    expect(one.json()).toEqual(account);
    expect(one.body).not.toContain(KITE.apiSecret);
  });
});

describe('account lifecycle', () => {
  it('switches mode, refusing live without keys', async () => {
    const t = await setup();
    const paper = (await t.link({ broker: 'zerodha', label: 'P' })).json().account;
    const refused = await t.app.inject({ method: 'PATCH', url: `/broker-accounts/${paper.id}`, headers: t.me.headers, payload: { mode: 'live' } });
    expect(refused.statusCode).toBe(400);

    const live = (await t.link({ broker: 'zerodha', label: 'L', mode: 'live', credentials: KITE })).json().account;
    const toPaper = await t.app.inject({ method: 'PATCH', url: `/broker-accounts/${live.id}`, headers: t.me.headers, payload: { mode: 'paper' } });
    expect(toPaper.statusCode).toBe(200);
    expect(toPaper.json()).toMatchObject({ mode: 'paper', token: { state: 'valid' } });
    const back = await t.app.inject({ method: 'PATCH', url: `/broker-accounts/${live.id}`, headers: t.me.headers, payload: { mode: 'live' } });
    expect(back.json().mode).toBe('live');
  });

  it('gives the login to redo, finishes it with the request token, and unlinks', async () => {
    const t = await setup();
    const { account } = (await t.link({ broker: 'zerodha', label: 'Kite', mode: 'live', credentials: KITE })).json();

    const relink = await t.app.inject({ method: 'GET', url: `/broker-accounts/${account.id}/relink`, headers: t.me.headers });
    expect(relink.statusCode).toBe(200);
    expect(relink.json()).toMatchObject({ kind: 'redirect', url: expect.stringContaining('kite.zerodha.com') });

    const done = await t.app.inject({
      method: 'POST',
      url: `/broker-accounts/${account.id}/link`,
      headers: t.me.headers,
      payload: { params: { request_token: 'rt-1' } },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ id: account.id, token: { state: 'valid', lastAuthAt: '2026-10-27T04:00:00.000Z', message: null } });
    expect(done.json().token.expiresAt).toEqual(expect.any(String));
    expect(done.body).not.toContain('AT-rt-1');
    const call = t.fetch.calls.find((c) => c.url.endsWith('/session/token'))!;
    expect(new URLSearchParams(call.body).get('request_token')).toBe('rt-1');

    const del = await t.app.inject({ method: 'DELETE', url: `/broker-accounts/${account.id}`, headers: t.me.headers });
    expect(del.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: `/broker-accounts/${account.id}`, headers: t.me.headers })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/broker-accounts/${account.id}`, headers: t.me.headers })).statusCode).toBe(404);
  });

  it('returns a paper account unchanged when "linking" it', async () => {
    const t = await setup();
    const { account } = (await t.link({ broker: 'zerodha', label: 'P' })).json();
    const res = await t.app.inject({ method: 'POST', url: `/broker-accounts/${account.id}/link`, headers: t.me.headers, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(account);
  });

  it('reports a failed broker login and marks the account', async () => {
    const t = await setup({
      fetch: fakeFetch(() => json({ status: 'error', error_type: 'TokenException', message: 'Token is invalid or has expired.' }, 403)),
    });
    const { account } = (await t.link({ broker: 'zerodha', label: 'Kite', mode: 'live', credentials: KITE })).json();
    const res = await t.app.inject({ method: 'POST', url: `/broker-accounts/${account.id}/link`, headers: t.me.headers, payload: { params: { request_token: 'x' } } });
    expect([401, 502]).toContain(res.statusCode);
    expect(res.json().error).toMatchObject({ code: 'broker_login_failed', details: { code: expect.any(String) } });
    expect(res.statusCode).toBe(res.json().error.details.code === 'AUTH_EXPIRED' ? 401 : 502);
    const after = await t.app.inject({ method: 'GET', url: `/broker-accounts/${account.id}`, headers: t.me.headers });
    expect(after.json().token.state).toBe('needs_user_action');

    const down = await setup({ fetch: fakeFetch(() => json({ status: 'error', error_type: 'NetworkException', message: 'down' }, 503)) });
    const acc = (await down.link({ broker: 'zerodha', label: 'Kite', mode: 'live', credentials: KITE })).json().account;
    const r = await down.app.inject({ method: 'POST', url: `/broker-accounts/${acc.id}/link`, headers: down.me.headers, payload: { params: { request_token: 'x' } } });
    expect(r.statusCode).toBe(502);
    expect(r.json().error.code).toBe('broker_login_failed');
  });

  it("doesn't show or touch another user's account", async () => {
    const t = await setup();
    const { account } = (await t.link({ broker: 'zerodha', label: 'Mine' })).json();
    const other = await signIn(t, '9123456780');
    expect((await t.app.inject({ method: 'GET', url: `/broker-accounts/${account.id}`, headers: other.headers })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/broker-accounts/${account.id}`, headers: other.headers })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/broker-accounts', headers: other.headers })).json()).toEqual({ accounts: [] });
  });
});

describe('GET /broker-callback/:broker', () => {
  it('finishes the Kite login from the browser redirect', async () => {
    const t = await setup();
    const { account, link } = (await t.link({ broker: 'zerodha', label: 'Kite <main>', mode: 'live', credentials: KITE })).json();
    const res = await t.app.inject({
      method: 'GET',
      url: `/broker-callback/zerodha?request_token=rt-9&action=login&status=success&state=${encodeURIComponent(stateOf(link.url))}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('<h1>Account linked</h1>');
    expect(res.body).toContain('Kite &#60;main&#62; is ready to trade.');
    const after = await t.app.inject({ method: 'GET', url: `/broker-accounts/${account.id}`, headers: t.me.headers });
    expect(after.json().token.state).toBe('valid');
  });

  it('shows an error page for a missing, forged, expired or mismatched state', async () => {
    const t = await setup();
    const { link } = (await t.link({ broker: 'zerodha', label: 'Kite', mode: 'live', credentials: KITE })).json();
    const state = stateOf(link.url);

    const none = await t.app.inject({ method: 'GET', url: '/broker-callback/zerodha?request_token=rt' });
    expect(none.statusCode).toBe(400);
    expect(none.body).toContain('<h1>Linking failed</h1>');
    expect(none.body).toContain('The broker redirect carried no state.');

    const forged = await t.app.inject({ method: 'GET', url: '/broker-callback/zerodha?request_token=rt&state=Zm9yZ2Vk' });
    expect(forged.statusCode).toBe(400);
    expect(forged.body).toContain('This login link is invalid. Start again from the app.');

    const wrongBroker = await t.app.inject({ method: 'GET', url: `/broker-callback/upstox?code=c&state=${encodeURIComponent(state)}` });
    expect(wrongBroker.statusCode).toBe(404);
    expect(wrongBroker.body).toContain('Broker account not found.');

    t.clock.advance(16 * 60_000);
    const expired = await t.app.inject({ method: 'GET', url: `/broker-callback/zerodha?request_token=rt&state=${encodeURIComponent(state)}` });
    expect(expired.statusCode).toBe(400);
    expect(expired.body).toContain('This login link has expired. Start again from the app.');
  });

  it('shows a generic 500 page when something unexpected fails', async () => {
    const t = await setup();
    const { link } = (await t.link({ broker: 'zerodha', label: 'Kite', mode: 'live', credentials: KITE })).json();
    vi.spyOn(t.services.brokerAccounts, 'callback').mockRejectedValueOnce(new Error('db exploded'));
    const res = await t.app.inject({ method: 'GET', url: `/broker-callback/zerodha?request_token=rt&state=${encodeURIComponent(stateOf(link.url))}` });
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain('Something went wrong. Try again from the app.');
    expect(res.body).not.toContain('db exploded');
  });
});

describe('POST /webhooks/:broker', () => {
  it("answers 404 for a broker that doesn't send webhooks", async () => {
    const t = await setup();
    const res = await t.app.inject({ method: 'POST', url: '/webhooks/groww', payload: { order_id: '1' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('refuses a body that is not an order update', async () => {
    const t = await setup();
    const res = await t.app.inject({ method: 'POST', url: '/webhooks/zerodha', payload: { hello: 'world' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'bad_request', message: 'Not an order update.' } });
  });

  it('acknowledges an update for an order we do not know', async () => {
    const t = await setup();
    const res = await t.app.inject({ method: 'POST', url: '/webhooks/zerodha', payload: { order_id: '999', order_timestamp: '2026-10-27 09:31:00', checksum: 'x' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ matched: false });
  });
});
