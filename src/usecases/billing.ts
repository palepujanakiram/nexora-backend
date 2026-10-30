import { toSubscription, type RazorpayClient } from '../brokers/razorpay.ts';
import type { BillingRepository, Plan, Subscription, SubscriptionStatus } from '../data/billing.ts';
import { newId } from '../data/crypto.ts';
import { AppError, badRequest, conflict, notFound } from '../domain/errors.ts';
import { rupees } from '../domain/money.ts';
import { objectOf, textOf } from '../brokers/http.ts';
import type { Log } from '../logging.ts';
import type { EntitlementService } from './entitlements.ts';
import type { EventBus } from './events.ts';

export interface BillingDeps {
  billing: BillingRepository;
  entitlements: EntitlementService;
  events: EventBus;
  /** Null when billing is off or Razorpay isn't configured. */
  razorpay: RazorpayClient | null;
  clock: () => Date;
  log: Log;
  graceDays: number;
}

export const planView = (p: Plan) => ({
  code: p.code,
  name: p.name,
  price: rupees(p.pricePaise),
  interval: p.interval,
  limits: { maxAccounts: p.maxAccounts, maxOrdersPerDay: p.maxOrdersPerDay, maxFanout: p.maxFanout, brokers: p.brokers },
});

const RAZORPAY_STATUS: Record<string, SubscriptionStatus> = {
  active: 'active',
  pending: 'past_due',
  halted: 'halted',
  paused: 'halted',
  cancelled: 'cancelled',
  completed: 'expired',
  expired: 'expired',
};

/** Razorpay's subscription status → ours. Anything else (created, authenticated) isn't paid yet. */
export const subscriptionStatus = (razorpay: string): SubscriptionStatus => RAZORPAY_STATUS[razorpay] ?? 'created';

/**
 * Plans, Razorpay subscriptions and the webhook that drives them. The
 * webhook is the only source of truth for whether someone has paid: never
 * the client, and never the checkout redirect.
 */
export class BillingService {
  private readonly d: BillingDeps;

  constructor(deps: BillingDeps) {
    this.d = deps;
  }

  async plans() {
    return (await this.d.billing.plans(true)).map(planView);
  }

  async upsertPlan(p: Plan) {
    await this.d.billing.upsertPlan(p);
    return planView(p);
  }

  async current(userId: string) {
    const sub = await this.d.billing.latestSubscription(userId);
    const e = await this.d.entitlements.check(userId);
    return {
      mode: e.mode,
      reason: e.reason,
      warning: e.warning,
      plan: e.plan ? planView(e.plan) : null,
      subscription: sub && {
        id: sub.id,
        planCode: sub.planCode,
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
        graceUntil: sub.graceUntil?.toISOString() ?? null,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        checkoutUrl: sub.status === 'created' ? sub.checkoutUrl : null,
      },
    };
  }

  /** Starts a Razorpay subscription and returns the page where the user authorises the mandate. */
  async checkout(userId: string, planCode: string) {
    const razorpay = this.razorpay();
    const plan = await this.d.billing.plan(planCode);
    if (!plan?.active) throw notFound('No such plan.');
    if (!plan.razorpayPlanId) throw badRequest('This plan has no Razorpay plan id yet.');
    const latest = await this.d.billing.latestSubscription(userId);
    if (latest && (latest.status === 'active' || latest.status === 'past_due') && !latest.cancelAtPeriodEnd) {
      throw conflict('You already have an active subscription.');
    }
    const created = await razorpay.createSubscription({
      planId: plan.razorpayPlanId,
      totalCount: plan.interval === 'monthly' ? 120 : 10,
      notes: { user_id: userId, plan_code: plan.code },
    });
    const now = this.d.clock();
    const sub: Subscription = {
      id: newId('sub'),
      userId,
      planCode: plan.code,
      status: 'created',
      currentPeriodEnd: null,
      graceUntil: null,
      cancelAtPeriodEnd: false,
      providerRef: created.id,
      checkoutUrl: created.shortUrl,
      createdAt: now,
      updatedAt: now,
    };
    await this.d.billing.createSubscription(sub);
    this.d.log.info({ userId, event: 'checkout', reason: plan.code }, 'subscription checkout started');
    return { subscriptionId: sub.id, checkoutUrl: created.shortUrl, status: sub.status };
  }

  /** Cancels at the end of the paid period. Trading stays allowed until then; exits always are. */
  async cancel(userId: string) {
    const razorpay = this.razorpay();
    const sub = await this.d.billing.latestSubscription(userId);
    if (!sub?.providerRef || sub.status === 'cancelled' || sub.status === 'expired') throw notFound('No subscription to cancel.');
    await razorpay.cancelAtCycleEnd(sub.providerRef);
    await this.d.billing.updateSubscription({ ...sub, cancelAtPeriodEnd: true, updatedAt: this.d.clock() });
    this.d.entitlements.invalidate(userId);
    return this.current(userId);
  }

  /**
   * A Razorpay webhook. Checks the signature over the raw body, stores the
   * event once (keyed by its event id), and moves the subscription to the
   * state Razorpay reports. Replays are acknowledged and ignored.
   */
  async webhook(rawBody: string, signature: string | undefined, eventId: string | undefined): Promise<{ processed: boolean }> {
    const razorpay = this.razorpay();
    if (!signature || !razorpay.verifyWebhook(rawBody, signature)) throw new AppError(401, 'bad_signature', 'Webhook signature does not match.');
    if (!eventId) throw badRequest('Missing X-Razorpay-Event-Id.');
    let body: Record<string, unknown>;
    try {
      body = objectOf(JSON.parse(rawBody));
    } catch {
      throw badRequest('Webhook body is not JSON.');
    }
    const type = textOf(body['event'], 'unknown');
    const entity = objectOf(objectOf(objectOf(body['payload'])['subscription'])['entity']);
    const remote = entity['id'] ? toSubscription(entity) : null;
    const sub = remote ? await this.d.billing.subscriptionByRef(remote.id) : null;
    const now = this.d.clock();
    const fresh = await this.d.billing.recordPaymentEvent({ subscriptionId: sub?.id ?? null, providerEventId: eventId, type, payload: body, at: now });
    if (!fresh) return { processed: false };
    if (!remote || !sub) {
      this.d.log.warn({ event: type, reason: remote ? 'unknown_subscription' : 'no_subscription_entity' }, 'payment event not applied');
      return { processed: true };
    }
    const status = subscriptionStatus(remote.status);
    const lapsing = status === 'past_due' || status === 'halted';
    const updated: Subscription = {
      ...sub,
      status,
      currentPeriodEnd: remote.currentEnd ?? sub.currentPeriodEnd,
      graceUntil: lapsing ? sub.graceUntil ?? new Date(now.getTime() + this.d.graceDays * 86_400_000) : status === 'active' ? null : sub.graceUntil,
      updatedAt: now,
    };
    await this.d.billing.updateSubscription(updated);
    this.d.entitlements.invalidate(sub.userId);
    const e = await this.d.entitlements.check(sub.userId);
    this.d.events.publish(sub.userId, { type: 'entitlement', mode: e.mode });
    this.d.log.info({ userId: sub.userId, event: type, status, mode: e.mode }, 'subscription updated from webhook');
    return { processed: true };
  }

  private razorpay(): RazorpayClient {
    if (!this.d.razorpay) throw new AppError(503, 'billing_unavailable', 'Billing isn\'t set up on this server.');
    return this.d.razorpay;
  }
}
