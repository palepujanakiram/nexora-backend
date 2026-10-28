import type { BrokerAccount, BrokerType, ProductType } from '../domain/account.ts';
import type { SecretBox } from './crypto.ts';
import type { Db } from './db.ts';

interface AccountRow {
  id: string;
  user_id: string;
  broker: string;
  label: string;
  api_key: string;
  api_secret: string;
  redirect_uri: string;
  access_token: string | null;
  token_issued_at: number | null;
  enabled: number;
  lots: number;
  product: string;
  paper_mode: number;
  created_at: number;
}

/** Broker accounts. API key, secret and access token are encrypted in the database. */
export class AccountRepository {
  private readonly db: Db;
  private readonly box: SecretBox;

  constructor(db: Db, box: SecretBox) {
    this.db = db;
    this.box = box;
  }

  /** The user's accounts, oldest first. */
  list(userId: string): BrokerAccount[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at, id')
      .all(userId) as unknown as AccountRow[];
    return rows.map((r) => this.toAccount(r));
  }

  /** The account, only if [userId] owns it. */
  find(userId: string, id: string): BrokerAccount | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(id, userId) as
      | AccountRow
      | undefined;
    return row ? this.toAccount(row) : null;
  }

  /** Inserts or replaces by id. */
  save(a: BrokerAccount): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO accounts
          (id, user_id, broker, label, api_key, api_secret, redirect_uri, access_token, token_issued_at,
           enabled, lots, product, paper_mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.userId,
        a.broker,
        a.label,
        this.box.encrypt(a.apiKey),
        this.box.encrypt(a.apiSecret),
        a.redirectUri,
        a.accessToken === null ? null : this.box.encrypt(a.accessToken),
        a.tokenIssuedAt?.getTime() ?? null,
        a.enabled ? 1 : 0,
        a.lots,
        a.product,
        a.paperMode ? 1 : 0,
        a.createdAt.getTime(),
      );
  }

  delete(userId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM accounts WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  private toAccount(r: AccountRow): BrokerAccount {
    return {
      id: r.id,
      userId: r.user_id,
      broker: r.broker as BrokerType,
      label: r.label,
      apiKey: this.box.decrypt(r.api_key),
      apiSecret: this.box.decrypt(r.api_secret),
      redirectUri: r.redirect_uri,
      accessToken: r.access_token === null ? null : this.box.decrypt(r.access_token),
      tokenIssuedAt: r.token_issued_at === null ? null : new Date(r.token_issued_at),
      enabled: r.enabled === 1,
      lots: r.lots,
      product: r.product as ProductType,
      paperMode: r.paper_mode === 1,
      createdAt: new Date(r.created_at),
    };
  }
}
