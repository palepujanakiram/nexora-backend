import type { Db } from './db.ts';

/** One OTP sent by SMS. MSG91 holds the code itself; we track limits and attempts. */
export interface OtpRequest {
  id: string;
  /** `91XXXXXXXXXX`. */
  phone: string;
  /** The client IP that asked for it. */
  ip: string;
  createdAt: Date;
  expiresAt: Date;
  /** Wrong (or any) codes tried so far. */
  attempts: number;
  verifiedAt: Date | null;
  /** The number had no user and the right invite code was given: verifying creates the user. */
  allowSignup: boolean;
}

interface OtpRow {
  id: string;
  phone: string;
  ip: string;
  created_at: number;
  expires_at: number;
  attempts: number;
  verified_at: number | null;
  allow_signup: number;
}

const toRequest = (r: OtpRow): OtpRequest => ({
  id: r.id,
  phone: r.phone,
  ip: r.ip,
  createdAt: new Date(r.created_at),
  expiresAt: new Date(r.expires_at),
  attempts: r.attempts,
  verifiedAt: r.verified_at === null ? null : new Date(r.verified_at),
  allowSignup: r.allow_signup === 1,
});

/** OTPs sent for mobile sign-in, kept a day for rate limiting. */
export class OtpRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(request: OtpRequest): void {
    this.db
      .prepare(
        `INSERT INTO otp_requests (id, phone, ip, created_at, expires_at, attempts, verified_at, allow_signup)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.phone,
        request.ip,
        request.createdAt.getTime(),
        request.expiresAt.getTime(),
        request.attempts,
        request.verifiedAt?.getTime() ?? null,
        request.allowSignup ? 1 : 0,
      );
  }

  /** The most recent OTP sent to [phone]. */
  latest(phone: string): OtpRequest | null {
    const row = this.db
      .prepare('SELECT * FROM otp_requests WHERE phone = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(phone) as OtpRow | undefined;
    return row ? toRequest(row) : null;
  }

  countForPhoneSince(phone: string, since: Date): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM otp_requests WHERE phone = ? AND created_at > ?')
      .get(phone, since.getTime()) as { n: number };
    return row.n;
  }

  countForIpSince(ip: string, since: Date): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM otp_requests WHERE ip = ? AND created_at > ?')
      .get(ip, since.getTime()) as { n: number };
    return row.n;
  }

  /** Counts one try at the code. Returns the new total. */
  addAttempt(id: string): number {
    const row = this.db
      .prepare('UPDATE otp_requests SET attempts = attempts + 1 WHERE id = ? RETURNING attempts')
      .get(id) as { attempts: number };
    return row.attempts;
  }

  markVerified(id: string, at: Date): void {
    this.db.prepare('UPDATE otp_requests SET verified_at = ? WHERE id = ?').run(at.getTime(), id);
  }

  deleteOlderThan(time: Date): void {
    this.db.prepare('DELETE FROM otp_requests WHERE created_at < ?').run(time.getTime());
  }
}
