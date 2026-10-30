import type { Exchange } from './instrument.ts';
import { istMinutes, istWeekday } from './ist.ts';

/** Regular trading sessions in IST minutes [open, close). TODO(verify): special sessions (muhurat) are not modelled. */
const SESSIONS: Record<Exchange, [number, number]> = {
  NSE: [9 * 60 + 15, 15 * 60 + 30],
  BSE: [9 * 60 + 15, 15 * 60 + 30],
  NFO: [9 * 60 + 15, 15 * 60 + 30],
  BFO: [9 * 60 + 15, 15 * 60 + 30],
  CDS: [9 * 60, 17 * 60],
  MCX: [9 * 60, 23 * 60 + 30],
};

/** Whether [exchange] is in its regular session at [now]. [holiday] says whether today is a listed market holiday. */
export function marketOpen(exchange: Exchange, now: Date, holiday: boolean): boolean {
  const day = istWeekday(now);
  if (day === 0 || day === 6 || holiday) return false;
  const [open, close] = SESSIONS[exchange];
  const m = istMinutes(now);
  return m >= open && m < close;
}
