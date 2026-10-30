import {
  needsUserAction,
  type AccountContext,
  type BrokerAck,
  type BrokerAdapter,
  type BrokerInstrument,
  type BrokerOrder,
  type BrokerPosition,
  type Credentials,
  type ModifyRequest,
  type NeedsUserAction,
  type PlaceRequest,
  type TokenSet,
} from '../brokers/adapter.ts';
import { BrokerHttp, type Fetch } from '../brokers/http.ts';
import type { PaperBroker } from '../brokers/paper.ts';
import type { BrokerRegistry } from '../brokers/registry.ts';
import type { BrokerAccountRecord, BrokerAccountRepository } from '../data/broker-accounts.ts';
import type { SecretBox } from '../data/crypto.ts';
import { BrokerError } from '../domain/broker-error.ts';
import { notFound } from '../domain/errors.ts';
import type { Log } from '../logging.ts';
import type { EventBus } from './events.ts';
import { must } from '../domain/invariant.ts';

/**
 * A token bucket per broker account (not per process): a fan-out to five
 * accounts on one broker can't burst past what that broker allows one account.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;

  constructor(deps: { now: () => number; sleep: (ms: number) => Promise<void>; maxWaitMs: number }) {
    this.now = deps.now;
    this.sleep = deps.sleep;
    this.maxWaitMs = deps.maxWaitMs;
  }

  /** Takes one token for [key], waiting for one if needed. Throws RATE_LIMITED rather than wait too long. */
  async acquire(key: string, perSecond: number): Promise<void> {
    const now = this.now();
    const b = this.buckets.get(key) ?? { tokens: perSecond, at: now };
    b.tokens = Math.min(perSecond, b.tokens + ((now - b.at) / 1000) * perSecond);
    b.at = now;
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (b.tokens >= 0) return;
    const waitMs = Math.ceil((-b.tokens / perSecond) * 1000);
    if (waitMs > this.maxWaitMs) {
      b.tokens += 1;
      throw new BrokerError('RATE_LIMITED', 'Too many requests to this broker account. Try again in a moment.');
    }
    await this.sleep(waitMs);
  }
}

export interface GatewayDeps {
  accounts: BrokerAccountRepository;
  registry: BrokerRegistry;
  paper: PaperBroker;
  box: SecretBox;
  fetch: Fetch;
  clock: () => Date;
  log: Log;
  limiter: RateLimiter;
  events: EventBus;
  /** Without it, live accounts run in dry-run mode: every broker write is logged, not sent. */
  liveTrading: boolean;
  timeoutMs: number;
}

/**
 * The broker gateway: the only module that decrypts broker credentials and
 * the only one that calls brokers, so it's the piece that must run on the
 * whitelisted static IP. Everything it takes and returns is plain data, so it
 * can move into its own service behind an internal API without the order
 * module changing.
 */
export class BrokerGateway {
  private readonly d: GatewayDeps;

  constructor(deps: GatewayDeps) {
    this.d = deps;
  }

  /** The adapter that serves [account]: the paper broker for paper accounts. */
  adapterFor(account: Pick<BrokerAccountRecord, 'broker' | 'mode'>): BrokerAdapter {
    return account.mode === 'paper' ? this.d.paper : this.d.registry.get(account.broker);
  }

  /** Every supported broker's adapter. */
  brokers(): BrokerAdapter[] {
    return this.d.registry.list();
  }

  /** The real broker's adapter, whatever the account's mode. */
  brokerAdapter(broker: string): BrokerAdapter {
    return this.d.registry.get(broker);
  }

  get dryRun(): boolean {
    return !this.d.liveTrading;
  }

  credentials(account: BrokerAccountRecord): Credentials {
    return JSON.parse(this.d.box.decrypt(account.credentialsEnc)) as Credentials;
  }

  /** An adapter context for [account]. Credentials are decrypted here and live only as long as the call. */
  context(account: BrokerAccountRecord, adapter: BrokerAdapter = this.adapterFor(account)): AccountContext {
    const token = account.tokenEnc ? (JSON.parse(this.d.box.decrypt(account.tokenEnc)) as Omit<TokenSet, 'expiresAt'>) : null;
    return {
      accountId: account.id,
      credentials: this.credentials(account),
      token: token && account.tokenExpiresAt ? { ...token, expiresAt: account.tokenExpiresAt } : null,
      http: new BrokerHttp({
        broker: adapter.code,
        fetch: this.d.fetch,
        timeoutMs: this.d.timeoutMs,
        dryRun: this.dryRun,
        log: this.d.log.child({ accountId: account.id, broker: adapter.code }),
        acquire: async () => this.d.limiter.acquire(account.id, adapter.capabilities.ratePerSecond),
      }),
    };
  }

  async saveToken(accountId: string, tokens: TokenSet): Promise<void> {
    const { expiresAt, ...secret } = tokens;
    await this.d.accounts.saveToken(accountId, {
      tokenEnc: this.d.box.encrypt(JSON.stringify(secret)),
      expiresAt,
      state: 'valid',
      message: null,
      authAt: this.d.clock(),
    });
  }

