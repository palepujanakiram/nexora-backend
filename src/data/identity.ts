import type { Db, Queryable } from './db.ts';

export interface User {
  id: string;
  /** `91XXXXXXXXXX`. */
  phone: string;
  email: string | null;
  status: 'active' | 'disabled';
  createdAt: Date;
}

export const CLIENT_PLATFORMS = ['web', 'ios', 'android', 'partner', 'other'] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];
export const GRANT_TYPES = ['otp', 'refresh_token'] as const;
export type GrantType = (typeof GRANT_TYPES)[number];

/** A registered front end with its own token policy. */
export interface Client {
  id: string;
  name: string;
  platform: ClientPlatform;
  grantTypes: GrantType[];
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  createdAt: Date;
}

/** One signed-in device. */
export interface Session {
  id: string;
  userId: string;
  clientId: string;
  device: string;
  ip: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

export interface OtpCode {
  id: string;
  phone: string;
  ip: string;
  codeHash: string;
  createdAt: Date;
  expiresAt: Date;
  attempts: number;
  usedAt: Date | null;
}

type Row = Record<string, unknown>;

const toUser = (r: Row): User => ({
  id: r['id'] as string,
  phone: r['phone'] as string,
  email: (r['email'] as string | null) ?? null,
  status: r['status'] as User['status'],
  createdAt: r['created_at'] as Date,
});

const toClient = (r: Row): Client => ({
  id: r['id'] as string,
  name: r['name'] as string,
  platform: r['platform'] as ClientPlatform,
  grantTypes: r['grant_types'] as GrantType[],
  accessTtlSeconds: r['access_ttl_seconds'] as number,
  refreshTtlSeconds: r['refresh_ttl_seconds'] as number,
  createdAt: r['created_at'] as Date,
});

const toSession = (r: Row): Session => ({
  id: r['id'] as string,
  userId: r['user_id'] as string,
  clientId: r['client_id'] as string,
  device: r['device'] as string,
  ip: r['ip'] as string,
  createdAt: r['created_at'] as Date,
  lastUsedAt: r['last_used_at'] as Date,
  expiresAt: r['expires_at'] as Date,
  revokedAt: (r['revoked_at'] as Date | null) ?? null,
  revokedReason: (r['revoked_reason'] as string | null) ?? null,
});

const toOtp = (r: Row): OtpCode => ({
  id: r['id'] as string,
  phone: r['phone'] as string,
  ip: r['ip'] as string,
  codeHash: r['code_hash'] as string,
  createdAt: r['created_at'] as Date,
  expiresAt: r['expires_at'] as Date,
  attempts: r['attempts'] as number,
  usedAt: (r['used_at'] as Date | null) ?? null,
});

/** Users, clients, sessions, refresh tokens and OTP codes: the identity module's tables. */
export class IdentityRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async createUser(u: User): Promise<User> {
    await this.db.query('INSERT INTO users (id, phone, email, status, created_at) VALUES ($1, $2, $3, $4, $5)', [
      u.id, u.phone, u.email, u.status, u.createdAt,
    ]);
    return u;
  }

  async userByPhone(phone: string): Promise<User | null> {
    const [row] = await this.db.query('SELECT * FROM users WHERE phone = $1', [phone]);
    return row ? toUser(row) : null;
  }

  async userByEmail(email: string): Promise<User | null> {
    const [row] = await this.db.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    return row ? toUser(row) : null;
  }

  async user(id: string): Promise<User | null> {
    const [row] = await this.db.query('SELECT * FROM users WHERE id = $1', [id]);
    return row ? toUser(row) : null;
  }

