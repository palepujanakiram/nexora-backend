import { describe, expect, it } from 'vitest';

import { BillingRepository, type Plan, type Subscription } from '../../src/data/billing.ts';
import { IdentityRepository } from '../../src/data/identity.ts';
import { decideEntitlement, type SubscriptionFacts } from '../../src/domain/entitlement.ts';
import { EntitlementService } from '../../src/usecases/entitlements.ts';
import { testClock } from '../app.ts';
import { testDb } from '../db.ts';
import { NOW } from '../helpers.ts';

const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const facts = (over: Partial<SubscriptionFacts>): SubscriptionFacts => ({
  status: 'active',
  currentPeriodEnd: at(10),
  graceUntil: null,
  cancelAtPeriodEnd: false,
  ...over,
});
const decide = (over: Partial<SubscriptionFacts>) => decideEntitlement(facts(over), NOW, 3);
const lapsed = { mode: 'exit_only', reason: 'lapsed', warning: null };

describe('decideEntitlement', () => {
  it('is exit-only without a subscription', () => {
    expect(decideEntitlement(null, NOW, 3)).toEqual({ mode: 'exit_only', reason: 'no_subscription', warning: null });
  });

  it('is full while an active subscription is in its period', () => {
    expect(decide({})).toEqual({ mode: 'full', reason: 'active', warning: null });
    expect(decide({ cancelAtPeriodEnd: true })).toEqual({ mode: 'full', reason: 'active', warning: 'Your plan ends at the end of this period.' });
  });

  it('gives an active subscription past its period a grace window for the renewal', () => {
    expect(decide({ currentPeriodEnd: at(-1) })).toEqual({
      mode: 'full',
      reason: 'grace',
      warning: `Your last payment failed. Trading stops on ${at(2).toISOString().slice(0, 10)} unless it goes through.`,
    });
    expect(decide({ currentPeriodEnd: at(-3) })).toEqual(lapsed);
  });

  it('is exit-only for an active subscription that was cancelled at period end, or has no period', () => {
    expect(decide({ currentPeriodEnd: at(-1), cancelAtPeriodEnd: true })).toEqual(lapsed);
    expect(decide({ currentPeriodEnd: null })).toEqual(lapsed);
  });

  it('allows past_due and halted only within the grace period', () => {
    for (const status of ['past_due', 'halted'] as const) {
      expect(decide({ status, graceUntil: at(1) })).toEqual({
        mode: 'full',
        reason: 'grace',
        warning: `Your last payment failed. Trading stops on ${at(1).toISOString().slice(0, 10)} unless it goes through.`,
      });
      expect(decide({ status, graceUntil: at(-1) })).toEqual(lapsed);
      expect(decide({ status, graceUntil: null })).toEqual(lapsed);
    }
  });

  it('keeps a cancelled subscription until its period ends', () => {
    expect(decide({ status: 'cancelled' })).toEqual({ mode: 'full', reason: 'active', warning: 'Your plan ends at the end of this period.' });
    expect(decide({ status: 'cancelled', currentPeriodEnd: at(-1) })).toEqual(lapsed);
  });

  it('is exit-only for created and expired subscriptions', () => {
    expect(decide({ status: 'created' })).toEqual({ mode: 'exit_only', reason: 'no_subscription', warning: null });
    expect(decide({ status: 'expired' })).toEqual(lapsed);
  });
});

const PLAN: Plan = {
  code: 'basic',
  name: 'Basic',
  pricePaise: 49_900,
  interval: 'monthly',
  maxAccounts: 1,
  maxOrdersPerDay: 20,
  maxFanout: 1,
  brokers: ['zerodha'],
  razorpayPlanId: 'plan_b',
  active: true,
};
const UNLIMITED: Plan = { ...PLAN, code: 'unlimited', razorpayPlanId: null };

async function service(billingEnabled = true) {
  const db = await testDb();
  const billing = new BillingRepository(db);
  const clock = testClock();
  await new IdentityRepository(db).createUser({ id: 'usr_1', phone: '919876543210', email: null, status: 'active', createdAt: NOW });
  const entitlements = new EntitlementService({ billing, clock, billingEnabled, graceDays: 3, cacheMs: 30_000, unlimited: UNLIMITED, upgradeUrl: 'https://nexora.test/plans' });
  const subscribe = async (over: Partial<Subscription> = {}) => {
    const sub: Subscription = {
      id: 'sub_1',
      userId: 'usr_1',
      planCode: 'basic',
      status: 'active',
      currentPeriodEnd: at(10),
      graceUntil: null,
      cancelAtPeriodEnd: false,
      providerRef: 'sub_rp_1',
      checkoutUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    };
    await billing.createSubscription(sub);
    return sub;
  };
  return { db, billing, clock, entitlements, subscribe };
}

describe('EntitlementService', () => {
  it('gives everyone the unlimited plan when billing is off', async () => {
    const { entitlements } = await service(false);
    expect(await entitlements.check('usr_1')).toEqual({ mode: 'full', reason: 'billing_disabled', warning: null, plan: UNLIMITED });
    expect(await entitlements.requireEntry('usr_1')).toEqual(UNLIMITED);
  });

  it('returns the subscribed plan with the decision', async () => {
    const t = await service();
    await t.billing.upsertPlan(PLAN);
    await t.subscribe();
    expect(await t.entitlements.check('usr_1')).toEqual({ mode: 'full', reason: 'active', warning: null, plan: PLAN });
    expect(await t.entitlements.requireEntry('usr_1')).toEqual(PLAN);
  });

  it('caches for cacheMs, and invalidate drops the cache', async () => {
    const t = await service();
    await t.billing.upsertPlan(PLAN);
    expect((await t.entitlements.check('usr_1')).mode).toBe('exit_only');
    const sub = await t.subscribe();
    t.clock.advance(29_000);
    expect((await t.entitlements.check('usr_1')).mode).toBe('exit_only');
    t.clock.advance(1000);
    expect((await t.entitlements.check('usr_1')).mode).toBe('full');

    await t.billing.updateSubscription({ ...sub, status: 'expired' });
    expect((await t.entitlements.check('usr_1')).mode).toBe('full');
    t.entitlements.invalidate('usr_1');
    expect((await t.entitlements.check('usr_1')).mode).toBe('exit_only');
  });

  it('refuses entry with 402 and names the cheapest plan and where to buy it', async () => {
    const t = await service();
    await t.billing.upsertPlan({ ...PLAN, code: 'pro', pricePaise: 99_900 });
    await t.billing.upsertPlan(PLAN);
    await t.billing.upsertPlan({ ...PLAN, code: 'free', pricePaise: 0, active: false });
    await expect(t.entitlements.requireEntry('usr_1')).rejects.toMatchObject({
      status: 402,
      code: 'subscription_required',
      message: 'Placing new orders needs an active subscription. You can still cancel and exit.',
      details: { mode: 'exit_only', reason: 'no_subscription', required_plan: 'basic', upgrade_url: 'https://nexora.test/plans' },
    });
  });

  it('names no plan when none are on sale', async () => {
    const t = await service();
    await t.billing.upsertPlan(PLAN);
    await t.subscribe({ status: 'halted' });
    await t.billing.upsertPlan({ ...PLAN, active: false });
    await expect(t.entitlements.requireEntry('usr_1')).rejects.toMatchObject({ details: { reason: 'lapsed', required_plan: null } });
  });
});
