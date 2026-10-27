export type TradeAction = 'BUY' | 'SELL';
export type OptionType = 'CE' | 'PE';

/** Underlyings whose options trade on BSE (BFO segment). Everything else is NSE F&O (NFO). */
export const BSE_UNDERLYINGS = new Set(['SENSEX', 'BANKEX', 'SENSEX50']);

/**
 * A parsed option-trading signal, e.g.
 * `BUY SENSEX 29 OCT 73100 PUT AT 400-420 WITH SL OF 300 TGT1 540, TGT2 600`.
 */
export interface TradeSignal {
  action: TradeAction;
  underlying: string;
  /** `YYYY-MM-DD`. */
  expiry: string;
  strike: number;
  optionType: OptionType;
  entryLow: number;
  entryHigh: number;
  stopLoss: number | null;
  targets: number[];
  raw: string;
  warnings: string[];
}

export const isBuy = (s: TradeSignal) => s.action === 'BUY';
export const exitSide = (s: TradeSignal): TradeAction => (isBuy(s) ? 'SELL' : 'BUY');
export const exchangeOf = (s: TradeSignal) => (BSE_UNDERLYINGS.has(s.underlying) ? 'BFO' : 'NFO');

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const fmt = (v: number) => (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2));

/** e.g. `SENSEX 29 OCT 2026 73100 PE`. */
export function contractLabel(s: TradeSignal): string {
  const [y, m, d] = s.expiry.split('-');
  return `${s.underlying} ${d} ${MONTHS[Number(m) - 1]} ${y} ${fmt(s.strike)} ${s.optionType}`;
}

/** e.g. `400–420`, or `400` for a single price. */
export function entryLabel(s: TradeSignal): string {
  return s.entryLow === s.entryHigh ? fmt(s.entryLow) : `${fmt(s.entryLow)}–${fmt(s.entryHigh)}`;
}

/** Case- and spacing-insensitive form of the signal text, used to spot repeats. */
export function normalizeSignalText(text: string): string {
  return text.toUpperCase().replace(/\s+/g, ' ').trim();
}
