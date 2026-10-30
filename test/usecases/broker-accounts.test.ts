import { describe, expect, it } from 'vitest';

import { BillingRepository, type Plan } from '../../src/data/billing.ts';
import { BrokerAccountRepository } from '../../src/data/broker-accounts.ts';
import { SecretBox } from '../../src/data/crypto.ts';
import { BrokerAccountService, maskKey } from '../../src/usecases/broker-accounts.ts';
import { harness } from '../app.ts';
import { FakeKite, brokerWorld } from '../fakes.ts';
import { NOW, TEST_KEY, formOf, json, memoryLog, defined, stringMatching } from '../helpers.ts';

const BILLING_ENV = {
  BILLING_ENABLED: 'true',
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret',
  RAZORPAY_WEBHOOK_SECRET: 'whsec',
};
const HOUR = 3_600_000;
const KITE = { apiKey: 'kite_api_key', apiSecret: 'kite_secret' };

async function world(env: Record<string, string> = {}) {
  const kite = new FakeKite();
  const angel = { answer: () => json({ status: true, data: { jwtToken: 'JWT2', refreshToken: 'RT2' } }) };
  const fetch = brokerWorld(kite, {
    handle: (url) => (url.startsWith('https://apiconnect.angelone.in') ? angel.answer() : null),
  });
  const h = await harness({ env, fetch });
  const s = h.services;
  const user = await s.identity.registerUser({ phone: '9876543210' });
  const other = await s.identity.registerUser({ phone: '9123456780' });
  const repo = new BrokerAccountRepository(s.db);
  const link = async (label: string, broker = 'zerodha', mode: 'live' | 'paper' = 'live', credentials: Record<string, string> = KITE, userId = user.id) =>
    s.brokerAccounts.link(userId, { broker, label, mode, credentials });
  return { ...h, s, kite, angel, user, other, repo, link };
}

/** The `state` Kite will hand back on the redirect, from the login URL we built. */
const stateOf = (url: string) => defined(new URLSearchParams(defined(new URL(url).searchParams.get('redirect_params'))).get('state'));

describe('brokers', () => {
  it('lists every broker with its capabilities and credential fields', async () => {
    const w = await world();
    const brokers = w.s.brokerAccounts.brokers();
    expect(brokers.map((b) => b.code)).toEqual(['zerodha', 'upstox', 'angelone', 'groww']);
    expect(defined(brokers.find((b) => b.code === 'upstox')).credentialFields.map((f) => f.name)).toEqual(['apiKey', 'apiSecret', 'redirectUri']);
    expect(defined(brokers.find((b) => b.code === 'angelone')).capabilities.headlessRefresh).toBe(true);
  });
});

