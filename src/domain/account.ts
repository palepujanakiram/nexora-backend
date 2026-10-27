import { lastIstTime } from './ist.ts';

export const BROKERS = ['zerodha', 'upstox', 'groww'] as const;
export type BrokerType = (typeof BROKERS)[number];

export const BROKER_LABELS: Record<BrokerType, string> = {
  zerodha: 'Zerodha (Kite Connect)',
  upstox: 'Upstox',
  groww: 'Groww',
};

/** Carry-forward (Kite/Groww NRML, Upstox D) or intraday (Kite/Groww MIS, Upstox I). */
export const PRODUCTS = ['carryForward', 'intraday'] as const;
export type ProductType = (typeof PRODUCTS)[number];

/** One set of broker API credentials, owned by one user. Secrets are decrypted. */
export interface BrokerAccount {
  id: string;
  userId: string;
  broker: BrokerType;
  label: string;
  apiKey: string;
  apiSecret: string;
  /** Upstox needs the exact redirect URI registered for the app. */
  redirectUri: string;
  accessToken: string | null;
  tokenIssuedAt: Date | null;
  /** Pre-selected when executing a signal. */
  enabled: boolean;
  /** Lots to trade per signal on this account. */
  lots: number;
  product: ProductType;
  /** Paper accounts never send orders to the broker. */
  paperMode: boolean;
  createdAt: Date;
}

/** Broker sessions expire daily: Kite and Groww at 06:00 IST, Upstox at 03:30 IST. */
export function hasValidToken(account: BrokerAccount, now: Date): boolean {
  if (!account.accessToken || !account.tokenIssuedAt) return false;
  const [h, m] = account.broker === 'upstox' ? [3, 30] : [6, 0];
  return account.tokenIssuedAt.getTime() > lastIstTime(now, h, m).getTime();
}

export function maskKey(key: string): string {
  return key.length <= 6 ? key : `${key.slice(0, 4)}••••${key.slice(-2)}`;
}
