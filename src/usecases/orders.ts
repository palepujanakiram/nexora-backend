import { newId } from '../data/crypto.ts';
import type { ParentOrder } from '../data/orders.ts';
import { badRequest, notFound } from '../domain/errors.ts';
import type { Paise } from '../domain/money.ts';
import type { OrderIntent, OrderType } from '../domain/order.ts';
import { ExitService, type ExitResult } from './exit.ts';
import { LegActions } from './leg-actions.ts';
import { newLeg, orderProblem, orderView, preReject } from './order-rules.ts';
import { OrderSupport, type FanoutResult, type OrderDeps } from './order-support.ts';

export type { ExitResult } from './exit.ts';
export type { FanoutResult, OrderDeps } from './order-support.ts';

export interface PlaceInput {
  clientId: string;
  idempotencyKey: string;
  intent: OrderIntent;
  accountIds: string[];
}

export interface ModifyInput {
  idempotencyKey: string;
  accountIds: string[] | null;
  quantity?: number | undefined;
  pricePaise?: Paise | null | undefined;
  triggerPaise?: Paise | null | undefined;
  orderType?: OrderType | undefined;
}

/**
 * Fan-out orchestration: one intent to many broker accounts, tracked per leg.
 * A failure on one account never rolls back or blocks the others. Every
 * write to a broker is confirmed by reading the order back; a timeout or 5xx
 * leaves the leg UNKNOWN and schedules reconciliation.
 */
export class OrderService {
  private readonly s: OrderSupport;
  private readonly actions: LegActions;
  private readonly exits: ExitService;

  constructor(deps: OrderDeps) {
    this.s = new OrderSupport(deps);
    this.actions = new LegActions(this.s);
    this.exits = new ExitService(this.s, this.actions);
  }

  private get d(): OrderDeps {
    return this.s.d;
  }

  async place(userId: string, input: PlaceInput): Promise<FanoutResult> {
    const plan = await this.d.entitlements.requireEntry(userId);
    const { intent } = input;
    const instrument = await this.s.instrument(intent.instrumentId);
    const problem = orderProblem(intent, instrument);
    if (problem) throw badRequest(problem);
    const accounts = await Promise.all([...new Set(input.accountIds)].map(async (id) => this.s.ownedAccount(userId, id)));
    await this.d.risk.checkEntry(userId, intent, instrument, accounts.length, plan);

    const now = this.d.clock();
    const parent: ParentOrder = {
      id: newId('po'),
      userId,
      clientId: input.clientId,
      kind: 'ENTRY',
      exitOf: null,
      ...intent,
      algoId: this.d.algoId,
      idempotencyKey: input.idempotencyKey,
      status: 'IN_PROGRESS',
      createdAt: now,
      updatedAt: now,
    };
    const planned = await Promise.all(
      accounts.map(async (account) => {
        const symbol = await this.s.symbolFor(account, instrument);
        const reject = preReject(this.d.gateway.brokerAdapter(account.broker), intent, instrument, symbol, plan.brokers);
        return { symbol, leg: newLeg(parent, account, intent.quantity, intent, reject) };
      }),
    );
    await this.d.orders.create(parent, planned.map((p) => p.leg));
    this.d.log.info({ parentOrderId: parent.id, userId, count: planned.length, op: 'place' }, 'fan-out place');
    // Pre-rejected legs (no symbol among them) were stored as REJECTED; the rest go to their brokers.
    const toSend = planned.flatMap((p) => (p.leg.status === 'PENDING_SUBMIT' && p.symbol ? [{ leg: p.leg, symbol: p.symbol }] : []));
    await Promise.all(toSend.map(async (p) => this.s.submit(userId, parent, p.leg, p.symbol)));
    return this.s.result(parent.id);
  }

  /** Cancels the still-open legs. Filled and otherwise finished legs are reported as not cancellable. Never gated. */
  async cancel(userId: string, parentId: string, accountIds: string[] | null): Promise<FanoutResult> {
    const parent = await this.s.ownedParent(userId, parentId);
    return this.s.locked(parent.id, async () => {
      const legs = await this.s.selectLegs(parent.id, accountIds);
      return this.s.result(parent.id, await this.s.perLeg(legs, async (leg) => this.actions.cancel(userId, leg)));
    });
  }

  /**
   * Changes price, quantity, trigger or order type on open legs (optionally a
   * subset). Not gated by the subscription, except that exit-only users can't
   * add quantity to an entry. The broker's adapter decides partial-fill rules.
   */
  async modify(userId: string, parentId: string, input: ModifyInput): Promise<FanoutResult> {
    const parent = await this.s.ownedParent(userId, parentId);
    const { quantity, pricePaise, triggerPaise, orderType } = input;
    if ([quantity, pricePaise, triggerPaise, orderType].every((v) => v === undefined)) {
      throw badRequest('Give at least one of quantity, price, triggerPrice or orderType.');
    }
    await this.d.risk.requireNoKillSwitch();
    const target = {
      parent,
      instrument: await this.s.instrument(parent.instrumentId),
      changes: { quantity, pricePaise, triggerPaise, orderType },
      exitOnly: (await this.d.entitlements.check(userId)).mode === 'exit_only',
    };
    return this.s.locked(parent.id, async () => {
      const legs = await this.s.selectLegs(parent.id, input.accountIds);
      return this.s.result(parent.id, await this.s.perLeg(legs, async (leg) => this.actions.modify(userId, leg, target)));
    });
  }

  /** Squares off filled legs at market (see [ExitService]). Never gated by the subscription. */
  async exit(userId: string, parentId: string, idempotencyKey: string, clientId: string, accountIds: string[] | null): Promise<ExitResult> {
    return this.exits.exit(userId, parentId, { idempotencyKey, clientId, accountIds });
  }

  async get(userId: string, parentId: string) {
    const parent = await this.s.ownedParent(userId, parentId);
    return orderView(parent, await this.d.orders.legs(parent.id));
  }

  async list(userId: string, limit: number, before: Date | null) {
    const parents = await this.d.orders.listParents(userId, limit, before);
    const legs = await this.d.orders.legsOf(parents.map((p) => p.id));
    return parents.map((p) => orderView(p, legs.filter((l) => l.parentOrderId === p.id)));
  }

  /** The audit trail of one leg, for disputes. */
  async events(userId: string, parentId: string, legId: string) {
    await this.s.ownedParent(userId, parentId);
    const leg = await this.d.orders.leg(legId);
    if (leg?.parentOrderId !== parentId) throw notFound('Leg not found.');
    return this.d.orders.events(legId);
  }

  async beginIdempotent(userId: string, key: string, operation: string, requestHash: string) {
    return this.d.orders.beginIdempotent(userId, key, operation, requestHash, this.d.clock());
  }

  async finishIdempotent(userId: string, key: string, statusCode: number, response: unknown) {
    return this.d.orders.finishIdempotent(userId, key, statusCode, response);
  }

  async releaseIdempotent(userId: string, key: string) {
    return this.d.orders.releaseIdempotent(userId, key);
  }
}
