import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/** Each entry upgrades the schema by one version (tracked in `PRAGMA user_version`). */
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    broker TEXT NOT NULL,
    label TEXT NOT NULL,
    api_key TEXT NOT NULL,
    api_secret TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    access_token TEXT,
    token_issued_at INTEGER,
    enabled INTEGER NOT NULL,
    lots INTEGER NOT NULL,
    product TEXT NOT NULL,
    paper_mode INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX accounts_user ON accounts(user_id);
  CREATE TABLE executions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    account_label TEXT NOT NULL,
    broker TEXT NOT NULL,
    signal_text TEXT NOT NULL,
    signal_key TEXT NOT NULL,
    paper INTEGER NOT NULL,
    time INTEGER NOT NULL,
    symbol TEXT,
    quantity INTEGER,
    entry_price REAL,
    orders TEXT NOT NULL,
    error TEXT,
    error_code TEXT
  );
  CREATE INDEX executions_user_time ON executions(user_id, time DESC);
  CREATE INDEX executions_account_signal ON executions(account_id, signal_key, time DESC);
  `,
];

/** Opens (creating if needed) the SQLite database at [path] and migrates it. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

/** Applies the [migrations] the database hasn't seen yet, each in its own transaction. */
export function migrate(db: Db, migrations: readonly string[] = MIGRATIONS) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = version; v < migrations.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
