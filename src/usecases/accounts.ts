import type { LoginMethod } from '../brokers/broker-api.ts';
import type { BrokerFactory } from '../brokers/index.ts';
import type { AccountRepository } from '../data/accounts.ts';
import { newId } from '../data/crypto.ts';
import {
  BROKER_LABELS,
  hasValidToken,
  maskKey,
  type BrokerAccount,
  type BrokerType,
  type ProductType,
} from '../domain/account.ts';
import { badRequest, notFound } from '../domain/errors.ts';

export interface AccountInput {
  broker: BrokerType;
  label: string;
  apiKey: string;
  apiSecret: string;
  redirectUri: string;
  enabled: boolean;
  lots: number;
  product: ProductType;
  paperMode: boolean;
}

/** What the app sees: never the secret or token, and only a masked key. */
export interface AccountView {
  id: string;
  broker: BrokerType;
  brokerLabel: string;
  label: string;
  apiKeyMasked: string;
  redirectUri: string;
  enabled: boolean;
  lots: number;
  product: ProductType;
  paperMode: boolean;
  loggedIn: boolean;
  tokenIssuedAt: string | null;
}

export interface AccountDeps {
  accounts: AccountRepository;
  brokers: BrokerFactory;
  clock: () => Date;
}

/** Managing a user's broker accounts and their daily broker login. */
export class AccountService {
  private readonly deps: AccountDeps;

  constructor(deps: AccountDeps) {
    this.deps = deps;
  }

  list(userId: string): AccountView[] {
    return this.deps.accounts.list(userId).map((a) => this.view(a));
  }

  get(userId: string, id: string): AccountView {
    return this.view(this.find(userId, id));
  }

  create(userId: string, input: AccountInput): AccountView {
    const account: BrokerAccount = {
      id: newId(),
      userId,
      ...clean(input),
      accessToken: null,
      tokenIssuedAt: null,
      createdAt: this.deps.clock(),
    };
    this.deps.accounts.save(account);
    return this.view(account);
  }

  /**
   * Applies [patch]. Empty `apiSecret` keeps the stored one. Changing the
   * broker, key, secret or redirect URI ends the broker session.
   */
  update(userId: string, id: string, patch: Partial<AccountInput>): AccountView {
    const current = this.find(userId, id);
    const merged = clean({
      broker: patch.broker ?? current.broker,
      label: patch.label ?? current.label,
      apiKey: patch.apiKey ?? current.apiKey,
      apiSecret: patch.apiSecret?.trim() ? patch.apiSecret : current.apiSecret,
      redirectUri: patch.redirectUri ?? current.redirectUri,
      enabled: patch.enabled ?? current.enabled,
      lots: patch.lots ?? current.lots,
      product: patch.product ?? current.product,
      paperMode: patch.paperMode ?? current.paperMode,
    });
    const credentialsChanged =
      merged.broker !== current.broker ||
      merged.apiKey !== current.apiKey ||
      merged.apiSecret !== current.apiSecret ||
      merged.redirectUri !== current.redirectUri;
    const account: BrokerAccount = {
      ...current,
      ...merged,
      accessToken: credentialsChanged ? null : current.accessToken,
      tokenIssuedAt: credentialsChanged ? null : current.tokenIssuedAt,
    };
    this.deps.accounts.save(account);
    return this.view(account);
  }

  delete(userId: string, id: string): void {
    if (!this.deps.accounts.delete(userId, id)) throw notFound('Account not found.');
  }

  /** How to log in to the broker for today. */
  login(userId: string, id: string): LoginMethod {
    return this.deps.brokers(this.find(userId, id)).login();
  }

  /** Exchanges the broker redirect (or code / TOTP) for today's access token. */
  async connect(userId: string, id: string, input: string): Promise<AccountView> {
    const account = this.find(userId, id);
    const accessToken = await this.deps.brokers(account).exchangeToken(input);
    const updated = { ...account, accessToken, tokenIssuedAt: this.deps.clock() };
    this.deps.accounts.save(updated);
    return this.view(updated);
  }

  /** Forgets the broker access token. */
  disconnect(userId: string, id: string): AccountView {
    const updated = { ...this.find(userId, id), accessToken: null, tokenIssuedAt: null };
    this.deps.accounts.save(updated);
    return this.view(updated);
  }

  private find(userId: string, id: string): BrokerAccount {
    const account = this.deps.accounts.find(userId, id);
    if (!account) throw notFound('Account not found.');
    return account;
  }

  private view(a: BrokerAccount): AccountView {
    return {
      id: a.id,
      broker: a.broker,
      brokerLabel: BROKER_LABELS[a.broker],
      label: a.label,
      apiKeyMasked: maskKey(a.apiKey),
      redirectUri: a.redirectUri,
      enabled: a.enabled,
      lots: a.lots,
      product: a.product,
      paperMode: a.paperMode,
      loggedIn: hasValidToken(a, this.deps.clock()),
      tokenIssuedAt: a.tokenIssuedAt?.toISOString() ?? null,
    };
  }
}

/** Trims text fields and checks the rules that depend on the broker. */
function clean(input: AccountInput): AccountInput {
  const out = {
    ...input,
    label: input.label.trim(),
    apiKey: input.apiKey.trim(),
    apiSecret: input.apiSecret.trim(),
    redirectUri: input.broker === 'upstox' ? input.redirectUri.trim() : '',
  };
  if (!out.label) throw badRequest('Give the account a name.');
  if (!out.apiKey) throw badRequest('Enter the API key.');
  if (!out.apiSecret) throw badRequest('Enter the API secret.');
  if (out.broker === 'upstox' && !/^https?:\/\/\S+$/.test(out.redirectUri)) {
    throw badRequest('Upstox needs the Redirect URI saved in your Upstox app, e.g. https://127.0.0.1/.');
  }
  if (!Number.isInteger(out.lots) || out.lots < 1) throw badRequest('Lots must be a whole number of at least 1.');
  return out;
}
