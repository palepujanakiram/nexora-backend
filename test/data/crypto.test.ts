import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { SecretBox, hmacSha256, newClientRef, newId, newToken, sameSecret, sha256 } from '../../src/data/crypto.ts';
import { TEST_KEY, defined } from '../helpers.ts';

const KEY2 = Buffer.alloc(32, 9).toString('base64');

describe('SecretBox', () => {
  it('round-trips with a bare key as version 1', () => {
    const box = SecretBox.fromConfig(TEST_KEY, null);
    expect(box.currentVersion).toBe(1);
    const sealed = box.encrypt('api-secret ✓');
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain('api-secret');
    expect(box.decrypt(sealed)).toBe('api-secret ✓');
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('uses the highest version by default and still decrypts older ones', () => {
    const v1 = SecretBox.fromConfig(`1:${TEST_KEY}`, null);
    const both = SecretBox.fromConfig(` 1:${TEST_KEY} , 2:${KEY2} ,`, null);
    expect(both.currentVersion).toBe(2);
    const old = v1.encrypt('hello');
    expect(both.decrypt(old)).toBe('hello');
    expect(both.isStale(old)).toBe(true);
    const fresh = both.encrypt('hello');
    expect(fresh).toMatch(/^v2:/);
    expect(both.isStale(fresh)).toBe(false);
    expect(() => v1.decrypt(fresh)).toThrow('Unknown secret format or key version.');
  });

  it('honours an explicit current version', () => {
    const box = SecretBox.fromConfig(`1:${TEST_KEY},2:${KEY2}`, 1);
    expect(box.currentVersion).toBe(1);
    expect(box.encrypt('x')).toMatch(/^v1:/);
  });

  it('refuses wrong key lengths and unknown versions', () => {
    expect(() => SecretBox.fromConfig(Buffer.alloc(16).toString('base64'), null)).toThrow('Encryption keys must be 32 bytes');
    expect(() => SecretBox.fromConfig(`1:${TEST_KEY}`, 3)).toThrow('No encryption key with version 3.');
  });

  it('refuses malformed or tampered ciphertext', () => {
    const box = SecretBox.fromConfig(TEST_KEY, null);
    expect(() => box.decrypt('plain text')).toThrow('Unknown secret format or key version.');
    const sealed = box.encrypt('hello');
    const raw = Buffer.from(sealed.slice(3), 'base64');
    raw[raw.length - 1] = defined(raw[raw.length - 1]) ^ 1;
    expect(() => box.decrypt(`v1:${raw.toString('base64')}`)).toThrow();
  });
});

describe('hashes and ids', () => {
  it('hashes and signs', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hmacSha256('key', 'body')).toBe(createHmac('sha256', 'key').update('body').digest('hex'));
  });

  it('compares secrets', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('short', 'a much longer value')).toBe(false);
  });

  it('makes prefixed random ids, tokens and client refs', () => {
    expect(newId('po')).toMatch(/^po_[A-Za-z0-9_-]{16}$/);
    expect(newId('po')).not.toBe(newId('po'));
    expect(newToken('rt')).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);
    expect(newClientRef()).toMatch(/^NX[0-9A-F]{16}$/);
  });
});
