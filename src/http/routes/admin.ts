import type { FastifyPluginAsync } from 'fastify';

import type { Services } from '../../container.ts';
import { badRequest } from '../../domain/errors.ts';
import { HolidayBody, KillSwitchBody, PlanBody, RefreshInstrumentsBody, RegisterClientBody, RegisterUserBody, parse } from '../schemas.ts';
import { userView } from './auth.ts';

/** Operator endpoints, behind ADMIN_TOKEN. */
export const adminRoutes =
  (s: Services): FastifyPluginAsync =>
  async (app) => {
    app.post('/admin/users', async (request, reply) => {
      return reply.status(201).send(userView(await s.identity.registerUser(parse(RegisterUserBody, request.body))));
    });

    app.post('/admin/clients', async (request, reply) => {
      const c = await s.identity.registerClient(parse(RegisterClientBody, request.body));
      return reply.status(201).send({ ...c, createdAt: c.createdAt.toISOString() });
    });

    app.get('/admin/clients', async () => ({
      clients: (await s.identity.clients()).map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
    }));

    app.get('/admin/kill-switch', async () => s.risk.killSwitch());

    /** Pauses (or resumes) every outbound order at once, without a deploy. */
    app.post('/admin/kill-switch', async (request) => {
      const { on, reason } = parse(KillSwitchBody, request.body);
      const result = await s.risk.setKillSwitch(on, reason);
      request.log.warn({ event: 'kill_switch', status: on ? 'on' : 'off', reason }, 'kill switch changed');
      return result;
    });

    app.post('/admin/plans', async (request) => {
      const { price, ...rest } = parse(PlanBody, request.body);
      return s.billing.upsertPlan({ ...rest, pricePaise: price });
    });

    app.post('/admin/holidays', async (request, reply) => {
      const { day, name } = parse(HolidayBody, request.body);
      await s.settings.addHoliday(day, name);
      return reply.status(201).send({ day, name });
    });

    app.get('/admin/holidays', async () => ({ holidays: await s.settings.holidays() }));

    app.post('/admin/instruments/refresh', async (request) => {
      const { brokers } = parse(RefreshInstrumentsBody, request.body);
      return { results: await s.instruments.refresh(brokers) };
    });

    app.get('/admin/reconciliation/issues', async () => ({
      issues: (await s.reconciler.openIssues()).map((i) => ({ ...i, foundAt: i.foundAt.toISOString() })),
    }));

    app.post<{ Params: { id: string } }>('/admin/reconciliation/issues/:id/resolve', async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) throw badRequest('Issue ids are numbers.');
      await s.reconciler.resolveIssue(id);
      return reply.status(204).send();
    });

    const JOBS: Record<string, () => Promise<unknown>> = {
      reconcile: async () => s.reconciler.pollDue(),
      eod_reconcile: async () => s.reconciler.endOfDay(),
      analytics: async () => s.analytics.pipeline(),
      sessions_refresh: async () => s.brokerAccounts.refreshSessions(),
      reencrypt: async () => s.brokerAccounts.reencrypt(),
    };

    /** Runs a background job now (e.g. end-of-day reconciliation, re-encryption after a key rotation). */
    app.post<{ Params: { name: string } }>('/admin/jobs/:name/run', async (request) => {
      const job = JOBS[request.params.name];
      if (!job) throw badRequest(`Unknown job. Jobs: ${Object.keys(JOBS).join(', ')}.`);
      return { job: request.params.name, result: await job() };
    });
  };
