import { describe, expect, it, vi } from 'vitest';

import type { BrokerApi } from '../../src/brokers/broker-api.ts';
import { AccountRepository } from '../../src/data/accounts.ts';
import { SecretBox } from '../../src/data/crypto.ts';
import { openDb } from '../../src/data/db.ts';
import { ExecutionRepository } from '../../src/data/executions.ts';
import { UserRepository } from '../../src/data/users.ts';
import type { BrokerAccount } from '../../src/domain/account.ts';
import { BrokerApiError } from '../../src/domain/errors.ts';
import { SignalParser } from '../../src/domain/signal-parser.ts';
import { DEFAULT_EXECUTION_SETTINGS } from '../../src/domain/trade.ts';
import { ExecuteSignalService, type ExecuteInput } from '../../src/usecases/execute-signal.ts';
import { NOW, TEST_KEY, account, clock } from '../helpers.ts';

const TEXT = 'BUY SENSEX 29 OCT 73100 PUT AT 400-420 WITH SL OF 300 TGT1 540, TGT2 600';
const inst = { symbol: 'SENSEX26O2973100PE', exchange: 'BFO', lotSize: 20, tickSize: 0.05 };

function setup({ liveTrading = true, accounts = [account()] as BrokerAccount[] } = {}) {
  const db = openDb(':memory:');
  new UserRepository(db).create({ id: 'user1', email: 'a@b.c', phone: null, createdAt: NOW }, 'h');
  const repo = new AccountRepository(db, new SecretBox(TEST_KEY));
  for (const a of accounts) repo.save(a);
  const executions = new ExecutionRepository(db);
  const broker = {
    login: vi.fn(),
    exchangeToken: vi.fn(),
    resolve: vi.fn(async () => inst),
    placeTrade: vi.fn(async () => [{ kind: 'ENTRY', id: 'O1' }]),
  } satisfies BrokerApi;
  let now = NOW;
  const service = new ExecuteSignalService({
    accounts: repo,
    executions,
    brokers: () => broker,
    parser: new SignalParser(clock),
    clock: () => now,
    random: () => 0.123456789,
    liveTrading,
    duplicateWindowMs: 15 * 60 * 1000,
  });
  return { service, broker, executions, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const run = (overrides: Partial<ExecuteInput> = {}): ExecuteInput => ({
  text: TEXT,
  accountIds: ['acc1'],
  settings: DEFAULT_EXECUTION_SETTINGS,
  allowDuplicate: false,
  ...overrides,
});

describe('ExecuteSignalService', () => {
  it('parses signals for previews', () => {
    expect(setup().service.parse(TEXT).underlying).toBe('SENSEX');
  });

  it('places a live trade with the resolved contract, lots and exits, and records it', async () => {
    const { service, broker, executions } = setup();
    const [result] = await service.execute('user1', run());
    expect(broker.placeTrade).toHaveBeenCalledWith(inst, {
      signal: expect.objectContaining({ underlying: 'SENSEX' }),
      quantity: 40,
      entryPrice: 420,
      product: 'carryForward',
      stopLoss: 300,
      target: 540,
    });
    expect(result).toMatchObject({
      accountId: 'acc1',
      accountLabel: 'Main',
      broker: 'Zerodha (Kite Connect)',
      paper: false,
      symbol: 'SENSEX26O2973100PE',
      quantity: 40,
      entryPrice: 420,
      orders: [{ kind: 'ENTRY', id: 'O1' }],
      error: null,
      errorCode: null,
    });
    expect(executions.list('user1', 10)).toEqual([result]);
  });

  it('honours entry price, exit mode and target settings', async () => {
    const { service, broker } = setup();
    await service.execute('user1', run({ settings: { entryPriceMode: 'mid', exitMode: 'entryOnly', targetIndex: 1 } }));
    expect(broker.placeTrade).toHaveBeenCalledWith(inst, expect.objectContaining({ entryPrice: 410, stopLoss: null, target: null }));
    await service.execute('user1', run({ settings: { ...DEFAULT_EXECUTION_SETTINGS, targetIndex: 1 }, allowDuplicate: true }));
    expect(broker.placeTrade).toHaveBeenLastCalledWith(inst, expect.objectContaining({ target: 600 }));
  });

  it('paper trades never call the broker to place orders', async () => {
    const { service, broker } = setup({ accounts: [account({ paperMode: true })] });
    const [result] = await service.execute('user1', run());
    expect(broker.placeTrade).not.toHaveBeenCalled();
    expect(broker.resolve).toHaveBeenCalled();
    expect(result).toMatchObject({
      paper: true,
      quantity: 40,
      orders: [
        { kind: 'ENTRY (paper)', id: 'PAPER-123456789' },
        { kind: 'SL 300 / TGT 540 (paper)', id: '-' },
      ],
    });
  });

  it('paper trades without a broker session use the signal itself', async () => {
    const { service, broker } = setup({ accounts: [account({ paperMode: true, accessToken: null })] });
    const [result] = await service.execute('user1', run({ settings: { ...DEFAULT_EXECUTION_SETTINGS, exitMode: 'entryOnly' } }));
    expect(broker.resolve).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      symbol: 'SENSEX 29 OCT 2026 73100 PE',
      quantity: null,
      entryPrice: 420,
      orders: [{ kind: 'ENTRY (paper)', id: 'PAPER-123456789' }],
      error: null,
    });
  });

  it('refuses live orders when the server switch is off or the session expired', async () => {
    const off = setup({ liveTrading: false });
    const [blocked] = await off.service.execute('user1', run());
    expect(blocked!.error).toBe('Live trading is turned off on this server (LIVE_TRADING).');
    expect(off.broker.placeTrade).not.toHaveBeenCalled();

    const expired = setup({ accounts: [account({ accessToken: null })] });
    const [result] = await expired.service.execute('user1', run());
    expect(result!.error).toBe('Session expired — log in to Main first.');
  });

  it('returns broker failures per account without failing the others', async () => {
    const { service, broker } = setup({ accounts: [account(), account({ id: 'acc2', label: 'Second' })] });
    broker.placeTrade.mockRejectedValueOnce(new BrokerApiError('Kite: Insufficient funds'));
    const results = await service.execute('user1', run({ accountIds: ['acc1', 'acc2', 'acc1'] }));
    expect(results.map((r) => r.error)).toEqual(['Kite: Insufficient funds', null]);
    expect(results[0]).toMatchObject({ symbol: 'SENSEX26O2973100PE', quantity: 40, entryPrice: 420 });

    broker.resolve.mockRejectedValueOnce('plain failure');
    const [failed] = await service.execute('user1', run({ accountIds: ['acc1'], allowDuplicate: true }));
    expect(failed).toMatchObject({ error: 'plain failure', symbol: 'SENSEX 29 OCT 2026 73100 PE', quantity: null });
  });

  it('refuses the same signal on the same account within the window, unless forced', async () => {
    const { service, broker, advance } = setup();
    await service.execute('user1', run());
    advance(5 * 60 * 1000);
    const [repeat] = await service.execute('user1', run({ text: TEXT.toLowerCase() }));
    expect(repeat!.errorCode).toBe('duplicate');
    expect(repeat!.error).toBe(
      'Already placed on this account at 09:30 IST (maybe from another device). Send it again with "place anyway" to repeat it.',
    );
    expect(broker.placeTrade).toHaveBeenCalledTimes(1);

    const [forced] = await service.execute('user1', run({ allowDuplicate: true }));
    expect(forced!.error).toBeNull();
    advance(16 * 60 * 1000);
    const [later] = await service.execute('user1', run());
    expect(later!.error).toBeNull();
    expect(broker.placeTrade).toHaveBeenCalledTimes(3);
  });

  it('refuses a second request for the same signal while the first is still placing', async () => {
    const { service, broker } = setup();
    let release!: () => void;
    broker.resolve.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(inst))));
    const first = service.execute('user1', run());
    const [second] = await service.execute('user1', run({ allowDuplicate: true }));
    expect(second!.error).toBe('This signal is already being placed on this account from another device.');
    expect(second!.errorCode).toBe('in_flight');
    release();
    expect((await first)[0]!.error).toBeNull();
    expect(broker.placeTrade).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown accounts and bad signals before placing anything', async () => {
    const { service, broker } = setup();
    await expect(service.execute('user1', run({ accountIds: ['acc1', 'missing'] }))).rejects.toThrow('Account missing not found.');
    await expect(service.execute('user2', run())).rejects.toThrow('Account acc1 not found.');
    await expect(service.execute('user1', run({ text: 'hello' }))).rejects.toMatchObject({ status: 422 });
    expect(broker.placeTrade).not.toHaveBeenCalled();
  });
});
