# nexora-backend API

Every request and response is JSON. Except for `GET /health`, `POST /v1/auth/register`, `POST /v1/auth/login` and `POST /v1/auth/otp/start` / `verify`, send the token from sign-in:

```
Authorization: Bearer <token>
```

Errors always look like this, with an HTTP status to match:

```json
{ "error": { "code": "bad_request", "message": "Enter the API key." } }
```

Some errors add machine-readable `details`, e.g. `{ "retry_after_seconds": 540 }` on an OTP `429`.

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | Missing or invalid fields. The message names the field. |
| 401 | `unauthorized` | No token, or the session ended or expired. Sign in again. |
| 403 | `forbidden` | Registration closed or wrong invite code. |
| 404 | `not_registered` | OTP sign-in for a number with no login: send the invite code too (or sign-up is closed). |
| 401 | `otp_invalid` | Wrong SMS code. The message says how many tries are left. |
| 401 | `otp_expired` | No live code for this number (expired, already used, or never sent). Ask for a new one. |
| 429 | `otp_attempts` | Too many wrong codes. Ask for a new one. |
| 404 | `not_found` | No such account (or it belongs to someone else), or no such endpoint. |
| 409 | `conflict` | Email already registered. |
| 422 | `invalid_signal` | The signal text can't be parsed. |
| 429 | `rate_limited` | Too many requests, or too many SMS codes (`details.retry_after_seconds` says how long to wait). |
| 502 | `broker_error` | The broker refused or failed. The message is the broker's. |
| 502 | `otp_send_failed` / `otp_verify_failed` | MSG91 failed to send or check a code. |
| 503 | `otp_unavailable` | Mobile sign-in isn't set up on this server (no `MSG91_AUTH_KEY` / `MSG91_TEMPLATE_ID`). |
| 500 | `internal` | A bug. Details are in the server log only. |

## Health

`GET /health` (no sign-in needed)

```json
{ "status": "ok", "service": "nexora-backend", "version": "1.0.0", "liveTrading": false }
```

## Sign-in

### `POST /v1/auth/register`

```json
{ "email": "you@example.com", "password": "at least 10 chars", "signupCode": "<SIGNUP_CODE>", "device": "Pixel 9" }
```

`201`:

```json
{ "token": "…", "user": { "id": "…", "email": "you@example.com", "phone": null } }
```

Store the token in secure storage on the device. Sessions last `SESSION_DAYS` (30 by default).

### `POST /v1/auth/login`

Body `{ email, password, device }`. The response is the same as for register. A wrong email or password returns `401`.

### `POST /v1/auth/otp/start`

Texts a code to an Indian mobile number through MSG91. The request and response match ManageMyFloor's `/auth/otp/start`, so the same app code can drive both.

```json
{ "phone": "+91 98765 43210", "signupCode": "<SIGNUP_CODE>" }
```

- The number is either `phone` or `countryCode` + `mobile` (`{ "countryCode": "+91", "mobile": "9876543210" }`). Only India (`+91`) works. `phone` may have `+91`, `91` or `0` in front, and spaces, dashes and brackets are ignored. The 10 digits must start with 6–9.
- `signupCode`: only needed when the number has no login yet. Without it, the server answers `404 not_registered` and sends nothing, so the app can ask for the invite code and try again. When sign-up is closed (`SIGNUP_CODE` unset), only numbers that already have a login can sign in.

`200`:

```json
{ "sent": true, "expires_in_seconds": 300 }
```

Limits (`429 rate_limited`, with `details.retry_after_seconds`): 5 codes per number per 15 minutes, and 20 per client IP per hour. The endpoint also shares the sign-in rate limit (`AUTH_RATE_LIMIT_PER_MINUTE`). Codes are `MSG91_OTP_LENGTH` digits (6 by default) and expire after `MSG91_OTP_EXPIRY_MINUTES` (5 by default).

### `POST /v1/auth/otp/verify`

