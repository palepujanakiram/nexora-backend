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

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_PATH: z.string().default('./data/nexora.db'),
  /** 32 random bytes, base64. Encrypts broker secrets and tokens at rest. */
  ENCRYPTION_KEY: z.string({ error: 'ENCRYPTION_KEY is required (openssl rand -base64 32).' }).min(1),
  /** Invite code for /v1/auth/register. Unset closes registration. */
  SIGNUP_CODE: optionalText,
  /** `msg91` turns on mobile + OTP sign-in. Also on when both MSG91 settings are given. */
  OTP_PROVIDER: z.enum(['', 'msg91']).default(''),
  /** MSG91 auth key. Secret: sent only to MSG91. */
  MSG91_AUTH_KEY: optionalText,
  /** MSG91 OTP template id (DLT-approved, with the ##OTP## placeholder). */
  MSG91_TEMPLATE_ID: optionalText,
  MSG91_OTP_LENGTH: z.coerce.number().int().min(4).max(9).default(6),
  /** How long an SMS code stays valid. */
  MSG91_OTP_EXPIRY_MINUTES: z.coerce.number().int().min(1).max(30).default(5),
  /** Must be true for live (non-paper) accounts to send real orders. */
  LIVE_TRADING: flag(false),
  /** Web origins allowed to call the API, comma-separated. Mobile apps don't need this. */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  DUPLICATE_WINDOW_MINUTES: z.coerce.number().min(0).max(24 * 60).default(15),
  /** Requests per minute per client IP across the API. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  /** Sign-in and sign-up attempts per minute per client IP. */
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
}).refine((c) => c.OTP_PROVIDER !== 'msg91' || (c.MSG91_AUTH_KEY && c.MSG91_TEMPLATE_ID), {
  path: ['OTP_PROVIDER'],
  message: 'MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are required when OTP_PROVIDER=msg91',
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
