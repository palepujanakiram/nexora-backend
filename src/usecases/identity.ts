import { randomInt } from 'node:crypto';

import type { OtpChannel } from '../brokers/msg91.ts';
import { newId, newToken, sameSecret, sha256 } from '../data/crypto.ts';
import type { Client, ClientPlatform, GrantType, IdentityRepository, OtpCode, OtpPurpose, Session, User } from '../data/identity.ts';
import { AppError, badRequest, conflict, forbidden, tooManyRequests, unauthorized } from '../domain/errors.ts';
import { normalizeIndianMobile } from '../domain/phone.ts';
import { CONSENT_KINDS, checkSignup, normalizeEmail, type SignupForm } from '../domain/profile.ts';
import type { Log } from '../logging.ts';
import type { AccessClaims, TokenSigner } from './tokens.ts';
import { must } from '../domain/invariant.ts';

export interface OtpPolicy {
  length: number;
  ttlMinutes: number;
  /** Tries at one code. */
  maxAttempts: number;
  /** Codes per phone per hour. */
  perPhonePerHour: number;
  /** Codes per client IP per hour. */
  perIpPerHour: number;
}

export const DEFAULT_OTP_POLICY: OtpPolicy = { length: 6, ttlMinutes: 5, maxAttempts: 5, perPhonePerHour: 3, perIpPerHour: 20 };

export interface IdentityDeps {
  repo: IdentityRepository;
  signer: TokenSigner;
  /** Tried in order until one sends: SMS first, then the fallbacks. */
  channels: readonly OtpChannel[];
  clock: () => Date;
  log: Log;
  policy: OtpPolicy;
  /** The wording version recorded with each sign-up consent. */
  consentVersion: string;
}

export interface TokenPair {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: string;
  sessionId: string;
}

/** Who made a request: from a verified access token whose session is still live. */
export interface Principal {
  user: User;
  sessionId: string;
  clientId: string;
}

const HOUR = 3_600_000;

interface OtpAnswer {
  sent: true;
  expiresInSeconds: number;
}

/**
 * OTP sign-up, OTP login and sessions for every registered client. Access tokens are
 * short-lived JWTs; refresh tokens are opaque, stored hashed, bound to one
 * client and device, rotated on every use, and reusing a spent one revokes
 * the whole session.
 */
export class IdentityService {
  private readonly d: IdentityDeps;

  constructor(deps: IdentityDeps) {
    this.d = deps;
  }

  /**
   * Texts a code to a registered number. Unregistered or disabled numbers get
   * the same answer and no SMS, so the endpoint can't be used to find users.
   */
  async requestOtp(input: { phone: string; ip: string }): Promise<OtpAnswer> {
    const phone = normalizeIndianMobile(input.phone);
    const now = this.d.clock();
    await this.limitCodes(phone, input.ip, now);
    const user = await this.d.repo.userByPhone(phone);
    // Recorded even for unknown numbers, so the limits apply to them too.
    const code = await this.storeCode(phone, input.ip, 'login', now, user?.status === 'active');
    if (user?.status !== 'active') {
      this.d.log.info({ reason: 'not_registered' }, 'otp requested for unknown number');
      return this.answer();
    }
    await this.deliver(user, code, user.id);
    return this.answer();
  }

  async verifyOtp(input: { phone: string; code: string; clientId: string; device: string; ip: string }): Promise<TokenPair & { user: User }> {
    const client = await this.client(input.clientId, 'otp');
    const phone = normalizeIndianMobile(input.phone);
    const now = this.d.clock();
    await this.useCode(await this.checkCode(phone, input.code, 'login', now), now);
    const user = await this.d.repo.userByPhone(phone);
    if (user?.status !== 'active') throw unauthorized('This account is not active.');
    const tokens = await this.startSession(user, client, input, now);
    this.d.log.info({ userId: user.id, sessionId: tokens.sessionId, clientId: client.id, event: 'login' }, 'signed in');
    return { ...tokens, user };
  }

  /**
   * Checks the sign-up form, then texts a sign-up code to [phone]. The code
   * goes out even if the number is registered: whether it is only comes out
   * after the code proves the number belongs to the caller.
   */
  async requestSignupOtp(input: SignupForm & { phone: string; ip: string }): Promise<OtpAnswer> {
    checkSignup(input);
    const phone = normalizeIndianMobile(input.phone);
    const now = this.d.clock();
    await this.limitCodes(phone, input.ip, now);
    const code = await this.storeCode(phone, input.ip, 'signup', now, true);
    await this.deliver({ phone, email: null }, code, null);
    return this.answer();
  }

