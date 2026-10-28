/** An error the API returns to the client as `{ error: { code, message } }`. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string) => new AppError(400, 'bad_request', message);
export const unauthorized = (message = 'Sign in first.') => new AppError(401, 'unauthorized', message);
export const forbidden = (message: string) => new AppError(403, 'forbidden', message);
export const notFound = (message: string) => new AppError(404, 'not_found', message);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const tooManyRequests = (message: string) => new AppError(429, 'rate_limited', message);

/** Free text that can't be parsed into a trade signal. */
export class SignalParseError extends AppError {
  constructor(message: string) {
    super(422, 'invalid_signal', message);
    this.name = 'SignalParseError';
  }
}

/** A broker API failure: HTTP error, rejected order, expired token. */
export class BrokerApiError extends AppError {
  constructor(message: string) {
    super(502, 'broker_error', message);
    this.name = 'BrokerApiError';
  }
}

/** The SMS provider (MSG91) failed or refused to send or check a code. */
export class OtpProviderError extends AppError {
  constructor(message: string) {
    super(502, 'otp_provider_error', message);
    this.name = 'OtpProviderError';
  }
}
