import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { loadConfig } from './config.ts';
import { createServices } from './container.ts';
import { CLIENT_PLATFORMS, isClientPlatform, type ClientPlatform } from './data/identity.ts';
import { e164 } from './domain/phone.ts';

const USAGE = `Usage:
  node dist/cli.js gen-key                     prints a new encryption key
  node dist/cli.js gen-jwt-key                 prints a new Ed25519 private key (PEM) for JWT_PRIVATE_KEY
  node dist/cli.js create-user <mobile> [email]
  node dist/cli.js create-client <name> <web|ios|android|partner|other>
  node dist/cli.js migrate                     applies database migrations and exits`;

/**
 * Server admin commands. Returns the text to print; throws with a message on
 * failure. Kept free of process I/O so it can be tested.
 */
export async function runCli(args: string[], env: Record<string, string | undefined>): Promise<string> {
  const [command, a, b] = args;
  if (command === 'gen-key') return randomBytes(32).toString('base64');
  if (command === 'gen-jwt-key') {
    return generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  }
  if (command !== 'create-user' && command !== 'create-client' && command !== 'migrate') throw new Error(USAGE);
  if (command !== 'migrate' && !a) throw new Error(USAGE);
  // Arguments are checked before the database is opened.
  const platform = command === 'create-client' ? platformOf(b) : 'other';
  const services = await createServices(loadConfig(env));
  try {
    if (command === 'migrate' || !a) return 'Database is up to date.';
    if (command === 'create-user') {
      const user = await services.identity.registerUser({ phone: a, email: b ?? null });
      return `Created user ${e164(user.phone)} (${user.id}).`;
    }
    const client = await services.identity.registerClient({
      name: a,
      platform,
      grantTypes: ['otp', 'refresh_token'],
      accessTtlSeconds: 900,
      refreshTtlSeconds: platform === 'web' ? 7 * 86_400 : 90 * 86_400,
    });
    return `Created client ${client.name} (${client.id}).`;
  } finally {
    await services.db.close();
  }
}

/** The client platform named on the command line (default `other`). */
function platformOf(arg: string | undefined): ClientPlatform {
  const platform = arg ?? 'other';
  if (!isClientPlatform(platform)) throw new Error(`Unknown platform "${platform}". Use one of: ${CLIENT_PLATFORMS.join(', ')}.`);
  return platform;
}

/** Runs a command and returns the process exit code; output goes through [io]. */
export async function main(
  args: string[],
  env: Record<string, string | undefined>,
  io: { out: (line: string) => void; err: (line: string) => void },
): Promise<number> {
  try {
    io.out(await runCli(args, env));
    return 0;
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, { out: console.log, err: console.error });
