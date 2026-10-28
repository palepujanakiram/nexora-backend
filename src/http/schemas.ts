import { z } from 'zod';

import { BROKERS, PRODUCTS } from '../domain/account.ts';
import { badRequest } from '../domain/errors.ts';
import { DEFAULT_EXECUTION_SETTINGS, ENTRY_PRICE_MODES, EXIT_MODES } from '../domain/trade.ts';

const device = z.string().trim().max(100).default('unknown device');

export const RegisterBody = z.object({
  email: z.string().max(200),
  password: z.string().max(200),
  signupCode: z.string().max(200),
  device,
});

export const LoginBody = z.object({
  email: z.string().max(200),
  password: z.string().max(200),
  device,
});

export const SendOtpBody = z.object({
  mobile: z.string().max(30),
  /** Needed only when the number has no login yet. */
  signupCode: z.string().max(200).optional(),
});

export const VerifyOtpBody = z.object({
  mobile: z.string().max(30),
  otp: z.string().max(20),
  device,
});

export const ChangePasswordBody = z.object({
  currentPassword: z.string().max(200),
  newPassword: z.string().max(200),
  device,
});

const accountFields = {
  broker: z.enum(BROKERS),
  label: z.string().max(100),
  apiKey: z.string().max(500),
  apiSecret: z.string().max(500),
  redirectUri: z.string().max(500),
  enabled: z.boolean(),
  lots: z.number().int().min(1).max(10000),
  product: z.enum(PRODUCTS),
  paperMode: z.boolean(),
};

export const CreateAccountBody = z.object({
  ...accountFields,
  redirectUri: accountFields.redirectUri.default(''),
  enabled: accountFields.enabled.default(true),
  lots: accountFields.lots.default(1),
  product: accountFields.product.default('carryForward'),
  // New accounts start in paper mode, like in the app.
  paperMode: accountFields.paperMode.default(true),
});

export const UpdateAccountBody = z.object(accountFields).partial();

export const ConnectBody = z.object({
  /** Redirect URL or code (Zerodha/Upstox), TOTP or empty (Groww). */
  input: z.string().max(4000).default(''),
});

export const ParseBody = z.object({ text: z.string().max(2000) });

export const ExecuteBody = z.object({
  text: z.string().max(2000),
  accountIds: z.array(z.string().max(100)).min(1, 'Pick at least one account.').max(50),
  settings: z
    .object({
      entryPriceMode: z.enum(ENTRY_PRICE_MODES).default(DEFAULT_EXECUTION_SETTINGS.entryPriceMode),
      exitMode: z.enum(EXIT_MODES).default(DEFAULT_EXECUTION_SETTINGS.exitMode),
      targetIndex: z.number().int().min(0).max(9).default(DEFAULT_EXECUTION_SETTINGS.targetIndex),
    })
    .default(DEFAULT_EXECUTION_SETTINGS),
  allowDuplicate: z.boolean().default(false),
});

export const ActivityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Validates [value] against [schema], turning failures into a 400 with a readable message. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
  throw badRequest(`${where}${issue.message}`);
}
