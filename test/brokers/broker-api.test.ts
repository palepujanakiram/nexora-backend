import { describe, expect, it, vi } from 'vitest';

import { InstrumentCache, extractParam, parseCsv, readJson, splitCsv } from '../../src/brokers/broker-api.ts';
import { brokerFactory } from '../../src/brokers/index.ts';
import { GrowwApi } from '../../src/brokers/groww.ts';
import { UpstoxApi } from '../../src/brokers/upstox.ts';
import { ZerodhaApi } from '../../src/brokers/zerodha.ts';
import { NOW, account, clock, noNetwork, text } from '../helpers.ts';

describe('extractParam', () => {
  it('reads the parameter from a redirect URL, or takes a bare code', () => {
    expect(extractParam('https://127.0.0.1/?action=login&request_token=abc', 'request_token')).toBe('abc');
    expect(extractParam('  abc123  ', 'code')).toBe('abc123');
  });

  it('rejects empty input and URLs without the parameter', () => {
    expect(() => extractParam(' ', 'code')).toThrow('No "code" given.');
    expect(() => extractParam('https://127.0.0.1/?error=denied', 'code')).toThrow('No "code" found in the pasted URL.');
    expect(() => extractParam('?code=', 'code')).toThrow('No "code" found');
  });
});

describe('CSV', () => {
  it('splits quoted fields with commas', () => {
    expect(splitCsv('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
    expect(splitCsv('')).toEqual(['']);
  });

  it('parses rows by header, skipping blank lines and short rows', () => {
    expect(parseCsv('name,lot\r\nNIFTY,75\n\nSENSEX\n')).toEqual([{ name: 'NIFTY', lot: '75' }, { name: 'SENSEX' }]);
    expect(parseCsv('')).toEqual([]);
  });
});

describe('readJson', () => {
  it('returns objects only', async () => {
    expect(await readJson(text('{"a":1}'))).toEqual({ a: 1 });
    expect(await readJson(text('[1]'))).toBeNull();
    expect(await readJson(text('null'))).toBeNull();
    expect(await readJson(text('<html>'))).toBeNull();
  });
});

describe('InstrumentCache', () => {
  it('loads once per key per day in India', async () => {
    const cache = new InstrumentCache();
    const load = vi.fn(async () => [{ a: '1' }]);
    await cache.get('k', NOW, load);
    await cache.get('k', new Date(NOW.getTime() + 60 * 60 * 1000), load);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.get('other', NOW, load);
    await cache.get('k', new Date(NOW.getTime() + 24 * 60 * 60 * 1000), load);
    expect(load).toHaveBeenCalledTimes(3);
  });
});

describe('brokerFactory', () => {
  it('builds the client for each broker', () => {
    const make = brokerFactory({ fetch: noNetwork, clock, cache: new InstrumentCache(), random: () => 0 });
    expect(make(account())).toBeInstanceOf(ZerodhaApi);
    expect(make(account({ broker: 'upstox' }))).toBeInstanceOf(UpstoxApi);
    expect(make(account({ broker: 'groww' }))).toBeInstanceOf(GrowwApi);
  });
});
