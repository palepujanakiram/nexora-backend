import type { BrokerAccountRepository } from '../data/broker-accounts.ts';
import type { Db } from '../data/db.ts';
import type { Leg, OrderRepository } from '../data/orders.ts';
import { AppError, notFound } from '../domain/errors.ts';
import { isTerminal } from '../domain/order.ts';
import { lastIstTime } from '../domain/ist.ts';
import type { Log } from '../logging.ts';
import type { BrokerGateway } from './gateway.ts';
import type { LegTracker } from './legs.ts';

export interface ReconcileDeps {
  db: Db;
  orders: OrderRepository;
  accounts: BrokerAccountRepository;
  gateway: BrokerGateway;
  legs: LegTracker;
  clock: () => Date;
  log: Log;
}

export interface ReconciliationIssue {
  id: number;
  legId: string | null;
  accountId: string;
  brokerOrderId: string | null;
  kind: string;
  detail: string;
  foundAt: Date;
}

/**
 * Brings legs in line with the broker, which is always the source of truth.
 * Three independent paths, since none is reliable alone: polling for legs
 * that aren't terminal, broker webhooks (only a hint to re-read), and an
 * end-of-day comparison against each broker's order book.
 * TODO(broker streams): subscribe to brokers' WebSocket order streams where offered
 * (adapter.subscribeOrderUpdates) as a fourth, faster path.
 */
export class Reconciler {
  private readonly d: ReconcileDeps;

  constructor(deps: ReconcileDeps) {
    this.d = deps;
  }

  /** Re-reads every leg that's due. Returns how many were looked at. */
  async pollDue(limit = 50): Promise<number> {
    const due = await this.d.orders.dueForReconcile(this.d.clock(), limit);
    await Promise.all(due.map((leg) => this.refreshUnderLock(leg, 'reconcile')));
    return due.length;
  }

  /**
   * A broker posted an order update. It's verified when the broker signs
   * them, then used only as a reason to read the order from the broker.
   */
  async webhook(broker: string, body: unknown, headers: Readonly<Record<string, string | string[] | undefined>>): Promise<{ matched: boolean }> {
    const adapter = this.d.gateway.brokerAdapter(broker);
    if (!adapter.parseWebhook) throw notFound(`${adapter.label} doesn't send webhooks.`);
    const hint = adapter.parseWebhook(body, headers);
    if (!hint) throw new AppError(400, 'bad_request', 'Not an order update.');
    const leg = await this.d.orders.legByBrokerOrder(broker, hint.brokerOrderId);
    if (!leg) return { matched: false };
    if (hint.verify) {
      const account = await this.d.accounts.find(leg.accountId);
      if (!account || !hint.verify(this.d.gateway.credentials(account))) {
        throw new AppError(401, 'bad_signature', 'Webhook signature does not match.');
      }
    }
    await this.refreshUnderLock(leg, 'webhook');
    return { matched: true };
  }

  /**
   * Compares today's legs on every live account with the broker's order book.
   * Differences are applied (the broker wins) and recorded for a human when
   * we had already called the leg finished, or the broker has orders tagged
   * by us that we don't know.
   */
  async endOfDay(): Promise<{ accounts: number; issues: number }> {
    const now = this.d.clock();
    const since = lastIstTime(now, 0, 0);
    let accounts = 0;
    let issues = 0;
    for (const account of (await this.d.accounts.listAll()).filter((a) => a.mode === 'live')) {
      const legs = await this.d.orders.legsForAccountSince(account.id, since);
      if (legs.length === 0) continue;
      accounts++;
      let book;
      try {
        book = await this.d.gateway.listOrders(account.id);
      } catch (e) {
        issues += await this.issue(null, account.id, null, 'order_book_unavailable', `Couldn't read the order book: ${(e as Error).message}`);
        continue;
      }
      const byId = new Map(book.map((o) => [o.brokerOrderId, o]));
      const byRef = new Map(book.filter((o) => o.clientRef).map((o) => [o.clientRef!, o]));
      for (const leg of legs) {
        const bo = (leg.brokerOrderId ? byId.get(leg.brokerOrderId) : undefined) ?? byRef.get(leg.clientRef);
        if (!bo) {
          if (leg.brokerOrderId) issues += await this.issue(leg.id, account.id, leg.brokerOrderId, 'missing_at_broker', `We have ${leg.status}; the broker's order book has no such order.`);
          continue;
        }
        const differs = bo.status !== leg.status || bo.filledQty !== leg.filledQty;
        if (differs && isTerminal(leg.status)) {
          issues += await this.issue(leg.id, account.id, bo.brokerOrderId, 'status_mismatch', `We had ${leg.status} (${leg.filledQty} filled); the broker says ${bo.status} (${bo.filledQty} filled).`);
        }
        if (differs) {
          const parent = (await this.d.orders.parent(leg.parentOrderId))!;
          await this.d.legs.apply(leg, bo, 'reconcile', 'eod', parent.userId);
        }
      }
      const known = new Set(legs.map((l) => l.clientRef));
      for (const o of book) {
        if (o.clientRef?.startsWith('NX') && !known.has(o.clientRef) && !(await this.knownRef(o.clientRef))) {
          issues += await this.issue(null, account.id, o.brokerOrderId, 'unknown_order', `The broker has order ${o.brokerOrderId} tagged ${o.clientRef}, which we have no record of.`);
        }
      }
    }
    this.d.log.info({ job: 'eod_reconcile', count: accounts, outcome: `${issues} issues` }, 'end-of-day reconciliation done');
    return { accounts, issues };
  }

  async openIssues(): Promise<ReconciliationIssue[]> {
    const rows = await this.d.db.query<Record<string, unknown>>('SELECT * FROM reconciliation_issues WHERE resolved_at IS NULL ORDER BY id');
    return rows.map((r) => ({
      id: Number(r['id']),
      legId: (r['leg_id'] as string | null) ?? null,
      accountId: r['broker_account_id'] as string,
      brokerOrderId: (r['broker_order_id'] as string | null) ?? null,
      kind: r['kind'] as string,
      detail: r['detail'] as string,
      foundAt: r['found_at'] as Date,
    }));
  }

  async resolveIssue(id: number): Promise<void> {
    const rows = await this.d.db.query('UPDATE reconciliation_issues SET resolved_at = $2 WHERE id = $1 AND resolved_at IS NULL RETURNING id', [id, this.d.clock()]);
    if (rows.length === 0) throw notFound('No open issue with that id.');
  }

  private async knownRef(ref: string): Promise<boolean> {
    return (await this.d.db.query('SELECT 1 FROM order_legs WHERE client_ref = $1', [ref])).length > 0;
  }

  private async issue(legId: string | null, accountId: string, brokerOrderId: string | null, kind: string, detail: string): Promise<number> {
    await this.d.db.query(
      'INSERT INTO reconciliation_issues (leg_id, broker_account_id, broker_order_id, kind, detail, found_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [legId, accountId, brokerOrderId, kind, detail, this.d.clock()],
    );
    this.d.log.error({ legId, accountId, code: kind, reason: detail }, 'reconciliation mismatch needs a human');
    return 1;
  }

  /** Re-reads [leg] while holding its order's lock, so it can't race a cancel or exit. Skips if busy. */
  private async refreshUnderLock(leg: Leg, source: 'reconcile' | 'webhook'): Promise<void> {
    await this.d.db.withLock(`order:${leg.parentOrderId}`, 0, async () => {
      const current = (await this.d.orders.leg(leg.id))!;
      const parent = (await this.d.orders.parent(current.parentOrderId))!;
      await this.d.legs.refresh(current, source, parent.userId);
    });
  }
}
