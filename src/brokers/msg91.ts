import { OtpProviderError } from '../domain/errors.ts';
import { objectOf, type Fetch } from './http.ts';

export const MSG91_BASE = 'https://control.msg91.com/api/v5';

/** Delivers a one-time code. The server generates the code; the channel only carries it. */
export interface OtpChannel {
  readonly name: string;
  /** Whether this channel can reach the user (e.g. email needs an address). */
  canReach(to: { phone: string; email: string | null }): boolean;
  send(to: { phone: string; email: string | null }, code: string, ttlMinutes: number): Promise<void>;
}

export interface Msg91Args {
  fetch: Fetch;
  /** The MSG91 auth key. Sent only in the `authkey` header, never logged. */
  authKey: string;
  /** The approved (DLT) OTP template that carries the `##OTP##` placeholder. */
  templateId: string;
}

/**
 * SMS through MSG91's OTP API (docs.msg91.com → OTP), passing our own code
 * in `otp` so that only its hash is stored, here. Answers are
 * `{ type: "success" | "error", message }`.
 */
export class Msg91Sms implements OtpChannel {
  readonly name = 'sms';
  private readonly args: Msg91Args;

  constructor(args: Msg91Args) {
    this.args = args;
  }

  canReach(): boolean {
    return true;
  }

  async send(to: { phone: string }, code: string, ttlMinutes: number): Promise<void> {
    const query = new URLSearchParams({
      template_id: this.args.templateId,
      mobile: to.phone,
      otp: code,
      otp_length: String(code.length),
      otp_expiry: String(ttlMinutes),
    });
    let res: Response;
    try {
      res = await this.args.fetch(`${MSG91_BASE}/otp?${query.toString()}`, {
        method: 'POST',
        headers: { authkey: this.args.authKey, accept: 'application/json', 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new OtpProviderError('otp_send_failed', 'Couldn\'t reach the SMS provider.');
    }
    let body: Record<string, unknown> = {};
    try {
      body = objectOf(await res.json());
    } catch {
      // not JSON
    }
    const message = typeof body['message'] === 'string' ? body['message'] : `HTTP ${res.status}`;
    if (!res.ok || body['type'] !== 'success') throw new OtpProviderError('otp_send_failed', `The SMS provider refused: ${message}`);
  }
}

/** Development only: prints the code to the server console. Refused in production by config. */
export class ConsoleOtp implements OtpChannel {
  readonly name = 'console';
  private readonly print: (line: string) => void;

  constructor(print: (line: string) => void) {
    this.print = print;
  }

  canReach(): boolean {
    return true;
  }

  async send(to: { phone: string }, code: string): Promise<void> {
    this.print(`[dev] OTP for +${to.phone}: ${code}`);
  }
}

// TODO(email OTP): the brief asks for an email fallback when SMS fails. No email
// provider has been chosen yet; implement OtpChannel for it and add it after SMS
// in the container's channel list.
