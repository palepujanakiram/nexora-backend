import type { BrokerAdapter, Credentials, LinkChallenge } from '../brokers/adapter.ts';
import type { AccountMode, BrokerAccountRecord, BrokerAccountRepository } from '../data/broker-accounts.ts';
import { newId, type SecretBox } from '../data/crypto.ts';
import { BrokerError } from '../domain/broker-error.ts';
import { AppError, badRequest, conflict, notFound } from '../domain/errors.ts';
import type { Log } from '../logging.ts';
import type { EntitlementService } from './entitlements.ts';
import type { BrokerGateway } from './gateway.ts';

export interface LinkAccountInput {
  broker: string;
  label: string;
  mode: AccountMode;
  /** The broker's credential fields by name (`apiKey`, `apiSecret`, plus broker extras). */
  credentials: Record<string, string>;
}

export interface BrokerAccountDeps {
  accounts: BrokerAccountRepository;
  gateway: BrokerGateway;
  entitlements: EntitlementService;
  box: SecretBox;
  clock: () => Date;
  log: Log;
  /** Where brokers redirect after login: `<PUBLIC_URL>/broker-callback/<broker>`. */
  callbackBase: string;
}

const STATE_TTL_MS = 15 * 60_000;

/** Linking, re-linking and unlinking broker accounts. Part of the broker gateway: it handles credentials. */
export class BrokerAccountService {
  private readonly d: BrokerAccountDeps;

  constructor(deps: BrokerAccountDeps) {
    this.d = deps;
  }

  /** Supported brokers and what each can do. */
  brokers() {
    return this.d.gateway.brokers().map((a) => ({
      code: a.code,
      label: a.label,
      capabilities: a.capabilities,
      credentialFields: a.credentialFields,
    }));
  }

  async list(userId: string) {
    return Promise.all((await this.d.accounts.listForUser(userId)).map((a) => this.view(a)));
  }

  async get(userId: string, id: string) {
    return this.view(await this.owned(userId, id));
  }

  /** Stores the account (encrypted) and starts the broker's login. */
  async link(userId: string, input: LinkAccountInput) {
    const adapter = this.d.gateway.brokerAdapter(input.broker);
    const label = input.label.trim();
    if (!label) throw badRequest('Give the account a name.');
    const credentials = this.credentialsFrom(adapter, input.credentials, input.mode === 'live');
    const entitlement = await this.d.entitlements.check(userId);
    const plan = entitlement.plan;
    if (plan) {
      if (!plan.brokers.includes(adapter.code)) throw new AppError(402, 'plan_limit', `Your plan doesn't include ${adapter.label}.`, { limit: 'brokers' });
      if ((await this.d.accounts.countForUser(userId)) >= plan.maxAccounts) {
        throw new AppError(402, 'plan_limit', `Your plan links at most ${plan.maxAccounts} accounts.`, { limit: 'max_accounts', max: plan.maxAccounts });
      }
    }
    const existing = await this.d.accounts.listForUser(userId);
    if (existing.some((a) => a.label.toLowerCase() === label.toLowerCase())) throw conflict('You already have an account with this name.');
    const account: BrokerAccountRecord = {
      id: newId('ba'),
      userId,
      broker: adapter.code,
      label,
      mode: input.mode,
      credentialsEnc: this.d.box.encrypt(JSON.stringify(credentials)),
      tokenEnc: null,
      tokenExpiresAt: null,
      tokenState: 'none',
      tokenMessage: null,
      lastAuthAt: null,
      createdAt: this.d.clock(),
    };
    await this.d.accounts.insert(account);
    this.d.log.info({ userId, accountId: account.id, broker: adapter.code, mode: account.mode, event: 'account_linked' }, 'broker account linked');
    return { account: await this.view(account), link: await this.challenge(account, adapter, credentials) };
  }

  /** The broker login to (re)do for today. */
  async relink(userId: string, id: string): Promise<LinkChallenge> {
    const account = await this.owned(userId, id);
    const adapter = this.d.gateway.brokerAdapter(account.broker);
    return this.challenge(account, adapter, this.d.gateway.credentials(account));
  }

  /** Finishes the login with the redirect parameters or what the user typed (TOTP, …). */
  async completeLink(userId: string, id: string, params: Record<string, string>) {
    const account = await this.owned(userId, id);
    return this.finish(account, params);
  }

  /** The broker redirected the browser to us. [state] says which account. */
  async callback(broker: string, params: Record<string, string>) {
    const state = params['state'];
    if (!state) throw badRequest('The broker redirect carried no state.');
    let parsed: { accountId: string; exp: number };
    try {
      parsed = JSON.parse(this.d.box.decrypt(Buffer.from(state, 'base64url').toString('utf8')));
    } catch {
      throw badRequest('This login link is invalid. Start again from the app.');
    }
    if (parsed.exp < this.d.clock().getTime()) throw badRequest('This login link has expired. Start again from the app.');
    const account = await this.d.accounts.find(parsed.accountId);
    if (!account || account.broker !== broker) throw notFound('Broker account not found.');
    return this.finish(account, params);
  }

  async update(userId: string, id: string, patch: { mode?: AccountMode | undefined }) {
    const account = await this.owned(userId, id);
    if (patch.mode && patch.mode !== account.mode) {
      if (patch.mode === 'live') this.credentialsFrom(this.d.gateway.brokerAdapter(account.broker), { ...flatten(this.d.gateway.credentials(account)) }, true);
      await this.d.accounts.setMode(id, patch.mode);
      this.d.log.info({ userId, accountId: id, mode: patch.mode, event: 'account_mode' }, 'broker account mode changed');
    }
    return this.view((await this.d.accounts.find(id))!);
  }

