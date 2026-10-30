import { randomBytes } from 'node:crypto';

import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import type { Services } from '../container.ts';
import { sameSecret, sha256 } from '../data/crypto.ts';
import { BrokerError } from '../domain/broker-error.ts';
import { AppError, badRequest, unauthorized } from '../domain/errors.ts';
import { traceFrom, traceparent, type TraceContext } from '../logging.ts';
import type { Principal } from '../usecases/identity.ts';
import { adminRoutes } from './routes/admin.ts';
import { authRoutes, publicAuthRoutes } from './routes/auth.ts';
import { billingRoutes, razorpayWebhookRoutes } from './routes/billing.ts';
import { brokerAccountRoutes, brokerPublicRoutes } from './routes/brokers.ts';
import { marketRoutes } from './routes/market.ts';
import { orderRoutes } from './routes/orders.ts';
import { streamRoutes } from './routes/stream.ts';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    trace: TraceContext;
  }
}

/** The signed-in caller. Only call from routes registered behind [requireUser]. */
export const principalOf = (request: FastifyRequest): Principal => request.principal!;

/** The token from `Authorization: Bearer <token>`. */
export function bearerToken(request: FastifyRequest): string {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
  if (!match) throw unauthorized();
  return match[1]!;
}

/** Builds the HTTP API. Doesn't listen; call `listen` or use `inject` in tests. */
export async function buildApp(s: Services): Promise<FastifyInstance> {
  const { config } = s;
  const app = Fastify({
    loggerInstance: s.logger as FastifyBaseLogger,
    // Fly's proxy sits in front, so the client IP is in X-Forwarded-For.
    trustProxy: true,
    bodyLimit: 256 * 1024,
    genReqId: () => randomBytes(8).toString('hex'),
  });

  app.decorateRequest('principal', null);
  app.decorateRequest('trace', null as unknown as TraceContext);
  app.addHook('onRequest', async (request, reply) => {
    request.trace = traceFrom(request.headers.traceparent);
    request.log = request.log.child({ traceId: request.trace.traceId, spanId: request.trace.spanId });
    reply.header('traceparent', traceparent(request.trace));
  });

  await app.register(cors, {
    origin: config.CORS_ORIGINS.length ? config.CORS_ORIGINS : false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'traceparent'],
    maxAge: 600,
  });
  await app.register(rateLimit, { max: config.RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' });
  await app.register(websocket);

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof AppError) {
      const { code, message, details } = error;
      return reply.status(error.status).send({ error: details ? { code, message, details } : { code, message } });
    }
    if (error instanceof BrokerError) {
      return reply.status(error.code === 'AUTH_EXPIRED' ? 401 : 502).send({ error: { code: 'broker_error', message: error.message, details: { code: error.code } } });
    }
    const status = error.statusCode ?? 500;
    if (status === 429) {
      return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' } });
    }
    if (status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'bad_request', message: error.message } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong on the server.' } });
  });
  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'No such endpoint.' } }));

  app.get('/health', async () => ({
    status: 'ok',
    service: 'nexora-backend',
    version: s.version,
    liveTrading: config.LIVE_TRADING,
    billing: config.BILLING_ENABLED,
  }));

  // Public: sign-in, JWKS, broker redirects and webhooks.
  await app.register(publicAuthRoutes(s));
  await app.register(brokerPublicRoutes(s));
  await app.register(razorpayWebhookRoutes(s));
  await app.register(streamRoutes(s));

  // Admin: a separate static credential, never a user session.
  await app.register(async (admin) => {
    admin.addHook('onRequest', async (request) => {
      const expected = config.ADMIN_TOKEN;
      if (!expected) throw new AppError(404, 'not_found', 'No such endpoint.');
      if (!sameSecret(bearerToken(request), expected)) throw new AppError(403, 'forbidden', 'Admin credential required.');
    });
    await admin.register(adminRoutes(s));
  });

  // Signed-in users.
  await app.register(async (secured) => {
    secured.addHook('onRequest', async (request) => {
      request.principal = await s.identity.authenticate(bearerToken(request));
      request.log = request.log.child({ userId: request.principal.user.id, sessionId: request.principal.sessionId });
    });
    await secured.register(authRoutes(s));
    await secured.register(brokerAccountRoutes(s));
    await secured.register(orderRoutes(s));
    await secured.register(marketRoutes(s));
    await secured.register(billingRoutes(s));
  });

  return app;
}

/**
 * Runs [fn] at most once per `Idempotency-Key`. A replay with the same body
 * gets the stored response (and `Idempotent-Replayed: true`); a different
 * body for the key is refused. Without this, a retry on a flaky connection
 * would place a second real order.
 */
export async function idempotent(
  s: Services,
  request: FastifyRequest,
  reply: FastifyReply,
  operation: string,
  fn: (key: string) => Promise<{ status: number; body: unknown }>,
) {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[\w.:-]{8,200}$/.test(key)) {
    throw badRequest('Send an Idempotency-Key header (8–200 letters, digits, - _ . :), unique per intended action.');
  }
  const userId = principalOf(request).user.id;
  const hash = sha256(JSON.stringify({ operation, params: request.params ?? null, body: request.body ?? null }));
  const start = await s.orders.beginIdempotent(userId, key, operation, hash);
  if (start.state === 'replay') return reply.status(start.statusCode).header('Idempotent-Replayed', 'true').send(start.response);
  if (start.state === 'in_progress') throw new AppError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still running.');
  if (start.state === 'mismatch') throw new AppError(422, 'idempotency_mismatch', 'This Idempotency-Key was used for a different request.');
  let result: { status: number; body: unknown };
  try {
    result = await fn(key);
  } catch (e) {
    if (e instanceof AppError) {
      // Refused before anything reached a broker: the key is free to retry.
      await s.orders.releaseIdempotent(userId, key);
    } else {
      await s.orders.finishIdempotent(userId, key, 500, { error: { code: 'internal', message: 'Check GET /orders before retrying with a new key.' } });
    }
    throw e;
  }
  await s.orders.finishIdempotent(userId, key, result.status, result.body);
  return reply.status(result.status).send(result.body);
}
