import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

import { InstrumentRepository } from '../../src/data/instruments.ts';
import { signIn, testApp } from '../app.ts';
import { NOW } from '../helpers.ts';

const INSTRUMENT = 'NFO:CE:NIFTY:2026-10-29:2450000';

/**
 * Opens `/stream`, collecting every message and the close code from the very
 * start. injectWS fakes the upgrade request without a socket, so one is
 * supplied: Fastify reads the client address from it (trustProxy).
 */
async function connect(app: FastifyInstance, path: string, headers: Record<string, string> = {}) {
  await app.ready();
  const messages: Record<string, unknown>[] = [];
  let resolveClose: (v: { code: number; reason: string }) => void = () => {};
  const closed = new Promise<{ code: number; reason: string }>((r) => (resolveClose = r));
  const waiters: (() => void)[] = [];
  const ws: WebSocket = await app.injectWS(path, { headers, socket: { remoteAddress: '127.0.0.1' } } as never, {
    onInit: (socket) => {
      socket.on('message', (data) => {
        messages.push(JSON.parse(String(data)));
        for (const w of waiters.splice(0)) w();
      });
      socket.on('close', (code, reason) => resolveClose({ code, reason: String(reason) }));
    },
  });
  const until = async (pred: () => boolean) => {
    while (!pred()) await new Promise<void>((r) => waiters.push(r));
  };
  return { ws, messages, closed, until };
}

describe('WS /stream', () => {
  it('says ready, then pushes leg updates for the user’s orders', async () => {
    const t = await testApp();
    await new InstrumentRepository(t.services.db).upsertFromBroker(
      'zerodha',
      [{ exchange: 'NFO', type: 'CE', underlying: 'NIFTY', expiry: '2026-10-29', strikePaise: 2450000, lotSize: 75, tickPaise: 5, symbol: { nativeId: '12345', tradingSymbol: 'X', exchange: 'NFO' } }],
      NOW,
    );
    const me = await signIn(t);
    const paper = (await t.app.inject({ method: 'POST', url: '/broker-accounts', headers: me.headers, payload: { broker: 'zerodha', label: 'Paper' } })).json().account.id;

    const s = await connect(t.app, `/stream?access_token=${me.accessToken}`);
    await s.until(() => s.messages.length >= 1);
    expect(s.messages[0]).toEqual({ type: 'ready' });

    const placed = await t.app.inject({
      method: 'POST',
      url: '/orders',
      headers: { ...me.headers, 'idempotency-key': 'key-stream-001' },
      payload: { instrumentId: INSTRUMENT, side: 'BUY', quantity: 75, orderType: 'MARKET', product: 'INTRADAY', referencePrice: '120', accountIds: [paper] },
    });
    expect(placed.statusCode).toBe(207);
    await s.until(() => s.messages.some((m) => m['type'] === 'leg' && (m['leg'] as { status: string }).status === 'FILLED'));
    const legs = s.messages.filter((m) => m['type'] === 'leg');
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.at(-1)).toMatchObject({ type: 'leg', leg: { accountId: paper, status: 'FILLED' } });

    s.ws.terminate();
    await s.closed;
  });

  it('accepts the token in an Authorization header too', async () => {
    const t = await testApp();
    const me = await signIn(t);
    const s = await connect(t.app, '/stream', { authorization: `Bearer ${me.accessToken}` });
    await s.until(() => s.messages.length >= 1);
    expect(s.messages[0]).toEqual({ type: 'ready' });
    s.ws.terminate();
  });

  it('closes with 4401 for a bad or missing token', async () => {
    const t = await testApp();
    const bad = await connect(t.app, '/stream?access_token=nope');
    expect((await bad.closed).code).toBe(4401);
    expect(bad.messages).toEqual([]);

    const missing = await connect(t.app, '/stream');
    const closed = await missing.closed;
    expect(closed.code).toBe(4401);
    expect(closed.reason).toBe('Invalid access token.');
  });

  it('closes with a generic reason when authentication fails unexpectedly', async () => {
    const t = await testApp();
    vi.spyOn(t.services.identity, 'authenticate').mockRejectedValueOnce(new Error('db down'));
    const s = await connect(t.app, '/stream?access_token=x');
    expect(await s.closed).toEqual({ code: 4401, reason: 'Unauthorized' });
  });
});
