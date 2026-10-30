import { createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { main, runCli } from '../src/cli.ts';
import { JWT_PRIVATE_KEY } from './app.ts';
import { TEST_KEY, defined } from './helpers.ts';

const ENV = { DATABASE_URL: 'pglite:memory', ENCRYPTION_KEYS: `1:${TEST_KEY}`, JWT_PRIVATE_KEY, LOG_LEVEL: 'silent' };

describe('runCli', () => {
  it('generates a 32-byte encryption key', async () => {
    const key = await runCli(['gen-key'], {});
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(await runCli(['gen-key'], {})).not.toBe(key);
  });

  it('generates an Ed25519 private key PEM', async () => {
    const pem = await runCli(['gen-jwt-key'], {});
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n$/);
    expect(createPrivateKey(pem).asymmetricKeyType).toBe('ed25519');
  });

  it('prints usage for unknown commands and missing arguments', async () => {
    for (const args of [[], ['nope'], ['create-user'], ['create-client']]) {
      await expect(runCli(args, ENV)).rejects.toThrow(/^Usage:\n {2}node dist\/cli\.js gen-key/);
    }
  });

  it('migrates the database', async () => {
    expect(await runCli(['migrate'], ENV)).toBe('Database is up to date.');
  });

  it('creates a user', async () => {
    expect(await runCli(['create-user', '98765 43210', 'me@example.com'], ENV)).toMatch(/^Created user \+919876543210 \(\S+\)\.$/);
    expect(await runCli(['create-user', '+91 87654 32109'], ENV)).toMatch(/^Created user \+918765432109 \(\S+\)\.$/);
    await expect(runCli(['create-user', '12345'], ENV)).rejects.toThrow('Enter a 10-digit Indian mobile number.');
  });

  it('creates a client', async () => {
    expect(await runCli(['create-client', 'Web app', 'web'], ENV)).toMatch(/^Created client Web app \(\S+\)\.$/);
    expect(await runCli(['create-client', 'Partner'], ENV)).toMatch(/^Created client Partner \(\S+\)\.$/);
  });

  it('refuses a bad configuration', async () => {
    await expect(runCli(['migrate'], { ...ENV, DATABASE_URL: undefined })).rejects.toThrow('Invalid configuration: DATABASE_URL');
  });
});

describe('create-client platform', () => {
  it('refuses a platform it does not know, before touching the database', async () => {
    await expect(runCli(['create-client', 'App', 'andriod'], {})).rejects.toThrow('Unknown platform "andriod". Use one of: web, ios, android, partner, other.');
  });
});

describe('main', () => {
  it('prints the result and returns 0, or prints the error and returns 1', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) };
    expect(await main(['gen-key'], {}, io)).toBe(0);
    expect(Buffer.from(defined(out[0]), 'base64')).toHaveLength(32);
    expect(await main(['nope'], {}, io)).toBe(1);
    expect(err[0]).toContain('Usage:');
  });
});
