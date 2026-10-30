import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { LOGGABLE_FIELDS, allowlisted, createLogger, traceFrom, traceparent } from '../src/logging.ts';
import { defined, parseJson } from './helpers.ts';

/** A pino destination that keeps each JSON line, parsed. */
function sink() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      for (const line of String(chunk).split('\n').filter(Boolean)) lines.push(parseJson(line) as Record<string, unknown>);
      done();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('writes only allowlisted fields', () => {
    const { lines, stream } = sink();
    const log = createLogger('info', stream);
    log.info({ broker: 'kite', accountId: 'ba_1', apiSecret: 's3cret', accessToken: 'AT', password: 'p' }, 'linked');
    expect(lines).toHaveLength(1);
    const line = defined(lines[0]);
    expect(line).toMatchObject({ level: 30, msg: 'linked', broker: 'kite', accountId: 'ba_1' });
    expect(JSON.stringify(line)).not.toMatch(/s3cret|AT"|apiSecret|accessToken|password/);
    for (const key of Object.keys(line)) expect(LOGGABLE_FIELDS.has(key)).toBe(true);
  });

  it('drops the query string from request URLs and serializes res and err', () => {
    const { lines, stream } = sink();
    const log = createLogger('info', stream);
    log.info({ req: { method: 'GET', url: '/broker-callback?request_token=abc&state=s', ip: '1.2.3.4', headers: { authorization: 'x' } } }, 'request');
    log.info({ req: { method: 'GET' } }, 'no url');
    log.info({ res: { statusCode: 201, headers: {} } }, 'response');
    const err = Object.assign(new Error('boom'), { code: 'E_X' });
    log.error({ err }, 'failed');
    expect(defined(lines[0])['req']).toEqual({ method: 'GET', url: '/broker-callback', ip: '1.2.3.4' });
    expect(defined(lines[1])['req']).toEqual({ method: 'GET' });
    expect(defined(lines[2])['res']).toEqual({ statusCode: 201 });
    expect(defined(lines[3])['err']).toMatchObject({ type: 'Error', message: 'boom', code: 'E_X' });
    expect((defined(lines[3])['err'] as { stack: string }).stack).toContain('boom');
  });

  it('respects the level', () => {
    const { lines, stream } = sink();
    const log = createLogger('warn', stream);
    log.info({}, 'hidden');
    log.warn({}, 'shown');
    expect(lines.map((l) => l['msg'])).toEqual(['shown']);
    expect(createLogger('silent').level).toBe('silent');
  });

  it('allowlists plain objects', () => {
    expect(allowlisted({ msg: 'm', token: 't', code: 'c' })).toEqual({ msg: 'm', code: 'c' });
  });
});

describe('trace context', () => {
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const SPAN = '00f067aa0ba902b7';

  it('continues a valid traceparent with a new span', () => {
    const t = traceFrom(`00-${TRACE}-${SPAN}-01`);
    expect(t.traceId).toBe(TRACE);
    expect(t.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(t.spanId).not.toBe(SPAN);
    expect(traceFrom([`00-${TRACE}-${SPAN}-00`, 'other']).traceId).toBe(TRACE);
  });

  it('starts a new trace for missing, invalid or all-zero headers', () => {
    for (const header of [undefined, '', 'garbage', `01-${TRACE}-${SPAN}-01`, `00-${TRACE.toUpperCase()}-${SPAN}-01`, `00-${'0'.repeat(32)}-${SPAN}-01`, []]) {
      const t = traceFrom(header);
      expect(t.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(t.traceId).not.toBe(TRACE);
      expect(t.traceId).not.toBe('0'.repeat(32));
    }
    expect(traceFrom(undefined).traceId).not.toBe(traceFrom(undefined).traceId);
  });

  it('formats a traceparent header', () => {
    expect(traceparent({ traceId: TRACE, spanId: SPAN })).toBe(`00-${TRACE}-${SPAN}-01`);
    const t = traceFrom(undefined);
    expect(traceFrom(traceparent(t)).traceId).toBe(t.traceId);
  });
});
