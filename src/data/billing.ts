import type { Db } from './db.ts';

export interface Plan {
  code: string;
  name: string;
  pricePaise: number;
  interval: 'monthly' | 'yearly';
  maxAccounts: number;
  maxOrdersPerDay: number;
  /** Most accounts one order may fan out to. */
  maxFanout: number;
  /** Broker codes this plan may trade on. */
  brokers: string[];
  razorpayPlanId: string | null;
  active: boolean;
}

export type SubscriptionStatus = 'created' | 'active' | 'past_due' | 'halted' | 'cancelled' | 'expired';

export interface Subscription {
  id: string;
  userId: string;
  planCode: string;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  graceUntil: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Razorpay subscription id. */
  providerRef: string | null;
  checkoutUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type Row = Record<string, unknown>;

const toPlan = (r: Row): Plan => ({
  code: r['code'] as string,
  name: r['name'] as string,
  pricePaise: r['price_paise'] as number,
  interval: r['interval'] as Plan['interval'],
  maxAccounts: r['max_accounts'] as number,
  maxOrdersPerDay: r['max_orders_per_day'] as number,
  maxFanout: r['max_fanout'] as number,
  brokers: r['brokers'] as string[],
  razorpayPlanId: (r['razorpay_plan_id'] as string | null) ?? null,
  active: r['active'] as boolean,
});

const toSubscription = (r: Row): Subscription => ({
  id: r['id'] as string,
  userId: r['user_id'] as string,
  planCode: r['plan_code'] as string,
  status: r['status'] as SubscriptionStatus,
  currentPeriodEnd: (r['current_period_end'] as Date | null) ?? null,
  graceUntil: (r['grace_until'] as Date | null) ?? null,
  cancelAtPeriodEnd: r['cancel_at_period_end'] as boolean,
  providerRef: (r['provider_ref'] as string | null) ?? null,
  checkoutUrl: (r['checkout_url'] as string | null) ?? null,
  createdAt: r['created_at'] as Date,
  updatedAt: r['updated_at'] as Date,
});

/** Plans (limits are data), subscriptions and the append-only payment events. */
export class BillingRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async plans(activeOnly: boolean): Promise<Plan[]> {
    const rows = await this.db.query(`SELECT * FROM plans ${activeOnly ? 'WHERE active' : ''} ORDER BY price_paise, code`);
    return rows.map(toPlan);
  }

  async plan(code: string): Promise<Plan | null> {
    const [row] = await this.db.query('SELECT * FROM plans WHERE code = $1', [code]);
    return row ? toPlan(row) : null;
  }

  async upsertPlan(p: Plan): Promise<void> {
    await this.db.query(
      `INSERT INTO plans (code, name, price_paise, interval, max_accounts, max_orders_per_day, max_fanout, brokers, razorpay_plan_id, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (code) DO UPDATE SET name = excluded.name, price_paise = excluded.price_paise, interval = excluded.interval,
         max_accounts = excluded.max_accounts, max_orders_per_day = excluded.max_orders_per_day, max_fanout = excluded.max_fanout,
         brokers = excluded.brokers, razorpay_plan_id = excluded.razorpay_plan_id, active = excluded.active`,
      [p.code, p.name, p.pricePaise, p.interval, p.maxAccounts, p.maxOrdersPerDay, p.maxFanout, p.brokers, p.razorpayPlanId, p.active],
    );
  }

  /** The user's most recent subscription, whatever its state. */
  async latestSubscription(userId: string): Promise<Subscription | null> {
    const [row] = await this.db.query('SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [userId]);
    return row ? toSubscription(row) : null;
  }

  async subscriptionByRef(providerRef: string): Promise<Subscription | null> {
    const [row] = await this.db.query('SELECT * FROM subscriptions WHERE provider_ref = $1', [providerRef]);
    return row ? toSubscription(row) : null;
  }

  async createSubscription(s: Subscription): Promise<void> {
    await this.db.query(
      `INSERT INTO subscriptions (id, user_id, plan_code, status, current_period_end, grace_until, cancel_at_period_end,
         provider_ref, checkout_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [s.id, s.userId, s.planCode, s.status, s.currentPeriodEnd, s.graceUntil, s.cancelAtPeriodEnd, s.providerRef, s.checkoutUrl, s.createdAt, s.updatedAt],
    );
  }

  async updateSubscription(s: Subscription): Promise<void> {
    await this.db.query(
      `UPDATE subscriptions SET status = $2, current_period_end = $3, grace_until = $4, cancel_at_period_end = $5, updated_at = $6
        WHERE id = $1`,
      [s.id, s.status, s.currentPeriodEnd, s.graceUntil, s.cancelAtPeriodEnd, s.updatedAt],
    );
  }

  /** Stores a provider event once. Returns false when this event id was already processed. */
  async recordPaymentEvent(e: { subscriptionId: string | null; providerEventId: string; type: string; payload: unknown; at: Date }): Promise<boolean> {
    const rows = await this.db.query(
      `INSERT INTO payment_events (subscription_id, provider_event_id, type, raw_payload, at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider_event_id) DO NOTHING RETURNING id`,
      [e.subscriptionId, e.providerEventId, e.type, JSON.stringify(e.payload), e.at],
    );
    return rows.length > 0;
  }

  async paymentEvents(subscriptionId: string): Promise<{ type: string; providerEventId: string; at: Date }[]> {
    const rows = await this.db.query<{ type: string; provider_event_id: string; at: Date }>(
      'SELECT type, provider_event_id, at FROM payment_events WHERE subscription_id = $1 ORDER BY id',
      [subscriptionId],
    );
    return rows.map((r) => ({ type: r.type, providerEventId: r.provider_event_id, at: r.at }));
  }
}
