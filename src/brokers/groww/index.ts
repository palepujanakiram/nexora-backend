import { createHash } from 'node:crypto';

import { BrokerError, classifyMessage, type BrokerErrorCode } from '../../domain/broker-error.ts';
import { nextIstTime } from '../../domain/ist.ts';
import { brokerRupeesToPaise, rupeeNumber } from '../../domain/money.ts';
import { needsTrigger, type OrderType, type Product } from '../../domain/order.ts';
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
  type ModifyRequest,
  type NeedsUserAction,
  type PlaceRequest,
  type TokenSet,
} from '../adapter.ts';
import { objectOf, parseCsv, type HttpRequest, type HttpResult, textOf } from '../http.ts';
import { SEGMENTS, splitExchange, splitOrderId, toInstrument, toOrder, type Segment } from './mapping.ts';

export { SEGMENTS, growwStatus, splitExchange, splitOrderId } from './mapping.ts';

/*
 * Groww Trade API. Docs: https://groww.in/trade-api/docs/curl
 *
 * NOTE: Groww's Trade API access tier for third-party platforms (one server
 * placing orders for many users) must be confirmed with Groww before going live.
 */

export const GROWW_BASE = 'https://api.groww.in';
export const GROWW_API_KEYS_PAGE = 'https://groww.in/trade-api/api-keys';
export const GROWW_INSTRUMENTS_URL = 'https://growwapi-assets.groww.in/instruments/instrument.csv';

const PRODUCT: Record<Product, string> = { DELIVERY: 'CNC', INTRADAY: 'MIS', CARRYFORWARD: 'NRML' };
const PRODUCT_BACK: Record<string, Product> = { CNC: 'DELIVERY', MIS: 'INTRADAY', NRML: 'CARRYFORWARD' };
const ORDER_TYPE: Record<OrderType, string> = { MARKET: 'MARKET', LIMIT: 'LIMIT', SL: 'SL', SL_M: 'SL_M' };

const CAPABILITIES: Capabilities = {
  orderTypes: ['MARKET', 'LIMIT', 'SL', 'SL_M'],
  products: ['DELIVERY', 'INTRADAY', 'CARRYFORWARD'],
  exchanges: ['NSE', 'BSE', 'NFO', 'BFO'],
  modifiable: ['price', 'quantity', 'triggerPrice', 'orderType'],
  // TODO(verify): Groww's published per-second order limit for the Trade API.
  ratePerSecond: 10,
  headlessRefresh: false,
  webhooks: false,
};

export class GrowwAdapter implements BrokerAdapter {
  readonly code = 'groww';
  readonly label = 'Groww';
  readonly capabilities = CAPABILITIES;
  readonly instrumentsNeedSession = false;
  readonly credentialFields = [
    { name: 'apiKey', label: 'API key', secret: false, required: true },
    { name: 'apiSecret', label: 'API secret', secret: true, required: true },
  ];
  private readonly clock: () => Date;

  constructor(deps: { clock: () => Date }) {
    this.clock = deps.clock;
  }

  /** Groww has no redirect login: the user approves the API key for the day, or gives a TOTP. */
  async startLink(): Promise<LinkChallenge> {
    return {
      kind: 'input',
      fields: [{ name: 'totp', label: 'TOTP (optional)', secret: true, required: false }],
      message: 'Approve today\'s API key on Groww\'s API Keys page, then connect (or enter a TOTP).',
      url: GROWW_API_KEYS_PAGE,
    };
  }

