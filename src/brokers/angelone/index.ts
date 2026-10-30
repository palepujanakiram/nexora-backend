import { BrokerError, classifyMessage, type BrokerErrorCode } from '../../domain/broker-error.ts';
import { nextIstTime } from '../../domain/ist.ts';
import { brokerRupeesToPaise, rupees } from '../../domain/money.ts';
import type { OrderType, Product } from '../../domain/order.ts';
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
import { objectOf, type CallKind, type HttpRequest, type HttpResult, textOf } from '../http.ts';
import { bare, toInstrument, toOrder } from './mapping.ts';

export { angelExpiry, angelStatus } from './mapping.ts';

export const ANGEL_BASE = 'https://apiconnect.angelone.in';
export const ANGEL_SCRIP_MASTER = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

const LOGIN_PATH = '/rest/auth/angelbroking/user/v1/loginByPassword';
const REFRESH_PATH = '/rest/auth/angelbroking/jwt/v1/generateTokens';
const ORDER_PATH = '/rest/secure/angelbroking/order/v1';

const PRODUCT: Record<Product, string> = { DELIVERY: 'DELIVERY', INTRADAY: 'INTRADAY', CARRYFORWARD: 'CARRYFORWARD' };
const PRODUCT_BACK: Record<string, Product> = { DELIVERY: 'DELIVERY', INTRADAY: 'INTRADAY', CARRYFORWARD: 'CARRYFORWARD' };
const ORDER_TYPE: Record<OrderType, string> = {
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  SL: 'STOPLOSS_LIMIT',
  SL_M: 'STOPLOSS_MARKET',
};
/** Angel error codes meaning the session (JWT) is invalid, expired or missing. */
const AUTH_CODES = new Set(['AG8001', 'AG8002', 'AG8003', 'AB1010', 'AB8050']); // TODO(verify): AB1010/AB8050 as "session expired".

const CAPABILITIES: Capabilities = {
  orderTypes: ['MARKET', 'LIMIT', 'SL', 'SL_M'],
  products: ['DELIVERY', 'INTRADAY', 'CARRYFORWARD'],
  exchanges: ['NSE', 'BSE', 'NFO', 'BFO'],
  modifiable: ['price', 'quantity', 'triggerPrice', 'orderType'],
  // TODO(verify): Angel documents per-endpoint limits (e.g. placeOrder 20/s, order book 1/s); 10/s is a conservative account-wide bucket.
  ratePerSecond: 10,
  headlessRefresh: true,
  webhooks: false,
};

/**
 * Angel One SmartAPI. Docs: https://smartapi.angelbroking.com/docs
 *
 * Login is headless: client code + MPIN + the current TOTP. The session
 * carries a refresh token, so it can be renewed without the user until the
 * refresh token itself expires. Angel often answers HTTP 200 with
 * `status: false`, so every answer is checked for `status === true`.
 */
export class AngelOneAdapter implements BrokerAdapter {
  readonly code = 'angelone';
  readonly label = 'Angel One (SmartAPI)';
  readonly capabilities = CAPABILITIES;
  readonly instrumentsNeedSession = false;
  readonly credentialFields = [
    { name: 'apiKey', label: 'API key', secret: false, required: true },
    { name: 'apiSecret', label: 'SmartAPI secret key', secret: true, required: true },
    { name: 'clientCode', label: 'Client code', secret: false, required: true },
    { name: 'pin', label: 'MPIN', secret: true, required: true },
  ];
  private readonly clock: () => Date;

  constructor(deps: { clock: () => Date }) {
    this.clock = deps.clock;
  }

  async startLink(): Promise<LinkChallenge> {
    return {
      kind: 'input',
      fields: [{ name: 'totp', label: '6-digit TOTP from your authenticator', secret: true, required: true }],
      message: 'Enter the current TOTP for your Angel One account.',
      url: null,
    };
  }

  async completeLink(ctx: AccountContext, { params }: LinkCallback): Promise<TokenSet> {
    const totp = (params['totp'] ?? '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(totp)) {
      throw new BrokerError('AUTH_EXPIRED', 'Enter the 6-digit TOTP shown in your authenticator app for Angel One.');
    }
    const clientcode = ctx.credentials.extra['clientCode'];
    const pin = ctx.credentials.extra['pin'];
    if (!clientcode || !pin) {
      throw new BrokerError('AUTH_EXPIRED', 'Angel One needs the client code and MPIN saved on the account.');
    }
    const data = await this.call(ctx, {
      kind: 'auth',
      method: 'POST',
      url: `${ANGEL_BASE}${LOGIN_PATH}`,
      json: { clientcode, password: pin, totp },
    }, false);
    return this.tokens(data);
  }