describe('link', () => {
  it('stores a live account encrypted and starts the broker login with a signed state', async () => {
    const w = await world();
    const { account, link } = await w.link('  My Kite ');
    expect(account).toEqual({
      id: stringMatching(/^ba_/),
      broker: 'zerodha',
      label: 'My Kite',
      mode: 'live',
      apiKeyMasked: 'ki••••ey',
      token: { state: 'none', expiresAt: null, lastAuthAt: null, message: null },
      createdAt: NOW.toISOString(),
    });
    expect(JSON.stringify(account)).not.toContain('kite_secret');
    const stored = defined(await w.repo.find(account.id));
    expect(stored.credentialsEnc).toMatch(/^v1:/);
    expect(stored.credentialsEnc).not.toContain('kite_secret');
    expect(link).toMatchObject({ kind: 'redirect' });
    const url = new URL((link as { url: string }).url);
    expect(url.origin + url.pathname).toBe('https://kite.zerodha.com/connect/login');
    expect(url.searchParams.get('api_key')).toBe('kite_api_key');
    expect(stateOf(url.toString())).toMatch(/^[\w-]+$/);
  });

  it('needs every required credential for a live account, but none for paper', async () => {
    const w = await world();
    await expect(w.link('Up', 'upstox', 'live', { apiKey: 'k', apiSecret: 's' })).rejects.toMatchObject({ status: 400, message: 'Upstox needs Redirect URI.' });
    await expect(w.link('Kite', 'zerodha', 'live', { apiKey: ' ', apiSecret: 's' })).rejects.toMatchObject({ message: 'Zerodha (Kite Connect) needs API key.' });
    const paper = await w.link('Paper', 'zerodha', 'paper', {});
    expect(paper.account).toMatchObject({ mode: 'paper', apiKeyMasked: '', token: { state: 'valid', expiresAt: null, message: null } });
    expect(paper.link).toEqual({ kind: 'input', fields: [], message: 'Paper accounts need no broker login.', url: null });
  });

  it('keeps broker extras and drops blank ones', async () => {
    const w = await world();
    const { account } = await w.link('Angel', 'angelone', 'live', { apiKey: 'ak', apiSecret: 'as', clientCode: ' A1 ', pin: '1234', ignored: 'x' });
    expect(w.s.gateway.credentials(defined(await w.repo.find(account.id)))).toEqual({ apiKey: 'ak', apiSecret: 'as', extra: { clientCode: 'A1', pin: '1234' } });
    const paper = await w.link('Angel paper', 'angelone', 'paper', { apiKey: 'ak', clientCode: '' });
    expect(w.s.gateway.credentials(defined(await w.repo.find(paper.account.id)))).toEqual({ apiKey: 'ak', apiSecret: '', extra: {} });
  });

  it('refuses unknown brokers, blank names and duplicate names', async () => {
    const w = await world();
    await expect(w.link('X', 'icici')).rejects.toMatchObject({ status: 404, message: 'Unknown broker "icici".' });
    await expect(w.link('   ')).rejects.toMatchObject({ status: 400, message: 'Give the account a name.' });
    await w.link('Kite');
    await expect(w.link('KITE')).rejects.toMatchObject({ status: 409, message: 'You already have an account with this name.' });
    // Another user may use the same name.
    await expect(w.link('Kite', 'zerodha', 'live', KITE, w.other.id)).resolves.toBeDefined();
  });

  describe('with billing on', () => {
    const PLAN: Plan = {
      code: 'basic', name: 'Basic', pricePaise: 49_900, interval: 'monthly', maxAccounts: 1, maxOrdersPerDay: 20, maxFanout: 1,
      brokers: ['zerodha'], razorpayPlanId: 'plan_b', active: true,
    };

    async function subscribed() {
      const w = await world(BILLING_ENV);
      const billing = new BillingRepository(w.s.db);
      await billing.upsertPlan(PLAN);
      await billing.createSubscription({
        id: 'sub_1', userId: w.user.id, planCode: 'basic', status: 'active', currentPeriodEnd: new Date(NOW.getTime() + 10 * 86_400_000),
        graceUntil: null, cancelAtPeriodEnd: false, providerRef: 'sub_rp_1', checkoutUrl: null, createdAt: NOW, updatedAt: NOW,
      });
      return w;
    }

    it('refuses brokers outside the plan', async () => {
      const w = await subscribed();
      await expect(w.link('Up', 'upstox', 'live', { ...KITE, redirectUri: 'https://x.test/cb' })).rejects.toMatchObject({
        status: 402,
        code: 'plan_limit',
        message: "Your plan doesn't include Upstox.",
        details: { limit: 'brokers' },
      });
    });

    it('refuses more accounts than the plan allows', async () => {
      const w = await subscribed();
      await w.link('Kite');
      await expect(w.link('Kite 2')).rejects.toMatchObject({
        status: 402,
        code: 'plan_limit',
        message: 'Your plan links at most 1 accounts.',
        details: { limit: 'max_accounts', max: 1 },
      });
      expect(await w.repo.countForUser(w.user.id)).toBe(1);
    });

    it('lets a user without a subscription link accounts (trading is what needs one)', async () => {
      const w = await world(BILLING_ENV);
      await w.link('Kite');
      await w.link('Kite 2');
      expect(await w.repo.countForUser(w.user.id)).toBe(2);
    });
  });
});

