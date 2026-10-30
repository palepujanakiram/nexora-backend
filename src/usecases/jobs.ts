import type { Db } from '../data/db.ts';
import type { SettingsRepository } from '../data/settings.ts';
import { istDate, istMinutes } from '../domain/ist.ts';
import type { Log } from '../logging.ts';

export interface Job {
  name: string;
  run: () => Promise<unknown>;
  /** Run every [everyMs]… */
  everyMs?: number;
  /** …or once a day at this IST time (`[hour, minute]`), catching up if the server was down then. */
  dailyAt?: readonly [number, number];
}

/**
 * Runs background jobs in-process. Each run holds a database lock named
 * after the job, so with several server processes only one runs it.
 * TODO(BullMQ): move to a queue with retries/backoff once jobs outgrow this.
 */
export class Scheduler {
  private readonly d: { db: Db; settings: SettingsRepository; clock: () => Date; log: Log; jobs: readonly Job[] };
  private readonly lastRun = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;

  constructor(deps: { db: Db; settings: SettingsRepository; clock: () => Date; log: Log; jobs: readonly Job[] }) {
    this.d = deps;
  }

  /** Runs every job that's due now. Returns the names it ran. */
  async runDue(): Promise<string[]> {
    const now = this.d.clock();
    const ran: string[] = [];
    for (const job of this.d.jobs) {
      if (job.everyMs !== undefined) {
        const last = this.lastRun.get(job.name) ?? 0;
        if (now.getTime() - last < job.everyMs) continue;
        this.lastRun.set(job.name, now.getTime());
        if (await this.runLocked(job)) ran.push(job.name);
      } else if (job.dailyAt) {
        const [h, m] = job.dailyAt;
        const today = istDate(now);
        if (istMinutes(now) < h * 60 + m) continue;
        const state = await this.d.settings.jobState<{ day: string }>(job.name);
        if (state?.day === today) continue;
        // A failed daily job is retried, but not more than every 10 minutes.
        if (now.getTime() - (this.lastRun.get(job.name) ?? 0) < 10 * 60_000) continue;
        this.lastRun.set(job.name, now.getTime());
        if (await this.runLocked(job, async () => this.d.settings.setJobState(job.name, { day: today }, this.d.clock()))) ran.push(job.name);
      }
    }
    return ran;
  }

  /** Checks for due jobs every [tickMs] until [stop]. */
  start(tickMs: number): void {
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = this.runDue()
        .catch((e: Error) => this.d.log.error({ job: 'scheduler', reason: e.message }, 'scheduler tick failed'))
        .then(() => {
          this.ticking = null;
        });
    }, tickMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking;
  }

  private async runLocked(job: Job, after?: () => Promise<void>): Promise<boolean> {
    const result = await this.d.db.withLock(`job:${job.name}`, 0, async () => {
      try {
        await job.run();
        await after?.();
      } catch (e) {
        this.d.log.error({ job: job.name, reason: (e as Error).message }, 'job failed');
      }
      return true;
    });
    return result !== null;
  }
}
