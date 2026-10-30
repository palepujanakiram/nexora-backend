import type { BrokerOrder } from '../brokers/adapter.ts';
import type { EventSource, Leg, LegPatch, OrderRepository } from '../data/orders.ts';
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

  /** Applies [patch] with an audit event, tells the user's devices, and returns the new leg. */
  async update(leg: Leg, patch: LegPatch, action: string, source: EventSource, raw: RawExchange | null, userId: string): Promise<Leg> {
    const now = this.d.clock();
    const updated = await this.d.orders.updateLeg(leg.id, patch, { action, source, raw }, now);
    if (updated.status !== leg.status) {
      this.d.log.info(
        { parentOrderId: leg.parentOrderId, legId: leg.id, accountId: leg.accountId, broker: leg.broker, fromStatus: leg.status, toStatus: updated.status, op: action },
        'leg status changed',
      );
    }
    const parent = await this.d.orders.parent(leg.parentOrderId);
    this.d.events.publish(userId, { type: 'leg', parentOrderId: leg.parentOrderId, parentStatus: parent!.status, leg: legView(updated) });
    return updated;
  }

  /** Writes what the broker reports about the order into the leg. */
  async apply(leg: Leg, bo: BrokerOrder, action: string, source: EventSource, userId: string): Promise<Leg> {
    const terminal = isTerminal(bo.status);
    const patch: LegPatch = {
      brokerOrderId: bo.brokerOrderId,
      status: bo.status,
      filledQty: bo.filledQty,
      avgPricePaise: bo.avgPricePaise,
      quantity: bo.quantity || leg.quantity,
      pricePaise: bo.pricePaise,
      triggerPaise: bo.triggerPaise,
      reconcileAt: terminal ? null : this.nextCheck(leg.reconcileAttempts),
      reconcileAttempts: terminal ? leg.reconcileAttempts : leg.reconcileAttempts + 1,
    };
    if (bo.orderType) patch.orderType = bo.orderType;
    if (bo.status === 'REJECTED') {
      patch.errorCode = classifyMessage(bo.message ?? '') ?? 'REJECTED_BY_EXCHANGE';
      patch.errorMessage = bo.message ?? 'Rejected by the broker.';
    } else if (leg.status === 'UNKNOWN') {
      patch.errorCode = null;
      patch.errorMessage = null;
    }
    const raw: RawExchange = { request: { method: 'GET', url: `${leg.broker}:order/${bo.brokerOrderId}`, body: null }, response: { status: 200, body: bo.raw } };
    const changed =
      bo.status !== leg.status || bo.filledQty !== leg.filledQty || bo.avgPricePaise !== leg.avgPricePaise ||
      bo.brokerOrderId !== leg.brokerOrderId || (bo.quantity || leg.quantity) !== leg.quantity ||
      bo.pricePaise !== leg.pricePaise || bo.triggerPaise !== leg.triggerPaise;
    if (!changed) {
      await this.d.orders.scheduleReconcile(leg.id, patch.reconcileAt ?? null, patch.reconcileAttempts!);
      return { ...leg, reconcileAt: patch.reconcileAt ?? null, reconcileAttempts: patch.reconcileAttempts! };
    }
    return this.update(leg, patch, action, source, raw, userId);
  }

  /**
   * Reads the leg from the broker and records what it says. For an UNKNOWN
   * leg without a broker order id, looks for our client reference in the
   * order book; when the broker still has no such order after
   * [maxUnknownAttempts] looks, the leg is marked REJECTED (NOT_FOUND).
   */
  async refresh(leg: Leg, source: EventSource, userId: string): Promise<Leg> {
    if (isTerminal(leg.status)) return leg;
    try {
      if (leg.brokerOrderId) {
        return await this.apply(leg, await this.d.gateway.getOrder(leg.accountId, leg.brokerOrderId), 'reconcile', source, userId);
      }
      const match = (await this.d.gateway.listOrders(leg.accountId)).find((o) => o.clientRef === leg.clientRef);
      if (match) return await this.apply(leg, match, 'reconcile', source, userId);
      if (leg.reconcileAttempts + 1 >= this.d.maxUnknownAttempts) {
        return await this.update(
          leg,
          { status: 'REJECTED', errorCode: 'NOT_FOUND', errorMessage: 'The broker has no record of this order, so it was not placed.' },
          'reconcile',
          source,
          null,
          userId,
        );
      }
      return await this.reschedule(leg);
    } catch (e) {
      this.d.log.warn(
        { legId: leg.id, accountId: leg.accountId, broker: leg.broker, code: e instanceof BrokerError ? e.code : 'INTERNAL', attempt: leg.reconcileAttempts },
        'reconcile read failed',
      );
      return this.reschedule(leg);
    }
  }

  private async reschedule(leg: Leg): Promise<Leg> {
    const at = this.nextCheck(leg.reconcileAttempts);
    await this.d.orders.scheduleReconcile(leg.id, at, leg.reconcileAttempts + 1);
    return { ...leg, reconcileAt: at, reconcileAttempts: leg.reconcileAttempts + 1 };
  }
}
