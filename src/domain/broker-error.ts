/**
 * The shared taxonomy every adapter maps broker failures into. TIMEOUT and
 * BROKER_UNAVAILABLE on a write mean the outcome is unknown: the order may
 * have reached the broker, so the leg becomes UNKNOWN and is reconciled.
 */
export const BROKER_ERROR_CODES = [
  'AUTH_EXPIRED',
  'INSUFFICIENT_FUNDS',
  'RATE_LIMITED',
  'MARKET_CLOSED',
  'INVALID_SYMBOL',
  'REJECTED_BY_EXCHANGE',
  'UNSUPPORTED',
  'NOT_FOUND',
  'TIMEOUT',
  'BROKER_UNAVAILABLE',
  'DRY_RUN',
  'UNKNOWN',
] as const;
export type BrokerErrorCode = (typeof BROKER_ERROR_CODES)[number];

/** One HTTP round trip to a broker, with credentials stripped, kept for the audit trail. */
export interface RawExchange {
  request: { method: string; url: string; body: unknown };
  response: { status: number; body: unknown } | null;
}

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;
  readonly raw: RawExchange | null;

  constructor(code: BrokerErrorCode, message: string, raw: RawExchange | null = null) {
    super(message);
    this.name = 'BrokerError';
    this.code = code;
    this.raw = raw;
  }

  /** Whether the request may have taken effect at the broker anyway. */
  get outcomeUnknown(): boolean {
    return this.code === 'TIMEOUT' || this.code === 'BROKER_UNAVAILABLE';
  }
}

/** Common phrases in broker rejection messages, checked in order after broker-specific codes. */
const MESSAGE_CODES: readonly [RegExp, BrokerErrorCode][] = [
  [/insufficient|margin (?:shortfall|exceeds|required)|not enough (?:funds|margin)|fund/, 'INSUFFICIENT_FUNDS'],
  [/market (?:is )?closed|markets are closed|outside (?:market|trading) hours|after market/, 'MARKET_CLOSED'],
  [/too many requests|rate limit|exceeding access rate|throttl/, 'RATE_LIMITED'],
  [/invalid (?:access )?token|token (?:is )?(?:invalid|expired)|session expired|unauthori[sz]ed|invalid session/, 'AUTH_EXPIRED'],
  [/invalid (?:symbol|instrument|tradingsymbol|scrip)|instrument (?:not found|expired)|symbol not found/, 'INVALID_SYMBOL'],
];

/** The taxonomy code a broker's message points to, or null. */
export function classifyMessage(message: string): BrokerErrorCode | null {
  const m = message.toLowerCase();
  return MESSAGE_CODES.find(([pattern]) => pattern.test(m))?.[1] ?? null;
}