  async refreshSession(ctx: AccountContext): Promise<TokenSet | NeedsUserAction> {
    const refreshToken = ctx.token?.refreshToken;
    if (!refreshToken) {
      return { needsUserAction: true, reason: 'Angel One needs a fresh login with your TOTP.' };
    }
    try {
      const data = await this.call(ctx, {
        kind: 'auth',
        method: 'POST',
        url: `${ANGEL_BASE}${REFRESH_PATH}`,
        json: { refreshToken },
      });
      return this.tokens(data);
    } catch (e) {
      if (e instanceof BrokerError && e.code === 'AUTH_EXPIRED') {
        return { needsUserAction: true, reason: 'Angel One\'s session has ended; log in again with your TOTP.' };
      }
      throw e;
    }
  }

  async fetchInstrumentMaster(ctx: AccountContext | null): Promise<BrokerInstrument[]> {
    if (!ctx) throw new BrokerError('UNKNOWN', 'Angel One\'s instrument list needs an http client.');
    // TODO(verify): the scrip master is ~40 MB of JSON and is parsed in one go; on small machines this may need streaming.
    const res = await ctx.http.send({ kind: 'read', method: 'GET', url: ANGEL_SCRIP_MASTER });
    if (res.status !== 200 || !Array.isArray(res.body)) throw this.error(res, 'read');
    const out: BrokerInstrument[] = [];
    for (const item of res.body) {
      const instrument = toInstrument(objectOf(item));
      if (instrument) out.push(instrument);
    }
    return out;
  }

  async placeOrder(ctx: AccountContext, req: PlaceRequest): Promise<BrokerAck> {
    // TODO(SEBI algo id): Angel hasn't published the request field for the exchange algo id yet; req.algoId is not sent.
    return this.ack(ctx, `${ORDER_PATH}/placeOrder`, {
      variety: variety(req.orderType),
      tradingsymbol: req.symbol.tradingSymbol,
      symboltoken: req.symbol.nativeId,
      transactiontype: req.side,
      exchange: req.symbol.exchange,
      ordertype: ORDER_TYPE[req.orderType],
      producttype: PRODUCT[req.product],
      duration: 'DAY',
      price: req.pricePaise === null ? '0' : rupees(req.pricePaise),
      triggerprice: req.triggerPaise === null ? '0' : rupees(req.triggerPaise),
      quantity: String(req.quantity),
      ordertag: req.clientRef,
    });
  }

  async modifyOrder(ctx: AccountContext, req: ModifyRequest): Promise<BrokerAck> {
    return this.ack(ctx, `${ORDER_PATH}/modifyOrder`, {
      variety: variety(req.orderType),
      orderid: req.brokerOrderId,
      ordertype: ORDER_TYPE[req.orderType],
      producttype: PRODUCT[req.product],
      duration: 'DAY',
      price: req.pricePaise === null ? '0' : rupees(req.pricePaise),
      quantity: String(req.quantity),
      tradingsymbol: req.symbol.tradingSymbol,
      symboltoken: req.symbol.nativeId,
      exchange: req.symbol.exchange,
      triggerprice: req.triggerPaise === null ? '0' : rupees(req.triggerPaise),
    });
  }

  async cancelOrder(ctx: AccountContext, brokerOrderId: string): Promise<BrokerAck> {
    // TODO(verify): whether Angel requires variety 'STOPLOSS' to cancel stop-loss orders. We don't know the order
    // type here and won't read the order book first, so NORMAL is always sent.
    return this.ack(ctx, `${ORDER_PATH}/cancelOrder`, { variety: 'NORMAL', orderid: brokerOrderId });
  }

  async getOrder(ctx: AccountContext, brokerOrderId: string): Promise<BrokerOrder> {
    // TODO(verify): `/order/v1/details/<uniqueorderid>` reads one order, but needs the uniqueorderid we don't keep;
    // the order book filtered by orderid is used instead.
    const found = (await this.listOrders(ctx)).find((o) => o.brokerOrderId === brokerOrderId);
    if (!found) throw new BrokerError('NOT_FOUND', `Angel One has no order ${brokerOrderId}.`);
    return found;
  }

