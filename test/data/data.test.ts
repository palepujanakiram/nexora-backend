import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AccountRepository } from '../../src/data/accounts.ts';
import { SecretBox, hashPassword, newId, newToken, sha256, verifyPassword } from '../../src/data/crypto.ts';
import { migrate, openDb } from '../../src/data/db.ts';
import { ExecutionRepository, type Execution } from '../../src/data/executions.ts';
import { SessionRepository, UserRepository } from '../../src/data/users.ts';
import { NOW, TEST_KEY, account } from '../helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function memoryDb() {
  const db = openDb(':memory:');
  new UserRepository(db).create({ id: 'user1', email: 'a@b.c', createdAt: NOW }, 'hash');
  return db;
}

describe('SecretBox', () => {
  it('round-trips text and never stores it in the clear', () => {
    const box = new SecretBox(TEST_KEY);
    const sealed = box.encrypt('my secret');
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain('my secret');
    expect(box.encrypt('my secret')).not.toBe(sealed);
    expect(box.decrypt(sealed)).toBe('my secret');
  });

  it('rejects bad keys, tampering and unknown formats', () => {
    expect(() => new SecretBox('c2hvcnQ=')).toThrow('ENCRYPTION_KEY must be 32 bytes');
    const box = new SecretBox(TEST_KEY);
    const sealed = box.encrypt('x');
    const other = new SecretBox(Buffer.alloc(32, 9).toString('base64'));
    expect(() => other.decrypt(sealed)).toThrow();
    expect(() => box.decrypt('plain')).toThrow('Unknown secret format.');
  });
});

describe('passwords and tokens', () => {
  it('hashes and verifies passwords', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong horse', hash)).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$whatever')).toBe(false);
  });

  it('makes random tokens and ids, and hashes text', () => {
    expect(newToken()).not.toBe(newToken());
    expect(newToken()).toMatch(/^[\w-]{43}$/);
    expect(newId()).toMatch(/^[\w-]{16}$/);
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('openDb and migrate', () => {
  it('creates the file and folders, and reopens without re-running migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexora-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'n.db');
    const db = openDb(path);
    new UserRepository(db).create({ id: 'u', email: 'x@y.z', createdAt: NOW }, 'h');
    db.close();
    const again = openDb(path);
    expect(new UserRepository(again).findById('u')?.email).toBe('x@y.z');
    expect(again.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    again.close();
  });

  it('rolls back a failing migration', () => {
    const db = openDb(':memory:');
    expect(() => migrate(db, ['SELECT 1', 'CREATE TABLE extra (id TEXT); NOT SQL'])).toThrow();
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'extra'").get()).toBeUndefined();
  });
});

describe('UserRepository and SessionRepository', () => {
  it('stores users with case-insensitive email lookup', () => {
    const users = new UserRepository(openDb(':memory:'));
    users.create({ id: 'u1', email: 'me@example.com', createdAt: NOW }, 'hash1');
    expect(users.findByEmail('ME@example.com')).toEqual({
      user: { id: 'u1', email: 'me@example.com', createdAt: NOW },
      passwordHash: 'hash1',
    });
    users.setPassword('u1', 'hash2');
    expect(users.findByEmail('me@example.com')?.passwordHash).toBe('hash2');
    expect(users.findByEmail('nobody@example.com')).toBeNull();
    expect(users.findById('nope')).toBeNull();
  });

  it('stores, finds and removes sessions', () => {
    const db = memoryDb();
    const sessions = new SessionRepository(db);
    const later = new Date(NOW.getTime() + 1000);
    sessions.create('h1', { userId: 'user1', device: 'phone', createdAt: NOW, expiresAt: later });
    sessions.create('h2', { userId: 'user1', device: 'tablet', createdAt: NOW, expiresAt: NOW });
    expect(sessions.find('h1')).toEqual({ userId: 'user1', device: 'phone', createdAt: NOW, expiresAt: later });
    sessions.deleteExpired(NOW);
    expect(sessions.find('h2')).toBeNull();
    sessions.delete('h1');
    expect(sessions.find('h1')).toBeNull();
    sessions.create('h3', { userId: 'user1', device: 'p', createdAt: NOW, expiresAt: later });
    sessions.deleteForUser('user1');
    expect(sessions.find('h3')).toBeNull();
  });
});

describe('AccountRepository', () => {
  it('encrypts credentials and round-trips every field', () => {
    const db = memoryDb();
    const repo = new AccountRepository(db, new SecretBox(TEST_KEY));
    const a = account();
    repo.save(a);
    expect(repo.find('user1', 'acc1')).toEqual(a);
    const raw = db.prepare('SELECT api_key, api_secret, access_token FROM accounts').get() as Record<string, string>;
    expect(Object.values(raw).every((v) => v.startsWith('v1:'))).toBe(true);

    const loggedOut = { ...a, id: 'acc2', accessToken: null, tokenIssuedAt: null, enabled: false, paperMode: true };
    repo.save(loggedOut);
    expect(repo.list('user1').map((x) => x.id)).toEqual(['acc1', 'acc2']);
    expect(repo.find('user1', 'acc2')).toEqual(loggedOut);
  });

  it('only lets the owner see or delete an account', () => {
    const repo = new AccountRepository(memoryDb(), new SecretBox(TEST_KEY));
    repo.save(account());
    expect(repo.find('someone-else', 'acc1')).toBeNull();
    expect(repo.list('someone-else')).toEqual([]);
    expect(repo.delete('someone-else', 'acc1')).toBe(false);
    expect(repo.delete('user1', 'acc1')).toBe(true);
    expect(repo.find('user1', 'acc1')).toBeNull();
  });
});

describe('ExecutionRepository', () => {
  const execution = (overrides: Partial<Execution> = {}): Execution => ({
    id: 'e1',
    userId: 'user1',
    accountId: 'acc1',
    accountLabel: 'Main',
    broker: 'Upstox',
    signalText: 'BUY …',
    signalKey: 'k1',
    paper: true,
    time: NOW,
    symbol: 'X',
    quantity: 20,
    entryPrice: 420,
    orders: [{ kind: 'ENTRY', id: '1' }],
    error: null,
    errorCode: null,
    ...overrides,
  });

  it('lists newest first, limited, and clears per user', () => {
    const repo = new ExecutionRepository(memoryDb());
    repo.addAll([
      execution(),
      execution({ id: 'e2', time: new Date(NOW.getTime() + 1000), paper: false, symbol: null, quantity: null, entryPrice: null, error: 'x', errorCode: 'duplicate' }),
    ]);
    expect(repo.list('user1', 10).map((e) => e.id)).toEqual(['e2', 'e1']);
    expect(repo.list('user1', 1)[0]).toMatchObject({ id: 'e2', paper: false, error: 'x', errorCode: 'duplicate', symbol: null });
    expect(repo.list('user1', 10)[1]).toEqual(execution());
    repo.clear('user1');
    expect(repo.list('user1', 10)).toEqual([]);
  });

  it('finds a recent successful execution of the same signal', () => {
    const repo = new ExecutionRepository(memoryDb());
    repo.addAll([execution({ id: 'failed', error: 'rejected', time: new Date(NOW.getTime() + 5) }), execution()]);
    expect(repo.findRecentSuccess('acc1', 'k1', new Date(NOW.getTime() - 1))?.id).toBe('e1');
    expect(repo.findRecentSuccess('acc1', 'k1', new Date(NOW.getTime() + 1))).toBeNull();
    expect(repo.findRecentSuccess('acc1', 'other', new Date(0))).toBeNull();
  });
});
