import type { BrokerOrder, ModifyRequest } from '../brokers/adapter.ts';
import type { BrokerAccountRecord, BrokerAccountRepository } from '../data/broker-accounts.ts';
import { newClientRef, newId } from '../data/crypto.ts';
import type { Db } from '../data/db.ts';
import type { InstrumentRepository } from '../data/instruments.ts';
import type { Leg, OrderRepository, ParentOrder } from '../data/orders.ts';
import { BrokerError, type BrokerErrorCode } from '../domain/broker-error.ts';
import { AppError, badRequest, notFound } from '../domain/errors.ts';
import type { BrokerSymbol, Instrument } from '../domain/instrument.ts';
import { isOnTick, rupees, type Paise } from '../domain/money.ts';
import { intentProblem, isTerminal, isWorking, opposite, type OrderIntent, type OrderType } from '../domain/order.ts';
import type { Log } from '../logging.ts';
import type { EntitlementService } from './entitlements.ts';
import type { BrokerGateway } from './gateway.ts';
import { legView, type LegTracker, type LegView } from './legs.ts';
import type { RiskService } from './risk.ts';

export interface OrderDeps {
  db: Db;
  orders: OrderRepository;
  instruments: InstrumentRepository;
  accounts: BrokerAccountRepository;
  gateway: BrokerGateway;
  legs: LegTracker;
  entitlements: EntitlementService;
  risk: RiskService;
  clock: () => Date;
  log: Log;
  /** SEBI algo id stamped on every order, when one has been issued. */
  algoId: string | null;
  lockWaitMs: number;
}

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

export interface FanoutResult {
  parentOrderId: string;
  status: string;
  legs: (LegView & { outcome?: string; reason?: string })[];
}

export interface ExitResult {
  parentOrderId: string;
  exitOrderId: string | null;
  exitStatus: string | null;
  legs: { accountId: string; outcome: string; reason?: string; heldQty?: number; exitLeg?: LegView; cancelledRemainder?: boolean }[];
}

type PreReject = { code: string; message: string };

/**
 * Fan-out orchestration: one intent to many broker accounts, tracked per leg.
 * A failure on one account never rolls back or blocks the others. Every
 * write to a broker is confirmed by reading the order back; a timeout or 5xx
 * leaves the leg UNKNOWN and schedules reconciliation.
 */
export class OrderService {
  private readonly d: OrderDeps;

  constructor(deps: OrderDeps) {
    this.d = deps;
  }

  // Place ------------------------------------------------------------------

