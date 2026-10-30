import type pino from 'pino';

import type { Fetch } from './brokers/http.ts';
import { ConsoleOtp, Msg91Sms, type OtpChannel } from './brokers/msg91.ts';
import { PaperBroker } from './brokers/paper.ts';
import { RazorpayClient } from './brokers/razorpay.ts';
import { BrokerRegistry } from './brokers/registry.ts';
import type { Config } from './config.ts';
import { AnalyticsRepository } from './data/analytics.ts';
import { BillingRepository, type Plan } from './data/billing.ts';
import { BrokerAccountRepository } from './data/broker-accounts.ts';
import { SecretBox } from './data/crypto.ts';
import { openDb, openPglite, type Db } from './data/db.ts';
import { IdentityRepository } from './data/identity.ts';
import { InstrumentRepository } from './data/instruments.ts';
import { OrderRepository } from './data/orders.ts';
import { PositionRepository } from './data/positions.ts';
import { SettingsRepository } from './data/settings.ts';
import { must } from './domain/invariant.ts';
import { toPaise } from './domain/money.ts';
import { SignalParser } from './domain/signal-parser.ts';
import { createLogger } from './logging.ts';
import { AnalyticsService } from './usecases/analytics.ts';
import { BillingService } from './usecases/billing.ts';
import { BrokerAccountService } from './usecases/broker-accounts.ts';
import { EntitlementService } from './usecases/entitlements.ts';
import { EventBus } from './usecases/events.ts';
import { BrokerGateway, RateLimiter } from './usecases/gateway.ts';
import { DEFAULT_OTP_POLICY, IdentityService } from './usecases/identity.ts';
import { InstrumentService } from './usecases/instruments.ts';
import { Scheduler } from './usecases/jobs.ts';
import { LegTracker } from './usecases/legs.ts';
import { OrderService } from './usecases/orders.ts';
import { PositionService } from './usecases/positions.ts';
import { Reconciler } from './usecases/reconcile.ts';
import { RiskService } from './usecases/risk.ts';
import { TokenSigner } from './usecases/tokens.ts';

export const VERSION = '2.0.0';

/** The outside world. Tests replace these; production uses the real ones. */
export interface Runtime {
  fetch: Fetch;
  clock: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Where development-only console OTPs are printed. */
  print: (line: string) => void;
}

export const realRuntime: Runtime = {
  fetch: async (input, init) => fetch(input, init),
  clock: () => new Date(),
  sleep: async (ms) => new Promise((r) => setTimeout(r, ms)),
  print: (line) => { console.log(line); },
};

export type Services = Awaited<ReturnType<typeof createServices>>;

/** Opens the database named by `DATABASE_URL`: Postgres, or PGlite for `pglite:memory` / `pglite:<dir>`. */
export async function openDatabase(url: string): Promise<Db> {
  if (url === 'pglite:memory') return openPglite();
  if (url.startsWith('pglite:')) return openPglite(url.slice('pglite:'.length));
  return openDb(url);
}

