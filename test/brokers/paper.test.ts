import { describe, expect, it } from 'vitest';

import type { AccountContext, BrokerOrder, ModifyRequest, PlaceRequest } from '../../src/brokers/adapter.ts';
import { PaperBroker } from '../../src/brokers/paper.ts';
import { BrokerError } from '../../src/domain/broker-error.ts';
import { testClock } from '../app.ts';
import { testDb } from '../db.ts';
import { NOW, ctx, noNetwork } from '../helpers.ts';

const SYMBOL = { nativeId: 'NSE:EQ:RELIANCE', tradingSymbol: 'RELIANCE', exchange: 'NSE' };

const place = (overrides: Partial<PlaceRequest> = {}): PlaceRequest => ({
  symbol: SYMBOL,
  side: 'BUY',
  quantity: 10,
  orderType: 'MARKET',
  product: 'DELIVERY',
  pricePaise: null,
  triggerPaise: null,
  clientRef: 'NXREF1',
  algoId: null,
  referencePricePaise: 100_00,
  ...overrides,
});

async function setup() {
  const clock = testClock();
  const paper = new PaperBroker({ db: await testDb(), clock });
  const account: AccountContext = { ...ctx(noNetwork()), accountId: 'ba_paper' };
  const other: AccountContext = { ...ctx(noNetwork()), accountId: 'ba_other' };
  /** Places [req] and moves the clock on, so orders list in placement order. */
  const submit = async (req: Partial<PlaceRequest> = {}, on = account) => {
    const ack = await paper.placeOrder(on, place(req));
    clock.advance(1000);
    return ack.brokerOrderId;
  };
  return { paper, clock, account, other, submit };
}

async function brokerError(p: Promise<unknown>): Promise<BrokerError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BrokerError) return e;
    throw e;
  }
  throw new Error('expected a BrokerError');
}

