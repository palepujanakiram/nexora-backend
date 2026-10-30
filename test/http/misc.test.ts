import { describe, expect, it, vi } from 'vitest';

import { BrokerError } from '../../src/domain/broker-error.ts';
import { AppError } from '../../src/domain/errors.ts';
import { EGRESS_IP_URL } from '../../src/http/routes/market.ts';
import { admin, signIn, testApp } from '../app.ts';
import { fakeFetch, json, text, type ErrorBody } from '../helpers.ts';

describe('health and routing', () => {
  it('reports health with version and flags', async () => {
    const { app } = await testApp({ env: { LIVE_TRADING: 'true' } });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'nexora-backend', version: '2.0.0', liveTrading: true, billing: false });
  });

  it('answers unknown endpoints with a JSON 404', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'No such endpoint.' } });
  });
});

describe('CORS', () => {
  it('allows only the configured origins', async () => {
    const { app } = await testApp({ env: { CORS_ORIGINS: 'https://app.nexora.test, https://admin.nexora.test' } });
    const ok = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://app.nexora.test' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.nexora.test');
    const other = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.test' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sends no CORS headers when no origins are configured', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://app.nexora.test' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('tracing', () => {
  it('continues a valid incoming traceparent with a new span', async () => {
    const { app } = await testApp();
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const res = await app.inject({ method: 'GET', url: '/health', headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` } });
    const header = String(res.headers['traceparent']);
    expect(header).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    expect(header).not.toContain('00f067aa0ba902b7');
  });

  it('starts a new trace when the incoming traceparent is invalid or missing', async () => {
    const { app } = await testApp();
    const bad = await app.inject({ method: 'GET', url: '/health', headers: { traceparent: 'garbage' } });
    expect(String(bad.headers['traceparent'])).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const zero = await app.inject({ method: 'GET', url: '/health', headers: { traceparent: `00-${'0'.repeat(32)}-00f067aa0ba902b7-01` } });
    expect(String(zero.headers['traceparent'])).not.toContain('0'.repeat(32));
    const none = await app.inject({ method: 'GET', url: '/health' });
    expect(String(none.headers['traceparent'])).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});

describe('error handler', () => {
  it('turns an AppError into its status, with details only when present', async () => {
    const t = await testApp();
    const me = await signIn(t);
    vi.spyOn(t.services.brokerAccounts, 'list').mockRejectedValueOnce(new AppError(418, 'teapot', 'Short and stout.'));
    const plain = await t.app.inject({ method: 'GET', url: '/broker-accounts', headers: me.headers });
    expect(plain.statusCode).toBe(418);
    expect(plain.json()).toEqual({ error: { code: 'teapot', message: 'Short and stout.' } });

    vi.spyOn(t.services.brokerAccounts, 'list').mockRejectedValueOnce(new AppError(409, 'busy', 'Wait.', { retry: 2 }));
    const detailed = await t.app.inject({ method: 'GET', url: '/broker-accounts', headers: me.headers });
    expect(detailed.statusCode).toBe(409);
    expect(detailed.json()).toEqual({ error: { code: 'busy', message: 'Wait.', details: { retry: 2 } } });
  });

  it('maps a BrokerError to 401 when the session expired and 502 otherwise', async () => {
    const t = await testApp();
    const me = await signIn(t);
    vi.spyOn(t.services.brokerAccounts, 'list').mockRejectedValueOnce(new BrokerError('AUTH_EXPIRED', 'Log in to Kite again.'));
    const expired = await t.app.inject({ method: 'GET', url: '/broker-accounts', headers: me.headers });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toEqual({ error: { code: 'broker_error', message: 'Log in to Kite again.', details: { code: 'AUTH_EXPIRED' } } });

    vi.spyOn(t.services.brokerAccounts, 'list').mockRejectedValueOnce(new BrokerError('BROKER_UNAVAILABLE', 'Kite is down.'));
    const down = await t.app.inject({ method: 'GET', url: '/broker-accounts', headers: me.headers });
    expect(down.statusCode).toBe(502);
    expect(down.json()).toEqual({ error: { code: 'broker_error', message: 'Kite is down.', details: { code: 'BROKER_UNAVAILABLE' } } });
  });

  it('answers malformed JSON with 400 bad_request', async () => {
    const { app } = await testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: { ...admin, 'content-type': 'application/json' },
      payload: '{"phone":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().error.code).toBe('bad_request');
    expect(res.json<ErrorBody>().error.message).toMatch(/JSON/i);
  });

  it('hides unexpected errors behind a generic 500', async () => {
    const t = await testApp();
    const me = await signIn(t);
    vi.spyOn(t.services.brokerAccounts, 'list').mockRejectedValueOnce(new Error('connection reset: password=hunter2'));
    const res = await t.app.inject({ method: 'GET', url: '/broker-accounts', headers: me.headers });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal', message: 'Something went wrong on the server.' } });
    expect(res.body).not.toContain('hunter2');
  });

  it('rate-limits sign-in routes with a 429', async () => {
    const { app } = await testApp({ env: { AUTH_RATE_LIMIT_PER_MINUTE: '2' } });
    const ask = async () => app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: '9000000001' } });
    expect((await ask()).statusCode).toBe(200);
    expect((await ask()).statusCode).toBe(200);
    const res = await ask();
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' } });
  });
});

describe('GET /server/ip', () => {
  it('returns the egress IP from ipify', async () => {
    const fetch = fakeFetch((url) => (url === EGRESS_IP_URL ? json({ ip: '203.0.113.7' }) : text('no', 500)));
    const t = await testApp({ fetch });
    const me = await signIn(t);
    const res = await t.app.inject({ method: 'GET', url: '/server/ip', headers: me.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ip: '203.0.113.7', liveTrading: false });
    expect(fetch.calls.map((c) => c.url)).toEqual([EGRESS_IP_URL]);
  });

  it('answers 502 ip_lookup_failed when the lookup fails or returns no ip', async () => {
    let answer: () => Response = () => {
      throw new Error('offline');
    };
    const t = await testApp({ fetch: fakeFetch(() => answer()) });
    const me = await signIn(t);
    const thrown = await t.app.inject({ method: 'GET', url: '/server/ip', headers: me.headers });
    expect(thrown.statusCode).toBe(502);
    expect(thrown.json()).toEqual({ error: { code: 'ip_lookup_failed', message: 'Could not look up the server IP. Try again.' } });
    answer = () => json({ ip: '' });
    expect((await t.app.inject({ method: 'GET', url: '/server/ip', headers: me.headers })).statusCode).toBe(502);
    answer = () => text('not json');
    expect((await t.app.inject({ method: 'GET', url: '/server/ip', headers: me.headers })).statusCode).toBe(502);
  });
});
