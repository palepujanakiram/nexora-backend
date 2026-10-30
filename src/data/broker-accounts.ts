import type { Db } from './db.ts';
import { single } from '../domain/invariant.ts';

export type AccountMode = 'paper' | 'live';
export type TokenState = 'none' | 'valid' | 'expired' | 'needs_user_action';

/** A linked broker account as stored: credentials and token are still ciphertext. */
export interface BrokerAccountRecord {
  id: string;
  userId: string;
  broker: string;
  label: string;
  mode: AccountMode;
  credentialsEnc: string;
  tokenEnc: string | null;
  tokenExpiresAt: Date | null;
  tokenState: TokenState;
  tokenMessage: string | null;
  lastAuthAt: Date | null;
  createdAt: Date;
}

type Row = Record<string, unknown>;

const toRecord = (r: Row): BrokerAccountRecord => ({
  id: r['id'] as string,
  userId: r['user_id'] as string,
  broker: r['broker'] as string,
  label: r['label'] as string,
  mode: r['mode'] as AccountMode,
  credentialsEnc: r['credentials_enc'] as string,
  tokenEnc: (r['token_enc'] as string | null) ?? null,
  tokenExpiresAt: (r['token_expires_at'] as Date | null) ?? null,
  tokenState: r['token_state'] as TokenState,
  tokenMessage: (r['token_message'] as string | null) ?? null,
  lastAuthAt: (r['last_auth_at'] as Date | null) ?? null,
  createdAt: r['created_at'] as Date,
});

/** Linked broker accounts. Only the broker gateway reads these rows, since only it can decrypt them. */
export class BrokerAccountRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async insert(a: BrokerAccountRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO broker_accounts (id, user_id, broker, label, mode, credentials_enc, token_enc, token_expires_at,
         token_state, token_message, last_auth_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [a.id, a.userId, a.broker, a.label, a.mode, a.credentialsEnc, a.tokenEnc, a.tokenExpiresAt, a.tokenState, a.tokenMessage, a.lastAuthAt, a.createdAt],
    );
  }

  async find(id: string): Promise<BrokerAccountRecord | null> {
    const [row] = await this.db.query('SELECT * FROM broker_accounts WHERE id = $1', [id]);
    return row ? toRecord(row) : null;
  }

  /** The account, only if [userId] owns it. */
  async findOwned(userId: string, id: string): Promise<BrokerAccountRecord | null> {
    const [row] = await this.db.query('SELECT * FROM broker_accounts WHERE id = $1 AND user_id = $2', [id, userId]);
    return row ? toRecord(row) : null;
  }

  async listForUser(userId: string): Promise<BrokerAccountRecord[]> {
    return (await this.db.query('SELECT * FROM broker_accounts WHERE user_id = $1 ORDER BY created_at, id', [userId])).map(toRecord);
  }

  async listAll(): Promise<BrokerAccountRecord[]> {
    return (await this.db.query('SELECT * FROM broker_accounts ORDER BY created_at, id')).map(toRecord);
  }

  async countForUser(userId: string): Promise<number> {
    const rows = await this.db.query<{ n: number }>('SELECT count(*) AS n FROM broker_accounts WHERE user_id = $1', [userId]);
    return single(rows, 'a count').n;
  }

  async saveToken(id: string, t: { tokenEnc: string | null; expiresAt: Date | null; state: TokenState; message: string | null; authAt: Date | null }): Promise<void> {
    await this.db.query(
      `UPDATE broker_accounts SET token_enc = $2, token_expires_at = $3, token_state = $4, token_message = $5,
         last_auth_at = coalesce($6, last_auth_at) WHERE id = $1`,
      [id, t.tokenEnc, t.expiresAt, t.state, t.message, t.authAt],
    );
  }

  async setTokenState(id: string, state: TokenState, message: string | null): Promise<void> {
    await this.db.query('UPDATE broker_accounts SET token_state = $2, token_message = $3 WHERE id = $1', [id, state, message]);
  }

  async saveCredentials(id: string, credentialsEnc: string, tokenEnc: string | null): Promise<void> {
    await this.db.query('UPDATE broker_accounts SET credentials_enc = $2, token_enc = $3 WHERE id = $1', [id, credentialsEnc, tokenEnc]);
  }

  async setMode(id: string, mode: AccountMode): Promise<void> {
    await this.db.query('UPDATE broker_accounts SET mode = $2 WHERE id = $1', [id, mode]);
  }

  /** Unlinks the account: the row, and with it every stored credential, is deleted. */
  async delete(userId: string, id: string): Promise<boolean> {
    return (await this.db.query('DELETE FROM broker_accounts WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId])).length > 0;
  }
}
