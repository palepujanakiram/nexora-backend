import type { OtpSender } from '../brokers/msg91.ts';
import { newId } from '../data/crypto.ts';
import type { OtpRepository } from '../data/otp.ts';
import type { UserRepository } from '../data/users.ts';
import { AppError, badRequest, forbidden, tooManyRequests } from '../domain/errors.ts';
import { e164, normalizeIndianMobile } from '../domain/phone.ts';
import { sameSecret, type AuthService, type SignedIn } from './auth.ts';

/** Limits on sending and checking codes. Tests may shrink them. */
export interface OtpLimits {
  length: number;
  /** Minimum gap between two codes to the same number. */
  resendAfterMs: number;
  /** Codes per number per hour. */
  perPhonePerHour: number;
  /** Codes per client IP per hour. */
  perIpPerHour: number;
  /** Tries at one code before a new one is needed. */
  maxAttempts: number;
}

export const DEFAULT_OTP_LIMITS: OtpLimits = {
  length: 6,
  resendAfterMs: 30_000,
  perPhonePerHour: 5,
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

export interface OtpSent {
  /** `+91XXXXXXXXXX`. */
  mobile: string;
  /** True when verifying will create a new user. */
  newUser: boolean;
  expiresInSeconds: number;
  resendInSeconds: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const otpError = (status: number, code: string, message: string) => new AppError(status, code, message);

/**
 * Sign-in with an Indian mobile number and a code texted by MSG91. Signs in the
 * user with that number, or creates one when the code was asked for with the
 * invite code.
 */
export class OtpLoginService {
  private readonly deps: OtpLoginDeps;
  private readonly limits: OtpLimits;

  constructor(deps: OtpLoginDeps) {
    this.deps = deps;
    this.limits = deps.limits ?? DEFAULT_OTP_LIMITS;
  }

  async send(input: { mobile: string; ip: string; signupCode?: string | undefined }): Promise<OtpSent> {
    const sender = this.sender();
    const phone = normalizeIndianMobile(input.mobile);
    const now = this.deps.clock();
    const { otps } = this.deps;
    const limits = this.limits;

    const last = otps.latest(phone);
    const wait = last ? last.createdAt.getTime() + limits.resendAfterMs - now.getTime() : 0;
    if (wait > 0) throw tooManyRequests(`Wait ${Math.ceil(wait / 1000)} seconds before asking for another code.`);
    const hourAgo = new Date(now.getTime() - HOUR);
    if (otps.countForPhoneSince(phone, hourAgo) >= limits.perPhonePerHour) {
      throw tooManyRequests('Too many codes sent to this number. Try again in an hour.');
    }
    if (otps.countForIpSince(input.ip, hourAgo) >= limits.perIpPerHour) {
      throw tooManyRequests('Too many codes requested from this network. Try again in an hour.');
    }

    const newUser = !this.deps.users.findByPhone(phone);
    if (newUser) this.checkInvite(input.signupCode);

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
    return {
      mobile: e164(phone),
      newUser,
      expiresInSeconds: this.deps.expiryMinutes * 60,
      resendInSeconds: Math.ceil(limits.resendAfterMs / 1000),
    };
  }

  async verify(input: { mobile: string; otp: string; device: string }): Promise<SignedIn> {
    const sender = this.sender();
    const phone = normalizeIndianMobile(input.mobile);
    const otp = input.otp.trim();
    if (!new RegExp(`^\\d{${this.limits.length}}$`).test(otp)) {
      throw badRequest(`Enter the ${this.limits.length}-digit code from the SMS.`);
    }
    const now = this.deps.clock();
    const request = this.deps.otps.latest(phone);
    if (!request || request.verifiedAt || request.expiresAt.getTime() <= now.getTime()) {
      throw otpError(401, 'otp_expired', 'This code has expired. Ask for a new one.');
    }
    if (request.attempts >= this.limits.maxAttempts) {
      throw otpError(429, 'otp_attempts', 'Too many wrong codes. Ask for a new one.');
    }
    // Count the try before asking MSG91, so parallel guesses can't skip the cap.
    const attempts = this.deps.otps.addAttempt(request.id);
    if (!(await sender.verify(phone, otp))) {
      const left = this.limits.maxAttempts - attempts;
      throw otpError(
        401,
        'otp_invalid',
        left > 0 ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Wrong code. Ask for a new one.',
      );
    }
    this.deps.otps.markVerified(request.id, now);

    let user = this.deps.users.findByPhone(phone);
    if (!user) {
      // The invite was checked when the code was sent; sign-up may have closed since.
      if (!request.allowSignup || !this.deps.signupCode) {
        throw forbidden('This number has no login. Ask for a new code with the invite code.');
      }
      user = this.deps.users.create({ id: newId(), email: null, phone, createdAt: now }, null);
    }
    return this.deps.auth.startSession(user, input.device);
  }

  private sender(): OtpSender {
    if (!this.deps.sender) throw otpError(503, 'otp_unavailable', 'Mobile sign-in isn\'t set up on this server.');
    return this.deps.sender;
  }

  private checkInvite(given: string | undefined) {
    const expected = this.deps.signupCode;
    if (!expected) throw forbidden('This number has no login, and registration is closed on this server.');
    if (!given?.trim()) {
      throw otpError(403, 'signup_code_required', 'This number has no login yet. Enter the invite code to sign up.');
    }
    if (!sameSecret(given.trim(), expected)) throw forbidden('Wrong invite code.');
  }
}
