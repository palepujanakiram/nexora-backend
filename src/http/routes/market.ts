import type { FastifyPluginAsync } from 'fastify';

import type { Services } from '../../container.ts';
import { AppError } from '../../domain/errors.ts';
import { exchangeOf } from '../../domain/signal.ts';
import { toPaise } from '../../domain/money.ts';
import { instrumentId } from '../../domain/instrument.ts';
import { principalOf } from '../app.ts';
import { AnalyticsQuery, InstrumentQuery, ParseSignalBody, parse } from '../schemas.ts';

export const EGRESS_IP_URL = 'https://api.ipify.org?format=json';

/** Instruments, positions, signals, analytics and server facts. */
export const marketRoutes =
  (s: Services): FastifyPluginAsync =>
  async (app) => {
    app.get('/instruments', async (request) => ({ instruments: await s.instruments.search(parse(InstrumentQuery, request.query)) }));

    /** Live positions per linked account, read from the brokers. Never gated. */
    app.get('/positions', async (request) => ({ accounts: await s.positions.live(principalOf(request).user.id) }));

    /** Parses a free-text option signal into the canonical instrument and suggested order fields. Places nothing. */
    app.post('/signals/parse', async (request) => {
      const signal = s.parser.parse(parse(ParseSignalBody, request.body).text);
      const id = instrumentId({
        exchange: exchangeOf(signal),
        type: signal.optionType,
        underlying: signal.underlying,
        expiry: signal.expiry,
        strikePaise: toPaise(signal.strike),
      });
      const known = (await s.instruments.search({ underlying: signal.underlying, type: signal.optionType, expiry: signal.expiry, limit: 500 })).some(
        (i) => i.id === id,
      );
      return {
        signal,
        instrumentId: known ? id : null,
        order: { side: signal.action, orderType: 'LIMIT', price: String(signal.entryHigh) },
        warnings: known ? signal.warnings : [...signal.warnings, `Instrument ${id} isn't in the instrument master yet.`],
      };
    });

    app.get('/analytics/execution', async (request) => s.analytics.execution(principalOf(request).user.id, parse(AnalyticsQuery, request.query)));

    app.get('/analytics/pnl', async (request) => s.analytics.pnl(principalOf(request).user.id, parse(AnalyticsQuery, request.query)));

    /** The public IP brokers see orders coming from: the one to whitelist with them. */
    app.get('/server/ip', async () => {
      let ip: unknown;
      try {
        const res = await s.fetch(EGRESS_IP_URL, { signal: AbortSignal.timeout(5000) });
        ip = ((await res.json()) as { ip?: unknown }).ip;
      } catch {
        ip = null;
      }
      if (typeof ip !== 'string' || !ip) throw new AppError(502, 'ip_lookup_failed', 'Could not look up the server IP. Try again.');
      return { ip, liveTrading: s.config.LIVE_TRADING };
    });
  };
