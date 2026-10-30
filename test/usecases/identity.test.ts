import { describe, expect, it } from 'vitest';

import type { OtpChannel } from '../../src/brokers/msg91.ts';
import { IdentityRepository } from '../../src/data/identity.ts';
import { AppError } from '../../src/domain/errors.ts';
import { DEFAULT_OTP_POLICY, IdentityService } from '../../src/usecases/identity.ts';
import { TokenSigner } from '../../src/usecases/tokens.ts';
import { JWT_PRIVATE_KEY, harness, testClock } from '../app.ts';
import { testDb } from '../db.ts';
import { memoryLog } from '../helpers.ts';

const PHONE = '9876543210';
const IP = '203.0.113.7';

async function world() {
  const h = await harness();
  const s = h.services;
  const user = await s.identity.registerUser({ phone: PHONE, email: 'Ravi@Example.com' });
  const client = await s.identity.registerClient({
    name: '  iOS app ',
    platform: 'ios',
    grantTypes: ['otp', 'refresh_token'],
    accessTtlSeconds: 900,
    refreshTtlSeconds: 30 * 86_400,
  });
  const login = async (phone = PHONE, clientId = client.id) => {
    await s.identity.requestOtp({ phone, ip: IP });
    return s.identity.verifyOtp({ phone, code: h.otps.at(-1)!, clientId, device: 'iPhone 17', ip: IP });
  };
  return { ...h, s, user, client, login };
}

async function rejects(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

describe('OTP request', () => {
  it('texts a code to a registered number and answers with the code lifetime', async () => {
    const w = await world();
    expect(await w.s.identity.requestOtp({ phone: '+91 98765 43210', ip: IP })).toEqual({ sent: true, expiresInSeconds: 300 });
    expect(w.otps).toHaveLength(1);
    expect(w.otps[0]).toMatch(/^\d{6}$/);
  });

  it('gives unknown and disabled numbers the same answer, and sends no code', async () => {
    const w = await world();
    expect(await w.s.identity.requestOtp({ phone: '9123456780', ip: IP })).toEqual({ sent: true, expiresInSeconds: 300 });
    await w.s.db.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [w.user.id]);
    expect(await w.s.identity.requestOtp({ phone: PHONE, ip: IP })).toEqual({ sent: true, expiresInSeconds: 300 });
    expect(w.otps).toHaveLength(0);
    // The unknown number's attempt is recorded but can never be verified.
    const [row] = await w.s.db.query<{ code_hash: string }>(`SELECT code_hash FROM otp_codes WHERE phone = '919123456780'`);
    expect(row!.code_hash).toBe('none');
  });

  it('allows three codes per number per hour, then 429 with retry_after_seconds', async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) {
      await w.s.identity.requestOtp({ phone: PHONE, ip: `10.0.0.${i}` });
      w.clock.advance(60_000);
    }
    const e = await rejects(w.s.identity.requestOtp({ phone: PHONE, ip: '10.0.0.9' }));
    expect(e.status).toBe(429);
    expect(e.code).toBe('rate_limited');
    expect(e.message).toBe('Too many codes for this number. Try again later.');
    // The first code went out 3 minutes ago, so it falls out of the window in 57 minutes.
    expect(e.details).toEqual({ retry_after_seconds: 57 * 60 });
    w.clock.advance(57 * 60_000 + 1000);
    await expect(w.s.identity.requestOtp({ phone: PHONE, ip: '10.0.0.9' })).resolves.toMatchObject({ sent: true });
  });

  it('limits codes per client IP across numbers', async () => {
    const w = await world();
    for (let i = 0; i < 20; i++) await w.s.identity.requestOtp({ phone: `91234567${String(i).padStart(2, '0')}`, ip: IP });
    const e = await rejects(w.s.identity.requestOtp({ phone: PHONE, ip: IP }));
    expect(e).toMatchObject({ status: 429, message: 'Too many codes from this network. Try again later.' });
    expect(e.details!['retry_after_seconds']).toBe(3600);
  });

  it('deletes codes older than a day', async () => {
    const w = await world();
    await w.s.identity.requestOtp({ phone: PHONE, ip: IP });
    w.clock.advance(25 * 3_600_000);
    await w.s.identity.requestOtp({ phone: '9123456780', ip: IP });
    const rows = await w.s.db.query<{ phone: string }>('SELECT phone FROM otp_codes');
    expect(rows.map((r) => r.phone)).toEqual(['919123456780']);
  });
});