describe('completing the login', () => {
  it('finishes from the broker redirect and stores the session', async () => {
    const w = await world();
    const { account, link } = await w.link('Kite');
    const view = await w.s.brokerAccounts.callback('zerodha', { state: stateOf((link as { url: string }).url), request_token: 'rt123', action: 'login' });
    expect(view.token).toEqual({ state: 'valid', expiresAt: '2026-10-28T00:30:00.000Z', lastAuthAt: NOW.toISOString(), message: null });
    expect(formOf(w.fetch.calls[0])).toMatchObject({ api_key: 'kite_api_key', request_token: 'rt123' });
    const stored = defined(await w.repo.find(account.id));
    expect(w.s.gateway.context(stored).token?.accessToken).toBe('AT-rt123');
  });

  it('refuses a redirect without state, with a garbled state, or an expired one', async () => {
    const w = await world();
    const { link } = await w.link('Kite');
    const state = stateOf((link as { url: string }).url);
    await expect(w.s.brokerAccounts.callback('zerodha', { request_token: 'r' })).rejects.toMatchObject({ status: 400, message: 'The broker redirect carried no state.' });
    await expect(w.s.brokerAccounts.callback('zerodha', { state: 'garbage', request_token: 'r' })).rejects.toMatchObject({
      status: 400,
      message: 'This login link is invalid. Start again from the app.',
    });
    const tampered = Buffer.from(Buffer.from(state, 'base64url').toString().replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))).toString('base64url');
    await expect(w.s.brokerAccounts.callback('zerodha', { state: tampered, request_token: 'r' })).rejects.toMatchObject({ status: 400 });
    w.clock.advance(15 * 60_000 + 1);
    await expect(w.s.brokerAccounts.callback('zerodha', { state, request_token: 'r' })).rejects.toMatchObject({
      status: 400,
      message: 'This login link has expired. Start again from the app.',
    });
    expect(w.fetch.calls).toHaveLength(0);
  });

  it('refuses a state for another broker, or for an account since unlinked', async () => {
    const w = await world();
    const { account, link } = await w.link('Kite');
    const state = stateOf((link as { url: string }).url);
    await expect(w.s.brokerAccounts.callback('upstox', { state, code: 'c' })).rejects.toMatchObject({ status: 404, message: 'Broker account not found.' });
    await w.s.brokerAccounts.unlink(w.user.id, account.id);
    await expect(w.s.brokerAccounts.callback('zerodha', { state, request_token: 'r' })).rejects.toMatchObject({ status: 404 });
  });

  it('completes with what the user typed or pasted', async () => {
    const w = await world();
    const { account } = await w.link('Kite');
    const view = await w.s.brokerAccounts.completeLink(w.user.id, account.id, { url: 'https://nexora.test/broker-callback/zerodha?request_token=pasted&status=success' });
    expect(view.token.state).toBe('valid');
    expect(formOf(w.fetch.calls[0])['request_token']).toBe('pasted');
    await expect(w.s.brokerAccounts.completeLink(w.other.id, account.id, {})).rejects.toMatchObject({ status: 404 });
  });

  it('records a failed login on the account: 401 for a bad login, 502 when the broker fails', async () => {
    const w = await world();
    const { account } = await w.link('Kite');
    await expect(w.s.brokerAccounts.completeLink(w.user.id, account.id, {})).rejects.toMatchObject({
      status: 401,
      code: 'broker_login_failed',
      message: 'No "request_token" in the broker\'s redirect.',
      details: { code: 'AUTH_EXPIRED' },
    });
    expect(await w.s.brokerAccounts.get(w.user.id, account.id)).toMatchObject({
      token: { state: 'needs_user_action', message: 'No "request_token" in the broker\'s redirect.' },
    });
    w.kite.down.add('');
    await expect(w.s.brokerAccounts.completeLink(w.user.id, account.id, { request_token: 'r' })).rejects.toMatchObject({
      status: 502,
      code: 'broker_login_failed',
      details: { code: 'BROKER_UNAVAILABLE' },
    });
  });

  it('passes on failures that are not the broker\'s', async () => {
    const w = await world();
    const { account } = await w.link('Kite');
    await w.s.db.query('UPDATE broker_accounts SET token_enc = $2, token_expires_at = $3 WHERE id = $1', [account.id, 'v9:corrupt', NOW]);
    await expect(w.s.brokerAccounts.completeLink(w.user.id, account.id, { request_token: 'r' })).rejects.toThrow('Unknown secret format or key version.');
    expect(defined(await w.repo.find(account.id)).tokenState).toBe('none');
  });

  it('has nothing to complete for paper accounts', async () => {
    const w = await world();
    const { account } = await w.link('Paper', 'zerodha', 'paper', {});
    expect(await w.s.brokerAccounts.completeLink(w.user.id, account.id, {})).toMatchObject({ id: account.id, mode: 'paper' });
    expect(w.fetch.calls).toHaveLength(0);
  });

  it('starts a new login with relink', async () => {
    const w = await world();
    const { account } = await w.link('Kite');
    const again = await w.s.brokerAccounts.relink(w.user.id, account.id);
    expect(again.kind).toBe('redirect');
    w.clock.advance(20 * 60_000);
    // A fresh relink carries a fresh state.
    const later = await w.s.brokerAccounts.relink(w.user.id, account.id);
    await expect(w.s.brokerAccounts.callback('zerodha', { state: stateOf((later as { url: string }).url), request_token: 'x' })).resolves.toMatchObject({
      token: { state: 'valid' },
    });
    const paper = await w.link('Paper', 'zerodha', 'paper', {});
    expect(await w.s.brokerAccounts.relink(w.user.id, paper.account.id)).toMatchObject({ kind: 'input', fields: [] });
    await expect(w.s.brokerAccounts.relink(w.other.id, account.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('list, get, update, unlink', () => {
  it('lists only the user\'s accounts, and shows an expired session as expired', async () => {
    const w = await world();
    const a = await w.link('Kite');
    await w.link('Theirs', 'zerodha', 'live', KITE, w.other.id);
    await w.s.gateway.saveToken(a.account.id, { accessToken: 'AT', refreshToken: null, expiresAt: new Date(NOW.getTime() + HOUR) });
    expect((await w.s.brokerAccounts.list(w.user.id)).map((x) => [x.label, x.token.state])).toEqual([['Kite', 'valid']]);
    w.clock.advance(HOUR);
    expect((await w.s.brokerAccounts.get(w.user.id, a.account.id)).token.state).toBe('expired');
    await expect(w.s.brokerAccounts.get(w.other.id, a.account.id)).rejects.toMatchObject({ status: 404 });
  });

  it('switches paper to live only once the keys are there', async () => {
    const w = await world();
    const bare = await w.link('Paper', 'zerodha', 'paper', {});
    await expect(w.s.brokerAccounts.update(w.user.id, bare.account.id, { mode: 'live' })).rejects.toMatchObject({
      status: 400,
      message: 'Zerodha (Kite Connect) needs API key.',
    });
    expect(defined(await w.repo.find(bare.account.id)).mode).toBe('paper');

    const keyed = await w.link('Paper 2', 'zerodha', 'paper', KITE);
    expect(await w.s.brokerAccounts.update(w.user.id, keyed.account.id, { mode: 'live' })).toMatchObject({ mode: 'live', token: { state: 'none' } });
    expect(await w.s.brokerAccounts.update(w.user.id, keyed.account.id, { mode: 'live' })).toMatchObject({ mode: 'live' });
    expect(await w.s.brokerAccounts.update(w.user.id, keyed.account.id, {})).toMatchObject({ mode: 'live' });
    expect(await w.s.brokerAccounts.update(w.user.id, keyed.account.id, { mode: 'paper' })).toMatchObject({ mode: 'paper' });
    await expect(w.s.brokerAccounts.update(w.other.id, keyed.account.id, { mode: 'live' })).rejects.toMatchObject({ status: 404 });
  });

  it('unlinks only the owner\'s account and deletes its credentials', async () => {
    const w = await world();
    const { account } = await w.link('Kite');
    await expect(w.s.brokerAccounts.unlink(w.other.id, account.id)).rejects.toMatchObject({ status: 404, message: 'Broker account not found.' });
    await w.s.brokerAccounts.unlink(w.user.id, account.id);
    expect(await w.repo.find(account.id)).toBeNull();
    await expect(w.s.brokerAccounts.unlink(w.user.id, account.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('refreshSessions', () => {
  it('renews what it can, flags the rest, and leaves the others alone', async () => {
    const w = await world();
    const past = new Date(NOW.getTime() - 1);
    await w.link('Paper', 'zerodha', 'paper', {});
    await w.link('Never logged in');
    const fresh = (await w.link('Fresh')).account.id;
    await w.s.gateway.saveToken(fresh, { accessToken: 'AT', refreshToken: null, expiresAt: new Date(NOW.getTime() + HOUR) });
    const kite = (await w.link('Kite expired')).account.id;
    await w.s.gateway.saveToken(kite, { accessToken: 'AT', refreshToken: null, expiresAt: past });
    const flagged = (await w.link('Flagged')).account.id;
    await w.s.gateway.saveToken(flagged, { accessToken: 'AT', refreshToken: null, expiresAt: past });
    await w.repo.setTokenState(flagged, 'needs_user_action', 'log in');
    const angel = (await w.link('Angel', 'angelone', 'live', { apiKey: 'ak', apiSecret: 'as', clientCode: 'A1', pin: '1234' })).account.id;
    await w.s.gateway.saveToken(angel, { accessToken: 'JWT1', refreshToken: 'RT1', expiresAt: past });

    expect(await w.s.brokerAccounts.refreshSessions()).toEqual({ checked: 2, needUser: 1 });
    expect(defined(await w.repo.find(kite)).tokenState).toBe('needs_user_action');
    expect(await w.repo.find(angel)).toMatchObject({ tokenState: 'valid', tokenExpiresAt: new Date('2026-10-27T18:30:00Z') });
    expect(w.fetch.calls.map((c) => c.url)).toEqual(['https://apiconnect.angelone.in/rest/auth/angelbroking/jwt/v1/generateTokens']);
    // Now nothing is due.
    expect(await w.s.brokerAccounts.refreshSessions()).toEqual({ checked: 0, needUser: 0 });
  });
});

describe('reencrypt', () => {
  it('re-encrypts credentials and tokens under the newest key, once', async () => {
    const w = await world();
    const withToken = (await w.link('Kite')).account.id;
    await w.s.gateway.saveToken(withToken, { accessToken: 'AT', refreshToken: null, expiresAt: new Date(NOW.getTime() + HOUR) });
    const without = (await w.link('Kite 2')).account.id;
    expect(await w.s.brokerAccounts.reencrypt()).toBe(0);

    const box = SecretBox.fromConfig(`1:${TEST_KEY},2:${Buffer.alloc(32, 9).toString('base64')}`, null);
    const rotated = new BrokerAccountService({
      accounts: w.repo, gateway: w.s.gateway, entitlements: w.s.entitlements, box, clock: w.clock, log: memoryLog(), callbackBase: 'https://nexora.test/broker-callback',
    });
    expect(await rotated.reencrypt()).toBe(2);
    const a = defined(await w.repo.find(withToken));
    const b = defined(await w.repo.find(without));
    expect(a.credentialsEnc).toMatch(/^v2:/);
    expect(a.tokenEnc).toMatch(/^v2:/);
    expect(b.tokenEnc).toBeNull();
    expect(JSON.parse(box.decrypt(a.credentialsEnc))).toMatchObject({ apiKey: 'kite_api_key', apiSecret: 'kite_secret' });
    expect(JSON.parse(box.decrypt(defined(a.tokenEnc)))).toEqual({ accessToken: 'AT', refreshToken: null });
    expect(await rotated.reencrypt()).toBe(0);
  });

  it('re-encrypts an account whose token alone is stale', async () => {
    const w = await world();
    const box = SecretBox.fromConfig(`1:${TEST_KEY},2:${Buffer.alloc(32, 9).toString('base64')}`, null);
    const id = (await w.link('Kite')).account.id;
    await w.s.gateway.saveToken(id, { accessToken: 'AT', refreshToken: null, expiresAt: new Date(NOW.getTime() + HOUR) });
    const a = defined(await w.repo.find(id));
    await w.repo.saveCredentials(id, box.encrypt(box.decrypt(a.credentialsEnc)), a.tokenEnc);
    const rotated = new BrokerAccountService({
      accounts: w.repo, gateway: w.s.gateway, entitlements: w.s.entitlements, box, clock: w.clock, log: memoryLog(), callbackBase: 'x',
    });
    expect(await rotated.reencrypt()).toBe(1);
    expect(defined(await w.repo.find(id)).tokenEnc).toMatch(/^v2:/);
  });
});

describe('maskKey', () => {
  it('shows only the ends of long keys', () => {
    expect(maskKey('')).toBe('');
    expect(maskKey('abcdef')).toBe('••••');
    expect(maskKey('abcdefg')).toBe('ab••••fg');
  });
});
