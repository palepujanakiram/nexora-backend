import type { InstrumentRepository, InstrumentSearch } from '../data/instruments.ts';
import { rupees } from '../domain/money.ts';
import type { Instrument } from '../domain/instrument.ts';
import type { Log } from '../logging.ts';
import type { BrokerGateway } from './gateway.ts';

export const instrumentView = (i: Instrument) => ({
  id: i.id,
  exchange: i.exchange,
  type: i.type,
  underlying: i.underlying,
  expiry: i.expiry,
  strike: i.strikePaise === null ? null : rupees(i.strikePaise),
  lotSize: i.lotSize,
  tickSize: rupees(i.tickPaise),
});

/**
 * The instrument master: one canonical row per contract, mapped to each
 * broker's identifier. Refreshed every morning before the market opens.
 */
export class InstrumentService {
  private readonly d: { instruments: InstrumentRepository; gateway: BrokerGateway; clock: () => Date; log: Log };

  constructor(deps: { instruments: InstrumentRepository; gateway: BrokerGateway; clock: () => Date; log: Log }) {
    this.d = deps;
  }

  async search(q: InstrumentSearch) {
    return (await this.d.instruments.search(q)).map(instrumentView);
  }

  /** Downloads each broker's master and upserts it. One broker failing doesn't stop the others. */
  async refresh(brokers: readonly string[] = this.d.gateway.brokers().map((b) => b.code)) {
    const results: { broker: string; count: number; error: string | null }[] = [];
    for (const broker of brokers) {
      const started = this.d.clock();
      try {
        const rows = await this.d.gateway.instrumentMaster(broker);
        const count = await this.d.instruments.upsertFromBroker(broker, rows, started);
        // Mappings this run didn't touch are for contracts the broker no longer lists.
        if (count > 0) await this.d.instruments.pruneMappings(broker, started);
        results.push({ broker, count, error: null });
        this.d.log.info({ job: 'instruments', broker, count }, 'instrument master refreshed');
      } catch (e) {
        results.push({ broker, count: 0, error: (e as Error).message });
        this.d.log.error({ job: 'instruments', broker, reason: (e as Error).message }, 'instrument master refresh failed');
      }
    }
    return results;
  }
}
