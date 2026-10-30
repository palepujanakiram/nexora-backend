import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { TokenSigner } from '../../src/usecases/tokens.ts';
import { JWT_PRIVATE_KEY, testClock } from '../app.ts';
import { NOW } from '../helpers.ts';

const claims = { sub: 'usr_1', aud: 'cl_1', sid: 'ses_1' };
const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

function signer(over: Partial<ConstructorParameters<typeof TokenSigner>[0]> = {}) {
  const clock = testClock();
  return { clock, signer: new TokenSigner({ privateKeyPem: JWT_PRIVATE_KEY, kid: 'k1', issuer: 'nexora', previous: [], clock, ...over }) };
}

const newKey = () => generateKeyPairSync('ed25519');

describe('TokenSigner', () => {
  it('signs and verifies its own tokens', () => {
    const { signer: s } = signer();
    const { token, expiresAt } = s.sign(claims, 900);
    expect(expiresAt).toEqual(new Date(NOW.getTime() + 900_000));
    const iat = NOW.getTime() / 1000;
    expect(s.verify(token)).toEqual({ iss: 'nexora', ...claims, iat, exp: iat + 900 });
    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());
    expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' });
  });

  it('refuses expired tokens', () => {
    const { signer: s, clock } = signer();
    const { token } = s.sign(claims, 60);
    clock.advance(60_000);
    expect(() => s.verify(token)).toThrow('Your access token has expired. Refresh it.');
  });

  it('refuses tokens from another issuer', () => {
    const { signer: a } = signer({ issuer: 'someone-else' });
    const { signer: b } = signer();
    expect(() => b.verify(a.sign(claims, 60).token)).toThrow('Invalid access token.');
  });

  it('refuses a tampered payload or signature', () => {
    const { signer: s } = signer();
    const [h, p, sig] = s.sign(claims, 60).token.split('.') as [string, string, string];
    const forged = b64url(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'usr_admin' }));
    expect(() => s.verify(`${h}.${forged}.${sig}`)).toThrow('Invalid access token.');
    const flipped = Buffer.from(sig, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => s.verify(`${h}.${p}.${b64url(flipped)}`)).toThrow('Invalid access token.');
  });

  it('refuses malformed tokens', () => {
    const { signer: s } = signer();
    expect(() => s.verify('not-a-jwt')).toThrow('Invalid access token.');
    expect(() => s.verify('a.b.c.d')).toThrow('Invalid access token.');
    expect(() => s.verify(`${b64url('{not json')}.${b64url('{}')}.sig`)).toThrow('Invalid access token.');
  });

  it('refuses unknown key ids, tokens without one, and algorithms other than EdDSA', () => {
    const { signer: s } = signer();
    const [, p, sig] = s.sign(claims, 60).token.split('.') as [string, string, string];
    for (const header of [{ alg: 'EdDSA', kid: 'k9' }, { alg: 'EdDSA' }, { alg: 'HS256', kid: 'k1' }, { alg: 'none', kid: 'k1' }]) {
      expect(() => s.verify(`${b64url(JSON.stringify(header))}.${p}.${sig}`)).toThrow('Invalid access token.');
    }
  });

  it('refuses a validly signed token without a numeric exp', () => {
    const { signer: s } = signer();
    const key = newKey();
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const other = new TokenSigner({ privateKeyPem: pem, kid: 'k1', issuer: 'nexora', previous: [], clock: testClock() });
    const head = `${b64url(JSON.stringify({ alg: 'EdDSA', kid: 'k1' }))}.${b64url(JSON.stringify({ iss: 'nexora', ...claims, exp: 'later' }))}`;
    const token = `${head}.${b64url(sign(null, Buffer.from(head), key.privateKey))}`;
    expect(() => other.verify(token)).toThrow('Your access token has expired. Refresh it.');
    expect(() => s.verify(token)).toThrow('Invalid access token.');
  });

  it('rejects a private key that is not Ed25519', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => signer({ privateKeyPem: rsa })).toThrow('JWT_PRIVATE_KEY must be an Ed25519 private key (PEM).');
  });

  it('still verifies tokens signed with a previous key during rotation', () => {
    const old = newKey();
    const oldSigner = new TokenSigner({
      privateKeyPem: old.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      kid: 'k0',
      issuer: 'nexora',
      previous: [],
      clock: testClock(),
    });
    const oldToken = oldSigner.sign(claims, 600).token;
    const oldPem = old.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const { signer: rotated } = signer({ previous: [{ kid: 'k0', pem: oldPem }] });
    expect(rotated.verify(oldToken)).toMatchObject(claims);
    // Without the old key listed, it's refused.
    expect(() => signer().signer.verify(oldToken)).toThrow('Invalid access token.');
  });

  it('publishes every verification key as a JWKS', () => {
    const old = newKey();
    const { signer: s } = signer({ previous: [{ kid: 'k0', pem: old.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] });
    const { keys } = s.jwks();
    expect(keys.map((k) => k['kid'])).toEqual(['k1', 'k0']);
    for (const k of keys) {
      expect(k).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
      expect(typeof k['x']).toBe('string');
      expect(k['d']).toBeUndefined();
    }
  });
});
