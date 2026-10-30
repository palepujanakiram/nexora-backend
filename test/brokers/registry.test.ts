import { describe, expect, it } from 'vitest';

import { BROKER_MODULES, BrokerRegistry } from '../../src/brokers/registry.ts';
import { PaperBroker } from '../../src/brokers/paper.ts';
import { AppError } from '../../src/domain/errors.ts';
import { testDb } from '../db.ts';
import { clock } from '../helpers.ts';

describe('BrokerRegistry', () => {
  it('runs every standard broker', () => {
    const registry = BrokerRegistry.standard({ clock });
    expect(Object.keys(BROKER_MODULES)).toEqual(['zerodha', 'upstox', 'angelone', 'groww']);
    expect(registry.list().map((a) => a.code)).toEqual(['zerodha', 'upstox', 'angelone', 'groww']);
    for (const code of ['zerodha', 'upstox', 'angelone', 'groww']) {
      expect(registry.has(code)).toBe(true);
      expect(registry.get(code).code).toBe(code);
    }
    expect(registry.get('zerodha').label).toBe('Zerodha (Kite Connect)');
  });

  it('refuses unknown brokers with a 404', () => {
    const registry = BrokerRegistry.standard({ clock });
    expect(registry.has('paper')).toBe(false);
    try {
      registry.get('dhan');
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect([(e as AppError).status, (e as AppError).message]).toEqual([404, 'Unknown broker "dhan".']);
    }
  });

  it('holds whatever adapters it is given', async () => {
    const paper = new PaperBroker({ db: await testDb(), clock });
    const registry = new BrokerRegistry([paper]);
    expect(registry.list()).toEqual([paper]);
    expect(registry.get('paper')).toBe(paper);
    expect(registry.has('zerodha')).toBe(false);
  });
});
