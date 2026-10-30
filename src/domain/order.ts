import type { Paise } from './money.ts';

export const SIDES = ['BUY', 'SELL'] as const;
export type Side = (typeof SIDES)[number];
export const opposite = (side: Side): Side => (side === 'BUY' ? 'SELL' : 'BUY');

/** SL is stop-loss limit; SL_M is stop-loss market. */
export const ORDER_TYPES = ['MARKET', 'LIMIT', 'SL', 'SL_M'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];
export const needsPrice = (t: OrderType) => t === 'LIMIT' || t === 'SL';
export const needsTrigger = (t: OrderType) => t === 'SL' || t === 'SL_M';

/** DELIVERY is equity cash (CNC); CARRYFORWARD is overnight F&O (NRML). */
export const PRODUCTS = ['DELIVERY', 'INTRADAY', 'CARRYFORWARD'] as const;
export type Product = (typeof PRODUCTS)[number];

export const LEG_STATUSES = [
  'PENDING_SUBMIT',
  'SUBMITTED',
  'OPEN',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'UNKNOWN',
] as const;
/**
 * What one broker did with one leg. `UNKNOWN` means we don't know whether the
 * broker took the order (a timeout or 5xx on submit); reconciliation resolves it.
 */
export type LegStatus = (typeof LEG_STATUSES)[number];

const TERMINAL = new Set<LegStatus>(['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED']);
export const isTerminal = (s: LegStatus) => TERMINAL.has(s);
/** Legs a cancel or modify can still act on. */
export const isWorking = (s: LegStatus) => s === 'SUBMITTED' || s === 'OPEN' || s === 'PARTIALLY_FILLED';

export type ParentStatus = 'IN_PROGRESS' | 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'CANCELLED';

/**
 * A parent's status is derived from its legs, never set directly:
 * any leg unresolved → IN_PROGRESS; all filled → COMPLETE; nothing filled and
 * nothing accepted → FAILED; nothing filled but cancelled/expired after
 * acceptance → CANCELLED; otherwise (some filled) → PARTIAL.
 */
export function parentStatus(legs: readonly { status: LegStatus; filledQty: number }[]): ParentStatus {
  if (legs.length === 0) return 'FAILED';
  if (legs.some((l) => !isTerminal(l.status))) return 'IN_PROGRESS';
  if (legs.every((l) => l.status === 'FILLED')) return 'COMPLETE';
  if (legs.some((l) => l.filledQty > 0)) return 'PARTIAL';
  return legs.every((l) => l.status === 'REJECTED') ? 'FAILED' : 'CANCELLED';
}

/** The order as the user asked for it, before fan-out. */
export interface OrderIntent {
  instrumentId: string;
  side: Side;
  /** Units (shares or contracts), a multiple of the lot size. Same on every account. */
  quantity: number;
  orderType: OrderType;
  product: Product;
  pricePaise: Paise | null;
  triggerPaise: Paise | null;
  /** The price the user saw when submitting: used for the notional check on market orders and for slippage. */
  referencePricePaise: Paise | null;
}

type IntentFields = Pick<OrderIntent, 'orderType' | 'pricePaise' | 'triggerPaise' | 'quantity'>;

/** Each rule an intent must meet, with what to say when it doesn't. */
const INTENT_RULES: readonly [(i: IntentFields) => boolean, (i: IntentFields) => string][] = [
  [(i) => !Number.isInteger(i.quantity) || i.quantity <= 0, () => 'Quantity must be a positive whole number.'],
  [(i) => needsPrice(i.orderType) && (i.pricePaise === null || i.pricePaise <= 0), (i) => `${i.orderType} orders need a price.`],
  [(i) => !needsPrice(i.orderType) && i.pricePaise !== null, (i) => `${i.orderType} orders take no price.`],
  [(i) => needsTrigger(i.orderType) && (i.triggerPaise === null || i.triggerPaise <= 0), (i) => `${i.orderType} orders need a trigger price.`],
  [(i) => !needsTrigger(i.orderType) && i.triggerPaise !== null, (i) => `${i.orderType} orders take no trigger price.`],
];

/** Checks that price and trigger match the order type. Returns the problem, or null. */
export function intentProblem(i: IntentFields): string | null {
  const broken = INTENT_RULES.find(([fails]) => fails(i));
  return broken ? broken[1](i) : null;
}
