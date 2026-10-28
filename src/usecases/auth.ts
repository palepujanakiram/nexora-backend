import { timingSafeEqual } from 'node:crypto';

import { badRequest, conflict, forbidden, unauthorized } from '../domain/errors.ts';
import { hashPassword, newId, newToken, sha256, verifyPassword } from '../data/crypto.ts';
import type { SessionRepository, User, UserRepository } from '../data/users.ts';

export const MIN_PASSWORD_LENGTH = 10;

export interface AuthDeps {
  users: UserRepository;
  sessions: SessionRepository;
  clock: () => Date;
  /** Invite code new users must give to register. Registration is closed without one. */
  signupCode: string | null;
  sessionDays: number;
}

export interface SignedIn {
  token: string;
  user: User;
}

/** Sign-up, sign-in and bearer-token sessions for app devices. */
export class AuthService {
  private readonly deps: AuthDeps;

  constructor(deps: AuthDeps) {
    this.deps = deps;
  }

  async register(input: { email: string; password: string; signupCode: string; device: string }): Promise<SignedIn> {
    const expected = this.deps.signupCode;
    if (!expected) throw forbidden('Registration is closed on this server. Ask the owner to create your user.');
    if (!sameSecret(input.signupCode, expected)) throw forbidden('Wrong invite code.');
    const user = await this.createUser(input.email, input.password);
    return this.startSession(user, input.device);
  }

  /** Creates a user without an invite code (server CLI). */
  async createUser(email: string, password: string): Promise<User> {
    const normalized = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(normalized)) throw badRequest('Enter a valid email address.');
    checkPassword(password);
    if (this.deps.users.findByEmail(normalized)) throw conflict('A user with this email already exists.');
    const user = { id: newId(), email: normalized, phone: null, createdAt: this.deps.clock() };
    return this.deps.users.create(user, await hashPassword(password));
  }

  async login(input: { email: string; password: string; device: string }): Promise<SignedIn> {
    const found = this.deps.users.findByEmail(input.email.trim().toLowerCase());
    // Hash even for unknown emails so response times don't reveal which emails exist.
    const ok = await verifyPassword(input.password, found?.passwordHash ?? DUMMY_HASH);
    if (!found?.passwordHash || !ok) throw unauthorized('Wrong email or password.');
    return this.startSession(found.user, input.device);
  }

  /** The user a bearer token belongs to. */
  authenticate(token: string): User {
    const hash = sha256(token);
    const session = this.deps.sessions.find(hash);
    if (!session) throw unauthorized('Your session has ended. Sign in again.');
    if (session.expiresAt.getTime() <= this.deps.clock().getTime()) {
      this.deps.sessions.delete(hash);
      throw unauthorized('Your session has expired. Sign in again.');
    }
    const user = this.deps.users.findById(session.userId);
    if (!user) throw unauthorized('Your session has ended. Sign in again.');
    return user;
  }

  logout(token: string): void {
    this.deps.sessions.delete(sha256(token));
  }

  /** Changes the password and signs out every device, then signs this one back in. */
  async changePassword(user: User, current: string, next: string, device: string): Promise<SignedIn> {
    const hash = this.deps.users.passwordHash(user.id);
    if (!hash) throw badRequest('You sign in with your mobile number, so there is no password to change.');
    if (!(await verifyPassword(current, hash))) {
      throw unauthorized('Current password is wrong.');
    }
    checkPassword(next);
    this.deps.users.setPassword(user.id, await hashPassword(next));
    this.deps.sessions.deleteForUser(user.id);
    return this.startSession(user, device);
  }

  /** Signs [user] in on [device] with a new bearer token. */
  startSession(user: User, device: string): SignedIn {
    const now = this.deps.clock();
    this.deps.sessions.deleteExpired(now);
    const token = newToken();
    this.deps.sessions.create(sha256(token), {
      userId: user.id,
      device: device.slice(0, 100),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.deps.sessionDays * 24 * 60 * 60 * 1000),
    });
    return { token, user };
  }
}

function checkPassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

/** Compares an invite code in constant time. */
export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(sha256(given));
  const b = Buffer.from(sha256(expected));
  return timingSafeEqual(a, b);
}

// scrypt hash of a random password nobody knows, used to equalise timing.
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
