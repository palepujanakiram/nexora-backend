import type { Paise } from './money.ts';

export const EXCHANGES = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'] as const;
export type Exchange = (typeof EXCHANGES)[number];

export const INSTRUMENT_TYPES = ['EQ', 'FUT', 'CE', 'PE'] as const;
export type InstrumentType = (typeof INSTRUMENT_TYPES)[number];

/** One tradable contract, the same whichever broker it goes to. */
export interface Instrument {
  /** Canonical id, see [instrumentId]. */
  id: string;
  exchange: Exchange;
  type: InstrumentType;
  /** `RELIANCE`, `NIFTY`, `SENSEX`. */
  underlying: string;
  /** `YYYY-MM-DD` for derivatives. */
  expiry: string | null;
  strikePaise: Paise | null;
  lotSize: number;
  tickPaise: Paise;
}

/**
 * The canonical id: `NSE:EQ:RELIANCE`, `NFO:FUT:NIFTY:2026-10-29`,
 * `BFO:PE:SENSEX:2026-10-29:7310000` (strike in paise).
 */
export function instrumentId(i: Pick<Instrument, 'exchange' | 'type' | 'underlying' | 'expiry' | 'strikePaise'>): string {
  const parts: string[] = [i.exchange, i.type, i.underlying.toUpperCase()];
  if (i.type !== 'EQ') parts.push(i.expiry ?? '');
  if (i.type === 'CE' || i.type === 'PE') parts.push(String(i.strikePaise ?? ''));
  return parts.join(':');
}

/** How one broker names an instrument. A missing mapping means the order is refused for that broker. */
export interface BrokerSymbol {
  /** Kite instrument_token, Upstox instrument_key, Angel symboltoken, Groww trading symbol. */
  nativeId: string;
  tradingSymbol: string;
  /** The exchange code in the broker's own vocabulary (`NFO`, `NSE_FO`, `NSE` + segment FNO, …). */
  exchange: string;
}

export const isExchange = (v: string): v is Exchange => (EXCHANGES as readonly string[]).includes(v);
export const isInstrumentType = (v: string): v is InstrumentType => (INSTRUMENT_TYPES as readonly string[]).includes(v);

export const isDerivative = (i: Pick<Instrument, 'type'>) => i.type !== 'EQ';
