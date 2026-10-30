import { istDate } from '../domain/ist.ts';
import type { Db } from './db.ts';

/** What the order module publishes when a leg turns terminal (see OrderRepository's outbox). */
export interface LegFact {
  legId: string;
  userId: string;
  accountId: string;
  broker: string;
  mode: string;
  instrumentId: string;
  kind: 'ENTRY' | 'EXIT';
  side: 'BUY' | 'SELL';
  orderType: string;
  status: string;
  errorCode: string | null;
  quantity: number;
  filledQty: number;
  avgPricePaise: number | null;
  referencePricePaise: number | null;
  submittedAt: string | null;
  terminalAt: string;
}

export interface ExecutionRow {
  broker: string;
  instrumentId: string | null;
  side: string | null;
  legs: number;
  filled: number;
  rejected: number;
  rejections: Record<string, number>;
  slippageBpsSum: number;
  slippageSamples: number;
  fillMsSum: number;
  fillSamples: number;
}

export interface PnlFact {
  accountId: string;
  instrumentId: string;
  side: 'BUY' | 'SELL';
  filledQty: number;
  avgPricePaise: number;
  terminalAt: Date;
}

/**
 * The analytics store. Reporting reads only these tables, never the live
 * order tables, so a heavy dashboard can't slow down order placement.
 * TODO(ClickHouse/Timescale): move these tables to a columnar store when
 * volume needs it; only this class changes.
 */