/** Wires every service from [config]. The one place dependencies are built. */
export async function createServices(config: Config, runtime: Runtime = realRuntime, opts: { db?: Db; logger?: pino.Logger } = {}) {
  const logger = opts.logger ?? createLogger(config.LOG_LEVEL);
  const log = logger;
  const db = opts.db ?? (await openDatabase(config.DATABASE_URL));
  const { clock } = runtime;
  const keys = must(config.ENCRYPTION_KEYS ?? config.ENCRYPTION_KEY, 'an encryption key (config validation requires one)');
  const box = SecretBox.fromConfig(keys, config.ENCRYPTION_KEY_VERSION ?? null);
  const events = new EventBus();

  const identityRepo = new IdentityRepository(db);
  const accountsRepo = new BrokerAccountRepository(db);
  const instrumentsRepo = new InstrumentRepository(db);
  const ordersRepo = new OrderRepository(db);
  const positionsRepo = new PositionRepository(db);
  const billingRepo = new BillingRepository(db);
  const settings = new SettingsRepository(db);
  const analyticsRepo = new AnalyticsRepository(db);
  const registry = BrokerRegistry.standard({ clock });

  const signer = new TokenSigner({
    privateKeyPem: config.JWT_PRIVATE_KEY,
    kid: config.JWT_KEY_ID,
    issuer: config.JWT_ISSUER,
    previous: config.JWT_PREVIOUS_PUBLIC_KEYS,
    clock,
  });
  const channels: OtpChannel[] =
    config.OTP_PROVIDER === 'msg91'
      ? [
          new Msg91Sms({
            fetch: runtime.fetch,
            authKey: must(config.MSG91_AUTH_KEY, 'MSG91_AUTH_KEY (config validation requires it)'),
            templateId: must(config.MSG91_TEMPLATE_ID, 'MSG91_TEMPLATE_ID (config validation requires it)'),
          }),
        ]
      : [new ConsoleOtp(runtime.print)];
  const identity = new IdentityService({
    repo: identityRepo,
    signer,
    channels,
    clock,
    log,
    policy: { ...DEFAULT_OTP_POLICY, length: config.OTP_LENGTH, ttlMinutes: config.OTP_TTL_MINUTES },
  });

  const gateway = new BrokerGateway({
    accounts: accountsRepo,
    registry,
    paper: new PaperBroker({ db, clock }),
    box,
    fetch: runtime.fetch,
    clock,
    log,
    limiter: new RateLimiter({ now: () => clock().getTime(), sleep: runtime.sleep, maxWaitMs: 3000 }),
    events,
    liveTrading: config.LIVE_TRADING,
    timeoutMs: config.BROKER_TIMEOUT_MS,
  });

  const unlimited: Plan = {
    code: 'unlimited',
    name: 'Unlimited (billing off)',
    pricePaise: 0,
    interval: 'monthly',
    maxAccounts: 100,
    maxOrdersPerDay: config.RISK_MAX_ORDERS_PER_DAY,
    maxFanout: 100,
    brokers: registry.list().map((b) => b.code),
    razorpayPlanId: null,
    active: true,
  };
  const entitlements = new EntitlementService({
    billing: billingRepo,
    clock,
    billingEnabled: config.BILLING_ENABLED,
    graceDays: config.GRACE_DAYS,
    cacheMs: config.ENTITLEMENT_CACHE_SECONDS * 1000,
    unlimited,
    upgradeUrl: `${config.PUBLIC_URL}/plans`,
  });
  const risk = new RiskService({
    settings,
    orders: ordersRepo,
    clock,
    enforceMarketHours: config.RISK_ENFORCE_MARKET_HOURS,
    maxNotionalPaise: toPaise(config.RISK_MAX_NOTIONAL_RUPEES),
    maxOrdersPerDay: config.RISK_MAX_ORDERS_PER_DAY,
  });
  const legs = new LegTracker({
    orders: ordersRepo,
    gateway,
    events,
    clock,
    log,
    baseDelayMs: 2000,
    maxDelayMs: 5 * 60_000,
    maxUnknownAttempts: 6,
  });
  const orders = new OrderService({
    db,
    orders: ordersRepo,
    instruments: instrumentsRepo,
    accounts: accountsRepo,
    gateway,
    legs,
    entitlements,
    risk,
    clock,
    log,
    algoId: config.ALGO_ID,
    lockWaitMs: 15_000,
  });
  const reconciler = new Reconciler({ db, orders: ordersRepo, accounts: accountsRepo, gateway, legs, clock, log });
  const brokerAccounts = new BrokerAccountService({
    accounts: accountsRepo,
    gateway,
    entitlements,
    box,
    clock,
    log,
    callbackBase: `${config.PUBLIC_URL}/broker-callback`,
  });
  const instruments = new InstrumentService({ instruments: instrumentsRepo, gateway, clock, log });
  const positions = new PositionService({ accounts: accountsRepo, gateway, positions: positionsRepo, instruments: instrumentsRepo, analytics: analyticsRepo, clock });
  const analytics = new AnalyticsService({ analytics: analyticsRepo, clock, log });
  const billing = new BillingService({
    billing: billingRepo,
    entitlements,
    events,
    razorpay:
      config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET && config.RAZORPAY_WEBHOOK_SECRET
        ? new RazorpayClient({ fetch: runtime.fetch, keyId: config.RAZORPAY_KEY_ID, keySecret: config.RAZORPAY_KEY_SECRET, webhookSecret: config.RAZORPAY_WEBHOOK_SECRET })
        : null,
    clock,
    log,
    graceDays: config.GRACE_DAYS,
  });
  const scheduler = new Scheduler({
    db,
    settings,
    clock,
    log,
    jobs: [
      { name: 'reconcile', everyMs: config.RECONCILE_INTERVAL_SECONDS * 1000, run: async () => reconciler.pollDue() },
      { name: 'analytics', everyMs: 60_000, run: async () => analytics.pipeline() },
      { name: 'idempotency_purge', everyMs: 3_600_000, run: async () => ordersRepo.purgeIdempotency(new Date(clock().getTime() - 86_400_000)) },
      { name: 'sessions_refresh', dailyAt: [6, 5], run: async () => brokerAccounts.refreshSessions() },
      { name: 'instruments_refresh', dailyAt: [8, 15], run: async () => instruments.refresh() },
      { name: 'eod_reconcile', dailyAt: [16, 0], run: async () => reconciler.endOfDay() },
    ],
  });

  return {
    config,
    db,
    logger,
    version: VERSION,
    signer,
    identity,
    gateway,
    brokerAccounts,
    instruments,
    orders,
    positions,
    reconciler,
    risk,
    entitlements,
    billing,
    analytics,
    events,
    scheduler,
    settings,
    parser: new SignalParser(clock),
    fetch: runtime.fetch,
  };
}
