import type { FastifyPluginAsync } from 'fastify';

import type { Services } from '../../container.ts';
import { principalOf } from '../app.ts';
import { CheckoutBody, parse } from '../schemas.ts';

/** Plans and the user's subscription. */
export const billingRoutes =
  ({ billing }: Services): FastifyPluginAsync =>
  async (app) => {
    app.get('/plans', async () => ({ plans: await billing.plans() }));
    app.get('/subscription', async (request) => billing.current(principalOf(request).user.id));
    app.post('/subscription/checkout', async (request) => billing.checkout(principalOf(request).user.id, parse(CheckoutBody, request.body).planCode));
    app.post('/subscription/cancel', async (request) => billing.cancel(principalOf(request).user.id));
  };

/** Razorpay's webhook. The signature covers the raw body, so this route keeps it as a string. */
export const razorpayWebhookRoutes =
  ({ billing }: Services): FastifyPluginAsync =>
  async (app) => {
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => { done(null, body); });
    app.post('/webhooks/razorpay', async (request) => {
      const header = (name: string) => request.headers[name]?.toString();
      const raw = typeof request.body === 'string' ? request.body : '';
      return billing.webhook(raw, header('x-razorpay-signature'), header('x-razorpay-event-id'));
    });
  };
