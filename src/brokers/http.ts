import { gunzipSync } from 'node:zlib';

import { BrokerError, type RawExchange } from '../domain/broker-error.ts';
import type { Log } from '../logging.ts';

export type Fetch = typeof fetch;

/**
 * `read` and `auth` calls always go out. `write` calls (place, modify, cancel)
 * are logged and not sent in dry-run mode.
 */
export type CallKind = 'read' | 'auth' | 'write';

export interface HttpRequest {
  kind: CallKind;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** A JSON body (object), or a form body (URLSearchParams). */
  json?: unknown;
  form?: Record<string, string>;
}

export interface HttpResult {
  status: number;
  /** Parsed JSON, or null when the body wasn't JSON. */
  body: unknown;
  text: string;
  raw: RawExchange;
}

export interface BrokerHttpOptions {
  broker: string;
  fetch: Fetch;
  timeoutMs: number;
  /** Don't send `write` calls; log the exact request instead. */
  dryRun: boolean;
  log: Log;
  /** Waits for this account's rate-limit token. Throws RATE_LIMITED when none comes in time. */
  acquire?: () => Promise<void>;
}

/** Keys whose values never reach logs or the audit trail. */
const SECRET_KEYS = new Set(
  [
    'authorization', 'api_key', 'apikey', 'api_secret', 'client_secret', 'secret', 'password', 'pin', 'mpin',
    'totp', 'checksum', 'access_token', 'refresh_token', 'refreshtoken', 'jwttoken', 'feedtoken', 'token',
    'request_token', 'code', 'x-privatekey', 'authkey',
  ],
);

/** A copy of [value] with secret-named keys replaced, recursively. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v)]),
    );
  }
  return value;
}

/** [url] with secret query parameters replaced. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (SECRET_KEYS.has(key.toLowerCase())) u.searchParams.set(key, '[redacted]');
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * The body as text. Some instrument masters (Upstox's `complete.json.gz`) are
 * served as raw gzip files rather than with `Content-Encoding`, so a gzip
 * body is unpacked here.
 */
export function decode(bytes: Buffer): string {
  const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  return (gzipped ? gunzipSync(bytes) : bytes).toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The one way adapters talk to brokers: rate limit, timeout, dry run, and a
 * credential-free record of every exchange for the audit trail. Timeouts,
 * network failures and 5xx answers throw TIMEOUT / BROKER_UNAVAILABLE, which
 * on a write mean "outcome unknown"; 429 throws RATE_LIMITED. Other statuses
 * are returned for the adapter to interpret.
 */
export class BrokerHttp {
  private readonly o: BrokerHttpOptions;

  constructor(options: BrokerHttpOptions) {
    this.o = options;
  }

  get dryRun(): boolean {
    return this.o.dryRun;
  }

  async send(req: HttpRequest): Promise<HttpResult> {
    const headers: Record<string, string> = { Accept: 'application/json', ...req.headers };
    let body: string | undefined;
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      headers['Content-Type'] = 'application/json';
    } else if (req.form) {
      body = new URLSearchParams(req.form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const request = { method: req.method, url: redactUrl(req.url), body: redact(req.json ?? req.form ?? null) };
    const { broker } = this.o;

    if (req.kind === 'write' && this.o.dryRun) {
      this.o.log.info({ broker, dryRunRequest: request }, 'dry run: broker write not sent');
      throw new BrokerError('DRY_RUN', `Dry run: not sent to ${broker}.`, { request, response: null });
    }
    await this.o.acquire?.();

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new BrokerError('TIMEOUT', `${broker} did not answer within ${this.o.timeoutMs} ms.`, { request, response: null }));
      }, this.o.timeoutMs);
    });
    let res: Response;
    let text: string;
    try {
      res = await Promise.race([this.o.fetch(req.url, { method: req.method, headers, body, signal: controller.signal }), timeout]);
      text = decode(Buffer.from(await Promise.race([res.arrayBuffer(), timeout])));
    } catch (e) {
      if (e instanceof BrokerError) throw e;
      throw new BrokerError('BROKER_UNAVAILABLE', `Couldn't reach ${broker}.`, { request, response: null });
    } finally {
      clearTimeout(timer);
    }
    const parsed = parseJson(text);
    const raw: RawExchange = { request, response: { status: res.status, body: redact(parsed ?? text.slice(0, 2000)) } };
    if (res.status === 429) {
      this.o.log.warn({ broker, status: 429 }, 'broker rate limit hit');
      throw new BrokerError('RATE_LIMITED', `${broker} is rate limiting requests. Try again shortly.`, raw);
    }
    if (res.status >= 500) {
      throw new BrokerError('BROKER_UNAVAILABLE', `${broker} failed (HTTP ${res.status}).`, raw);
    }
    return { status: res.status, body: parsed, text, raw };
  }
}

/** The JSON object in [r], or an empty one. */
export const objectOf = (r: unknown): Record<string, unknown> =>
  r !== null && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : {};

/** Splits one CSV line, honouring double-quoted fields that contain commas. */
export function splitCsv(line: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(buf);
      buf = '';
    } else buf += ch;
  }
  out.push(buf);
  return out;
}

/** Parses a CSV document with a header row into one record per line. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/);
  const header = splitCsv(lines[0] ?? '');
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cells = splitCsv(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      if (i < cells.length) row[h] = cells[i]!;
    });
    rows.push(row);
  }
  return rows;
}

/** Accepts either a bare code or a full redirect URL containing [param]. */
export function extractParam(params: Readonly<Record<string, string>>, param: string): string {
  const direct = params[param]?.trim();
  if (direct) return direct;
  const pasted = params['url']?.trim() ?? '';
  try {
    const fromUrl = new URL(pasted).searchParams.get(param);
    if (fromUrl) return fromUrl;
  } catch {
    // not a URL
  }
  throw new BrokerError('AUTH_EXPIRED', `No "${param}" in the broker's redirect.`);
}
