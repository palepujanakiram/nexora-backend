import { BrokerError, classifyMessage, type BrokerErrorCode } from '../../domain/broker-error.ts';
import type { Exchange, InstrumentType } from '../../domain/instrument.ts';
import { istDate, nextIstTime } from '../../domain/ist.ts';
import { brokerRupeesToPaise, rupeeNumber } from '../../domain/money.ts';
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
import { extractParam, objectOf, type HttpRequest, type HttpResult } from '../http.ts';

export const UPSTOX_BASE = 'https://api.upstox.com';
export const UPSTOX_HFT = 'https://api-hft.upstox.com';
export const UPSTOX_INSTRUMENTS = 'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz';

const PRODUCT: Record<Product, string> = { DELIVERY: 'D', INTRADAY: 'I', CARRYFORWARD: 'D' };
const ORDER_TYPE: Record<OrderType, string> = { MARKET: 'MARKET', LIMIT: 'LIMIT', SL: 'SL', SL_M: 'SL-M' };
const ORDER_TYPE_BACK: Record<string, OrderType> = { MARKET: 'MARKET', LIMIT: 'LIMIT', SL: 'SL', 'SL-M': 'SL_M' };
/** Upstox instrument segments → our exchanges. Other segments (indices, MCX, currency) are skipped. */
const SEGMENT: Record<string, Exchange> = { NSE_EQ: 'NSE', BSE_EQ: 'BSE', NSE_FO: 'NFO', BSE_FO: 'BFO' };
const TYPES = new Set<string>(['EQ', 'FUT', 'CE', 'PE']);
/** Upstox's "invalid token" error code. */
const INVALID_TOKEN_CODES = new Set<string>(['UDAPI100050']);

const CAPABILITIES: Capabilities = {
  orderTypes: ['MARKET', 'LIMIT', 'SL', 'SL_M'],
  products: ['DELIVERY', 'INTRADAY', 'CARRYFORWARD'],
  exchanges: ['NSE', 'BSE', 'NFO', 'BFO'],
  modifiable: ['price', 'quantity', 'triggerPrice', 'orderType'],
  // TODO(verify): Upstox order APIs allow about 10 requests per second per user.
  ratePerSecond: 10,
  headlessRefresh: false,
  webhooks: true,
};

const UPSTOX_STATES: Record<string, BrokerState> = {
  COMPLETE: 'FILLED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  OPEN: 'WORKING',
  'TRIGGER PENDING': 'WORKING',
};

/** Upstox's order status → ours. */
export const upstoxStatus = (status: string, filled: number): LegStatus => mapStatus(UPSTOX_STATES, status, filled);

/**
 * Upstox API v2 (auth, reads) and v3 (order writes on the HFT host).
 * Docs: https://upstox.com/developer/api-documentation/
 *
 * Login is a browser redirect with an authorization code, and the session ends
 * at 03:30 IST the next day; there is no headless refresh.
 */
export class UpstoxAdapter implements BrokerAdapter {
  readonly code = 'upstox';
  readonly label = 'Upstox';
  readonly capabilities = CAPABILITIES;
  readonly instrumentsNeedSession = false;
  readonly credentialFields = [
    { name: 'apiKey', label: 'API key', secret: false, required: true },
    { name: 'apiSecret', label: 'API secret', secret: true, required: true },
    { name: 'redirectUri', label: 'Redirect URI', secret: false, required: true },
  ];
  private readonly clock: () => Date;

  constructor(deps: { clock: () => Date }) {
    this.clock = deps.clock;
  }

  async startLink({ credentials, state }: LinkInput): Promise<LinkChallenge> {
    const url = new URL(`${UPSTOX_BASE}/v2/login/authorization/dialog`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', credentials.apiKey);
    url.searchParams.set('redirect_uri', redirectUri(credentials.extra));
    url.searchParams.set('state', state);
    return {
      kind: 'redirect',
      url: url.toString(),
      message: 'Log in to Upstox. Upstox redirects to the redirect URI saved with this account.',
    };
  }

  async completeLink(ctx: AccountContext, { params }: LinkCallback): Promise<TokenSet> {
    const code = extractParam(params, 'code');
    const { apiKey, apiSecret, extra } = ctx.credentials;
    const res = await ctx.http.send({
      kind: 'auth',
      method: 'POST',
      url: `${UPSTOX_BASE}/v2/login/authorization/token`,
      form: {
        code,
        client_id: apiKey,
        client_secret: apiSecret,
        redirect_uri: redirectUri(extra),
        grant_type: 'authorization_code',
      },
    });
    // The token endpoint answers with the token fields at the top level, not under `data`.
    if (res.status !== 200) throw this.error(res, 'auth');
    const accessToken = objectOf(res.body)['access_token'];
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new BrokerError('AUTH_EXPIRED', 'Upstox returned no access token.', res.raw);
    }
    return { accessToken, refreshToken: null, expiresAt: nextIstTime(this.clock(), 3, 30) };
  }

  async refreshSession(): Promise<TokenSet | NeedsUserAction> {
    return { needsUserAction: true, reason: 'Upstox needs a fresh login in the browser every day after 03:30 IST.' };
  }