describe('OTP verify', () => {
  it('signs in with the code and returns a working token pair', async () => {
    const w = await world();
    const r = await w.login();
    expect(r).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, user: { id: w.user.id, phone: '919876543210', email: 'ravi@example.com' } });
    expect(r.refreshToken).toMatch(/^rt_/);
    expect(r.refreshExpiresAt).toBe(new Date(w.clock().getTime() + 30 * 86_400_000).toISOString());
    const principal = await w.s.identity.authenticate(r.accessToken);
    expect(principal).toMatchObject({ user: { id: w.user.id }, sessionId: r.sessionId, clientId: w.client.id });
    const [session] = await w.s.identity.sessions(w.user.id);
    expect(session).toMatchObject({ id: r.sessionId, device: 'iPhone 17', ip: IP, clientId: w.client.id });
  });

  it('refuses a malformed code before looking anything up', async () => {
    const w = await world();
    const e = await rejects(w.s.identity.verifyOtp({ phone: PHONE, code: '12ab', clientId: w.client.id, device: 'x', ip: IP }));
    expect(e).toMatchObject({ status: 400, code: 'bad_request', message: 'Enter the 6-digit code.' });
  });

  it('refuses when no code was ever sent', async () => {
    const w = await world();
    const e = await rejects(w.s.identity.verifyOtp({ phone: PHONE, code: '123456', clientId: w.client.id, device: 'x', ip: IP }));
    expect(e).toMatchObject({ status: 401, code: 'otp_expired' });
  });

  it('refuses an expired code', async () => {
    const w = await world();
    await w.s.identity.requestOtp({ phone: PHONE, ip: IP });
    w.clock.advance(5 * 60_000);
    const e = await rejects(w.s.identity.verifyOtp({ phone: PHONE, code: w.otps[0]!, clientId: w.client.id, device: 'x', ip: IP }));
    expect(e).toMatchObject({ status: 401, code: 'otp_expired', message: 'This code has expired. Ask for a new one.' });
  });

  it('counts wrong guesses and locks the code after five', async () => {
    const w = await world();
    await w.s.identity.requestOtp({ phone: PHONE, ip: IP });
    const right = w.otps[0]!;
    const wrong = right === '000000' ? '111111' : '000000';
    const messages: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = await rejects(w.s.identity.verifyOtp({ phone: PHONE, code: wrong, clientId: w.client.id, device: 'x', ip: IP }));
      expect(e).toMatchObject({ status: 401, code: 'otp_invalid' });
      messages.push(e.message);
    }
    expect(messages).toEqual([
      'Wrong code. 4 tries left.',
      'Wrong code. 3 tries left.',
      'Wrong code. 2 tries left.',
      'Wrong code. 1 try left.',
      'Wrong code. Ask for a new one.',
    ]);
    const e = await rejects(w.s.identity.verifyOtp({ phone: PHONE, code: right, clientId: w.client.id, device: 'x', ip: IP }));
    expect(e).toMatchObject({ status: 429, code: 'otp_attempts' });
  });

  it('uses a code once', async () => {
    const w = await world();
    await w.login();
    const e = await rejects(w.s.identity.verifyOtp({ phone: PHONE, code: w.otps[0]!, clientId: w.client.id, device: 'x', ip: IP }));
    expect(e).toMatchObject({ status: 401, code: 'otp_expired' });
  });

  it('refuses when the code is used concurrently', async () => {
    const w = await world();
    await w.s.identity.requestOtp({ phone: PHONE, ip: IP });
    const input = { phone: PHONE, code: w.otps[0]!, clientId: w.client.id, device: 'x', ip: IP };
    const results = await Promise.allSettled([w.s.identity.verifyOtp(input), w.s.identity.verifyOtp(input)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ status: 401, code: 'otp_expired' });
  });

  it('refuses a user disabled between sending and verifying', async () => {
    const w = await world();
    await w.s.identity.requestOtp({ phone: PHONE, ip: IP });
    await w.s.db.query(`UPDATE users SET status = 'disabled'`);
    const e = await rejects(w.s.identity.verifyOtp({ phone: PHONE, code: w.otps[0]!, clientId: w.client.id, device: 'x', ip: IP }));
    expect(e).toMatchObject({ status: 401, code: 'unauthorized', message: 'This account is not active.' });
  });

  it('refuses unknown clients and clients without the otp grant', async () => {
    const w = await world();
    const unknown = await rejects(w.s.identity.verifyOtp({ phone: PHONE, code: '123456', clientId: 'cl_nope', device: 'x', ip: IP }));
    expect(unknown).toMatchObject({ status: 401, message: 'Unknown client_id.' });
    await w.s.db.query(`UPDATE clients SET grant_types = '{refresh_token}'`);
    const grant = await rejects(w.s.identity.verifyOtp({ phone: PHONE, code: '123456', clientId: w.client.id, device: 'x', ip: IP }));
    expect(grant).toMatchObject({ status: 403, code: 'forbidden', message: 'This client may not use the otp grant.' });
  });
});

