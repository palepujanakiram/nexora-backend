import { describe, expect, it } from 'vitest';

import { SettingsRepository } from '../../src/data/settings.ts';
import { Scheduler, type Job } from '../../src/usecases/jobs.ts';
import { testClock } from '../app.ts';
import { testDb } from '../db.ts';
import { memoryLog } from '../helpers.ts';

const MIN = 60_000;

async function scheduler(jobs: Job[], start?: Date) {
  const db = await testDb();
  const settings = new SettingsRepository(db);
  const clock = testClock(start);
  const log = memoryLog();
  return { db, settings, clock, log, scheduler: new Scheduler({ db, settings, clock, log, jobs }) };
}

/** A job that counts its runs, and fails while [fail] is set. */
function counting(job: Omit<Job, 'run'>) {
  const state = { runs: 0, fail: false };
  return {
    state,
    job: {
      ...job,
      run: async () => {
        state.runs++;
        if (state.fail) throw new Error('broker master unavailable');
      },
    },
  };
}

describe('Scheduler', () => {
  it('runs interval jobs when due and not before', async () => {
    const every = counting({ name: 'reconcile', everyMs: 5000 });
    const t = await scheduler([every.job]);
    expect(await t.scheduler.runDue()).toEqual(['reconcile']);
    t.clock.advance(4999);
    expect(await t.scheduler.runDue()).toEqual([]);
    t.clock.advance(1);
    expect(await t.scheduler.runDue()).toEqual(['reconcile']);
    expect(every.state.runs).toBe(2);
  });

  it('never runs a job with no schedule', async () => {
    const idle = counting({ name: 'manual' });
    const t = await scheduler([idle.job]);
    expect(await t.scheduler.runDue()).toEqual([]);
    expect(idle.state.runs).toBe(0);
  });

  it('runs a daily job once per IST day, after its time', async () => {
    // NOW is 09:30 IST; the job is at 09:45.
    const daily = counting({ name: 'instruments_refresh', dailyAt: [9, 45] });
    const t = await scheduler([daily.job]);
    expect(await t.scheduler.runDue()).toEqual([]);
    t.clock.advance(15 * MIN);
    expect(await t.scheduler.runDue()).toEqual(['instruments_refresh']);
    expect(await t.settings.jobState('instruments_refresh')).toEqual({ day: '2026-10-27' });
    t.clock.advance(6 * 60 * MIN);
    expect(await t.scheduler.runDue()).toEqual([]);
    // Next day, after 09:45 IST.
    t.clock.advance(18 * 60 * MIN);
    expect(await t.scheduler.runDue()).toEqual(['instruments_refresh']);
    expect(await t.settings.jobState('instruments_refresh')).toEqual({ day: '2026-10-28' });
    expect(daily.state.runs).toBe(2);
  });

  it('catches up on a daily job missed earlier today, and does not repeat it after a restart', async () => {
    const daily = counting({ name: 'sessions_refresh', dailyAt: [6, 5] });
    const first = await scheduler([daily.job]);
    expect(await first.scheduler.runDue()).toEqual(['sessions_refresh']);
    // A restarted process reads the stored day and doesn't run it again.
    const again = new Scheduler({ db: first.db, settings: first.settings, clock: first.clock, log: first.log, jobs: [daily.job] });
    expect(await again.runDue()).toEqual([]);
    expect(daily.state.runs).toBe(1);
  });

  it('retries a failed daily job no sooner than every 10 minutes', async () => {
    const daily = counting({ name: 'eod', dailyAt: [9, 0] });
    daily.state.fail = true;
    const t = await scheduler([daily.job]);
    expect(await t.scheduler.runDue()).toEqual(['eod']);
    expect(await t.settings.jobState('eod')).toBeNull();
    expect(t.log.lines).toContainEqual({ level: 'error', obj: { job: 'eod', reason: 'broker master unavailable' }, msg: 'job failed' });
    t.clock.advance(9 * MIN);
    expect(await t.scheduler.runDue()).toEqual([]);
    daily.state.fail = false;
    t.clock.advance(MIN);
    expect(await t.scheduler.runDue()).toEqual(['eod']);
    expect(await t.settings.jobState('eod')).toEqual({ day: '2026-10-27' });
    expect(daily.state.runs).toBe(2);
  });

  it('skips a job whose lock another runner holds', async () => {
    const every = counting({ name: 'analytics', everyMs: MIN });
    const t = await scheduler([every.job]);
    let release!: () => void;
    const held = t.db.withLock('job:analytics', 1000, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 5));
    expect(await t.scheduler.runDue()).toEqual([]);
    expect(every.state.runs).toBe(0);
    release();
    await held;
  });

  it('ticks on a timer until stopped, and logs a failed tick', async () => {
    const every = counting({ name: 'reconcile', everyMs: 1 });
    const t = await scheduler([every.job]);
    t.scheduler.start(5);
    await new Promise((r) => setTimeout(r, 40));
    t.clock.advance(10);
    await new Promise((r) => setTimeout(r, 40));
    await t.scheduler.stop();
    const runs = every.state.runs;
    expect(runs).toBeGreaterThanOrEqual(2);
    t.clock.advance(10);
    await new Promise((r) => setTimeout(r, 20));
    expect(every.state.runs).toBe(runs);
    await t.scheduler.stop();

    const broken = new Scheduler({
      db: t.db,
      settings: { jobState: async () => Promise.reject(new Error('db down')) } as unknown as SettingsRepository,
      clock: t.clock,
      log: t.log,
      jobs: [{ name: 'daily', dailyAt: [0, 0], run: async () => {} }],
    });
    broken.start(5);
    await new Promise((r) => setTimeout(r, 30));
    await broken.stop();
    expect(t.log.lines).toContainEqual({ level: 'error', obj: { job: 'scheduler', reason: 'db down' }, msg: 'scheduler tick failed' });
  });
});
