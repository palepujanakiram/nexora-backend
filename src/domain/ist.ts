/** Indian Standard Time is UTC+05:30 all year (no daylight saving). */
export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** The calendar date in India at [now], as `YYYY-MM-DD`. */
export function istDate(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The most recent moment (at or before [now]) the IST clock read [hour]:[minute]. */
export function lastIstTime(now: Date, hour: number, minute: number): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  let reset = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hour, minute);
  if (ist.getTime() < reset) reset -= 24 * 60 * 60 * 1000;
  return new Date(reset - IST_OFFSET_MS);
}

/** The time of day in India at [at], as `HH:MM`. */
export function istTime(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(11, 16);
}
