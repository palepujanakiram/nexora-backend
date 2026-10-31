import { badRequest } from './errors.ts';

/** The confirmations a new user ticks. Their wording comes from compliance; the server records which version they saw. */
export const CONSENT_KINDS = ['terms', 'risk', 'data_use'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

/** What someone fills in to sign themselves up, checked and in canonical form. */
export interface SignupDetails {
  fullName: string;
  /** Lower case. */
  email: string;
}

export interface SignupForm {
  fullName: string;
  email: string;
  consents: { terms: boolean; risk: boolean; dataUse: boolean };
}

/** Checks a sign-up form and puts each field in canonical form. Every consent must be ticked. */
export function checkSignup(form: SignupForm): SignupDetails {
  const { terms, risk, dataUse } = form.consents;
  if (!terms || !risk || !dataUse) throw badRequest('Please confirm each of the statements to create your account.');
  return { fullName: normalizeFullName(form.fullName), email: normalizeEmail(form.email) };
}

/** A name as typed, with spaces collapsed. Letters, spaces, dots, apostrophes and hyphens. */
export function normalizeFullName(input: string): string {
  const name = input.trim().replace(/\s+/g, ' ');
  if (!/^\p{L}[\p{L}\p{M} .'-]{1,99}$/u.test(name)) throw badRequest('Enter your full name.');
  return name;
}

export function normalizeEmail(input: string): string {
  const email = input.trim().toLowerCase();
  if (email.length > 200 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Enter a valid email address.');
  return email;
}
