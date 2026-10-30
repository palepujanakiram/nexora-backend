import type { BrokerAdapter, Credentials } from '../brokers/adapter.ts';
import type { BrokerAccountRecord } from '../data/broker-accounts.ts';
import type { SecretBox } from '../data/crypto.ts';
import { badRequest } from '../domain/errors.ts';

/** Pure rules for broker accounts: credentials from a form, the login state, and what clients see. */

const STATE_TTL_MS = 15 * 60_000;

/**
 * The broker's credential fields from what the user typed. Paper accounts may
 * leave them out ([required] false); they're needed before switching to live.
 */
export function credentialsFrom(adapter: BrokerAdapter, given: Record<string, string>, required: boolean): Credentials {
  const extra: Record<string, string> = {};
  for (const f of adapter.credentialFields) {
    const value = given[f.name]?.trim() ?? '';
    if (required && f.required && !value) throw badRequest(`${adapter.label} needs ${f.label}.`);
    if (f.name !== 'apiKey' && f.name !== 'apiSecret' && value) extra[f.name] = value;
  }
  return { apiKey: given['apiKey']?.trim() ?? '', apiSecret: given['apiSecret']?.trim() ?? '', extra };
}

/** Credentials back in the shape [credentialsFrom] reads. */
export const flatten = (c: Credentials): Record<string, string> => ({ apiKey: c.apiKey, apiSecret: c.apiSecret, ...c.extra });

/**
 * The `state` carried through a broker's login redirect: the account id and an
 * expiry, encrypted (and so authenticated) with the server's key.
 */
export function encodeState(box: SecretBox, accountId: string, now: Date): string {
  return Buffer.from(box.encrypt(JSON.stringify({ accountId, exp: now.getTime() + STATE_TTL_MS }))).toString('base64url');
}

/** The account id in a login [state]. Throws 400 when it's missing, forged or expired. */
export function decodeState(box: SecretBox, state: string | undefined, now: Date): string {
  if (!state) throw badRequest('The broker redirect carried no state.');
  let parsed: { accountId: string; exp: number };
  try {
    parsed = JSON.parse(box.decrypt(Buffer.from(state, 'base64url').toString('utf8')));
  } catch {
    throw badRequest('This login link is invalid. Start again from the app.');
  }
  if (parsed.exp < now.getTime()) throw badRequest('This login link has expired. Start again from the app.');
  return parsed.accountId;
}

export function maskKey(key: string): string {
  if (!key) return '';
  return key.length <= 6 ? '••••' : `${key.slice(0, 2)}••••${key.slice(-2)}`;
}

/** The session's health as clients see it: paper accounts are always ready; a "valid" token past its expiry is expired. */
function health(a: BrokerAccountRecord, now: Date): string {
  if (a.mode === 'paper') return 'valid';
  const expired = !a.tokenExpiresAt || a.tokenExpiresAt <= now;
  return a.tokenState === 'valid' && expired ? 'expired' : a.tokenState;
}

/** What clients see: never a secret or token, and only a masked API key. */
export function accountView(a: BrokerAccountRecord, apiKey: string, now: Date) {
  const paper = a.mode === 'paper';
  return {
    id: a.id,
    broker: a.broker,
    label: a.label,
    mode: a.mode,
    apiKeyMasked: maskKey(apiKey),
    token: {
      state: health(a, now),
      expiresAt: paper ? null : a.tokenExpiresAt?.toISOString() ?? null,
      lastAuthAt: a.lastAuthAt?.toISOString() ?? null,
      message: paper ? null : a.tokenMessage,
    },
    createdAt: a.createdAt.toISOString(),
  };
}
