import { describe, expect, it } from 'vitest';

import { BROKER_ERROR_CODES, BrokerError, classifyMessage } from '../../src/domain/broker-error.ts';
import {
  AppError,
  OtpProviderError,
  SignalParseError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  tooManyRequests,
  unauthorized,
} from '../../src/domain/errors.ts';
import { instrumentId, isDerivative } from '../../src/domain/instrument.ts';
import { IST_OFFSET_MS, istDate, istMinutes, istTime, istWeekday, lastIstTime, nextIstTime } from '../../src/domain/ist.ts';
import { e164, normalizeIndianMobile, resolveIndianMobile } from '../../src/domain/phone.ts';
import {
  contractLabel,
  entryLabel,
  exchangeOf,
  exitSide,
  isBuy,
  normalizeSignalText,
  type TradeSignal,
} from '../../src/domain/signal.ts';
import { NOW } from '../helpers.ts';

describe('errors', () => {
  it('builds AppErrors with status, code and message', () => {
    const cases: [AppError, number, string, string][] = [
      [badRequest('bad'), 400, 'bad_request', 'bad'],
      [unauthorized(), 401, 'unauthorized', 'Sign in first.'],
      [unauthorized('again'), 401, 'unauthorized', 'again'],
      [forbidden('no'), 403, 'forbidden', 'no'],
      [notFound('gone'), 404, 'not_found', 'gone'],
      [conflict('dup'), 409, 'conflict', 'dup'],
    ];
    for (const [e, status, code, message] of cases) {
      expect(e).toBeInstanceOf(AppError);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe('AppError');
      expect([e.status, e.code, e.message, e.details]).toEqual([status, code, message, undefined]);
    }
  });

  it('carries retry-after details on rate limits', () => {
    const e = tooManyRequests('slow down', 30);
    expect([e.status, e.code, e.message]).toEqual([429, 'rate_limited', 'slow down']);
    expect(e.details).toEqual({ retry_after_seconds: 30 });
  });

  it('has typed subclasses for signal parsing and OTP delivery', () => {
    const p = new SignalParseError('nope');
    expect(p).toBeInstanceOf(AppError);
    expect([p.name, p.status, p.code, p.message]).toEqual(['SignalParseError', 422, 'invalid_signal', 'nope']);
    const o = new OtpProviderError('otp_send_failed', 'down');
    expect([o.name, o.status, o.code, o.message]).toEqual(['OtpProviderError', 502, 'otp_send_failed', 'down']);
  });
});

describe('ist', () => {
  it('reads date, time, weekday and minutes in India', () => {
    expect(IST_OFFSET_MS).toBe(19_800_000);
    expect(istDate(NOW)).toBe('2026-10-27');
    expect(istTime(NOW)).toBe('09:30');
    expect(istWeekday(NOW)).toBe(2);
    expect(istMinutes(NOW)).toBe(9 * 60 + 30);
    // 23:00 UTC on the 27th is already the 28th in India.
    expect(istDate(new Date('2026-10-27T23:00:00Z'))).toBe('2026-10-28');
  });

  it('finds the last and next time the IST clock read a given time', () => {
    expect(lastIstTime(NOW, 6, 5).toISOString()).toBe('2026-10-27T00:35:00.000Z');
    expect(lastIstTime(NOW, 16, 0).toISOString()).toBe('2026-10-26T10:30:00.000Z');
    expect(lastIstTime(NOW, 9, 30).toISOString()).toBe(NOW.toISOString());
    expect(nextIstTime(NOW, 16, 0).toISOString()).toBe('2026-10-27T10:30:00.000Z');
    expect(nextIstTime(NOW, 6, 5).toISOString()).toBe('2026-10-28T00:35:00.000Z');
    expect(nextIstTime(NOW, 9, 30).toISOString()).toBe('2026-10-28T04:00:00.000Z');
  });
});

describe('phone', () => {
  it('normalises the ways Indian numbers are typed', () => {
    for (const input of ['98765 43210', '+91-98765-43210', '098765 43210', '919876543210', '(98765) 43210', '+91 98765.43210']) {
      expect(normalizeIndianMobile(input)).toBe('919876543210');
    }
    expect(e164('919876543210')).toBe('+919876543210');
  });

  it('refuses anything that is not a 10-digit Indian mobile', () => {
    for (const input of ['', 'abc', '12345', '58765 43210', '9876543210123', '+1 415 555 0100']) {
      expect(() => normalizeIndianMobile(input)).toThrow('Enter a 10-digit Indian mobile number.');
    }
    try {
      normalizeIndianMobile('x');
    } catch (e) {
      expect((e as AppError).status).toBe(400);
    }
  });

  it('resolves either { phone } or { countryCode, mobile }', () => {
    expect(resolveIndianMobile({ phone: '9876543210' })).toBe('919876543210');
    expect(resolveIndianMobile({ countryCode: '+91', mobile: '98765 43210' })).toBe('919876543210');
    expect(resolveIndianMobile({ countryCode: ' 91 ', mobile: '9876543210', phone: 'ignored' })).toBe('919876543210');
    expect(() => resolveIndianMobile({ countryCode: '+1', mobile: '4155550100' })).toThrow('Only Indian (+91) mobile numbers are supported.');
    // A blank country code falls back to phone.
    expect(resolveIndianMobile({ countryCode: ' ', mobile: '9876543210', phone: '8765432109' })).toBe('918765432109');
    expect(() => resolveIndianMobile({})).toThrow('Enter a 10-digit Indian mobile number.');
  });
});

