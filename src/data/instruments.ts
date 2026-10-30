import type { BrokerInstrument } from '../brokers/adapter.ts';
import { instrumentId, type BrokerSymbol, type Instrument } from '../domain/instrument.ts';
import type { Db } from './db.ts';

type Row = Record<string, unknown>;

const isoDay = (d: unknown): string | null => {
  if (d === null || d === undefined) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
};

const toInstrument = (r: Row): Instrument => ({
  id: r['id'] as string,
  exchange: r['exchange'] as Instrument['exchange'],
  type: r['type'] as Instrument['type'],
  underlying: r['underlying'] as string,
  expiry: isoDay(r['expiry']),
  strikePaise: (r['strike_paise'] as number | null) ?? null,
  lotSize: r['lot_size'] as number,
  tickPaise: r['tick_paise'] as number,
});

export interface InstrumentSearch {
  underlying?: string | undefined;
  type?: string | undefined;
  expiry?: string | undefined;
  exchange?: string | undefined;
  limit: number;
}

/** The instrument master and each broker's name for every instrument. */
export class InstrumentRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async find(id: string): Promise<Instrument | null> {
    const [row] = await this.db.query('SELECT * FROM instruments WHERE id = $1', [id]);
    return row ? toInstrument(row) : null;
  }

  async search(q: InstrumentSearch): Promise<Instrument[]> {
    const rows = await this.db.query(
      `SELECT * FROM instruments
        WHERE ($1::text IS NULL OR underlying = upper($1))
          AND ($2::text IS NULL OR type = $2)
          AND ($3::date IS NULL OR expiry = $3::date)
          AND ($4::text IS NULL OR exchange = $4)
        ORDER BY underlying, expiry NULLS FIRST, strike_paise NULLS FIRST, type LIMIT $5`,
      [q.underlying ?? null, q.type ?? null, q.expiry ?? null, q.exchange ?? null, q.limit],
    );
    return rows.map(toInstrument);
  }

  /** How [broker] names [instrumentId], or null when it has no mapping (the order is then refused). */
  async mapping(instrumentId: string, broker: string): Promise<BrokerSymbol | null> {
    const [row] = await this.db.query<{ native_id: string; trading_symbol: string; broker_exchange: string }>(
      'SELECT native_id, trading_symbol, broker_exchange FROM instrument_mappings WHERE instrument_id = $1 AND broker = $2',
      [instrumentId, broker],
    );
    return row ? { nativeId: row.native_id, tradingSymbol: row.trading_symbol, exchange: row.broker_exchange } : null;
  }

  /** The canonical instrument a broker's native id stands for. */
  async byNativeId(broker: string, nativeId: string): Promise<string | null> {
    const [row] = await this.db.query<{ instrument_id: string }>(
      'SELECT instrument_id FROM instrument_mappings WHERE broker = $1 AND native_id = $2',
      [broker, nativeId],
    );
    return row?.instrument_id ?? null;
  }

  /**
   * Upserts [rows] from one broker's master. Instruments are keyed by their
   * canonical id, so the same contract from several brokers becomes one row
   * with one mapping per broker. Returns how many rows were written.
   */
  async upsertFromBroker(broker: string, rows: readonly BrokerInstrument[], now: Date): Promise<number> {
    const BATCH = 500;
    let written = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      await this.db.transaction(async (tx) => {
        for (const r of chunk) {
          const id = instrumentId(r);
          await tx.query(
            `INSERT INTO instruments (id, exchange, type, underlying, expiry, strike_paise, lot_size, tick_paise, refreshed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET lot_size = excluded.lot_size, tick_paise = excluded.tick_paise, refreshed_at = excluded.refreshed_at`,
            [id, r.exchange, r.type, r.underlying.toUpperCase(), r.expiry, r.strikePaise, r.lotSize, r.tickPaise, now],
          );
          await tx.query(
            `INSERT INTO instrument_mappings (instrument_id, broker, native_id, trading_symbol, broker_exchange, refreshed_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (instrument_id, broker) DO UPDATE SET native_id = excluded.native_id,
               trading_symbol = excluded.trading_symbol, broker_exchange = excluded.broker_exchange, refreshed_at = excluded.refreshed_at`,
            [id, broker, r.symbol.nativeId, r.symbol.tradingSymbol, r.symbol.exchange, now],
          );
          written++;
        }
      });
    }
    return written;
  }

  /** Drops [broker]'s mappings not refreshed since [before] (delisted or expired contracts). */
  async pruneMappings(broker: string, before: Date): Promise<void> {
    await this.db.query('DELETE FROM instrument_mappings WHERE broker = $1 AND refreshed_at < $2', [broker, before]);
  }
}
