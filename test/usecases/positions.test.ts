import { describe, expect, it } from 'vitest';

import { InstrumentRepository } from '../../src/data/instruments.ts';
import { PositionRepository } from '../../src/data/positions.ts';
import { harness } from '../app.ts';
import { FakeKite, brokerWorld } from '../fakes.ts';
import { NOW } from '../helpers.ts';

const INSTRUMENT = 'NFO:CE:NIFTY:2026-10-29:2450000';

async function world() {
  const kite = new FakeKite();
  const h = await harness({ env: { LIVE_TRADING: 'true' }, fetch: brokerWorld(kite) });
  const s = h.services;
  const base = { exchange: 'NFO' as const, type: 'CE' as const, underlying: 'NIFTY', expiry: '2026-10-29', strikePaise: 2450000, lotSize: 75, tickPaise: 5 };
  await new InstrumentRepository(s.db).upsertFromBroker('zerodha', [{ ...base, symbol: { nativeId: '12345', tradingSymbol: 'NIFTY26O2924500CE', exchange: 'NFO' } }], NOW);
  const user = await s.identity.registerUser({ phone: '9876543210' });
  const link = async (label: string, mode: 'live' | 'paper', credentials: Record<string, string> = {}, broker = 'zerodha') =>
    (await s.brokerAccounts.link(user.id, { broker, label, mode, credentials })).account.id;
  let n = 0;
  const buy = (accountIds: string[], quantity = 150) =>
    s.orders.place(user.id, {
      clientId: 'cl_test',
      idempotencyKey: `k${++n}`,
      accountIds,
      intent: { instrumentId: INSTRUMENT, side: 'BUY', quantity, orderType: 'MARKET', product: 'CARRYFORWARD', pricePaise: null, triggerPaise: null, referencePricePaise: 41_950 },
    });
  return { ...h, s, kite, user, link, buy };
}

describe('live positions', () => {
  it('reads every account, keeps a copy and a P&L snapshot, and reports failing accounts with their error', async () => {
    const w = await world();
    const paper = await w.link('Paper', 'paper');
    const kiteId = await w.link('Kite', 'live', { apiKey: 'kiteA', apiSecret: 's' });
    await w.s.gateway.saveToken(kiteId, { accessToken: 'AT', refreshToken: null, expiresAt: new Date(NOW.getTime() + 3_600_000) });
    const loggedOut = await w.link('Angel', 'live', { apiKey: 'ak', apiSecret: 'as', clientCode: 'A1', pin: '1' }, 'angelone');
    w.kite.fill['kiteA'] = 'filled';
    await w.buy([paper, kiteId]);

    const result = await w.s.positions.live(w.user.id);
    const order = [paper, kiteId, loggedOut];
    result.sort((a, b) => order.indexOf(a.accountId) - order.indexOf(b.accountId));
    expect(result).toEqual([
      {
        accountId: paper,
        broker: 'zerodha',
        mode: 'paper',
        syncedAt: NOW.toISOString(),
        positions: [
          { instrumentId: INSTRUMENT, tradingSymbol: INSTRUMENT, exchange: 'NFO', product: 'CARRYFORWARD', netQty: 150, avgPrice: '419.50', lastPrice: null, pnl: null },
        ],
      },
      {
        accountId: kiteId,
        broker: 'zerodha',
        mode: 'live',
        syncedAt: NOW.toISOString(),
        positions: [
          { instrumentId: INSTRUMENT, tradingSymbol: 'NIFTY26O2924500CE', exchange: 'NFO', product: 'CARRYFORWARD', netQty: 150, avgPrice: '425.50', lastPrice: '425.50', pnl: '12.50' },
        ],
      },
      {
        accountId: loggedOut,
        broker: 'angelone',
        mode: 'live',
        error: { code: 'AUTH_EXPIRED', message: 'The broker session has expired. Log in to this account again.' },
      },
    ]);

    const stored = await new PositionRepository(w.s.db).list([paper, kiteId, loggedOut]);
    expect(stored.map((p) => [p.accountId, p.netQty, p.instrumentId]).sort()).toEqual(
      [
        [paper, 150, INSTRUMENT],
        [kiteId, 150, INSTRUMENT],
      ].sort(),
    );
    const pnl = await w.s.analytics.pnl(w.user.id, {});
    expect(pnl.unrealised).toHaveLength(2);
    expect(pnl.unrealised).toContainEqual(expect.objectContaining({ accountId: paper, netQty: 150, unrealised: null }));
    expect(pnl.unrealised).toContainEqual(expect.objectContaining({ accountId: kiteId, netQty: 150, unrealised: '12.50' }));
  });

  it('reports UNKNOWN for failures that are not broker errors, and maps unknown symbols to no instrument', async () => {
    const w = await world();
    const broken = await w.link('Broken', 'live', { apiKey: 'k', apiSecret: 's' });
    await w.s.gateway.saveToken(broken, { accessToken: 'AT', refreshToken: null, expiresAt: new Date(NOW.getTime() + 3_600_000) });
    await w.s.db.query(`UPDATE broker_accounts SET token_enc = 'v9:corrupt' WHERE id = $1`, [broken]);
    const kiteId = await w.link('Kite', 'live', { apiKey: 'kiteA', apiSecret: 's' });
    await w.s.gateway.saveToken(kiteId, { accessToken: 'AT', refreshToken: null, expiresAt: new Date(NOW.getTime() + 3_600_000) });
    w.kite.fill['kiteA'] = 'filled';
    await w.buy([kiteId]);
    await w.s.db.query('DELETE FROM instrument_mappings');

    const result = await w.s.positions.live(w.user.id);
    const a = result.find((r) => r.accountId === broken);
    const b = result.find((r) => r.accountId === kiteId);
    expect(a).toEqual({ accountId: broken, broker: 'zerodha', mode: 'live', error: { code: 'UNKNOWN', message: 'Unknown secret format or key version.' } });
    expect(b).toMatchObject({ accountId: kiteId, positions: [{ instrumentId: null, tradingSymbol: 'NIFTY26O2924500CE' }] });
  });

  it('is empty for a user without accounts', async () => {
    const w = await world();
    expect(await w.s.positions.live(w.user.id)).toEqual([]);
  });
});
