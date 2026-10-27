import type { FastifyPluginAsync } from 'fastify';

import { BrokerApiError } from '../../domain/errors.ts';
import type { AppDeps } from '../app.ts';

export const EGRESS_IP_URL = 'https://api.ipify.org?format=json';

/** Facts about the server the user needs while setting up their brokers. */
export const serverRoutes =
  ({ config, fetch }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    /** The public IP brokers see orders coming from: the one to register with them. */
    app.get('/server/ip', async () => {
      let ip: unknown;
      try {
        const res = await fetch(EGRESS_IP_URL, { signal: AbortSignal.timeout(5000) });
        ip = ((await res.json()) as { ip?: unknown }).ip;
      } catch {
        ip = null;
      }
      if (typeof ip !== 'string' || !ip) throw new BrokerApiError('Could not look up the server IP. Try again.');
      return { ip, liveTrading: config.LIVE_TRADING };
    });
  };
