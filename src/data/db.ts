import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/** Each entry upgrades the schema by one version (tracked in `PRAGMA user_version`). */
export const MIGRATIONS = [
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
  // Mobile + OTP sign-in: users may have a phone instead of an email and password.
  `
  CREATE TABLE users_new (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE COLLATE NOCASE,
    phone TEXT UNIQUE,
    password_hash TEXT,
    created_at INTEGER NOT NULL,
    CHECK (email IS NOT NULL OR phone IS NOT NULL)
  );
  INSERT INTO users_new (id, email, phone, password_hash, created_at)
    SELECT id, email, NULL, password_hash, created_at FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;
  CREATE TABLE otp_requests (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    ip TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    verified_at INTEGER,
    allow_signup INTEGER NOT NULL
  );
  CREATE INDEX otp_requests_phone ON otp_requests(phone, created_at DESC);
  CREATE INDEX otp_requests_ip ON otp_requests(ip, created_at DESC);
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

/**
 * Applies the [migrations] the database hasn't seen yet, each in its own transaction.
 * Foreign keys are off meanwhile so a table can be rebuilt (create, copy, drop,
 * rename) without cascading deletes; each migration must still leave them valid.
 */
export function migrate(db: Db, migrations: readonly string[] = MIGRATIONS) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const { foreign_keys: foreignKeys } = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (let v = version; v < migrations.length; v++) {
      db.exec('BEGIN');
      try {
        db.exec(migrations[v]!);
        if (db.prepare('PRAGMA foreign_key_check').all().length) {
          throw new Error(`Migration ${v + 1} leaves rows pointing at missing parents.`);
        }
        db.exec(`PRAGMA user_version = ${v + 1}`);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  } finally {
    if (foreignKeys) db.exec('PRAGMA foreign_keys = ON');
  }
}
