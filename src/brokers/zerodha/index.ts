import { createHash, timingSafeEqual } from 'node:crypto';

import { BrokerError, classifyMessage, type BrokerErrorCode } from '../../domain/broker-error.ts';
import type { Exchange, InstrumentType } from '../../domain/instrument.ts';
import { nextIstTime } from '../../domain/ist.ts';
import { brokerRupeesToPaise, rupees } from '../../domain/money.ts';
import type { LegStatus, OrderType, Product } from '../../domain/order.ts';
import {
  standardModifyProblem,
  type AccountContext,
  type BrokerAck,
  type BrokerAdapter,
  type BrokerInstrument,
  type BrokerOrder,
  type BrokerPosition,
  type Capabilities,
  type LinkCallback,
  type LinkChallenge,
  type LinkInput,
  type ModifyRequest,
  type NeedsUserAction,
  type PlaceRequest,
  type TokenSet,
  type WebhookHint,
} from '../adapter.ts';
import { mapStatus, type BrokerState } from '../status.ts';
import { extractParam, objectOf, parseCsv, type HttpRequest, type HttpResult } from '../http.ts';

export const KITE_BASE = 'https://api.kite.trade';
export const KITE_LOGIN = 'https://kite.zerodha.com/connect/login';

const PRODUCT: Record<Product, string> = { DELIVERY: 'CNC', INTRADAY: 'MIS', CARRYFORWARD: 'NRML' };
const PRODUCT_BACK: Record<string, Product> = { CNC: 'DELIVERY', MIS: 'INTRADAY', NRML: 'CARRYFORWARD' };
const ORDER_TYPE: Record<OrderType, string> = { MARKET: 'MARKET', LIMIT: 'LIMIT', SL: 'SL', SL_M: 'SL-M' };
const ORDER_TYPE_BACK: Record<string, OrderType> = { MARKET: 'MARKET', LIMIT: 'LIMIT', SL: 'SL', 'SL-M': 'SL_M' };
const EXCHANGES = new Set<string>(['NSE', 'BSE', 'NFO', 'BFO']);
const TYPES = new Set<string>(['EQ', 'FUT', 'CE', 'PE']);

const CAPABILITIES: Capabilities = {
  orderTypes: ['MARKET', 'LIMIT', 'SL', 'SL_M'],
  products: ['DELIVERY', 'INTRADAY', 'CARRYFORWARD'],
  exchanges: ['NSE', 'BSE', 'NFO', 'BFO'],
  modifiable: ['price', 'quantity', 'triggerPrice', 'orderType'],
  // Kite allows 10 order requests per second per API key.
  ratePerSecond: 10,
  headlessRefresh: false,
  webhooks: true,
};

const KITE_STATES: Record<string, BrokerState> = {
  COMPLETE: 'FILLED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  LAPSED: 'EXPIRED',
  OPEN: 'WORKING',
  'TRIGGER PENDING': 'WORKING',
};

/** Kite's order status → ours. */
export const kiteStatus = (status: string, filled: number): LegStatus => mapStatus(KITE_STATES, status, filled);

/**
 * Zerodha Kite Connect v3. Docs: https://kite.trade/docs/connect/v3/
 *
 * Login is a browser redirect only (no TOTP, no headless login), and the
 * session dies at 06:00 IST every day, so refresh always needs the user.
 */
export class ZerodhaAdapter implements BrokerAdapter {
  readonly code = 'zerodha';
  readonly label = 'Zerodha (Kite Connect)';
  readonly capabilities = CAPABILITIES;
  readonly instrumentsNeedSession = true;
  readonly credentialFields = [
    { name: 'apiKey', label: 'API key', secret: false, required: true },
    { name: 'apiSecret', label: 'API secret', secret: true, required: true },
  ];
  private readonly clock: () => Date;

  constructor(deps: { clock: () => Date }) {
    this.clock = deps.clock;
  }

  async startLink({ credentials, state }: LinkInput): Promise<LinkChallenge> {
    const url = new URL(KITE_LOGIN);
    url.searchParams.set('v', '3');
    url.searchParams.set('api_key', credentials.apiKey);
    url.searchParams.set('redirect_params', new URLSearchParams({ state }).toString());
    return {
      kind: 'redirect',
      url: url.toString(),
      message: 'Log in to Kite. Set your Kite app\'s redirect URL to this server\'s /broker-callback/zerodha.',
    };
  }

