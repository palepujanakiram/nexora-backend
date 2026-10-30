import { describe, expect, it } from 'vitest';

import { ConsoleOtp, MSG91_BASE, Msg91Sms } from '../../src/brokers/msg91.ts';
import { OtpProviderError } from '../../src/domain/errors.ts';
import { fakeFetch, json, text, type FakeFetch } from '../helpers.ts';

const sms = (fetch: FakeFetch) => new Msg91Sms({ fetch, authKey: 'AUTHKEY', templateId: 'TPL1' });
const to = { phone: '919876543210', email: null };

async function otpError(p: Promise<unknown>): Promise<OtpProviderError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OtpProviderError) return e;
    throw e;
  }
  throw new Error('expected an OtpProviderError');
}

describe('Msg91Sms', () => {
  it('sends our code in the otp query parameter with the authkey header', async () => {
    const fetch = fakeFetch(() => json({ type: 'success', message: 'sent' }));
    const channel = sms(fetch);
    expect(channel.name).toBe('sms');
    expect(channel.canReach()).toBe(true);
    await channel.send(to, '123456', 5);
    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0]!;
    const url = new URL(call.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${MSG91_BASE}/otp`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      template_id: 'TPL1',
      mobile: '919876543210',
      otp: '123456',
      otp_length: '6',
      otp_expiry: '5',
    });
    expect(call.method).toBe('POST');
    expect(call.headers).toEqual({ authkey: 'AUTHKEY', accept: 'application/json', 'content-type': 'application/json' });
    expect(call.body).toBe('{}');
    expect(call.url).not.toContain('AUTHKEY');
  });

  it('fails on an error answer with the provider message', async () => {
    const e = await otpError(sms(fakeFetch(() => json({ type: 'error', message: 'Invalid template' }))).send(to, '1234', 5));
    expect([e.status, e.code, e.message]).toEqual([502, 'otp_send_failed', 'The SMS provider refused: Invalid template']);
  });

  it('fails on an HTTP error even when the body says success', async () => {
    const e = await otpError(sms(fakeFetch(() => json({ type: 'success' }, 401))).send(to, '1234', 5));
    expect(e.message).toBe('The SMS provider refused: HTTP 401');
  });

  it('fails on a non-JSON answer', async () => {
    const e = await otpError(sms(fakeFetch(() => text('<html>bad gateway</html>', 502))).send(to, '1234', 5));
    expect(e.message).toBe('The SMS provider refused: HTTP 502');
    const ok = await otpError(sms(fakeFetch(() => text('ok', 200))).send(to, '1234', 5));
    expect(ok.message).toBe('The SMS provider refused: HTTP 200');
  });

  it('fails when MSG91 is unreachable', async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const e = await otpError(sms(fetch).send(to, '1234', 5));
    expect([e.code, e.message]).toEqual(['otp_send_failed', "Couldn't reach the SMS provider."]);
  });
});

describe('ConsoleOtp', () => {
  it('prints the code', async () => {
    const lines: string[] = [];
    const channel = new ConsoleOtp((line) => lines.push(line));
    expect(channel.name).toBe('console');
    expect(channel.canReach()).toBe(true);
    await channel.send(to, '654321');
    expect(lines).toEqual(['[dev] OTP for +919876543210: 654321']);
  });
});
