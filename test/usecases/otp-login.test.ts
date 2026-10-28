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

const MOBILE = '98765 43210';
const IP = '203.0.113.9';
const verify = { mobile: '+919876543210', otp: '123456', device: 'Pixel 9' };

describe('OtpLoginService', () => {
  it('signs up a new number with the invite code, then signs it in', async () => {
    const { otp, auth, sent, users } = setup();
    expect(await otp.send({ mobile: MOBILE, ip: IP, signupCode: ' invite ' })).toEqual({
      mobile: '+919876543210',
      newUser: true,
      expiresInSeconds: 300,
      resendInSeconds: 30,
    });
    expect(sent).toEqual([{ mobile: '919876543210', length: 6, expiryMinutes: 5 }]);

    const { token, user } = await otp.verify(verify);
    expect(user).toMatchObject({ email: null, phone: '919876543210', createdAt: NOW });
    expect(auth.authenticate(token)).toEqual(user);
    expect(users.passwordHash(user.id)).toBeNull();
    await expect(auth.changePassword(user, 'x', 'long enough pw', 'd')).rejects.toThrow('no password to change');
  });

  it('signs in an existing number without an invite code, even after sign-up closes', async () => {
    const { otp, users } = setup({ signupCode: null });
    users.create({ id: 'u1', email: null, phone: '919876543210', createdAt: NOW }, null);
    expect((await otp.send({ mobile: MOBILE, ip: IP })).newUser).toBe(false);
    expect((await otp.verify(verify)).user.id).toBe('u1');
  });

  it('needs a valid invite code before texting a new number', async () => {
    const { otp, sent } = setup();
    await expect(otp.send({ mobile: MOBILE, ip: IP })).rejects.toMatchObject({ status: 403, code: 'signup_code_required' });
    await expect(otp.send({ mobile: MOBILE, ip: IP, signupCode: '  ' })).rejects.toMatchObject({ code: 'signup_code_required' });
    await expect(otp.send({ mobile: MOBILE, ip: IP, signupCode: 'nope' })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      message: 'Wrong invite code.',
    });
    await expect(setup({ signupCode: null }).otp.send({ mobile: MOBILE, ip: IP, signupCode: 'invite' })).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('registration is closed'),
    });
    expect(sent).toEqual([]);
  });

  it('does not create the user if sign-up closed between send and verify', async () => {
    const db = openDb(':memory:');
    const users = new UserRepository(db);
    const otps = new OtpRepository(db);
    const auth = new AuthService({ users, sessions: new SessionRepository(db), clock: () => NOW, signupCode: null, sessionDays: 30 });
    const { sender } = fakeSender();
    const open = new OtpLoginService({ users, otps, auth, sender, clock: () => NOW, signupCode: 'invite', expiryMinutes: 5 });
    await open.send({ mobile: MOBILE, ip: IP, signupCode: 'invite' });
    const closed = new OtpLoginService({ users, otps, auth, sender, clock: () => NOW, signupCode: null, expiryMinutes: 5 });
    await expect(closed.verify(verify)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('no login') });
    expect(users.findByPhone('919876543210')).toBeNull();
  });

  it('does not create a user from a code sent before the number had one and was deleted', async () => {
    const { otp, users, db } = setup();
    users.create({ id: 'u1', email: null, phone: '919876543210', createdAt: NOW }, null);
    await otp.send({ mobile: MOBILE, ip: IP });
    db.prepare('DELETE FROM users').run();
    await expect(otp.verify(verify)).rejects.toMatchObject({ status: 403 });
  });

  it('rate-limits sending per number (cooldown and hourly cap) and per IP', async () => {
    const { otp, advance, sent } = setup();
    const send = (mobile = MOBILE, ip = IP) => otp.send({ mobile, ip, signupCode: 'invite' });
    await send();
    await expect(send()).rejects.toMatchObject({ status: 429, code: 'rate_limited', message: 'Wait 30 seconds before asking for another code.' });
    advance(29_500);
    await expect(send()).rejects.toThrow('Wait 1 seconds');
    for (let i = 1; i < DEFAULT_OTP_LIMITS.perPhonePerHour; i++) {
      advance(30_000);
      await send();
    }
    advance(30_000);
    await expect(send()).rejects.toThrow('Too many codes sent to this number. Try again in an hour.');
    advance(60 * 60 * 1000);
    await send();
    expect(sent).toHaveLength(DEFAULT_OTP_LIMITS.perPhonePerHour + 1);

    const { otp: other } = setup();
    for (let i = 0; i < DEFAULT_OTP_LIMITS.perIpPerHour; i++) {
      await other.send({ mobile: `98765${String(i).padStart(5, '0')}`, ip: IP, signupCode: 'invite' });
    }
    await expect(other.send({ mobile: '9999999999', ip: IP, signupCode: 'invite' })).rejects.toThrow(
      'Too many codes requested from this network.',
    );
    await expect(other.send({ mobile: '9999999999', ip: '198.51.100.1', signupCode: 'invite' })).resolves.toBeTruthy();
  });

  it('caps wrong codes and counts down the tries left', async () => {
    const { otp, checked } = setup();
    await otp.send({ mobile: MOBILE, ip: IP, signupCode: 'invite' });
    const wrong = { ...verify, otp: '000000' };
    await expect(otp.verify(wrong)).rejects.toMatchObject({ status: 401, code: 'otp_invalid', message: 'Wrong code. 4 tries left.' });
    for (const left of [3, 2]) await expect(otp.verify(wrong)).rejects.toThrow(`Wrong code. ${left} tries left.`);
    await expect(otp.verify(wrong)).rejects.toThrow('Wrong code. 1 try left.');
    await expect(otp.verify(wrong)).rejects.toThrow('Wrong code. Ask for a new one.');
    await expect(otp.verify(verify)).rejects.toMatchObject({ status: 429, code: 'otp_attempts' });
    expect(checked).toHaveLength(5);
  });

  it('refuses expired, already used or never-sent codes and malformed input', async () => {
    const { otp, advance, checked } = setup();
    await expect(otp.verify(verify)).rejects.toMatchObject({ status: 401, code: 'otp_expired' });
    await otp.send({ mobile: MOBILE, ip: IP, signupCode: 'invite' });
    await expect(otp.verify({ ...verify, otp: '12345' })).rejects.toMatchObject({ status: 400, message: 'Enter the 6-digit code from the SMS.' });
    await expect(otp.verify({ ...verify, mobile: '12345' })).rejects.toMatchObject({ status: 400 });
    await expect(otp.verify({ ...verify, otp: ' 123456 ' })).resolves.toBeTruthy();
    await expect(otp.verify(verify)).rejects.toMatchObject({ code: 'otp_expired' });

    advance(30_000);
    await otp.send({ mobile: MOBILE, ip: IP });
    advance(5 * 60 * 1000);
    await expect(otp.verify(verify)).rejects.toThrow('This code has expired. Ask for a new one.');
    expect(checked).toEqual(['123456']);
  });

  it('is off until MSG91 is configured', async () => {
    const { otp } = setup({ sender: null });
    for (const run of [otp.send({ mobile: MOBILE, ip: IP }), otp.verify(verify)]) {
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
    await expect(otp.send({ mobile: MOBILE, ip: IP, signupCode: 'invite' })).rejects.toThrow('down');
    await expect(otp.verify(verify)).rejects.toMatchObject({ code: 'otp_expired' });
  });
});
