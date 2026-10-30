import type { PGliteInterface } from '@electric-sql/pglite';
import pg from 'pg';

import { MIGRATIONS } from './schema.ts';

/** Something SQL can run on: the pool, or one transaction. */
export interface Queryable {
  /** Runs [sql] with `$1`-style [params] and returns the rows. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs one or more statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
}

/** The Postgres database. Production uses a `pg` pool; tests use PGlite (Postgres in-process). */
export interface Db extends Queryable {
  /** Runs [fn] in one transaction: committed when it returns, rolled back when it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /**
   * Runs [fn] while holding the lock named [key], across every process that
   * shares the database (a Postgres advisory lock), waiting up to [waitMs].
   * Returns null when the lock stays taken that long.
   */
  withLock<T>(key: string, waitMs: number, fn: () => Promise<T>): Promise<{ value: T } | null>;
  close(): Promise<void>;
}

/** A row as the driver returns it; repositories map it to typed records. */
type Row = Record<string, unknown>;

const INT8 = 20;
const DATE = 1082;
/** Counts and paise are int8 (every value fits a JS number); dates stay `YYYY-MM-DD` strings, free of time zones. */
const PARSERS: Record<number, (value: string) => unknown> = { [INT8]: Number, [DATE]: (v) => v };

/** Postgres through a `pg` connection pool. */
export class PgDb implements Db {
  private readonly pool: pg.Pool;
  /**
   * Advisory locks are held by a session for as long as the locked work runs,
   * and that work queries [pool]. Taking lock sessions from a separate pool
   * means lock holders can never exhaust the connections their own work needs.
   */
  private readonly lockPool: pg.Pool;
  private readonly local = new LocalLocks();

  constructor(connectionString: string, max = 10, maxLocks = 10) {
    const types = new pg.TypeOverrides();
    types.setTypeParser(pg.types.builtins.INT8, Number);
    types.setTypeParser(pg.types.builtins.DATE, (v: string) => v);
    this.pool = new pg.Pool({ connectionString, max, types });
    this.lockPool = new pg.Pool({ connectionString, max: maxLocks, types });
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return (await this.pool.query<Row>(sql, [...params])).rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn({
        query: async <R>(sql: string, params: readonly unknown[] = []) => (await client.query<Row>(sql, [...params])).rows as R[],
        exec: async (sql: string) => {
          await client.query(sql);
        },
      });
      await client.query('COMMIT');
      return value;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async withLock<T>(key: string, waitMs: number, fn: () => Promise<T>): Promise<{ value: T } | null> {
    // The in-process lock queues callers here; the advisory lock covers other processes.
    return this.local.run(key, waitMs, async () => {
      const client = await this.lockPool.connect();
      try {
        const deadline = Date.now() + waitMs;
        for (;;) {
          const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [key]);
          if (rows[0]?.ok === true) break;
          if (Date.now() >= deadline) return null;
          await new Promise((r) => setTimeout(r, 50));
        }
        try {
          return { value: await fn() };
        } finally {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
        }
      } finally {
        client.release();
      }
    });
  }

  async close(): Promise<void> {
    await Promise.all([this.pool.end(), this.lockPool.end()]);
  }
}

/**
 * Postgres in-process (PGlite): tests and local development. One connection,
 * so locks are in-process. Parsers go with every query because clones of a
 * PGlite instance don't keep them.
 */
export class PgliteDb implements Db {
  readonly pg: PGliteInterface;
  private readonly local = new LocalLocks();

  constructor(pglite: PGliteInterface) {
    this.pg = pglite;
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return (await this.pg.query<T>(sql, [...params], { parsers: PARSERS })).rows;
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx) =>
      fn({
        query: async <R>(sql: string, params: readonly unknown[] = []) => (await tx.query<R>(sql, [...params], { parsers: PARSERS })).rows,
        exec: async (sql: string) => {
          await tx.exec(sql);
        },
      }),
    );
  }

  async withLock<T>(key: string, waitMs: number, fn: () => Promise<T>): Promise<{ value: T } | null> {
    return this.local.run(key, waitMs, async () => ({ value: await fn() }));
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

/** Named mutexes within this process, with a bounded wait. */
export class LocalLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, waitMs: number, fn: () => Promise<T | null>): Promise<T | null> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = previous.then(async () => mine);
    this.tails.set(key, tail);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((r) => (timer = setTimeout(() => { r('timeout'); }, waitMs)));
    try {
      if ((await Promise.race([previous.then(() => 'ok' as const), timedOut])) === 'timeout') return null;
      return await fn();
    } finally {
      clearTimeout(timer);
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/** Opens Postgres at [url] and applies pending migrations. */
export async function openDb(url: string): Promise<Db> {
  const db = new PgDb(url);
  await migrate(db);
  return db;
}

/** Opens an in-process Postgres (PGlite), in memory or at a data directory, and migrates it. */
export async function openPglite(dataDir?: string): Promise<PgliteDb> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PgliteDb(await PGlite.create({ ...(dataDir ? { dataDir } : {}), parsers: PARSERS }));
  await migrate(db);
  return db;
}

/**
 * Applies the [migrations] the database hasn't seen yet, each in its own
 * transaction, under an advisory lock so two machines starting together don't
 * both run them.
 */
export async function migrate(db: Db, migrations: readonly string[] = MIGRATIONS): Promise<number> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const result = await db.withLock('migrations', 60_000, async () => {
    const [row] = await db.query<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
    const current = row?.v ?? 0;
    for (const [i, sql] of migrations.slice(current).entries()) {
      await db.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [current + i + 1]);
      });
    }
    return migrations.length - current;
  });
  if (!result) throw new Error('Another process held the migrations lock for 60 s; not starting.');
  return result.value;
}
