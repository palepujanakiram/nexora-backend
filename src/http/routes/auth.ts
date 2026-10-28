import type { FastifyPluginAsync } from 'fastify';

import type { SignedIn } from '../../usecases/auth.ts';
import { bearerToken, userOf, type AppDeps } from '../app.ts';
import { ChangePasswordBody, LoginBody, RegisterBody, SendOtpBody, VerifyOtpBody, parse } from '../schemas.ts';

const signedIn = ({ token, user }: SignedIn) => ({
  token,
  user: { id: user.id, email: user.email, phone: user.phone && `+${user.phone}` },
});

/** Sign-up and sign-in. Public, with a tighter rate limit against password and code guessing. */
export const authRoutes =
  ({ auth, otp, config }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const limit = { rateLimit: { max: config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } };

    app.post('/auth/register', { config: limit }, async (request, reply) => {
      const body = parse(RegisterBody, request.body);
      return reply.status(201).send(signedIn(await auth.register(body)));
    });

    app.post('/auth/login', { config: limit }, async (request) => {
      return signedIn(await auth.login(parse(LoginBody, request.body)));
    });

    app.post('/auth/otp/send', { config: limit }, async (request) => {
      return otp.send({ ...parse(SendOtpBody, request.body), ip: request.ip });
    });

    app.post('/auth/otp/verify', { config: limit }, async (request) => {
      return signedIn(await otp.verify(parse(VerifyOtpBody, request.body)));
    });
  };

/** The signed-in user's own session and password. */
export const meRoutes =
  ({ auth }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/me', async (request) => {
      const user = userOf(request);
      return {
        id: user.id,
        email: user.email,
        phone: user.phone && `+${user.phone}`,
        createdAt: user.createdAt.toISOString(),
      };
    });

    app.post('/auth/logout', async (request, reply) => {
      auth.logout(bearerToken(request));
      return reply.status(204).send();
    });

    app.post('/auth/password', async (request) => {
      const body = parse(ChangePasswordBody, request.body);
      return signedIn(await auth.changePassword(userOf(request), body.currentPassword, body.newPassword, body.device));
    });
  };
