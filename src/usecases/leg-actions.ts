import type { BrokerOrder, ModifyRequest } from '../brokers/adapter.ts';
import type { Leg, ParentOrder } from '../data/orders.ts';
import type { BrokerError } from '../domain/broker-error.ts';
import type { Instrument } from '../domain/instrument.ts';
import { isWorking } from '../domain/order.ts';
import {
  brokerErrorOf,
  cancelOutcome,
  cancelRefusal,
  desiredOrder,
  notModifiable,
  orderProblem,
  type ModifyChanges,
  type Outcome,
} from './order-rules.ts';
import type { OrderSupport } from './order-support.ts';
import { must } from '../domain/invariant.ts';

const LAPSED_ADD = 'Your subscription has lapsed: you can reduce or close positions, not add to them.';

/** What a modify of one leg needs to know about its order. */
export interface ModifyTarget {
  parent: ParentOrder;
  instrument: Instrument;
  changes: ModifyChanges;
  /** The user is in exit-only mode: they may not add quantity to an entry. */
  exitOnly: boolean;
}

/**
 * Cancel and modify on one leg. Every request is followed by a read from the
 * broker, and the outcome reports what the broker says, not what was asked.
 */
export class LegActions {
  private readonly s: OrderSupport;

  constructor(support: OrderSupport) {
    this.s = support;
  }

  async cancel(userId: string, start: Leg): Promise<Outcome> {
    const { legs, gateway, orders } = this.s.d;
    const leg = start.status === 'UNKNOWN' || start.status === 'PENDING_SUBMIT' ? await legs.refresh(start, 'api', userId) : start;
    const refusal = cancelRefusal(leg);
    if (refusal) return refusal;
    let error: BrokerError | null = null;
    try {
      const ack = await gateway.cancel(leg.accountId, must(leg.brokerOrderId, 'the broker order id of a working leg'));
      await orders.note(leg, { action: 'cancel', source: 'api', raw: ack.raw }, this.s.d.clock());
    } catch (e) {
      error = brokerErrorOf(e);
      await orders.note(leg, { action: 'cancel_failed', source: 'api', raw: error.raw }, this.s.d.clock());
    }
    return cancelOutcome(await legs.refresh(leg, 'api', userId), error);
  }

  async modify(userId: string, start: Leg, target: ModifyTarget): Promise<Outcome> {
    if (!isWorking(start.status) || !start.brokerOrderId) return notModifiable(start);
    const want = desiredOrder(start, target.changes);
    const problem = this.problem(start, want, target);
    if (problem) return { outcome: 'not_modifiable', reason: problem };

    const account = must(await this.s.d.accounts.find(start.accountId), `account ${start.accountId} of an existing leg`);
    const req: ModifyRequest = {
      ...want,
      brokerOrderId: start.brokerOrderId,
      side: target.parent.side,
      product: target.parent.product,
      symbol: must(await this.s.symbolFor(account, target.instrument), 'the broker symbol a working leg was placed with'),
    };
    const fresh = await this.current(userId, start);
    if ('outcome' in fresh) return fresh;
    const refused = await this.s.d.gateway.modifyProblem(fresh.leg.accountId, fresh.order, req);
    return refused ? { outcome: 'not_modifiable', reason: refused } : this.send(userId, fresh.leg, req);
  }

  /** The order as the broker has it now (recorded on the leg), or why it can't be modified. */
  private async current(userId: string, start: Leg): Promise<{ leg: Leg; order: BrokerOrder } | Outcome> {
    let order: BrokerOrder;
    try {
      order = await this.s.d.gateway.getOrder(start.accountId, must(start.brokerOrderId, 'the broker order id of a working leg'));
    } catch (e) {
      return { outcome: 'failed', reason: brokerErrorOf(e).message };
    }
    const leg = await this.s.d.legs.apply(start, order, 'api', userId);
    return isWorking(leg.status) ? { leg, order } : notModifiable(leg);
  }

  /** Why the modify can't be sent at all: bad shape, adding to a lapsed entry, or over the order-value limit. */
  private problem(leg: Leg, want: ReturnType<typeof desiredOrder>, t: ModifyTarget): string | null {
    const shape = orderProblem(want, t.instrument);
    if (shape) return shape;
    if (t.exitOnly && t.parent.kind === 'ENTRY' && want.quantity > leg.quantity) return LAPSED_ADD;
    try {
      this.s.d.risk.checkNotional(want.quantity, want.pricePaise ?? want.triggerPaise ?? t.parent.referencePricePaise);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  private async send(userId: string, leg: Leg, req: ModifyRequest): Promise<Outcome> {
    const { legs, gateway, orders } = this.s.d;
    try {
      const ack = await gateway.modify(leg.accountId, req);
      await orders.note(leg, { action: 'modify', source: 'api', raw: ack.raw }, this.s.d.clock());
    } catch (e) {
      const err = brokerErrorOf(e);
      await orders.note(leg, { action: 'modify_failed', source: 'api', raw: err.raw }, this.s.d.clock());
      await legs.refresh(leg, 'api', userId);
      return { outcome: err.outcomeUnknown ? 'unknown' : 'failed', reason: err.message };
    }
    const after = await legs.refresh(leg, 'api', userId);
    const applied = after.quantity === req.quantity && after.pricePaise === req.pricePaise && after.triggerPaise === req.triggerPaise;
    return applied ? { outcome: 'modified' } : { outcome: 'modify_requested', reason: 'The broker accepted the change but hasn\'t confirmed it yet.' };
  }
}
