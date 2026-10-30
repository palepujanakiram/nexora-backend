import { describe, expect, it } from 'vitest';

import { AnalyticsRepository, type LegFact } from '../../src/data/analytics.ts';
import { harness } from '../app.ts';
import { NOW } from '../helpers.ts';

const NIFTY = 'NFO:CE:NIFTY:2026-10-29:2450000';
const BANK = 'NFO:PE:BANKNIFTY:2026-10-28:5200000';
let seq = 0;

/** One terminal leg, as the order module writes it to the outbox. */
function fact(over: Partial<LegFact> & { at?: Date; fillMs?: number }): LegFact {
  const { at = NOW, fillMs = 2000, ...rest } = over;
  return {
    legId: `leg_${++seq}`,
    userId: 'usr_1',
    accountId: 'ba_kite',
    broker: 'zerodha',
    mode: 'live',
    instrumentId: NIFTY,
    kind: 'ENTRY',
    side: 'BUY',
    orderType: 'LIMIT',
    status: 'FILLED',
    errorCode: null,
    quantity: 150,
    filledQty: 150,
    avgPricePaise: 42_100,
    referencePricePaise: 42_000,
    submittedAt: new Date(at.getTime() - fillMs).toISOString(),
    terminalAt: at.toISOString(),
    ...rest,
  };
}

async function world() {
  const h = await harness();
  const s = h.services;
  const outbox = async (...facts: LegFact[]) => {
    for (const f of facts) await s.db.query('INSERT INTO analytics_outbox (payload, created_at) VALUES ($1, $2)', [JSON.stringify(f), NOW]);
  };
  return { ...h, s, outbox, repo: new AnalyticsRepository(s.db) };
}

const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe('analytics pipeline', () => {
  it('drains the outbox into facts once, and rolls up each touched day', async () => {
    const w = await world();
    await w.outbox(fact({}), fact({ at: new Date('2026-10-26T06:00:00Z') }));
    expect(await w.s.analytics.pipeline()).toBe(2);
    expect(await w.s.db.query('SELECT 1 FROM analytics_outbox')).toEqual([]);
    expect(await w.s.db.query('SELECT day FROM analytics_execution_daily ORDER BY day')).toEqual([{ day: '2026-10-26' }, { day: '2026-10-27' }]);
    expect(await w.s.analytics.pipeline()).toBe(0);
  });

  it('ignores a leg already in the facts', async () => {
    const w = await world();
    const f = fact({});
    await w.outbox(f, f);
    await w.s.analytics.pipeline();
    expect((await w.s.analytics.execution('usr_1', { groupBy: 'broker' })).rows[0]).toMatchObject({ legs: 1 });
  });

  it('drains more than one batch', async () => {
    const w = await world();
    await w.s.db.query(
      `INSERT INTO analytics_outbox (payload, created_at)
       SELECT jsonb_set($1::jsonb, '{legId}', to_jsonb('bulk_' || g)), $2 FROM generate_series(1, 501) g`,
      [JSON.stringify(fact({})), NOW],
    );
    expect(await w.s.analytics.pipeline()).toBe(1);
    expect((await w.s.analytics.execution('usr_1', { groupBy: 'broker' })).rows[0]).toMatchObject({ legs: 501, filled: 501 });
  });
});

describe('execution quality', () => {
  async function seeded() {
    const w = await world();
    await w.outbox(
      // Bought 1 rupee above the reference: worse for the user (+23.81 bps), 2 s to fill.
      fact({ at: minutes(1) }),
      // Sold 2.10 above the reference: better for the user (-50 bps), 4 s to fill.
      fact({ side: 'SELL', kind: 'EXIT', avgPricePaise: 42_210, quantity: 75, filledQty: 75, at: minutes(2), fillMs: 4000 }),
      fact({ status: 'REJECTED', errorCode: 'INSUFFICIENT_FUNDS', filledQty: 0, avgPricePaise: null, at: minutes(3) }),
      fact({ broker: 'upstox', accountId: 'ba_up', status: 'REJECTED', errorCode: null, filledQty: 0, avgPricePaise: null, at: minutes(4) }),
      fact({ broker: 'upstox', accountId: 'ba_up', status: 'CANCELLED', filledQty: 0, avgPricePaise: null, at: minutes(5) }),
      fact({ broker: 'upstox', accountId: 'ba_up', instrumentId: BANK, referencePricePaise: null, submittedAt: null, at: minutes(6) }),
      // Last month: outside the default range.
      fact({ at: new Date('2026-09-30T06:00:00Z'), status: 'REJECTED', errorCode: 'MARKET_CLOSED', filledQty: 0, avgPricePaise: null }),
      // Someone else's.
      fact({ userId: 'usr_2', at: minutes(7) }),
    );
    await w.s.analytics.pipeline();
    return w;
  }

  it('reports fill rate, rejections, slippage and time to fill by broker, for this month by default', async () => {
    const w = await seeded();
    const r = await w.s.analytics.execution('usr_1', { groupBy: 'broker' });
    expect(r.from).toBe('2026-10-01');
    expect(r.to).toBe('2026-10-27');
    expect(r.rows).toEqual([
      {
        broker: 'upstox',
        legs: 3,
        filled: 1,
        rejected: 1,
        fillRate: 0.3333,
        rejectionRate: 0.3333,
        rejectionsByReason: { UNKNOWN: 1 },
        avgSlippageBps: null,
        avgTimeToFillMs: null,
      },
      {
        broker: 'zerodha',
        legs: 3,
        filled: 2,
        rejected: 1,
        fillRate: 0.6667,
        rejectionRate: 0.3333,
        rejectionsByReason: { INSUFFICIENT_FUNDS: 1 },
        avgSlippageBps: -13.1,
        avgTimeToFillMs: 3000,
      },
    ]);
  });

  it('groups by instrument and side to compare the same contract across brokers', async () => {
    const w = await seeded();
    const r = await w.s.analytics.execution('usr_1', { groupBy: 'instrument' });
    expect(r.rows.map((x) => [x.broker, x.instrumentId, x.side, x.legs, x.avgSlippageBps])).toEqual([
      ['upstox', NIFTY, 'BUY', 2, null],
      ['upstox', BANK, 'BUY', 1, null],
      ['zerodha', NIFTY, 'BUY', 2, 23.81],
      ['zerodha', NIFTY, 'SELL', 1, -50],
    ]);
  });

  it('honours an explicit range, and refuses one that runs backwards', async () => {
    const w = await seeded();
    const sept = await w.s.analytics.execution('usr_1', { from: '2026-09-01', to: '2026-09-30', groupBy: 'broker' });
    expect(sept.rows).toEqual([expect.objectContaining({ broker: 'zerodha', legs: 1, rejectionsByReason: { MARKET_CLOSED: 1 } })]);
    expect((await w.s.analytics.execution('usr_1', { to: '2026-09-30', groupBy: 'broker' })).from).toBe('2026-09-01');
    await expect(w.s.analytics.execution('usr_1', { from: '2026-10-27', to: '2026-10-01', groupBy: 'broker' })).rejects.toMatchObject({
      status: 400,
      message: 'from must not be after to.',
    });
  });
});