  async completeLink(ctx: AccountContext, { params }: LinkCallback): Promise<TokenSet> {
    const totp = (params['totp'] ?? '').trim();
    const { apiKey, apiSecret } = ctx.credentials;
    let body: Record<string, string>;
    if (/^\d{6}$/.test(totp)) {
      body = { key_type: 'totp', totp };
    } else if (totp === '') {
      const timestamp = String(Math.floor(this.clock().getTime() / 1000));
      const checksum = createHash('sha256').update(`${apiSecret}${timestamp}`).digest('hex');
      body = { key_type: 'approval', checksum, timestamp };
    } else {
      throw new BrokerError('AUTH_EXPIRED', 'Groww: leave the TOTP empty after approving today\'s API key, or enter the 6-digit TOTP code.');
    }
    const res = await ctx.http.send({
      kind: 'auth',
      method: 'POST',
      url: `${GROWW_BASE}/v1/token/api/access`,
      headers: { Authorization: `Bearer ${apiKey}` },
      json: body,
    });
    if (res.status >= 300) throw this.error(res, 'auth');
    const data = objectOf(res.body);
    const token = data['token'] ?? objectOf(data['payload'])['token'];
    if (typeof token !== 'string' || !token) throw new BrokerError('AUTH_EXPIRED', 'Groww returned no access token.', res.raw);
    return { accessToken: token, refreshToken: null, expiresAt: nextIstTime(this.clock(), 6, 0) };
  }

  async refreshSession(): Promise<TokenSet | NeedsUserAction> {
    return { needsUserAction: true, reason: 'Groww needs the API key approved again (or a TOTP) every day after 06:00 IST.' };
  }

  /** The instrument list is public; the context only supplies the HTTP client. */
  async fetchInstrumentMaster(ctx: AccountContext | null): Promise<BrokerInstrument[]> {
    if (!ctx) throw new BrokerError('UNKNOWN', 'Groww\'s instrument download needs an http client.');
    const res = await ctx.http.send({ kind: 'read', method: 'GET', url: GROWW_INSTRUMENTS_URL });
    if (res.status !== 200) throw this.error(res, 'read');
    return parseCsv(res.text).flatMap((r) => toInstrument(r) ?? []);
  }

  async placeOrder(ctx: AccountContext, req: PlaceRequest): Promise<BrokerAck> {
    // TODO(SEBI algo id): Groww hasn't published the request field for the exchange algo id yet; req.algoId is not sent.
    const { exchange, segment } = splitExchange(req.symbol);
    const json: Record<string, unknown> = {
      trading_symbol: req.symbol.tradingSymbol,
      quantity: req.quantity,
      price: req.pricePaise === null ? 0 : rupeeNumber(req.pricePaise),
      validity: 'DAY',
      exchange,
      segment,
      product: PRODUCT[req.product],
      order_type: ORDER_TYPE[req.orderType],
      transaction_type: req.side,
      order_reference_id: req.clientRef,
    };
    if (needsTrigger(req.orderType) && req.triggerPaise !== null) json['trigger_price'] = rupeeNumber(req.triggerPaise);
    return this.ack(ctx, { kind: 'write', method: 'POST', url: `${GROWW_BASE}/v1/order/create`, json }, segment, null);
  }

  async modifyOrder(ctx: AccountContext, req: ModifyRequest): Promise<BrokerAck> {
    const { segment, id } = splitOrderId(req.brokerOrderId);
    const json: Record<string, unknown> = {
      groww_order_id: id,
      segment,
      quantity: req.quantity,
      price: req.pricePaise === null ? 0 : rupeeNumber(req.pricePaise),
      order_type: ORDER_TYPE[req.orderType],
    };
    // TODO(verify): whether Groww wants trigger_price omitted or 0 when the new order type has no trigger.
    if (needsTrigger(req.orderType) && req.triggerPaise !== null) json['trigger_price'] = rupeeNumber(req.triggerPaise);
    return this.ack(ctx, { kind: 'write', method: 'POST', url: `${GROWW_BASE}/v1/order/modify`, json }, segment, id);
  }

  async cancelOrder(ctx: AccountContext, brokerOrderId: string): Promise<BrokerAck> {
    const { segment, id } = splitOrderId(brokerOrderId);
    const json = { segment, groww_order_id: id };
    return this.ack(ctx, { kind: 'write', method: 'POST', url: `${GROWW_BASE}/v1/order/cancel`, json }, segment, id);
  }

  async getOrder(ctx: AccountContext, brokerOrderId: string): Promise<BrokerOrder> {
    const { segment, id } = splitOrderId(brokerOrderId);
    const url = `${GROWW_BASE}/v1/order/detail/${encodeURIComponent(id)}?segment=${segment}`;
    const payload = objectOf(await this.call(ctx, { kind: 'read', method: 'GET', url }));
    if (!payload['groww_order_id']) throw new BrokerError('NOT_FOUND', `Groww has no order ${brokerOrderId}.`);
    return toOrder(payload, segment);
  }

