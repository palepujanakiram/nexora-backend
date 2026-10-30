import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

import { unauthorized } from '../domain/errors.ts';

/**
 * Access-token claims. Identity only: never entitlements or subscription
 * status, which change mid-session.
 */
export interface AccessClaims {
  iss: string;
  /** User id. */
  sub: string;
  /** Client id. */
  aud: string;
  /** Session id. */
  sid: string;
  iat: number;
  exp: number;
}

export interface PublicKeyEntry {
  kid: string;
  pem: string;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

/**
 * Short-lived EdDSA (Ed25519) JWTs, verifiable by any service from the
 * public keys at `/.well-known/jwks.json` without calling identity.
 * Rotate by making a new key current and listing the old public key in
 * [previous] until the longest access token TTL has passed.
 */
export class TokenSigner {
  private readonly privateKey: KeyObject;
  private readonly kid: string;
  private readonly issuer: string;
  private readonly publicKeys: Map<string, KeyObject>;
  private readonly clock: () => Date;

  constructor(args: { privateKeyPem: string; kid: string; issuer: string; previous: readonly PublicKeyEntry[]; clock: () => Date }) {
    this.privateKey = createPrivateKey(args.privateKeyPem);
    if (this.privateKey.asymmetricKeyType !== 'ed25519') throw new Error('JWT_PRIVATE_KEY must be an Ed25519 private key (PEM).');
    this.kid = args.kid;
    this.issuer = args.issuer;
    this.clock = args.clock;
    this.publicKeys = new Map([[args.kid, createPublicKey(this.privateKey)], ...args.previous.map((p) => [p.kid, createPublicKey(p.pem)] as const)]);
  }

  sign(claims: Omit<AccessClaims, 'iss' | 'iat' | 'exp'>, ttlSeconds: number): { token: string; expiresAt: Date } {
    const iat = Math.floor(this.clock().getTime() / 1000);
    const payload: AccessClaims = { iss: this.issuer, ...claims, iat, exp: iat + ttlSeconds };
    const head = `${b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: this.kid }))}.${b64url(JSON.stringify(payload))}`;
    const signature = sign(null, Buffer.from(head), this.privateKey);
    return { token: `${head}.${b64url(signature)}`, expiresAt: new Date(payload.exp * 1000) };
  }

  /** The claims of a valid, unexpired token from this issuer. Throws 401 otherwise. */
  verify(token: string): AccessClaims {
    const parts = token.split('.');
    if (parts.length !== 3) throw unauthorized('Invalid access token.');
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let claims: AccessClaims;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      throw unauthorized('Invalid access token.');
    }
    const key = header.kid ? this.publicKeys.get(header.kid) : undefined;
    if (header.alg !== 'EdDSA' || !key || !verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) {
      throw unauthorized('Invalid access token.');
    }
    if (claims.iss !== this.issuer) throw unauthorized('Invalid access token.');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= this.clock().getTime()) {
      throw unauthorized('Your access token has expired. Refresh it.');
    }
    return claims;
  }

  /** The JSON Web Key Set for local verification elsewhere. */
  jwks(): { keys: Record<string, unknown>[] } {
    return {
      keys: [...this.publicKeys].map(([kid, key]) => ({ ...key.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' })),
    };
  }
}
