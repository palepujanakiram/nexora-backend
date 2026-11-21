import type { FastifyPluginAsync } from 'fastify';

import type { Services } from '../../container.ts';
import { AppError } from '../../domain/errors.ts';
import { exchangeOf } from '../../domain/signal.ts';
import { toPaise } from '../../domain/money.ts';
import { instrumentId } from '../../domain/instrument.ts';
import { principalOf } from '../app.ts';
import { AnalyticsQuery, InstrumentQuery, ParseSignalBody, SignalsFeedQuery, parse } from '../schemas.ts';

export const EGRESS_IP_URL = 'https://api.ipify.org?format=json';

/** Nexora's own EMA Pivot signals API (vendor-hosted; never called from app or browser code). */
export const EPS_API_URL = 'https://zxrzvywkyhyssajdkdpy.supabase.co/functions/v1/eps-api';

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

    /**
     * Live NIFTY/SENSEX signals from Nexora's EMA Pivot rule, proxied so the
     * vendor's x-api-key stays server-side only — the app never holds it.
     * Measured-good defaults (both symbols, 15m/30m/1H, no option premium
     * signals): the vendor's own testing shows 3m/5m and option premium
     * signals lose money.
     */
    app.get('/signals/feed', async (request) => {
      const q = parse(SignalsFeedQuery, request.query);
      const key = s.config.EPS_API_KEY;
      if (!key) throw new AppError(503, 'eps_not_configured', 'The signals feed is not configured on this server.');
      const target = new URL(EPS_API_URL);
      target.searchParams.set('symbols', q.symbols);
      target.searchParams.set('tfs', q.tfs);
      target.searchParams.set('history', String(q.history));
      let upstream: Response;
      try {
        upstream = await s.fetch(target.toString(), { headers: { 'x-api-key': key } });
      } catch {
        throw new AppError(502, 'eps_unavailable', "Couldn't reach the signals service. Try again.");
      }
      if (!upstream.ok) throw new AppError(502, 'eps_unavailable', 'The signals service is unavailable. Try again.');
      let body: unknown;
      try {
        body = await upstream.json();
      } catch {
        throw new AppError(502, 'eps_unavailable', 'The signals service returned an unexpected response.');
      }
      return body;
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
