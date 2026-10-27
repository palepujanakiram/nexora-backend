import type { FastifyPluginAsync } from 'fastify';

import type { Execution } from '../../data/executions.ts';
import { contractLabel, entryLabel, exchangeOf } from '../../domain/signal.ts';
import { userOf, type AppDeps } from '../app.ts';
import { ExecuteBody, ParseBody, parse } from '../schemas.ts';

/** How an execution is shown to the app. */
export const executionView = (e: Execution) => ({
  id: e.id,
  accountId: e.accountId,
  accountLabel: e.accountLabel,
  broker: e.broker,
  signalText: e.signalText,
  paper: e.paper,
  time: e.time.toISOString(),
  symbol: e.symbol,
  quantity: e.quantity,
  entryPrice: e.entryPrice,
  orders: e.orders,
  error: e.error,
  success: e.error === null,
});

/** Parsing a signal (preview) and placing it on accounts. */
export const signalRoutes =
  ({ signals }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.post('/signals/parse', async (request) => {
      const signal = signals.parse(parse(ParseBody, request.body).text);
      return {
        signal,
        contract: contractLabel(signal),
        entry: entryLabel(signal),
        exchange: exchangeOf(signal),
      };
    });

    app.post('/signals/execute', async (request) => {
      const body = parse(ExecuteBody, request.body);
      const results = await signals.execute(userOf(request).id, body);
      return { results: results.map(executionView) };
    });
  };
