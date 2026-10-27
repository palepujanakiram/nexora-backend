import type { FastifyPluginAsync } from 'fastify';

import { userOf, type AppDeps } from '../app.ts';
import { ConnectBody, CreateAccountBody, UpdateAccountBody, parse } from '../schemas.ts';

type WithId = { Params: { id: string } };

/** Broker accounts and their daily broker login. */
export const accountRoutes =
  ({ accounts }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/accounts', async (request) => ({ accounts: accounts.list(userOf(request).id) }));

    app.post('/accounts', async (request, reply) => {
      const body = parse(CreateAccountBody, request.body);
      return reply.status(201).send(accounts.create(userOf(request).id, body));
    });

    app.get<WithId>('/accounts/:id', async (request) => accounts.get(userOf(request).id, request.params.id));

    app.patch<WithId>('/accounts/:id', async (request) => {
      const body = parse(UpdateAccountBody, request.body);
      return accounts.update(userOf(request).id, request.params.id, body);
    });

    app.delete<WithId>('/accounts/:id', async (request, reply) => {
      accounts.delete(userOf(request).id, request.params.id);
      return reply.status(204).send();
    });

    /** How to log in to the broker today: a page to open and what to catch. */
    app.get<WithId>('/accounts/:id/login', async (request) => accounts.login(userOf(request).id, request.params.id));

    /** Finishes the broker login with the redirect URL / code (or Groww approval / TOTP). */
    app.post<WithId>('/accounts/:id/session', async (request) => {
      const { input } = parse(ConnectBody, request.body);
      return accounts.connect(userOf(request).id, request.params.id, input);
    });

    app.delete<WithId>('/accounts/:id/session', async (request) =>
      accounts.disconnect(userOf(request).id, request.params.id),
    );
  };
