import { describe, expect, it } from 'vitest';

import type { BrokerInstrument } from '../../src/brokers/adapter.ts';
import { BillingRepository, type Plan } from '../../src/data/billing.ts';
import { IdentityRepository } from '../../src/data/identity.ts';
import { InstrumentRepository } from '../../src/data/instruments.ts';
import { PositionRepository } from '../../src/data/positions.ts';
import { SettingsRepository } from '../../src/data/settings.ts';
import { testDb } from '../db.ts';
import { NOW } from '../helpers.ts';

const later = (ms: number) => new Date(NOW.getTime() + ms);

describe('SettingsRepository', () => {
  it('stores settings and job state as JSON, overwriting on set', async () => {
    const r = new SettingsRepository(await testDb());
    expect(await r.get('kill_switch')).toBeNull();
    await r.set('kill_switch', { on: true }, NOW);
    await r.set('kill_switch', { on: false, by: 'ops' }, later(1000));
    expect(await r.get('kill_switch')).toEqual({ on: false, by: 'ops' });
    expect(await r.jobState('eod')).toBeNull();
    await r.setJobState('eod', { day: '2026-10-27' }, NOW);
    await r.setJobState('eod', { day: '2026-10-28' }, NOW);
    expect(await r.jobState('eod')).toEqual({ day: '2026-10-28' });
  });

  it('keeps market holidays, renaming on re-add, in date order', async () => {
    const r = new SettingsRepository(await testDb());
    await r.addHoliday('2026-11-09', 'Diwali Balipratipada');
    await r.addHoliday('2026-10-02', 'Gandhi Jayanti');
    await r.addHoliday('2026-11-09', 'Diwali');
    expect(await r.holidays()).toEqual([
      { day: '2026-10-02', name: 'Gandhi Jayanti' },
      { day: '2026-11-09', name: 'Diwali' },
    ]);
    expect(await r.isHoliday('2026-10-02')).toBe(true);
    expect(await r.isHoliday('2026-10-27')).toBe(false);
  });
});

describe('PositionRepository', () => {
  const symbol = (id: string) => ({ nativeId: id, tradingSymbol: `SYM${id}`, exchange: 'NFO' });

  it('replaces an account\'s positions, merging rows for the same contract and product', async () => {
    const r = new PositionRepository(await testDb());
    expect(await r.list([])).toEqual([]);
    await r.replace('ba_1', [{ symbol: symbol('1'), product: 'INTRADAY', netQty: 10, avgPricePaise: 100, lastPricePaise: 110, pnlPaise: 100, instrumentId: 'I1' }], NOW);
    await r.replace('ba_2', [{ symbol: symbol('9'), product: 'INTRADAY', netQty: 1, avgPricePaise: null, lastPricePaise: null, pnlPaise: null, instrumentId: null }], NOW);
    await r.replace(
      'ba_1',
      [
        { symbol: symbol('2'), product: 'CARRYFORWARD', netQty: 75, avgPricePaise: 200, lastPricePaise: null, pnlPaise: null, instrumentId: null },
        { symbol: symbol('2'), product: 'CARRYFORWARD', netQty: -25, avgPricePaise: 200, lastPricePaise: null, pnlPaise: null, instrumentId: null },
      ],
      later(1000),
    );
    expect(await r.list(['ba_1'])).toEqual([
      {
        accountId: 'ba_1', instrumentId: null, symbol: symbol('2'), product: 'CARRYFORWARD', netQty: 50,
        avgPricePaise: 200, lastPricePaise: null, pnlPaise: null, syncedAt: later(1000),
      },
    ]);
    expect((await r.list(['ba_1', 'ba_2'])).map((p) => p.accountId)).toEqual(['ba_1', 'ba_2']);
  });
});

