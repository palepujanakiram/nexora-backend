import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/domain/errors.ts';
import { brokerRupeesToPaise, isOnTick, rupeeNumber, rupees, toPaise } from '../../src/domain/money.ts';

describe('toPaise', () => {
  it('converts rupee strings and numbers exactly', () => {
    expect(toPaise('420.05')).toBe(42005);
    expect(toPaise(' 420.5 ')).toBe(42050);
    expect(toPaise('420')).toBe(42000);
    expect(toPaise(420.05)).toBe(42005);
    expect(toPaise(0.1 + 0.2)).toBe(30);
    expect(toPaise(1_000_000)).toBe(100_000_000);
    expect(toPaise('-1.5')).toBe(-150);
    expect(toPaise(-0.05)).toBe(-5);
    expect(toPaise('1.2300')).toBe(123);
  });

  it('refuses non-prices and more than 2 decimals with a 400', () => {
    expect(() => toPaise('abc')).toThrow('Not a price: abc.');
    expect(() => toPaise('')).toThrow('Not a price: .');
    expect(() => toPaise('1.23456')).toThrow('Not a price: 1.23456.');
    expect(() => toPaise('420.055')).toThrow('Prices can have at most 2 decimal places: 420.055.');
    expect(() => toPaise(420.055)).toThrow('Prices can have at most 2 decimal places: 420.055.');
    try {
      toPaise('x');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(400);
    }
  });
});

describe('rupees', () => {
  it('formats paise with two decimals', () => {
    expect(rupees(42005)).toBe('420.05');
    expect(rupees(42050)).toBe('420.50');
    expect(rupees(0)).toBe('0.00');
    expect(rupees(7)).toBe('0.07');
    expect(rupees(-5)).toBe('-0.05');
    expect(rupees(-12345)).toBe('-123.45');
    expect(rupeeNumber(42005)).toBe(420.05);
    expect(rupeeNumber(-150)).toBe(-1.5);
  });
});

describe('brokerRupeesToPaise', () => {
  it('rounds broker floats and parses numeric strings', () => {
    expect(brokerRupeesToPaise(420.05000000001)).toBe(42005);
    expect(brokerRupeesToPaise(420.04999999)).toBe(42005);
    expect(brokerRupeesToPaise('12.3')).toBe(1230);
    expect(brokerRupeesToPaise(0)).toBe(0);
    expect(brokerRupeesToPaise(-3.5)).toBe(-350);
  });

  it('returns null for empty and non-numeric values', () => {
    for (const v of [null, undefined, '', 'abc', Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(brokerRupeesToPaise(v)).toBeNull();
    }
  });
});

describe('isOnTick', () => {
  it('checks the tick size', () => {
    expect(isOnTick(42005, 5)).toBe(true);
    expect(isOnTick(42003, 5)).toBe(false);
    expect(isOnTick(100, 100)).toBe(true);
  });
});
