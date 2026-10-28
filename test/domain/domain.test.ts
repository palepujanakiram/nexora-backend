import { describe, expect, it } from 'vitest';

import { hasValidToken, maskKey } from '../../src/domain/account.ts';
import { AppError, BrokerApiError, SignalParseError, badRequest, conflict, forbidden, notFound, unauthorized } from '../../src/domain/errors.ts';
import { istDate, istTime, lastIstTime } from '../../src/domain/ist.ts';
import { e164, normalizeIndianMobile } from '../../src/domain/phone.ts';
import { contractLabel, entryLabel, exchangeOf, exitSide, isBuy, normalizeSignalText } from '../../src/domain/signal.ts';
import { DEFAULT_EXECUTION_SETTINGS, TradePricing, hasExits } from '../../src/domain/trade.ts';
import { NOW, account, signal } from '../helpers.ts';

describe('phone', () => {
  it('normalizes Indian mobile numbers as typed to 91XXXXXXXXXX', () => {
    for (const typed of ['9876543210', '98765 43210', '+91 98765-43210', '91 9876543210', '098765 43210', '(+91) 98765.43210']) {
      expect(normalizeIndianMobile(typed)).toBe('919876543210');
    }
    expect(normalizeIndianMobile('6000000000')).toBe('916000000000');
    expect(e164('919876543210')).toBe('+919876543210');
  });

  it('rejects anything that is not a 10-digit Indian mobile number', () => {
    for (const typed of ['', '12345', '5876543210', '98765432101', '+1 415 555 0100', '98765abc10', '919876543', '0091 9876543210']) {
      expect(() => normalizeIndianMobile(typed)).toThrow('Enter a 10-digit Indian mobile number.');
    }
  });
});

describe('ist', () => {
  it('reports the date and time in India', () => {
    expect(istDate(new Date('2026-10-26T18:29:00Z'))).toBe('2026-10-26');
    expect(istDate(new Date('2026-10-26T18:30:00Z'))).toBe('2026-10-27');
    expect(istTime(NOW)).toBe('09:30');
  });

  it('finds the last time the IST clock read a given time', () => {
    // 09:30 IST: 06:00 IST today has passed.
    expect(lastIstTime(NOW, 6, 0).toISOString()).toBe('2026-10-27T00:30:00.000Z');
    // 09:30 IST: 10:00 IST today is still ahead, so it's yesterday's.
    expect(lastIstTime(NOW, 10, 0).toISOString()).toBe('2026-10-26T04:30:00.000Z');
  });
});

describe('account', () => {
  it('a token is valid until the next daily reset (06:00 IST, 03:30 for Upstox)', () => {
    const issuedAt = (iso: string) => new Date(iso);
    // Issued 05:00 IST today: before today's 06:00 reset, so expired for Kite…
    expect(hasValidToken(account({ tokenIssuedAt: issuedAt('2026-10-26T23:30:00Z') }), NOW)).toBe(false);
    // …but after Upstox's 03:30 reset.
    expect(hasValidToken(account({ broker: 'upstox', tokenIssuedAt: issuedAt('2026-10-26T23:30:00Z') }), NOW)).toBe(true);
    expect(hasValidToken(account(), NOW)).toBe(true);
    expect(hasValidToken(account({ accessToken: null }), NOW)).toBe(false);
    expect(hasValidToken(account({ accessToken: '' }), NOW)).toBe(false);
    expect(hasValidToken(account({ tokenIssuedAt: null }), NOW)).toBe(false);
  });

  it('masks API keys', () => {
    expect(maskKey('abcdefgh')).toBe('abcd••••gh');
    expect(maskKey('short')).toBe('short');
  });
});

describe('signal helpers', () => {
  it('derive sides, exchange and labels', () => {
    const s = signal();
    expect([isBuy(s), exitSide(s), exchangeOf(s)]).toEqual([true, 'SELL', 'BFO']);
    expect(exitSide(signal({ action: 'SELL' }))).toBe('BUY');
    expect(exchangeOf(signal({ underlying: 'NIFTY' }))).toBe('NFO');
    expect(contractLabel(s)).toBe('SENSEX 29 OCT 2026 73100 PE');
    expect(contractLabel(signal({ strike: 24512.5 }))).toBe('SENSEX 29 OCT 2026 24512.50 PE');
    expect(entryLabel(s)).toBe('400–420');
    expect(entryLabel(signal({ entryLow: 99.5, entryHigh: 99.5 }))).toBe('99.50');
  });

  it('normalises signal text for duplicate checks', () => {
    expect(normalizeSignalText('  buy  nifty\n30 oct ')).toBe('BUY NIFTY 30 OCT');
  });
});

describe('trade pricing', () => {
  it('picks the entry price by mode', () => {
    const s = signal();
    expect(TradePricing.entryPrice(s, 'low')).toBe(400);
    expect(TradePricing.entryPrice(s, 'mid')).toBe(410);
    expect(TradePricing.entryPrice(s, 'high')).toBe(420);
  });

  it('picks the target, falling back to the last one', () => {
    expect(TradePricing.targetFor(signal(), DEFAULT_EXECUTION_SETTINGS)).toBe(540);
    expect(TradePricing.targetFor(signal(), { ...DEFAULT_EXECUTION_SETTINGS, targetIndex: 5 })).toBe(600);
    expect(TradePricing.targetFor(signal({ targets: [] }), DEFAULT_EXECUTION_SETTINGS)).toBeNull();
  });

  it('rounds to the tick size', () => {
    expect(TradePricing.roundToTick(100.03, 0.05)).toBe(100.05);
    expect(TradePricing.roundToTick(100.02, 0.05)).toBe(100);
  });

  it('knows when a plan has exits', () => {
    const plan = { signal: signal(), quantity: 1, entryPrice: 1, product: 'intraday' as const, stopLoss: 1, target: 2 };
    expect(hasExits(plan)).toBe(true);
    expect(hasExits({ ...plan, target: null })).toBe(false);
  });
});

describe('errors', () => {
  it('carry an HTTP status and code', () => {
    expect([badRequest('x').status, unauthorized().status, forbidden('x').status, notFound('x').status, conflict('x').status]).toEqual([
      400, 401, 403, 404, 409,
    ]);
    expect(unauthorized().message).toBe('Sign in first.');
    expect(new SignalParseError('bad')).toMatchObject({ status: 422, code: 'invalid_signal', name: 'SignalParseError' });
    expect(new BrokerApiError('down')).toBeInstanceOf(AppError);
    expect(new BrokerApiError('down')).toMatchObject({ status: 502, code: 'broker_error' });
  });
});
