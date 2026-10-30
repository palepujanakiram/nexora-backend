import { describe, expect, it } from 'vitest';

import { InstrumentRepository } from '../../src/data/instruments.ts';
import { signIn, testApp } from '../app.ts';
import { NOW, anyString, defined, type ErrorBody } from '../helpers.ts';

interface Instruments {
  instruments: unknown[];
}
interface Rows {
  rows: object[];
}

const INSTRUMENT = 'NFO:CE:NIFTY:2026-10-29:2450000';
const SIGNAL = 'BUY NIFTY 29 OCT 24500 CALL AT 120-125 SL 100 TGT 150';

async function seed(t: Awaited<ReturnType<typeof testApp>>) {
  const repo = new InstrumentRepository(t.services.db);
  const option = { exchange: 'NFO' as const, underlying: 'NIFTY', expiry: '2026-10-29', strikePaise: 2450000, lotSize: 75, tickPaise: 5 };
  await repo.upsertFromBroker(
    'zerodha',
    [
      { ...option, type: 'CE', symbol: { nativeId: '12345', tradingSymbol: 'NIFTY26O2924500CE', exchange: 'NFO' } },
      { ...option, type: 'PE', symbol: { nativeId: '12346', tradingSymbol: 'NIFTY26O2924500PE', exchange: 'NFO' } },
      { exchange: 'NSE', type: 'EQ', underlying: 'INFY', expiry: null, strikePaise: null, lotSize: 1, tickPaise: 5, symbol: { nativeId: '408065', tradingSymbol: 'INFY', exchange: 'NSE' } },
    ],
    NOW,
  );
}

describe('GET /instruments', () => {
  it('searches the master with filters', async () => {
    const t = await testApp();
    await seed(t);
    const me = await signIn(t);
    const all = await t.app.inject({ method: 'GET', url: '/instruments', headers: me.headers });
    expect(all.statusCode).toBe(200);
    expect(all.json<Instruments>().instruments).toHaveLength(3);

    const calls = await t.app.inject({ method: 'GET', url: '/instruments?underlying=NIFTY&type=CE&expiry=2026-10-29&exchange=NFO', headers: me.headers });
    expect(calls.json<Instruments>().instruments).toEqual([
      { id: INSTRUMENT, exchange: 'NFO', type: 'CE', underlying: 'NIFTY', expiry: '2026-10-29', strike: '24500.00', lotSize: 75, tickSize: '0.05' },
    ]);
    expect((await t.app.inject({ method: 'GET', url: '/instruments?limit=1', headers: me.headers })).json<Instruments>().instruments).toHaveLength(1);

    const bad = await t.app.inject({ method: 'GET', url: '/instruments?type=XX', headers: me.headers });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<ErrorBody>().error.message).toMatch(/^type: /);
    expect((await t.app.inject({ method: 'GET', url: '/instruments?expiry=29-10-2026', headers: me.headers })).statusCode).toBe(400);
  });
});