  /** Marks the account as needing the user to log in again, and tells their devices. */
  async needsRelink(account: BrokerAccountRecord, reason: string): Promise<void> {
    await this.d.accounts.setTokenState(account.id, 'needs_user_action', reason);
    this.d.events.publish(account.userId, { type: 'relink_needed', accountId: account.id, broker: account.broker, message: reason });
    this.d.log.warn({ accountId: account.id, broker: account.broker, reason }, 'broker account needs re-linking');
  }

  /**
   * Renews the session if it has expired and the broker allows it without
   * the user. Returns true when the account has a usable session.
   */
  async ensureSession(account: BrokerAccountRecord): Promise<boolean> {
    if (account.mode === 'paper' || hasLiveSession(account, this.d.clock())) return true;
    const adapter = this.adapterFor(account);
    if (!account.tokenEnc || !adapter.capabilities.headlessRefresh) {
      await this.needsRelink(account, `${adapter.label}: log in again to trade on this account.`);
      return false;
    }
    return this.refreshHeadless(account, adapter);
  }

  /** Renews a session without the user (Angel One). False when the broker wants the user, or the refresh failed. */
  private async refreshHeadless(account: BrokerAccountRecord, adapter: BrokerAdapter): Promise<boolean> {
    let result: TokenSet | NeedsUserAction;
    try {
      result = await adapter.refreshSession(this.context(account, adapter));
    } catch (e) {
      this.d.log.warn({ accountId: account.id, broker: account.broker, code: (e as BrokerError).code }, 'session refresh failed');
      await this.d.accounts.setTokenState(account.id, 'expired', 'Session refresh failed; it will be retried.');
      return false;
    }
    if (needsUserAction(result)) {
      await this.needsRelink(account, result.reason);
      return false;
    }
    await this.saveToken(account.id, result);
    return true;
  }

  async place(accountId: string, req: PlaceRequest): Promise<BrokerAck> {
    return this.withAccount(accountId, async (a, ctx) => a.placeOrder(ctx, req));
  }

  async modify(accountId: string, req: ModifyRequest): Promise<BrokerAck> {
    return this.withAccount(accountId, async (a, ctx) => a.modifyOrder(ctx, req));
  }

  async cancel(accountId: string, brokerOrderId: string): Promise<BrokerAck> {
    return this.withAccount(accountId, async (a, ctx) => a.cancelOrder(ctx, brokerOrderId));
  }

  async getOrder(accountId: string, brokerOrderId: string): Promise<BrokerOrder> {
    return this.withAccount(accountId, async (a, ctx) => a.getOrder(ctx, brokerOrderId));
  }

  async listOrders(accountId: string): Promise<BrokerOrder[]> {
    return this.withAccount(accountId, async (a, ctx) => a.listOrders(ctx));
  }

  async positions(accountId: string): Promise<BrokerPosition[]> {
    return this.withAccount(accountId, async (a, ctx) => a.getPositions(ctx));
  }

  /** Whether [req] is allowed on [current] by the account's broker. */
  async modifyProblem(accountId: string, current: BrokerOrder, req: ModifyRequest): Promise<string | null> {
    return this.adapterFor(await this.account(accountId)).modifyProblem(current, req);
  }

  /** Downloads [broker]'s instrument master, using a logged-in account when the broker requires one. */
  async instrumentMaster(broker: string): Promise<BrokerInstrument[]> {
    const adapter = this.d.registry.get(broker);
    const now = this.d.clock();
    const accounts = (await this.d.accounts.listAll()).filter(
      (a) => a.broker === broker && a.mode === 'live' && hasLiveSession(a, now),
    );
    if (adapter.instrumentsNeedSession && accounts.length === 0) {
      throw new BrokerError('AUTH_EXPIRED', `${adapter.label} needs a logged-in account to download instruments.`);
    }
    const ctx: AccountContext = accounts[0]
      ? this.context(accounts[0], adapter)
      : {
          accountId: 'instruments',
          credentials: { apiKey: '', apiSecret: '', extra: {} },
          token: null,
          http: new BrokerHttp({ broker, fetch: this.d.fetch, timeoutMs: 120_000, dryRun: this.dryRun, log: this.d.log }),
        };
    return adapter.fetchInstrumentMaster(ctx);
  }

  private async account(id: string): Promise<BrokerAccountRecord> {
    const account = await this.d.accounts.find(id);
    if (!account) throw notFound('Broker account not found.');
    return account;
  }

  private async withAccount<T>(accountId: string, fn: (adapter: BrokerAdapter, ctx: AccountContext) => Promise<T>): Promise<T> {
    let account = await this.account(accountId);
    if (!(await this.ensureSession(account))) {
      throw new BrokerError('AUTH_EXPIRED', 'The broker session has expired. Log in to this account again.');
    }
    account = must(await this.d.accounts.find(accountId), `account ${accountId}`);
    const adapter = this.adapterFor(account);
    try {
      return await fn(adapter, this.context(account, adapter));
    } catch (e) {
      if (e instanceof BrokerError && e.code === 'AUTH_EXPIRED' && account.mode === 'live') {
        await this.needsRelink(account, `${adapter.label} rejected the session. Log in again.`);
      }
      throw e;
    }
  }
}

/** Whether [account] holds a session that hasn't expired at [now]. */
function hasLiveSession(account: BrokerAccountRecord, now: Date): boolean {
  return account.tokenEnc !== null && account.tokenExpiresAt !== null && account.tokenExpiresAt > now;
}
