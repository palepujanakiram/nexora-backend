import { describe, expect, it } from 'vitest';

import { MSG91_BASE, Msg91Otp } from '../../src/brokers/msg91.ts';
import { fakeFetch, json, text } from '../helpers.ts';

const client = (fetch: ReturnType<typeof fakeFetch>) => new Msg91Otp({ fetch, authKey: 'AUTHKEY123', templateId: 'TPL1' });

describe('Msg91Otp', () => {
  it('sends a code with the template, length and expiry, and the key only in the authkey header', async () => {
    const fetch = fakeFetch(() => json({ type: 'success', request_id: 'r1' }));
    await client(fetch).send('919876543210', { length: 6, expiryMinutes: 5 });
    const call = fetch.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${MSG91_BASE}/otp?template_id=TPL1&mobile=919876543210&otp_length=6&otp_expiry=5`);
    expect(call.headers).toEqual({ authkey: 'AUTHKEY123', accept: 'application/json', 'content-type': 'application/json' });
    expect(call.body).toBe('{}');
  });

  it('verifies a code', async () => {
    const fetch = fakeFetch(() => json({ type: 'success', message: 'OTP verified success' }));
    expect(await client(fetch).verify('919876543210', '123456')).toBe(true);
    const call = fetch.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe(`${MSG91_BASE}/otp/verify?otp=123456&mobile=919876543210`);
    expect(call.headers).toEqual({ authkey: 'AUTHKEY123', accept: 'application/json' });
    expect(call.body).toBeUndefined();
  });

  it('treats wrong, expired or used codes as a failed check', async () => {
    for (const message of ['OTP not match', 'OTP expired', 'Mobile no. already verified', 'Max limit reached for this otp verification']) {
      const fetch = fakeFetch(() => json({ type: 'error', message }));
      expect(await client(fetch).verify('919876543210', '123456')).toBe(false);
    }
  });

  it('turns provider failures into otp_provider_error without leaking the key', async () => {
    const cases = [
      { fetch: fakeFetch(() => json({ type: 'error', message: 'Invalid authkey' })), op: 'verify', msg: "Couldn't check the code: Invalid authkey" },
      { fetch: fakeFetch(() => json({ type: 'error', message: 'Template not found' })), op: 'send', msg: "Couldn't send the code: Template not found" },
      { fetch: fakeFetch(() => json({ type: 'error' })), op: 'send', msg: "Couldn't send the code: no reason given" },
      { fetch: fakeFetch(() => json({ type: 'error', message: 'Unauthorized' }, 401)), op: 'send', msg: 'The SMS provider failed (HTTP 401): Unauthorized' },
      { fetch: fakeFetch(() => text('<html>bad gateway</html>', 502)), op: 'verify', msg: 'The SMS provider failed (HTTP 502).' },
      { fetch: fakeFetch(() => Promise.reject(new Error('ECONNRESET AUTHKEY123'))), op: 'send', msg: "Couldn't reach the SMS provider. Try again." },
    ] as const;
    for (const { fetch, op, msg } of cases) {
      const api = client(fetch);
      const run = op === 'send' ? api.send('919876543210', { length: 6, expiryMinutes: 5 }) : api.verify('919876543210', '123456');
      const error = await run.then(
        () => null,
        (e: unknown) => e as Error & { status: number; code: string },
      );
      expect(error).toMatchObject({ status: 502, code: 'otp_provider_error', message: msg });
      expect(error!.message).not.toContain('AUTHKEY123');
    }
  });
});
