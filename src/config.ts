import { z } from 'zod';

const flag = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1' || v === 'yes');

const optionalText = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : null));

/** A PEM given either as-is (with real or `\n` newlines) or base64-encoded. */
const pem = z.string().transform((v) => {
  const text = v.includes('-----BEGIN') ? v : Buffer.from(v, 'base64').toString('utf8');
  return text.replace(/\\n/g, '\n');
});

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(0).max(65535).default(8080),
    HOST: z.string().default('0.0.0.0'),
    /** The server's public base URL, for broker redirects and checkout links. */
    PUBLIC_URL: z.url().default('http://localhost:8080'),

    /** `postgres://…`, or `pglite:<dir>` / `pglite:memory` for local development without a server. */
    DATABASE_URL: z.string({ error: 'DATABASE_URL is required (postgres://user:pass@host/db).' }).min(1),

    /** `1:<base64>,2:<base64>` (32-byte keys), or one key as ENCRYPTION_KEY. */
    ENCRYPTION_KEYS: optionalText,
    ENCRYPTION_KEY: optionalText,
    /** The key version new ciphertexts use. Defaults to the highest. */
    ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).optional(),

    /** Ed25519 private key (PEM, or base64 of the PEM) that signs access tokens. */
    JWT_PRIVATE_KEY: pem,
    JWT_KEY_ID: z.string().default('k1'),
    JWT_ISSUER: z.string().default('nexora-backend'),
    /** Earlier public keys still accepted while rotating: JSON `[{"kid":"k0","pem":"…"}]`. */
    JWT_PREVIOUS_PUBLIC_KEYS: z
      .string()
      .default('[]')
      .transform((v, ctx) => {
        try {
          return z.array(z.object({ kid: z.string(), pem: z.string() })).parse(JSON.parse(v));
        } catch {
          ctx.addIssue({ code: 'custom', message: 'must be a JSON array of {kid, pem}' });
          return z.NEVER;
        }
      }),

    /** Bearer token for /admin endpoints. Unset turns them off. */
    ADMIN_TOKEN: optionalText,

    /** `msg91` texts codes; `console` prints them (development only). */
    OTP_PROVIDER: z.enum(['msg91', 'console']).default('console'),
    MSG91_AUTH_KEY: optionalText,
    MSG91_TEMPLATE_ID: optionalText,
    OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
    OTP_TTL_MINUTES: z.coerce.number().int().min(1).max(30).default(5),

    // The version of the sign-up statements' wording (terms, risk, data use) recorded with each consent.
    CONSENT_VERSION: z.string().trim().min(1).max(40).default('draft'),

    /** Must be true for live accounts to send real orders. Off, every broker write is logged instead (dry run). */
    LIVE_TRADING: flag(false),
    BROKER_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8000),
    /** SEBI algo id stamped on orders, once the exchange issues one. */
    ALGO_ID: optionalText,

    RISK_ENFORCE_MARKET_HOURS: flag(true),
    RISK_MAX_NOTIONAL_RUPEES: z.coerce.number().positive().default(1_000_000),
    RISK_MAX_ORDERS_PER_DAY: z.coerce.number().int().min(1).default(500),

    /** Off: every user may trade (one operator's own accounts). On: trading needs a paid subscription. */
    BILLING_ENABLED: flag(false),
    RAZORPAY_KEY_ID: optionalText,
    RAZORPAY_KEY_SECRET: optionalText,
    RAZORPAY_WEBHOOK_SECRET: optionalText,
    GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(3),
    ENTITLEMENT_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(30),

    /** Run reconciliation, analytics and daily jobs in this process. */
    JOBS_ENABLED: flag(true),
    RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(300).default(5),

    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      ),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
    AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .refine((c) => (c.ENCRYPTION_KEYS ?? c.ENCRYPTION_KEY) !== null, {
    path: ['ENCRYPTION_KEYS'],
    message: 'ENCRYPTION_KEYS (or ENCRYPTION_KEY) is required (openssl rand -base64 32)',
  })
  .refine((c) => c.OTP_PROVIDER !== 'msg91' || (c.MSG91_AUTH_KEY && c.MSG91_TEMPLATE_ID), {
    path: ['OTP_PROVIDER'],
    message: 'MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are required when OTP_PROVIDER=msg91',
  })
  .refine((c) => !(c.NODE_ENV === 'production' && c.OTP_PROVIDER === 'console'), {
    path: ['OTP_PROVIDER'],
    message: 'console OTPs are for development only; use msg91 in production',
  })
  .refine((c) => !c.BILLING_ENABLED || (c.RAZORPAY_KEY_ID && c.RAZORPAY_KEY_SECRET && c.RAZORPAY_WEBHOOK_SECRET), {
    path: ['BILLING_ENABLED'],
    message: 'RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required when BILLING_ENABLED=true',
  });

export type Config = z.output<typeof ConfigSchema>;

/** Reads and checks the settings from environment variables. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}
