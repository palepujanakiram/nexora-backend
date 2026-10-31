import { describe, expect, it } from 'vitest';

import { ANGEL_SCRIP_MASTER } from '../../src/brokers/angelone/index.ts';
import { GROWW_INSTRUMENTS_URL } from '../../src/brokers/groww/index.ts';
import { ADMIN_TOKEN, admin, signIn, testApp } from '../app.ts';
import { fakeFetch, json, text, defined, anyString, anyNumber, type ErrorBody } from '../helpers.ts';

describe('admin credential', () => {
  it('hides /admin entirely when ADMIN_TOKEN is unset', async () => {
    const { app } = await testApp({ env: { ADMIN_TOKEN: '' } });
    const res = await app.inject({ method: 'GET', url: '/admin/clients', headers: admin });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'No such endpoint.' } });
  });

  it('refuses a wrong token with 403 and a missing one with 401', async () => {
    const { app } = await testApp();
    const wrong = await app.inject({ method: 'GET', url: '/admin/clients', headers: { authorization: `Bearer ${ADMIN_TOKEN}x` } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toEqual({ error: { code: 'forbidden', message: 'Admin credential required.' } });
    expect((await app.inject({ method: 'GET', url: '/admin/clients' })).statusCode).toBe(401);
  });

  it('does not accept a user access token', async () => {
    const t = await testApp();
    const me = await signIn(t);
    expect((await t.app.inject({ method: 'GET', url: '/admin/clients', headers: me.headers })).statusCode).toBe(403);
  });
});