  async place(userId: string, input: PlaceInput): Promise<FanoutResult> {
    const plan = await this.d.entitlements.requireEntry(userId);
    const { intent } = input;
    const instrument = await this.instrument(intent.instrumentId);
    this.validate(intent, instrument);
    const accountIds = [...new Set(input.accountIds)];
    const accounts = await Promise.all(accountIds.map((id) => this.ownedAccount(userId, id)));
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
        const symbol = await this.symbolFor(account, instrument);
        const reject = this.preReject(account, intent, instrument, symbol, plan.brokers);
        return { account, symbol, leg: this.newLeg(parent, account, intent.quantity, intent, reject) };
      }),
    );
    await this.d.orders.create(parent, planned.map((p) => p.leg));
    this.d.log.info({ parentOrderId: parent.id, userId, count: planned.length, op: 'place' }, 'fan-out place');

    await Promise.all(
      planned.filter((p) => p.leg.status === 'PENDING_SUBMIT').map((p) => this.submit(userId, parent, p.leg, p.symbol!)),
    );
    return this.result(parent.id);
  }

  // Cancel -----------------------------------------------------------------

  /** Cancels the still-open legs. Filled and otherwise finished legs are reported as not cancellable. Never gated. */
  async cancel(userId: string, parentId: string, accountIds: string[] | null): Promise<FanoutResult> {
    const parent = await this.ownedParent(userId, parentId);
    return this.locked(parent.id, async () => {
      const outcomes = new Map<string, { outcome: string; reason?: string }>();
      await Promise.all(
        (await this.selectLegs(parent.id, accountIds)).map(async (leg) => {
          outcomes.set(leg.id, await this.cancelLeg(userId, leg));
        }),
      );
      return this.result(parent.id, outcomes);
    });
  }

  private async cancelLeg(userId: string, start: Leg): Promise<{ outcome: string; reason?: string }> {
    let leg = start;
    if (leg.status === 'UNKNOWN' || leg.status === 'PENDING_SUBMIT') leg = await this.d.legs.refresh(leg, 'api', userId);
    if (leg.status === 'FILLED') return { outcome: 'not_cancellable', reason: 'Already filled.' };
    if (isTerminal(leg.status)) return { outcome: 'not_cancellable', reason: `Already ${leg.status.toLowerCase()}.` };
    if (!isWorking(leg.status) || !leg.brokerOrderId) {
      return { outcome: 'unknown', reason: 'The broker hasn\'t confirmed whether it has this order yet. Reconciliation is checking; try again shortly.' };
    }
    try {
      const ack = await this.d.gateway.cancel(leg.accountId, leg.brokerOrderId);
      await this.d.orders.note(leg, { action: 'cancel', source: 'api', raw: ack.raw }, this.d.clock());
    } catch (e) {
      const err = brokerErrorOf(e);
      await this.d.orders.note(leg, { action: 'cancel_failed', source: 'api', raw: err.raw }, this.d.clock());
      leg = await this.d.legs.refresh(leg, 'api', userId);
      if (err.outcomeUnknown) return { outcome: 'unknown', reason: err.message };
      if (leg.status === 'FILLED') return { outcome: 'not_cancellable', reason: 'Filled before the cancel reached the broker.' };
      return { outcome: 'failed', reason: err.message };
    }
    leg = await this.d.legs.refresh(leg, 'api', userId);
    if (leg.status === 'CANCELLED') return { outcome: 'cancelled' };
    if (leg.status === 'FILLED') return { outcome: 'not_cancellable', reason: 'Filled before the cancel reached the broker.' };
    return { outcome: 'cancel_requested', reason: 'The broker accepted the cancel but hasn\'t confirmed it yet.' };
  }

  // Modify -----------------------------------------------------------------

  /**
   * Changes price, quantity, trigger or order type on open legs (optionally a
   * subset). Not gated by the subscription, except that exit-only users can't
   * add quantity to an entry. The broker's adapter decides partial-fill rules.
   */
  async modify(userId: string, parentId: string, input: ModifyInput): Promise<FanoutResult> {
    const parent = await this.ownedParent(userId, parentId);
    if (input.quantity === undefined && input.pricePaise === undefined && input.triggerPaise === undefined && input.orderType === undefined) {
      throw badRequest('Give at least one of quantity, price, triggerPrice or orderType.');
    }
    await this.d.risk.requireNoKillSwitch();
    const instrument = await this.instrument(parent.instrumentId);
    const entitlement = await this.d.entitlements.check(userId);
    return this.locked(parent.id, async () => {
      const outcomes = new Map<string, { outcome: string; reason?: string }>();
      await Promise.all(
        (await this.selectLegs(parent.id, input.accountIds)).map(async (leg) => {
          outcomes.set(leg.id, await this.modifyLeg(userId, parent, instrument, leg, input, entitlement.mode === 'exit_only'));
        }),
      );
      return this.result(parent.id, outcomes);
    });
  }

  private async modifyLeg(
    userId: string,
    parent: ParentOrder,
    instrument: Instrument,
    start: Leg,
    input: ModifyInput,
    exitOnly: boolean,
  ): Promise<{ outcome: string; reason?: string }> {
    let leg = start;
    if (!isWorking(leg.status) || !leg.brokerOrderId) {
      return { outcome: 'not_modifiable', reason: `The order is ${leg.status.toLowerCase()}.` };
    }
    const orderType = input.orderType ?? leg.orderType;
    const quantity = input.quantity ?? leg.quantity;
    const req = {
      brokerOrderId: leg.brokerOrderId,
      side: parent.side,
      product: parent.product,
      quantity,
      orderType,
      pricePaise: input.pricePaise !== undefined ? input.pricePaise : orderType === 'MARKET' || orderType === 'SL_M' ? null : leg.pricePaise,
      triggerPaise: input.triggerPaise !== undefined ? input.triggerPaise : orderType === 'SL' || orderType === 'SL_M' ? leg.triggerPaise : null,
    };
    const problem = intentProblem(req) ?? this.tickProblem(req.pricePaise, req.triggerPaise, instrument) ?? lotProblem(quantity, instrument);
    if (problem) return { outcome: 'not_modifiable', reason: problem };
    if (exitOnly && parent.kind === 'ENTRY' && quantity > leg.quantity) {
      return { outcome: 'not_modifiable', reason: 'Your subscription has lapsed: you can reduce or close positions, not add to them.' };
    }
    try {
      this.d.risk.checkNotional(quantity, req.pricePaise ?? req.triggerPaise ?? parent.referencePricePaise);
    } catch (e) {
      return { outcome: 'not_modifiable', reason: (e as Error).message };
    }
    const account = (await this.d.accounts.find(leg.accountId))!;
    const symbol = (await this.symbolFor(account, instrument))!;
    const full: ModifyRequest = { ...req, symbol };
    let current: BrokerOrder;
    try {
      current = await this.d.gateway.getOrder(leg.accountId, leg.brokerOrderId);
    } catch (e) {
      return { outcome: 'failed', reason: brokerErrorOf(e).message };
    }
    leg = await this.d.legs.apply(leg, current, 'reconcile', 'api', userId);
    if (!isWorking(leg.status)) return { outcome: 'not_modifiable', reason: `The order is ${leg.status.toLowerCase()}.` };
    const refused = await this.d.gateway.modifyProblem(leg.accountId, current, full);
    if (refused) return { outcome: 'not_modifiable', reason: refused };
    try {
      const ack = await this.d.gateway.modify(leg.accountId, full);
      await this.d.orders.note(leg, { action: 'modify', source: 'api', raw: ack.raw }, this.d.clock());
    } catch (e) {
      const err = brokerErrorOf(e);
      await this.d.orders.note(leg, { action: 'modify_failed', source: 'api', raw: err.raw }, this.d.clock());
      await this.d.legs.refresh(leg, 'api', userId);
      return { outcome: err.outcomeUnknown ? 'unknown' : 'failed', reason: err.message };
    }
    leg = await this.d.legs.refresh(leg, 'api', userId);
    const applied = leg.quantity === quantity && leg.pricePaise === req.pricePaise && leg.triggerPaise === req.triggerPaise;
    return applied ? { outcome: 'modified' } : { outcome: 'modify_requested', reason: 'The broker accepted the change but hasn\'t confirmed it yet.' };
  }

  // Exit -------------------------------------------------------------------

  /**
   * Squares off filled legs at market. For each account: cancel whatever is
   * still open on the entry, read the live position from the broker, and
   * send the opposite side for the quantity actually held — never more than
   * this order filled, minus earlier exits. Never gated by the subscription.
   */
  async exit(userId: string, parentId: string, idempotencyKey: string, clientId: string, accountIds: string[] | null): Promise<ExitResult> {
    const parent = await this.ownedParent(userId, parentId);
    if (parent.kind !== 'ENTRY') throw badRequest('Only entry orders can be exited.');
    await this.d.risk.requireNoKillSwitch();
    const instrument = await this.instrument(parent.instrumentId);
    return this.locked(parent.id, async () => {
      const legs = await this.selectLegs(parent.id, accountIds);
      const earlier = await this.d.orders.exitLegs(parent.id);
      const results: ExitResult['legs'] = [];
      const toExit: { account: BrokerAccountRecord; symbol: BrokerSymbol; qty: number; ref: Paise | null }[] = [];

      await Promise.all(
        legs.map(async (start) => {
          let leg = start;
          let cancelledRemainder = false;
          if (!isTerminal(leg.status)) {
            const c = await this.cancelLeg(userId, leg);
            cancelledRemainder = c.outcome === 'cancelled';
            leg = (await this.d.orders.leg(leg.id))!;
          }
          if (!isTerminal(leg.status)) {
            results.push({ accountId: leg.accountId, outcome: 'failed', reason: 'Couldn\'t confirm the open part of the order was cancelled; nothing was exited. Try again.' });
            return;
          }
          const exited = earlier
            .filter((e) => e.accountId === leg.accountId && e.status !== 'REJECTED')
            .reduce((n, e) => n + (isTerminal(e.status) ? e.filledQty : e.quantity), 0);
          const remaining = leg.filledQty - exited;
          if (remaining <= 0) {
            results.push({ accountId: leg.accountId, outcome: 'nothing_to_exit', reason: leg.filledQty === 0 ? 'Nothing was filled.' : 'Already exited.', cancelledRemainder });
            return;
          }
          const account = (await this.d.accounts.find(leg.accountId))!;
          const symbol = (await this.symbolFor(account, instrument))!;
          let held = 0;
          let ref: Paise | null = null;
          try {
            for (const p of await this.d.gateway.positions(account.id)) {
              if (p.symbol.nativeId !== symbol.nativeId || p.product !== parent.product) continue;
              const signed = parent.side === 'BUY' ? p.netQty : -p.netQty;
              if (signed > 0) held += signed;
              ref = p.lastPricePaise ?? ref;
            }
          } catch (e) {
            results.push({ accountId: leg.accountId, outcome: 'failed', reason: `Couldn't read positions: ${brokerErrorOf(e).message}`, cancelledRemainder });
            return;
          }
          const qty = Math.min(held, remaining);
          if (qty <= 0) {
            results.push({ accountId: leg.accountId, outcome: 'nothing_to_exit', reason: 'The broker shows no open position for this order.', heldQty: held, cancelledRemainder });
            return;
          }
          results.push({ accountId: leg.accountId, outcome: 'exit_placed', heldQty: held, cancelledRemainder });
          toExit.push({ account, symbol, qty, ref: ref ?? leg.avgPricePaise });
        }),
      );

      if (toExit.length === 0) return { parentOrderId: parent.id, exitOrderId: null, exitStatus: null, legs: results };
      const now = this.d.clock();
      const exitParent: ParentOrder = {
        id: newId('po'),
        userId,
        clientId,
        kind: 'EXIT',
        exitOf: parent.id,
        instrumentId: parent.instrumentId,
        side: opposite(parent.side),
        // Exit legs carry their own quantities; the parent records the total.
        quantity: toExit.reduce((n, e) => n + e.qty, 0),
        orderType: 'MARKET',
        product: parent.product,
        pricePaise: null,
        triggerPaise: null,
        referencePricePaise: toExit[0]!.ref,
        algoId: this.d.algoId,
        idempotencyKey,
        status: 'IN_PROGRESS',
        createdAt: now,
        updatedAt: now,
      };
      const exitLegs = toExit.map((e) => ({
        ...e,
        leg: this.newLeg(exitParent, e.account, e.qty, { orderType: 'MARKET', pricePaise: null, triggerPaise: null }, null),
      }));
      await this.d.orders.create(exitParent, exitLegs.map((e) => e.leg));
      this.d.log.info({ parentOrderId: exitParent.id, correlationId: parent.id, userId, count: exitLegs.length, op: 'exit' }, 'fan-out exit');
      await Promise.all(exitLegs.map((e) => this.submit(userId, { ...exitParent, referencePricePaise: e.ref }, e.leg, e.symbol)));

      const placed = await this.d.orders.legs(exitParent.id);
      for (const r of results) {
        const leg = placed.find((l) => l.accountId === r.accountId);
        if (r.outcome === 'exit_placed' && leg) r.exitLeg = legView(leg);
      }
      return { parentOrderId: parent.id, exitOrderId: exitParent.id, exitStatus: (await this.d.orders.parent(exitParent.id))!.status, legs: results };
    });
  }

  // Reads ------------------------------------------------------------------

  async get(userId: string, parentId: string) {
    const parent = await this.ownedParent(userId, parentId);
    return this.view(parent, await this.d.orders.legs(parent.id));
  }

  async list(userId: string, limit: number, before: Date | null) {
    const parents = await this.d.orders.listParents(userId, limit, before);
    const legs = await this.d.orders.legsOf(parents.map((p) => p.id));
    return parents.map((p) => this.view(p, legs.filter((l) => l.parentOrderId === p.id)));
  }

  /** The audit trail of one leg, for disputes. */
  async events(userId: string, parentId: string, legId: string) {
    await this.ownedParent(userId, parentId);
    const leg = await this.d.orders.leg(legId);
    if (!leg || leg.parentOrderId !== parentId) throw notFound('Leg not found.');
    return this.d.orders.events(legId);
  }

  // Idempotency ------------------------------------------------------------

  beginIdempotent(userId: string, key: string, operation: string, requestHash: string) {
    return this.d.orders.beginIdempotent(userId, key, operation, requestHash, this.d.clock());
  }

  finishIdempotent(userId: string, key: string, statusCode: number, response: unknown) {
    return this.d.orders.finishIdempotent(userId, key, statusCode, response);
  }

  releaseIdempotent(userId: string, key: string) {
    return this.d.orders.releaseIdempotent(userId, key);
  }

  // Internals --------------------------------------------------------------

  /** Sends one leg to its broker, then reads it back. Never throws: the leg records what happened. */
  private async submit(userId: string, parent: ParentOrder, leg: Leg, symbol: BrokerSymbol): Promise<void> {
    const submittedAt = this.d.clock();
    try {
      const ack = await this.d.gateway.place(leg.accountId, {
        symbol,
        side: parent.side,
        quantity: leg.quantity,
        orderType: leg.orderType,
        product: parent.product,
        pricePaise: leg.pricePaise,
        triggerPaise: leg.triggerPaise,
        clientRef: leg.clientRef,
        algoId: parent.algoId,
        referencePricePaise: parent.referencePricePaise,
      });
      let current = await this.d.legs.update(
        leg,
        { status: 'SUBMITTED', brokerOrderId: ack.brokerOrderId, submittedAt, reconcileAt: this.d.legs.nextCheck(0) },
        'place',
        'api',
        ack.raw,
        userId,
      );
      current = await this.d.legs.refresh(current, 'api', userId);
    } catch (e) {
      const err = brokerErrorOf(e);
      if (err.outcomeUnknown || !(e instanceof BrokerError)) {
        await this.d.legs.update(
          leg,
          { status: 'UNKNOWN', submittedAt, errorCode: err.code, errorMessage: err.message, reconcileAt: this.d.legs.nextCheck(0) },
          'place',
          'api',
          err.raw,
          userId,
        );
        this.d.log.warn({ parentOrderId: parent.id, legId: leg.id, broker: leg.broker, code: err.code }, 'leg outcome unknown; reconciling');
      } else {
        await this.d.legs.update(leg, { status: 'REJECTED', errorCode: err.code, errorMessage: err.message }, 'place', 'api', err.raw, userId);
      }
    }
  }

  private newLeg(
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

  /** Refuses a leg up front when its broker can't do what was asked; nothing is sent. */
  private preReject(account: BrokerAccountRecord, intent: OrderIntent, instrument: Instrument, symbol: BrokerSymbol | null, planBrokers: readonly string[]): PreReject | null {
    const adapter = this.d.gateway.brokerAdapter(account.broker);
    const caps = adapter.capabilities;
    const reject = (code: BrokerErrorCode | 'NOT_IN_PLAN', message: string) => ({ code, message });
    if (!planBrokers.includes(account.broker)) return reject('NOT_IN_PLAN', `Your plan doesn't include ${adapter.label}.`);
    if (!caps.orderTypes.includes(intent.orderType)) return reject('UNSUPPORTED', `${adapter.label} doesn't support ${intent.orderType} orders.`);
    if (!caps.products.includes(intent.product)) return reject('UNSUPPORTED', `${adapter.label} doesn't support the ${intent.product} product.`);
    if (!caps.exchanges.includes(instrument.exchange)) return reject('UNSUPPORTED', `${adapter.label} doesn't trade on ${instrument.exchange}.`);
    if (!symbol) return reject('INVALID_SYMBOL', `${adapter.label} has no mapping for ${instrument.id}. Refresh instruments or pick another account.`);
    return null;
  }

  /** How the account's broker names the instrument. Paper accounts use the canonical id. */
  private async symbolFor(account: BrokerAccountRecord, instrument: Instrument): Promise<BrokerSymbol | null> {
    if (account.mode === 'paper') return { nativeId: instrument.id, tradingSymbol: instrument.id, exchange: instrument.exchange };
    return this.d.instruments.mapping(instrument.id, account.broker);
  }

  private validate(intent: OrderIntent, instrument: Instrument): void {
    const problem =
      intentProblem(intent) ??
      lotProblem(intent.quantity, instrument) ??
      this.tickProblem(intent.pricePaise, intent.triggerPaise, instrument);
    if (problem) throw badRequest(problem);
  }

  private tickProblem(price: Paise | null, trigger: Paise | null, instrument: Instrument): string | null {
    for (const [name, value] of [['Price', price], ['Trigger price', trigger]] as const) {
      if (value !== null && !isOnTick(value, instrument.tickPaise)) {
        return `${name} must be a multiple of the tick size ₹${rupees(instrument.tickPaise)}.`;
      }
    }
    return null;
  }

  private async instrument(id: string): Promise<Instrument> {
    const instrument = await this.d.instruments.find(id);
    if (!instrument) throw notFound(`Unknown instrument ${id}. Search /instruments for the id.`);
    return instrument;
  }

  private async ownedAccount(userId: string, id: string): Promise<BrokerAccountRecord> {
    const account = await this.d.accounts.findOwned(userId, id);
    if (!account) throw notFound(`Broker account ${id} not found.`);
    return account;
  }

  private async ownedParent(userId: string, id: string): Promise<ParentOrder> {
    const parent = await this.d.orders.parentOwned(userId, id);
    if (!parent) throw notFound('Order not found.');
    return parent;
  }

  private async selectLegs(parentId: string, accountIds: string[] | null): Promise<Leg[]> {
    const legs = await this.d.orders.legs(parentId);
    if (!accountIds) return legs;
    const unknown = accountIds.filter((id) => !legs.some((l) => l.accountId === id));
    if (unknown.length) throw badRequest(`This order has no leg on account ${unknown.join(', ')}.`);
    return legs.filter((l) => accountIds.includes(l.accountId));
  }

  /** Runs [fn] holding the order's lock, so two cancels or exits can't overlap (no double square-off). */
  private async locked<T>(parentId: string, fn: () => Promise<T>): Promise<T> {
    const result = await this.d.db.withLock(`order:${parentId}`, this.d.lockWaitMs, fn);
    if (!result) throw new AppError(409, 'order_busy', 'Another change to this order is in progress. Try again.');
    return result.value;
  }

  private async result(parentId: string, outcomes?: Map<string, { outcome: string; reason?: string }>): Promise<FanoutResult> {
    const parent = (await this.d.orders.parent(parentId))!;
    const legs = await this.d.orders.legs(parentId);
    return {
      parentOrderId: parent.id,
      status: parent.status,
      legs: legs.filter((l) => !outcomes || outcomes.has(l.id)).map((l) => ({ ...legView(l), ...outcomes?.get(l.id) })),
    };
  }

  private view(p: ParentOrder, legs: Leg[]) {
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
      price: p.pricePaise === null ? null : rupees(p.pricePaise),
      triggerPrice: p.triggerPaise === null ? null : rupees(p.triggerPaise),
      referencePrice: p.referencePricePaise === null ? null : rupees(p.referencePricePaise),
      algoId: p.algoId,
      clientId: p.clientId,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      legs: legs.map(legView),
    };
  }
}

function lotProblem(quantity: number, instrument: Instrument): string | null {
  return quantity % instrument.lotSize === 0 ? null : `Quantity must be a multiple of the lot size ${instrument.lotSize}.`;
}

/** Any failure as a BrokerError; unexpected errors count as outcome unknown, never as a clean rejection. */
function brokerErrorOf(e: unknown): BrokerError {
  if (e instanceof BrokerError) return e;
  if (e instanceof AppError) return new BrokerError('UNKNOWN', e.message);
  return new BrokerError('BROKER_UNAVAILABLE', 'Something went wrong talking to the broker.');
}