export class AnalyticsRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Moves up to [limit] outbox entries into the fact table. Returns the IST days touched. */
  async drainOutbox(limit: number): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<{ id: number; payload: LegFact }>(
        'SELECT id, payload FROM analytics_outbox ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED',
        [limit],
      );
      const days = new Set<string>();
      for (const { payload: f } of rows) {
        const day = istDate(new Date(f.terminalAt));
        days.add(day);
        await tx.query(
          `INSERT INTO analytics_leg_facts (leg_id, user_id, broker_account_id, broker, mode, instrument_id, kind, side, order_type,
             status, error_code, quantity, filled_qty, avg_price_paise, reference_price_paise, submitted_at, terminal_at, day)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
           ON CONFLICT (leg_id) DO NOTHING`,
          [
            f.legId, f.userId, f.accountId, f.broker, f.mode, f.instrumentId, f.kind, f.side, f.orderType, f.status,
            f.errorCode, f.quantity, f.filledQty, f.avgPricePaise, f.referencePricePaise, f.submittedAt, f.terminalAt, day,
          ],
        );
      }
      if (rows.length) await tx.query('DELETE FROM analytics_outbox WHERE id = ANY($1)', [rows.map((r) => r.id)]);
      return [...days].sort();
    });
  }

  /**
   * Recomputes the execution-quality rollup for [day] from the facts.
   * Slippage is in basis points against the price at submission, positive
   * when the fill was worse for the user.
   */
  async rollup(day: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM analytics_execution_daily WHERE day = $1', [day]);
      await tx.query(
        `INSERT INTO analytics_execution_daily (day, user_id, broker, instrument_id, side, legs, filled, rejected, rejections,
           slippage_bps_sum, slippage_samples, fill_ms_sum, fill_samples)
         SELECT f.day, f.user_id, f.broker, f.instrument_id, f.side,
                count(*), count(*) FILTER (WHERE f.status = 'FILLED'), count(*) FILTER (WHERE f.status = 'REJECTED'),
                coalesce((SELECT jsonb_object_agg(r.code, r.n) FROM (
                   SELECT coalesce(g.error_code, 'UNKNOWN') AS code, count(*) AS n FROM analytics_leg_facts g
                    WHERE g.day = f.day AND g.user_id = f.user_id AND g.broker = f.broker AND g.instrument_id = f.instrument_id
                      AND g.side = f.side AND g.status = 'REJECTED' GROUP BY 1) r), '{}'::jsonb),
                coalesce(sum(CASE WHEN f.filled_qty > 0 AND f.avg_price_paise IS NOT NULL AND f.reference_price_paise > 0 THEN
                   (CASE WHEN f.side = 'BUY' THEN f.avg_price_paise - f.reference_price_paise
                         ELSE f.reference_price_paise - f.avg_price_paise END)::float8 * 10000 / f.reference_price_paise END), 0),
                count(*) FILTER (WHERE f.filled_qty > 0 AND f.avg_price_paise IS NOT NULL AND f.reference_price_paise > 0),
                coalesce(sum(CASE WHEN f.status = 'FILLED' AND f.submitted_at IS NOT NULL THEN
                   (extract(epoch FROM f.terminal_at - f.submitted_at) * 1000)::int8 END), 0),
                count(*) FILTER (WHERE f.status = 'FILLED' AND f.submitted_at IS NOT NULL)
           FROM analytics_leg_facts f WHERE f.day = $1
          GROUP BY f.day, f.user_id, f.broker, f.instrument_id, f.side`,
        [day],
      );
    });
  }

  /** Execution quality from the rollups, grouped by broker (and optionally instrument and side). */
  async execution(q: { userId: string; from: string; to: string; byInstrument: boolean }): Promise<ExecutionRow[]> {
    const group = q.byInstrument ? 'broker, instrument_id, side' : 'broker';
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${group}, sum(legs)::int8 AS legs, sum(filled)::int8 AS filled, sum(rejected)::int8 AS rejected,
              jsonb_agg(rejections) AS rejections, sum(slippage_bps_sum) AS slip, sum(slippage_samples)::int8 AS slip_n,
              sum(fill_ms_sum)::int8 AS fill_ms, sum(fill_samples)::int8 AS fill_n
         FROM analytics_execution_daily
        WHERE user_id = $1 AND day BETWEEN $2 AND $3
        GROUP BY ${group} ORDER BY ${group}`,
      [q.userId, q.from, q.to],
    );
    return rows.map((r) => {
      const rejections: Record<string, number> = {};
      for (const part of r['rejections'] as Record<string, number>[]) {
        for (const [code, n] of Object.entries(part)) rejections[code] = (rejections[code] ?? 0) + Number(n);
      }
      return {
        broker: r['broker'] as string,
        instrumentId: (r['instrument_id'] as string | undefined) ?? null,
        side: (r['side'] as string | undefined) ?? null,
        legs: r['legs'] as number,
        filled: r['filled'] as number,
        rejected: r['rejected'] as number,
        rejections,
        slippageBpsSum: Number(r['slip']),
        slippageSamples: r['slip_n'] as number,
        fillMsSum: r['fill_ms'] as number,
        fillSamples: r['fill_n'] as number,
      };
    });
  }

  /** Every fill for the user up to [to] (earlier fills set the cost basis), oldest first. */
  async fills(userId: string, to: string): Promise<PnlFact[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT broker_account_id, instrument_id, side, filled_qty, avg_price_paise, terminal_at FROM analytics_leg_facts
        WHERE user_id = $1 AND filled_qty > 0 AND avg_price_paise IS NOT NULL AND day <= $2
        ORDER BY terminal_at, leg_id`,
      [userId, to],
    );
    return rows.map((r) => ({
      accountId: r['broker_account_id'] as string,
      instrumentId: r['instrument_id'] as string,
      side: r['side'] as 'BUY' | 'SELL',
      filledQty: r['filled_qty'] as number,
      avgPricePaise: r['avg_price_paise'] as number,
      terminalAt: r['terminal_at'] as Date,
    }));
  }

  async saveSnapshots(accountId: string, userId: string, rows: readonly { nativeId: string; tradingSymbol: string; netQty: number; pnlPaise: number | null }[], at: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM analytics_position_snapshots WHERE broker_account_id = $1', [accountId]);
      for (const r of rows) {
        await tx.query(
          `INSERT INTO analytics_position_snapshots (broker_account_id, user_id, native_id, trading_symbol, net_qty, pnl_paise, at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (broker_account_id, native_id) DO NOTHING`,
          [accountId, userId, r.nativeId, r.tradingSymbol, r.netQty, r.pnlPaise, at],
        );
      }
    });
  }

  async snapshots(userId: string): Promise<{ accountId: string; tradingSymbol: string; netQty: number; pnlPaise: number | null; at: Date }[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      'SELECT * FROM analytics_position_snapshots WHERE user_id = $1 AND net_qty <> 0 ORDER BY broker_account_id, trading_symbol',
      [userId],
    );
    return rows.map((r) => ({
      accountId: r['broker_account_id'] as string,
      tradingSymbol: r['trading_symbol'] as string,
      netQty: r['net_qty'] as number,
      pnlPaise: (r['pnl_paise'] as number | null) ?? null,
      at: r['at'] as Date,
    }));
  }
}
