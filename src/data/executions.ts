import type { PlacedOrder } from '../domain/trade.ts';
import type { Db } from './db.ts';

/** Outcome of executing one signal on one account. */
export interface Execution {
  id: string;
  userId: string;
  accountId: string;
  accountLabel: string;
  /** Broker label, e.g. "Upstox". */
  broker: string;
  signalText: string;
  /** Hash of the normalised signal text, used to spot repeats. */
  signalKey: string;
  paper: boolean;
  time: Date;
  symbol: string | null;
  quantity: number | null;
  entryPrice: number | null;
  orders: PlacedOrder[];
  error: string | null;
  /** Machine-readable reason for some errors: `duplicate` or `in_flight`. */
  errorCode: string | null;
}

interface ExecutionRow {
  id: string;
  user_id: string;
  account_id: string;
  account_label: string;
  broker: string;
  signal_text: string;
  signal_key: string;
  paper: number;
  time: number;
  symbol: string | null;
  quantity: number | null;
  entry_price: number | null;
  orders: string;
  error: string | null;
  error_code: string | null;
}

const toExecution = (r: ExecutionRow): Execution => ({
  id: r.id,
  userId: r.user_id,
  accountId: r.account_id,
  accountLabel: r.account_label,
  broker: r.broker,
  signalText: r.signal_text,
  signalKey: r.signal_key,
  paper: r.paper === 1,
  time: new Date(r.time),
  symbol: r.symbol,
  quantity: r.quantity,
  entryPrice: r.entry_price,
  orders: JSON.parse(r.orders) as PlacedOrder[],
  error: r.error,
  errorCode: r.error_code,
});

/** The activity log every device of a user shares. */
export class ExecutionRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  addAll(executions: Execution[]): void {
    const insert = this.db.prepare(
      `INSERT INTO executions
        (id, user_id, account_id, account_label, broker, signal_text, signal_key, paper, time,
         symbol, quantity, entry_price, orders, error, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of executions) {
      insert.run(
        e.id,
        e.userId,
        e.accountId,
        e.accountLabel,
        e.broker,
        e.signalText,
        e.signalKey,
        e.paper ? 1 : 0,
        e.time.getTime(),
        e.symbol,
        e.quantity,
        e.entryPrice,
        JSON.stringify(e.orders),
        e.error,
        e.errorCode,
      );
    }
  }

  /** Newest first. */
  list(userId: string, limit: number): Execution[] {
    const rows = this.db
      .prepare('SELECT * FROM executions WHERE user_id = ? ORDER BY time DESC, rowid DESC LIMIT ?')
      .all(userId, limit) as unknown as ExecutionRow[];
    return rows.map(toExecution);
  }

  /** The latest successful execution of this signal on this account since [since], if any. */
  findRecentSuccess(accountId: string, signalKey: string, since: Date): Execution | null {
    const row = this.db
      .prepare(
        `SELECT * FROM executions WHERE account_id = ? AND signal_key = ? AND time >= ? AND error IS NULL
         ORDER BY time DESC LIMIT 1`,
      )
      .get(accountId, signalKey, since.getTime()) as ExecutionRow | undefined;
    return row ? toExecution(row) : null;
  }

  clear(userId: string): void {
    this.db.prepare('DELETE FROM executions WHERE user_id = ?').run(userId);
  }
}