  async listOrders(ctx: AccountContext): Promise<BrokerOrder[]> {
    const out: BrokerOrder[] = [];
    for (const segment of SEGMENTS) {
      // TODO(verify): page_size 100 is Groww's maximum; accounts with more orders in a day need paging.
      const url = `${GROWW_BASE}/v1/order/list?segment=${segment}&page=0&page_size=100`;
      const list = objectOf(await this.call(ctx, { kind: 'read', method: 'GET', url }))['order_list'];
      for (const o of Array.isArray(list) ? list : []) out.push(toOrder(objectOf(o), segment));
    }
    return out;
  }

  modifyProblem(current: BrokerOrder, req: ModifyRequest): string | null {
    return standardModifyProblem(CAPABILITIES, current, req);
  }

  async getPositions(ctx: AccountContext): Promise<BrokerPosition[]> {
    const out: BrokerPosition[] = [];
    for (const segment of SEGMENTS) {
      const url = `${GROWW_BASE}/v1/positions/user?segment=${segment}`;
      const positions = objectOf(await this.call(ctx, { kind: 'read', method: 'GET', url }))['positions'];
      for (const p of Array.isArray(positions) ? positions : []) {
        // TODO(verify): field names of Groww's position rows (trading_symbol, exchange, segment, product, quantity, net_price).
        const r = objectOf(p);
        const tradingSymbol = textOf(r['trading_symbol']);
        out.push({
          symbol: { nativeId: tradingSymbol, tradingSymbol, exchange: `${textOf(r['exchange'])}:${textOf(r['segment'], segment)}` },
          product: PRODUCT_BACK[textOf(r['product'])] ?? 'CARRYFORWARD',
          netQty: Number(r['quantity']) || 0,
          avgPricePaise: brokerRupeesToPaise(r['net_price']),
          // TODO(verify): Groww's positions response carries no LTP or P&L that we know of; both stay null.
          lastPricePaise: null,
          pnlPaise: null,
        });
      }
    }
    return out;
  }

  private headers(ctx: AccountContext): Record<string, string> {
    return { Authorization: `Bearer ${ctx.token?.accessToken ?? ''}`, Accept: 'application/json', 'X-API-VERSION': '1.0' };
  }

  private async ack(ctx: AccountContext, req: HttpRequest, segment: Segment, knownId: string | null): Promise<BrokerAck> {
    const res = await ctx.http.send({ ...req, headers: this.headers(ctx) });
    const payload = objectOf(this.payload(res, req.kind));
    const id = textOf(payload['groww_order_id']) || (knownId ?? '');
    if (id === '') {
      throw new BrokerError('UNKNOWN', 'Groww accepted the request but returned no order id.', res.raw);
    }
    return { brokerOrderId: `${segment}:${id}`, raw: res.raw };
  }

  private async call(ctx: AccountContext, req: HttpRequest): Promise<unknown> {
    return this.payload(await ctx.http.send({ ...req, headers: this.headers(ctx) }), req.kind);
  }

  private payload(res: HttpResult, kind: HttpRequest['kind']): unknown {
    const body = objectOf(res.body);
    if (res.status !== 200 || body['status'] !== 'SUCCESS') throw this.error(res, kind);
    return body['payload'];
  }

  private error(res: HttpResult, kind: HttpRequest['kind']): BrokerError {
    const body = objectOf(res.body);
    const nested = objectOf(body['error'])['message'];
    const message = typeof nested === 'string' ? nested : typeof body['message'] === 'string' ? body['message'] : `HTTP ${res.status}`;
    let code: BrokerErrorCode;
    if (res.status === 401 || res.status === 403) code = 'AUTH_EXPIRED';
    else if (res.status === 404) code = 'NOT_FOUND';
    else code = classifyMessage(message) ?? (res.status === 400 && kind === 'write' ? 'REJECTED_BY_EXCHANGE' : 'UNKNOWN');
    return new BrokerError(code, `Groww: ${message}`, res.raw);
  }
}