  async fetchInstrumentMaster(ctx: AccountContext | null): Promise<BrokerInstrument[]> {
    // The list is public (no token is sent), but the request still goes through an account's HTTP client.
    if (!ctx) throw new BrokerError('UNKNOWN', 'Fetching the Upstox instrument list needs an HTTP client.');
    // The file is served as raw gzip (checked 30 Oct 2026); BrokerHttp unpacks it.
    const res = await ctx.http.send({
      kind: 'read',
      method: 'GET',
      url: UPSTOX_INSTRUMENTS,
      headers: { 'Accept-Encoding': 'gzip' },
    });
    if (res.status !== 200) throw this.error(res, 'read');
    if (!Array.isArray(res.body)) {
      throw new BrokerError('UNKNOWN', 'Upstox instrument list was not a JSON array.', res.raw);
    }
    const out: BrokerInstrument[] = [];
    for (const row of res.body) {
      const r = objectOf(row);
      const exchange = SEGMENT[String(r['segment'])];
      const type = String(r['instrument_type']);
      if (!exchange || !TYPES.has(type)) continue;
      const derivative = type !== 'EQ';
      const tradingSymbol = String(r['trading_symbol']);
      const expiryMs = Number(r['expiry']);
      out.push({
        exchange,
        type: type as InstrumentType,
        underlying: derivative ? String(r['underlying_symbol'] ?? r['name']) : tradingSymbol,
        expiry: derivative && expiryMs > 0 ? istDate(new Date(expiryMs)) : null,
        strikePaise: type === 'CE' || type === 'PE' ? brokerRupeesToPaise(r['strike_price']) : null,
        lotSize: Number(r['lot_size']) || 1,
        // Upstox's tick_size is in paise (5 means ₹0.05), unlike Kite's rupees. Checked against the live file, 30 Oct 2026.
        tickPaise: Math.round(Number(r['tick_size'])) || 5,
        symbol: { nativeId: String(r['instrument_key']), tradingSymbol, exchange: String(r['segment']) },
      });
    }
    return out;
  }

  async placeOrder(ctx: AccountContext, req: PlaceRequest): Promise<BrokerAck> {
    // TODO(SEBI algo id): Upstox hasn't published the request field for the exchange algo id yet; req.algoId is not sent.
    const res = await this.send(ctx, {
      kind: 'write',
      method: 'POST',
      url: `${UPSTOX_HFT}/v3/order/place`,
      json: {
        quantity: req.quantity,
        product: PRODUCT[req.product],
        validity: 'DAY',
        price: req.pricePaise === null ? 0 : rupeeNumber(req.pricePaise),
        tag: req.clientRef,
        instrument_token: req.symbol.nativeId,
        order_type: ORDER_TYPE[req.orderType],
        transaction_type: req.side,
        disclosed_quantity: 0,
        trigger_price: req.triggerPaise === null ? 0 : rupeeNumber(req.triggerPaise),
        is_amo: false,
        // One leg must be exactly one broker order: never let Upstox split it.
        slice: false,
      },
    });
    const ids = objectOf(this.data(res, 'write'))['order_ids'];
    return this.ack(res, Array.isArray(ids) ? ids[0] : undefined);
  }

  async modifyOrder(ctx: AccountContext, req: ModifyRequest): Promise<BrokerAck> {
    const res = await this.send(ctx, {
      kind: 'write',
      method: 'PUT',
      url: `${UPSTOX_HFT}/v3/order/modify`,
      json: {
        order_id: req.brokerOrderId,
        quantity: req.quantity,
        validity: 'DAY',
        price: req.pricePaise === null ? 0 : rupeeNumber(req.pricePaise),
        order_type: ORDER_TYPE[req.orderType],
        trigger_price: req.triggerPaise === null ? 0 : rupeeNumber(req.triggerPaise),
        disclosed_quantity: 0,
      },
    });
    return this.ack(res, objectOf(this.data(res, 'write'))['order_id']);
  }

  async cancelOrder(ctx: AccountContext, brokerOrderId: string): Promise<BrokerAck> {
    const url = `${UPSTOX_HFT}/v3/order/cancel?order_id=${encodeURIComponent(brokerOrderId)}`;
    const res = await this.send(ctx, { kind: 'write', method: 'DELETE', url });
    return this.ack(res, objectOf(this.data(res, 'write'))['order_id']);
  }

  async getOrder(ctx: AccountContext, brokerOrderId: string): Promise<BrokerOrder> {
    const url = `${UPSTOX_BASE}/v2/order/details?order_id=${encodeURIComponent(brokerOrderId)}`;
    const res = await this.send(ctx, { kind: 'read', method: 'GET', url });
    const data = objectOf(this.data(res, 'read'));
    if (data['order_id'] === undefined || data['order_id'] === null) {
      throw new BrokerError('NOT_FOUND', `Upstox has no order ${brokerOrderId}.`, res.raw);
    }
    return toOrder(data);
  }

