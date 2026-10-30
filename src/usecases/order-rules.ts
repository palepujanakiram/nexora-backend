import type { BrokerAdapter, BrokerPosition } from '../brokers/adapter.ts';
import type { BrokerAccountRecord } from '../data/broker-accounts.ts';
import { newClientRef, newId } from '../data/crypto.ts';
import type { Leg, ParentOrder } from '../data/orders.ts';
import { BrokerError } from '../domain/broker-error.ts';
import { AppError } from '../domain/errors.ts';
import type { BrokerSymbol, Instrument } from '../domain/instrument.ts';
import { isOnTick, rupees, type Paise } from '../domain/money.ts';
import { intentProblem, isTerminal, isWorking, type OrderIntent, type OrderType } from '../domain/order.ts';
import { legView } from './legs.ts';

/** What happened to one leg in a cancel or modify. */
export interface Outcome {
  outcome: string;
  reason?: string;
}

export interface PreReject {
  code: string;
  message: string;
}

/** The changes a modify asks for; missing fields keep the leg's current value. */
export interface ModifyChanges {
  quantity?: number | undefined;
  pricePaise?: Paise | null | undefined;
  triggerPaise?: Paise | null | undefined;
  orderType?: OrderType | undefined;
}

export function lotProblem(quantity: number, instrument: Instrument): string | null {
  return quantity % instrument.lotSize === 0 ? null : `Quantity must be a multiple of the lot size ${instrument.lotSize}.`;
}

export function tickProblem(price: Paise | null, trigger: Paise | null, instrument: Instrument): string | null {
  for (const [name, value] of [['Price', price], ['Trigger price', trigger]] as const) {
    if (value !== null && !isOnTick(value, instrument.tickPaise)) {
      return `${name} must be a multiple of the tick size ₹${rupees(instrument.tickPaise)}.`;
    }
  }
  return null;
}

/** The first thing wrong with an order shape on [instrument], or null. */
export function orderProblem(o: Pick<OrderIntent, 'orderType' | 'pricePaise' | 'triggerPaise' | 'quantity'>, instrument: Instrument): string | null {
  return intentProblem(o) ?? lotProblem(o.quantity, instrument) ?? tickProblem(o.pricePaise, o.triggerPaise, instrument);
}

/** Any failure as a BrokerError; unexpected errors count as outcome unknown, never as a clean rejection. */
export function brokerErrorOf(e: unknown): BrokerError {
  if (e instanceof BrokerError) return e;
  if (e instanceof AppError) return new BrokerError('UNKNOWN', e.message);
  return new BrokerError('BROKER_UNAVAILABLE', 'Something went wrong talking to the broker.');
}

/** Refuses a leg up front when its broker can't do what was asked; nothing is sent. */
export function preReject(
  adapter: BrokerAdapter,
  intent: OrderIntent,
  instrument: Instrument,
  symbol: BrokerSymbol | null,
  planBrokers: readonly string[],
): PreReject | null {
  const caps = adapter.capabilities;
  const name = adapter.label;
  const rules: [boolean, string, string][] = [
    [!planBrokers.includes(adapter.code), 'NOT_IN_PLAN', `Your plan doesn't include ${name}.`],
    [!caps.orderTypes.includes(intent.orderType), 'UNSUPPORTED', `${name} doesn't support ${intent.orderType} orders.`],
    [!caps.products.includes(intent.product), 'UNSUPPORTED', `${name} doesn't support the ${intent.product} product.`],
    [!caps.exchanges.includes(instrument.exchange), 'UNSUPPORTED', `${name} doesn't trade on ${instrument.exchange}.`],
    [!symbol, 'INVALID_SYMBOL', `${name} has no mapping for ${instrument.id}. Refresh instruments or pick another account.`],
  ];
  const broken = rules.find(([fails]) => fails);
  return broken ? { code: broken[1], message: broken[2] } : null;
}

/** A new leg of [parent] on [account]: PENDING_SUBMIT, or REJECTED with [reject]'s reason. */
export function newLeg(
  parent: ParentOrder,
  account: BrokerAccountRecord,
  quantity: number,
  intent: Pick<OrderIntent, 'orderType' | 'pricePaise' | 'triggerPaise'>,
  reject: PreReject | null,
): Leg {
  return {
    id: newId('leg'),
    parentOrderId: parent.id,
    accountId: account.id,
    broker: account.broker,
    mode: account.mode,
    clientRef: newClientRef(),
    brokerOrderId: null,
    status: reject ? 'REJECTED' : 'PENDING_SUBMIT',
    quantity,
    filledQty: 0,
    avgPricePaise: null,
    orderType: intent.orderType,
    pricePaise: intent.pricePaise,
    triggerPaise: intent.triggerPaise,
    errorCode: reject?.code ?? null,
    errorMessage: reject?.message ?? null,
    reconcileAt: null,
    reconcileAttempts: 0,
    submittedAt: null,
    terminalAt: reject ? parent.createdAt : null,
    createdAt: parent.createdAt,
    updatedAt: parent.createdAt,
  };
}

