import { expect } from 'vitest';

import type { AccountContext, Credentials, TokenSet } from '../src/brokers/adapter.ts';
import { BrokerHttp, type Fetch } from '../src/brokers/http.ts';
import type { Log } from '../src/logging.ts';

/** 27 Oct 2026 (a Tuesday), 09:30 IST. */
export const NOW = new Date('2026-10-27T04:00:00Z');
export const clock = () => NOW;

/** A valid encryption key for tests. */
export const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type FakeFetch = Fetch & { calls: RecordedCall[] };

/** A fetch that never touches the network: [handler] answers every call, and calls are recorded. */
export function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FakeFetch {
  const calls: RecordedCall[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body as string | undefined,
    });
    return handler(url, init);
  };
  return Object.assign(fn, { calls });
}

/** A request body as text: the clients under test only ever send strings. */
export const bodyText = (init: RequestInit): string => (typeof init.body === 'string' ? init.body : '');

/** A fetch that fails the test if anything calls it. */
export const noNetwork = () =>
  fakeFetch((url) => {
    throw new Error(`Unexpected network call to ${url}`);
  });

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const text = (body: string, status = 200) => new Response(body, { status });

/** A logger that keeps what it's given, for asserting on. */
export function memoryLog(): Log & { lines: { level: string; obj: object; msg: string }[] } {
  const lines: { level: string; obj: object; msg: string }[] = [];
  const log = {
    lines,
    info: (obj: object, msg: string) => void lines.push({ level: 'info', obj, msg }),
    warn: (obj: object, msg: string) => void lines.push({ level: 'warn', obj, msg }),
    error: (obj: object, msg: string) => void lines.push({ level: 'error', obj, msg }),
    child: () => log,
  };
  return log;
}

export const credentials = (overrides: Partial<Credentials> = {}): Credentials => ({
  apiKey: 'key123',
  apiSecret: 'secret456',
  extra: {},
  ...overrides,
});

export const token = (overrides: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: 'AT',
  refreshToken: null,
  expiresAt: new Date(NOW.getTime() + 3600_000),
  ...overrides,
});

/** An adapter call context over [fetch], live (not dry run) unless asked. */
export function ctx(
  fetch: Fetch,
  overrides: { credentials?: Partial<Credentials>; token?: TokenSet | null; dryRun?: boolean; timeoutMs?: number; broker?: string } = {},
): AccountContext {
  return {
    accountId: 'ba_1',
    credentials: credentials(overrides.credentials),
    token: overrides.token === undefined ? token() : overrides.token,
    http: new BrokerHttp({
      broker: overrides.broker ?? 'broker',
      fetch,
      timeoutMs: overrides.timeoutMs ?? 1000,
      dryRun: overrides.dryRun ?? false,
      log: memoryLog(),
    }),
  };
}

/** Parses a recorded form body into an object. */
export const formOf = (call: RecordedCall | undefined) => Object.fromEntries(new URLSearchParams(call?.body ?? ''));

/** Parses a recorded JSON body. */
export const jsonOf = (call: RecordedCall | undefined) => JSON.parse(call?.body ?? 'null') as Record<string, unknown>;

/** [value], or a clear test failure when it's null or undefined (instead of a non-null `!`). */
export function defined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === null || value === undefined) throw new Error(`Expected ${label} to be defined`);
  return value;
}

/** A callback that does nothing. */
export const noop = (): void => undefined;

/** An async callback that does nothing. */
export const asyncNoop = async (): Promise<void> => undefined;

/** A parsed JSON value, typed as `unknown` until the test narrows or asserts it. */
export const parseJson = (text: string): unknown => JSON.parse(text);

/** The `{ error }` body every failed API call returns. */
export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

// Asymmetric matchers typed as `unknown` (vitest types them `any`), for use inside expected objects.
export const anyString = (): unknown => expect.any(String);
export const anyNumber = (): unknown => expect.any(Number);
export const stringMatching = (pattern: RegExp): unknown => expect.stringMatching(pattern);
export const stringContaining = (part: string): unknown => expect.stringContaining(part);
export const objectContaining = (shape: Record<string, unknown>): unknown => expect.objectContaining(shape);
