import type { ProductType } from './account.ts';
import type { TradeSignal } from './signal.ts';

export const ENTRY_PRICE_MODES = ['low', 'mid', 'high'] as const;
export type EntryPriceMode = (typeof ENTRY_PRICE_MODES)[number];

export const EXIT_MODES = ['entryOnly', 'withStopAndTarget'] as const;
export type ExitMode = (typeof EXIT_MODES)[number];

/** How a signal is turned into orders. Same choices as the app's settings. */
export interface ExecutionSettings {
  entryPriceMode: EntryPriceMode;
  exitMode: ExitMode;
  /** Which target (0 = TGT1) the exit order uses. */
  targetIndex: number;
}

export const DEFAULT_EXECUTION_SETTINGS: ExecutionSettings = {
  entryPriceMode: 'high',
  exitMode: 'withStopAndTarget',
  targetIndex: 0,
};

/** A broker contract resolved from a signal. */
export interface ResolvedInstrument {
  /** Human-readable trading symbol. */
  symbol: string;
  exchange: string;
  lotSize: number;
  /** Upstox `instrument_key`; unused by the other brokers. */
  instrumentKey?: string;
  tickSize: number;
}

/** An entry limit order and, optionally, a stop loss / target pair the broker manages. */
export interface TradePlan {
  signal: TradeSignal;
  quantity: number;
  entryPrice: number;
  product: ProductType;
  stopLoss: number | null;
  target: number | null;
}

export const hasExits = (p: TradePlan) => p.stopLoss !== null && p.target !== null;

export interface PlacedOrder {
  /** e.g. "ENTRY", "GTT OCO (SL 300 / TGT 540)". */
  kind: string;
  id: string;
}

/** Pricing rules shared by order placement and the signal preview. */
export const TradePricing = {
  entryPrice(s: TradeSignal, mode: EntryPriceMode): number {
    if (mode === 'low') return s.entryLow;
    if (mode === 'mid') return (s.entryLow + s.entryHigh) / 2;
    return s.entryHigh;
  },

  /** The exit target; falls back to the last target when the signal has fewer. */
  targetFor(s: TradeSignal, settings: ExecutionSettings): number | null {
    if (s.targets.length === 0) return null;
    return s.targets[Math.min(settings.targetIndex, s.targets.length - 1)]!;
  },

  roundToTick(price: number, tick: number): number {
    return Number((Math.round(price / tick) * tick).toFixed(2));
  },
};