describe('InstrumentRepository', () => {
  const instrument = (over: Partial<BrokerInstrument>): BrokerInstrument => ({
    exchange: 'NFO', type: 'CE', underlying: 'nifty', expiry: '2026-10-29', strikePaise: 2_450_000, lotSize: 75, tickPaise: 5,
    symbol: { nativeId: '1', tradingSymbol: 'NIFTY26O2924500CE', exchange: 'NFO' }, ...over,
  });

  async function seeded() {
    const r = new InstrumentRepository(await testDb());
    await r.upsertFromBroker(
      'zerodha',
      [
        instrument({}),
        instrument({ type: 'PE', symbol: { nativeId: '2', tradingSymbol: 'NIFTY26O2924500PE', exchange: 'NFO' } }),
        instrument({ expiry: '2026-11-26', type: 'FUT', strikePaise: null, symbol: { nativeId: '3', tradingSymbol: 'NIFTY26NOVFUT', exchange: 'NFO' } }),
        instrument({ exchange: 'BFO', underlying: 'SENSEX', strikePaise: 8_000_000, symbol: { nativeId: '4', tradingSymbol: 'SENSEX', exchange: 'BFO' } }),
        instrument({ exchange: 'NSE', type: 'EQ', underlying: 'RELIANCE', expiry: null, strikePaise: null, lotSize: 1, symbol: { nativeId: '5', tradingSymbol: 'RELIANCE', exchange: 'NSE' } }),
      ],
      NOW,
    );
    return r;
  }

  it('searches with each filter, case-insensitive on the underlying, up to the limit', async () => {
    const r = await seeded();
    const ids = async (q: Parameters<typeof r.search>[0]) => (await r.search(q)).map((i) => i.id);
    expect(await ids({ limit: 10 })).toEqual([
      'NFO:CE:NIFTY:2026-10-29:2450000',
      'NFO:PE:NIFTY:2026-10-29:2450000',
      'NFO:FUT:NIFTY:2026-11-26',
      'NSE:EQ:RELIANCE',
      'BFO:CE:SENSEX:2026-10-29:8000000',
    ]);
    expect(await ids({ underlying: 'Nifty', limit: 10 })).toHaveLength(3);
    expect(await ids({ underlying: 'nifty', type: 'PE', limit: 10 })).toEqual(['NFO:PE:NIFTY:2026-10-29:2450000']);
    expect(await ids({ expiry: '2026-11-26', limit: 10 })).toEqual(['NFO:FUT:NIFTY:2026-11-26']);
    expect(await ids({ exchange: 'BFO', limit: 10 })).toEqual(['BFO:CE:SENSEX:2026-10-29:8000000']);
    expect(await ids({ underlying: 'NIFTY', limit: 1 })).toHaveLength(1);
    expect(await ids({ underlying: 'BANKNIFTY', limit: 10 })).toEqual([]);
    expect(await r.find('NSE:EQ:RELIANCE')).toEqual({
      id: 'NSE:EQ:RELIANCE', exchange: 'NSE', type: 'EQ', underlying: 'RELIANCE', expiry: null, strikePaise: null, lotSize: 1, tickPaise: 5,
    });
    expect(await r.find('nope')).toBeNull();
  });

  it('orders by underlying, then expiry and strike', async () => {
    const r = await seeded();
    expect((await r.search({ underlying: 'NIFTY', limit: 10 })).map((i) => [i.type, i.expiry])).toEqual([
      ['CE', '2026-10-29'],
      ['PE', '2026-10-29'],
      ['FUT', '2026-11-26'],
    ]);
  });

  it('maps native ids both ways, and keeps one instrument per contract across brokers', async () => {
    const r = await seeded();
    await r.upsertFromBroker('upstox', [instrument({ lotSize: 65, symbol: { nativeId: 'NSE_FO|1', tradingSymbol: 'NIFTY 24500 CE', exchange: 'NSE_FO' } })], later(1000));
    expect(await r.byNativeId('upstox', 'NSE_FO|1')).toBe('NFO:CE:NIFTY:2026-10-29:2450000');
    expect(await r.byNativeId('upstox', '1')).toBeNull();
    expect(await r.mapping('NFO:CE:NIFTY:2026-10-29:2450000', 'zerodha')).toEqual({ nativeId: '1', tradingSymbol: 'NIFTY26O2924500CE', exchange: 'NFO' });
    expect(await r.mapping('NFO:CE:NIFTY:2026-10-29:2450000', 'groww')).toBeNull();
    // The latest refresh's lot size wins.
    expect((await r.find('NFO:CE:NIFTY:2026-10-29:2450000'))!.lotSize).toBe(65);
  });

  it('prunes only the broker\'s mappings not refreshed since the given time', async () => {
    const r = await seeded();
    await r.upsertFromBroker('upstox', [instrument({ symbol: { nativeId: 'U1', tradingSymbol: 'U1', exchange: 'NSE_FO' } })], NOW);
    await r.upsertFromBroker('zerodha', [instrument({})], later(1000));
    await r.pruneMappings('zerodha', later(1000));
    expect(await r.byNativeId('zerodha', '1')).toBe('NFO:CE:NIFTY:2026-10-29:2450000');
    expect(await r.byNativeId('zerodha', '2')).toBeNull();
    expect(await r.byNativeId('zerodha', '5')).toBeNull();
    expect(await r.byNativeId('upstox', 'U1')).toBe('NFO:CE:NIFTY:2026-10-29:2450000');
  });

  it('writes large masters in batches', async () => {
    const r = new InstrumentRepository(await testDb());
    const rows = Array.from({ length: 501 }, (_, i) =>
      instrument({ strikePaise: 1_000_000 + i * 5000, symbol: { nativeId: String(i), tradingSymbol: `S${i}`, exchange: 'NFO' } }),
    );
    expect(await r.upsertFromBroker('zerodha', rows, NOW)).toBe(501);
    expect(await r.search({ limit: 1000 })).toHaveLength(501);
  });
});

