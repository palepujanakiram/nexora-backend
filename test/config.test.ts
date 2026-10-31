import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.ts';
import { JWT_PRIVATE_KEY } from './app.ts';
import { TEST_KEY } from './helpers.ts';

const BASE = { DATABASE_URL: 'pglite:memory', ENCRYPTION_KEYS: `1:${TEST_KEY}`, JWT_PRIVATE_KEY };
const load = (env: Record<string, string | undefined> = {}) => loadConfig({ ...BASE, ...env });

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = load();
    expect(c).toMatchObject({
      NODE_ENV: 'development',
      PORT: 8080,
      HOST: '0.0.0.0',
      PUBLIC_URL: 'http://localhost:8080',
      ENCRYPTION_KEY: null,
      JWT_KEY_ID: 'k1',
      JWT_ISSUER: 'nexora-backend',
      JWT_PREVIOUS_PUBLIC_KEYS: [],
      ADMIN_TOKEN: null,
      OTP_PROVIDER: 'console',
      OTP_LENGTH: 6,
      OTP_TTL_MINUTES: 5,
      LIVE_TRADING: false,
      BROKER_TIMEOUT_MS: 8000,
      ALGO_ID: null,
      RISK_ENFORCE_MARKET_HOURS: true,
      RISK_MAX_NOTIONAL_RUPEES: 1_000_000,
      RISK_MAX_ORDERS_PER_DAY: 500,
      BILLING_ENABLED: false,
      GRACE_DAYS: 3,
      ENTITLEMENT_CACHE_SECONDS: 30,
      JOBS_ENABLED: true,
      RECONCILE_INTERVAL_SECONDS: 5,
      CORS_ORIGINS: [],
      RATE_LIMIT_PER_MINUTE: 300,
      AUTH_RATE_LIMIT_PER_MINUTE: 10,
      LOG_LEVEL: 'info',
    });
    expect(c.ENCRYPTION_KEY_VERSION).toBeUndefined();
    expect(c.JWT_PRIVATE_KEY).toBe(JWT_PRIVATE_KEY);
  });

  it('parses flags, numbers, lists and trims optional text', () => {
    const c = load({
      LIVE_TRADING: 'yes',
      JOBS_ENABLED: '0',
      RISK_ENFORCE_MARKET_HOURS: 'no',
      BILLING_ENABLED: '1',
      RAZORPAY_KEY_ID: ' rzp ',
      RAZORPAY_KEY_SECRET: 's',
      RAZORPAY_WEBHOOK_SECRET: 'w',
      PORT: '0',
      ENCRYPTION_KEY_VERSION: '1',
      CORS_ORIGINS: ' https://a.test , ,https://b.test',
      ADMIN_TOKEN: '   ',
      ALGO_ID: ' ALGO1 ',
    });
    expect(c).toMatchObject({
      LIVE_TRADING: true,
      JOBS_ENABLED: false,
      RISK_ENFORCE_MARKET_HOURS: false,
      BILLING_ENABLED: true,
      RAZORPAY_KEY_ID: 'rzp',
      PORT: 0,
      ENCRYPTION_KEY_VERSION: 1,
      CORS_ORIGINS: ['https://a.test', 'https://b.test'],
      ADMIN_TOKEN: null,
      ALGO_ID: 'ALGO1',
    });
    expect(load({ ENCRYPTION_KEYS: undefined, ENCRYPTION_KEY: TEST_KEY }).ENCRYPTION_KEY).toBe(TEST_KEY);
  });

  it('accepts the JWT key as base64 of the PEM or with literal \\n', () => {
    expect(load({ JWT_PRIVATE_KEY: Buffer.from(JWT_PRIVATE_KEY).toString('base64') }).JWT_PRIVATE_KEY).toBe(JWT_PRIVATE_KEY);
    expect(load({ JWT_PRIVATE_KEY: JWT_PRIVATE_KEY.replace(/\n/g, '\\n') }).JWT_PRIVATE_KEY).toBe(JWT_PRIVATE_KEY);
  });

  it('parses previous public keys', () => {
    const keys = [{ kid: 'k0', pem: '-----BEGIN PUBLIC KEY-----' }];
    expect(load({ JWT_PREVIOUS_PUBLIC_KEYS: JSON.stringify(keys) }).JWT_PREVIOUS_PUBLIC_KEYS).toEqual(keys);
    expect(() => load({ JWT_PREVIOUS_PUBLIC_KEYS: 'not json' })).toThrow('JWT_PREVIOUS_PUBLIC_KEYS: must be a JSON array of {kid, pem}');
    expect(() => load({ JWT_PREVIOUS_PUBLIC_KEYS: '[{"kid":1}]' })).toThrow('JWT_PREVIOUS_PUBLIC_KEYS: must be a JSON array of {kid, pem}');
  });

  it('names every problem', () => {
    expect(() => loadConfig({ ENCRYPTION_KEYS: `1:${TEST_KEY}`, JWT_PRIVATE_KEY })).toThrow(
      'Invalid configuration: DATABASE_URL: DATABASE_URL is required (postgres://user:pass@host/db).',
    );
    expect(() => load({ ENCRYPTION_KEYS: ' ' })).toThrow('ENCRYPTION_KEYS: ENCRYPTION_KEYS (or ENCRYPTION_KEY) is required (openssl rand -base64 32)');
    expect(() => load({ OTP_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k' })).toThrow(
      'OTP_PROVIDER: MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are required when OTP_PROVIDER=msg91',
    );
    expect(() => load({ NODE_ENV: 'production' })).toThrow('OTP_PROVIDER: console OTPs are for development only; use msg91 in production');
    expect(() => load({ BILLING_ENABLED: 'true', RAZORPAY_KEY_ID: 'k' })).toThrow(
      'BILLING_ENABLED: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required when BILLING_ENABLED=true',
    );
    expect(() => load({ PORT: '70000', LIVE_TRADING: 'maybe' })).toThrow(/PORT: .*; LIVE_TRADING: /);
    expect(() => load({ PUBLIC_URL: 'not a url' })).toThrow('PUBLIC_URL');
  });

  it('accepts a production msg91 setup', () => {
    const c = load({ NODE_ENV: 'production', OTP_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 't' });
    expect(c).toMatchObject({ NODE_ENV: 'production', OTP_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 't' });
    expect(load({}).CONSENT_VERSION).toBe('draft');
  });
});