describe('P&L', () => {
  it('realises P&L at average cost: buy 150 @ 100, sell 75 @ 110 → 750.00', async () => {
    const w = await world();
    await w.outbox(
      fact({ avgPricePaise: 10_000, at: minutes(1) }),
      fact({ side: 'SELL', filledQty: 75, avgPricePaise: 11_000, at: minutes(2) }),
    );
    await w.s.analytics.pipeline();
    expect(await w.s.analytics.pnl('usr_1', {})).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-27',
      realisedTotal: '750.00',
      realised: [{ accountId: 'ba_kite', instrumentId: NIFTY, realised: '750.00' }],
    });
  });

  it('averages up on adds, and starts a new basis when the position flips through zero', async () => {
    const w = await world();
    await w.outbox(
      fact({ filledQty: 50, avgPricePaise: 10_000, at: minutes(1) }),
      fact({ filledQty: 50, avgPricePaise: 12_000, at: minutes(2) }), // 100 @ 110
      fact({ side: 'SELL', filledQty: 150, avgPricePaise: 12_000, at: minutes(3) }), // +1000 on 100, then short 50 @ 120
      fact({ filledQty: 50, avgPricePaise: 11_000, at: minutes(4) }), // short covered: +500
    );
    await w.s.analytics.pipeline();
    const r = await w.s.analytics.pnl('usr_1', {});
    expect(r.realised).toEqual([{ accountId: 'ba_kite', instrumentId: NIFTY, realised: '1500.00' }]);
    expect(r.realisedTotal).toBe('1500.00');
  });

  it('uses earlier fills for the cost basis but counts only P&L realised in the period', async () => {
    const w = await world();
    await w.outbox(
      fact({ avgPricePaise: 10_000, at: new Date('2026-09-15T06:00:00Z') }),
      fact({ side: 'SELL', filledQty: 75, avgPricePaise: 9_000, at: new Date('2026-09-20T06:00:00Z') }), // -750, in September
      fact({ side: 'SELL', filledQty: 75, avgPricePaise: 11_000, at: minutes(1) }), // +750, in October
      fact({ instrumentId: BANK, avgPricePaise: 5_000, at: minutes(2) }), // open, nothing realised
      fact({ status: 'REJECTED', filledQty: 0, avgPricePaise: null, at: minutes(3) }),
    );
    await w.s.analytics.pipeline();
    const oct = await w.s.analytics.pnl('usr_1', {});
    expect(oct.realised).toEqual([{ accountId: 'ba_kite', instrumentId: NIFTY, realised: '750.00' }]);
    const sept = await w.s.analytics.pnl('usr_1', { from: '2026-09-01', to: '2026-09-30' });
    expect(sept).toMatchObject({ realisedTotal: '-750.00', realised: [{ realised: '-750.00' }] });
    const both = await w.s.analytics.pnl('usr_1', { from: '2026-09-01' });
    expect(both.realisedTotal).toBe('0.00');
    expect(both.realised).toEqual([]);
  });

  it('reports unrealised P&L from the latest position snapshots, skipping flat ones', async () => {
    const w = await world();
    await w.repo.saveSnapshots(
      'ba_kite',
      'usr_1',
      [
        { nativeId: '12345', tradingSymbol: 'NIFTY26O2924500CE', netQty: 75, pnlPaise: 12_550 },
        { nativeId: '999', tradingSymbol: 'FLAT', netQty: 0, pnlPaise: 0 },
        { nativeId: '777', tradingSymbol: 'NOPNL', netQty: -50, pnlPaise: null },
      ],
      NOW,
    );
    const r = await w.s.analytics.pnl('usr_1', {});
    expect(r.unrealised).toEqual([
      { accountId: 'ba_kite', tradingSymbol: 'NIFTY26O2924500CE', netQty: 75, unrealised: '125.50', asOf: NOW.toISOString() },
      { accountId: 'ba_kite', tradingSymbol: 'NOPNL', netQty: -50, unrealised: null, asOf: NOW.toISOString() },
    ]);
    // A new snapshot replaces the account's old one.
    await w.repo.saveSnapshots('ba_kite', 'usr_1', [], NOW);
    expect((await w.s.analytics.pnl('usr_1', {})).unrealised).toEqual([]);
  });
});
