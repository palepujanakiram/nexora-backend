import { describe, expect, it } from 'vitest';

import { BrokerError } from '../../src/domain/broker-error.ts';
import { BrokerHttp, extractParam, objectOf, parseCsv, redact, redactUrl, splitCsv, type Fetch } from '../../src/brokers/http.ts';
import { fakeFetch, json, memoryLog, noNetwork, text } from '../helpers.ts';

function client(fetch: Fetch, overrides: { dryRun?: boolean; timeoutMs?: number; acquire?: () => Promise<void> } = {}) {
  const log = memoryLog();
  const http = new BrokerHttp({
    broker: 'kite',
    fetch,
    timeoutMs: overrides.timeoutMs ?? 1000,
    dryRun: overrides.dryRun ?? false,
    log,
    ...(overrides.acquire ? { acquire: overrides.acquire } : {}),
  });
  return { http, log };
}

async function brokerError(p: Promise<unknown>): Promise<BrokerError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BrokerError) return e;
    throw e;
  }
  throw new Error('expected a BrokerError');
}

describe('BrokerHttp.send', () => {
  it('sends a JSON body and returns the parsed answer with a redacted record', async () => {
    const fetch = fakeFetch(() => json({ ok: true, access_token: 'AT' }, 201));
    const { http } = client(fetch);
    expect(http.dryRun).toBe(false);
    const res = await http.send({
      kind: 'auth',
      method: 'POST',
      url: 'https://api.test/session?api_key=k&x=1',
      headers: { Authorization: 'token k:s' },
      json: { api_secret: 's', nested: [{ pin: '1234', qty: 1 }] },
    });
    expect(fetch.calls[0]).toMatchObject({
      url: 'https://api.test/session?api_key=k&x=1',
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: 'token k:s', 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_secret: 's', nested: [{ pin: '1234', qty: 1 }] }),
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, access_token: 'AT' });
    expect(res.raw).toEqual({
      request: {
        method: 'POST',
        url: 'https://api.test/session?api_key=%5Bredacted%5D&x=1',
        body: { api_secret: '[redacted]', nested: [{ pin: '[redacted]', qty: 1 }] },
      },
      response: { status: 201, body: { ok: true, access_token: '[redacted]' } },
    });
  });

  it('sends a form body', async () => {
    const fetch = fakeFetch(() => json({}));
    const { http } = client(fetch);
    await http.send({ kind: 'write', method: 'PUT', url: 'https://api.test/orders/1', form: { price: '420.05', checksum: 'c' } });
    expect(fetch.calls[0]!.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(fetch.calls[0]!.body).toBe('price=420.05&checksum=c');
  });

  it('sends no body for GETs and returns non-JSON text as is', async () => {
    const fetch = fakeFetch(() => text('<html>not found</html>', 404));
    const { http } = client(fetch);
    const res = await http.send({ kind: 'read', method: 'GET', url: 'https://api.test/x' });
    expect(fetch.calls[0]!.body).toBeUndefined();
    expect(fetch.calls[0]!.headers['Content-Type']).toBeUndefined();
    expect(res).toMatchObject({ status: 404, body: null, text: '<html>not found</html>' });
    expect(res.raw.request.body).toBeNull();
    expect(res.raw.response).toEqual({ status: 404, body: '<html>not found</html>' });
  });

  it('in dry run blocks only writes and logs the redacted request', async () => {
    const fetch = fakeFetch(() => json({ data: 1 }));
    const { http, log } = client(fetch, { dryRun: true });
    expect(http.dryRun).toBe(true);
    const e = await brokerError(http.send({ kind: 'write', method: 'POST', url: 'https://api.test/orders', form: { qty: '1', access_token: 'AT' } }));
    expect(e.code).toBe('DRY_RUN');
    expect(e.message).toBe('Dry run: not sent to kite.');
    expect(e.raw).toEqual({ request: { method: 'POST', url: 'https://api.test/orders', body: { qty: '1', access_token: '[redacted]' } }, response: null });
    expect(fetch.calls).toHaveLength(0);
    expect(log.lines).toEqual([
      {
        level: 'info',
        obj: { broker: 'kite', dryRunRequest: { method: 'POST', url: 'https://api.test/orders', body: { qty: '1', access_token: '[redacted]' } } },
        msg: 'dry run: broker write not sent',
      },
    ]);
    await http.send({ kind: 'read', method: 'GET', url: 'https://api.test/orders' });
    await http.send({ kind: 'auth', method: 'POST', url: 'https://api.test/session', json: {} });
    expect(fetch.calls).toHaveLength(2);
  });

  it('waits for the rate-limit token before sending', async () => {
    const order: string[] = [];
    const fetch = fakeFetch(() => {
      order.push('fetch');
      return json({});
    });
    const { http } = client(fetch, { acquire: async () => void order.push('acquire') });
    await http.send({ kind: 'read', method: 'GET', url: 'https://api.test/' });
    expect(order).toEqual(['acquire', 'fetch']);
  });

  it('does not send when acquire throws', async () => {
    const fetch = noNetwork();
    const { http } = client(fetch, {
      acquire: async () => {
        throw new BrokerError('RATE_LIMITED', 'wait');
      },
    });
    expect((await brokerError(http.send({ kind: 'read', method: 'GET', url: 'https://api.test/' }))).code).toBe('RATE_LIMITED');
    expect(fetch.calls).toHaveLength(0);
  });

  it('times out even when fetch ignores the abort signal', async () => {
    let signal: AbortSignal | undefined;
    const fetch = fakeFetch((_url, init) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const { http } = client(fetch, { timeoutMs: 20 });
    const e = await brokerError(http.send({ kind: 'write', method: 'POST', url: 'https://api.test/orders', json: { a: 1 } }));
    expect(e.code).toBe('TIMEOUT');
    expect(e.message).toBe('kite did not answer within 20 ms.');
    expect(e.outcomeUnknown).toBe(true);
    expect(e.raw).toEqual({ request: { method: 'POST', url: 'https://api.test/orders', body: { a: 1 } }, response: null });
    expect(signal?.aborted).toBe(true);
  });

  it('times out when the body never arrives', async () => {
    const fetch = fakeFetch(() => ({ status: 200, arrayBuffer: () => new Promise<string>(() => {}) }) as unknown as Response);
    const { http } = client(fetch, { timeoutMs: 20 });
    expect((await brokerError(http.send({ kind: 'read', method: 'GET', url: 'https://api.test/' }))).code).toBe('TIMEOUT');
  });

  it('maps network failures to BROKER_UNAVAILABLE', async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const { http } = client(fetch);
    const e = await brokerError(http.send({ kind: 'read', method: 'GET', url: 'https://api.test/?token=t' }));
    expect(e.code).toBe('BROKER_UNAVAILABLE');
    expect(e.message).toBe("Couldn't reach kite.");
    expect(e.raw).toEqual({ request: { method: 'GET', url: 'https://api.test/?token=%5Bredacted%5D', body: null }, response: null });
  });

  it('maps 429 to RATE_LIMITED and warns', async () => {
    const { http, log } = client(fakeFetch(() => json({ message: 'Too many requests' }, 429)));
    const e = await brokerError(http.send({ kind: 'read', method: 'GET', url: 'https://api.test/' }));
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.message).toBe('kite is rate limiting requests. Try again shortly.');
    expect(e.raw?.response).toEqual({ status: 429, body: { message: 'Too many requests' } });
    expect(log.lines).toEqual([{ level: 'warn', obj: { broker: 'kite', status: 429 }, msg: 'broker rate limit hit' }]);
  });

  it('maps 5xx to BROKER_UNAVAILABLE with the raw response', async () => {
    const { http } = client(fakeFetch(() => text('x'.repeat(3000), 503)));
    const e = await brokerError(http.send({ kind: 'write', method: 'POST', url: 'https://api.test/', json: {} }));
    expect(e.code).toBe('BROKER_UNAVAILABLE');
    expect(e.message).toBe('kite failed (HTTP 503).');
    expect(e.raw?.response).toEqual({ status: 503, body: 'x'.repeat(2000) });
  });
});

