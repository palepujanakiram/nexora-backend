import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { describe, expect, it } from 'vitest';

import { LocalLocks, PgDb, PgliteDb, migrate, openDb, openPglite } from '../../src/data/db.ts';
import { MIGRATIONS } from '../../src/data/schema.ts';
import { testDb } from '../db.ts';
import { defined } from '../helpers.ts';

describe('migrations', () => {
  it('applies every migration once and records it', async () => {
    const db = await testDb();
    expect(await migrate(db)).toBe(0);
    const [row] = await db.query<{ v: number }>('SELECT max(version) AS v FROM schema_migrations');
    expect(defined(row).v).toBe(MIGRATIONS.length);
  });

  it('rolls back a failing migration', async () => {
    const db = new PgliteDb(await PGlite.create());
    await expect(migrate(db, ['CREATE TABLE a (x int)', 'CREATE TABLE b (x int); SELECT nope'])).rejects.toThrow();
    expect(await db.query('SELECT * FROM schema_migrations')).toHaveLength(1);
    expect(await db.query(`SELECT to_regclass('b') AS t`)).toEqual([{ t: null }]);
    await db.close();
  });

  it('keeps the audit tables append-only', async () => {
    const db = await testDb();
    await db.query(`INSERT INTO payment_events (provider_event_id, type, raw_payload, at) VALUES ('e1', 't', '{}', now())`);
    await expect(db.query(`UPDATE payment_events SET type = 'x'`)).rejects.toThrow('append-only');
    await expect(db.query('DELETE FROM payment_events')).rejects.toThrow('append-only');
  });

  it('returns int8 as numbers and dates as plain strings', async () => {
    const db = await testDb();
    expect(await db.query(`SELECT 5::int8 AS n, '2026-10-27'::date AS d`)).toEqual([{ n: 5, d: '2026-10-27' }]);
  });

  it('opens a PGlite database in memory', async () => {
    const db = await openPglite();
    expect(await db.query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    await db.close();
  });
});

describe('transactions', () => {
  it('commits on success and rolls back on failure', async () => {
    const db = await testDb();
    await db.exec('CREATE TABLE t (x int)');
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO t VALUES ($1)', [1]);
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.exec('INSERT INTO t VALUES (2)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.query('SELECT x FROM t')).toEqual([{ x: 1 }]);
  });
});

describe('LocalLocks', () => {
  it('runs holders of the same key one after another', async () => {
    const locks = new LocalLocks();
    const order: string[] = [];
    let release!: () => void;
    const first = locks.run('k', 1000, async () => {
      order.push('first start');
      await new Promise<void>((r) => (release = r));
      order.push('first end');
      return 1;
    });
    const second = locks.run('k', 1000, async () => {
      order.push('second');
      return 2;
    });
    await new Promise((r) => setTimeout(r, 5));
    release();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(['first start', 'first end', 'second']);
  });

  it('gives up after the wait and returns null', async () => {
    const locks = new LocalLocks();
    let release!: () => void;
    const held = locks.run('k', 1000, async () => new Promise<number>((r) => (release = () => { r(1); })));
    expect(await locks.run('k', 10, async () => 2)).toBeNull();
    release();
    expect(await held).toBe(1);
    expect(await locks.run('k', 10, async () => 3)).toBe(3);
  });

  it('wraps PGlite lock results', async () => {
    const db = await testDb();
    expect(await db.withLock('x', 100, async () => 'v')).toEqual({ value: 'v' });
  });
});

describe('PgDb (the production driver) over the Postgres wire protocol', () => {
  it('migrates, queries, runs transactions and takes advisory locks', async () => {
    const pg = await PGlite.create();
    const server = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1', maxConnections: 20 });
    await server.start();
    const port = Number(new URL(`tcp://${server.getServerConn()}`).port);
    const db = new PgDb(`postgres://postgres@127.0.0.1:${port}/postgres`, 1);
    try {
      await migrate(db, ['CREATE TABLE t (n int8, d date)']);
      await db.query('INSERT INTO t VALUES ($1, $2)', [7, '2026-10-27']);
      expect(await db.query('SELECT * FROM t')).toEqual([{ n: 7, d: '2026-10-27' }]);
      await db.exec('INSERT INTO t VALUES (8, NULL)');
      await expect(
        db.transaction(async (tx) => {
          await tx.exec('INSERT INTO t VALUES (9, NULL)');
          await tx.query('SELECT $1::int', ['nope']);
        }),
      ).rejects.toThrow();
      expect(await db.transaction(async (tx) => tx.query<{ n: number }>('SELECT count(*) AS n FROM t'))).toEqual([{ n: 2 }]);
      expect(await db.withLock('job:x', 200, async () => 'locked')).toEqual({ value: 'locked' });
    } finally {
      await db.close();
      await server.stop();
      await pg.close();
    }
  });

  it('openDb connects and migrates', async () => {
    const pg = await PGlite.create();
    const server = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1', maxConnections: 20 });
    await server.start();
    const port = Number(new URL(`tcp://${server.getServerConn()}`).port);
    const db = await openDb(`postgres://postgres@127.0.0.1:${port}/postgres`);
    try {
      expect(defined((await db.query<{ v: number }>('SELECT max(version) AS v FROM schema_migrations'))[0]).v).toBe(MIGRATIONS.length);
    } finally {
      await db.close();
      await server.stop();
      await pg.close();
    }
  });
});
