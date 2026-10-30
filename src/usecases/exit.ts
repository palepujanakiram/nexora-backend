import type { BrokerAccountRecord } from '../data/broker-accounts.ts';
import { newId } from '../data/crypto.ts';
import type { Leg, ParentOrder } from '../data/orders.ts';
import { badRequest } from '../domain/errors.ts';
import type { BrokerSymbol, Instrument } from '../domain/instrument.ts';
import type { Paise } from '../domain/money.ts';
import { isTerminal, opposite } from '../domain/order.ts';
import type { LegActions } from './leg-actions.ts';
import { legView, type LegView } from './legs.ts';
import { alreadyExited, brokerErrorOf, heldAtBroker, newLeg } from './order-rules.ts';
import type { OrderSupport } from './order-support.ts';

export interface ExitLegResult {
  accountId: string;
  outcome: string;
  reason?: string;
  heldQty?: number;
  exitLeg?: LegView;
  cancelledRemainder?: boolean;
}

export interface ExitResult {
  parentOrderId: string;
  exitOrderId: string | null;
  exitStatus: string | null;
  legs: ExitLegResult[];
}

export interface ExitRequest {
  idempotencyKey: string;
  clientId: string;
  accountIds: string[] | null;
}

/** One account's exit, once worked out: what to tell the user, and what to send (if anything). */
interface ExitPlan {
  result: ExitLegResult;
  send: { account: BrokerAccountRecord; symbol: BrokerSymbol; qty: number; ref: Paise | null } | null;
}

/** Everything one exit call shares across its accounts. */
interface ExitScope {
  userId: string;
  parent: ParentOrder;
  instrument: Instrument;
  earlier: Leg[];
}

/**
 * Squares off filled legs at market. For each account: cancel whatever is
 * still open on the entry, read the live position from the broker, and send
 * the opposite side for the quantity actually held — never more than this
 * order filled, minus earlier exits. Never gated by the subscription.
 */
export class ExitService {
  private readonly s: OrderSupport;
  private readonly actions: LegActions;

  constructor(support: OrderSupport, actions: LegActions) {
    this.s = support;
    this.actions = actions;
  }

  async exit(userId: string, parentId: string, req: ExitRequest): Promise<ExitResult> {
    const parent = await this.s.ownedParent(userId, parentId);
    if (parent.kind !== 'ENTRY') throw badRequest('Only entry orders can be exited.');
    await this.s.d.risk.requireNoKillSwitch();
    const instrument = await this.s.instrument(parent.instrumentId);
    return this.s.locked(parent.id, async () => {
      const scope: ExitScope = { userId, parent, instrument, earlier: await this.s.d.orders.exitLegs(parent.id) };
      const legs = await this.s.selectLegs(parent.id, req.accountIds);
      const plans = await Promise.all(legs.map((leg) => this.plan(scope, leg)));
      const results = plans.map((p) => p.result);
      const sends = plans.flatMap((p) => (p.send ? [p.send] : []));
      if (sends.length === 0) return { parentOrderId: parent.id, exitOrderId: null, exitStatus: null, legs: results };

      const exitParent = await this.place(scope, sends, req);
      const placed = await this.s.d.orders.legs(exitParent.id);
      for (const r of results) {
        const leg = placed.find((l) => l.accountId === r.accountId);
        if (r.outcome === 'exit_placed' && leg) r.exitLeg = legView(leg);
      }
      const exitStatus = (await this.s.d.orders.parent(exitParent.id))!.status;
      return { parentOrderId: parent.id, exitOrderId: exitParent.id, exitStatus, legs: results };
    });
  }

  /** Works out one account's exit: cancel the open remainder, then compare what filled with what the broker holds. */
  private async plan(scope: ExitScope, start: Leg): Promise<ExitPlan> {
    const { accountId } = start;
    const { leg, cancelledRemainder } = await this.closeRemainder(scope.userId, start);
    if (!isTerminal(leg.status)) {
      return none({ accountId, outcome: 'failed', reason: 'Couldn\'t confirm the open part of the order was cancelled; nothing was exited. Try again.' });
    }
    const remaining = leg.filledQty - alreadyExited(scope.earlier, accountId);
    if (remaining <= 0) {
      return none({ accountId, outcome: 'nothing_to_exit', reason: leg.filledQty === 0 ? 'Nothing was filled.' : 'Already exited.', cancelledRemainder });
    }
    const account = (await this.s.d.accounts.find(accountId))!;
    const symbol = (await this.s.symbolFor(account, scope.instrument))!;
    let position: ReturnType<typeof heldAtBroker>;
    try {
      position = heldAtBroker(await this.s.d.gateway.positions(accountId), symbol, scope.parent);
    } catch (e) {
      return none({ accountId, outcome: 'failed', reason: `Couldn't read positions: ${brokerErrorOf(e).message}`, cancelledRemainder });
    }
    const qty = Math.min(position.held, remaining);
    const heldQty = position.held;
    if (qty <= 0) {
      return none({ accountId, outcome: 'nothing_to_exit', reason: 'The broker shows no open position for this order.', heldQty, cancelledRemainder });
    }
    return {
      result: { accountId, outcome: 'exit_placed', heldQty, cancelledRemainder },
      send: { account, symbol, qty, ref: position.lastPrice ?? leg.avgPricePaise },
    };
  }

  /** Cancels whatever of [start] is still open, and returns the leg as the broker now reports it. */
  private async closeRemainder(userId: string, start: Leg): Promise<{ leg: Leg; cancelledRemainder: boolean }> {
    if (isTerminal(start.status)) return { leg: start, cancelledRemainder: false };
    const cancelled = (await this.actions.cancel(userId, start)).outcome === 'cancelled';
    return { leg: (await this.s.d.orders.leg(start.id))!, cancelledRemainder: cancelled };
  }

  /** Creates the EXIT order with one market leg per account and sends them. */
  private async place(scope: ExitScope, sends: NonNullable<ExitPlan['send']>[], req: ExitRequest): Promise<ParentOrder> {
    const { parent, userId } = scope;
    const now = this.s.d.clock();
    const exitParent: ParentOrder = {
      id: newId('po'),
      userId,
      clientId: req.clientId,
      kind: 'EXIT',
      exitOf: parent.id,
      instrumentId: parent.instrumentId,
      side: opposite(parent.side),
      // Exit legs carry their own quantities; the parent records the total.
      quantity: sends.reduce((n, e) => n + e.qty, 0),
      orderType: 'MARKET',
      product: parent.product,
      pricePaise: null,
      triggerPaise: null,
      referencePricePaise: sends[0]!.ref,
      algoId: this.s.d.algoId,
      idempotencyKey: req.idempotencyKey,
      status: 'IN_PROGRESS',
      createdAt: now,
      updatedAt: now,
    };
    const market = { orderType: 'MARKET' as const, pricePaise: null, triggerPaise: null };
    const legs = sends.map((e) => ({ ...e, leg: newLeg(exitParent, e.account, e.qty, market, null) }));
    await this.s.d.orders.create(exitParent, legs.map((e) => e.leg));
    this.s.d.log.info({ parentOrderId: exitParent.id, correlationId: parent.id, userId, count: legs.length, op: 'exit' }, 'fan-out exit');
    await Promise.all(legs.map((e) => this.s.submit(userId, { ...exitParent, referencePricePaise: e.ref }, e.leg, e.symbol)));
    return exitParent;
  }
}

const none = (result: ExitLegResult): ExitPlan => ({ result, send: null });
