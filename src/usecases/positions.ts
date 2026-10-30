import type { AnalyticsRepository } from '../data/analytics.ts';
import type { BrokerAccountRepository } from '../data/broker-accounts.ts';
import type { InstrumentRepository } from '../data/instruments.ts';
import type { PositionRepository } from '../data/positions.ts';
import { BrokerError } from '../domain/broker-error.ts';
import { rupees } from '../domain/money.ts';
import type { BrokerGateway } from './gateway.ts';

const money = (p: number | null) => (p === null ? null : rupees(p));

/** Live positions, read from each broker (never inferred from our orders). Never gated. */
export class PositionService {
  private readonly d: {
    accounts: BrokerAccountRepository;
    gateway: BrokerGateway;
    positions: PositionRepository;
    instruments: InstrumentRepository;
    analytics: AnalyticsRepository;
    clock: () => Date;
  };

  constructor(deps: PositionService['d']) {
    this.d = deps;
  }

  /** Reads every linked account in parallel. An account that fails is reported, not dropped. */
  async live(userId: string) {
    const accounts = await this.d.accounts.listForUser(userId);
    return Promise.all(
      accounts.map(async (a) => {
        try {
          const raw = await this.d.gateway.positions(a.id);
          const now = this.d.clock();
          const rows = await Promise.all(
            raw.map(async (p) => ({
              ...p,
              instrumentId: a.mode === 'paper' ? p.symbol.nativeId : await this.d.instruments.byNativeId(a.broker, p.symbol.nativeId),
            })),
          );
          await this.d.positions.replace(a.id, rows, now);
          await this.d.analytics.saveSnapshots(a.id, userId, rows.map((r) => ({ nativeId: r.symbol.nativeId, tradingSymbol: r.symbol.tradingSymbol, netQty: r.netQty, pnlPaise: r.pnlPaise })), now);
          return {
            accountId: a.id,
            broker: a.broker,
            mode: a.mode,
            syncedAt: now.toISOString(),
            positions: rows.map((r) => ({
              instrumentId: r.instrumentId,
              tradingSymbol: r.symbol.tradingSymbol,
              exchange: r.symbol.exchange,
              product: r.product,
              netQty: r.netQty,
              avgPrice: money(r.avgPricePaise),
              lastPrice: money(r.lastPricePaise),
              pnl: money(r.pnlPaise),
            })),
          };
        } catch (e) {
          const code = e instanceof BrokerError ? e.code : 'UNKNOWN';
          return { accountId: a.id, broker: a.broker, mode: a.mode, error: { code, message: (e as Error).message } };
        }
      }),
    );
  }
}
