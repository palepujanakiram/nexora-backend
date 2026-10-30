import type { LegStatus } from '../domain/order.ts';

/** Where a broker's status word puts an order: finished one way or another, or still working. */
export type BrokerState = 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED' | 'WORKING';

/**
 * A broker's status word → ours, through [table] (keys in upper case).
 * Working orders are OPEN, or PARTIALLY_FILLED once something filled. Words
 * not in the table are in-flight states (validation pending, modify pending,
 * anything new) and stay SUBMITTED, so reconciliation keeps checking.
 */
export function mapStatus(table: Readonly<Record<string, BrokerState>>, status: string, filled: number): LegStatus {
  const state = table[status.trim().toUpperCase()];
  if (state === undefined) return filled > 0 ? 'PARTIALLY_FILLED' : 'SUBMITTED';
  if (state === 'WORKING') return filled > 0 ? 'PARTIALLY_FILLED' : 'OPEN';
  return state;
}
