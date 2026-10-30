import type { FastifyInstance } from 'fastify';

import { loadConfig } from './config.ts';
import { createServices, realRuntime, type Runtime } from './container.ts';
import { buildApp } from './http/app.ts';

/** Starts the API (and, unless turned off, the background jobs). Returns the running app. */
export async function start(
  env: Record<string, string | undefined> = process.env,
  runtime: Runtime = realRuntime,
): Promise<FastifyInstance> {
  const config = loadConfig(env);
  const services = await createServices(config, runtime);
  const app = await buildApp(services);
  app.addHook('onClose', async () => {
    await services.scheduler.stop();
    await services.db.close();
  });
  await app.listen({ port: config.PORT, host: config.HOST });
  if (config.JOBS_ENABLED) services.scheduler.start(1000);
  if (!config.LIVE_TRADING) app.log.warn({ mode: 'dry_run' }, 'LIVE_TRADING is off: broker writes for live accounts are logged, not sent.');
  return app;
}

/** Closes the app cleanly when the platform asks the process to stop. */
export function closeOnSignals(app: FastifyInstance, signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']) {
  for (const signal of signals) {
    process.once(signal, () => void app.close().then(() => process.exit(0)));
  }
}

/** Starts the server and stops it cleanly on SIGINT/SIGTERM. */
export async function main(env: Record<string, string | undefined> = process.env, runtime: Runtime = realRuntime): Promise<FastifyInstance> {
  const app = await start(env, runtime);
  closeOnSignals(app);
  return app;
}

if (import.meta.main) await main();
