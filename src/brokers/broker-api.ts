import type { BrokerAccount } from '../domain/account.ts';
import { BrokerApiError } from '../domain/errors.ts';
import { istDate } from '../domain/ist.ts';
import type { TradeSignal } from '../domain/signal.ts';
import type { PlacedOrder, ResolvedInstrument, TradePlan } from '../domain/trade.ts';

/** How the user logs in to a broker for the day. */
export type LoginMethod =
  /** Open [url]; the broker redirects back with [codeParam] in the address. */
  | { kind: 'redirect'; url: string; codeParam: string; redirectUri: string | null }
  /** Approve the key on the broker's page at [url], then connect with no code (or a TOTP). */
  | { kind: 'approval'; url: string };

/** Remote API for one broker account. */
export interface BrokerApi {
  login(): LoginMethod;
  /** Turns the redirect URL / code (or TOTP, or nothing for Groww) into an access token. */
  exchangeToken(input: string): Promise<string>;
  resolve(signal: TradeSignal): Promise<ResolvedInstrument>;
  placeTrade(instrument: ResolvedInstrument, plan: TradePlan): Promise<PlacedOrder[]>;
}

export type Fetch = typeof fetch;

/** What every broker client needs from the outside world. */
export interface BrokerDeps {
  fetch: Fetch;
  clock: () => Date;
  cache: InstrumentCache;
  /** A number in [0, 1), like `Math.random`. */
  random: () => number;
}

export interface BrokerClientArgs extends BrokerDeps {
  account: BrokerAccount;
}

/**
 * Instrument lists are several MB and change once a day, so they're cached per
 * key (e.g. `zerodha:BFO`) for the current day in India, across all accounts.
 */
export class InstrumentCache {
  private readonly entries = new Map<string, { day: string; rows: Record<string, string>[] }>();

  async get(key: string, now: Date, load: () => Promise<Record<string, string>[]>) {
    const day = istDate(now);
    const hit = this.entries.get(key);
    if (hit?.day === day) return hit.rows;
    const rows = await load();
    this.entries.set(key, { day, rows });
    return rows;
  }
}

/** Accepts either a bare code or a full redirect URL containing [param]. */
export function extractParam(input: string, param: string): string {
  const trimmed = input.trim();
  let fromUrl: string | null = null;
  try {
    fromUrl = new URL(trimmed).searchParams.get(param);
  } catch {
    // Not a URL: treat it as the bare code.
  }
  if (fromUrl) return fromUrl;
  if (!trimmed) throw new BrokerApiError(`No "${param}" given.`);
  if (trimmed.includes('://') || trimmed.includes('?')) {
    throw new BrokerApiError(`No "${param}" found in the pasted URL.`);
  }
  return trimmed;
}

/** Splits one CSV line, honouring double-quoted fields that contain commas. */
export function splitCsv(line: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
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

/** Reads a JSON object body, or null when the body isn't one. */
export async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

export const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' };
export const JSON_HEADERS = { 'Content-Type': 'application/json' };
