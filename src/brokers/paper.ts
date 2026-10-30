import { randomBytes } from 'node:crypto';

import { BrokerError } from '../domain/broker-error.ts';
import type { Paise } from '../domain/money.ts';
import type { LegStatus, OrderType, Product, Side } from '../domain/order.ts';
import type { Db } from '../data/db.ts';
import {
  standardModifyProblem,
  type AccountContext,
  type BrokerAck,
  type BrokerAdapter,
  type BrokerOrder,
  type BrokerPosition,
  type Capabilities,
  type LinkChallenge,
  type ModifyRequest,
  type PlaceRequest,
  type TokenSet,
} from './adapter.ts';

const CAPABILITIES: Capabilities = {
  orderTypes: ['MARKET', 'LIMIT', 'SL', 'SL_M'],
  products: ['DELIVERY', 'INTRADAY', 'CARRYFORWARD'],
  exchanges: ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'],
  modifiable: ['price', 'quantity', 'triggerPrice', 'orderType'],
  ratePerSecond: 50,
  headlessRefresh: true,
  webhooks: false,
};

interface PaperRow {
  id: string;
  native_id: string;
  trading_symbol: string;
  exchange: string;
  side: Side;
  product: Product;
  order_type: OrderType;
  quantity: number;
  filled_qty: number;
  status: LegStatus;
  price_paise: Paise | null;
  trigger_paise: Paise | null;
  avg_price_paise: Paise | null;
  client_ref: string;
}

/**
 * A simulated broker for accounts in paper mode. Nothing leaves the server.
 * There's no market data, so it fills only against the price the user saw
 * (`referencePrice`): a market order, or a limit order at or better than that
 * price, fills at once; everything else rests OPEN until cancelled or modified.
 */
export class PaperBroker implements BrokerAdapter {
  readonly code = 'paper';
  readonly label = 'Paper trading';
  readonly capabilities = CAPABILITIES;
  readonly credentialFields = [];
  readonly instrumentsNeedSession = false;
  private readonly db: Db;
  private readonly clock: () => Date;

  constructor(deps: { db: Db; clock: () => Date }) {
    this.db = deps.db;
    this.clock = deps.clock;
  }

  async startLink(): Promise<LinkChallenge> {
    return { kind: 'input', fields: [], message: 'Paper accounts need no broker login.', url: null };
  }

  async completeLink(): Promise<TokenSet> {
    return { accessToken: 'paper', refreshToken: null, expiresAt: new Date(this.clock().getTime() + 365 * 86_400_000) };
  }

  async refreshSession(): Promise<TokenSet> {
    return this.completeLink();
  }

  async fetchInstrumentMaster(): Promise<never[]> {
    return [];
  }

