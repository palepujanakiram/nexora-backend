import { createHash } from 'node:crypto';

import type { BrokerAccount } from '../domain/account.ts';
import { BrokerApiError } from '../domain/errors.ts';
import { contractLabel, exchangeOf, exitSide, type TradeSignal } from '../domain/signal.ts';
import { TradePricing, hasExits, type PlacedOrder, type ResolvedInstrument, type TradePlan } from '../domain/trade.ts';
import {
  FORM_HEADERS,
  extractParam,
  form,
  parseCsv,
  readJson,
  type BrokerApi,
  type BrokerClientArgs,
  type BrokerDeps,
  type LoginMethod,
} from './broker-api.ts';

const BASE = 'https://api.kite.trade';

/** Kite Connect v3. Docs: https://kite.trade/docs/connect/v3/ */
export class ZerodhaApi implements BrokerApi {
  private readonly account: BrokerAccount;
  private readonly deps: BrokerDeps;

  constructor({ account, ...deps }: BrokerClientArgs) {
    this.account = account;
    this.deps = deps;
  }

  private get headers() {
    return { 'X-Kite-Version': '3', Authorization: `token ${this.account.apiKey}:${this.account.accessToken}` };
  }

  login(): LoginMethod {
    return {
      kind: 'redirect',
      url: `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(this.account.apiKey)}`,
      codeParam: 'request_token',
      redirectUri: null,
    };
  }

  async exchangeToken(input: string): Promise<string> {
    const requestToken = extractParam(input, 'request_token');
    const { apiKey, apiSecret } = this.account;
    const checksum = createHash('sha256').update(`${apiKey}${requestToken}${apiSecret}`).digest('hex');
    const data = await this.send(`${BASE}/session/token`, {
      method: 'POST',
      headers: { 'X-Kite-Version': '3', ...FORM_HEADERS },
      body: form({ api_key: apiKey, request_token: requestToken, checksum }),
    });
    return String(data['access_token']);
  }

  async resolve(signal: TradeSignal): Promise<ResolvedInstrument> {
    const exchange = exchangeOf(signal);
    const rows = await this.deps.cache.get(`zerodha:${exchange}`, this.deps.clock(), async () => {
      const res = await this.deps.fetch(`${BASE}/instruments/${exchange}`, { headers: this.headers });
      if (res.status !== 200) {
        throw new BrokerApiError(`Kite instruments download failed (${res.status}). Is the session valid?`);
      }
      return parseCsv(await res.text());
    });
    const row = rows.find(
      (r) =>
        r['name'] === signal.underlying &&
        r['instrument_type'] === signal.optionType &&
        r['expiry'] === signal.expiry &&
        Number(r['strike']) === signal.strike,
    );
    if (!row) throw new BrokerApiError(`No Kite contract found for ${contractLabel(signal)} on ${exchange}.`);
    return {
      symbol: row['tradingsymbol']!,
      exchange: row['exchange'] || exchange,
      lotSize: Number(row['lot_size']),
      tickSize: Number(row['tick_size']) || 0.05,
    };
  }

  async placeTrade(inst: ResolvedInstrument, plan: TradePlan): Promise<PlacedOrder[]> {
    const product = plan.product === 'intraday' ? 'MIS' : 'NRML';
    const entry = await this.send(`${BASE}/orders/regular`, {
      method: 'POST',
      headers: { ...this.headers, ...FORM_HEADERS },
      body: form({
        tradingsymbol: inst.symbol,
        exchange: inst.exchange,
        transaction_type: plan.signal.action,
        order_type: 'LIMIT',
        quantity: String(plan.quantity),
        price: plan.entryPrice.toFixed(2),
        product,
        validity: 'DAY',
        tag: 'signal',
      }),
    });
    const orders: PlacedOrder[] = [{ kind: 'ENTRY', id: String(entry['order_id']) }];
    if (!hasExits(plan)) return orders;

    // GTT OCO: whichever of stop loss / target triggers first fires an exit
    // limit order and cancels the other. Kite wants legs in ascending price.
    const side = exitSide(plan.signal);
    const sl = plan.stopLoss!;
    const tgt = plan.target!;
    // Give the stop-loss limit a 5% buffer past the trigger so it fills on a fast move.
    const slLimit = TradePricing.roundToTick(side === 'SELL' ? sl * 0.95 : sl * 1.05, inst.tickSize);
    const legs = [
      [sl, slLimit],
      [tgt, tgt],
    ].sort((a, b) => a[0]! - b[0]!);
    const ltp = await this.ltp(inst).catch(() => plan.entryPrice);

    const gtt = await this.send(`${BASE}/gtt/triggers`, {
      method: 'POST',
      headers: { ...this.headers, ...FORM_HEADERS },
      body: form({
        type: 'two-leg',
        condition: JSON.stringify({
          exchange: inst.exchange,
          tradingsymbol: inst.symbol,
          trigger_values: legs.map((l) => l[0]),
          last_price: ltp,
        }),
        orders: JSON.stringify(
          legs.map((l) => ({
            exchange: inst.exchange,
            tradingsymbol: inst.symbol,
            transaction_type: side,
            quantity: plan.quantity,
            order_type: 'LIMIT',
            product,
            price: l[1],
          })),
        ),
      }),
    });
    orders.push({ kind: `GTT OCO (SL ${sl} / TGT ${tgt})`, id: String(gtt['trigger_id']) });
    return orders;
  }

  private async ltp(inst: ResolvedInstrument): Promise<number> {
    const key = `${inst.exchange}:${inst.symbol}`;
    const data = await this.send(`${BASE}/quote/ltp?i=${encodeURIComponent(key)}`, { headers: this.headers });
    return Number((data[key] as { last_price: number }).last_price);
  }

  private async send(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const res = await this.deps.fetch(url, init);
    const body = await readJson(res);
    if (!body) throw new BrokerApiError(`Kite returned HTTP ${res.status}.`);
    if (res.status !== 200 || body['status'] !== 'success') {
      throw new BrokerApiError(`Kite: ${body['message'] ?? `HTTP ${res.status}`}`);
    }
    return body['data'] as Record<string, unknown>;
  }
}