  /**
   * Creates the account once the sign-up code checks out, records the
   * consents, and signs the new user in. A clash (number or email
   * already registered) leaves the code unused, so the user can fix
   * the form and send it again within the code's tries.
   */
  async verifySignup(
    input: SignupForm & { phone: string; code: string; clientId: string; device: string; ip: string },
  ): Promise<TokenPair & { user: User }> {
    const client = await this.client(input.clientId, 'otp');
    const details = checkSignup(input);
    const phone = normalizeIndianMobile(input.phone);
    const now = this.d.clock();
    const { repo } = this.d;
    const otp = await this.checkCode(phone, input.code, 'signup', now);
    if (await repo.userByPhone(phone)) throw new AppError(409, 'already_registered', 'This mobile number already has an account. Sign in instead.');
    if (await repo.userByEmail(details.email)) throw conflict('An account with this email already exists.');
    await this.useCode(otp, now);

    const user: User = {
      id: newId('usr'), phone, email: details.email, fullName: details.fullName, createdVia: 'client', createdByClientId: client.id, status: 'active', createdAt: now,
    };
    // Each consent is recorded with the date and time it was accepted: when the verified form created the account.
    const consents = CONSENT_KINDS.map((kind) => ({ kind, version: this.d.consentVersion, acceptedAt: now, ip: input.ip }));
    await repo.createSignedUpUser(user, consents);
    const tokens = await this.startSession(user, client, input, now);
    this.d.log.info({ userId: user.id, sessionId: tokens.sessionId, clientId: client.id, event: 'signup' }, 'signed up');
    return { ...tokens, user };
  }

  async refresh(input: { refreshToken: string; clientId: string }): Promise<TokenPair> {
    const client = await this.client(input.clientId, 'refresh_token');
    const { repo } = this.d;
    const now = this.d.clock();
    const oldHash = sha256(input.refreshToken);
    const owner = await repo.sessionOfRefresh(oldHash);
    if (owner && owner.clientId !== client.id) throw unauthorized('This refresh token belongs to another app.');
    const next = newToken('rt');
    const result = await repo.rotateRefresh(oldHash, sha256(next), now, () => new Date(now.getTime() + client.refreshTtlSeconds * 1000));
    if (result === null) throw unauthorized('Unknown refresh token. Sign in again.');
    if (result === 'reused') {
      const reused = must(owner, 'the session of a spent refresh token');
      await repo.revokeSession(reused.id, now, 'refresh_token_reused');
      this.d.log.warn({ userId: reused.userId, sessionId: reused.id, event: 'refresh_reuse' }, 'refresh token reused; session revoked');
      throw new AppError(401, 'refresh_reused', 'This sign-in was used from somewhere else and has been ended. Sign in again.');
    }
    if (result.revokedAt || result.expiresAt <= now) throw unauthorized('Your session has ended. Sign in again.');
    return this.pair(result, client, next);
  }

  /** The caller behind [accessToken]. The session must still be live, so revoking a device takes effect at once here. */
  async authenticate(accessToken: string): Promise<Principal> {
    const claims: AccessClaims = this.d.signer.verify(accessToken);
    const session = await this.d.repo.session(claims.sid);
    if (!session || session.revokedAt || session.userId !== claims.sub) throw unauthorized('Your session has ended. Sign in again.');
    const user = await this.d.repo.user(claims.sub);
    if (user?.status !== 'active') throw unauthorized('This account is not active.');
    return { user, sessionId: session.id, clientId: claims.aud };
  }

  async logout(sessionId: string): Promise<void> {
    await this.d.repo.revokeSession(sessionId, this.d.clock(), 'logout');
  }

  async sessions(userId: string): Promise<Session[]> {
    return this.d.repo.activeSessions(userId, this.d.clock());
  }

  async revoke(userId: string, sessionId: string): Promise<void> {
    const session = await this.d.repo.session(sessionId);
    if (session?.userId !== userId || session.revokedAt) throw new AppError(404, 'not_found', 'No such active session.');
    await this.d.repo.revokeSession(sessionId, this.d.clock(), 'revoked_by_user');
  }

  // Admin --------------------------------------------------------------------

  async registerUser(input: { phone: string; email?: string | null | undefined }): Promise<User> {
    const phone = normalizeIndianMobile(input.phone);
    const email = input.email?.trim() ? normalizeEmail(input.email) : null;
    if (await this.d.repo.userByPhone(phone)) throw conflict('A user with this mobile number already exists.');
    if (email && (await this.d.repo.userByEmail(email))) throw conflict('A user with this email already exists.');
    return this.d.repo.createUser({
      id: newId('usr'), phone, email, fullName: null, createdVia: 'admin', createdByClientId: null, status: 'active', createdAt: this.d.clock(),
    });
  }

  async registerClient(input: { name: string; platform: ClientPlatform; grantTypes: GrantType[]; accessTtlSeconds: number; refreshTtlSeconds: number }): Promise<Client> {
    if (!input.grantTypes.includes('otp')) throw badRequest('A client needs the otp grant to sign anyone in.');
    return this.d.repo.createClient({ id: newId('cl'), ...input, name: input.name.trim(), createdAt: this.d.clock() });
  }

  async clients(): Promise<Client[]> {
    return this.d.repo.clients();
  }

  // Internals ----------------------------------------------------------------

  private answer(): OtpAnswer {
    return { sent: true, expiresInSeconds: this.d.policy.ttlMinutes * 60 };
  }