```json
{ "phone": "+919876543210", "code": "123456", "device": "Pixel 9" }
```

`countryCode` + `mobile` works here too. MSG91 checks the code. On success, the server signs the device in. If the number had no login and the code was sent with the right invite code, the user is created now, with no email or password.

`200`:

```json
{
  "token": "…",
  "user": { "id": "…", "email": null, "phone": "+919876543210" },
  "tokens": { "access_token": "…", "token_type": "Bearer", "expires_in": 2592000 }
}
```

`token` and `tokens.access_token` are the same bearer token, and it works everywhere else in the API. `tokens` follows ManageMyFloor's shape. There is no refresh token: the session lasts `SESSION_DAYS`, then the user signs in again.

- Each code allows 5 tries. A wrong code is `401 otp_invalid`; after the fifth, `429 otp_attempts`.
- An expired or already used code is `401 otp_expired`. Ask for a new code.
- Users created this way have no password, so `POST /v1/auth/password` returns `400` for them.

### `POST /v1/auth/logout`

Ends this device's session. Returns `204`.

### `POST /v1/auth/password`

Body `{ currentPassword, newPassword, device }`. Signs out every device, then returns a new `{ token, user }` for this one.

### `GET /v1/me`

```json
{ "id": "…", "email": "you@example.com", "phone": null, "createdAt": "2026-10-27T04:00:00.000Z" }
```

`email` is `null` for users who signed up with a mobile number; `phone` is `+91XXXXXXXXXX` or `null`.

## Accounts

An account as the app sees it. The secret and the access token are never returned.

```json
{
  "id": "N1j-B6Ll0pMDMC9E",
  "broker": "upstox",
  "brokerLabel": "Upstox",
  "label": "Family",
  "apiKeyMasked": "upke••••34",
  "redirectUri": "https://127.0.0.1/",
  "enabled": true,
  "lots": 1,
  "product": "carryForward",
  "paperMode": true,
  "loggedIn": false,
  "tokenIssuedAt": null,
  "login": { "kind": "redirect", "url": "https://api.upstox.com/v2/login/authorization/dialog?…", "codeParam": "code", "redirectUri": "https://127.0.0.1/" }
}
```

- `broker`: `zerodha`, `upstox` or `groww`.
- `product`: `carryForward` (NRML; Upstox `D`) or `intraday` (MIS; Upstox `I`).
- `login`: the same thing `GET /v1/accounts/:id/login` returns. It saves a request.
- `loggedIn`: whether today's broker session is still valid. Sessions reset daily at 06:00 IST (Kite, Groww) or 03:30 IST (Upstox).

### `GET /v1/accounts`

Returns `{ "accounts": [ … ] }`, oldest first.

### `POST /v1/accounts`

```json
{
  "broker": "upstox",
  "label": "Family",
  "apiKey": "…",
  "apiSecret": "…",
  "redirectUri": "https://127.0.0.1/",
  "lots": 1,
  "product": "carryForward",
  "enabled": true,
  "paperMode": true
}
```

- `redirectUri` is required for Upstox and must exactly match the one saved in your Upstox app. It's ignored for the other brokers.
- `lots`, `product`, `enabled` and `paperMode` are optional. **`paperMode` defaults to `true`.**
- Returns `201` with the account.

### `GET /v1/accounts/:id`, `PATCH /v1/accounts/:id`, `DELETE /v1/accounts/:id`

- `PATCH` takes any of the create fields.
- Send `apiSecret` only to change it; an empty value keeps the stored one.
- Changing the broker, key, secret or redirect URI ends the broker session.
- `DELETE` returns `204`.

## Broker login (once a day per account)

### `GET /v1/accounts/:id/login`

How to log in today.

For Zerodha and Upstox, the response is a page to open and the redirect to catch:

```json
{ "kind": "redirect", "url": "https://kite.zerodha.com/connect/login?v=3&api_key=…", "codeParam": "request_token", "redirectUri": null }
```