describe('POST /signals/parse', () => {
  it('returns the canonical instrument when it is in the master', async () => {
    const t = await testApp();
    await seed(t);
    const me = await signIn(t);
    const res = await t.app.inject({ method: 'POST', url: '/signals/parse', headers: me.headers, payload: { text: SIGNAL } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ instrumentId: string | null; order: unknown; signal: object; warnings: string[] }>();
    expect(body.instrumentId).toBe(INSTRUMENT);
    expect(body.order).toEqual({ side: 'BUY', orderType: 'LIMIT', price: '125' });
    expect(body.signal).toMatchObject({ action: 'BUY', underlying: 'NIFTY', optionType: 'CE', expiry: '2026-10-29' });
    expect(body.warnings.some((w) => w.includes('instrument master'))).toBe(false);
  });

  it('returns a null instrument with a warning when the master lacks it', async () => {
    const t = await testApp();
    const me = await signIn(t);
    const res = await t.app.inject({ method: 'POST', url: '/signals/parse', headers: me.headers, payload: { text: SIGNAL } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ instrumentId: string | null; warnings: string[] }>();
    expect(body.instrumentId).toBeNull();
    expect(body.warnings).toContain(`Instrument ${INSTRUMENT} isn't in the instrument master yet.`);
  });

  it('refuses text that is not a signal', async () => {
    const t = await testApp();
    const me = await signIn(t);
    const res = await t.app.inject({ method: 'POST', url: '/signals/parse', headers: me.headers, payload: { text: 'good morning traders' } });
    expect(res.statusCode).toBe(422);
    expect(res.json<ErrorBody>().error.code).toBe('invalid_signal');
    expect((await t.app.inject({ method: 'POST', url: '/signals/parse', headers: me.headers, payload: {} })).statusCode).toBe(400);
  });
});

describe('positions and analytics', () => {
  it('shows a paper position after a filled paper order, and analytics after the pipeline runs', async () => {
    const t = await testApp();
    await seed(t);
    const me = await signIn(t);
    const empty = await t.app.inject({ method: 'GET', url: '/positions', headers: me.headers });
    expect(empty.json()).toEqual({ accounts: [] });

    const paper = (await t.app.inject({ method: 'POST', url: '/broker-accounts', headers: me.headers, payload: { broker: 'zerodha', label: 'Paper' } })).json<{ account: { id: string } }>()
      .account.id;
    const placed = await t.app.inject({
      method: 'POST',
      url: '/orders',
      headers: { ...me.headers, 'idempotency-key': 'key-paper-0001' },
      payload: { instrumentId: INSTRUMENT, side: 'BUY', quantity: 75, orderType: 'MARKET', product: 'INTRADAY', referencePrice: '120.00', accountIds: [paper] },
    });
    expect(placed.statusCode).toBe(207);
    expect(placed.json<{ status: string }>().status).toBe('COMPLETE');

    const positions = await t.app.inject({ method: 'GET', url: '/positions', headers: me.headers });
    expect(positions.statusCode).toBe(200);
    const account = defined(positions.json<{ accounts: { positions: unknown[] }[] }>().accounts[0]);
    expect(account).toMatchObject({ accountId: paper, broker: 'zerodha', mode: 'paper', syncedAt: '2026-10-27T04:00:00.000Z' });
    expect(account.positions).toEqual([expect.objectContaining({ instrumentId: INSTRUMENT, netQty: 75, product: 'INTRADAY' })]);

    await t.services.analytics.pipeline();
    const execution = await t.app.inject({ method: 'GET', url: '/analytics/execution?from=2026-10-01&to=2026-10-31', headers: me.headers });
    expect(execution.statusCode).toBe(200);
    expect(execution.json()).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(execution.json<Rows>().rows).toEqual([expect.objectContaining({ broker: 'zerodha', legs: 1, filled: 1, rejected: 0, fillRate: 1 })]);

    const byInstrument = await t.app.inject({ method: 'GET', url: '/analytics/execution?groupBy=instrument', headers: me.headers });
    expect(byInstrument.statusCode).toBe(200);
    expect(byInstrument.json<Rows>().rows[0]).toMatchObject({ instrumentId: INSTRUMENT, side: 'BUY' });

    const pnl = await t.app.inject({ method: 'GET', url: '/analytics/pnl?from=2026-10-27&to=2026-10-27', headers: me.headers });
    expect(pnl.statusCode).toBe(200);
    expect(pnl.json()).toMatchObject({ from: '2026-10-27', to: '2026-10-27', realisedTotal: anyString() });

    for (const path of ['/analytics/execution', '/analytics/pnl']) {
      const backwards = await t.app.inject({ method: 'GET', url: `${path}?from=2026-10-28&to=2026-10-27`, headers: me.headers });
      expect(backwards.statusCode).toBe(400);
      expect(backwards.json<ErrorBody>().error.message).toBe('from must not be after to.');
    }
    expect((await t.app.inject({ method: 'GET', url: '/analytics/execution?groupBy=day', headers: me.headers })).statusCode).toBe(400);
  });
});