describe('redaction helpers', () => {
  it('redacts secret keys recursively, case-insensitively', () => {
    expect(
      redact({ Authorization: 'a', X_PrivateKey: 1, 'x-privatekey': 'k', list: [{ Code: 'c', ok: 1 }, 'plain'], n: null, deep: { refreshToken: 'r' } }),
    ).toEqual({ Authorization: '[redacted]', X_PrivateKey: 1, 'x-privatekey': '[redacted]', list: [{ Code: '[redacted]', ok: 1 }, 'plain'], n: null, deep: { refreshToken: '[redacted]' } });
    expect(redact('text')).toBe('text');
    expect(redact(5)).toBe(5);
  });

  it('redacts secret query parameters and leaves non-URLs alone', () => {
    expect(redactUrl('https://a.test/p?code=123&authkey=x&state=s')).toBe('https://a.test/p?code=%5Bredacted%5D&authkey=%5Bredacted%5D&state=s');
    expect(redactUrl('https://a.test/p')).toBe('https://a.test/p');
    expect(redactUrl('not a url')).toBe('not a url');
  });
});

describe('objectOf', () => {
  it('returns objects and turns everything else into {}', () => {
    expect(objectOf({ a: 1 })).toEqual({ a: 1 });
    expect(objectOf([1])).toEqual({});
    expect(objectOf(null)).toEqual({});
    expect(objectOf('x')).toEqual({});
  });
});

