import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import type { Fetch } from '../brokers/broker-api.ts';
import type { Config } from '../config.ts';
import type { ExecutionRepository } from '../data/executions.ts';
import type { User } from '../data/users.ts';
import { AppError, unauthorized } from '../domain/errors.ts';
import type { AccountService } from '../usecases/accounts.ts';
import type { AuthService } from '../usecases/auth.ts';
import type { ExecuteSignalService } from '../usecases/execute-signal.ts';
import type { OtpLoginService } from '../usecases/otp-login.ts';
import { accountRoutes } from './routes/accounts.ts';
import { activityRoutes } from './routes/activity.ts';
import { authRoutes, meRoutes } from './routes/auth.ts';
import { serverRoutes } from './routes/server.ts';
import { signalRoutes } from './routes/signals.ts';

export interface AppDeps {
  config: Config;
  auth: AuthService;
  otp: OtpLoginService;
  accounts: AccountService;
  signals: ExecuteSignalService;
  executions: ExecutionRepository;
  /** Used only to look up the server's own outgoing IP. */
  fetch: Fetch;
  version: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

/** The signed-in user. Only call from routes registered behind [requireUser]. */
export const userOf = (request: FastifyRequest): User => request.user!;

/** Builds the HTTP API. Doesn't listen; call `listen` or use `inject` in tests. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    // Fly's proxy sits in front, so the client IP is in X-Forwarded-For.
    trustProxy: true,
    bodyLimit: 64 * 1024,
    logger: {
      level: config.LOG_LEVEL,
      // Never log bearer tokens, secrets or signal bodies.
      redact: ['req.headers.authorization'],
    },
  });

  app.decorateRequest('user', null);

  await app.register(cors, {
    origin: config.CORS_ORIGINS.length ? config.CORS_ORIGINS : false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  await app.register(rateLimit, { max: config.RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof AppError) {
      const { code, message, details } = error;
      return reply.status(error.status).send({ error: details ? { code, message, details } : { code, message } });
    }
    const status = error.statusCode ?? 500;
    if (status === 429) {
      return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' } });
    }
    if (status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'bad_request', message: error.message } });
    }
    request.log.error(error);
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong on the server.' } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'No such endpoint.' } }),
  );

  app.get('/health', async () => ({
    status: 'ok',
    service: 'nexora-backend',
    version: deps.version,
    liveTrading: config.LIVE_TRADING,
  }));

  await app.register(
    async (v1) => {
      await v1.register(authRoutes(deps));
      await v1.register(async (secured) => {
        secured.addHook('onRequest', async (request) => {
          request.user = deps.auth.authenticate(bearerToken(request));
        });
        await secured.register(meRoutes(deps));
        await secured.register(accountRoutes(deps));
        await secured.register(signalRoutes(deps));
        await secured.register(activityRoutes(deps));
        await secured.register(serverRoutes(deps));
      });
    },
    { prefix: '/v1' },
  );

  return app;
}

/** The token from `Authorization: Bearer <token>`. */
export function bearerToken(request: FastifyRequest): string {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
  if (!match) throw unauthorized();
  return match[1]!;
}
