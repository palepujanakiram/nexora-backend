import type { FastifyPluginAsync } from 'fastify';

import type { Services } from '../../container.ts';
import { AppError } from '../../domain/errors.ts';
import { principalOf } from '../app.ts';
import { CompleteLinkBody, LinkAccountBody, UpdateAccountBody, parse } from '../schemas.ts';

type WithId = { Params: { id: string } };

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title}</title></head><body style="font-family:system-ui;padding:2rem;max-width:32rem;margin:auto">` +
  `<h1>${title}</h1><p>${body}</p></body></html>`;

const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page shown when the broker's redirect couldn't finish the link. Unexpected errors don't show their message. */
function failurePage(e: unknown): { status: number; html: string } {
  if (e instanceof AppError) return { status: e.status, html: page('Linking failed', escapeHtml(e.message)) };
  return { status: 500, html: page('Linking failed', 'Something went wrong. Try again from the app.') };
}

/** Linked broker accounts. */
export const brokerAccountRoutes =
  ({ brokerAccounts }: Services): FastifyPluginAsync =>
  async (app) => {
    app.get('/brokers', async () => ({ brokers: brokerAccounts.brokers() }));

    app.get('/broker-accounts', async (request) => ({ accounts: await brokerAccounts.list(principalOf(request).user.id) }));

    /** Links an account and returns how to start the broker login. */
    app.post('/broker-accounts', async (request, reply) => {
      const body = parse(LinkAccountBody, request.body);
      return reply.status(201).send(await brokerAccounts.link(principalOf(request).user.id, body));
    });

    app.get<WithId>('/broker-accounts/:id', async (request) => brokerAccounts.get(principalOf(request).user.id, request.params.id));

    app.patch<WithId>('/broker-accounts/:id', async (request) =>
      brokerAccounts.update(principalOf(request).user.id, request.params.id, parse(UpdateAccountBody, request.body)),
    );

    /** The broker login to (re)do, for an account whose session needs the user. */
    app.get<WithId>('/broker-accounts/:id/relink', async (request) => brokerAccounts.relink(principalOf(request).user.id, request.params.id));

    /** Finishes the login with what the app caught from the redirect, or the TOTP the user typed. */
    app.post<WithId>('/broker-accounts/:id/link', async (request) =>
      brokerAccounts.completeLink(principalOf(request).user.id, request.params.id, parse(CompleteLinkBody, request.body).params),
    );

    app.delete<WithId>('/broker-accounts/:id', async (request, reply) => {
      await brokerAccounts.unlink(principalOf(request).user.id, request.params.id);
      return reply.status(204).send();
    });
  };

/** Where brokers send the browser after login, and their order postbacks. Public; checked by state or signature. */
export const brokerPublicRoutes =
  ({ brokerAccounts, reconciler }: Services): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Params: { broker: string }; Querystring: Record<string, string> }>('/broker-callback/:broker', async (request, reply) => {
      reply.type('text/html; charset=utf-8');
      try {
        const account = await brokerAccounts.callback(request.params.broker, request.query);
        return page('Account linked', `${escapeHtml(account.label)} is ready to trade. You can close this page and return to the app.`);
      } catch (e) {
        const failed = failurePage(e);
        if (failed.status >= 500) request.log.error({ err: e }, 'broker callback failed');
        return reply.status(failed.status).send(failed.html);
      }
    });

    app.post<{ Params: { broker: string } }>('/webhooks/:broker', async (request) => {
      return reconciler.webhook(request.params.broker, request.body, request.headers);
    });
  };