describe('refresh tokens', () => {
  it('rotates: the new pair works, the old refresh token does not', async () => {
    const w = await world();
    const first = await w.login();
    w.clock.advance(60_000);
    const second = await w.s.identity.refresh({ refreshToken: first.refreshToken, clientId: w.client.id });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.refreshExpiresAt).toBe(new Date(w.clock().getTime() + 30 * 86_400_000).toISOString());
    await expect(w.s.identity.authenticate(second.accessToken)).resolves.toMatchObject({ sessionId: first.sessionId });
  });

  it('revokes the whole session when a spent refresh token is reused', async () => {
    const w = await world();
    const first = await w.login();
    const second = await w.s.identity.refresh({ refreshToken: first.refreshToken, clientId: w.client.id });
    const e = await rejects(w.s.identity.refresh({ refreshToken: first.refreshToken, clientId: w.client.id }));
    expect(e).toMatchObject({ status: 401, code: 'refresh_reused' });
    const [row] = await w.s.db.query<{ revoked_reason: string }>('SELECT revoked_reason FROM sessions WHERE id = $1', [first.sessionId]);
    expect(row!.revoked_reason).toBe('refresh_token_reused');
    // Every token of that session stops working.
    await expect(w.s.identity.authenticate(second.accessToken)).rejects.toMatchObject({ status: 401, message: 'Your session has ended. Sign in again.' });
    await expect(w.s.identity.refresh({ refreshToken: second.refreshToken, clientId: w.client.id })).rejects.toMatchObject({
      status: 401,
      message: 'Your session has ended. Sign in again.',
    });
  });

  it('refuses another client using the token', async () => {
    const w = await world();
    const first = await w.login();
    const other = await w.s.identity.registerClient({ name: 'web', platform: 'web', grantTypes: ['otp', 'refresh_token'], accessTtlSeconds: 60, refreshTtlSeconds: 600 });
    const e = await rejects(w.s.identity.refresh({ refreshToken: first.refreshToken, clientId: other.id }));
    expect(e).toMatchObject({ status: 401, message: 'This refresh token belongs to another app.' });
  });

  it('refuses unknown refresh tokens and clients without the refresh grant', async () => {
    const w = await world();
    const e = await rejects(w.s.identity.refresh({ refreshToken: 'rt_nope', clientId: w.client.id }));
    expect(e).toMatchObject({ status: 401, message: 'Unknown refresh token. Sign in again.' });
    const otpOnly = await w.s.identity.registerClient({ name: 'kiosk', platform: 'other', grantTypes: ['otp'], accessTtlSeconds: 60, refreshTtlSeconds: 600 });
    await expect(w.s.identity.refresh({ refreshToken: 'rt_nope', clientId: otpOnly.id })).rejects.toMatchObject({ status: 403 });
  });

  it('refuses an expired session', async () => {
    const w = await world();
    const first = await w.login();
    w.clock.advance(31 * 86_400_000);
    const e = await rejects(w.s.identity.refresh({ refreshToken: first.refreshToken, clientId: w.client.id }));
    expect(e).toMatchObject({ status: 401, message: 'Your session has ended. Sign in again.' });
    expect(await w.s.identity.sessions(w.user.id)).toEqual([]);
  });
});

