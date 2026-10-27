import { loadConfig } from './config.ts';
import { createServices } from './container.ts';

const USAGE = `Usage:
  node dist/cli.js create-user <email>       (password from NEXORA_PASSWORD)
  node dist/cli.js gen-key                   (prints a new ENCRYPTION_KEY)`;

/**
 * Server admin commands. Returns the text to print; throws with a message on
 * failure. Kept free of process I/O so it can be tested.
 */
export async function runCli(args: string[], env: Record<string, string | undefined>): Promise<string> {
  const [command, email] = args;
  if (command === 'gen-key') {
    const { randomBytes } = await import('node:crypto');
    return randomBytes(32).toString('base64');
  }
  if (command === 'create-user') {
    if (!email) throw new Error(USAGE);
    const password = env['NEXORA_PASSWORD'];
    if (!password) throw new Error('Set NEXORA_PASSWORD to the new user\'s password.');
    const services = createServices(loadConfig(env));
    try {
      const user = await services.auth.createUser(email, password);
      return `Created user ${user.email} (${user.id}).`;
    } finally {
      services.db.close();
    }
  }
  throw new Error(USAGE);
}

if (import.meta.main) {
  try {
    console.log(await runCli(process.argv.slice(2), process.env));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