1. Open `url` in the app's in-app browser.
2. Catch the navigation to `redirectUri` (Upstox) or to any address carrying `codeParam` (Zerodha).
3. Send that address to `/session`.

For Groww, the response is a page where the user approves the key:

```json
{ "kind": "approval", "url": "https://groww.in/trade-api/api-keys" }
```

The user approves the key there, then the app calls `/session` with an empty `input`, or with a 6-digit TOTP code.

### `POST /v1/accounts/:id/session`

Body `{ "input": "https://127.0.0.1/?code=…" }`. `input` can be the full redirect URL or just the code; for Groww it's empty or a TOTP code. The server exchanges it for the access token from its static IP and stores the token encrypted. Returns the account with `loggedIn: true`.

### `DELETE /v1/accounts/:id/session`

Forgets the access token.

## Signals

### `POST /v1/signals/parse`

Body `{ "text": "BUY SENSEX 29 OCT 73100 PUT AT 400-420 WITH SL OF 300 TGT1 540, TGT2 600" }`:

```json
{
  "signal": {
    "action": "BUY", "underlying": "SENSEX", "expiry": "2026-10-29", "strike": 73100, "optionType": "PE",
    "entryLow": 400, "entryHigh": 420, "stopLoss": 300, "targets": [540, 600], "raw": "…", "warnings": []
  },
  "contract": "SENSEX 29 OCT 2026 73100 PE",
  "entry": "400–420",
  "exchange": "BFO"
}
```

When the signal has no year, the server uses the next occurrence of that date in India, counting today.

### `POST /v1/signals/execute`

```json
{
  "text": "BUY SENSEX 29 OCT 73100 PUT AT 400-420 WITH SL OF 300 TGT1 540",
  "accountIds": ["N1j-B6Ll0pMDMC9E"],
  "settings": { "entryPriceMode": "high", "exitMode": "withStopAndTarget", "targetIndex": 0 },
  "allowDuplicate": false
}
```

- `settings` is optional; the values shown are the defaults.
  - `entryPriceMode`: `low`, `mid` or `high`.
  - `exitMode`: `entryOnly` or `withStopAndTarget`.
  - `targetIndex`: `0` = TGT1.
- `allowDuplicate: true` places the signal even if it was already placed on the account within `DUPLICATE_WINDOW_MINUTES`. Use it for a deliberate repeat.

The response has one result per account. A failed account doesn't stop the others:

```json
{
  "results": [
    {
      "id": "…", "accountId": "…", "accountLabel": "Family", "broker": "Upstox",
      "signalText": "…", "paper": false, "time": "2026-10-27T04:00:00.000Z",
      "symbol": "SENSEX 73100 PE 29 OCT 26", "quantity": 20, "entryPrice": 420,
      "orders": [{ "kind": "GTT entry+SL 300+TGT 540", "id": "GTT-123" }],
      "error": null, "errorCode": null, "success": true
    }
  ]
}
```

An account comes back with `success: false` and an `error` when any of the following happens. For the duplicate checks, `errorCode` says which one it was, so the app can offer **Place anyway**.

- The broker session expired. Log in again.
- `LIVE_TRADING` is off for a live account.
- The signal was already placed on it recently (`errorCode: "duplicate"`).
- The signal is being placed on it from another device right now (`errorCode: "in_flight"`).
- The broker rejected the order.

Paper accounts never send orders. They return `PAPER-…` ids, and they still resolve the real contract when logged in.

## Activity

### `GET /v1/activity?limit=100`

Returns `{ "results": [ … ] }`, newest first. `limit` is 1–500 (default 100). The items have the same shape as the execute results.

### `DELETE /v1/activity`

Clears your log. Returns `204`.

## Server

### `GET /v1/server/ip`

```json
{ "ip": "203.0.113.7", "liveTrading": false }
```

The public IP brokers see your orders coming from. Register it as the static IP with Zerodha, Upstox and Groww.