  async listOrders(ctx: AccountContext): Promise<BrokerOrder[]> {
    const res = await this.send(ctx, { kind: 'read', method: 'GET', url: `${UPSTOX_BASE}/v2/order/retrieve-all` });
    const data = this.data(res, 'read');
    return (Array.isArray(data) ? data : []).map((o) => toOrder(objectOf(o)));
  }

  modifyProblem(current: BrokerOrder, req: ModifyRequest): string | null {
    return standardModifyProblem(CAPABILITIES, current, req);
  }

  async getPositions(ctx: AccountContext): Promise<BrokerPosition[]> {
    const res = await this.send(ctx, { kind: 'read', method: 'GET', url: `${UPSTOX_BASE}/v2/portfolio/short-term-positions` });
    const data = this.data(res, 'read');
    return (Array.isArray(data) ? data : []).map((p) => {
      const r = objectOf(p);
      const key = String(r['instrument_token']);
      // The instrument key is `<segment>|<id>`; the segment is the exchange code our symbols carry.
      const segment = key.split('|')[0]!;
      return {
        // TODO(verify): positions name the field `trading_symbol`; older payloads used `tradingsymbol`.
        symbol: { nativeId: key, tradingSymbol: String(r['trading_symbol'] ?? r['tradingsymbol']), exchange: segment },
        product: positionProduct(String(r['product']), segment),
        netQty: Number(r['quantity']) || 0,
        avgPricePaise: brokerRupeesToPaise(r['average_price']),
        lastPricePaise: brokerRupeesToPaise(r['last_price']),
        pnlPaise: brokerRupeesToPaise(r['pnl']),
      };
    });
  }

  /**
   * Upstox order-update webhooks carry the order id.
   * TODO(verify): as far as we know they are not signed, so there is nothing to verify; the core only
   * uses the hint to re-read the order from Upstox.
   */
  parseWebhook(body: unknown): WebhookHint | null {
    const orderId = objectOf(body)['order_id'];
    if (typeof orderId !== 'string' || !orderId) return null;
    return { brokerOrderId: orderId, verify: null };
  }

  private send(ctx: AccountContext, req: HttpRequest): Promise<HttpResult> {
    return ctx.http.send({ ...req, headers: { Authorization: `Bearer ${ctx.token?.accessToken ?? ''}`, Accept: 'application/json', ...req.headers } });
  }

  private ack(res: HttpResult, id: unknown): BrokerAck {
    if (id === undefined || id === null || id === '') {
      throw new BrokerError('UNKNOWN', 'Upstox accepted the request but returned no order id.', res.raw);
    }
    return { brokerOrderId: String(id), raw: res.raw };
  }

  private data(res: HttpResult, kind: HttpRequest['kind']): unknown {
    const body = objectOf(res.body);
    if (res.status !== 200 || body['status'] !== 'success') throw this.error(res, kind);
    return body['data'];
  }

  private error(res: HttpResult, kind: HttpRequest['kind']): BrokerError {
    const body = objectOf(res.body);
    const first = objectOf(Array.isArray(body['errors']) ? body['errors'][0] : undefined);
    const message = typeof first['message'] === 'string' ? first['message'] : `HTTP ${res.status}`;
    const errorCode = String(first['errorCode'] ?? first['error_code'] ?? '');
    let code: BrokerErrorCode;
    if (res.status === 401 || INVALID_TOKEN_CODES.has(errorCode)) code = 'AUTH_EXPIRED';
    else code = classifyMessage(message) ?? (kind === 'write' && res.status === 400 ? 'REJECTED_BY_EXCHANGE' : 'UNKNOWN');
    return new BrokerError(code, `Upstox: ${message}`, res.raw);
  }
}

function redirectUri(extra: Readonly<Record<string, string>>): string {
  const uri = extra['redirectUri']?.trim();
  if (!uri) throw new BrokerError('AUTH_EXPIRED', 'This Upstox account has no redirect URI. Re-link it with one.');
  return uri;
}

/** Upstox's `D` covers both equity delivery and F&O carry-forward; the segment tells them apart. */
function positionProduct(product: string, segment: string): Product {
  if (product === 'I') return 'INTRADAY';
  if (product === 'D' && segment.endsWith('_EQ')) return 'DELIVERY';
  return 'CARRYFORWARD';
}

function toOrder(r: Record<string, unknown>): BrokerOrder {
  const filled = Number(r['filled_quantity']) || 0;
  return {
    brokerOrderId: String(r['order_id']),
    status: upstoxStatus(String(r['status'] ?? ''), filled),
    quantity: Number(r['quantity']) || 0,
    filledQty: filled,
    avgPricePaise: filled > 0 ? brokerRupeesToPaise(r['average_price']) : null,
    pricePaise: brokerRupeesToPaise(r['price']) || null,
    triggerPaise: brokerRupeesToPaise(r['trigger_price']) || null,
    orderType: ORDER_TYPE_BACK[String(r['order_type'])] ?? null,
    clientRef: typeof r['tag'] === 'string' && r['tag'] ? r['tag'] : null,
    message: typeof r['status_message'] === 'string' && r['status_message'] ? r['status_message'] : null,
    raw: r,
  };
}
