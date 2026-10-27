import { createHash } from 'node:crypto';

import type { BrokerAccount } from '../domain/account.ts';
import { BrokerApiError } from '../domain/errors.ts';
import { contractLabel, exchangeOf, type TradeSignal } from '../domain/signal.ts';
import { hasExits, type PlacedOrder, type ResolvedInstrument, type TradePlan } from '../domain/trade.ts';
import {
  JSON_HEADERS,
  parseCsv,
  readJson,
  type BrokerApi,
  type BrokerClientArgs,
  type BrokerDeps,
  type LoginMethod,
} from './broker-api.ts';

const BASE = 'https://api.groww.in';
export const GROWW_INSTRUMENTS_URL = 'https://growwapi-assets.groww.in/instruments/instrument.csv';
export const GROWW_API_KEYS_PAGE = 'https://groww.in/trade-api/api-keys';

/**
 * Groww Trade API. Docs: https://groww.in/trade-api/docs/curl
 *
 * Groww has no redirect login: the user approves the API key for the day on
 * Groww's API Keys page, then the server creates a token from the key and a
 * checksum of the secret (or from a TOTP code).
 *
 * Stop loss / target aren't placed: Groww's OCO needs an existing position,
 * so it can only be created after the entry fills.
 */
export class GrowwApi implements BrokerApi {
  private readonly account: BrokerAccount;
  private readonly deps: BrokerDeps;

  constructor({ account, ...deps }: BrokerClientArgs) {
    this.account = account;
    this.deps = deps;
  }

  login(): LoginMethod {
    return { kind: 'approval', url: GROWW_API_KEYS_PAGE };
  }

  /** [input] is empty for the daily-approval flow, or a 6-digit TOTP code. */
  async exchangeToken(input: string): Promise<string> {
    const code = input.trim();
    let body: Record<string, string>;
    if (/^\d{6}$/.test(code)) {
      body = { key_type: 'totp', totp: code };
    } else if (code === '') {
      const timestamp = String(Math.floor(this.deps.clock().getTime() / 1000));
      const checksum = createHash('sha256').update(`${this.account.apiSecret}${timestamp}`).digest('hex');
      body = { key_type: 'approval', checksum, timestamp };
    } else {
      throw new BrokerApiError('Groww: leave the box empty, or enter the 6-digit TOTP code.');
    }
    const res = await this.deps.fetch(`${BASE}/v1/token/api/access`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.account.apiKey}`, ...JSON_HEADERS },
      body: JSON.stringify(body),
    });
    const data = await decode(res);
    const payload = data['payload'] as Record<string, unknown> | undefined;
    const token = data['token'] ?? payload?.['token'];
    if (res.status >= 300 || typeof token !== 'string' || token === '') {
      throw new BrokerApiError(`Groww: ${errorOf(data, res)}`);
    }
    return token;
  }

  async resolve(signal: TradeSignal): Promise<ResolvedInstrument> {
    const exchange = exchangeOf(signal) === 'BFO' ? 'BSE' : 'NSE';
    const rows = await this.deps.cache.get('groww', this.deps.clock(), async () => {
      const res = await this.deps.fetch(GROWW_INSTRUMENTS_URL);
      if (res.status !== 200) throw new BrokerApiError(`Groww instruments download failed (${res.status}).`);
      // The list covers every segment; keep only F&O to save memory.
      const rows = parseCsv(await res.text()).filter((r) => r['segment'] === 'FNO');
      if (rows.length === 0) throw new BrokerApiError('Groww instruments list had no F&O contracts.');
      return rows;
    });
    const row = rows.find(
      (r) =>
        r['exchange'] === exchange &&
        r['segment'] === 'FNO' &&
        r['underlying_symbol'] === signal.underlying &&
        r['instrument_type'] === signal.optionType &&
        r['expiry_date'] === signal.expiry &&
        Number(r['strike_price']) === signal.strike,
    );
    if (!row) throw new BrokerApiError(`No Groww contract found for ${contractLabel(signal)} on ${exchange}.`);
    return {
      symbol: row['trading_symbol']!,
      exchange,
      lotSize: Number(row['lot_size']),
      tickSize: Number(row['tick_size']) || 0.05,
    };
  }

  async placeTrade(inst: ResolvedInstrument, plan: TradePlan): Promise<PlacedOrder[]> {
    const res = await this.deps.fetch(`${BASE}/v1/order/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.account.accessToken}`,
        Accept: 'application/json',
        'X-API-VERSION': '1.0',
        ...JSON_HEADERS,
      },
      body: JSON.stringify({
        trading_symbol: inst.symbol,
        quantity: plan.quantity,
        price: Number(plan.entryPrice.toFixed(2)),
        validity: 'DAY',
        exchange: inst.exchange,
        segment: 'FNO',
        product: plan.product === 'intraday' ? 'MIS' : 'NRML',
        order_type: 'LIMIT',
        transaction_type: plan.signal.action,
        order_reference_id: this.referenceId(),
      }),
    });
    const data = await decode(res);
    const payload = data['payload'] as Record<string, unknown> | undefined;
    if (res.status >= 300 || data['status'] !== 'SUCCESS' || !payload) {
      throw new BrokerApiError(`Groww: ${errorOf(data, res)}`);
    }
    const orders: PlacedOrder[] = [{ kind: 'ENTRY', id: String(payload['groww_order_id']) }];
    if (hasExits(plan)) {
      orders.push({
        kind: `SL ${plan.stopLoss} / TGT ${plan.target}`,
        id: 'not placed: add an OCO in the Groww app after the entry fills',
      });
    }
    return orders;
  }

  /** 8–20 characters, letters/digits and at most two hyphens. */
  private referenceId(): string {
    const suffix = String(Math.floor(this.deps.random() * 1000)).padStart(3, '0');
    return `NX${this.deps.clock().getTime()}${suffix}`;
  }
}

async function decode(res: Response): Promise<Record<string, unknown>> {
  const body = await readJson(res);
  if (body) return body;
  if (res.status >= 300) throw new BrokerApiError(`Groww returned HTTP ${res.status}.`);
  return {};
}

function errorOf(body: Record<string, unknown>, res: Response): string {
  const error = body['error'] as { message?: unknown } | undefined;
  if (error?.message) return String(error.message);
  return String(body['message'] ?? `HTTP ${res.status}`);
}