const UNCONFIRMED = 'The broker hasn\'t confirmed whether it has this order yet. Reconciliation is checking; try again shortly.';
const FILLED_FIRST = 'Filled before the cancel reached the broker.';

/** Why [leg] can't be cancelled as it stands, or null when a cancel can be sent. */
export function cancelRefusal(leg: Leg): Outcome | null {
  if (leg.status === 'FILLED') return { outcome: 'not_cancellable', reason: 'Already filled.' };
  if (isTerminal(leg.status)) return { outcome: 'not_cancellable', reason: `Already ${leg.status.toLowerCase()}.` };
  if (!isWorking(leg.status) || !leg.brokerOrderId) return { outcome: 'unknown', reason: UNCONFIRMED };
  return null;
}

/** The outcome of a cancel, from the leg as the broker reports it afterwards and the error the cancel got, if any. */
export function cancelOutcome(after: Leg, error: BrokerError | null): Outcome {
  if (error?.outcomeUnknown) return { outcome: 'unknown', reason: error.message };
  if (after.status === 'FILLED') return { outcome: 'not_cancellable', reason: FILLED_FIRST };
  if (error) return { outcome: 'failed', reason: error.message };
  if (after.status === 'CANCELLED') return { outcome: 'cancelled' };
  return { outcome: 'cancel_requested', reason: 'The broker accepted the cancel but hasn\'t confirmed it yet.' };
}

export const notModifiable = (leg: Leg): Outcome => ({ outcome: 'not_modifiable', reason: `The order is ${leg.status.toLowerCase()}.` });

/** The order [leg] should become: [changes] applied, price and trigger kept only where the new order type takes them. */
export function desiredOrder(leg: Leg, changes: ModifyChanges) {
  const orderType = changes.orderType ?? leg.orderType;
  const keepsPrice = orderType === 'LIMIT' || orderType === 'SL';
  const keepsTrigger = orderType === 'SL' || orderType === 'SL_M';
  return {
    quantity: changes.quantity ?? leg.quantity,
    orderType,
    pricePaise: changes.pricePaise !== undefined ? changes.pricePaise : keepsPrice ? leg.pricePaise : null,
    triggerPaise: changes.triggerPaise !== undefined ? changes.triggerPaise : keepsTrigger ? leg.triggerPaise : null,
  };
}

/**
 * How much [parent]'s side the broker shows held in [positions] for
 * [symbol] (same product), and the last price it reported.
 */
export function heldAtBroker(positions: readonly BrokerPosition[], symbol: BrokerSymbol, parent: ParentOrder): { held: number; lastPrice: Paise | null } {
  let held = 0;
  let lastPrice: Paise | null = null;
  for (const p of positions) {
    if (p.symbol.nativeId !== symbol.nativeId || p.product !== parent.product) continue;
    held += Math.max(0, parent.side === 'BUY' ? p.netQty : -p.netQty);
    lastPrice = p.lastPricePaise ?? lastPrice;
  }
  return { held, lastPrice };
}

/** Quantity already exited (or being exited) on [accountId]: fills of finished exit legs, full size of working ones. */
export function alreadyExited(exitLegs: readonly Leg[], accountId: string): number {
  return exitLegs
    .filter((e) => e.accountId === accountId && e.status !== 'REJECTED')
    .reduce((n, e) => n + (isTerminal(e.status) ? e.filledQty : e.quantity), 0);
}

const money = (p: Paise | null) => (p === null ? null : rupees(p));

/** How an order and its legs are shown to clients. */
export function orderView(p: ParentOrder, legs: readonly Leg[]) {
  return {
    parentOrderId: p.id,
    kind: p.kind,
    exitOf: p.exitOf,
    status: p.status,
    instrumentId: p.instrumentId,
    side: p.side,
    quantity: p.quantity,
    orderType: p.orderType,
    product: p.product,
    price: money(p.pricePaise),
    triggerPrice: money(p.triggerPaise),
    referencePrice: money(p.referencePricePaise),
    algoId: p.algoId,
    clientId: p.clientId,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    legs: legs.map(legView),
  };
}
