import { describe, expect, it } from 'vitest';

import { needsUserAction, standardModifyProblem, type BrokerOrder, type Capabilities, type ModifyRequest } from '../../src/brokers/adapter.ts';
import { token } from '../helpers.ts';

const caps = (modifiable: Capabilities['modifiable']): Capabilities => ({
  orderTypes: ['MARKET', 'LIMIT'],
  products: ['INTRADAY'],
  exchanges: ['NSE'],
  modifiable,
  ratePerSecond: 10,
  headlessRefresh: false,
  webhooks: false,
});

const current: BrokerOrder = {
  brokerOrderId: 'B1',
  status: 'OPEN',
  quantity: 10,
  filledQty: 0,
  avgPricePaise: null,
  pricePaise: 100,
  triggerPaise: null,
  orderType: 'LIMIT',
  clientRef: null,
  message: null,
  raw: null,
};

const req = (overrides: Partial<ModifyRequest> = {}): ModifyRequest => ({
  brokerOrderId: 'B1',
  symbol: { nativeId: '1', tradingSymbol: 'X', exchange: 'NSE' },
  side: 'BUY',
  product: 'INTRADAY',
  quantity: 10,
  orderType: 'LIMIT',
  pricePaise: 105,
  triggerPaise: null,
  ...overrides,
});

describe('needsUserAction', () => {
  it('tells a re-login request from a token set', () => {
    expect(needsUserAction({ needsUserAction: true, reason: 'TOTP needed' })).toBe(true);
    expect(needsUserAction(token())).toBe(false);
  });
});

describe('standardModifyProblem', () => {
  const all = caps(['price', 'quantity', 'triggerPrice', 'orderType']);

  it('allows price changes and permitted quantity or type changes', () => {
    expect(standardModifyProblem(caps(['price']), current, req())).toBeNull();
    expect(standardModifyProblem(all, current, req({ quantity: 20, orderType: 'MARKET', pricePaise: null }))).toBeNull();
  });

  it('refuses a quantity change the broker cannot make', () => {
    expect(standardModifyProblem(caps(['price']), current, req({ quantity: 20 }))).toBe('This broker cannot change quantity.');
  });

  it('refuses an order type change the broker cannot make, unless the current type is unknown', () => {
    expect(standardModifyProblem(caps(['price', 'quantity']), current, req({ orderType: 'MARKET' }))).toBe('This broker cannot change the order type.');
    expect(standardModifyProblem(caps(['price']), { ...current, orderType: null }, req({ orderType: 'MARKET' }))).toBeNull();
  });

  it('refuses quantities at or below what has filled', () => {
    const partial = { ...current, status: 'PARTIALLY_FILLED' as const, filledQty: 6 };
    expect(standardModifyProblem(all, partial, req({ quantity: 6 }))).toBe('Quantity must be more than the 6 already filled.');
    expect(standardModifyProblem(all, partial, req({ quantity: 5 }))).toBe('Quantity must be more than the 6 already filled.');
    expect(standardModifyProblem(all, partial, req({ quantity: 7 }))).toBeNull();
  });
});
