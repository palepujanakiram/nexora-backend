import { describe, expect, it } from 'vitest';

import { PHONE, admin, signIn, testApp } from '../app.ts';
import { defined, anyString, stringMatching, type ErrorBody } from '../helpers.ts';

async function newClient(app: Awaited<ReturnType<typeof testApp>>['app']) {
  const res = await app.inject({ method: 'POST', url: '/admin/clients', headers: admin, payload: { name: 'Android app', platform: 'android' } });
  return res.json<{ id: string }>().id;
}

describe('POST /auth/otp/request', () => {
  it('sends a code to a registered number, given in any common format', async () => {
    const t = await testApp();
    await t.app.inject({ method: 'POST', url: '/admin/users', headers: admin, payload: { phone: '9876543210' } });
    const res = await t.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: '+91 98765-43210' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: true, expiresInSeconds: 300 });
    expect(t.otps).toHaveLength(1);
    expect(t.otps[0]).toMatch(/^\d{6}$/);
  });

  it('answers an unknown number the same way without sending a code', async () => {
    const t = await testApp();
    const res = await t.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: '9123456789' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: true, expiresInSeconds: 300 });
    expect(t.otps).toHaveLength(0);
  });

  it('refuses a body without a phone', async () => {
    const t = await testApp();
    const res = await t.app.inject({ method: 'POST', url: '/auth/otp/request', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().error).toMatchObject({ code: 'bad_request', message: stringMatching(/^phone: /) });
  });
});

describe('POST /auth/otp/verify', () => {
  it('signs in with the right code and returns tokens and the user', async () => {
    const t = await testApp();
    const me = await signIn(t);
    expect(me.accessToken).toBeTruthy();
    expect(me.refreshToken).toBeTruthy();
    const profile = await t.app.inject({ method: 'GET', url: '/me', headers: me.headers });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toEqual({ id: me.userId, phone: '+919876543210', email: null, createdAt: anyString() });
  });

  it('refuses a wrong code with the tries left', async () => {
    const t = await testApp();
    await t.app.inject({ method: 'POST', url: '/admin/users', headers: admin, payload: { phone: PHONE } });
    const clientId = await newClient(t.app);
    await t.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: PHONE } });
    const wrong = t.otps[0] === '000000' ? '111111' : '000000';
    const res = await t.app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone: PHONE, code: wrong, clientId } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'otp_invalid', message: 'Wrong code. 4 tries left.' } });
  });

  it('refuses an unknown client id', async () => {
    const t = await testApp();
    await t.app.inject({ method: 'POST', url: '/admin/users', headers: admin, payload: { phone: PHONE } });
    await t.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: PHONE } });
    const res = await t.app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone: PHONE, code: t.otps[0], clientId: 'cl_nope' } });
    expect(res.statusCode).toBe(401);
    expect(res.json<ErrorBody>().error.code).toBe('unauthorized');
  });
});

describe('POST /auth/refresh', () => {
  it('rotates tokens, and reuse of the old refresh token ends the session', async () => {
    const t = await testApp();
    const me = await signIn(t);
    const first = await t.app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: me.refreshToken, clientId: me.clientId } });
    expect(first.statusCode).toBe(200);
    const rotated = first.json<{ accessToken: string; refreshToken: string }>();
    expect(rotated.refreshToken).not.toBe(me.refreshToken);
    const fresh = { authorization: `Bearer ${rotated.accessToken}` };
    expect((await t.app.inject({ method: 'GET', url: '/me', headers: fresh })).statusCode).toBe(200);

    const reused = await t.app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: me.refreshToken, clientId: me.clientId } });
    expect(reused.statusCode).toBe(401);
    expect(reused.json<ErrorBody>().error.code).toBe('refresh_reused');

    const after = await t.app.inject({ method: 'GET', url: '/me', headers: fresh });
    expect(after.statusCode).toBe(401);
    expect(after.json<ErrorBody>().error.code).toBe('unauthorized');
  });

  it('refuses an unknown refresh token', async () => {
    const t = await testApp();
    const me = await signIn(t);
    const res = await t.app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: 'nope', clientId: me.clientId } });
    expect(res.statusCode).toBe(401);
  });
});

describe('sessions', () => {
  it('lists devices with the current one flagged, and revoking one leaves the other', async () => {
    const t = await testApp();
    const phone = await signIn(t);
    // OTPs issued in the same instant tie on created_at (and ids are random), so move the clock on.
    t.clock.advance(1000);
    const tablet = await signIn(t);
    const list = await t.app.inject({ method: 'GET', url: '/auth/sessions', headers: phone.headers });
    expect(list.statusCode).toBe(200);
    const { sessions } = list.json<{ sessions: { id: string; current: boolean; device: string; clientId: string }[] }>();
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ device: 'iPhone', ip: '127.0.0.1', createdAt: anyString(), lastUsedAt: anyString(), expiresAt: anyString() });
    const other = defined(sessions.find((s) => !s.current));
    expect(other.clientId).toBe(tablet.clientId);

    const revoked = await t.app.inject({ method: 'DELETE', url: `/auth/sessions/${other.id}`, headers: phone.headers });
    expect(revoked.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: '/me', headers: tablet.headers })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/me', headers: phone.headers })).statusCode).toBe(200);

    const again = await t.app.inject({ method: 'DELETE', url: `/auth/sessions/${other.id}`, headers: phone.headers });
    expect(again.statusCode).toBe(404);
  });

  it('logs out the current session', async () => {
    const t = await testApp();
    const me = await signIn(t);
    const res = await t.app.inject({ method: 'POST', url: '/auth/logout', headers: me.headers });
    expect(res.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: '/me', headers: me.headers })).statusCode).toBe(401);
  });

  it('refuses a missing or invalid bearer token', async () => {
    const t = await testApp();
    const none = await t.app.inject({ method: 'GET', url: '/me' });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ error: { code: 'unauthorized', message: 'Sign in first.' } });
    const basic = await t.app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Basic abc' } });
    expect(basic.statusCode).toBe(401);
    const junk = await t.app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Bearer not.a.jwt' } });
    expect(junk.statusCode).toBe(401);
    expect(junk.json<ErrorBody>().error.code).toBe('unauthorized');
  });
});

describe('GET /.well-known/jwks.json', () => {
  it('publishes the Ed25519 public key with a cache header', async () => {
    const t = await testApp();
    const res = await t.app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    const { keys } = res.json<{ keys: Record<string, unknown>[] }>();
    expect(keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', kid: 'k1', x: anyString() });
    expect(JSON.stringify(keys)).not.toContain('"d"');
  });
});
