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
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body as string | undefined,
    });
    return handler(url, init);
  };
  return Object.assign(fn, { calls }) as FakeFetch;
}

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
