import type { BrokerOrder } from '../brokers/adapter.ts';
import type { EventSource, Leg, LegEvent, LegPatch, OrderRepository } from '../data/orders.ts';
import { BrokerError, classifyMessage, type RawExchange } from '../domain/broker-error.ts';
import { rupees } from '../domain/money.ts';
import { isTerminal } from '../domain/order.ts';
import type { Log } from '../logging.ts';
import type { EventBus } from './events.ts';
import type { BrokerGateway } from './gateway.ts';

/** How a leg is shown to clients. */
export function legView(l: Leg) {
  return {
    legId: l.id,
    accountId: l.accountId,
    broker: l.broker,
    mode: l.mode,
    status: l.status,
    brokerOrderId: l.brokerOrderId,
    quantity: l.quantity,
    filledQty: l.filledQty,
    avgPrice: l.avgPricePaise === null ? null : rupees(l.avgPricePaise),
    orderType: l.orderType,
    price: l.pricePaise === null ? null : rupees(l.pricePaise),
    triggerPrice: l.triggerPaise === null ? null : rupees(l.triggerPaise),
    ...(l.errorCode ? { error: { code: l.errorCode, message: l.errorMessage } } : {}),
    reconcileScheduled: l.reconcileAt !== null,
  };
}

export type LegView = ReturnType<typeof legView>;

export interface LegTrackerDeps {
  orders: OrderRepository;
  gateway: BrokerGateway;
  events: EventBus;
  clock: () => Date;
  log: Log;
  /** First reconciliation delay; doubles per attempt up to [maxDelayMs]. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** After this many looks without the broker knowing an UNKNOWN leg, it's marked REJECTED (NOT_FOUND). */
  maxUnknownAttempts: number;
}

/**
 * Keeps legs in step with the broker. Nothing here assumes an order reached
 * the state that was asked for: every write is followed by a read, and any
 * leg that isn't terminal is read again later.
 */
export class LegTracker {
  private readonly d: LegTrackerDeps;

  constructor(deps: LegTrackerDeps) {
    this.d = deps;
  }

  nextCheck(attempts: number): Date {
    const delay = Math.min(this.d.baseDelayMs * 2 ** attempts, this.d.maxDelayMs);
    return new Date(this.d.clock().getTime() + delay);
  }

  /** Applies [patch] with the audit [event], tells the user's devices, and returns the new leg. */
  async update(leg: Leg, patch: LegPatch, event: LegEvent, userId: string): Promise<Leg> {
    const updated = await this.d.orders.updateLeg(leg.id, patch, event, this.d.clock());
    if (updated.status !== leg.status) {
      this.d.log.info(
        { parentOrderId: leg.parentOrderId, legId: leg.id, accountId: leg.accountId, broker: leg.broker, fromStatus: leg.status, toStatus: updated.status, op: event.action },
        'leg status changed',
      );
    }
    const parent = await this.d.orders.parent(leg.parentOrderId);
    this.d.events.publish(userId, { type: 'leg', parentOrderId: leg.parentOrderId, parentStatus: parent!.status, leg: legView(updated) });
    return updated;
  }

  /** Writes what the broker reports about the order into the leg. */
  async apply(leg: Leg, bo: BrokerOrder, source: EventSource, userId: string): Promise<Leg> {
    const terminal = isTerminal(bo.status);
    const reported: LegPatch = {
      brokerOrderId: bo.brokerOrderId,
      status: bo.status,
      filledQty: bo.filledQty,
      avgPricePaise: bo.avgPricePaise,
      quantity: bo.quantity || leg.quantity,
      pricePaise: bo.pricePaise,
      triggerPaise: bo.triggerPaise,
    };
    const schedule = {
      reconcileAt: terminal ? null : this.nextCheck(leg.reconcileAttempts),
      reconcileAttempts: terminal ? leg.reconcileAttempts : leg.reconcileAttempts + 1,
    };
    const changed = (Object.keys(reported) as (keyof LegPatch)[]).some((k) => reported[k] !== leg[k]);
    if (!changed) {
      await this.d.orders.scheduleReconcile(leg.id, schedule.reconcileAt, schedule.reconcileAttempts);
      return { ...leg, ...schedule };
    }
    const raw: RawExchange = { request: { method: 'GET', url: `${leg.broker}:order/${bo.brokerOrderId}`, body: null }, response: { status: 200, body: bo.raw } };
    const patch: LegPatch = { ...reported, ...schedule, ...errorFields(leg, bo) };
    if (bo.orderType) patch.orderType = bo.orderType;
    return this.update(leg, patch, { action: 'reconcile', source, raw }, userId);
  }

  /**
   * Reads the leg from the broker and records what it says. For an UNKNOWN
   * leg without a broker order id, looks for our client reference in the
   * order book; when the broker still has no such order after
   * [maxUnknownAttempts] looks, the leg is marked REJECTED (NOT_FOUND).
   */
  async refresh(leg: Leg, source: EventSource, userId: string): Promise<Leg> {
    if (isTerminal(leg.status)) return leg;
    let found: BrokerOrder | undefined;
    try {
      found = await this.lookup(leg);
    } catch (e) {
      this.d.log.warn(
        { legId: leg.id, accountId: leg.accountId, broker: leg.broker, code: e instanceof BrokerError ? e.code : 'INTERNAL', attempt: leg.reconcileAttempts },
        'reconcile read failed',
      );
      return this.reschedule(leg);
    }
    if (found) return this.apply(leg, found, source, userId);
    if (leg.reconcileAttempts + 1 < this.d.maxUnknownAttempts) return this.reschedule(leg);
    const notPlaced = { status: 'REJECTED' as const, errorCode: 'NOT_FOUND', errorMessage: 'The broker has no record of this order, so it was not placed.' };
    return this.update(leg, notPlaced, { action: 'reconcile', source, raw: null }, userId);
  }

  /** The broker's view of [leg]: by its order id, or by our client reference in the order book. */
  private async lookup(leg: Leg): Promise<BrokerOrder | undefined> {
    if (leg.brokerOrderId) return this.d.gateway.getOrder(leg.accountId, leg.brokerOrderId);
    return (await this.d.gateway.listOrders(leg.accountId)).find((o) => o.clientRef === leg.clientRef);
  }

  private async reschedule(leg: Leg): Promise<Leg> {
    const at = this.nextCheck(leg.reconcileAttempts);
    await this.d.orders.scheduleReconcile(leg.id, at, leg.reconcileAttempts + 1);
    return { ...leg, reconcileAt: at, reconcileAttempts: leg.reconcileAttempts + 1 };
  }
}

/** A rejection's reason, or clearing the error an UNKNOWN leg carried once the broker has answered. */
function errorFields(leg: Leg, bo: BrokerOrder): LegPatch {
  if (bo.status === 'REJECTED') {
    return { errorCode: classifyMessage(bo.message ?? '') ?? 'REJECTED_BY_EXCHANGE', errorMessage: bo.message ?? 'Rejected by the broker.' };
  }
  return leg.status === 'UNKNOWN' ? { errorCode: null, errorMessage: null } : {};
}
