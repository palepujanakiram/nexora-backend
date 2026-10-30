import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll } from 'vitest';

import { PgliteDb, migrate } from '../src/data/db.ts';

let template: Promise<PGlite> | null = null;
const open: PgliteDb[] = [];

/** One migrated database per worker; every test gets a clone of it. */
async function migratedTemplate(): Promise<PGlite> {
  template ??= (async () => {
    const pg = await PGlite.create();
    await migrate(new PgliteDb(pg));
    return pg;
  })();
  return template;
}

// Creating and migrating the template takes a few seconds on slow CI runners:
// do it before the first test, with its own timeout, so no test pays for it.
beforeAll(async () => {
  await migratedTemplate();
}, 120_000);

/** A freshly migrated in-process Postgres, cloned from the worker's template so it's fast. */
export async function testDb(): Promise<PgliteDb> {
  const db = new PgliteDb(await (await migratedTemplate()).clone());
  open.push(db);
  return db;
}

afterEach(async () => {
  for (const db of open.splice(0)) await db.close();
});