describe('CSV', () => {
  it('splits lines honouring quotes', () => {
    expect(splitCsv('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
    expect(splitCsv('')).toEqual(['']);
    expect(splitCsv('a,,')).toEqual(['a', '', '']);
  });

  it('parses a document with a header, skipping blank lines and short rows', () => {
    expect(parseCsv('sym,name,lot\r\nNIFTY,"Nifty, 50",75\n\nBANK,Bank\n')).toEqual([
      { sym: 'NIFTY', name: 'Nifty, 50', lot: '75' },
      { sym: 'BANK', name: 'Bank' },
    ]);
    expect(parseCsv('')).toEqual([]);
  });
});

describe('extractParam', () => {
  it('takes a direct value, or the parameter from a pasted URL', () => {
    expect(extractParam({ request_token: ' abc ' }, 'request_token')).toBe('abc');
    expect(extractParam({ url: 'https://app.test/cb?request_token=xyz&status=success' }, 'request_token')).toBe('xyz');
  });

  it('throws AUTH_EXPIRED when the parameter is missing', () => {
    const cases: Record<string, string>[] = [{}, { request_token: '  ' }, { url: 'not a url' }, { url: 'https://app.test/cb?status=x' }];
    for (const params of cases) {
      try {
        extractParam(params, 'request_token');
        throw new Error('expected a throw');
      } catch (e) {
        expect(e).toBeInstanceOf(BrokerError);
        expect((e as BrokerError).code).toBe('AUTH_EXPIRED');
        expect((e as BrokerError).message).toBe('No "request_token" in the broker\'s redirect.');
      }
    }
  });
});

describe('decode', () => {
  it('unpacks a raw gzip body and passes plain bodies through', async () => {
    const { gzipSync } = await import('node:zlib');
    const { decode } = await import('../../src/brokers/http.ts');
    expect(decode(gzipSync(Buffer.from('[{"a":1}]')))).toBe('[{"a":1}]');
    expect(decode(Buffer.from('plain'))).toBe('plain');
  });
});
