import type { BrokerPosition } from '../brokers/adapter.ts';
import type { Db } from './db.ts';

export interface StoredPosition extends BrokerPosition {
  accountId: string;
  instrumentId: string | null;
  syncedAt: Date;
}

/** The last positions read from each broker. A cache for display; exits always re-read the broker. */
export class PositionRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async replace(accountId: string, positions: readonly (BrokerPosition & { instrumentId: string | null })[], now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM positions WHERE broker_account_id = $1', [accountId]);
      for (const p of positions) {
        await tx.query(
          `INSERT INTO positions (broker_account_id, native_id, instrument_id, trading_symbol, exchange, product, net_qty,
             avg_price_paise, last_price_paise, pnl_paise, synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (broker_account_id, native_id, product) DO UPDATE SET net_qty = positions.net_qty + excluded.net_qty`,
          [accountId, p.symbol.nativeId, p.instrumentId, p.symbol.tradingSymbol, p.symbol.exchange, p.product, p.netQty,
            p.avgPricePaise, p.lastPricePaise, p.pnlPaise, now],
        );
      }
    });
  }

  async list(accountIds: readonly string[]): Promise<StoredPosition[]> {
    if (accountIds.length === 0) return [];
    const rows = await this.db.query<Record<string, unknown>>(
      'SELECT * FROM positions WHERE broker_account_id = ANY($1) ORDER BY broker_account_id, trading_symbol',
      [accountIds],
    );
    return rows.map((r) => ({
      accountId: r['broker_account_id'] as string,
      instrumentId: (r['instrument_id'] as string | null) ?? null,
      symbol: { nativeId: r['native_id'] as string, tradingSymbol: r['trading_symbol'] as string, exchange: r['exchange'] as string },
      product: r['product'] as BrokerPosition['product'],
      netQty: r['net_qty'] as number,
      avgPricePaise: (r['avg_price_paise'] as number | null) ?? null,
      lastPricePaise: (r['last_price_paise'] as number | null) ?? null,
      pnlPaise: (r['pnl_paise'] as number | null) ?? null,
      syncedAt: r['synced_at'] as Date,
    }));
  }
}