describe('signal helpers', () => {
  const signal = (overrides: Partial<TradeSignal> = {}): TradeSignal => ({
    action: 'BUY',
    underlying: 'SENSEX',
    expiry: '2026-10-29',
    strike: 73100,
    optionType: 'PE',
    entryLow: 400,
    entryHigh: 420,
    stopLoss: 300,
    targets: [540],
    raw: '',
    warnings: [],
    ...overrides,
  });

  it('knows side, exit side and exchange', () => {
    expect(isBuy(signal())).toBe(true);
    expect(exitSide(signal())).toBe('SELL');
    expect(isBuy(signal({ action: 'SELL' }))).toBe(false);
    expect(exitSide(signal({ action: 'SELL' }))).toBe('BUY');
    expect(exchangeOf(signal())).toBe('BFO');
    expect(exchangeOf(signal({ underlying: 'BANKEX' }))).toBe('BFO');
    expect(exchangeOf(signal({ underlying: 'NIFTY' }))).toBe('NFO');
  });

  it('labels the contract and entry', () => {
    expect(contractLabel(signal())).toBe('SENSEX 29 OCT 2026 73100 PE');
    expect(contractLabel(signal({ underlying: 'NIFTY', expiry: '2027-01-07', strike: 24500.5, optionType: 'CE' }))).toBe(
      'NIFTY 07 JAN 2027 24500.50 CE',
    );
    expect(entryLabel(signal())).toBe('400–420');
    expect(entryLabel(signal({ entryLow: 400, entryHigh: 400 }))).toBe('400');
    expect(entryLabel(signal({ entryLow: 99.5, entryHigh: 100.25 }))).toBe('99.50–100.25');
  });

  it('normalises signal text for repeat detection', () => {
    expect(normalizeSignalText('  buy  sensex\n29 oct\t73100 put ')).toBe('BUY SENSEX 29 OCT 73100 PUT');
  });
});

describe('instrument', () => {
  it('formats canonical ids', () => {
    expect(instrumentId({ exchange: 'NSE', type: 'EQ', underlying: 'reliance', expiry: null, strikePaise: null })).toBe('NSE:EQ:RELIANCE');
    expect(instrumentId({ exchange: 'NFO', type: 'FUT', underlying: 'NIFTY', expiry: '2026-10-29', strikePaise: null })).toBe(
      'NFO:FUT:NIFTY:2026-10-29',
    );
    expect(instrumentId({ exchange: 'BFO', type: 'PE', underlying: 'SENSEX', expiry: '2026-10-29', strikePaise: 7310000 })).toBe(
      'BFO:PE:SENSEX:2026-10-29:7310000',
    );
    expect(instrumentId({ exchange: 'NFO', type: 'CE', underlying: 'NIFTY', expiry: null, strikePaise: null })).toBe('NFO:CE:NIFTY::');
  });

  it('knows derivatives', () => {
    expect(isDerivative({ type: 'EQ' })).toBe(false);
    expect(isDerivative({ type: 'FUT' })).toBe(true);
    expect(isDerivative({ type: 'CE' })).toBe(true);
  });
});

describe('BrokerError', () => {
  it('carries a code, message and raw exchange', () => {
    const e = new BrokerError('REJECTED_BY_EXCHANGE', 'no');
    expect(e).toBeInstanceOf(Error);
    expect([e.name, e.code, e.message, e.raw]).toEqual(['BrokerError', 'REJECTED_BY_EXCHANGE', 'no', null]);
    const raw = { request: { method: 'POST', url: 'u', body: null }, response: null };
    expect(new BrokerError('UNKNOWN', 'x', raw).raw).toBe(raw);
  });

  it('marks only TIMEOUT and BROKER_UNAVAILABLE as outcome unknown', () => {
    const unknown = BROKER_ERROR_CODES.filter((c) => new BrokerError(c, '').outcomeUnknown);
    expect(unknown).toEqual(['TIMEOUT', 'BROKER_UNAVAILABLE']);
  });

  it('classifies common rejection phrases', () => {
    const cases: [string, string | null][] = [
      ['Insufficient funds. Required margin is 400', 'INSUFFICIENT_FUNDS'],
      ['Margin shortfall', 'INSUFFICIENT_FUNDS'],
      ['Not enough margin', 'INSUFFICIENT_FUNDS'],
      ['Markets are closed right now', 'MARKET_CLOSED'],
      ['Order placed outside market hours', 'MARKET_CLOSED'],
      ['Market is closed', 'MARKET_CLOSED'],
      ['Too many requests', 'RATE_LIMITED'],
      ['Exceeding access rate', 'RATE_LIMITED'],
      ['Request throttled', 'RATE_LIMITED'],
      ['Invalid access token', 'AUTH_EXPIRED'],
      ['Token is expired', 'AUTH_EXPIRED'],
      ['Unauthorised', 'AUTH_EXPIRED'],
      ['Invalid session', 'AUTH_EXPIRED'],
      ['Invalid tradingsymbol', 'INVALID_SYMBOL'],
      ['Instrument expired', 'INVALID_SYMBOL'],
      ['Symbol not found', 'INVALID_SYMBOL'],
      ['Order price is outside the circuit', null],
    ];
    for (const [message, code] of cases) expect([message, classifyMessage(message)]).toEqual([message, code]);
  });
});
