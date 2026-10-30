/**
 * [value], or an error naming [what] when it's missing. For values the code's
 * own logic guarantees (a row it just wrote, a regex group that matched), so
 * a broken guarantee fails loudly instead of being asserted away with `!`.
 */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Internal error: expected ${what}.`);
  return value;
}

/** The only row of a query that always returns exactly one (a count, an `UPDATE … RETURNING` on a known id). */
export const single = <T>(rows: readonly T[], what: string): T => must(rows[0], what);
