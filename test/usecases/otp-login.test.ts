import { describe, expect, it } from 'vitest';

import type { OtpSender } from '../../src/brokers/msg91.ts';
import { openDb } from '../../src/data/db.ts';
import { OtpRepository } from '../../src/data/otp.ts';
import { SessionRepository, UserRepository } from '../../src/data/users.ts';
import { AuthService } from '../../src/usecases/auth.ts';
import { DEFAULT_OTP_LIMITS, OtpLoginService } from '../../src/usecases/otp-login.ts';
import { NOW } from '../helpers.ts';

/** A fake SMS provider: the right code is always 123456. */
function fakeSender() {
  const sent: { mobile: string; length: number; expiryMinutes: number }[] = [];
  const checked: string[] = [];
  const sender: OtpSender = {
    send: async (mobile, options) => {
      sent.push({ mobile, ...options });
    },
    verify: async (_mobile, otp) => {
      checked.push(otp);
      return otp === '123456';
    },
  };
  return { sender, sent, checked };
}

function setup(options: { signupCode?: string | null; sender?: OtpSender | null } = {}) {
  const db = openDb(':memory:');
  let now = NOW;
  const clock = () => now;
  const users = new UserRepository(db);
  const signupCode = options.signupCode === undefined ? 'invite' : options.signupCode;
  const auth = new AuthService({ users, sessions: new SessionRepository(db), clock, signupCode, sessionDays: 30 });
  const fake = fakeSender();
  const otp = new OtpLoginService({
    users,
    otps: new OtpRepository(db),
    auth,
    sender: options.sender === undefined ? fake.sender : options.sender,
    clock,
    signupCode,
    expiryMinutes: 5,
  });
  return { db, otp, auth, users, ...fake, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const PHONE = '98765 43210';
const IP = '203.0.113.9';
const verify = { phone: '+919876543210', code: '123456', device: 'Pixel 9' };

describe('OtpLoginService', () => {
  it('signs up a new number with the invite code, then signs it in', async () => {
    const { otp, auth, sent, users } = setup();
    expect(await otp.start({ phone: PHONE, ip: IP, signupCode: ' invite ' })).toEqual({ sent: true, expires_in_seconds: 300 });
    expect(sent).toEqual([{ mobile: '919876543210', length: 6, expiryMinutes: 5 }]);

    const { token, user, expiresAt, expiresInSeconds } = await otp.verify(verify);
    expect(user).toMatchObject({ email: null, phone: '919876543210', createdAt: NOW });
    expect(expiresAt).toEqual(new Date(NOW.getTime() + 30 * 86_400_000));
    expect(expiresInSeconds).toBe(30 * 86_400);
    expect(auth.authenticate(token)).toEqual(user);
    expect(users.passwordHash(user.id)).toBeNull();
    await expect(auth.changePassword(user, 'x', 'long enough pw', 'd')).rejects.toThrow('no password to change');
  });

  it('accepts { countryCode, mobile } as well as { phone }, India only', async () => {
    const { otp, users, sent } = setup({ signupCode: null });
    users.create({ id: 'u1', email: null, phone: '919876543210', createdAt: NOW }, null);
    await otp.start({ countryCode: '+91', mobile: '9876543210', ip: IP });
    expect(sent[0]!.mobile).toBe('919876543210');
    expect((await otp.verify({ countryCode: '91', mobile: '98765 43210', code: '123456', device: 'x' })).user.id).toBe('u1');
    await expect(otp.start({ countryCode: '+1', mobile: '4155550100', ip: IP })).rejects.toMatchObject({
      status: 400,
      message: 'Only Indian (+91) mobile numbers are supported.',
    });
    await expect(otp.start({ ip: IP })).rejects.toThrow('Enter a 10-digit Indian mobile number.');
  });

  it('signs in an existing number without an invite code, even after sign-up closes', async () => {
    const { otp, users } = setup({ signupCode: null });
    users.create({ id: 'u1', email: null, phone: '919876543210', createdAt: NOW }, null);
    await otp.start({ phone: PHONE, ip: IP });
    expect((await otp.verify(verify)).user.id).toBe('u1');
  });

  it('answers not_registered for a new number without a valid invite, and sends nothing', async () => {
    const { otp, sent } = setup();
    await expect(otp.start({ phone: PHONE, ip: IP })).rejects.toMatchObject({
      status: 404,
      code: 'not_registered',
      message: 'This phone number is not registered. Enter the invite code to sign up.',
    });
    await expect(otp.start({ phone: PHONE, ip: IP, signupCode: '  ' })).rejects.toMatchObject({ code: 'not_registered' });
    await expect(otp.start({ phone: PHONE, ip: IP, signupCode: 'nope' })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      message: 'Wrong invite code.',
    });
    await expect(setup({ signupCode: null }).otp.start({ phone: PHONE, ip: IP, signupCode: 'invite' })).rejects.toMatchObject({
      status: 404,
      message: 'This phone number is not registered.',
    });
    expect(sent).toEqual([]);
  });

  it('does not create the user if sign-up closed between start and verify', async () => {
    const db = openDb(':memory:');
    const users = new UserRepository(db);
    const otps = new OtpRepository(db);
    const auth = new AuthService({ users, sessions: new SessionRepository(db), clock: () => NOW, signupCode: null, sessionDays: 30 });
    const { sender } = fakeSender();
    const open = new OtpLoginService({ users, otps, auth, sender, clock: () => NOW, signupCode: 'invite', expiryMinutes: 5 });
    await open.start({ phone: PHONE, ip: IP, signupCode: 'invite' });
    const closed = new OtpLoginService({ users, otps, auth, sender, clock: () => NOW, signupCode: null, expiryMinutes: 5 });
    await expect(closed.verify(verify)).rejects.toMatchObject({ status: 404, code: 'not_registered' });
    expect(users.findByPhone('919876543210')).toBeNull();
  });

  it('does not create a user from a code sent while the number had one that was then deleted', async () => {
    const { otp, users, db } = setup();
    users.create({ id: 'u1', email: null, phone: '919876543210', createdAt: NOW }, null);
    await otp.start({ phone: PHONE, ip: IP });
    db.prepare('DELETE FROM users').run();
    await expect(otp.verify(verify)).rejects.toMatchObject({ status: 404 });
  });

  it('allows 5 codes per number per 15 minutes and 20 per IP per hour, with retry_after_seconds', async () => {
    const { otp, advance, sent } = setup();
    const start = (phone = PHONE, ip = IP) => otp.start({ phone, ip, signupCode: 'invite' });
    for (let i = 0; i < DEFAULT_OTP_LIMITS.perPhone; i++) {
      await start();
      advance(60_000);
    }
    // First code went out 5 minutes ago: 10 minutes to wait.
    await expect(start()).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      message: 'Too many OTP requests. Try again later.',
      details: { retry_after_seconds: 600 },
    });
    advance(600_000);
    await start();
    expect(sent).toHaveLength(DEFAULT_OTP_LIMITS.perPhone + 1);

    const { otp: other, advance: later } = setup();
    for (let i = 0; i < DEFAULT_OTP_LIMITS.perIpPerHour; i++) {
      await other.start({ phone: `98765${String(i).padStart(5, '0')}`, ip: IP, signupCode: 'invite' });
    }
    later(59 * 60_000 + 59_500);
    await expect(other.start({ phone: '9999999999', ip: IP, signupCode: 'invite' })).rejects.toMatchObject({
      message: 'Too many OTP requests from this network. Try again later.',
      details: { retry_after_seconds: 1 },
    });
    await expect(other.start({ phone: '9999999999', ip: '198.51.100.1', signupCode: 'invite' })).resolves.toBeTruthy();
  });

  it('caps wrong codes and counts down the tries left', async () => {
    const { otp, checked } = setup();
    await otp.start({ phone: PHONE, ip: IP, signupCode: 'invite' });
    const wrong = { ...verify, code: '000000' };
    await expect(otp.verify(wrong)).rejects.toMatchObject({ status: 401, code: 'otp_invalid', message: 'Invalid OTP. 4 tries left.' });
    for (const left of [3, 2]) await expect(otp.verify(wrong)).rejects.toThrow(`Invalid OTP. ${left} tries left.`);
    await expect(otp.verify(wrong)).rejects.toThrow('Invalid OTP. 1 try left.');
    await expect(otp.verify(wrong)).rejects.toThrow('Invalid OTP. Ask for a new one.');
    await expect(otp.verify(verify)).rejects.toMatchObject({ status: 429, code: 'otp_attempts' });
    expect(checked).toHaveLength(5);
  });

  it('refuses expired, already used or never-sent codes and malformed input', async () => {
    const { otp, advance, checked } = setup();
    await expect(otp.verify(verify)).rejects.toMatchObject({ status: 401, code: 'otp_expired' });
    await otp.start({ phone: PHONE, ip: IP, signupCode: 'invite' });
    await expect(otp.verify({ ...verify, code: '12345' })).rejects.toMatchObject({ status: 400, message: 'Enter the 6-digit code from the SMS.' });
    await expect(otp.verify({ ...verify, phone: '12345' })).rejects.toMatchObject({ status: 400 });
    await expect(otp.verify({ ...verify, code: ' 123456 ' })).resolves.toBeTruthy();
    await expect(otp.verify(verify)).rejects.toMatchObject({ code: 'otp_expired' });

    await otp.start({ phone: PHONE, ip: IP });
    advance(5 * 60 * 1000);
    await expect(otp.verify(verify)).rejects.toThrow('This code has expired. Ask for a new one.');
    expect(checked).toEqual(['123456']);
  });

  it('uses the configured code length', async () => {
    const db = openDb(':memory:');
    const users = new UserRepository(db);
    const auth = new AuthService({ users, sessions: new SessionRepository(db), clock: () => NOW, signupCode: 'invite', sessionDays: 30 });
    const { sender, sent } = fakeSender();
    const otp = new OtpLoginService({
      users, otps: new OtpRepository(db), auth, sender, clock: () => NOW, signupCode: 'invite', expiryMinutes: 10,
      limits: { ...DEFAULT_OTP_LIMITS, length: 4 },
    });
    expect(await otp.start({ phone: PHONE, ip: IP, signupCode: 'invite' })).toEqual({ sent: true, expires_in_seconds: 600 });
    expect(sent[0]).toMatchObject({ length: 4, expiryMinutes: 10 });
    await expect(otp.verify(verify)).rejects.toThrow('Enter the 4-digit code from the SMS.');
  });

  it('is off until MSG91 is configured', async () => {
    const { otp } = setup({ sender: null });
    for (const run of [otp.start({ phone: PHONE, ip: IP }), otp.verify(verify)]) {
      await expect(run).rejects.toMatchObject({ status: 503, code: 'otp_unavailable' });
    }
  });

  it('records nothing when MSG91 fails to send', async () => {
    const failing: OtpSender = {
      send: async () => {
        throw new Error('down');
      },
      verify: async () => true,
    };
    const { otp } = setup({ sender: failing });
    await expect(otp.start({ phone: PHONE, ip: IP, signupCode: 'invite' })).rejects.toThrow('down');
    await expect(otp.verify(verify)).rejects.toMatchObject({ code: 'otp_expired' });
  });
});
