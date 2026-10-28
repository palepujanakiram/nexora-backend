import { OtpProviderError } from '../domain/errors.ts';
import { readJson, type Fetch } from './broker-api.ts';

export const MSG91_BASE = 'https://control.msg91.com/api/v5';

/** Sends and checks SMS one-time passwords. The provider generates and holds the code. */
export interface OtpSender {
  /** Texts a new [length]-digit code to [mobile] (`91XXXXXXXXXX`), valid for [expiryMinutes]. */
  send(mobile: string, options: { length: number; expiryMinutes: number }): Promise<void>;
  /** Whether [otp] is the code last sent to [mobile]. Throws when the provider itself fails. */
  verify(mobile: string, otp: string): Promise<boolean>;
}

export interface Msg91Args {
  fetch: Fetch;
  /** The MSG91 auth key. Sent only in the `authkey` header, never logged. */
  authKey: string;
  /** The approved (DLT) OTP template that carries the `##OTP##` placeholder. */
  templateId: string;
}

// MSG91 answers a wrong, expired or reused code with HTTP 200 and `type: "error"`.
const CODE_REJECTED = /not match|expired|already verified|invalid otp|max limit/i;

/**
 * MSG91's OTP API (docs.msg91.com → OTP): `POST /otp` sends a code,
 * `GET /otp/verify` checks it. Both answer `{ type: "success" | "error", message }`.
 */
export class Msg91Otp implements OtpSender {
  private readonly args: Msg91Args;

  constructor(args: Msg91Args) {
    this.args = args;
  }

  async send(mobile: string, options: { length: number; expiryMinutes: number }): Promise<void> {
    const query = new URLSearchParams({
      template_id: this.args.templateId,
      mobile,
      otp_length: String(options.length),
      otp_expiry: String(options.expiryMinutes),
    });
    const body = await this.call(`${MSG91_BASE}/otp?${query}`, 'POST');
    if (body.type !== 'success') throw new OtpProviderError(`Couldn't send the code: ${messageOf(body)}`);
  }

  async verify(mobile: string, otp: string): Promise<boolean> {
    const body = await this.call(`${MSG91_BASE}/otp/verify?${new URLSearchParams({ otp, mobile })}`, 'GET');
    if (body.type === 'success') return true;
    if (CODE_REJECTED.test(messageOf(body))) return false;
    throw new OtpProviderError(`Couldn't check the code: ${messageOf(body)}`);
  }

  private async call(url: string, method: string): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { authkey: this.args.authKey, accept: 'application/json' };
    if (method === 'POST') headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.args.fetch(url, { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) });
    } catch {
      throw new OtpProviderError('Couldn\'t reach the SMS provider. Try again.');
    }
    const body = await readJson(res);
    if (!res.ok || !body) {
      throw new OtpProviderError(`The SMS provider failed (HTTP ${res.status})${body ? `: ${messageOf(body)}` : '.'}`);
    }
    return body;
  }
}

const messageOf = (body: Record<string, unknown>) =>
  typeof body.message === 'string' && body.message ? body.message : 'no reason given';
