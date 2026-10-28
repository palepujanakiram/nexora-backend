import { badRequest } from './errors.ts';

/**
 * Turns an Indian mobile number as typed (`98765 43210`, `+91-98765-43210`,
 * `098765 43210`) into `91XXXXXXXXXX`, the E.164 digits without the plus that
 * MSG91 expects.
 */
export function normalizeIndianMobile(input: string): string {
  const digits = input.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) throw badRequest('Enter a 10-digit Indian mobile number.');
  let local = digits;
  if (local.length === 12 && local.startsWith('91')) local = local.slice(2);
  else if (local.length === 11 && local.startsWith('0')) local = local.slice(1);
  if (!/^[6-9]\d{9}$/.test(local)) throw badRequest('Enter a 10-digit Indian mobile number.');
  return `91${local}`;
}

/** `+91XXXXXXXXXX`, for showing a normalized number back to the user. */
export const e164 = (mobile: string) => `+${mobile}`;

/**
 * The number from a request body that sends either `{ phone }` or
 * `{ countryCode, mobile }` (the two shapes ManageMyFloor's app sends).
 * Only India (+91) is supported.
 */
export function resolveIndianMobile(input: { phone?: string | undefined; countryCode?: string | undefined; mobile?: string | undefined }): string {
  if (input.countryCode?.trim() && input.mobile?.trim()) {
    if (input.countryCode.replace(/[\s+]/g, '') !== '91') throw badRequest('Only Indian (+91) mobile numbers are supported.');
    return normalizeIndianMobile(input.mobile);
  }
  return normalizeIndianMobile(input.phone ?? '');
}