describe('IdentityRepository', () => {
  it('finds users by email case-insensitively, and reports unknown ids as null', async () => {
    const r = new IdentityRepository(await testDb());
    await r.createUser({ id: 'usr_1', phone: '919876543210', email: 'a@b.co', status: 'active', createdAt: NOW });
    expect(await r.userByEmail('A@B.CO')).toMatchObject({ id: 'usr_1', email: 'a@b.co' });
    expect(await r.userByEmail('x@y.z')).toBeNull();
    expect(await r.user('usr_nope')).toBeNull();
    expect(await r.client('cl_nope')).toBeNull();
    expect(await r.session('ses_nope')).toBeNull();
    expect(await r.sessionOfRefresh('nope')).toBeNull();
    expect(await r.latestOtp('919876543210')).toBeNull();
    expect(await r.revokeSession('ses_nope', NOW, 'x')).toBe(false);
  });
});

describe('BillingRepository', () => {
  const plan: Plan = {
    code: 'pro', name: 'Pro', pricePaise: 99_900, interval: 'monthly', maxAccounts: 3, maxOrdersPerDay: 100, maxFanout: 3,
    brokers: ['zerodha'], razorpayPlanId: null, active: false,
  };

  it('upserts plans and lists inactive ones only when asked', async () => {
    const r = new BillingRepository(await testDb());
    await r.upsertPlan(plan);
    await r.upsertPlan({ ...plan, name: 'Pro+', razorpayPlanId: 'plan_x' });
    expect(await r.plans(true)).toEqual([]);
    expect(await r.plans(false)).toEqual([{ ...plan, name: 'Pro+', razorpayPlanId: 'plan_x' }]);
    expect(await r.plan('nope')).toBeNull();
  });

  it('records payment events once and lists them per subscription', async () => {
    const db = await testDb();
    const r = new BillingRepository(db);
    await new IdentityRepository(db).createUser({ id: 'usr_1', phone: '919876543210', email: null, status: 'active', createdAt: NOW });
    await r.upsertPlan(plan);
    await r.createSubscription({
      id: 'sub_1', userId: 'usr_1', planCode: 'pro', status: 'created', currentPeriodEnd: null, graceUntil: null, cancelAtPeriodEnd: false,
      providerRef: 'sub_rp_1', checkoutUrl: 'https://rzp.io/i/1', createdAt: NOW, updatedAt: NOW,
    });
    expect(await r.subscriptionByRef('sub_rp_1')).toMatchObject({ id: 'sub_1', checkoutUrl: 'https://rzp.io/i/1' });
    expect(await r.subscriptionByRef('sub_rp_x')).toBeNull();
    expect(await r.recordPaymentEvent({ subscriptionId: 'sub_1', providerEventId: 'evt_1', type: 'subscription.activated', payload: { a: 1 }, at: NOW })).toBe(true);
    expect(await r.recordPaymentEvent({ subscriptionId: 'sub_1', providerEventId: 'evt_1', type: 'subscription.activated', payload: { a: 1 }, at: NOW })).toBe(false);
    expect(await r.recordPaymentEvent({ subscriptionId: 'sub_1', providerEventId: 'evt_2', type: 'subscription.charged', payload: {}, at: later(1000) })).toBe(true);
    expect(await r.paymentEvents('sub_1')).toEqual([
      { type: 'subscription.activated', providerEventId: 'evt_1', at: NOW },
      { type: 'subscription.charged', providerEventId: 'evt_2', at: later(1000) },
    ]);
  });
});
