import type { OtpSender } from '../brokers/msg91.ts';
import { newId } from '../data/crypto.ts';
import type { OtpRepository } from '../data/otp.ts';
import type { UserRepository } from '../data/users.ts';
import { AppError, badRequest, forbidden, tooManyRequests } from '../domain/errors.ts';
import { resolveIndianMobile } from '../domain/phone.ts';
import { sameSecret, type AuthService, type SignedIn } from './auth.ts';

/** Limits on sending and checking codes. Tests may shrink them. */
export interface OtpLimits {
  length: number;
  /** Codes per number per [phoneWindowMs] (ManageMyFloor: 5 per 15 minutes). */
  perPhone: number;
  phoneWindowMs: number;
  /** Codes per client IP per hour. */
  perIpPerHour: number;
  /** Tries at one code before a new one is needed. */
  maxAttempts: number;
}

export const DEFAULT_OTP_LIMITS: OtpLimits = {
  length: 6,
  perPhone: 5,
  phoneWindowMs: 15 * 60 * 1000,
  perIpPerHour: 20,
  maxAttempts: 5,
};

export interface OtpLoginDeps {
  users: UserRepository;
  otps: OtpRepository;
  auth: AuthService;
  /** Null when MSG91 isn't configured: OTP sign-in is off. */
  sender: OtpSender | null;
  clock: () => Date;
  /** Same invite code as email sign-up. A new number needs it; null closes sign-up. */
  signupCode: string | null;
  expiryMinutes: number;
  limits?: OtpLimits;
}

/** The number as either `{ phone }` or `{ countryCode, mobile }`. */
export interface PhoneInput {
  phone?: string | undefined;
  countryCode?: string | undefined;
  mobile?: string | undefined;
}

export interface OtpSent {
  sent: true;
  expires_in_seconds: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const notRegistered = (message: string) => new AppError(404, 'not_registered', message);

/**
 * Sign-in with an Indian mobile number and a code texted by MSG91, mirroring
 * ManageMyFloor's `/auth/otp/start` + `/auth/otp/verify`. Signs in the user
 * with that number, or creates one when the code was asked for with the
 * invite code.
 */
export class OtpLoginService {
  private readonly deps: OtpLoginDeps;
  private readonly limits: OtpLimits;

  constructor(deps: OtpLoginDeps) {
    this.deps = deps;
    this.limits = deps.limits ?? DEFAULT_OTP_LIMITS;
  }

  async start(input: PhoneInput & { ip: string; signupCode?: string | undefined }): Promise<OtpSent> {
    const sender = this.sender();
    const phone = resolveIndianMobile(input);
    const now = this.deps.clock();
    const { otps } = this.deps;
    const limits = this.limits;

    const newUser = !this.deps.users.findByPhone(phone);
    if (newUser) this.checkInvite(input.signupCode);

    const byPhone = otps.sentToPhoneSince(phone, new Date(now.getTime() - limits.phoneWindowMs));
    checkLimit(byPhone, limits.perPhone, limits.phoneWindowMs, now, 'Too many OTP requests. Try again later.');
    const byIp = otps.sentFromIpSince(input.ip, new Date(now.getTime() - HOUR));
    checkLimit(byIp, limits.perIpPerHour, HOUR, now, 'Too many OTP requests from this network. Try again later.');

    await sender.send(phone, { length: limits.length, expiryMinutes: this.deps.expiryMinutes });
    otps.deleteOlderThan(new Date(now.getTime() - DAY));
    otps.create({
      id: newId(),
      phone,
      ip: input.ip,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.deps.expiryMinutes * 60_000),
      attempts: 0,
      verifiedAt: null,
      allowSignup: newUser,
    });
    return { sent: true, expires_in_seconds: this.deps.expiryMinutes * 60 };
  }

  async verify(input: PhoneInput & { code: string; device: string }): Promise<SignedIn & { expiresInSeconds: number }> {
    const sender = this.sender();
    const phone = resolveIndianMobile(input);
    const code = input.code.trim();
    if (!new RegExp(`^\\d{${this.limits.length}}$`).test(code)) {
      throw badRequest(`Enter the ${this.limits.length}-digit code from the SMS.`);
    }
    const now = this.deps.clock();
    const request = this.deps.otps.latest(phone);
    if (!request || request.verifiedAt || request.expiresAt.getTime() <= now.getTime()) {
      throw new AppError(401, 'otp_expired', 'This code has expired. Ask for a new one.');
    }
    if (request.attempts >= this.limits.maxAttempts) {
      throw new AppError(429, 'otp_attempts', 'Too many wrong codes. Ask for a new one.');
    }
    // Count the try before asking MSG91, so parallel guesses can't skip the cap.
    const attempts = this.deps.otps.addAttempt(request.id);
    if (!(await sender.verify(phone, code))) {
      const left = this.limits.maxAttempts - attempts;
      throw new AppError(
        401,
        'otp_invalid',
        left > 0 ? `Invalid OTP. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Invalid OTP. Ask for a new one.',
      );
    }
    this.deps.otps.markVerified(request.id, now);

    let user = this.deps.users.findByPhone(phone);
    if (!user) {
      // The invite was checked when the code was sent; sign-up may have closed since.
      if (!request.allowSignup || !this.deps.signupCode) throw notRegistered('This phone number is not registered.');
      user = this.deps.users.create({ id: newId(), email: null, phone, createdAt: now }, null);
    }
    const session = this.deps.auth.startSession(user, input.device);
    return { ...session, expiresInSeconds: Math.round((session.expiresAt.getTime() - now.getTime()) / 1000) };
  }

  private sender(): OtpSender {
    if (!this.deps.sender) throw new AppError(503, 'otp_unavailable', 'Mobile sign-in isn\'t set up on this server.');
    return this.deps.sender;
  }

  private checkInvite(given: string | undefined) {
    const expected = this.deps.signupCode;
    if (!expected) throw notRegistered('This phone number is not registered.');
    if (!given?.trim()) throw notRegistered('This phone number is not registered. Enter the invite code to sign up.');
    if (!sameSecret(given.trim(), expected)) throw forbidden('Wrong invite code.');
  }
}

/** Refuses when [times] (oldest first, inside the window) already hold [max] sends. */
function checkLimit(times: Date[], max: number, windowMs: number, now: Date, message: string) {
  if (times.length < max) return;
  const retryAfterMs = times[0]!.getTime() + windowMs - now.getTime();
  throw tooManyRequests(message, Math.max(1, Math.ceil(retryAfterMs / 1000)));
}
