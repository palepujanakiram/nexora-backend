import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/cli.ts';
import { loadConfig } from '../../src/config.ts';
import { realRuntime } from '../../src/container.ts';
import { closeOnSignals, start } from '../../src/server.ts';
import { TEST_KEY, clock, noNetwork } from '../helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexora-'));
  dirs.push(dir);
  return join(dir, 'n.db');
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({ ENCRYPTION_KEY: 'k' })).toEqual({
      PORT: 8080,
      HOST: '0.0.0.0',
      DATABASE_PATH: './data/nexora.db',
      ENCRYPTION_KEY: 'k',
      SIGNUP_CODE: null,
      OTP_PROVIDER: '',
      MSG91_AUTH_KEY: null,
      MSG91_TEMPLATE_ID: null,
      MSG91_OTP_LENGTH: 6,
      MSG91_OTP_EXPIRY_MINUTES: 5,
      LIVE_TRADING: false,
      CORS_ORIGINS: [],
      SESSION_DAYS: 30,
      DUPLICATE_WINDOW_MINUTES: 15,
      RATE_LIMIT_PER_MINUTE: 300,
      AUTH_RATE_LIMIT_PER_MINUTE: 10,
      LOG_LEVEL: 'info',
    });
  });

  it('parses flags, lists and numbers', () => {
    const config = loadConfig({
      ENCRYPTION_KEY: 'k',
      PORT: '3000',
      LIVE_TRADING: 'yes',
      SIGNUP_CODE: '  family  ',
      CORS_ORIGINS: 'https://a.com, ,https://b.com',
    });
    expect(config).toMatchObject({ PORT: 3000, LIVE_TRADING: true, SIGNUP_CODE: 'family', CORS_ORIGINS: ['https://a.com', 'https://b.com'] });
    expect(loadConfig({ ENCRYPTION_KEY: 'k', SIGNUP_CODE: '  ' }).SIGNUP_CODE).toBeNull();
  });

  it('explains what is wrong', () => {
    expect(() => loadConfig({})).toThrow('Invalid configuration: ENCRYPTION_KEY: ENCRYPTION_KEY is required');
    expect(() => loadConfig({ ENCRYPTION_KEY: 'k', LIVE_TRADING: 'maybe' })).toThrow('LIVE_TRADING');
  });

  it('needs the MSG91 key and template when OTP_PROVIDER=msg91', () => {
    const msg91 = { ENCRYPTION_KEY: 'k', OTP_PROVIDER: 'msg91', MSG91_TEMPLATE_ID: 'tpl' };
    expect(() => loadConfig(msg91)).toThrow(
      'OTP_PROVIDER: MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are required when OTP_PROVIDER=msg91',
    );
    expect(loadConfig({ ...msg91, MSG91_AUTH_KEY: 'fake-key', MSG91_OTP_LENGTH: '4' })).toMatchObject({
      OTP_PROVIDER: 'msg91',
      MSG91_OTP_LENGTH: 4,
    });
    expect(() => loadConfig({ ENCRYPTION_KEY: 'k', OTP_PROVIDER: 'supabase' })).toThrow('OTP_PROVIDER');
  });
});

describe('start', () => {
  it('listens on the configured port and closes cleanly', async () => {
    const env = { ENCRYPTION_KEY: TEST_KEY, DATABASE_PATH: tempDb(), PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent' };
    const app = await start(env, { fetch: noNetwork, clock, random: Math.random });
    const { port } = app.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(((await res.json()) as { status: string }).status).toBe('ok');
    await app.close();
  });

  it('closes the app when the process is asked to stop', async () => {
    const app = { close: vi.fn(async () => undefined) };
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    closeOnSignals(app as never, ['SIGUSR2']);
    process.emit('SIGUSR2', 'SIGUSR2');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(app.close).toHaveBeenCalled();
  });

  it('uses the real clock and fetch in production', () => {
    expect(realRuntime.clock()).toBeInstanceOf(Date);
    expect(typeof realRuntime.fetch).toBe('function');
    expect(realRuntime.random()).toBeLessThan(1);
  });
});

describe('runCli', () => {
  it('creates users and refuses duplicates', async () => {
    const env = { ENCRYPTION_KEY: TEST_KEY, DATABASE_PATH: tempDb(), NEXORA_PASSWORD: 'long enough pw' };
    expect(await runCli(['create-user', 'Me@Example.com'], env)).toMatch(/^Created user me@example.com \(/);
    await expect(runCli(['create-user', 'me@example.com'], env)).rejects.toThrow('already exists');
  });

  it('creates mobile users and refuses duplicates', async () => {
    const env = { ENCRYPTION_KEY: TEST_KEY, DATABASE_PATH: tempDb() };
    expect(await runCli(['create-phone-user', '98765 43210'], env)).toMatch(/^Created user \+919876543210 \(/);
    await expect(runCli(['create-phone-user', '+91-9876543210'], env)).rejects.toThrow('already exists');
    await expect(runCli(['create-phone-user', '12345'], env)).rejects.toThrow('Enter a 10-digit Indian mobile number.');
    await expect(runCli(['create-phone-user'], {})).rejects.toThrow('Usage:');
  });

  it('prints a fresh encryption key', async () => {
    expect(Buffer.from(await runCli(['gen-key'], {}), 'base64')).toHaveLength(32);
  });

  it('explains usage and missing input', async () => {
    await expect(runCli([], {})).rejects.toThrow('Usage:');
    await expect(runCli(['create-user'], {})).rejects.toThrow('Usage:');
    await expect(runCli(['create-user', 'a@b.c'], {})).rejects.toThrow('Set NEXORA_PASSWORD');
  });
});
