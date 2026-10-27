import type { FastifyInstance } from 'fastify';

import { loadConfig } from './config.ts';
import { createServices, realRuntime, type Runtime } from './container.ts';
import { buildApp } from './http/app.ts';

/** Starts the API on the configured host and port. Returns the running app. */
export async function start(
  env: Record<string, string | undefined> = process.env,
  runtime: Runtime = realRuntime,
): Promise<FastifyInstance> {
  const config = loadConfig(env);
  const services = createServices(config, runtime);
  const app = await buildApp(services);
  app.addHook('onClose', async () => services.db.close());
  await app.listen({ port: config.PORT, host: config.HOST });
  if (!config.LIVE_TRADING) app.log.warn('LIVE_TRADING is off: live accounts will not send real orders.');
  return app;
}

/** Closes the app cleanly when the platform asks the process to stop. */
export function closeOnSignals(app: FastifyInstance, signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']) {
  for (const signal of signals) {
    process.once(signal, () => void app.close().then(() => process.exit(0)));
  }
}

if (import.meta.main) {
  closeOnSignals(await start());
}