describe('PaperBroker', () => {
  it('describes itself and links without a broker login', async () => {
    const { paper, account } = await setup();
    expect([paper.code, paper.label, paper.instrumentsNeedSession, paper.credentialFields]).toEqual(['paper', 'Paper trading', false, []]);
    expect(paper.capabilities.orderTypes).toEqual(['MARKET', 'LIMIT', 'SL', 'SL_M']);
    expect(await paper.startLink()).toEqual({ kind: 'input', fields: [], message: 'Paper accounts need no broker login.', url: null });
    const year = new Date(NOW.getTime() + 365 * 86_400_000);
    expect(await paper.completeLink()).toEqual({ accessToken: 'paper', refreshToken: null, expiresAt: year });
    expect(await paper.refreshSession()).toEqual({ accessToken: 'paper', refreshToken: null, expiresAt: year });
    expect(await paper.fetchInstrumentMaster()).toEqual([]);
    expect(await paper.listOrders(account)).toEqual([]);
    expect(await paper.getPositions(account)).toEqual([]);
  });

  it('fills a market order at the reference price', async () => {
    const { paper, account } = await setup();
    const ack = await paper.placeOrder(account, place());
    expect(ack.brokerOrderId).toMatch(/^PAPER[0-9A-F]{12}$/);
    expect(ack.raw).toEqual({ request: { method: 'PAPER', url: 'paper:place', body: place() }, response: { status: 200, body: { id: ack.brokerOrderId } } });
    expect(await paper.getOrder(account, ack.brokerOrderId)).toMatchObject({
      brokerOrderId: ack.brokerOrderId,
      status: 'FILLED',
      quantity: 10,
      filledQty: 10,
      avgPricePaise: 100_00,
      pricePaise: null,
      triggerPaise: null,
      orderType: 'MARKET',
      clientRef: 'NXREF1',
      message: null,
    });
  });

  it('fills marketable limits and rests the others OPEN', async () => {
    const { paper, account, submit } = await setup();
    const buyAbove = await submit({ orderType: 'LIMIT', pricePaise: 101_00 });
    const buyAt = await submit({ orderType: 'LIMIT', pricePaise: 100_00 });
    const buyBelow = await submit({ orderType: 'LIMIT', pricePaise: 99_00 });
    const sellBelow = await submit({ side: 'SELL', orderType: 'LIMIT', pricePaise: 99_00 });
    const sellAbove = await submit({ side: 'SELL', orderType: 'LIMIT', pricePaise: 101_00 });
    const stop = await submit({ orderType: 'SL_M', triggerPaise: 105_00 });
    const noReference = await submit({ referencePricePaise: null });
    const status = async (id: string) => {
      const o = await paper.getOrder(account, id);
      return [o.status, o.filledQty, o.avgPricePaise];
    };
    expect(await status(buyAbove)).toEqual(['FILLED', 10, 100_00]);
    expect(await status(buyAt)).toEqual(['FILLED', 10, 100_00]);
    expect(await status(buyBelow)).toEqual(['OPEN', 0, null]);
    expect(await status(sellBelow)).toEqual(['FILLED', 10, 100_00]);
    expect(await status(sellAbove)).toEqual(['OPEN', 0, null]);
    expect(await status(stop)).toEqual(['OPEN', 0, null]);
    expect(await status(noReference)).toEqual(['OPEN', 0, null]);
    expect((await paper.listOrders(account)).map((o) => o.brokerOrderId)).toEqual([buyAbove, buyAt, buyBelow, sellBelow, sellAbove, stop, noReference]);
  });

  it('modifies and cancels only OPEN orders', async () => {
    const { paper, account, submit } = await setup();
    const open = await submit({ orderType: 'LIMIT', pricePaise: 90_00 });
    const filled = await submit();
    const modify: ModifyRequest = {
      brokerOrderId: open,
      symbol: SYMBOL,
      side: 'BUY',
      product: 'DELIVERY',
      quantity: 20,
      orderType: 'SL',
      pricePaise: 95_00,
      triggerPaise: 94_00,
    };
    const ack = await paper.modifyOrder(account, modify);
    expect(ack).toEqual({ brokerOrderId: open, raw: { request: { method: 'PAPER', url: 'paper:modify', body: modify }, response: { status: 200, body: {} } } });
    expect(await paper.getOrder(account, open)).toMatchObject({ status: 'OPEN', quantity: 20, orderType: 'SL', pricePaise: 95_00, triggerPaise: 94_00 });

    const modFilled = await brokerError(paper.modifyOrder(account, { ...modify, brokerOrderId: filled }));
    expect([modFilled.code, modFilled.message]).toEqual(['REJECTED_BY_EXCHANGE', 'Paper order is FILLED.']);

    expect(await paper.cancelOrder(account, open)).toEqual({
      brokerOrderId: open,
      raw: { request: { method: 'PAPER', url: 'paper:cancel', body: { brokerOrderId: open } }, response: { status: 200, body: {} } },
    });
    expect((await paper.getOrder(account, open)).status).toBe('CANCELLED');
    const again = await brokerError(paper.cancelOrder(account, open));
    expect([again.code, again.message]).toEqual(['REJECTED_BY_EXCHANGE', 'Paper order is CANCELLED.']);
    expect((await brokerError(paper.modifyOrder(account, modify))).message).toBe('Paper order is CANCELLED.');
  });

  it("can't see another account's orders", async () => {
    const { paper, account, other, submit } = await setup();
    const id = await submit({ orderType: 'LIMIT', pricePaise: 1_00 });
    for (const call of [paper.getOrder(other, id), paper.cancelOrder(other, id), paper.getOrder(account, 'PAPERNOPE')]) {
      const e = await brokerError(call);
      expect(e.code).toBe('NOT_FOUND');
    }
    expect((await brokerError(paper.getOrder(other, id))).message).toBe(`No paper order ${id}.`);
    expect(await paper.listOrders(other)).toEqual([]);
    expect((await paper.getOrder(account, id)).status).toBe('OPEN');
  });

  it('nets filled orders into long and short positions with average prices', async () => {
    const { paper, account, other, submit } = await setup();
    const NIFTY = { nativeId: 'NFO:FUT:NIFTY:2026-10-29', tradingSymbol: 'NIFTY26OCTFUT', exchange: 'NFO' };
    await submit({ quantity: 10, referencePricePaise: 100_00 });
    await submit({ quantity: 30, referencePricePaise: 104_00 });
    await submit({ side: 'SELL', quantity: 15, referencePricePaise: 110_00 });
    await submit({ orderType: 'LIMIT', pricePaise: 1_00, quantity: 1000 }); // resting: ignored
    await submit({ symbol: NIFTY, product: 'CARRYFORWARD', side: 'SELL', quantity: 75, referencePricePaise: 24500_00 });
    await submit({ symbol: NIFTY, product: 'CARRYFORWARD', side: 'SELL', quantity: 75, referencePricePaise: 24510_00 });
    await submit({ symbol: NIFTY, product: 'CARRYFORWARD', side: 'BUY', quantity: 50, referencePricePaise: 24400_00 });
    await submit({ quantity: 5 }, other);

    const positions = await paper.getPositions(account);
    const by = Object.fromEntries(positions.map((p) => [p.symbol.tradingSymbol, p]));
    expect(positions).toHaveLength(2);
    // Long 25: average of the buys, (10×100 + 30×104) / 40 = 103.
    expect(by['RELIANCE']).toEqual({ symbol: SYMBOL, product: 'DELIVERY', netQty: 25, avgPricePaise: 103_00, lastPricePaise: null, pnlPaise: null });
    // Short 100: average of the sells, 24505.
    expect(by['NIFTY26OCTFUT']).toEqual({ symbol: NIFTY, product: 'CARRYFORWARD', netQty: -100, avgPricePaise: 24505_00, lastPricePaise: null, pnlPaise: null });
    expect((await paper.getPositions(other))[0]?.netQty).toBe(5);
  });

  it('reports a flat position from a short-only round trip with the buy average', async () => {
    const { paper, account, submit } = await setup();
    await submit({ side: 'SELL', quantity: 10, referencePricePaise: 50_00 });
    await submit({ side: 'BUY', quantity: 10, referencePricePaise: 40_00 });
    expect(await paper.getPositions(account)).toEqual([expect.objectContaining({ netQty: 0, avgPricePaise: 40_00 })]);
  });

  it('reports a short-only position with the sell average', async () => {
    const { paper, account } = await setup();
    await paper.placeOrder(account, place({ side: 'SELL', quantity: 5, referencePricePaise: 10_00 }));
    const [p] = await paper.getPositions(account);
    expect(p).toMatchObject({ netQty: -5, avgPricePaise: 10_00 });
  });

  it('applies the standard modify rules', async () => {
    const { paper } = await setup();
    const current: BrokerOrder = {
      brokerOrderId: 'P1', status: 'PARTIALLY_FILLED', quantity: 10, filledQty: 4, avgPricePaise: null, pricePaise: 1, triggerPaise: null,
      orderType: 'LIMIT', clientRef: null, message: null, raw: null,
    };
    const req: ModifyRequest = { brokerOrderId: 'P1', symbol: SYMBOL, side: 'BUY', product: 'DELIVERY', quantity: 8, orderType: 'MARKET', pricePaise: null, triggerPaise: null };
    expect(paper.modifyProblem(current, req)).toBeNull();
    expect(paper.modifyProblem(current, { ...req, quantity: 4 })).toBe('Quantity must be more than the 4 already filled.');
  });
});
