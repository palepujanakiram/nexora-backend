import { generateKeyPairSync } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, expect } from 'vitest';

import { loadConfig } from '../src/config.ts';
import { createServices, type Runtime, type Services } from '../src/container.ts';
import { buildApp } from '../src/http/app.ts';
import { createLogger } from '../src/logging.ts';
import { testDb } from './db.ts';
import { NOW, TEST_KEY, noNetwork, type FakeFetch, asyncNoop, defined } from './helpers.ts';

export const JWT_PRIVATE_KEY = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
export const ADMIN_TOKEN = 'admin-token-for-tests';
export const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };

/** A clock that tests can move forward. Starts at [NOW] (Tue 27 Oct 2026, 09:30 IST). */
export function testClock(start: Date = NOW) {
  let now = start.getTime();
  const clock = () => new Date(now);
  return Object.assign(clock, {
    advance: (ms: number) => {
      now += ms;
    },
    set: (d: Date) => {
      now = d.getTime();
    },
  });
}
export type TestClock = ReturnType<typeof testClock>;

export interface Harness {
  services: Services;
  fetch: FakeFetch;
  clock: TestClock;
  /** Codes the console OTP channel printed, newest last. */
  otps: string[];
}

/** Every service, wired as in production, over an in-memory database and a fake network. */
export async function harness(opts: { env?: Record<string, string>; fetch?: FakeFetch; clock?: TestClock } = {}): Promise<Harness> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite:memory',
    ENCRYPTION_KEYS: `1:${TEST_KEY}`,
    JWT_PRIVATE_KEY,
    ADMIN_TOKEN,
    LOG_LEVEL: 'silent',
    PUBLIC_URL: 'https://nexora.test',
    ...opts.env,
  });
  const fetch = opts.fetch ?? noNetwork();
  const clock = opts.clock ?? testClock();
  const otps: string[] = [];
  const runtime: Runtime = {
    fetch,
    clock,
    sleep: asyncNoop,
    print: (line) => void otps.push(defined(line.split(': ').pop())),
  };
  const services = await createServices(config, runtime, { db: await testDb(), logger: createLogger('silent') });
  return { services, fetch, clock, otps };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/** The HTTP API over [harness]. Closed after each test. */
export async function testApp(opts: Parameters<typeof harness>[0] = {}) {
  const h = await harness(opts);
  const app = await buildApp(h.services);
  apps.push(app);
  return { ...h, app };
}

export const PHONE = '+91 98765 43210';

/** Registers a user and a client through the admin API, signs in with an OTP and returns the bearer headers. */
export async function signIn(t: { app: FastifyInstance; otps: string[] }, phone = PHONE) {
  const user = await t.app.inject({ method: 'POST', url: '/admin/users', headers: admin, payload: { phone } });
  if (user.statusCode !== 201 && user.statusCode !== 409) throw new Error(`create user: ${user.body}`);
  const client = await t.app.inject({ method: 'POST', url: '/admin/clients', headers: admin, payload: { name: 'iOS app', platform: 'ios' } });
  expect(client.statusCode).toBe(201);
  const clientId = client.json<{ id: string }>().id;
  expect((await t.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone } })).statusCode).toBe(200);
  const verified = await t.app.inject({
    method: 'POST',
    url: '/auth/otp/verify',
    payload: { phone, code: t.otps.at(-1), clientId, device: 'iPhone' },
  });
  expect(verified.statusCode).toBe(200);
  const body = verified.json<{ accessToken: string; refreshToken: string; user: { id: string } }>();
  return {
    headers: { authorization: `Bearer ${body.accessToken}` },
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    clientId,
    userId: body.user.id,
  };
}
