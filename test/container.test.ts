import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.ts';
import { VERSION, createServices, openDatabase, realRuntime, type Runtime } from '../src/container.ts';
import type { Db } from '../src/data/db.ts';
import { AppError } from '../src/domain/errors.ts';
import { createLogger } from '../src/logging.ts';
import { JWT_PRIVATE_KEY, testClock } from './app.ts';
import { testDb } from './db.ts';
import { TEST_KEY, fakeFetch, json, noNetwork, type FakeFetch, defined, asyncNoop, noop } from './helpers.ts';

const BASE = { DATABASE_URL: 'pglite:memory', ENCRYPTION_KEYS: `1:${TEST_KEY}`, JWT_PRIVATE_KEY, LOG_LEVEL: 'silent' };

const opened: Db[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const runtime = (fetch: FakeFetch = noNetwork()): Runtime => ({ fetch, clock: testClock(), sleep: asyncNoop, print: noop });

describe('openDatabase', () => {
  it('opens a migrated in-memory PGlite', async () => {
    const db = await openDatabase('pglite:memory');
    opened.push(db);
    const [row] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations');
    expect(defined(row).n).toBeGreaterThan(0);
    expect(await db.query('SELECT * FROM paper_orders')).toEqual([]);
  });

  it('opens a PGlite data directory that keeps its data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexora-pglite-'));
    dirs.push(dir);
    const first = await openDatabase(`pglite:${dir}`);
    await first.exec('CREATE TABLE probe (v int)');
    await first.query('INSERT INTO probe VALUES (42)');
    await first.close();
    expect((await readdir(dir)).length).toBeGreaterThan(0);
    const again = await openDatabase(`pglite:${dir}`);
    opened.push(again);
    expect(await again.query('SELECT v FROM probe')).toEqual([{ v: 42 }]);
  });

  it('opens Postgres URLs with the pg driver', async () => {
    // Nothing listens on port 1, so connecting (to run migrations) fails locally.
    await expect(openDatabase('postgres://u:p@127.0.0.1:1/nexora')).rejects.toThrow();
  });
});

describe('createServices', () => {
  it('wires console OTPs and no Razorpay by default', async () => {
    const lines: string[] = [];
    const s = await createServices(loadConfig(BASE), { ...runtime(), print: (l) => void lines.push(l) }, { db: await testDb(), logger: createLogger('silent') });
    expect(s.version).toBe(VERSION);
    await s.identity.registerUser({ phone: '9876543210' });
    await s.identity.requestOtp({ phone: '9876543210', ip: '1.2.3.4' });
    expect(lines).toEqual([expect.stringMatching(/^\[dev\] OTP for \+919876543210: \d{6}$/)]);
    await expect(s.billing.webhook('{}', 'sig', 'evt_1')).rejects.toMatchObject({ status: 503, code: 'billing_unavailable' });
  });

  it('wires MSG91 and Razorpay when configured', async () => {
    const fetch = fakeFetch(() => json({ type: 'success', message: 'ok' }));
    const config = loadConfig({
      ...BASE,
      OTP_PROVIDER: 'msg91',
      MSG91_AUTH_KEY: 'AUTH',
      MSG91_TEMPLATE_ID: 'TPL',
      OTP_LENGTH: '4',
      BILLING_ENABLED: 'true',
      RAZORPAY_KEY_ID: 'rzp_test',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRET: 'whsec',
    });
    const s = await createServices(config, runtime(fetch), { db: await testDb(), logger: createLogger('silent') });
    await s.identity.registerUser({ phone: '9876543210' });
    await s.identity.requestOtp({ phone: '9876543210', ip: '1.2.3.4' });
    expect(fetch.calls).toHaveLength(1);
    const url = new URL(defined(fetch.calls[0]).url);
    expect(url.pathname).toBe('/api/v5/otp');
    expect(url.searchParams.get('template_id')).toBe('TPL');
    expect(url.searchParams.get('otp')).toMatch(/^\d{4}$/);
    expect(defined(fetch.calls[0]).headers['authkey']).toBe('AUTH');
    // Razorpay is wired: a webhook is checked against the secret instead of refused as unconfigured.
    const e = await s.billing.webhook('{}', 'bad-signature', 'evt_1').catch((err: unknown) => err);
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe('bad_signature');
  });

  it('schedules every background job', async () => {
    // 17:00 IST on a weekday: every daily job is due.
    const clock = testClock(new Date('2026-10-27T17:00:00+05:30'));
    const s = await createServices(loadConfig(BASE), { ...runtime(), clock }, { db: await testDb(), logger: createLogger('silent') });
    const ran = await s.scheduler.runDue();
    expect([...ran].sort()).toEqual(['analytics', 'eod_reconcile', 'idempotency_purge', 'instruments_refresh', 'reconcile', 'sessions_refresh']);
    // Daily jobs don't repeat the same day.
    clock.advance(60_000);
    expect(await s.scheduler.runDue()).not.toContain('eod_reconcile');
  });

  it('opens the configured database and logger when none are given', async () => {
    const s = await createServices(loadConfig({ ...BASE, ENCRYPTION_KEYS: undefined, ENCRYPTION_KEY: TEST_KEY }), runtime());
    opened.push(s.db);
    expect(s.logger.level).toBe('silent');
    expect(await s.db.query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });
});

describe('realRuntime', () => {
  it('uses the real clock, sleep and console', async () => {
    const before = Date.now();
    expect(realRuntime.clock().getTime()).toBeGreaterThanOrEqual(before);
    await realRuntime.sleep(1);
    const log = console.log;
    const lines: unknown[] = [];
    console.log = (...args: unknown[]) => void lines.push(args.join(' '));
    try {
      realRuntime.print('hello');
    } finally {
      console.log = log;
    }
    expect(lines).toEqual(['hello']);
    // A data: URL is answered by fetch itself, with no network.
    expect(await (await realRuntime.fetch('data:text/plain,hi')).text()).toBe('hi');
  });
});
