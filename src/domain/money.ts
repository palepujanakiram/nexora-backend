import { badRequest } from './errors.ts';

/**
 * Prices are integer paise everywhere inside the server (₹420.05 = 42005).
 * Rupee amounts only exist at the edges: request/response JSON and broker APIs.
 */
export type Paise = number;

/** Rupees as a decimal string or number (`"420.05"`, `420.05`) to paise, exactly. */
export function toPaise(rupees: string | number): Paise {
  const text = typeof rupees === 'number' ? rupees.toFixed(4) : rupees.trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(text);
  if (!m) throw badRequest(`Not a price: ${String(rupees)}.`);
  const [, sign, whole, frac = ''] = m;
  const digits = (frac + '0000').slice(0, 4);
  if (digits.slice(2) !== '00') throw badRequest(`Prices can have at most 2 decimal places: ${String(rupees)}.`);
  const paise = Number(whole) * 100 + Number(digits.slice(0, 2));
  return sign ? -paise : paise;
}

/** Paise to a rupee string with two decimals (`42005` → `"420.05"`), for JSON and broker form bodies. */
export function rupees(paise: Paise): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Paise to a rupee number, for broker JSON bodies that want a number. Exact to 2 places. */
export const rupeeNumber = (paise: Paise): number => Number(rupees(paise));

/** A broker's rupee value (number or string, possibly with float noise) to paise. */
export function brokerRupeesToPaise(value: unknown): Paise | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export const isOnTick = (paise: Paise, tick: Paise) => paise % tick === 0;