  async listOrders(ctx: AccountContext): Promise<BrokerOrder[]> {
    const data = await this.call(ctx, { kind: 'read', method: 'GET', url: `${ANGEL_BASE}${ORDER_PATH}/getOrderBook` });
    // Angel answers `data: null` when the book is empty.
    return (Array.isArray(data) ? data : []).map((o) => toOrder(objectOf(o)));
  }

  modifyProblem(current: BrokerOrder, req: ModifyRequest): string | null {
    return standardModifyProblem(CAPABILITIES, current, req);
  }

  async getPositions(ctx: AccountContext): Promise<BrokerPosition[]> {
    const data = await this.call(ctx, { kind: 'read', method: 'GET', url: `${ANGEL_BASE}${ORDER_PATH}/getPosition` });
    return (Array.isArray(data) ? data : []).map((p) => {
      const r = objectOf(p);
      return {
        symbol: { nativeId: textOf(r['symboltoken']), tradingSymbol: textOf(r['tradingsymbol']), exchange: textOf(r['exchange']) },
        product: PRODUCT_BACK[textOf(r['producttype'])] ?? 'CARRYFORWARD',
        netQty: Number(r['netqty']) || 0,
        // TODO(verify): `avgnetprice` vs `netprice` as the average price of the net position.
        avgPricePaise: brokerRupeesToPaise(r['avgnetprice']),
        lastPricePaise: brokerRupeesToPaise(r['ltp']),
        pnlPaise: brokerRupeesToPaise(r['pnl']),
      };
    });
  }

  private headers(ctx: AccountContext, authed: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      // TODO(verify): whether Angel needs real client IPs / MAC. Brokers whitelist our static egress IP, which they
      // see on the connection anyway; these are placeholders.
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': ctx.credentials.apiKey,
    };
    if (authed) headers['Authorization'] = `Bearer ${ctx.token?.accessToken ?? ''}`;
    return headers;
  }

  private tokens(data: unknown): TokenSet {
    const d = objectOf(data);
    const jwt = bare(d['jwtToken']);
    if (!jwt) throw new BrokerError('AUTH_EXPIRED', 'Angel One returned no session token.');
    const refresh = bare(d['refreshToken']);
    // TODO(verify): Angel sessions are documented as valid until midnight IST.
    return { accessToken: jwt, refreshToken: refresh || null, expiresAt: nextIstTime(this.clock(), 0, 0) };
  }

  private async ack(ctx: AccountContext, path: string, json: Record<string, string>): Promise<BrokerAck> {
    const req: HttpRequest = { kind: 'write', method: 'POST', url: `${ANGEL_BASE}${path}`, json };
    const res = await ctx.http.send({ ...req, headers: this.headers(ctx, true) });
    const id = objectOf(this.data(res, 'write'))['orderid'];
    if (id === undefined || id === null || id === '') {
      throw new BrokerError('UNKNOWN', 'Angel One accepted the request but returned no order id.', res.raw);
    }
    return { brokerOrderId: textOf(id), raw: res.raw };
  }

  private async call(ctx: AccountContext, req: HttpRequest, authed = true): Promise<unknown> {
    return this.data(await ctx.http.send({ ...req, headers: this.headers(ctx, authed) }), req.kind);
  }

  private data(res: HttpResult, kind: CallKind): unknown {
    const body = objectOf(res.body);
    if (res.status !== 200 || body['status'] !== true) throw this.error(res, kind);
    return body['data'];
  }

  private error(res: HttpResult, kind: CallKind): BrokerError {
    const body = objectOf(res.body);
    const errorcode = typeof body['errorcode'] === 'string' ? body['errorcode'] : '';
    const message = typeof body['message'] === 'string' && body['message'] ? body['message'] : `HTTP ${res.status}`;
    let code: BrokerErrorCode;
    if (AUTH_CODES.has(errorcode) || res.status === 401 || res.status === 403) code = 'AUTH_EXPIRED';
    else code = classifyMessage(message) ?? (kind === 'write' ? 'REJECTED_BY_EXCHANGE' : 'UNKNOWN');
    return new BrokerError(code, `Angel One: ${message}${errorcode ? ` (${errorcode})` : ''}`, res.raw);
  }
}

/** Stop-loss orders go in the STOPLOSS variety; everything else is NORMAL. */
const variety = (t: OrderType) => (t === 'SL' || t === 'SL_M' ? 'STOPLOSS' : 'NORMAL');
