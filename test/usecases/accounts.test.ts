import { describe, expect, it, vi } from 'vitest';

import type { BrokerApi } from '../../src/brokers/broker-api.ts';
import { AccountRepository } from '../../src/data/accounts.ts';
import { SecretBox } from '../../src/data/crypto.ts';
import { openDb } from '../../src/data/db.ts';
import { UserRepository } from '../../src/data/users.ts';
import { AccountService, type AccountInput } from '../../src/usecases/accounts.ts';
import { NOW, TEST_KEY } from '../helpers.ts';

function setup() {
  const db = openDb(':memory:');
  new UserRepository(db).create({ id: 'user1', email: 'a@b.c', phone: null, createdAt: NOW }, 'h');
  const repo = new AccountRepository(db, new SecretBox(TEST_KEY));
  const broker: BrokerApi = {
    login: vi.fn(() => ({ kind: 'approval' as const, url: 'https://groww.in/trade-api/api-keys' })),
    exchangeToken: vi.fn(async (input: string) => `token-for-${input}`),
    resolve: vi.fn(),
    placeTrade: vi.fn(),
  };
  const service = new AccountService({ accounts: repo, brokers: () => broker, clock: () => NOW });
  return { service, repo, broker };
}

const input: AccountInput = {
  broker: 'upstox',
  label: ' Family ',
  apiKey: ' upkey1234 ',
  apiSecret: ' upsecret ',
  redirectUri: ' https://127.0.0.1/ ',
  enabled: true,
  lots: 2,
  product: 'intraday',
  paperMode: true,
};

describe('AccountService', () => {
  it('creates accounts with trimmed fields and shows only a masked key', () => {
    const { service, repo } = setup();
    const view = service.create('user1', input);
    expect(view).toEqual({
      id: view.id,
      broker: 'upstox',
      brokerLabel: 'Upstox',
      label: 'Family',
      apiKeyMasked: 'upke••••34',
      redirectUri: 'https://127.0.0.1/',
      enabled: true,
      lots: 2,
      product: 'intraday',
      paperMode: true,
      loggedIn: false,
      tokenIssuedAt: null,
      login: { kind: 'approval', url: 'https://groww.in/trade-api/api-keys' },
    });
    expect(repo.find('user1', view.id)).toMatchObject({ apiKey: 'upkey1234', apiSecret: 'upsecret' });
    expect(service.list('user1')).toEqual([view]);
    expect(service.get('user1', view.id)).toEqual(view);
  });

  it('drops the redirect URI for brokers that do not use one', () => {
    const { service } = setup();
    expect(service.create('user1', { ...input, broker: 'zerodha' }).redirectUri).toBe('');
  });

  it('validates required fields and broker rules', () => {
    const { service } = setup();
    expect(() => service.create('user1', { ...input, label: ' ' })).toThrow('Give the account a name.');
    expect(() => service.create('user1', { ...input, apiKey: '' })).toThrow('Enter the API key.');
    expect(() => service.create('user1', { ...input, apiSecret: '' })).toThrow('Enter the API secret.');
    expect(() => service.create('user1', { ...input, redirectUri: '' })).toThrow('Upstox needs the Redirect URI');
    expect(() => service.create('user1', { ...input, lots: 0 })).toThrow('Lots must be a whole number');
  });

  it('updates settings, keeping the session unless credentials change', async () => {
    const { service } = setup();
    const { id } = service.create('user1', input);
    await service.connect('user1', id, 'CODE');
    expect(service.update('user1', id, { lots: 5, paperMode: false, apiSecret: '  ' })).toMatchObject({
      lots: 5,
      paperMode: false,
      loggedIn: true,
    });
    expect(service.update('user1', id, { label: 'Renamed', enabled: false, product: 'carryForward' })).toMatchObject({
      label: 'Renamed',
      enabled: false,
      product: 'carryForward',
      loggedIn: true,
    });
    expect(service.update('user1', id, { apiSecret: 'new secret' }).loggedIn).toBe(false);
    await service.connect('user1', id, 'CODE');
    expect(service.update('user1', id, { redirectUri: 'https://localhost/' }).loggedIn).toBe(false);
    await service.connect('user1', id, 'CODE');
    expect(service.update('user1', id, { apiKey: 'other-key' }).loggedIn).toBe(false);
    await service.connect('user1', id, 'CODE');
    expect(service.update('user1', id, { broker: 'zerodha' })).toMatchObject({ loggedIn: false, redirectUri: '' });
  });

  it('logs in to the broker and forgets the token on disconnect', async () => {
    const { service, broker, repo } = setup();
    const { id } = service.create('user1', input);
    expect(service.login('user1', id)).toEqual({ kind: 'approval', url: 'https://groww.in/trade-api/api-keys' });
    const connected = await service.connect('user1', id, 'https://127.0.0.1/?code=X');
    expect(broker.exchangeToken).toHaveBeenCalledWith('https://127.0.0.1/?code=X');
    expect(connected).toMatchObject({ loggedIn: true, tokenIssuedAt: NOW.toISOString() });
    expect(repo.find('user1', id)?.accessToken).toBe('token-for-https://127.0.0.1/?code=X');
    expect(service.disconnect('user1', id)).toMatchObject({ loggedIn: false, tokenIssuedAt: null });
  });

  it('treats other users’ accounts as missing', async () => {
    const { service } = setup();
    const { id } = service.create('user1', input);
    expect(() => service.get('user2', id)).toThrow('Account not found.');
    expect(() => service.update('user2', id, {})).toThrow('Account not found.');
    expect(() => service.delete('user2', id)).toThrow('Account not found.');
    expect(() => service.login('user2', id)).toThrow('Account not found.');
    await expect(service.connect('user2', id, 'x')).rejects.toThrow('Account not found.');
    service.delete('user1', id);
    expect(service.list('user1')).toEqual([]);
  });
});
