import { BrokerError } from '../../domain/broker-error.ts';
import { isInstrumentType, type BrokerSymbol, type Exchange } from '../../domain/instrument.ts';
import { brokerRupeesToPaise, positivePaise } from '../../domain/money.ts';
import type { LegStatus, OrderType } from '../../domain/order.ts';
import type { BrokerInstrument, BrokerOrder } from '../adapter.ts';
import { nonEmpty, textOf } from '../http.ts';
import { mapStatus, type BrokerState } from '../status.ts';

/** Turning Groww Trade API payloads into the adapter contract's types. Pure functions, no I/O. */

/** Groww splits orders by segment; every order call needs one. */
export const SEGMENTS = ['FNO', 'CASH'] as const;
export type Segment = (typeof SEGMENTS)[number];

const ORDER_TYPE_BACK: Record<string, OrderType> = { MARKET: 'MARKET', LIMIT: 'LIMIT', SL: 'SL', SL_M: 'SL_M' };
/** Groww exchange + segment → our exchange. Other combinations aren't traded here. */
const EXCHANGE_OF: Record<string, Exchange> = {
  'NSE:CASH': 'NSE',
  'BSE:CASH': 'BSE',
  'NSE:FNO': 'NFO',
  'BSE:FNO': 'BFO',
};

const GROWW_STATES: Record<string, BrokerState> = {
  COMPLETED: 'FILLED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  FAILED: 'REJECTED',
  NEW: 'WORKING',
  ACKED: 'WORKING',
  OPEN: 'WORKING',
  TRIGGER_PENDING: 'WORKING',
  APPROVED: 'WORKING',
};

/** Groww's order status → ours. */
export function growwStatus(status: string, filled: number, quantity: number): LegStatus {
  // TODO(verify): whether Groww reports EXECUTED for a partly filled order, or only once fully filled.
  if (status.toUpperCase() === 'EXECUTED') return quantity > 0 && filled < quantity ? 'PARTIALLY_FILLED' : 'FILLED';
  return mapStatus(GROWW_STATES, status, filled);
}

/**
 * Groww needs the segment on modify, cancel and status calls, but the core only
 * hands those calls a broker order id. So the id we return from placeOrder (and
 * listOrders) is `<SEGMENT>:<groww_order_id>`, e.g. `FNO:GLTFO123`, and it is
 * split again here.
 */
export function splitOrderId(brokerOrderId: string): { segment: Segment; id: string } {
  const at = brokerOrderId.indexOf(':');
  const segment = brokerOrderId.slice(0, at);
  const id = brokerOrderId.slice(at + 1);
  if (at < 0 || !(SEGMENTS as readonly string[]).includes(segment) || !id) {
    throw new BrokerError('NOT_FOUND', `Not a Groww order id: ${brokerOrderId}.`);
  }
  return { segment: segment as Segment, id };
}

/**
 * Groww names a market by exchange and segment, so BrokerSymbol.exchange holds
 * both, e.g. `NSE:FNO` or `BSE:CASH`. The core passes it through untouched.
 */
export function splitExchange(symbol: BrokerSymbol): { exchange: string; segment: Segment } {
  const [exchange = '', segment = ''] = symbol.exchange.split(':');
  if (!EXCHANGE_OF[`${exchange}:${segment}`]) {
    throw new BrokerError('INVALID_SYMBOL', `Groww can't trade on ${symbol.exchange}.`);
  }
  return { exchange, segment: segment as Segment };
}

/** One instrument-list row → an instrument, or null for markets and types we don't trade. */
export function toInstrument(r: Record<string, string>): BrokerInstrument | null {
  const marketKey = `${r['exchange'] ?? ''}:${r['segment'] ?? ''}`;
  const exchange = EXCHANGE_OF[marketKey];
  const type = r['instrument_type'] ?? '';
  const tradingSymbol = r['trading_symbol'] ?? '';
  if (!exchange || !isInstrumentType(type) || !tradingSymbol) return null;
  const derivative = type !== 'EQ';
  return {
    exchange,
    type,
    underlying: derivative ? r['underlying_symbol'] ?? tradingSymbol : tradingSymbol,
    expiry: derivative ? nonEmpty(r['expiry_date']) : null,
    strikePaise: type === 'CE' || type === 'PE' ? brokerRupeesToPaise(r['strike_price']) : null,
    lotSize: Number(r['lot_size']) || 1,
    tickPaise: positivePaise(r['tick_size']) ?? 5,
    symbol: { nativeId: tradingSymbol, tradingSymbol, exchange: marketKey },
  };
}

export function toOrder(r: Record<string, unknown>, segment: Segment): BrokerOrder {
  // TODO(verify): field names of Groww's order detail / order list rows.
  const filled = Number(r['filled_quantity']) || 0;
  const quantity = Number(r['quantity']) || 0;
  return {
    brokerOrderId: `${segment}:${textOf(r['groww_order_id'])}`,
    status: growwStatus(textOf(r['order_status']), filled, quantity),
    quantity,
    filledQty: filled,
    avgPricePaise: filled > 0 ? brokerRupeesToPaise(r['average_fill_price']) : null,
    pricePaise: positivePaise(r['price']),
    triggerPaise: positivePaise(r['trigger_price']),
    orderType: ORDER_TYPE_BACK[textOf(r['order_type'])] ?? null,
    clientRef: typeof r['order_reference_id'] === 'string' ? r['order_reference_id'] : null,
    message: typeof r['remark'] === 'string' ? r['remark'] : null,
    raw: r,
  };
}
