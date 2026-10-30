import { AppError } from '../domain/errors.ts';
import { hmacSha256, sameSecret } from '../data/crypto.ts';
import { objectOf, type Fetch } from './http.ts';

export const RAZORPAY_BASE = 'https://api.razorpay.com/v1';

export interface RazorpaySubscription {
  id: string;
  status: string;
  shortUrl: string | null;
  /** End of the current billing period. */
  currentEnd: Date | null;
}

/** The few Razorpay Subscriptions API calls billing needs. Docs: https://razorpay.com/docs/api/payments/subscriptions/ */
export class RazorpayClient {
  private readonly args: { fetch: Fetch; keyId: string; keySecret: string; webhookSecret: string };

  constructor(args: { fetch: Fetch; keyId: string; keySecret: string; webhookSecret: string }) {
    this.args = args;
  }

  async createSubscription(input: { planId: string; totalCount: number; notes: Record<string, string> }): Promise<RazorpaySubscription> {
    return this.call('POST', '/subscriptions', { plan_id: input.planId, total_count: input.totalCount, customer_notify: 1, notes: input.notes });
  }

  /** Cancels at the end of the current period, so the user keeps what they paid for. */
  async cancelAtCycleEnd(id: string): Promise<RazorpaySubscription> {
    return this.call('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: 1 });
  }

  /** Checks `X-Razorpay-Signature`: HMAC-SHA256 of the raw body with the webhook secret. */
  verifyWebhook(rawBody: string, signature: string): boolean {
    return sameSecret(signature, hmacSha256(this.args.webhookSecret, rawBody));
  }

  private async call(method: string, path: string, body: unknown): Promise<RazorpaySubscription> {
    const auth = Buffer.from(`${this.args.keyId}:${this.args.keySecret}`).toString('base64');
    let res: Response;
    try {
      res = await this.args.fetch(`${RAZORPAY_BASE}${path}`, {
        method,
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AppError(502, 'payment_provider_error', 'Couldn\'t reach Razorpay. Try again.');
    }
    let data: Record<string, unknown> = {};
    try {
      data = objectOf(await res.json());
    } catch {
      // not JSON
    }
    if (!res.ok) {
      const error = objectOf(data['error']);
      throw new AppError(502, 'payment_provider_error', `Razorpay: ${typeof error['description'] === 'string' ? error['description'] : `HTTP ${res.status}`}`);
    }
    return toSubscription(data);
  }
}

export function toSubscription(e: Record<string, unknown>): RazorpaySubscription {
  const end = Number(e['current_end']);
  return {
    id: String(e['id']),
    status: String(e['status'] ?? ''),
    shortUrl: typeof e['short_url'] === 'string' ? e['short_url'] : null,
    currentEnd: Number.isFinite(end) && end > 0 ? new Date(end * 1000) : null,
  };
}
