import { z } from 'zod';

import { CLIENT_PLATFORMS, GRANT_TYPES } from '../data/identity.ts';
import { AppError, badRequest } from '../domain/errors.ts';
import { must } from '../domain/invariant.ts';
import { toPaise } from '../domain/money.ts';
import { ORDER_TYPES, PRODUCTS, SIDES } from '../domain/order.ts';

/** A rupee amount (`"420.05"` or `420.05`) as exact integer paise. */
const price = z.union([z.string().max(20), z.number()]).transform((v, ctx) => {
  try {
    return toPaise(v);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: e instanceof AppError ? e.message : 'Not a price.' });
    return z.NEVER;
  }
});
const positivePrice = price.refine((p) => p > 0, 'must be more than 0');
const optionalPrice = positivePrice.nullable().optional();

const id = z.string().min(1).max(100);
const device = z.string().trim().max(100).default('unknown device');
const phone = z.string().min(1).max(30);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

export const OtpRequestBody = z.object({ phone });
export const OtpVerifyBody = z.object({ phone, code: z.string().max(10), clientId: id, device });
const signupForm = {
  phone,
  fullName: z.string().max(200),
  email: z.string().max(200),
  consents: z.object({ terms: z.boolean(), risk: z.boolean(), dataUse: z.boolean() }),
};
export const SignupRequestBody = z.object(signupForm);
export const SignupVerifyBody = z.object({ ...signupForm, code: z.string().max(10), clientId: id, device });
export const RefreshBody = z.object({ refreshToken: z.string().min(1).max(200), clientId: id });

export const RegisterUserBody = z.object({ phone, email: z.string().max(200).nullable().optional() });
export const RegisterClientBody = z.object({
  name: z.string().min(1).max(100),
  platform: z.enum(CLIENT_PLATFORMS),
  grantTypes: z.array(z.enum(GRANT_TYPES)).min(1).default(['otp', 'refresh_token']),
  accessTtlSeconds: z.number().int().min(60).max(3600).default(900),
  refreshTtlSeconds: z.number().int().min(300).max(31_536_000).default(30 * 86_400),
});
export const KillSwitchBody = z.object({ on: z.boolean(), reason: z.string().max(200).nullable().default(null) });
export const HolidayBody = z.object({ day: isoDate, name: z.string().min(1).max(100) });
export const PlanBody = z.object({
  code: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  name: z.string().min(1).max(100),
  price: price.refine((p) => p >= 0, 'must not be negative'),
  interval: z.enum(['monthly', 'yearly']),
  maxAccounts: z.number().int().min(1),
  maxOrdersPerDay: z.number().int().min(1),
  maxFanout: z.number().int().min(1),
  brokers: z.array(z.string().max(40)).min(1),
  razorpayPlanId: z.string().max(100).nullable().default(null),
  active: z.boolean().default(true),
});
export const RefreshInstrumentsBody = z.object({ brokers: z.array(z.string().max(40)).optional() });

export const LinkAccountBody = z.object({
  broker: z.string().min(1).max(40),
  label: z.string().min(1).max(100),
  // New accounts start in paper mode.
  mode: z.enum(['paper', 'live']).default('paper'),
  credentials: z.record(z.string().max(60), z.string().max(2000)).default({}),
});
export const UpdateAccountBody = z.object({ mode: z.enum(['paper', 'live']).optional() });
export const CompleteLinkBody = z.object({ params: z.record(z.string().max(60), z.string().max(4000)).default({}) });

export const PlaceOrderBody = z.object({
  instrumentId: z.string().min(1).max(100),
  side: z.enum(SIDES),
  quantity: z.number().int().positive().max(1_000_000),
  orderType: z.enum(ORDER_TYPES),
  product: z.enum(PRODUCTS),
  price: optionalPrice,
  triggerPrice: optionalPrice,
  referencePrice: optionalPrice,
  accountIds: z.array(id).min(1, 'Pick at least one account.').max(100),
});
const accountSubset = z.array(id).min(1).max(100).optional();
export const ModifyOrderBody = z.object({
  accountIds: accountSubset,
  quantity: z.number().int().positive().max(1_000_000).optional(),
  price: optionalPrice,
  triggerPrice: optionalPrice,
  orderType: z.enum(ORDER_TYPES).optional(),
});
export const SubsetBody = z.object({ accountIds: accountSubset });
export const ListOrdersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime().optional(),
});

export const InstrumentQuery = z.object({
  underlying: z.string().max(40).optional(),
  type: z.enum(['EQ', 'FUT', 'CE', 'PE']).optional(),
  expiry: isoDate.optional(),
  exchange: z.string().max(10).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export const ParseSignalBody = z.object({ text: z.string().max(2000) });
export const CheckoutBody = z.object({ planCode: z.string().min(1).max(40) });
export const AnalyticsQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  groupBy: z.enum(['broker', 'instrument']).default('broker'),
});

/** Validates [value] against [schema], turning failures into a 400 with a readable message. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const issue = must(result.error.issues[0], 'a validation issue on a failed parse');
  const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
  throw badRequest(`${where}${issue.message}`);
}
