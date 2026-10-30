import { randomBytes } from 'node:crypto';

import pino from 'pino';

/** The logging calls the app uses (a subset of pino's). */
export interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  child(bindings: object): Log;
}

/**
 * The only fields that ever reach the log. Redaction lives here, at the
 * logger, rather than at call sites: a field nobody listed is dropped, so a
 * secret added to a log call by mistake never gets written.
 */
export const LOGGABLE_FIELDS = new Set([
  // pino and Fastify
  'level', 'time', 'pid', 'hostname', 'msg', 'reqId', 'req', 'res', 'responseTime', 'err',
  // correlation and tracing
  'traceId', 'spanId', 'correlationId', 'parentOrderId', 'legId', 'accountId', 'userId', 'sessionId', 'clientId',
  // what happened
  'broker', 'op', 'status', 'fromStatus', 'toStatus', 'code', 'attempt', 'durationMs', 'count', 'job', 'event',
  'reason', 'outcome', 'mode', 'dryRunRequest',
]);

export function allowlisted(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => LOGGABLE_FIELDS.has(k)));
}

/** Structured JSON logs to stdout. Request URLs are logged without their query string (it may carry a token). */
export function createLogger(level: string, destination?: pino.DestinationStream): pino.Logger {
  return pino(
    {
      level,
      formatters: { log: allowlisted },
      serializers: {
        req: (req: { method?: string; url?: string; ip?: string }) => ({
          method: req.method,
          url: req.url?.split('?')[0],
          ip: req.ip,
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
        err: (err: Error & { code?: unknown }) => ({ type: err.name, message: err.message, code: err.code, stack: err.stack }),
      },
    },
    destination,
  );
}

/** A W3C trace context (`traceparent`): `00-<trace id>-<span id>-01`. */
export interface TraceContext {
  traceId: string;
  spanId: string;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** Continues the caller's trace when it sent a valid `traceparent`, else starts one. Always a new span. */
export function traceFrom(header: string | string[] | undefined): TraceContext {
  const value = Array.isArray(header) ? header[0] : header;
  const m = value ? TRACEPARENT.exec(value) : null;
  const traceId = m && !/^0+$/.test(m[1]!) ? m[1]! : randomBytes(16).toString('hex');
  return { traceId, spanId: randomBytes(8).toString('hex') };
}

export const traceparent = (t: TraceContext) => `00-${t.traceId}-${t.spanId}-01`;
