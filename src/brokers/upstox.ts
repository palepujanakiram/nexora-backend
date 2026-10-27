import type { BrokerAccount } from '../domain/account.ts';
import { BrokerApiError } from '../domain/errors.ts';
import { contractLabel, exchangeOf, isBuy, type TradeSignal } from '../domain/signal.ts';
import { hasExits, type PlacedOrder, type ResolvedInstrument, type TradePlan } from '../domain/trade.ts';
import {
  FORM_HEADERS,
  JSON_HEADERS,
  extractParam,
  form,
  readJson,
  type BrokerApi,
  type BrokerClientArgs,
  type BrokerDeps,
  type LoginMethod,
} from './broker-api.ts';

const BASE = 'https://api.upstox.com';
const HFT = 'https://api-hft.upstox.com';

/**
 * Option-chain lookups need the underlying's instrument key. Stock options
 * need ISIN-based keys and are not mapped yet.
 */
export const UPSTOX_UNDERLYING_KEYS: Record<string, string> = {
  NIFTY: 'NSE_INDEX|Nifty 50',
  BANKNIFTY: 'NSE_INDEX|Nifty Bank',
  FINNIFTY: 'NSE_INDEX|Nifty Fin Service',
  MIDCPNIFTY: 'NSE_INDEX|NIFTY MID SELECT',
  SENSEX: 'BSE_INDEX|SENSEX',
  BANKEX: 'BSE_INDEX|BANKEX',
};

interface UpstoxContract {
  instrument_type: string;
  strike_price: number;
  trading_symbol: string;
  lot_size: number;
  instrument_key: string;
}

/** Upstox API v2/v3. Docs: https://upstox.com/developer/api-documentation/ */
export class UpstoxApi implements BrokerApi {
  private readonly account: BrokerAccount;
  private readonly deps: BrokerDeps;

  constructor({ account, ...deps }: BrokerClientArgs) {
    this.account = account;
    this.deps = deps;
  }

  private get headers() {
    return { Authorization: `Bearer ${this.account.accessToken}`, Accept: 'application/json', ...JSON_HEADERS };
  }

  login(): LoginMethod {
    const url = new URL(`${BASE}/v2/login/authorization/dialog`);
    url.search = form({
      response_type: 'code',
      client_id: this.account.apiKey,
      redirect_uri: this.account.redirectUri,
    });
    return { kind: 'redirect', url: url.toString(), codeParam: 'code', redirectUri: this.account.redirectUri };
  }

  async exchangeToken(input: string): Promise<string> {
    const code = extractParam(input, 'code');
    const res = await this.deps.fetch(`${BASE}/v2/login/authorization/token`, {
      method: 'POST',
      headers: { Accept: 'application/json', ...FORM_HEADERS },
      body: form({
        code,
        client_id: this.account.apiKey,
        client_secret: this.account.apiSecret,
        redirect_uri: this.account.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const body = await decode(res);
    const token = body['access_token'];
    if (res.status !== 200 || typeof token !== 'string') throw new BrokerApiError(`Upstox: ${errorOf(body, res)}`);
    return token;
  }

  async resolve(signal: TradeSignal): Promise<ResolvedInstrument> {
    const underlyingKey = UPSTOX_UNDERLYING_KEYS[signal.underlying];
    if (!underlyingKey) {
      throw new BrokerApiError(`Upstox: underlying ${signal.underlying} is not mapped yet (indices only).`);
    }
    const url = `${BASE}/v2/option/contract?${form({ instrument_key: underlyingKey, expiry_date: signal.expiry })}`;
    const contracts = (await this.data(url, { headers: this.headers })) as UpstoxContract[];
    const c = contracts.find((x) => x.instrument_type === signal.optionType && Number(x.strike_price) === signal.strike);
    if (!c) throw new BrokerApiError(`No Upstox contract found for ${contractLabel(signal)}.`);
    return {
      symbol: c.trading_symbol,
      exchange: exchangeOf(signal),
      lotSize: Number(c.lot_size),
      instrumentKey: c.instrument_key,
      tickSize: 0.05,
    };
  }

  async placeTrade(inst: ResolvedInstrument, plan: TradePlan): Promise<PlacedOrder[]> {
    const product = plan.product === 'intraday' ? 'I' : 'D';
    if (!hasExits(plan)) {
      const data = (await this.data(`${HFT}/v3/order/place`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          quantity: plan.quantity,
          product,
          validity: 'DAY',
          price: plan.entryPrice,
          tag: 'signal',
          instrument_token: inst.instrumentKey,
          order_type: 'LIMIT',
          transaction_type: plan.signal.action,
          disclosed_quantity: 0,
          trigger_price: 0,
          is_amo: false,
          slice: true,
        }),
      })) as { order_ids: unknown[] };
      return data.order_ids.map((id) => ({ kind: 'ENTRY', id: String(id) }));
    }

    // A "MULTIPLE" GTT bundles entry, target and stop loss; Upstox places the
    // exit legs only after the entry fills.
    const ltp = await this.ltp(inst).catch(() => plan.entryPrice);
    const entryTrigger = isBuy(plan.signal)
      ? ltp > plan.entryPrice ? 'BELOW' : 'IMMEDIATE'
      : ltp < plan.entryPrice ? 'ABOVE' : 'IMMEDIATE';
    const data = (await this.data(`${BASE}/v3/order/gtt/place`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        type: 'MULTIPLE',
        quantity: plan.quantity,
        product,
        instrument_token: inst.instrumentKey,
        transaction_type: plan.signal.action,
        rules: [
          { strategy: 'ENTRY', trigger_type: entryTrigger, trigger_price: plan.entryPrice },
          { strategy: 'TARGET', trigger_type: 'IMMEDIATE', trigger_price: plan.target },
          { strategy: 'STOPLOSS', trigger_type: 'IMMEDIATE', trigger_price: plan.stopLoss },
        ],
      }),
    })) as { gtt_order_ids: unknown[] };
    return data.gtt_order_ids.map((id) => ({
      kind: `GTT entry+SL ${plan.stopLoss}+TGT ${plan.target}`,
      id: String(id),
    }));
  }

  private async ltp(inst: ResolvedInstrument): Promise<number> {
    const url = `${BASE}/v2/market-quote/ltp?${form({ instrument_key: inst.instrumentKey! })}`;
    const data = (await this.data(url, { headers: this.headers })) as Record<string, { last_price: number }>;
    return Number(Object.values(data)[0]!.last_price);
  }

  private async data(url: string, init: RequestInit): Promise<unknown> {
    const res = await this.deps.fetch(url, init);
    const body = await decode(res);
    if (res.status !== 200 || body['status'] !== 'success') throw new BrokerApiError(`Upstox: ${errorOf(body, res)}`);
    return body['data'];
  }
}

async function decode(res: Response): Promise<Record<string, unknown>> {
  const body = await readJson(res);
  if (!body) throw new BrokerApiError(`Upstox returned HTTP ${res.status}.`);
  return body;
}

function errorOf(body: Record<string, unknown>, res: Response): string {
  const errors = body['errors'];
  if (Array.isArray(errors) && errors.length > 0) return String((errors[0] as { message?: unknown }).message);
  return `HTTP ${res.status}`;
}
