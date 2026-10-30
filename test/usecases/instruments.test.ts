import { describe, expect, it } from 'vitest';

import { InstrumentRepository } from '../../src/data/instruments.ts';
import { harness } from '../app.ts';
import { fakeFetch, text } from '../helpers.ts';

const GROWW_CSV = 'https://growwapi-assets.groww.in/instruments/instrument.csv';
const HEADER = 'exchange,trading_symbol,instrument_type,segment,underlying_symbol,expiry_date,strike_price,lot_size,tick_size';
const ROWS = [
  'NSE,RELIANCE,EQ,CASH,,,,1,0.05',
  'NSE,NIFTY26O2924500CE,CE,FNO,NIFTY,2026-10-29,24500,75,0.05',
  'NSE,NIFTY26O2924500PE,PE,FNO,NIFTY,2026-10-29,24500,75,0.05',
  'NSE,NIFTY26NOVFUT,FUT,FNO,NIFTY,2026-11-26,,75,0.10',
];

async function world() {
  const csv = { body: [HEADER, ...ROWS].join('\n') };
  const fetch = fakeFetch((url) => {
    if (url === GROWW_CSV) return text(csv.body);
    throw new Error(`Unexpected network call to ${url}`);
  });
  const h = await harness({ fetch });
  return { ...h, s: h.services, csv, repo: new InstrumentRepository(h.services.db) };
}

describe('instrument refresh', () => {
  it('refreshes each broker, and one failing does not stop the others', async () => {
    const w = await world();
    const results = await w.s.instruments.refresh();
    expect(results).toEqual([
      { broker: 'zerodha', count: 0, error: 'Zerodha (Kite Connect) needs a logged-in account to download instruments.' },
      { broker: 'upstox', count: 0, error: "Couldn't reach upstox." },
      { broker: 'angelone', count: 0, error: "Couldn't reach angelone." },
      { broker: 'groww', count: 4, error: null },
    ]);
    expect(await w.repo.byNativeId('groww', 'NIFTY26O2924500CE')).toBe('NFO:CE:NIFTY:2026-10-29:2450000');
    expect(await w.repo.mapping('NFO:CE:NIFTY:2026-10-29:2450000', 'groww')).toEqual({
      nativeId: 'NIFTY26O2924500CE',
      tradingSymbol: 'NIFTY26O2924500CE',
      exchange: 'NSE:FNO',
    });
  });

  it('prunes mappings the broker no longer lists, unless the download came back empty', async () => {
    const w = await world();
    await w.s.instruments.refresh(['groww']);
    w.clock.advance(86_400_000);
    w.csv.body = [HEADER, ...ROWS.slice(0, 2)].join('\n');
    expect(await w.s.instruments.refresh(['groww'])).toEqual([{ broker: 'groww', count: 2, error: null }]);
    expect(await w.repo.byNativeId('groww', 'NIFTY26O2924500PE')).toBeNull();
    expect(await w.repo.byNativeId('groww', 'RELIANCE')).toBe('NSE:EQ:RELIANCE');
    // The canonical instrument stays; only Groww's name for it went.
    expect(await w.repo.find('NFO:PE:NIFTY:2026-10-29:2450000')).not.toBeNull();

    w.clock.advance(86_400_000);
    w.csv.body = HEADER;
    expect(await w.s.instruments.refresh(['groww'])).toEqual([{ broker: 'groww', count: 0, error: null }]);
    expect(await w.repo.byNativeId('groww', 'RELIANCE')).toBe('NSE:EQ:RELIANCE');
  });

  it('searches the master and shows prices in rupees', async () => {
    const w = await world();
    await w.s.instruments.refresh(['groww']);
    expect(await w.s.instruments.search({ underlying: 'nifty', type: 'CE', limit: 10 })).toEqual([
      { id: 'NFO:CE:NIFTY:2026-10-29:2450000', exchange: 'NFO', type: 'CE', underlying: 'NIFTY', expiry: '2026-10-29', strike: '24500.00', lotSize: 75, tickSize: '0.05' },
    ]);
    expect(await w.s.instruments.search({ underlying: 'RELIANCE', limit: 10 })).toEqual([
      { id: 'NSE:EQ:RELIANCE', exchange: 'NSE', type: 'EQ', underlying: 'RELIANCE', expiry: null, strike: null, lotSize: 1, tickSize: '0.05' },
    ]);
  });
});
