import type { FastifyPluginAsync } from 'fastify';

import type { Services } from '../../container.ts';
import { idempotent, principalOf } from '../app.ts';
import { ListOrdersQuery, ModifyOrderBody, PlaceOrderBody, SubsetBody, parse } from '../schemas.ts';

type WithId = { Params: { id: string } };

/**
 * Orders. Every write needs an Idempotency-Key and answers 207 with one
 * result per leg: there is no single success or failure for a fan-out.
 */
export const orderRoutes =
  (s: Services): FastifyPluginAsync =>
  async (app) => {
    const { orders } = s;

    app.post('/orders', async (request, reply) => {
      const body = parse(PlaceOrderBody, request.body);
      return idempotent(s, request, reply, 'place', async (key) => {
        const me = principalOf(request);
        const result = await orders.place(me.user.id, {
          clientId: me.clientId,
          idempotencyKey: key,
          accountIds: body.accountIds,
          intent: {
            instrumentId: body.instrumentId,
            side: body.side,
            quantity: body.quantity,
            orderType: body.orderType,
            product: body.product,
            pricePaise: body.price ?? null,
            triggerPaise: body.triggerPrice ?? null,
            referencePricePaise: body.referencePrice ?? null,
          },
        });
        return { status: 207, body: result };
      });
    });

    app.get('/orders', async (request) => {
      const q = parse(ListOrdersQuery, request.query);
      return { orders: await orders.list(principalOf(request).user.id, q.limit, q.before ? new Date(q.before) : null) };
    });

    app.get<WithId>('/orders/:id', async (request) => orders.get(principalOf(request).user.id, request.params.id));

    app.get<{ Params: { id: string; legId: string } }>('/orders/:id/legs/:legId/events', async (request) => {
      const events = await orders.events(principalOf(request).user.id, request.params.id, request.params.legId);
      return { events: events.map((e) => ({ ...e, at: e.at.toISOString() })) };
    });

    app.post<WithId>('/orders/:id/modify', async (request, reply) => {
      const body = parse(ModifyOrderBody, request.body);
      return idempotent(s, request, reply, 'modify', async (key) => ({
        status: 207,
        body: await orders.modify(principalOf(request).user.id, request.params.id, {
          idempotencyKey: key,
          accountIds: body.accountIds ?? null,
          quantity: body.quantity,
          pricePaise: body.price,
          triggerPaise: body.triggerPrice,
          orderType: body.orderType,
        }),
      }));
    });

    app.post<WithId>('/orders/:id/cancel', async (request, reply) => {
      const body = parse(SubsetBody, request.body);
      return idempotent(s, request, reply, 'cancel', async () => ({
        status: 207,
        body: await orders.cancel(principalOf(request).user.id, request.params.id, body.accountIds ?? null),
      }));
    });

    app.post<WithId>('/orders/:id/exit', async (request, reply) => {
      const body = parse(SubsetBody, request.body);
      return idempotent(s, request, reply, 'exit', async (key) => {
        const me = principalOf(request);
        return { status: 207, body: await orders.exit(me.user.id, request.params.id, key, me.clientId, body.accountIds ?? null) };
      });
    });
  };
