import type { Db } from './db.ts';

/** Signs in with an email and password, a mobile number and OTP, or both. */
export interface User {
  id: string;
  email: string | null;
  /** `91XXXXXXXXXX`. */
  phone: string | null;
  createdAt: Date;
}

interface UserRow {
  id: string;
  email: string | null;
  phone: string | null;
  password_hash: string | null;
  created_at: number;
}

const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, phone: r.phone, createdAt: new Date(r.created_at) });

/** People who sign in to the backend. Each owns their broker accounts and activity. */
export class UserRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** [passwordHash] is null for users who sign in only with a mobile number and OTP. */
  create(user: User, passwordHash: string | null): User {
    this.db
      .prepare('INSERT INTO users (id, email, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, user.email, user.phone, passwordHash, user.createdAt.getTime());
    return user;
  }

  /** The user and their password hash, matched case-insensitively. */
  findByEmail(email: string): { user: User; passwordHash: string | null } | null {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
    return row ? { user: toUser(row), passwordHash: row.password_hash } : null;
  }

  /** The user with mobile number [phone] (`91XXXXXXXXXX`). */
  findByPhone(phone: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE phone = ?').get(phone) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  findById(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  /** The user's password hash, or null when they have no password (OTP sign-in only). */
  passwordHash(id: string): string | null {
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id) as
      | { password_hash: string | null }
      | undefined;
    return row?.password_hash ?? null;
  }

  setPassword(id: string, passwordHash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  }
}

export interface Session {
  userId: string;
  device: string;
  createdAt: Date;
  expiresAt: Date;
}

interface SessionRow {
  user_id: string;
  device: string;
  created_at: number;
  expires_at: number;
}

/** Signed-in app devices. Stores only a hash of each bearer token. */
export class SessionRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(tokenHash: string, session: Session): void {
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, device, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(tokenHash, session.userId, session.device, session.createdAt.getTime(), session.expiresAt.getTime());
  }

  find(tokenHash: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as SessionRow | undefined;
    if (!row) return null;
    return {
      userId: row.user_id,
      device: row.device,
      createdAt: new Date(row.created_at),
      expiresAt: new Date(row.expires_at),
    };
  }

  delete(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  /** Signs the user out everywhere (e.g. after a password change). */
  deleteForUser(userId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  deleteExpired(now: Date): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.getTime());
  }
}
