import type { AnalyticsRepository } from '../data/analytics.ts';
import { badRequest } from '../domain/errors.ts';
import { istDate } from '../domain/ist.ts';
import { rupees } from '../domain/money.ts';
import type { Log } from '../logging.ts';

const round = (n: number, places: number) => Number(n.toFixed(places));

/**
 * Execution quality across brokers and P&L, served from the analytics
 * tables only. The pipeline drains the order module's outbox into facts
 * and recomputes the daily rollups for the days it touched.
 */
export class AnalyticsService {
  private readonly d: { analytics: AnalyticsRepository; clock: () => Date; log: Log };

  constructor(deps: { analytics: AnalyticsRepository; clock: () => Date; log: Log }) {
    this.d = deps;
  }

  /** Moves new terminal legs into the analytics store and refreshes the touched days' rollups. */
  async pipeline(): Promise<number> {
    const days = new Set<string>();
    for (;;) {
      const touched = await this.d.analytics.drainOutbox(500);
      if (touched.length === 0) break;
      for (const d of touched) days.add(d);
    }
    for (const day of days) await this.d.analytics.rollup(day);
    if (days.size) this.d.log.info({ job: 'analytics', count: days.size }, 'analytics rollups refreshed');
    return days.size;
  }

  /**
   * Fill rate, slippage against the price at submission, time to fill and
   * rejection reasons, by broker — and by instrument and side when asked, so
   * the same contract can be compared across brokers.
   */
  async execution(userId: string, q: { from?: string | undefined; to?: string | undefined; groupBy: 'broker' | 'instrument' }) {
    const { from, to } = this.range(q.from, q.to);
    const rows = await this.d.analytics.execution({ userId, from, to, byInstrument: q.groupBy === 'instrument' });
    return {
      from,
      to,
      rows: rows.map((r) => ({
        broker: r.broker,
        ...(q.groupBy === 'instrument' ? { instrumentId: r.instrumentId, side: r.side } : {}),
        legs: r.legs,
        filled: r.filled,
        rejected: r.rejected,
        fillRate: r.legs ? round(r.filled / r.legs, 4) : null,
        rejectionRate: r.legs ? round(r.rejected / r.legs, 4) : null,
        rejectionsByReason: r.rejections,
        avgSlippageBps: r.slippageSamples ? round(r.slippageBpsSum / r.slippageSamples, 2) : null,
        avgTimeToFillMs: r.fillSamples ? Math.round(r.fillMsSum / r.fillSamples) : null,
      })),
    };
  }

  /**
   * Realised P&L (average-cost method, from fills in the analytics store) for
   * the period, by account and instrument, plus unrealised P&L from the last
   * position snapshot the brokers reported.
   */
  async pnl(userId: string, q: { from?: string | undefined; to?: string | undefined }) {
    const { from, to } = this.range(q.from, q.to);
    const books = new Map<string, { accountId: string; instrumentId: string; qty: number; avg: number; realised: number }>();
    for (const f of await this.d.analytics.fills(userId, to)) {
      const key = `${f.accountId}|${f.instrumentId}`;
      const b = books.get(key) ?? { accountId: f.accountId, instrumentId: f.instrumentId, qty: 0, avg: 0, realised: 0 };
      const signed = f.side === 'BUY' ? f.filledQty : -f.filledQty;
      const inPeriod = istDate(f.terminalAt) >= from;
      if (b.qty === 0 || Math.sign(b.qty) === Math.sign(signed)) {
        // Adding to the position: new average cost.
        b.avg = (b.avg * Math.abs(b.qty) + f.avgPricePaise * Math.abs(signed)) / (Math.abs(b.qty) + Math.abs(signed));
        b.qty += signed;
      } else {
        const closing = Math.min(Math.abs(b.qty), Math.abs(signed));
        const pnl = (f.avgPricePaise - b.avg) * closing * Math.sign(b.qty);
        if (inPeriod) b.realised += pnl;
        const rest = Math.abs(signed) - closing;
        b.qty += Math.sign(signed) * closing;
        if (rest > 0) {
          b.qty = Math.sign(signed) * rest;
          b.avg = f.avgPricePaise;
        }
      }
      books.set(key, b);
    }
    const realised = [...books.values()].filter((b) => b.realised !== 0).map((b) => ({ accountId: b.accountId, instrumentId: b.instrumentId, realised: rupees(Math.round(b.realised)) }));
    const unrealised = (await this.d.analytics.snapshots(userId)).map((s) => ({
      accountId: s.accountId,
      tradingSymbol: s.tradingSymbol,
      netQty: s.netQty,
      unrealised: s.pnlPaise === null ? null : rupees(s.pnlPaise),
      asOf: s.at.toISOString(),
    }));
    const total = realised.reduce((n, r) => n + Math.round(Number(r.realised) * 100), 0);
    return { from, to, realisedTotal: rupees(total), realised, unrealised };
  }

  private range(from: string | undefined, to: string | undefined) {
    const today = istDate(this.d.clock());
    const end = to ?? today;
    const start = from ?? `${end.slice(0, 8)}01`;
    if (start > end) throw badRequest('from must not be after to.');
    return { from: start, to: end };
  }
}
