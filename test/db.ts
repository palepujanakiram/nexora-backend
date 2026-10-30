import { PGlite } from '@electric-sql/pglite';
import { afterEach } from 'vitest';

import { PgliteDb, migrate } from '../src/data/db.ts';

let template: Promise<PGlite> | null = null;
const open: PgliteDb[] = [];

/** A freshly migrated in-process Postgres. Cloned from one migrated template per worker, so it's fast. */
export async function testDb(): Promise<PgliteDb> {
  template ??= (async () => {
    const pg = await PGlite.create();
    await migrate(new PgliteDb(pg));
    return pg;
  })();
  const db = new PgliteDb(await (await template).clone());
  open.push(db);
  return db;
}

afterEach(async () => {
  for (const db of open.splice(0)) await db.close();
});
