import type { FastifyPluginAsync } from 'fastify';

import type { Services } from '../../container.ts';
import type { User } from '../../data/identity.ts';
import { e164 } from '../../domain/phone.ts';
import { principalOf } from '../app.ts';
import { OtpRequestBody, OtpVerifyBody, RefreshBody, parse } from '../schemas.ts';

export const userView = (u: User) => ({ id: u.id, phone: e164(u.phone), email: u.email, createdAt: u.createdAt.toISOString() });

/** OTP sign-in, token refresh and the JWKS. Public, with a tighter rate limit against guessing. */
export const publicAuthRoutes =
  ({ identity, signer, config }: Services): FastifyPluginAsync =>
  async (app) => {
    const limit = { rateLimit: { max: config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } };

    app.post('/auth/otp/request', { config: limit }, async (request) => {
      return identity.requestOtp({ ...parse(OtpRequestBody, request.body), ip: request.ip });
    });

    app.post('/auth/otp/verify', { config: limit }, async (request) => {
      const { user, ...tokens } = await identity.verifyOtp({ ...parse(OtpVerifyBody, request.body), ip: request.ip });
      return { ...tokens, user: userView(user) };
    });

    app.post('/auth/refresh', { config: limit }, async (request) => identity.refresh(parse(RefreshBody, request.body)));

    app.get('/.well-known/jwks.json', async (_request, reply) => {
      reply.header('Cache-Control', 'public, max-age=300');
      return signer.jwks();
    });
  };

/** The signed-in user's own sessions. */
export const authRoutes =
  ({ identity }: Services): FastifyPluginAsync =>
  async (app) => {
    app.get('/me', async (request) => userView(principalOf(request).user));

    app.post('/auth/logout', async (request, reply) => {
      await identity.logout(principalOf(request).sessionId);
      return reply.status(204).send();
    });

    app.get('/auth/sessions', async (request) => {
      const me = principalOf(request);
      return {
        sessions: (await identity.sessions(me.user.id)).map((s) => ({
          id: s.id,
          clientId: s.clientId,
          device: s.device,
          ip: s.ip,
          createdAt: s.createdAt.toISOString(),
          lastUsedAt: s.lastUsedAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
          current: s.id === me.sessionId,
        })),
      };
    });

    app.delete<{ Params: { id: string } }>('/auth/sessions/:id', async (request, reply) => {
      await identity.revoke(principalOf(request).user.id, request.params.id);
      return reply.status(204).send();
    });
  };
