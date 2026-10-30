import type { RawExchange } from '../domain/broker-error.ts';
import type { Paise } from '../domain/money.ts';
import {
  isTerminal,
  parentStatus,
  type LegStatus,
  type OrderType,
  type ParentStatus,
  type Product,
  type Side,
} from '../domain/order.ts';
import type { AccountMode } from './broker-accounts.ts';
import type { Db, Queryable } from './db.ts';

export type ParentKind = 'ENTRY' | 'EXIT';

/** What the user asked for. Its status is derived from its legs. */
export interface ParentOrder {
  id: string;
  userId: string;
  clientId: string;
  kind: ParentKind;
  /** For an EXIT, the order whose position it closes. */
  exitOf: string | null;
  instrumentId: string;
  side: Side;
  quantity: number;
  orderType: OrderType;
  product: Product;
  pricePaise: Paise | null;
  triggerPaise: Paise | null;
  referencePricePaise: Paise | null;
  algoId: string | null;
  idempotencyKey: string;
  status: ParentStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** What one broker account did with the order. */
export interface Leg {
  id: string;
  parentOrderId: string;
  accountId: string;
  broker: string;
  mode: AccountMode;
  /** Sent to the broker as the order tag, so an UNKNOWN leg can be found in the order book. */
  clientRef: string;
  brokerOrderId: string | null;
  status: LegStatus;
  quantity: number;
  filledQty: number;
  avgPricePaise: Paise | null;
  orderType: OrderType;
  pricePaise: Paise | null;
  triggerPaise: Paise | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** When reconciliation should next look at this leg; null once terminal. */
  reconcileAt: Date | null;
  reconcileAttempts: number;
  submittedAt: Date | null;
  terminalAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type EventSource = 'api' | 'reconcile' | 'webhook' | 'eod' | 'risk';

/** One audit-trail entry: what was done to a leg and the raw broker exchange. */
export interface LegEvent {
  action: string;
  source: EventSource;
  raw: RawExchange | null;
}

export interface OrderEvent {
  id: number;
  legId: string;
  action: string;
  fromStatus: LegStatus | null;
  toStatus: LegStatus;
  source: EventSource;
  rawRequest: unknown;
  rawResponse: unknown;
  at: Date;
}

export type LegPatch = Partial<
  Pick<
    Leg,
    | 'brokerOrderId' | 'status' | 'quantity' | 'filledQty' | 'avgPricePaise' | 'orderType' | 'pricePaise'
    | 'triggerPaise' | 'errorCode' | 'errorMessage' | 'reconcileAt' | 'reconcileAttempts' | 'submittedAt'
  >
>;

type Row = Record<string, unknown>;

const toParent = (r: Row): ParentOrder => ({
  id: r['id'] as string,
  userId: r['user_id'] as string,
  clientId: r['client_id'] as string,
  kind: r['kind'] as ParentKind,
  exitOf: (r['exit_of'] as string | null) ?? null,
  instrumentId: r['instrument_id'] as string,
  side: r['side'] as Side,
  quantity: r['quantity'] as number,
  orderType: r['order_type'] as OrderType,
  product: r['product'] as Product,
  pricePaise: (r['price_paise'] as number | null) ?? null,
  triggerPaise: (r['trigger_paise'] as number | null) ?? null,
  referencePricePaise: (r['reference_price_paise'] as number | null) ?? null,
  algoId: (r['algo_id'] as string | null) ?? null,
  idempotencyKey: r['idempotency_key'] as string,
  status: r['status'] as ParentStatus,
  createdAt: r['created_at'] as Date,
  updatedAt: r['updated_at'] as Date,
});

const toLeg = (r: Row): Leg => ({
  id: r['id'] as string,
  parentOrderId: r['parent_order_id'] as string,
  accountId: r['broker_account_id'] as string,
  broker: r['broker'] as string,
  mode: r['mode'] as AccountMode,
  clientRef: r['client_ref'] as string,
  brokerOrderId: (r['broker_order_id'] as string | null) ?? null,
  status: r['status'] as LegStatus,
  quantity: r['quantity'] as number,
  filledQty: r['filled_qty'] as number,
  avgPricePaise: (r['avg_price_paise'] as number | null) ?? null,
  orderType: r['order_type'] as OrderType,
  pricePaise: (r['price_paise'] as number | null) ?? null,
  triggerPaise: (r['trigger_paise'] as number | null) ?? null,
  errorCode: (r['error_code'] as string | null) ?? null,
  errorMessage: (r['error_message'] as string | null) ?? null,
  reconcileAt: (r['reconcile_at'] as Date | null) ?? null,
  reconcileAttempts: r['reconcile_attempts'] as number,
  submittedAt: (r['submitted_at'] as Date | null) ?? null,
  terminalAt: (r['terminal_at'] as Date | null) ?? null,
  createdAt: r['created_at'] as Date,
  updatedAt: r['updated_at'] as Date,
});

const COLUMNS: Record<keyof LegPatch, string> = {
  brokerOrderId: 'broker_order_id',
  status: 'status',
  quantity: 'quantity',
  filledQty: 'filled_qty',
  avgPricePaise: 'avg_price_paise',
  orderType: 'order_type',
  pricePaise: 'price_paise',
  triggerPaise: 'trigger_paise',
  errorCode: 'error_code',
  errorMessage: 'error_message',
  reconcileAt: 'reconcile_at',
  reconcileAttempts: 'reconcile_attempts',
  submittedAt: 'submitted_at',
};

export type IdempotencyStart =
  | { state: 'new' }
  | { state: 'replay'; statusCode: number; response: unknown }
  | { state: 'in_progress' }
  | { state: 'mismatch'; operation: string };

/** Parent orders, legs, the append-only order events, and idempotency keys. */
export class OrderRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Stores the parent and its legs (all PENDING_SUBMIT) before anything is sent to a broker. */
  async create(parent: ParentOrder, legs: readonly Leg[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO parent_orders (id, user_id, client_id, kind, exit_of, instrument_id, side, quantity, order_type, product,
           price_paise, trigger_paise, reference_price_paise, algo_id, idempotency_key, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          parent.id, parent.userId, parent.clientId, parent.kind, parent.exitOf, parent.instrumentId, parent.side,
          parent.quantity, parent.orderType, parent.product, parent.pricePaise, parent.triggerPaise,
          parent.referencePricePaise, parent.algoId, parent.idempotencyKey, parent.status, parent.createdAt, parent.updatedAt,
        ],
      );
      for (const l of legs) {
        await tx.query(
          `INSERT INTO order_legs (id, parent_order_id, broker_account_id, broker, mode, client_ref, broker_order_id, status,
             quantity, filled_qty, avg_price_paise, order_type, price_paise, trigger_paise, error_code, error_message,
             reconcile_at, reconcile_attempts, submitted_at, terminal_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
          [
            l.id, l.parentOrderId, l.accountId, l.broker, l.mode, l.clientRef, l.brokerOrderId, l.status, l.quantity,
            l.filledQty, l.avgPricePaise, l.orderType, l.pricePaise, l.triggerPaise, l.errorCode, l.errorMessage,
            l.reconcileAt, l.reconcileAttempts, l.submittedAt, l.terminalAt, l.createdAt, l.updatedAt,
          ],
        );
        await this.event(tx, { leg: l, from: null, to: l.status, event: { action: 'create', source: 'api', raw: null }, at: l.createdAt });
        if (isTerminal(l.status)) await this.outbox(tx, parent, l, l.createdAt);
      }
      await this.refreshParent(tx, parent.id, parent.createdAt);
    });
  }

  /**
   * Applies [patch] to a leg and records [event] in the audit trail, in one
   * transaction. Recomputes the parent status, and when the leg turns terminal
   * queues it for analytics. Returns the updated leg.
   */
  async updateLeg(legId: string, patch: LegPatch, event: LegEvent, now: Date): Promise<Leg> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query('SELECT * FROM order_legs WHERE id = $1 FOR UPDATE', [legId]);
      const before = toLeg(row!);
      const after: Leg = { ...before, ...patch, updatedAt: now };
      const becameTerminal = !isTerminal(before.status) && isTerminal(after.status);
      if (becameTerminal) {
        after.terminalAt = now;
        after.reconcileAt = null;
      }
      const sets: string[] = ['updated_at = $2', 'terminal_at = $3', 'reconcile_at = $4'];
      const values: unknown[] = [legId, now, after.terminalAt, after.reconcileAt];
      for (const [key, column] of Object.entries(COLUMNS)) {
        if (key === 'reconcileAt' || !(key in patch)) continue;
        values.push(after[key as keyof LegPatch]);
        sets.push(`${column} = $${values.length}`);
      }
      await tx.query(`UPDATE order_legs SET ${sets.join(', ')} WHERE id = $1`, values);
      await this.event(tx, { leg: before, from: before.status, to: after.status, event, at: now });
      if (becameTerminal) {
        const [p] = await tx.query('SELECT * FROM parent_orders WHERE id = $1', [before.parentOrderId]);
        await this.outbox(tx, toParent(p!), after, now);
      }
      await this.refreshParent(tx, before.parentOrderId, now);
      return after;
    });
  }

  /** Sets when reconciliation looks at a leg next, without an audit event (nothing about the order changed). */
  async scheduleReconcile(legId: string, at: Date | null, attempts: number): Promise<void> {
    await this.db.query('UPDATE order_legs SET reconcile_at = $2, reconcile_attempts = $3 WHERE id = $1', [legId, at, attempts]);
  }

  /** Records an action on a leg that didn't change its state (a refused cancel, a modify request). */
  async note(leg: Leg, event: LegEvent, now: Date): Promise<void> {
    await this.event(this.db, { leg, from: leg.status, to: leg.status, event, at: now });
  }

  async parent(id: string): Promise<ParentOrder | null> {
    const [row] = await this.db.query('SELECT * FROM parent_orders WHERE id = $1', [id]);
    return row ? toParent(row) : null;
  }

  async parentOwned(userId: string, id: string): Promise<ParentOrder | null> {
    const [row] = await this.db.query('SELECT * FROM parent_orders WHERE id = $1 AND user_id = $2', [id, userId]);
    return row ? toParent(row) : null;
  }

  async listParents(userId: string, limit: number, before: Date | null): Promise<ParentOrder[]> {
    const rows = await this.db.query(
      'SELECT * FROM parent_orders WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2) ORDER BY created_at DESC, id DESC LIMIT $3',
      [userId, before, limit],
    );
    return rows.map(toParent);
  }

  async legs(parentId: string): Promise<Leg[]> {
    return (await this.db.query('SELECT * FROM order_legs WHERE parent_order_id = $1 ORDER BY created_at, id', [parentId])).map(toLeg);
  }

  async legsOf(parentIds: readonly string[]): Promise<Leg[]> {
    if (parentIds.length === 0) return [];
    return (await this.db.query('SELECT * FROM order_legs WHERE parent_order_id = ANY($1) ORDER BY created_at, id', [parentIds])).map(toLeg);
  }

  async leg(id: string): Promise<Leg | null> {
    const [row] = await this.db.query('SELECT * FROM order_legs WHERE id = $1', [id]);
    return row ? toLeg(row) : null;
  }

  async legByBrokerOrder(broker: string, brokerOrderId: string): Promise<Leg | null> {
    const [row] = await this.db.query('SELECT * FROM order_legs WHERE broker = $1 AND broker_order_id = $2', [broker, brokerOrderId]);
    return row ? toLeg(row) : null;
  }

  /** Legs that aren't terminal and are due a look from reconciliation. */
  async dueForReconcile(now: Date, limit: number): Promise<Leg[]> {
    const rows = await this.db.query('SELECT * FROM order_legs WHERE reconcile_at <= $1 ORDER BY reconcile_at LIMIT $2', [now, limit]);
    return rows.map(toLeg);
  }

  /** Every leg on [accountId] since [since], for the end-of-day comparison. */
  async legsForAccountSince(accountId: string, since: Date): Promise<Leg[]> {
    const rows = await this.db.query('SELECT * FROM order_legs WHERE broker_account_id = $1 AND created_at >= $2 ORDER BY created_at', [accountId, since]);
    return rows.map(toLeg);
  }

  /** Legs of the EXIT orders already sent for [parentId]. */
  async exitLegs(parentId: string): Promise<Leg[]> {
    const rows = await this.db.query(
      `SELECT l.* FROM order_legs l JOIN parent_orders p ON p.id = l.parent_order_id
        WHERE p.exit_of = $1 ORDER BY l.created_at`,
      [parentId],
    );
    return rows.map(toLeg);
  }

  /** Broker orders (legs) the user's ENTRY orders sent since [since]. Exits don't count. */
  async entryLegsSince(userId: string, since: Date): Promise<number> {
    const [row] = await this.db.query<{ n: number }>(
      `SELECT count(*) AS n FROM order_legs l JOIN parent_orders p ON p.id = l.parent_order_id
        WHERE p.user_id = $1 AND p.kind = 'ENTRY' AND p.created_at >= $2`,
      [userId, since],
    );
    return row!.n;
  }

  async events(legId: string): Promise<OrderEvent[]> {
    const rows = await this.db.query('SELECT * FROM order_events WHERE leg_id = $1 ORDER BY id', [legId]);
    return rows.map((r) => ({
      id: Number(r['id']),
      legId: r['leg_id'] as string,
      action: r['action'] as string,
      fromStatus: (r['from_status'] as LegStatus | null) ?? null,
      toStatus: r['to_status'] as LegStatus,
      source: r['source'] as EventSource,
      rawRequest: r['raw_request'] ?? null,
      rawResponse: r['raw_response'] ?? null,
      at: r['at'] as Date,
    }));
  }

  // Idempotency ------------------------------------------------------------

  /**
   * Claims [key] for this request. A replay with the same body gets the
   * stored response; a different body for the same key is a mismatch; a
   * replay while the first request is still running is in progress.
   */
  async beginIdempotent(userId: string, key: string, operation: string, requestHash: string, now: Date): Promise<IdempotencyStart> {
    const inserted = await this.db.query(
      `INSERT INTO idempotency_keys (user_id, key, operation, request_hash, created_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, key) DO NOTHING RETURNING key`,
      [userId, key, operation, requestHash, now],
    );
    if (inserted.length > 0) return { state: 'new' };
    const [row] = await this.db.query<{ operation: string; request_hash: string; status_code: number | null; response: unknown }>(
      'SELECT operation, request_hash, status_code, response FROM idempotency_keys WHERE user_id = $1 AND key = $2',
      [userId, key],
    );
    if (row!.operation !== operation || row!.request_hash !== requestHash) return { state: 'mismatch', operation: row!.operation };
    if (row!.status_code === null) return { state: 'in_progress' };
    return { state: 'replay', statusCode: row!.status_code, response: row!.response };
  }

  async finishIdempotent(userId: string, key: string, statusCode: number, response: unknown): Promise<void> {
    await this.db.query('UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE user_id = $1 AND key = $2', [
      userId, key, statusCode, JSON.stringify(response),
    ]);
  }

  /** Frees a key whose request failed before doing anything, so the client can retry with it. */
  async releaseIdempotent(userId: string, key: string): Promise<void> {
    await this.db.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND status_code IS NULL', [userId, key]);
  }

  async purgeIdempotency(before: Date): Promise<void> {
    await this.db.query('DELETE FROM idempotency_keys WHERE created_at < $1', [before]);
  }

  // Internals ----------------------------------------------------------------

  private async event(q: Queryable, r: { leg: Pick<Leg, 'id' | 'parentOrderId'>; from: LegStatus | null; to: LegStatus; event: LegEvent; at: Date }) {
    const { raw } = r.event;
    await q.query(
      `INSERT INTO order_events (leg_id, parent_order_id, action, from_status, to_status, source, raw_request, raw_response, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        r.leg.id, r.leg.parentOrderId, r.event.action, r.from, r.to, r.event.source,
        raw ? JSON.stringify(raw.request) : null,
        raw?.response ? JSON.stringify(raw.response) : null,
        r.at,
      ],
    );
  }

  private async refreshParent(q: Queryable, parentId: string, now: Date) {
    const legs = await q.query<{ status: LegStatus; filled_qty: number }>('SELECT status, filled_qty FROM order_legs WHERE parent_order_id = $1', [parentId]);
    const status = parentStatus(legs.map((l) => ({ status: l.status, filledQty: l.filled_qty })));
    await q.query('UPDATE parent_orders SET status = $2, updated_at = $3 WHERE id = $1', [parentId, status, now]);
  }

  /** Transactional outbox: the analytics job picks these up later, off the order path. */
  private async outbox(q: Queryable, parent: ParentOrder, leg: Leg, at: Date) {
    const payload = {
      legId: leg.id,
      userId: parent.userId,
      accountId: leg.accountId,
      broker: leg.broker,
      mode: leg.mode,
      instrumentId: parent.instrumentId,
      kind: parent.kind,
      side: parent.side,
      orderType: leg.orderType,
      status: leg.status,
      errorCode: leg.errorCode,
      quantity: leg.quantity,
      filledQty: leg.filledQty,
      avgPricePaise: leg.avgPricePaise,
      referencePricePaise: parent.referencePricePaise ?? parent.pricePaise,
      submittedAt: leg.submittedAt?.toISOString() ?? null,
      terminalAt: at.toISOString(),
    };
    await q.query('INSERT INTO analytics_outbox (payload, created_at) VALUES ($1, $2)', [JSON.stringify(payload), at]);
  }
}
