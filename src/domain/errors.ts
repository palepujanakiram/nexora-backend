/** An error the API returns to the client as `{ error: { code, message } }`. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  /** Extra machine-readable fields, returned as `error.details`. */
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string) => new AppError(400, 'bad_request', message);
export const unauthorized = (message = 'Sign in first.') => new AppError(401, 'unauthorized', message);
export const forbidden = (message: string) => new AppError(403, 'forbidden', message);
export const notFound = (message: string) => new AppError(404, 'not_found', message);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const tooManyRequests = (message: string, retryAfterSeconds: number) =>
  new AppError(429, 'rate_limited', message, { retry_after_seconds: retryAfterSeconds });

/** Free text that can't be parsed into a trade signal. */
export class SignalParseError extends AppError {
  constructor(message: string) {
    super(422, 'invalid_signal', message);
    this.name = 'SignalParseError';
  }
}

/** The SMS provider failed or refused to send a code. */
export class OtpProviderError extends AppError {
  constructor(code: 'otp_send_failed', message: string) {
    super(502, code, message);
    this.name = 'OtpProviderError';
  }
}
