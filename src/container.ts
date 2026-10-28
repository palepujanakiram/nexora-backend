import { InstrumentCache, type Fetch } from './brokers/broker-api.ts';
import { brokerFactory } from './brokers/index.ts';
import { Msg91Otp } from './brokers/msg91.ts';
import type { Config } from './config.ts';
import { AccountRepository } from './data/accounts.ts';
import { SecretBox } from './data/crypto.ts';
import { openDb, type Db } from './data/db.ts';
import { ExecutionRepository } from './data/executions.ts';
import { OtpRepository } from './data/otp.ts';
import { SessionRepository, UserRepository } from './data/users.ts';
import { SignalParser } from './domain/signal-parser.ts';
import type { AppDeps } from './http/app.ts';
import { AccountService } from './usecases/accounts.ts';
import { AuthService } from './usecases/auth.ts';
import { ExecuteSignalService } from './usecases/execute-signal.ts';
import { OtpLoginService } from './usecases/otp-login.ts';

export const VERSION = '1.0.0';

/** The outside world. Tests replace these; production uses the real ones. */
export interface Runtime {
  fetch: Fetch;
  clock: () => Date;
  random: () => number;
}

export const realRuntime: Runtime = {
  fetch: (input, init) => fetch(input, init),
  clock: () => new Date(),
  random: Math.random,
};

export interface Services extends AppDeps {
  db: Db;
}

/** Wires every service from [config]. The one place dependencies are built. */
export function createServices(config: Config, runtime: Runtime = realRuntime): Services {
  const db = openDb(config.DATABASE_PATH);
  const box = new SecretBox(config.ENCRYPTION_KEY);
  const accountRepo = new AccountRepository(db, box);
  const executions = new ExecutionRepository(db);
  const brokers = brokerFactory({ ...runtime, cache: new InstrumentCache() });
  const users = new UserRepository(db);
  const auth = new AuthService({
    users,
    sessions: new SessionRepository(db),
    clock: runtime.clock,
    signupCode: config.SIGNUP_CODE,
    sessionDays: config.SESSION_DAYS,
  });
  const { MSG91_AUTH_KEY: authKey, MSG91_TEMPLATE_ID: templateId } = config;

  return {
    db,
    config,
    executions,
    fetch: runtime.fetch,
    version: VERSION,
    auth,
    otp: new OtpLoginService({
      users,
      otps: new OtpRepository(db),
      auth,
      sender: authKey && templateId ? new Msg91Otp({ fetch: runtime.fetch, authKey, templateId }) : null,
      clock: runtime.clock,
      signupCode: config.SIGNUP_CODE,
      expiryMinutes: config.OTP_EXPIRY_MINUTES,
    }),
    accounts: new AccountService({ accounts: accountRepo, brokers, clock: runtime.clock }),
    signals: new ExecuteSignalService({
      accounts: accountRepo,
      executions,
      brokers,
      parser: new SignalParser(runtime.clock),
      clock: runtime.clock,
      random: runtime.random,
      liveTrading: config.LIVE_TRADING,
      duplicateWindowMs: config.DUPLICATE_WINDOW_MINUTES * 60 * 1000,
    }),
  };
}
