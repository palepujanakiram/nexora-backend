import type { BrokerAccountRecord, BrokerAccountRepository } from '../data/broker-accounts.ts';
import type { Db } from '../data/db.ts';
import type { InstrumentRepository } from '../data/instruments.ts';
import type { Leg, OrderRepository, ParentOrder } from '../data/orders.ts';
import { BrokerError } from '../domain/broker-error.ts';
import { AppError, badRequest, notFound } from '../domain/errors.ts';
import type { BrokerSymbol, Instrument } from '../domain/instrument.ts';
import type { Log } from '../logging.ts';
import type { EntitlementService } from './entitlements.ts';
import type { BrokerGateway } from './gateway.ts';
import { legView, type LegTracker, type LegView } from './legs.ts';
import { brokerErrorOf, type Outcome } from './order-rules.ts';
import type { RiskService } from './risk.ts';
import { must } from '../domain/invariant.ts';

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

export interface FanoutResult {
  parentOrderId: string;
  status: string;
  legs: (LegView & Partial<Outcome>)[];
}

/** Lookups, locking and leg submission shared by place, cancel, modify and exit. */
export class OrderSupport {
  readonly d: OrderDeps;

  constructor(deps: OrderDeps) {
    this.d = deps;
  }

  async instrument(id: string): Promise<Instrument> {
    const instrument = await this.d.instruments.find(id);
    if (!instrument) throw notFound(`Unknown instrument ${id}. Search /instruments for the id.`);
    return instrument;
  }

  async ownedAccount(userId: string, id: string): Promise<BrokerAccountRecord> {
    const account = await this.d.accounts.findOwned(userId, id);
    if (!account) throw notFound(`Broker account ${id} not found.`);
    return account;
  }

  async ownedParent(userId: string, id: string): Promise<ParentOrder> {
    const parent = await this.d.orders.parentOwned(userId, id);
    if (!parent) throw notFound('Order not found.');
    return parent;
  }

  /** The order's legs, or only those on [accountIds] (each must have one). */
  async selectLegs(parentId: string, accountIds: string[] | null): Promise<Leg[]> {
    const legs = await this.d.orders.legs(parentId);
    if (!accountIds) return legs;
    const unknown = accountIds.filter((id) => !legs.some((l) => l.accountId === id));
    if (unknown.length) throw badRequest(`This order has no leg on account ${unknown.join(', ')}.`);
    return legs.filter((l) => accountIds.includes(l.accountId));
  }

  /** How the account's broker names the instrument. Paper accounts use the canonical id. */
  async symbolFor(account: BrokerAccountRecord, instrument: Instrument): Promise<BrokerSymbol | null> {
    if (account.mode === 'paper') return { nativeId: instrument.id, tradingSymbol: instrument.id, exchange: instrument.exchange };
    return this.d.instruments.mapping(instrument.id, account.broker);
  }

  /** Runs [fn] holding the order's lock, so two cancels or exits can't overlap (no double square-off). */
  async locked<T>(parentId: string, fn: () => Promise<T>): Promise<T> {
    const result = await this.d.db.withLock(`order:${parentId}`, this.d.lockWaitMs, fn);
    if (!result) throw new AppError(409, 'order_busy', 'Another change to this order is in progress. Try again.');
    return result.value;
  }

  /** Runs [action] on each leg in parallel and collects its outcome by leg id. */
  async perLeg(legs: readonly Leg[], action: (leg: Leg) => Promise<Outcome>): Promise<Map<string, Outcome>> {
    const outcomes = new Map<string, Outcome>();
    await Promise.all(legs.map(async (leg) => outcomes.set(leg.id, await action(leg))));
    return outcomes;
  }

  /** The order and its legs (only those in [outcomes], with their outcome, when given). */
  async result(parentId: string, outcomes?: Map<string, Outcome>): Promise<FanoutResult> {
    const parent = must(await this.d.orders.parent(parentId), `order ${parentId}`);
    const legs = await this.d.orders.legs(parentId);
    return {
      parentOrderId: parent.id,
      status: parent.status,
      legs: legs.filter((l) => !outcomes || outcomes.has(l.id)).map((l) => ({ ...legView(l), ...outcomes?.get(l.id) })),
    };
  }

  /** Sends one leg to its broker, then reads it back. Never throws: the leg records what happened. */
  async submit(userId: string, parent: ParentOrder, leg: Leg, symbol: BrokerSymbol): Promise<void> {
    const { gateway, legs } = this.d;
    const submittedAt = this.d.clock();
    try {
      const ack = await gateway.place(leg.accountId, {
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
      const submitted = { status: 'SUBMITTED' as const, brokerOrderId: ack.brokerOrderId, submittedAt, reconcileAt: legs.nextCheck(0) };
      await legs.refresh(await legs.update(leg, submitted, { action: 'place', source: 'api', raw: ack.raw }, userId), 'api', userId);
    } catch (e) {
      const err = brokerErrorOf(e);
      const event = { action: 'place', source: 'api' as const, raw: err.raw };
      if (err.outcomeUnknown || !(e instanceof BrokerError)) {
        const unknown = { status: 'UNKNOWN' as const, submittedAt, errorCode: err.code, errorMessage: err.message, reconcileAt: legs.nextCheck(0) };
        await legs.update(leg, unknown, event, userId);
        this.d.log.warn({ parentOrderId: parent.id, legId: leg.id, broker: leg.broker, code: err.code }, 'leg outcome unknown; reconciling');
      } else {
        await legs.update(leg, { status: 'REJECTED', errorCode: err.code, errorMessage: err.message }, event, userId);
      }
    }
  }
}
