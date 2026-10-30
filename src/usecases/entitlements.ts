import type { BillingRepository, Plan } from '../data/billing.ts';
import { decideEntitlement, type EntitlementDecision } from '../domain/entitlement.ts';
import { AppError } from '../domain/errors.ts';

export interface Entitlement extends EntitlementDecision {
  /** The plan whose limits apply. In exit-only mode, the plan the user last had (or null). */
  plan: Plan | null;
}

export interface EntitlementDeps {
  billing: BillingRepository;
  clock: () => Date;
  /** Off: every user is entitled, with [unlimited] as their plan (a single operator's own accounts). */
  billingEnabled: boolean;
  graceDays: number;
  cacheMs: number;
  unlimited: Plan;
  /** Where the app sends the user to upgrade. */
  upgradeUrl: string;
}

/**
 * The entitlement check in the order path. Evaluated per request (cached for
 * [cacheMs] and dropped on every payment webhook for the user), never read
 * from the access token, so a lapse takes effect within seconds.
 */
export class EntitlementService {
  private readonly d: EntitlementDeps;
  private readonly cache = new Map<string, { at: number; value: Entitlement }>();

  constructor(deps: EntitlementDeps) {
    this.d = deps;
  }

  async check(userId: string): Promise<Entitlement> {
    const now = this.d.clock();
    const hit = this.cache.get(userId);
    if (hit && now.getTime() - hit.at < this.d.cacheMs) return hit.value;
    const value = await this.compute(userId, now);
    this.cache.set(userId, { at: now.getTime(), value });
    return value;
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  /** The plan if new entries are allowed; otherwise HTTP 402 with the plan needed and where to buy it. */
  async requireEntry(userId: string): Promise<Plan> {
    const e = await this.check(userId);
    if (e.mode === 'full' && e.plan) return e.plan;
    const cheapest = (await this.d.billing.plans(true))[0] ?? null;
    throw new AppError(402, 'subscription_required', 'Placing new orders needs an active subscription. You can still cancel and exit.', {
      mode: e.mode,
      reason: e.reason,
      required_plan: cheapest?.code ?? null,
      upgrade_url: this.d.upgradeUrl,
    });
  }

  private async compute(userId: string, now: Date): Promise<Entitlement> {
    if (!this.d.billingEnabled) return { mode: 'full', reason: 'billing_disabled', warning: null, plan: this.d.unlimited };
    const sub = await this.d.billing.latestSubscription(userId);
    const decision = decideEntitlement(sub, now, this.d.graceDays);
    return { ...decision, plan: sub ? await this.d.billing.plan(sub.planCode) : null };
  }
}