  async placeOrder(ctx: AccountContext, req: PlaceRequest): Promise<BrokerAck> {
    const id = `PAPER${randomBytes(6).toString('hex').toUpperCase()}`;
    const fillAt = this.fillPrice(req.side, req.orderType, req.pricePaise, req.referencePricePaise);
    await this.db.query(
      `INSERT INTO paper_orders (id, broker_account_id, native_id, trading_symbol, exchange, side, product, order_type,
         quantity, filled_qty, status, price_paise, trigger_paise, avg_price_paise, client_ref, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id, ctx.accountId, req.symbol.nativeId, req.symbol.tradingSymbol, req.symbol.exchange, req.side, req.product,
        req.orderType, req.quantity, fillAt === null ? 0 : req.quantity, fillAt === null ? 'OPEN' : 'FILLED',
        req.pricePaise, req.triggerPaise, fillAt, req.clientRef, this.clock(),
      ],
    );
    return { brokerOrderId: id, raw: { request: { method: 'PAPER', url: 'paper:place', body: req }, response: { status: 200, body: { id } } } };
  }

  async modifyOrder(ctx: AccountContext, req: ModifyRequest): Promise<BrokerAck> {
    const row = await this.row(ctx, req.brokerOrderId);
    if (row.status !== 'OPEN') throw new BrokerError('REJECTED_BY_EXCHANGE', `Paper order is ${row.status}.`);
    await this.db.query(
      'UPDATE paper_orders SET quantity = $2, order_type = $3, price_paise = $4, trigger_paise = $5 WHERE id = $1',
      [row.id, req.quantity, req.orderType, req.pricePaise, req.triggerPaise],
    );
    return { brokerOrderId: row.id, raw: { request: { method: 'PAPER', url: 'paper:modify', body: req }, response: { status: 200, body: {} } } };
  }

  async cancelOrder(ctx: AccountContext, brokerOrderId: string): Promise<BrokerAck> {
    const row = await this.row(ctx, brokerOrderId);
    if (row.status !== 'OPEN') throw new BrokerError('REJECTED_BY_EXCHANGE', `Paper order is ${row.status}.`);
    await this.db.query(`UPDATE paper_orders SET status = 'CANCELLED' WHERE id = $1`, [row.id]);
    return { brokerOrderId, raw: { request: { method: 'PAPER', url: 'paper:cancel', body: { brokerOrderId } }, response: { status: 200, body: {} } } };
  }

  async getOrder(ctx: AccountContext, brokerOrderId: string): Promise<BrokerOrder> {
    return toOrder(await this.row(ctx, brokerOrderId));
  }

  async listOrders(ctx: AccountContext): Promise<BrokerOrder[]> {
    const rows = await this.db.query<PaperRow>('SELECT * FROM paper_orders WHERE broker_account_id = $1 ORDER BY created_at', [ctx.accountId]);
    return rows.map(toOrder);
  }

  modifyProblem(current: BrokerOrder, req: ModifyRequest): string | null {
    return standardModifyProblem(CAPABILITIES, current, req);
  }

  async getPositions(ctx: AccountContext): Promise<BrokerPosition[]> {
    const rows = await this.db.query<{
      native_id: string; trading_symbol: string; exchange: string; product: Product; net: number; buy_value: number; buy_qty: number; sell_value: number; sell_qty: number;
    }>(
      `SELECT native_id, trading_symbol, exchange, product,
              sum(CASE WHEN side = 'BUY' THEN filled_qty ELSE -filled_qty END)::int8 AS net,
              sum(CASE WHEN side = 'BUY' THEN filled_qty * avg_price_paise ELSE 0 END)::int8 AS buy_value,
              sum(CASE WHEN side = 'BUY' THEN filled_qty ELSE 0 END)::int8 AS buy_qty,
              sum(CASE WHEN side = 'SELL' THEN filled_qty * avg_price_paise ELSE 0 END)::int8 AS sell_value,
              sum(CASE WHEN side = 'SELL' THEN filled_qty ELSE 0 END)::int8 AS sell_qty
         FROM paper_orders WHERE broker_account_id = $1 AND filled_qty > 0
        GROUP BY native_id, trading_symbol, exchange, product`,
      [ctx.accountId],
    );
    return rows.map((r) => {
      const [value, qty] = r.net >= 0 ? [r.buy_value, r.buy_qty] : [r.sell_value, r.sell_qty];
      return {
        symbol: { nativeId: r.native_id, tradingSymbol: r.trading_symbol, exchange: r.exchange },
        product: r.product,
        netQty: r.net,
        avgPricePaise: qty > 0 ? Math.round(value / qty) : null,
        lastPricePaise: null,
        pnlPaise: null,
      };
    });
  }

  private fillPrice(side: Side, type: OrderType, limit: Paise | null, reference: Paise | null): Paise | null {
    if (reference === null) return null;
    if (type === 'MARKET') return reference;
    if (type === 'LIMIT' && limit !== null && (side === 'BUY' ? limit >= reference : limit <= reference)) return reference;
    return null;
  }

  private async row(ctx: AccountContext, id: string): Promise<PaperRow> {
    const [row] = await this.db.query<PaperRow>('SELECT * FROM paper_orders WHERE id = $1 AND broker_account_id = $2', [id, ctx.accountId]);
    if (!row) throw new BrokerError('NOT_FOUND', `No paper order ${id}.`);
    return row;
  }
}

function toOrder(r: PaperRow): BrokerOrder {
  return {
    brokerOrderId: r.id,
    status: r.status,
    quantity: r.quantity,
    filledQty: r.filled_qty,
    avgPricePaise: r.avg_price_paise,
    pricePaise: r.price_paise,
    triggerPaise: r.trigger_paise,
    orderType: r.order_type,
    clientRef: r.client_ref,
    message: null,
    raw: r,
  };
}