  /** Codes per number and per client IP per hour, across sign-in and sign-up. */
  private async limitCodes(phone: string, ip: string, now: Date): Promise<void> {
    const { repo, policy } = this.d;
    const hourAgo = new Date(now.getTime() - HOUR);
    limit(await repo.otpTimes('phone', phone, hourAgo), policy.perPhonePerHour, now, 'Too many codes for this number. Try again later.');
    limit(await repo.otpTimes('ip', ip, hourAgo), policy.perIpPerHour, now, 'Too many codes from this network. Try again later.');
  }

  /** Stores a new code and returns it. An undeliverable code is stored with no hash, so it can never be verified. */
  private async storeCode(phone: string, ip: string, purpose: OtpPurpose, now: Date, deliverable: boolean): Promise<string> {
    const { repo, policy } = this.d;
    const code = String(randomInt(0, 10 ** policy.length)).padStart(policy.length, '0');
    const id = newId('otp');
    await repo.createOtp({
      id, purpose, phone, ip, codeHash: deliverable ? sha256(`${id}:${code}`) : 'none',
      createdAt: now, expiresAt: new Date(now.getTime() + policy.ttlMinutes * 60_000), attempts: 0, usedAt: null,
    });
    await repo.deleteOtpsBefore(new Date(now.getTime() - 24 * HOUR));
    return code;
  }

  /** The latest [purpose] code for [phone], if [given] matches it. Counts the try; doesn't use the code up. */
  private async checkCode(phone: string, given: string, purpose: OtpPurpose, now: Date): Promise<OtpCode> {
    const { repo, policy } = this.d;
    const code = given.trim();
    if (!new RegExp(`^\\d{${policy.length}}$`).test(code)) throw badRequest(`Enter the ${policy.length}-digit code.`);
    const otp = await repo.latestOtp(phone, purpose);
    if (!otp || otp.usedAt || otp.expiresAt <= now) throw new AppError(401, 'otp_expired', 'This code has expired. Ask for a new one.');
    if (otp.attempts >= policy.maxAttempts) throw new AppError(429, 'otp_attempts', 'Too many wrong codes. Ask for a new one.');
    // Counted before checking, so parallel guesses can't get past the cap.
    const attempts = await repo.addOtpAttempt(otp.id);
    if (!sameSecret(sha256(`${otp.id}:${code}`), otp.codeHash)) {
      const left = policy.maxAttempts - attempts;
      throw new AppError(401, 'otp_invalid', left > 0 ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Wrong code. Ask for a new one.');
    }
    return otp;
  }

  /** Marks the code used. Of two requests racing with the same code, only one gets past here. */
  private async useCode(otp: OtpCode, now: Date): Promise<void> {
    if (!(await this.d.repo.useOtp(otp.id, now))) throw new AppError(401, 'otp_expired', 'This code was already used. Ask for a new one.');
  }

  private async startSession(user: User, client: Client, from: { device: string; ip: string }, now: Date): Promise<TokenPair> {
    const session: Session = {
      id: newId('ses'),
      userId: user.id,
      clientId: client.id,
      device: from.device.slice(0, 100),
      ip: from.ip,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + client.refreshTtlSeconds * 1000),
      revokedAt: null,
      revokedReason: null,
    };
    const refresh = newToken('rt');
    await this.d.repo.createSession(session, sha256(refresh));
    return this.pair(session, client, refresh);
  }

  private pair(session: Session, client: Client, refresh: string): TokenPair {
    const { token, expiresAt } = this.d.signer.sign({ sub: session.userId, aud: client.id, sid: session.id }, client.accessTtlSeconds);
    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn: Math.round((expiresAt.getTime() - this.d.clock().getTime()) / 1000),
      refreshToken: refresh,
      refreshExpiresAt: session.expiresAt.toISOString(),
      sessionId: session.id,
    };
  }

  private async client(id: string, grant: GrantType): Promise<Client> {
    const client = await this.d.repo.client(id);
    if (!client) throw unauthorized('Unknown client_id.');
    if (!client.grantTypes.includes(grant)) throw forbidden(`This client may not use the ${grant} grant.`);
    return client;
  }

  /** Tries each channel that can reach [to] until one succeeds. [userId] is null for someone signing up. */
  private async deliver(to: { phone: string; email: string | null }, code: string, userId: string | null): Promise<void> {
    let last: unknown = null;
    for (const channel of this.d.channels.filter((c) => c.canReach(to))) {
      try {
        await channel.send(to, code, this.d.policy.ttlMinutes);
        return;
      } catch (e) {
        last = e;
        this.d.log.warn({ ...(userId === null ? {} : { userId }), op: channel.name, reason: (e as Error).message }, 'otp channel failed; trying the next');
      }
    }
    if (last instanceof Error) throw last;
    throw new AppError(503, 'otp_unavailable', 'Sign-in codes can\'t be sent right now.');
  }
}

function limit(times: Date[], max: number, now: Date, message: string) {
  if (times.length < max) return;
  const oldest = times[0] ?? now;
  const retry = oldest.getTime() + HOUR - now.getTime();
  throw tooManyRequests(message, Math.max(1, Math.ceil(retry / 1000)));
}
