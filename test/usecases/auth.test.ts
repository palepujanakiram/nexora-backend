import { describe, expect, it } from 'vitest';

import { openDb } from '../../src/data/db.ts';
import { SessionRepository, UserRepository } from '../../src/data/users.ts';
import { AuthService } from '../../src/usecases/auth.ts';
import { NOW } from '../helpers.ts';

function setup(signupCode: string | null = 'invite') {
  const db = openDb(':memory:');
  let now = NOW;
  const auth = new AuthService({
    users: new UserRepository(db),
    sessions: new SessionRepository(db),
    clock: () => now,
    signupCode,
    sessionDays: 30,
  });
  return { auth, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const register = { email: ' Me@Example.com ', password: 'long enough pw', signupCode: 'invite', device: 'iPhone' };

describe('AuthService', () => {
  it('registers with the invite code and signs the device in', async () => {
    const { auth } = setup();
    const { token, user } = await auth.register(register);
    expect(user.email).toBe('me@example.com');
    expect(auth.authenticate(token)).toEqual(user);
  });

  it('refuses registration when closed, with a wrong code, or for a taken email', async () => {
    await expect(setup(null).auth.register(register)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('closed') });
    const { auth } = setup();
    await expect(auth.register({ ...register, signupCode: 'nope' })).rejects.toThrow('Wrong invite code.');
    await auth.register(register);
    await expect(auth.register(register)).rejects.toMatchObject({ status: 409 });
  });

  it('creates mobile users without an invite code, once per number', () => {
    const { auth } = setup(null);
    const user = auth.createPhoneUser('098765 43210');
    expect(user).toMatchObject({ email: null, phone: '919876543210', createdAt: NOW });
    expect(() => auth.createPhoneUser('+91 98765 43210')).toThrow(
      expect.objectContaining({ status: 409, message: 'A user with this mobile number already exists.' }),
    );
    expect(() => auth.createPhoneUser('5876543210')).toThrow('Enter a 10-digit Indian mobile number.');
  });

  it('checks email and password rules', async () => {
    const { auth } = setup();
    await expect(auth.createUser('not-an-email', 'long enough pw')).rejects.toThrow('Enter a valid email address.');
    await expect(auth.createUser('a@b.c', 'short')).rejects.toThrow('at least 10 characters');
  });

  it('logs in with the right password only', async () => {
    const { auth } = setup();
    await auth.createUser('me@example.com', 'long enough pw');
    const { token } = await auth.login({ email: 'ME@example.com', password: 'long enough pw', device: 'web' });
    expect(auth.authenticate(token).email).toBe('me@example.com');
    await expect(auth.login({ email: 'me@example.com', password: 'wrong password', device: 'web' })).rejects.toMatchObject({
      status: 401,
      message: 'Wrong email or password.',
    });
    await expect(auth.login({ email: 'who@example.com', password: 'long enough pw', device: 'web' })).rejects.toThrow(
      'Wrong email or password.',
    );
  });

  it('refuses a password login for a user who has no password', async () => {
    const db = openDb(':memory:');
    const users = new UserRepository(db);
    users.create({ id: 'u1', email: 'otp@example.com', phone: '919876543210', createdAt: NOW }, null);
    const auth = new AuthService({ users, sessions: new SessionRepository(db), clock: () => NOW, signupCode: null, sessionDays: 30 });
    await expect(auth.login({ email: 'otp@example.com', password: 'long enough pw', device: 'x' })).rejects.toThrow(
      'Wrong email or password.',
    );
  });

  it('ends sessions on logout, expiry or when the user is gone', async () => {
    const { auth, advance } = setup();
    const { token } = await auth.register(register);
    const second = await auth.login({ email: 'me@example.com', password: 'long enough pw', device: 'tablet' });
    auth.logout(token);
    expect(() => auth.authenticate(token)).toThrow('Your session has ended. Sign in again.');
    advance(31 * 24 * 60 * 60 * 1000);
    expect(() => auth.authenticate(second.token)).toThrow('Your session has expired. Sign in again.');
    expect(() => auth.authenticate(second.token)).toThrow('Your session has ended.');
  });

  it('rejects a session whose user no longer exists', async () => {
    const db = openDb(':memory:');
    const sessions = new SessionRepository(db);
    const users = new UserRepository(db);
    const auth = new AuthService({ users, sessions, clock: () => NOW, signupCode: 'invite', sessionDays: 30 });
    const { token, user } = await auth.register(register);
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    expect(() => auth.authenticate(token)).toThrow('Your session has ended.');
  });

  it('changes the password and signs out other devices', async () => {
    const { auth } = setup();
    const first = await auth.register(register);
    await expect(auth.changePassword(first.user, 'wrong password', 'brand new password', 'x')).rejects.toThrow(
      'Current password is wrong.',
    );
    await expect(auth.changePassword(first.user, 'long enough pw', 'short', 'x')).rejects.toThrow('at least 10');
    const next = await auth.changePassword(first.user, 'long enough pw', 'brand new password', 'iPhone');
    expect(() => auth.authenticate(first.token)).toThrow();
    expect(auth.authenticate(next.token).id).toBe(first.user.id);
    await expect(auth.login({ email: 'me@example.com', password: 'brand new password', device: 'x' })).resolves.toBeTruthy();
  });
});
