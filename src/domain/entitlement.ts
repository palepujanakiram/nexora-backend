/** What a user may do right now. Cancel, modify, exit, positions and history are allowed in both modes. */
export type AccessMode = 'full' | 'exit_only';

export interface SubscriptionFacts {
  status: 'created' | 'active' | 'past_due' | 'halted' | 'cancelled' | 'expired';
  currentPeriodEnd: Date | null;
  graceUntil: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface EntitlementDecision {
  mode: AccessMode;
  /** Machine-readable why: `active`, `grace`, `no_subscription`, `lapsed`, `billing_disabled`. */
  reason: string;
  /** Shown in the app while still allowed but at risk (grace period). */
  warning: string | null;
}

/**
 * Whether new entries are allowed. Fails closed: anything not clearly paid up
 * is exit-only. Exit-only never blocks closing a position: cancel, modify
 * (without adding quantity) and exit don't consult this at all.
 */
export function decideEntitlement(sub: SubscriptionFacts | null, now: Date, graceDays: number): EntitlementDecision {
  return sub ? BY_STATUS[sub.status](sub, now, graceDays) : NO_SUBSCRIPTION;
}

const DAY_MS = 86_400_000;
const ENDING = 'Your plan ends at the end of this period.';
const NO_SUBSCRIPTION: EntitlementDecision = { mode: 'exit_only', reason: 'no_subscription', warning: null };
const LAPSED: EntitlementDecision = { mode: 'exit_only', reason: 'lapsed', warning: null };

const full = (reason: string, warning: string | null): EntitlementDecision => ({ mode: 'full', reason, warning });
const inPeriod = (s: SubscriptionFacts, now: Date) => s.currentPeriodEnd !== null && s.currentPeriodEnd > now;

/** Still allowed until [until] (a failed or unconfirmed renewal), with a warning; lapsed after. */
function grace(until: Date | null, now: Date): EntitlementDecision {
  if (!until || until <= now) return LAPSED;
  return full('grace', `Your last payment failed. Trading stops on ${until.toISOString().slice(0, 10)} unless it goes through.`);
}

const BY_STATUS: Record<SubscriptionFacts['status'], (s: SubscriptionFacts, now: Date, graceDays: number) => EntitlementDecision> = {
  active: (s, now, graceDays) => {
    if (inPeriod(s, now)) return full('active', s.cancelAtPeriodEnd ? ENDING : null);
    if (s.cancelAtPeriodEnd || s.currentPeriodEnd === null) return LAPSED;
    // Renewal is due but the provider hasn't confirmed it yet: allow the grace period.
    return grace(new Date(s.currentPeriodEnd.getTime() + graceDays * DAY_MS), now);
  },
  past_due: (s, now) => grace(s.graceUntil, now),
  halted: (s, now) => grace(s.graceUntil, now),
  cancelled: (s, now) => (inPeriod(s, now) ? full('active', ENDING) : LAPSED),
  created: () => NO_SUBSCRIPTION,
  expired: () => LAPSED,
};