describe('users and clients', () => {
  it('registers a user once', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/admin/users', headers: admin, payload: { phone: '98765 43210', email: 'a@b.in' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: anyString(), phone: '+919876543210', email: 'a@b.in', fullName: null, createdAt: '2026-10-27T04:00:00.000Z' });
    const dup = await app.inject({ method: 'POST', url: '/admin/users', headers: admin, payload: { phone: '+919876543210' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: { code: 'conflict', message: 'A user with this mobile number already exists.' } });
  });

  it('registers and lists clients', async () => {
    const { app } = await testApp();
    const created = await app.inject({ method: 'POST', url: '/admin/clients', headers: admin, payload: { name: 'Web', platform: 'web' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Web', platform: 'web', grantTypes: ['otp', 'refresh_token'], createdAt: '2026-10-27T04:00:00.000Z' });
    const list = await app.inject({ method: 'GET', url: '/admin/clients', headers: admin });
    expect(list.json<{ clients: { id: string }[] }>().clients.map((c) => c.id)).toEqual([created.json<{ id: string }>().id]);

    const bad = await app.inject({ method: 'POST', url: '/admin/clients', headers: admin, payload: { name: 'X', platform: 'toaster' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<ErrorBody>().error.message).toMatch(/^platform: /);
  });
});

describe('kill switch, plans and holidays', () => {
  it('reads and flips the kill switch', async () => {
    const { app } = await testApp();
    expect((await app.inject({ method: 'GET', url: '/admin/kill-switch', headers: admin })).json()).toEqual({ on: false, reason: null, at: null });
    const on = await app.inject({ method: 'POST', url: '/admin/kill-switch', headers: admin, payload: { on: true, reason: 'exchange glitch' } });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ on: true, reason: 'exchange glitch', at: '2026-10-27T04:00:00.000Z' });
    expect((await app.inject({ method: 'GET', url: '/admin/kill-switch', headers: admin })).json<{ on: boolean }>().on).toBe(true);
    const off = await app.inject({ method: 'POST', url: '/admin/kill-switch', headers: admin, payload: { on: false } });
    expect(off.json()).toMatchObject({ on: false, reason: null });
  });

  it('upserts a plan and shows it in /plans', async () => {
    const t = await testApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/admin/plans',
      headers: admin,
      payload: { code: 'pro', name: 'Pro', price: '499.00', interval: 'monthly', maxAccounts: 5, maxOrdersPerDay: 100, maxFanout: 5, brokers: ['zerodha'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      code: 'pro',
      name: 'Pro',
      price: '499.00',
      interval: 'monthly',
      limits: { maxAccounts: 5, maxOrdersPerDay: 100, maxFanout: 5, brokers: ['zerodha'] },
    });
    const me = await signIn(t);
    expect((await t.app.inject({ method: 'GET', url: '/plans', headers: me.headers })).json<{ plans: { code: string }[] }>().plans.map((p) => p.code)).toEqual(['pro']);

    const negative = await t.app.inject({
      method: 'POST',
      url: '/admin/plans',
      headers: admin,
      payload: { code: 'neg', name: 'Neg', price: -1, interval: 'monthly', maxAccounts: 1, maxOrdersPerDay: 1, maxFanout: 1, brokers: ['zerodha'] },
    });
    expect(negative.statusCode).toBe(400);
    const badPrice = await t.app.inject({
      method: 'POST',
      url: '/admin/plans',
      headers: admin,
      payload: { code: 'bad', name: 'Bad', price: 'abc', interval: 'monthly', maxAccounts: 1, maxOrdersPerDay: 1, maxFanout: 1, brokers: ['zerodha'] },
    });
    expect(badPrice.statusCode).toBe(400);
    expect(badPrice.json<ErrorBody>().error.message).toMatch(/^price: /);
  });

  it('adds and lists market holidays', async () => {
    const { app } = await testApp();
    const added = await app.inject({ method: 'POST', url: '/admin/holidays', headers: admin, payload: { day: '2026-11-09', name: 'Diwali' } });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toEqual({ day: '2026-11-09', name: 'Diwali' });
    const list = await app.inject({ method: 'GET', url: '/admin/holidays', headers: admin });
    expect(list.statusCode).toBe(200);
    const { holidays } = list.json<{ holidays: { name: string; day: string }[] }>();
    expect(holidays).toHaveLength(1);
    expect(defined(holidays[0]).name).toBe('Diwali');
    expect(defined(holidays[0]).day).toContain('2026-11-0');
    const bad = await app.inject({ method: 'POST', url: '/admin/holidays', headers: admin, payload: { day: '09/11/2026', name: 'Diwali' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<ErrorBody>().error.message).toBe('day: use YYYY-MM-DD');
  });
});

describe('POST /admin/instruments/refresh', () => {
  it('reports each broker on its own, failures included', async () => {
    const fetch = fakeFetch((url) => {
      if (url === ANGEL_SCRIP_MASTER) return json([]);
      if (url === GROWW_INSTRUMENTS_URL) return text('exchange,segment,trading_symbol,instrument_type\n');
      return text('nope', 500);
    });
    const { app } = await testApp({ fetch });
    const res = await app.inject({ method: 'POST', url: '/admin/instruments/refresh', headers: admin, payload: {} });
    expect(res.statusCode).toBe(200);
    const { results } = res.json<{ results: { broker: string; count: number; error: string | null }[] }>();
    const by = Object.fromEntries(results.map((r) => [r.broker, r]));
    expect(Object.keys(by).sort()).toEqual(['angelone', 'groww', 'upstox', 'zerodha']);
    expect(by['angelone']).toEqual({ broker: 'angelone', count: 0, error: null });
    expect(by['groww']).toEqual({ broker: 'groww', count: 0, error: null });
    expect(defined(by['upstox']).error).toEqual(expect.any(String));
    expect(defined(by['zerodha']).error).toMatch(/logged-in account/);
  });

  it('refreshes only the brokers asked for', async () => {
    const fetch = fakeFetch(() => json([]));
    const { app } = await testApp({ fetch });
    const res = await app.inject({ method: 'POST', url: '/admin/instruments/refresh', headers: admin, payload: { brokers: ['angelone'] } });
    expect(res.json()).toEqual({ results: [{ broker: 'angelone', count: 0, error: null }] });
    expect(fetch.calls.map((c) => c.url)).toEqual([ANGEL_SCRIP_MASTER]);
  });
});

describe('reconciliation issues', () => {
  it('lists open issues and resolves them', async () => {
    const t = await testApp();
    await t.services.db.query(
      'INSERT INTO reconciliation_issues (leg_id, broker_account_id, broker_order_id, kind, detail, found_at) VALUES ($1, $2, $3, $4, $5, $6)',
      ['leg_1', 'ba_1', '1001', 'status_mismatch', 'We had OPEN; the broker says FILLED.', new Date('2026-10-27T10:30:00Z')],
    );
    const list = await t.app.inject({ method: 'GET', url: '/admin/reconciliation/issues', headers: admin });
    expect(list.statusCode).toBe(200);
    const issue = defined(list.json<{ issues: { id: number }[] }>().issues[0]);
    expect(issue).toEqual({
      id: anyNumber(),
      legId: 'leg_1',
      accountId: 'ba_1',
      brokerOrderId: '1001',
      kind: 'status_mismatch',
      detail: 'We had OPEN; the broker says FILLED.',
      foundAt: '2026-10-27T10:30:00.000Z',
    });

    const resolved = await t.app.inject({ method: 'POST', url: `/admin/reconciliation/issues/${issue.id}/resolve`, headers: admin });
    expect(resolved.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: '/admin/reconciliation/issues', headers: admin })).json<{ issues: unknown[] }>().issues).toEqual([]);

    const again = await t.app.inject({ method: 'POST', url: `/admin/reconciliation/issues/${issue.id}/resolve`, headers: admin });
    expect(again.statusCode).toBe(404);
    const bad = await t.app.inject({ method: 'POST', url: '/admin/reconciliation/issues/abc/resolve', headers: admin });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<ErrorBody>().error.message).toBe('Issue ids are numbers.');
  });
});

describe('POST /admin/jobs/:name/run', () => {
  it.each(['reconcile', 'eod_reconcile', 'analytics', 'sessions_refresh', 'reencrypt'])('runs %s', async (name) => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'POST', url: `/admin/jobs/${name}/run`, headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ job: string }>().job).toBe(name);
  });

  it('reports what the jobs did', async () => {
    const { app } = await testApp();
    expect((await app.inject({ method: 'POST', url: '/admin/jobs/eod_reconcile/run', headers: admin })).json()).toEqual({
      job: 'eod_reconcile',
      result: { accounts: 0, issues: 0 },
    });
    expect((await app.inject({ method: 'POST', url: '/admin/jobs/reencrypt/run', headers: admin })).json()).toEqual({ job: 'reencrypt', result: 0 });
  });

  it('refuses an unknown job and names the known ones', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/admin/jobs/rm-rf/run', headers: admin });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().error.message).toBe('Unknown job. Jobs: reconcile, eod_reconcile, analytics, sessions_refresh, reencrypt.');
  });
});