describe('sessions', () => {
  it('logout ends the session at once', async () => {
    const w = await world();
    const r = await w.login();
    await w.s.identity.logout(r.sessionId);
    await expect(w.s.identity.authenticate(r.accessToken)).rejects.toMatchObject({ status: 401 });
    expect(await w.s.identity.sessions(w.user.id)).toEqual([]);
  });

  it('lists active sessions newest first, and revokes one by the owner only', async () => {
    const w = await world();
    const a = await w.login();
    w.clock.advance(1000);
    w.clock.advance(60 * 60_000);
    const b = await w.login();
    expect((await w.s.identity.sessions(w.user.id)).map((s) => s.id)).toEqual([b.sessionId, a.sessionId]);

    const other = await w.s.identity.registerUser({ phone: '9123456780' });
    await expect(w.s.identity.revoke(other.id, a.sessionId)).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(w.s.identity.revoke(w.user.id, 'ses_nope')).rejects.toMatchObject({ status: 404 });
    await w.s.identity.revoke(w.user.id, a.sessionId);
    await expect(w.s.identity.revoke(w.user.id, a.sessionId)).rejects.toMatchObject({ status: 404 });
    expect((await w.s.identity.sessions(w.user.id)).map((s) => s.id)).toEqual([b.sessionId]);
    const [row] = await w.s.db.query<{ revoked_reason: string }>('SELECT revoked_reason FROM sessions WHERE id = $1', [a.sessionId]);
    expect(row!.revoked_reason).toBe('revoked_by_user');
  });

  it('refuses a token whose user was disabled, or whose session belongs to someone else', async () => {
    const w = await world();
    const r = await w.login();
    await w.s.db.query(`UPDATE users SET status = 'disabled'`);
    await expect(w.s.identity.authenticate(r.accessToken)).rejects.toMatchObject({ message: 'This account is not active.' });
    const forged = w.s.signer.sign({ sub: 'usr_other', aud: w.client.id, sid: r.sessionId }, 60).token;
    await expect(w.s.identity.authenticate(forged)).rejects.toMatchObject({ message: 'Your session has ended. Sign in again.' });
  });
});

describe('admin', () => {
  it('validates and de-duplicates users', async () => {
    const w = await world();
    await expect(w.s.identity.registerUser({ phone: '9123456780', email: 'not-an-email' })).rejects.toMatchObject({
      status: 400,
      message: 'Enter a valid email address.',
    });
    await expect(w.s.identity.registerUser({ phone: '+91 98765 43210' })).rejects.toMatchObject({
      status: 409,
      message: 'A user with this mobile number already exists.',
    });
    await expect(w.s.identity.registerUser({ phone: '9123456780', email: 'RAVI@example.com' })).rejects.toMatchObject({
      status: 409,
      message: 'A user with this email already exists.',
    });
    const blank = await w.s.identity.registerUser({ phone: '9123456780', email: '   ' });
    expect(blank).toMatchObject({ phone: '919123456780', email: null, status: 'active' });
  });

  it('registers clients only with the otp grant, and lists them', async () => {
    const w = await world();
    await expect(
      w.s.identity.registerClient({ name: 'x', platform: 'web', grantTypes: ['refresh_token'], accessTtlSeconds: 60, refreshTtlSeconds: 60 }),
    ).rejects.toMatchObject({ status: 400, message: 'A client needs the otp grant to sign anyone in.' });
    expect(await w.s.identity.clients()).toEqual([expect.objectContaining({ id: w.client.id, name: 'iOS app', platform: 'ios', grantTypes: ['otp', 'refresh_token'] })]);
  });
});

describe('OTP delivery', () => {
  async function direct(channels: OtpChannel[]) {
    const clock = testClock();
    const repo = new IdentityRepository(await testDb());
    const log = memoryLog();
    const signer = new TokenSigner({ privateKeyPem: JWT_PRIVATE_KEY, kid: 'k1', issuer: 'test', previous: [], clock });
    const service = new IdentityService({ repo, signer, channels, clock, log, policy: DEFAULT_OTP_POLICY });
    await service.registerUser({ phone: PHONE });
    return { service, log };
  }
  const channel = (name: string, behaviour: 'ok' | 'fail' | 'unreachable', sent: string[]): OtpChannel => ({
    name,
    canReach: () => behaviour !== 'unreachable',
    send: async (_to, code) => {
      if (behaviour === 'fail') throw new Error(`${name} is down`);
      sent.push(`${name}:${code}`);
    },
  });

  it('falls back to the next channel when one fails', async () => {
    const sent: string[] = [];
    const { service, log } = await direct([channel('sms', 'fail', sent), channel('email', 'unreachable', sent), channel('console', 'ok', sent)]);
    await service.requestOtp({ phone: PHONE, ip: IP });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^console:\d{6}$/);
    expect(log.lines).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'otp channel failed; trying the next', obj: expect.objectContaining({ op: 'sms', reason: 'sms is down' }) }));
  });

  it('throws the last failure when every channel fails', async () => {
    const sent: string[] = [];
    const { service } = await direct([channel('sms', 'fail', sent), channel('email', 'fail', sent)]);
    await expect(service.requestOtp({ phone: PHONE, ip: IP })).rejects.toThrow('email is down');
  });

  it('answers 503 when no channel can reach the user', async () => {
    const { service } = await direct([channel('email', 'unreachable', [])]);
    await expect(service.requestOtp({ phone: PHONE, ip: IP })).rejects.toMatchObject({ status: 503, code: 'otp_unavailable' });
  });
});
