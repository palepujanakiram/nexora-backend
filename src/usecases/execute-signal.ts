import type { BrokerFactory } from '../brokers/index.ts';
import type { AccountRepository } from '../data/accounts.ts';
import { newId, sha256 } from '../data/crypto.ts';
import type { Execution, ExecutionRepository } from '../data/executions.ts';
import { BROKER_LABELS, hasValidToken, type BrokerAccount } from '../domain/account.ts';
import { AppError, notFound } from '../domain/errors.ts';
import { istTime } from '../domain/ist.ts';
import { contractLabel, normalizeSignalText, type TradeSignal } from '../domain/signal.ts';
import type { SignalParser } from '../domain/signal-parser.ts';
import {
  TradePricing,
  hasExits,
  type ExecutionSettings,
  type PlacedOrder,
  type ResolvedInstrument,
  type TradePlan,
} from '../domain/trade.ts';

const IN_FLIGHT = 'This signal is already being placed on this account from another device.';

export interface ExecuteDeps {
  accounts: AccountRepository;
  executions: ExecutionRepository;
  brokers: BrokerFactory;
  parser: SignalParser;
  clock: () => Date;
  random: () => number;
  /** Server-wide switch: without it, live (non-paper) accounts never send orders. */
  liveTrading: boolean;
  /** A signal already placed on an account within this window is refused, unless forced. */
  duplicateWindowMs: number;
}

export interface ExecuteInput {
  text: string;
  accountIds: string[];
  settings: ExecutionSettings;
  /** Place it even if the same signal was already placed on the account recently. */
  allowDuplicate: boolean;
}

/**
 * Places a signal on the user's chosen accounts in parallel and records each
 * result in the shared activity log. Per-account failures are returned, not
 * thrown. Mirrors `ExecuteSignalUseCase` in nexora-app, plus a guard against
 * the same signal being placed twice from different devices.
 */
export class ExecuteSignalService {
  private readonly deps: ExecuteDeps;
  /** `accountId:signalKey` pairs being placed right now. */
  private readonly inFlight = new Set<string>();

  constructor(deps: ExecuteDeps) {
    this.deps = deps;
  }

  parse(text: string): TradeSignal {
    return this.deps.parser.parse(text);
  }

  async execute(userId: string, input: ExecuteInput): Promise<Execution[]> {
    const signal = this.deps.parser.parse(input.text);
    const signalKey = sha256(normalizeSignalText(input.text));
    const accounts = [...new Set(input.accountIds)].map((id) => {
      const account = this.deps.accounts.find(userId, id);
      if (!account) throw notFound(`Account ${id} not found.`);
      return account;
    });
    // Locks are held until the results are in the activity log, so a request
    // from another device can't slip in between placing and recording.
    const locked: string[] = [];
    try {
      const results = await Promise.all(
        accounts.map((a) => {
          const lockKey = `${a.id}:${signalKey}`;
          if (this.inFlight.has(lockKey)) return this.result(a, signal, signalKey, { error: IN_FLIGHT, errorCode: 'in_flight' });
          this.inFlight.add(lockKey);
          locked.push(lockKey);
          return this.executeOne(a, signal, signalKey, input);
        }),
      );
      this.deps.executions.addAll(results);
      return results;
    } finally {
      for (const key of locked) this.inFlight.delete(key);
    }
  }

  private async executeOne(
    account: BrokerAccount,
    signal: TradeSignal,
    signalKey: string,
    input: ExecuteInput,
  ): Promise<Execution> {
    const result = (fields: Partial<Execution>) => this.result(account, signal, signalKey, fields);
    if (!input.allowDuplicate) {
      const since = new Date(this.deps.clock().getTime() - this.deps.duplicateWindowMs);
      const previous = this.deps.executions.findRecentSuccess(account.id, signalKey, since);
      if (previous) {
        return result({
          error:
            `Already placed on this account at ${istTime(previous.time)} IST` +
            ' (maybe from another device). Send it again with "place anyway" to repeat it.',
          errorCode: 'duplicate',
        });
      }
    }

    let inst: ResolvedInstrument | null = null;
    let price: number | null = null;
    let qty: number | null = null;
    try {
      const now = this.deps.clock();
      if (!account.paperMode && !this.deps.liveTrading) {
        throw new AppError(403, 'live_trading_off', 'Live trading is turned off on this server (LIVE_TRADING).');
      }
      // Paper accounts still resolve the real contract when logged in, so the
      // dry run shows the exact symbol and lot size.
      if (hasValidToken(account, now)) {
        inst = await this.deps.brokers(account).resolve(signal);
      } else if (!account.paperMode) {
        throw new AppError(401, 'broker_session_expired', `Session expired — log in to ${account.label} first.`);
      }

      const { settings } = input;
      price = TradePricing.roundToTick(TradePricing.entryPrice(signal, settings.entryPriceMode), inst?.tickSize ?? 0.05);
      qty = account.lots * (inst?.lotSize ?? 1);
      const withExits = settings.exitMode === 'withStopAndTarget';
      const plan: TradePlan = {
        signal,
        quantity: qty,
        entryPrice: price,
        product: account.product,
        stopLoss: withExits ? signal.stopLoss : null,
        target: withExits ? TradePricing.targetFor(signal, settings) : null,
      };

      const orders: PlacedOrder[] = account.paperMode
        ? this.paperOrders(plan)
        : await this.deps.brokers(account).placeTrade(inst!, plan);

      return result({ symbol: inst?.symbol ?? contractLabel(signal), quantity: inst ? qty : null, entryPrice: price, orders });
    } catch (e) {
      return result({
        symbol: inst?.symbol ?? contractLabel(signal),
        // Without a resolved contract the lot size (and so the quantity) is unknown.
        quantity: inst ? qty : null,
        entryPrice: price,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private result(account: BrokerAccount, signal: TradeSignal, signalKey: string, fields: Partial<Execution>): Execution {
    return {
      id: newId(),
      userId: account.userId,
      accountId: account.id,
      accountLabel: account.label,
      broker: BROKER_LABELS[account.broker],
      signalText: signal.raw,
      signalKey,
      paper: account.paperMode,
      time: this.deps.clock(),
      symbol: contractLabel(signal),
      quantity: null,
      entryPrice: null,
      orders: [],
      error: null,
      errorCode: null,
      ...fields,
    };
  }

  private paperOrders(plan: TradePlan): PlacedOrder[] {
    const orders = [{ kind: 'ENTRY (paper)', id: `PAPER-${Math.floor(this.deps.random() * 1_000_000_000)}` }];
    if (hasExits(plan)) orders.push({ kind: `SL ${plan.stopLoss} / TGT ${plan.target} (paper)`, id: '-' });
    return orders;
  }
}
