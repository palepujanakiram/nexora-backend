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
  if (!sub) return { mode: 'exit_only', reason: 'no_subscription', warning: null };
  const end = sub.currentPeriodEnd;
  const inPeriod = end !== null && end > now;
  const graceOk = sub.graceUntil !== null && sub.graceUntil > now;
  const graceWarning = (until: Date) => `Your last payment failed. Trading stops on ${until.toISOString().slice(0, 10)} unless it goes through.`;
  switch (sub.status) {
    case 'active': {
      if (inPeriod) return { mode: 'full', reason: 'active', warning: sub.cancelAtPeriodEnd ? 'Your plan ends at the end of this period.' : null };
      if (sub.cancelAtPeriodEnd || end === null) return { mode: 'exit_only', reason: 'lapsed', warning: null };
      // Renewal is due but the provider hasn't confirmed it yet: allow the grace period.
      const until = new Date(end.getTime() + graceDays * 86_400_000);
      return until > now ? { mode: 'full', reason: 'grace', warning: graceWarning(until) } : { mode: 'exit_only', reason: 'lapsed', warning: null };
    }
    case 'past_due':
    case 'halted':
      return graceOk ? { mode: 'full', reason: 'grace', warning: graceWarning(sub.graceUntil!) } : { mode: 'exit_only', reason: 'lapsed', warning: null };
    case 'cancelled':
      return inPeriod ? { mode: 'full', reason: 'active', warning: 'Your plan ends at the end of this period.' } : { mode: 'exit_only', reason: 'lapsed', warning: null };
    default:
      return { mode: 'exit_only', reason: sub.status === 'created' ? 'no_subscription' : 'lapsed', warning: null };
  }
}