  /** Unlinks the account and deletes its stored credentials. Past orders stay in the audit trail. */
  async unlink(userId: string, id: string): Promise<void> {
    if (!(await this.d.accounts.delete(userId, id))) throw notFound('Broker account not found.');
    this.d.log.info({ userId, accountId: id, event: 'account_unlinked' }, 'broker account unlinked');
  }

  /** Renews sessions that have expired, where brokers allow it; flags the rest for re-linking. */
  async refreshSessions(): Promise<{ checked: number; needUser: number }> {
    const now = this.d.clock();
    let checked = 0;
    let needUser = 0;
    for (const a of await this.d.accounts.listAll()) {
      if (a.mode !== 'live' || a.tokenState === 'none' || a.tokenState === 'needs_user_action') continue;
      if (a.tokenExpiresAt && a.tokenExpiresAt > now) continue;
      checked++;
      if (!(await this.d.gateway.ensureSession(a))) needUser++;
    }
    return { checked, needUser };
  }

  /** Re-encrypts every credential still under an older key version. Returns how many accounts changed. */
  async reencrypt(): Promise<number> {
    let changed = 0;
    for (const a of await this.d.accounts.listAll()) {
      const stale = this.d.box.isStale(a.credentialsEnc) || (a.tokenEnc !== null && this.d.box.isStale(a.tokenEnc));
      if (!stale) continue;
      await this.d.accounts.saveCredentials(
        a.id,
        this.d.box.encrypt(this.d.box.decrypt(a.credentialsEnc)),
        a.tokenEnc === null ? null : this.d.box.encrypt(this.d.box.decrypt(a.tokenEnc)),
      );
      changed++;
    }
    return changed;
  }

  private async finish(account: BrokerAccountRecord, params: Record<string, string>) {
    if (account.mode === 'paper') return this.view(account);
    const adapter = this.d.gateway.brokerAdapter(account.broker);
    try {
      const tokens = await adapter.completeLink(this.d.gateway.context(account, adapter), { params });
      await this.d.gateway.saveToken(account.id, tokens);
    } catch (e) {
      if (e instanceof BrokerError) {
        await this.d.accounts.setTokenState(account.id, 'needs_user_action', e.message);
        throw new AppError(e.code === 'AUTH_EXPIRED' ? 401 : 502, 'broker_login_failed', e.message, { code: e.code });
      }
      throw e;
    }
    this.d.log.info({ accountId: account.id, broker: account.broker, event: 'broker_login' }, 'broker session started');
    return this.view((await this.d.accounts.find(account.id))!);
  }

  private async challenge(account: BrokerAccountRecord, adapter: BrokerAdapter, credentials: Credentials): Promise<LinkChallenge> {
    if (account.mode === 'paper') return { kind: 'input', fields: [], message: 'Paper accounts need no broker login.', url: null };
    const state = Buffer.from(
      this.d.box.encrypt(JSON.stringify({ accountId: account.id, exp: this.d.clock().getTime() + STATE_TTL_MS })),
    ).toString('base64url');
    return adapter.startLink({ credentials, state, callbackUrl: `${this.d.callbackBase}/${adapter.code}` });
  }

  /** Paper accounts may skip the broker's keys; they're needed before switching the account to live. */
  private credentialsFrom(adapter: BrokerAdapter, given: Record<string, string>, required: boolean): Credentials {
    const extra: Record<string, string> = {};
    for (const f of adapter.credentialFields) {
      const value = given[f.name]?.trim() ?? '';
      if (required && f.required && !value) throw badRequest(`${adapter.label} needs ${f.label}.`);
      if (f.name !== 'apiKey' && f.name !== 'apiSecret' && value) extra[f.name] = value;
    }
    return { apiKey: given['apiKey']?.trim() ?? '', apiSecret: given['apiSecret']?.trim() ?? '', extra };
  }

  private async owned(userId: string, id: string): Promise<BrokerAccountRecord> {
    const account = await this.d.accounts.findOwned(userId, id);
    if (!account) throw notFound('Broker account not found.');
    return account;
  }

  /** What clients see: never a secret or token, and only a masked API key. */
  private async view(a: BrokerAccountRecord) {
    const now = this.d.clock();
    const key = this.d.gateway.credentials(a).apiKey;
    let health: string = a.tokenState;
    if (a.mode === 'paper') health = 'valid';
    else if (a.tokenState === 'valid' && (!a.tokenExpiresAt || a.tokenExpiresAt <= now)) health = 'expired';
    return {
      id: a.id,
      broker: a.broker,
      label: a.label,
      mode: a.mode,
      apiKeyMasked: maskKey(key),
      token: {
        state: health,
        expiresAt: a.mode === 'paper' ? null : a.tokenExpiresAt?.toISOString() ?? null,
        lastAuthAt: a.lastAuthAt?.toISOString() ?? null,
        message: a.mode === 'paper' ? null : a.tokenMessage,
      },
      createdAt: a.createdAt.toISOString(),
    };
  }
}

const flatten = (c: Credentials): Record<string, string> => ({ apiKey: c.apiKey, apiSecret: c.apiSecret, ...c.extra });

export function maskKey(key: string): string {
  if (!key) return '';
  return key.length <= 6 ? '••••' : `${key.slice(0, 2)}••••${key.slice(-2)}`;
}
