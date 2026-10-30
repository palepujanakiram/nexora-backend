import type { Exchange } from '../../domain/instrument.ts';
import { brokerRupeesToPaise } from '../../domain/money.ts';
import type { LegStatus, OrderType } from '../../domain/order.ts';
import type { BrokerInstrument, BrokerOrder } from '../adapter.ts';
import { mapStatus, type BrokerState } from '../status.ts';

/** Turning SmartAPI payloads into the adapter contract's types. Pure functions, no I/O. */

const ORDER_TYPE_BACK: Record<string, OrderType> = {
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  STOPLOSS_LIMIT: 'SL',
  STOPLOSS_MARKET: 'SL_M',
};

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

const ANGEL_STATES: Record<string, BrokerState> = {
  COMPLETE: 'FILLED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  OPEN: 'WORKING',
  'TRIGGER PENDING': 'WORKING',
};

/** Angel's order status (`orderstatus`) → ours. */
export const angelStatus = (status: string, filled: number): LegStatus => mapStatus(ANGEL_STATES, status, filled);

/** Angel's expiry (`30OCT2026`) → `2026-10-30`, or null when it isn't one. */
export function angelExpiry(expiry: string): string | null {
  const m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(expiry.trim().toUpperCase());
  const month = m ? MONTHS[m[2]!] : undefined;
  return m && month ? `${m[3]}-${month}-${m[1]}` : null;
}

/** A token string without a `Bearer ` prefix (TODO(verify): some SmartAPI answers include it), or ''. */
export function bare(value: unknown): string {
  return typeof value === 'string' ? value.replace(/^Bearer\s+/i, '').trim() : '';
}

const textOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

export function toOrder(r: Record<string, unknown>): BrokerOrder {
  const filled = Number(r['filledshares']) || 0;
  return {
    brokerOrderId: String(r['orderid']),
    status: angelStatus(String(r['orderstatus'] || r['status'] || ''), filled),
    quantity: Number(r['quantity']) || 0,
    filledQty: filled,
    avgPricePaise: filled > 0 ? brokerRupeesToPaise(r['averageprice']) : null,
    pricePaise: brokerRupeesToPaise(r['price']) || null,
    triggerPaise: brokerRupeesToPaise(r['triggerprice']) || null,
    orderType: ORDER_TYPE_BACK[String(r['ordertype'])] ?? null,
    clientRef: textOf(r['ordertag']),
    message: textOf(r['text']),
    raw: r,
  };
}

interface ScripRow {
  exch: string;
  kind: string;
  symbolText: string;
  base: Pick<BrokerInstrument, 'underlying' | 'lotSize' | 'tickPaise' | 'symbol'>;
  expiry: string;
  strike: unknown;
}

function scripRow(r: Record<string, unknown>): ScripRow {
  const exch = String(r['exch_seg'] ?? '');
  const symbolText = String(r['symbol'] ?? '');
  return {
    exch,
    kind: String(r['instrumenttype'] ?? ''),
    symbolText,
    base: {
      underlying: String(r['name'] ?? ''),
      lotSize: Number(r['lotsize']) || 1,
      // Angel's strike and tick_size are in paise already.
      tickPaise: Math.round(Number(r['tick_size'])) || 5,
      symbol: { nativeId: String(r['token'] ?? ''), tradingSymbol: symbolText, exchange: exch },
    },
    expiry: String(r['expiry'] ?? ''),
    strike: r['strike'],
  };
}

const isEquity = (row: ScripRow) => row.kind === '' && ((row.exch === 'NSE' && row.symbolText.endsWith('-EQ')) || row.exch === 'BSE');

/** A derivative's type from Angel's instrument type and the symbol's last two letters, or null for anything else. */
function derivativeType(row: ScripRow): 'FUT' | 'CE' | 'PE' | null {
  if (row.kind.startsWith('FUT')) return 'FUT';
  const right = row.symbolText.slice(-2);
  return row.kind.startsWith('OPT') && (right === 'CE' || right === 'PE') ? right : null;
}

/** One scrip-master row → an instrument, or null for segments and types we don't trade. */
export function toInstrument(r: Record<string, unknown>): BrokerInstrument | null {
  const row = scripRow(r);
  if (isEquity(row)) return { ...row.base, exchange: row.exch as Exchange, type: 'EQ', expiry: null, strikePaise: null };
  if (row.exch !== 'NFO' && row.exch !== 'BFO') return null;
  const expiry = angelExpiry(row.expiry);
  const type = derivativeType(row);
  if (!expiry || !type) return null;
  const strikePaise = type === 'FUT' ? null : Math.round(Number(row.strike));
  return { ...row.base, exchange: row.exch, type, expiry, strikePaise };
}
