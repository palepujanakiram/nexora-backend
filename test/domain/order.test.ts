import { describe, expect, it } from 'vitest';

import {
  LEG_STATUSES,
  intentProblem,
  isTerminal,
  isWorking,
  needsPrice,
  needsTrigger,
  opposite,
  parentStatus,
  type LegStatus,
} from '../../src/domain/order.ts';

const leg = (status: LegStatus, filledQty = 0) => ({ status, filledQty });

describe('order basics', () => {
  it('flips sides and knows which order types need prices', () => {
    expect(opposite('BUY')).toBe('SELL');
    expect(opposite('SELL')).toBe('BUY');
    expect(['MARKET', 'LIMIT', 'SL', 'SL_M'].map((t) => needsPrice(t as never))).toEqual([false, true, true, false]);
    expect(['MARKET', 'LIMIT', 'SL', 'SL_M'].map((t) => needsTrigger(t as never))).toEqual([false, false, true, true]);
  });

  it('knows terminal and working leg statuses', () => {
    expect(LEG_STATUSES.filter(isTerminal)).toEqual(['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED']);
    expect(LEG_STATUSES.filter(isWorking)).toEqual(['SUBMITTED', 'OPEN', 'PARTIALLY_FILLED']);
  });
});

describe('parentStatus', () => {
  it('derives the parent status from its legs', () => {
    expect(parentStatus([])).toBe('FAILED');
    expect(parentStatus([leg('FILLED', 10), leg('OPEN')])).toBe('IN_PROGRESS');
    expect(parentStatus([leg('FILLED', 10), leg('UNKNOWN')])).toBe('IN_PROGRESS');
    expect(parentStatus([leg('FILLED', 10), leg('FILLED', 10)])).toBe('COMPLETE');
    expect(parentStatus([leg('FILLED', 10), leg('REJECTED')])).toBe('PARTIAL');
    expect(parentStatus([leg('CANCELLED', 5), leg('CANCELLED')])).toBe('PARTIAL');
    expect(parentStatus([leg('REJECTED'), leg('REJECTED')])).toBe('FAILED');
    expect(parentStatus([leg('REJECTED'), leg('CANCELLED')])).toBe('CANCELLED');
    expect(parentStatus([leg('EXPIRED')])).toBe('CANCELLED');
  });
});

describe('intentProblem', () => {
  const base = { quantity: 10, orderType: 'LIMIT' as const, pricePaise: 100, triggerPaise: null };

  it('accepts well-formed intents', () => {
    expect(intentProblem(base)).toBeNull();
    expect(intentProblem({ quantity: 1, orderType: 'MARKET', pricePaise: null, triggerPaise: null })).toBeNull();
    expect(intentProblem({ quantity: 1, orderType: 'SL', pricePaise: 100, triggerPaise: 95 })).toBeNull();
    expect(intentProblem({ quantity: 1, orderType: 'SL_M', pricePaise: null, triggerPaise: 95 })).toBeNull();
  });

  it('names each problem', () => {
    expect(intentProblem({ ...base, quantity: 0 })).toBe('Quantity must be a positive whole number.');
    expect(intentProblem({ ...base, quantity: 1.5 })).toBe('Quantity must be a positive whole number.');
    expect(intentProblem({ ...base, pricePaise: null })).toBe('LIMIT orders need a price.');
    expect(intentProblem({ ...base, pricePaise: 0 })).toBe('LIMIT orders need a price.');
    expect(intentProblem({ ...base, orderType: 'MARKET' })).toBe('MARKET orders take no price.');
    expect(intentProblem({ ...base, orderType: 'SL' })).toBe('SL orders need a trigger price.');
    expect(intentProblem({ ...base, orderType: 'SL', triggerPaise: -1 })).toBe('SL orders need a trigger price.');
    expect(intentProblem({ ...base, triggerPaise: 90 })).toBe('LIMIT orders take no trigger price.');
  });
});
