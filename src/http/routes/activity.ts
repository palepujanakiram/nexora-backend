import type { FastifyPluginAsync } from 'fastify';

import { userOf, type AppDeps } from '../app.ts';
import { ActivityQuery, parse } from '../schemas.ts';
import { executionView } from './signals.ts';

/** The activity log shared by all of a user's devices. */
export const activityRoutes =
  ({ executions }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/activity', async (request) => {
      const { limit } = parse(ActivityQuery, request.query);
      return { results: executions.list(userOf(request).id, limit).map(executionView) };
    });

    app.delete('/activity', async (request, reply) => {
      executions.clear(userOf(request).id);
      return reply.status(204).send();
    });
  };