  async completeLink(ctx: AccountContext, { params }: LinkCallback): Promise<TokenSet> {
    const requestToken = extractParam(params, 'request_token');
    const { apiKey, apiSecret } = ctx.credentials;
    const checksum = createHash('sha256').update(`${apiKey}${requestToken}${apiSecret}`).digest('hex');
    const data = objectOf(
      await this.call(ctx, {
        kind: 'auth',
        method: 'POST',
        url: `${KITE_BASE}/session/token`,
        form: { api_key: apiKey, request_token: requestToken, checksum },
      }, false),
    );
    const accessToken = data['access_token'];
    if (typeof accessToken !== 'string' || !accessToken) throw new BrokerError('AUTH_EXPIRED', 'Kite returned no access token.');
    return { accessToken, refreshToken: null, expiresAt: nextIstTime(this.clock(), 6, 0) };
  }

  async refreshSession(): Promise<TokenSet | NeedsUserAction> {
    return { needsUserAction: true, reason: 'Kite needs a fresh login in the browser every day after 06:00 IST.' };
  }

  async fetchInstrumentMaster(ctx: AccountContext | null): Promise<BrokerInstrument[]> {
    if (!ctx) throw new BrokerError('AUTH_EXPIRED', 'Kite\'s instrument list needs a logged-in account.');
    const res = await ctx.http.send({ kind: 'read', method: 'GET', url: `${KITE_BASE}/instruments`, headers: this.headers(ctx) });
    if (res.status !== 200) throw this.error(res);
    const out: BrokerInstrument[] = [];
    for (const r of parseCsv(res.text)) {
      const exchange = r['exchange'] ?? '';
      const type = r['instrument_type'] ?? '';
      if (!EXCHANGES.has(exchange) || !TYPES.has(type) || r['segment'] === 'INDICES') continue;
      const derivative = type !== 'EQ';
      out.push({
        exchange: exchange as Exchange,
        type: type as InstrumentType,
        underlying: derivative ? r['name']! : r['tradingsymbol']!,
        expiry: derivative ? r['expiry'] || null : null,
        strikePaise: type === 'CE' || type === 'PE' ? brokerRupeesToPaise(r['strike']) : null,
        lotSize: Number(r['lot_size']) || 1,
        tickPaise: brokerRupeesToPaise(r['tick_size']) || 5,
        symbol: { nativeId: r['instrument_token']!, tradingSymbol: r['tradingsymbol']!, exchange },
      });
    }
    return out;
  }

  async placeOrder(ctx: AccountContext, req: PlaceRequest): Promise<BrokerAck> {
    // TODO(SEBI algo id): Kite hasn't published the request field for the exchange algo id yet; req.algoId is not sent.
    const form: Record<string, string> = {
      tradingsymbol: req.symbol.tradingSymbol,
      exchange: req.symbol.exchange,
      transaction_type: req.side,
      order_type: ORDER_TYPE[req.orderType],
      quantity: String(req.quantity),
      product: PRODUCT[req.product],
      validity: 'DAY',
      tag: req.clientRef,
    };
    if (req.pricePaise !== null) form['price'] = rupees(req.pricePaise);
    if (req.triggerPaise !== null) form['trigger_price'] = rupees(req.triggerPaise);
    return this.ack(ctx, { kind: 'write', method: 'POST', url: `${KITE_BASE}/orders/regular`, form });
  }

  async modifyOrder(ctx: AccountContext, req: ModifyRequest): Promise<BrokerAck> {
    const form: Record<string, string> = {
      quantity: String(req.quantity),
      order_type: ORDER_TYPE[req.orderType],
      validity: 'DAY',
    };
    if (req.pricePaise !== null) form['price'] = rupees(req.pricePaise);
    if (req.triggerPaise !== null) form['trigger_price'] = rupees(req.triggerPaise);
    const url = `${KITE_BASE}/orders/regular/${encodeURIComponent(req.brokerOrderId)}`;
    return this.ack(ctx, { kind: 'write', method: 'PUT', url, form });
  }

  async cancelOrder(ctx: AccountContext, brokerOrderId: string): Promise<BrokerAck> {
    const url = `${KITE_BASE}/orders/regular/${encodeURIComponent(brokerOrderId)}`;
    return this.ack(ctx, { kind: 'write', method: 'DELETE', url });
  }

  async getOrder(ctx: AccountContext, brokerOrderId: string): Promise<BrokerOrder> {
    const url = `${KITE_BASE}/orders/${encodeURIComponent(brokerOrderId)}`;
    const history = await this.call(ctx, { kind: 'read', method: 'GET', url });
    if (!Array.isArray(history) || history.length === 0) {
      throw new BrokerError('NOT_FOUND', `Kite has no order ${brokerOrderId}.`);
    }
    return toOrder(objectOf(history[history.length - 1]));
  }

