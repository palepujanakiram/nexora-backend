import { notFound } from '../domain/errors.ts';
import type { BrokerAdapter } from './adapter.ts';
import { AngelOneAdapter } from './angelone/index.ts';
import { GrowwAdapter } from './groww/index.ts';
import { UpstoxAdapter } from './upstox/index.ts';
import { ZerodhaAdapter } from './zerodha/index.ts';

export interface AdapterDeps {
  clock: () => Date;
}

/**
 * Every supported broker. Adding one means writing `src/brokers/<code>/` and
 * adding one line here; routing, orders and storage don't change.
 */
export const BROKER_MODULES: Readonly<Record<string, (deps: AdapterDeps) => BrokerAdapter>> = {
  zerodha: (deps) => new ZerodhaAdapter(deps),
  upstox: (deps) => new UpstoxAdapter(deps),
  angelone: (deps) => new AngelOneAdapter(deps),
  groww: (deps) => new GrowwAdapter(deps),
};

/** The adapters this server runs, by broker code. */
export class BrokerRegistry {
  private readonly adapters: Map<string, BrokerAdapter>;

  constructor(adapters: readonly BrokerAdapter[]) {
    this.adapters = new Map(adapters.map((a) => [a.code, a]));
  }

  static standard(deps: AdapterDeps): BrokerRegistry {
    return new BrokerRegistry(Object.values(BROKER_MODULES).map((create) => create(deps)));
  }

  has(code: string): boolean {
    return this.adapters.has(code);
  }

  get(code: string): BrokerAdapter {
    const adapter = this.adapters.get(code);
    if (!adapter) throw notFound(`Unknown broker "${code}".`);
    return adapter;
  }

  list(): BrokerAdapter[] {
    return [...this.adapters.values()];
  }
}
