import type { FastifyPluginAsync } from 'fastify';

import type { Services } from '../../container.ts';
import { AppError } from '../../domain/errors.ts';

/**
 * `WS /stream`: pushes leg status changes, re-link prompts and entitlement
 * changes to the user's devices. Browsers can't set headers on a WebSocket,
 * so the access token comes as `?access_token=` (never logged: request URLs
 * are logged without their query string).
 */
export const streamRoutes =
  ({ identity, events }: Services): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Querystring: { access_token?: string } }>('/stream', { websocket: true }, async (socket, request) => {
      let userId: string;
      try {
        const header = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
        const token = header ?? request.query.access_token ?? '';
        userId = (await identity.authenticate(token)).user.id;
      } catch (e) {
        socket.close(4401, e instanceof AppError ? e.message.slice(0, 100) : 'Unauthorized');
        return;
      }
      const unsubscribe = events.subscribe(userId, (event) => { socket.send(JSON.stringify(event)); });
      socket.on('close', unsubscribe);
      socket.send(JSON.stringify({ type: 'ready' }));
    });
  };
