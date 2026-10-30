import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Runtime } from '../src/container.ts';
import { closeOnSignals, main, start } from '../src/server.ts';
import { JWT_PRIVATE_KEY, testClock } from './app.ts';
import { TEST_KEY, noNetwork } from './helpers.ts';

const ENV = {
  PORT: '0',
  HOST: '127.0.0.1',
  DATABASE_URL: 'pglite:memory',
  ENCRYPTION_KEYS: `1:${TEST_KEY}`,
  JWT_PRIVATE_KEY,
  LOG_LEVEL: 'silent',
};

const runtime = (): Runtime => ({ fetch: noNetwork(), clock: testClock(), sleep: async () => {}, print: () => {} });

const started: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of started.splice(0)) await app.close();
  vi.restoreAllMocks();
});

/** GET /health from the listening socket, over real HTTP on 127.0.0.1. */
async function health(app: FastifyInstance) {
  const { port } = app.server.address() as AddressInfo;
  const res = await globalThis.fetch(`http://127.0.0.1:${port}/health`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('start', () => {
  it('listens and answers /health with jobs off', async () => {
    const app = await start({ ...ENV, JOBS_ENABLED: 'false' }, runtime());
    started.push(app);
    expect(await health(app)).toEqual({
      status: 200,
      body: { status: 'ok', service: 'nexora-backend', version: '2.0.0', liveTrading: false, billing: false },
    });
  });

  it('starts the jobs and closes cleanly', async () => {
    const app = await start({ ...ENV, JOBS_ENABLED: 'true', LIVE_TRADING: 'true' }, runtime());
    expect((await health(app)).body['liveTrading']).toBe(true);
    await app.close();
    expect(app.server.listening).toBe(false);
  });

  it('refuses a bad configuration', async () => {
    await expect(start({ ...ENV, DATABASE_URL: undefined }, runtime())).rejects.toThrow('Invalid configuration');
  });
});

describe('closeOnSignals', () => {
  it('closes the app and exits on each signal, once', async () => {
    const signals: NodeJS.Signals[] = ['SIGUSR2', 'SIGWINCH'];
    const before = signals.map((s) => process.listenerCount(s));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const close = vi.fn(async () => {});
    const listeners = signals.map((s) => process.listeners(s));
    closeOnSignals({ close } as unknown as FastifyInstance, signals);
    try {
      expect(signals.map((s) => process.listenerCount(s))).toEqual(before.map((n) => n + 1));
      process.emit('SIGUSR2');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(close).toHaveBeenCalledTimes(1);
      // `once`: the SIGUSR2 listener removed itself.
      expect(process.listenerCount('SIGUSR2')).toBe(before[0]);
    } finally {
      signals.forEach((s, i) => {
        for (const l of process.listeners(s)) if (!listeners[i]!.includes(l)) process.removeListener(s, l);
      });
    }
    expect(signals.map((s) => process.listenerCount(s))).toEqual(before);
  });

  it('defaults to SIGINT and SIGTERM', () => {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    const listeners = signals.map((s) => process.listeners(s));
    closeOnSignals({ close: async () => {} } as unknown as FastifyInstance);
    try {
      expect(signals.map((s) => process.listenerCount(s))).toEqual(listeners.map((l) => l.length + 1));
    } finally {
      signals.forEach((s, i) => {
        for (const l of process.listeners(s)) if (!listeners[i]!.includes(l)) process.removeListener(s, l);
      });
    }
  });
});

describe('main', () => {
  it('starts the server and closes it on SIGTERM', async () => {
    const before = process.listenerCount('SIGTERM');
    const app = await main({ ...ENV, JOBS_ENABLED: 'false' }, runtime());
    started.push(app);
    expect((await health(app)).status).toBe(200);
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const listener = process.listeners(signal).at(-1)!;
      process.removeListener(signal, listener);
    }
  });
});
