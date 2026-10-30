import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Encrypts broker credentials and session tokens at rest with AES-256-GCM.
 * Each ciphertext names its key version (`v2:<base64 iv|tag|data>`), so keys
 * rotate without a migration: add a new version, make it current, then run
 * the re-encryption job. The keys come from the environment and never touch
 * the database.
 *
 * TODO(KMS): wrap these data keys with AWS KMS / Vault (envelope encryption)
 * instead of reading them from the environment. Only [SecretBox]'s
 * constructor changes.
 */
export class SecretBox {
  private readonly keys: ReadonlyMap<number, Buffer>;
  readonly currentVersion: number;

  constructor(keys: ReadonlyMap<number, Buffer>, currentVersion: number) {
    for (const key of keys.values()) {
      if (key.length !== 32) throw new Error('Encryption keys must be 32 bytes, base64-encoded (openssl rand -base64 32).');
    }
    if (!keys.has(currentVersion)) throw new Error(`No encryption key with version ${currentVersion}.`);
    this.keys = keys;
    this.currentVersion = currentVersion;
  }

  /** From `ENCRYPTION_KEYS` (`1:<base64>,2:<base64>`) or a single `ENCRYPTION_KEY` (version 1). */
  static fromConfig(spec: string, currentVersion: number | null): SecretBox {
    const keys = new Map<number, Buffer>();
    for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
      const m = /^(\d+):(.+)$/.exec(part);
      if (m) keys.set(Number(m[1]), Buffer.from(m[2]!, 'base64'));
      else keys.set(1, Buffer.from(part, 'base64'));
    }
    return new SecretBox(keys, currentVersion ?? Math.max(...keys.keys()));
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.currentVersion)!, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v${this.currentVersion}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
  }

  decrypt(sealed: string): string {
    const m = /^v(\d+):(.*)$/s.exec(sealed);
    const key = m ? this.keys.get(Number(m[1])) : undefined;
    if (!m || !key) throw new Error('Unknown secret format or key version.');
    const raw = Buffer.from(m[2]!, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  /** Whether [sealed] was encrypted with an older key and should be re-encrypted. */
  isStale(sealed: string): boolean {
    return !sealed.startsWith(`v${this.currentVersion}:`);
  }
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export const hmacSha256 = (key: string | Buffer, text: string) => createHmac('sha256', key).update(text).digest('hex');

/** Constant-time comparison of two strings (e.g. secrets, signatures). */
export function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(given)), Buffer.from(sha256(expected)));
}

/** A random id with a type prefix: `po_…`, `leg_…`, `ba_…`. */
export const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url')}`;

/** A random opaque token (refresh tokens). Only its hash is stored. */
export const newToken = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;

/** Letters and digits only, for broker order tags (Kite allows 20). */
export const newClientRef = () => `NX${randomBytes(8).toString('hex').toUpperCase()}`;
