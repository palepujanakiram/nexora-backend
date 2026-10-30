import type { Plan } from '../data/billing.ts';
import type { OrderRepository } from '../data/orders.ts';
import type { SettingsRepository } from '../data/settings.ts';
import { AppError, badRequest } from '../domain/errors.ts';
import type { Instrument } from '../domain/instrument.ts';
import { istDate, lastIstTime } from '../domain/ist.ts';
import { rupees, type Paise } from '../domain/money.ts';
import type { OrderIntent } from '../domain/order.ts';
import { marketOpen } from '../domain/risk.ts';

export interface KillSwitch {
  on: boolean;
  reason: string | null;
  at: string | null;
}

export interface RiskDeps {
  settings: SettingsRepository;
  orders: OrderRepository;
  clock: () => Date;
  enforceMarketHours: boolean;
  /** Most rupees (in paise) one order may be worth on one account. */
  maxNotionalPaise: Paise;
  /** Server-wide cap on broker orders per user per day, on top of the plan's. */
  maxOrdersPerDay: number;
}

const KILL_SWITCH = 'kill_switch';

/** Pre-trade checks, run before any fan-out. */
export class RiskService {
  private readonly d: RiskDeps;

  constructor(deps: RiskDeps) {
    this.d = deps;
  }

  /** Read from the database on every order, so flipping it takes effect at once, without a deploy. */
  async killSwitch(): Promise<KillSwitch> {
    return (await this.d.settings.get<KillSwitch>(KILL_SWITCH)) ?? { on: false, reason: null, at: null };
  }

  async setKillSwitch(on: boolean, reason: string | null): Promise<KillSwitch> {
    const value: KillSwitch = { on, reason: on ? reason : null, at: this.d.clock().toISOString() };
    await this.d.settings.set(KILL_SWITCH, value, this.d.clock());
    return value;
  }

  /** Every outbound order (entry, modify, exit) stops while the kill switch is on. Cancels still go out. */
  async requireNoKillSwitch(): Promise<void> {
    const k = await this.killSwitch();
    if (k.on) throw new AppError(503, 'kill_switch', `Trading is paused on this server${k.reason ? `: ${k.reason}` : ''}. Cancels still work.`);
  }

  /** The checks for a new entry fanned out to [legCount] accounts. */
  async checkEntry(userId: string, intent: OrderIntent, instrument: Instrument, legCount: number, plan: Plan): Promise<void> {
    await this.requireNoKillSwitch();
    const now = this.d.clock();
    if (this.d.enforceMarketHours && !marketOpen(instrument.exchange, now, await this.d.settings.isHoliday(istDate(now)))) {
      throw new AppError(422, 'market_closed', `${instrument.exchange} is closed now.`);
    }
    if (legCount > plan.maxFanout) {
      throw new AppError(402, 'plan_limit', `Your plan places on at most ${plan.maxFanout} accounts at once.`, { limit: 'max_fanout', max: plan.maxFanout });
    }
    const cap = Math.min(plan.maxOrdersPerDay, this.d.maxOrdersPerDay);
    const today = await this.d.orders.entryLegsSince(userId, lastIstTime(now, 0, 0));
    if (today + legCount > cap) {
      throw new AppError(429, 'daily_order_cap', `That would exceed the daily limit of ${cap} orders (${today} placed today).`);
    }
    this.checkNotional(intent.quantity, intent.pricePaise ?? intent.triggerPaise ?? intent.referencePricePaise);
  }

  /** One account's order value must stay under the limit. Market orders need the price the user saw. */
  checkNotional(quantity: number, pricePaise: Paise | null): void {
    if (pricePaise === null) throw badRequest('Market orders need referencePrice (the last price you saw), for the risk check.');
    const notional = quantity * pricePaise;
    if (notional > this.d.maxNotionalPaise) {
      throw new AppError(422, 'max_notional', `Order value ₹${rupees(notional)} is over the ₹${rupees(this.d.maxNotionalPaise)} limit per order.`);
    }
  }
}