  async listOrders(ctx: AccountContext): Promise<BrokerOrder[]> {
    const data = await this.call(ctx, { kind: 'read', method: 'GET', url: `${KITE_BASE}/orders` });
    return (Array.isArray(data) ? data : []).map((o) => toOrder(objectOf(o)));
  }

  modifyProblem(current: BrokerOrder, req: ModifyRequest): string | null {
    return standardModifyProblem(CAPABILITIES, current, req);
  }

  async getPositions(ctx: AccountContext): Promise<BrokerPosition[]> {
    const data = objectOf(await this.call(ctx, { kind: 'read', method: 'GET', url: `${KITE_BASE}/portfolio/positions` }));
    const net = Array.isArray(data['net']) ? data['net'] : [];
    return net.map((p) => {
      const r = objectOf(p);
      return {
        symbol: { nativeId: String(r['instrument_token']), tradingSymbol: String(r['tradingsymbol']), exchange: String(r['exchange']) },
        product: PRODUCT_BACK[String(r['product'])] ?? 'CARRYFORWARD',
        netQty: Number(r['quantity']) || 0,
        avgPricePaise: brokerRupeesToPaise(r['average_price']),
        lastPricePaise: brokerRupeesToPaise(r['last_price']),
        pnlPaise: brokerRupeesToPaise(r['pnl']),
      };
    });
  }

  /** Kite postbacks carry `checksum = sha256(order_id + order_timestamp + api_secret)`. */
  parseWebhook(body: unknown): WebhookHint | null {
    const b = objectOf(body);
    const orderId = b['order_id'];
    const timestamp = b['order_timestamp'];
    const checksum = b['checksum'];
    if (typeof orderId !== 'string' || typeof timestamp !== 'string' || typeof checksum !== 'string') return null;
    return {
      brokerOrderId: orderId,
      verify: (credentials) => {
        const expected = createHash('sha256').update(`${orderId}${timestamp}${credentials.apiSecret}`).digest('hex');
        return expected.length === checksum.length && timingSafeEqual(Buffer.from(expected), Buffer.from(checksum));
      },
    };
  }

  private headers(ctx: AccountContext): Record<string, string> {
    return { 'X-Kite-Version': '3', Authorization: `token ${ctx.credentials.apiKey}:${ctx.token?.accessToken ?? ''}` };
  }

  private async ack(ctx: AccountContext, req: HttpRequest): Promise<BrokerAck> {
    const res = await ctx.http.send({ ...req, headers: { ...this.headers(ctx), ...req.headers } });
    const data = objectOf(this.data(res));
    const id = data['order_id'];
    if (id === undefined || id === null || id === '') {
      throw new BrokerError('UNKNOWN', 'Kite accepted the request but returned no order id.', res.raw);
    }
    return { brokerOrderId: String(id), raw: res.raw };
  }

  private async call(ctx: AccountContext, req: HttpRequest, authed = true): Promise<unknown> {
    const headers = authed ? { ...this.headers(ctx), ...req.headers } : { 'X-Kite-Version': '3', ...req.headers };
    return this.data(await ctx.http.send({ ...req, headers }));
  }

  private data(res: HttpResult): unknown {
    const body = objectOf(res.body);
    if (res.status !== 200 || body['status'] !== 'success') throw this.error(res);
    return body['data'];
  }

  private error(res: HttpResult): BrokerError {
    const body = objectOf(res.body);
    const message = typeof body['message'] === 'string' ? body['message'] : `HTTP ${res.status}`;
    const type = String(body['error_type'] ?? '');
    let code: BrokerErrorCode;
    if (type === 'TokenException' || res.status === 403) code = 'AUTH_EXPIRED';
    else code = classifyMessage(message) ?? (type === 'OrderException' || type === 'InputException' ? 'REJECTED_BY_EXCHANGE' : 'UNKNOWN');
    return new BrokerError(code, `Kite: ${message}`, res.raw);
  }
}

function toOrder(r: Record<string, unknown>): BrokerOrder {
  const filled = Number(r['filled_quantity']) || 0;
  return {
    brokerOrderId: String(r['order_id']),
    status: kiteStatus(String(r['status'] ?? ''), filled),
    quantity: Number(r['quantity']) || 0,
    filledQty: filled,
    avgPricePaise: filled > 0 ? brokerRupeesToPaise(r['average_price']) : null,
    pricePaise: brokerRupeesToPaise(r['price']) || null,
    triggerPaise: brokerRupeesToPaise(r['trigger_price']) || null,
    orderType: ORDER_TYPE_BACK[String(r['order_type'])] ?? null,
    clientRef: typeof r['tag'] === 'string' ? r['tag'] : null,
    message: typeof r['status_message'] === 'string' ? r['status_message'] : null,
    raw: r,
  };
}