  async createClient(c: Client): Promise<Client> {
    await this.db.query(
      `INSERT INTO clients (id, name, platform, grant_types, access_ttl_seconds, refresh_ttl_seconds, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [c.id, c.name, c.platform, c.grantTypes, c.accessTtlSeconds, c.refreshTtlSeconds, c.createdAt],
    );
    return c;
  }

  async client(id: string): Promise<Client | null> {
    const [row] = await this.db.query('SELECT * FROM clients WHERE id = $1', [id]);
    return row ? toClient(row) : null;
  }

  async clients(): Promise<Client[]> {
    return (await this.db.query('SELECT * FROM clients ORDER BY created_at, id')).map(toClient);
  }

  /** Creates the session and its first refresh token together. */
  async createSession(s: Session, refreshHash: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO sessions (id, user_id, client_id, device, ip, created_at, last_used_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [s.id, s.userId, s.clientId, s.device, s.ip, s.createdAt, s.lastUsedAt, s.expiresAt],
      );
      await tx.query('INSERT INTO refresh_tokens (token_hash, session_id, created_at) VALUES ($1, $2, $3)', [refreshHash, s.id, s.createdAt]);
    });
  }

  async session(id: string): Promise<Session | null> {
    const [row] = await this.db.query('SELECT * FROM sessions WHERE id = $1', [id]);
    return row ? toSession(row) : null;
  }

  /** The user's sessions that are neither revoked nor expired, newest first. */
  async activeSessions(userId: string, now: Date): Promise<Session[]> {
    const rows = await this.db.query(
      'SELECT * FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2 ORDER BY last_used_at DESC',
      [userId, now],
    );
    return rows.map(toSession);
  }

  /**
   * Swaps refresh token [oldHash] for [newHash] in one transaction. Returns
   * the session, `'reused'` if the old token was already spent (the caller
   * revokes the session), or null if the token is unknown.
   */
  async rotateRefresh(oldHash: string, newHash: string, now: Date, expiresAt: (s: Session) => Date): Promise<Session | 'reused' | null> {
    return this.db.transaction(async (tx) => {
      const [token] = await tx.query<{ session_id: string; used_at: Date | null }>(
        'SELECT session_id, used_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
        [oldHash],
      );
      if (!token) return null;
      const [row] = await tx.query('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [token.session_id]);
      const session = toSession(row!);
      if (token.used_at) return 'reused';
      // Revoked or expired: returned unchanged for the caller to refuse.
      if (session.revokedAt || session.expiresAt <= now) return session;
      const nextExpiry = expiresAt(session);
      await tx.query('UPDATE refresh_tokens SET used_at = $2 WHERE token_hash = $1', [oldHash, now]);
      await tx.query('INSERT INTO refresh_tokens (token_hash, session_id, created_at) VALUES ($1, $2, $3)', [newHash, session.id, now]);
      await tx.query('UPDATE sessions SET last_used_at = $2, expires_at = $3 WHERE id = $1', [session.id, now, nextExpiry]);
      return { ...session, lastUsedAt: now, expiresAt: nextExpiry };
    });
  }

  /** The session a refresh token belongs to, spent or not. */
  async sessionOfRefresh(hash: string): Promise<Session | null> {
    const [row] = await this.db.query(
      'SELECT s.* FROM refresh_tokens t JOIN sessions s ON s.id = t.session_id WHERE t.token_hash = $1',
      [hash],
    );
    return row ? toSession(row) : null;
  }

  async revokeSession(id: string, now: Date, reason: string, q: Queryable = this.db): Promise<boolean> {
    const rows = await q.query('UPDATE sessions SET revoked_at = $2, revoked_reason = $3 WHERE id = $1 AND revoked_at IS NULL RETURNING id', [
      id, now, reason,
    ]);
    return rows.length > 0;
  }

  async createOtp(o: OtpCode): Promise<void> {
    await this.db.query(
      'INSERT INTO otp_codes (id, phone, ip, code_hash, created_at, expires_at, attempts) VALUES ($1, $2, $3, $4, $5, $6, 0)',
      [o.id, o.phone, o.ip, o.codeHash, o.createdAt, o.expiresAt],
    );
  }

  async latestOtp(phone: string): Promise<OtpCode | null> {
    const [row] = await this.db.query('SELECT * FROM otp_codes WHERE phone = $1 ORDER BY seq DESC LIMIT 1', [phone]);
    return row ? toOtp(row) : null;
  }

  /** When codes were sent to [phone] (or asked for from [ip]) after [since], oldest first. */
  async otpTimes(by: 'phone' | 'ip', key: string, since: Date): Promise<Date[]> {
    const column = by === 'phone' ? 'phone' : 'ip';
    const rows = await this.db.query<{ created_at: Date }>(
      `SELECT created_at FROM otp_codes WHERE ${column} = $1 AND created_at > $2 ORDER BY created_at`,
      [key, since],
    );
    return rows.map((r) => r.created_at);
  }

  /** Counts one try at the code and returns the new total. */
  async addOtpAttempt(id: string): Promise<number> {
    const [row] = await this.db.query<{ attempts: number }>('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts', [id]);
    return row!.attempts;
  }

  /** Marks the code used. False if it was already used (two verifies racing). */
  async useOtp(id: string, now: Date): Promise<boolean> {
    const rows = await this.db.query('UPDATE otp_codes SET used_at = $2 WHERE id = $1 AND used_at IS NULL RETURNING id', [id, now]);
    return rows.length > 0;
  }

  async deleteOtpsBefore(time: Date): Promise<void> {
    await this.db.query('DELETE FROM otp_codes WHERE created_at < $1', [time]);
  }
}
