import type { Fetch } from '../src/brokers/broker-api.ts';
import type { BrokerAccount } from '../src/domain/account.ts';
import type { TradeSignal } from '../src/domain/signal.ts';

/** 27 Oct 2026, 09:30 IST. */
export const NOW = new Date('2026-10-27T04:00:00Z');
export const clock = () => NOW;

/** A valid ENCRYPTION_KEY for tests. */
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
export const noNetwork = fakeFetch((url) => {
  throw new Error(`Unexpected network call to ${url}`);
});

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const text = (body: string, status = 200) => new Response(body, { status });

export function account(overrides: Partial<BrokerAccount> = {}): BrokerAccount {
  return {
    id: 'acc1',
    userId: 'user1',
    broker: 'zerodha',
    label: 'Main',
    apiKey: 'kitekey123',
    apiSecret: 'kitesecret',
    redirectUri: '',
    accessToken: 'tok',
    tokenIssuedAt: new Date(NOW.getTime() - 60_000),
    enabled: true,
    lots: 2,
    product: 'carryForward',
    paperMode: false,
    createdAt: NOW,
    ...overrides,
  };
}

export function signal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    action: 'BUY',
    underlying: 'SENSEX',
    expiry: '2026-10-29',
    strike: 73100,
    optionType: 'PE',
    entryLow: 400,
    entryHigh: 420,
    stopLoss: 300,
    targets: [540, 600],
    raw: 'BUY SENSEX 29 OCT 73100 PUT AT 400-420 WITH SL OF 300 TGT1 540, TGT2 600',
    warnings: [],
    ...overrides,
  };
}

/** Parses a recorded form body into an object. */
export const formOf = (call: RecordedCall | undefined) => Object.fromEntries(new URLSearchParams(call?.body ?? ''));

/** Parses a recorded JSON body. */
export const jsonOf = (call: RecordedCall | undefined) => JSON.parse(call?.body ?? 'null') as Record<string, unknown>;
