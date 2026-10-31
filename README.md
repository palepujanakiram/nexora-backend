# nexora-backend

The execution server for [NexoraApp](https://github.com/palepujanakiram/nexora-app). One order from the user fans out to several broker accounts (Zerodha, Upstox, Angel One, Groww), and each account's order is tracked until it's finished. Everything leaves from a single static IP, as SEBI's retail algo rules require.

```
 iPhone ─┐                                          ┌─▶ Zerodha (Kite Connect)
 Android ┼──HTTPS──▶ nexora-backend ──static IP─────┼─▶ Upstox
 Web    ─┘           (Fly, Singapore)               ├─▶ Angel One (SmartAPI)
                          │                         └─▶ Groww
                       Postgres
```

This is an execution layer, not a strategy engine. It doesn't generate signals, backtest, or hold positions of its own.

## Three rules the code is built around

1. **Every broker write can fail on its own.** A fan-out returns HTTP 207 with one result per account. A rejection on one account never rolls back or blocks the others.
2. **Nothing is assumed: every write is confirmed.** After a place, modify or cancel, the order is read back from the broker. A timeout or 5xx leaves the leg `UNKNOWN`, and reconciliation finds it in the broker's order book by our client reference.
3. **A user can always close a position.** Cancel, modify and exit are never blocked by the subscription. When a subscription lapses the user drops to *exit-only*: no new entries, but full access to cancel, exit, positions and history.

## What it does

- **Sign-up and sign-in.** Users sign themselves up with their mobile number and an OTP, plus full name, email and three consents (`/auth/signup/*`). Each consent is recorded with its wording version and the date and time it was accepted. Returning users sign in with an OTP. Admins can still create users, and `users.created_via` records which way each user was created.
- **Accounts.** A user links any number of broker accounts, including two at the same broker. Credentials and session tokens are encrypted per field with AES-256-GCM, and each ciphertext records its key version so keys can rotate. The API only ever returns a masked key.
- **Daily broker login.** Kite and Upstox use a browser redirect to `/broker-callback/<broker>`. Groww is approve-and-connect. Angel One uses a TOTP and then refreshes headlessly. Accounts whose session needs the user are flagged, and the app is told over `/stream`.
- **Orders.** Place, modify, cancel and exit across accounts. Every write needs an `Idempotency-Key` and takes a lock on the order, so a retry or a second device can't double an order or double a square-off. Exit reads the live position from each broker and sells only what's actually held.
- **Instrument master.** One canonical id per contract (`NFO:CE:NIFTY:2026-10-29:2450000`), mapped to each broker's own identifier and refreshed every morning. A broker with no mapping gets no order.
- **Safety.** Paper mode is the default for new accounts. Live accounts are dry-run (writes logged, not sent) until `LIVE_TRADING=true`. Before each order the server checks market hours, a daily order cap, the maximum value per order, and a kill switch that's flipped through the API, with no deploy.
- **Billing (optional).** Plans with their limits stored as data, Razorpay subscriptions, and signature-verified idempotent webhooks with a grace period. With `BILLING_ENABLED=false`, every user is entitled. That suits one operator trading their own accounts.
- **Analytics.** Execution quality compared across brokers: fill rate, slippage against the price at submission, time to fill, and rejection reasons. Also realised and unrealised P&L. All of it comes from separate analytics tables fed by an outbox, never from the live order tables.
- **Audit.** `order_events` and `payment_events` are append-only (enforced by a database trigger) and keep the raw broker request and response, with credentials stripped.

## Quick start (local)

Needs Node.js 24 or later. No Postgres server is needed locally: `DATABASE_URL=pglite:./data/pg` runs Postgres in-process.

```bash
npm install
cp .env.example .env     # then fill in ENCRYPTION_KEYS and JWT_PRIVATE_KEY (commands in the file)
node --env-file=.env src/server.ts
curl localhost:8080/health
```

Register a client (the app), then either sign up through `POST /auth/signup/request` and `/auth/signup/verify`, or create a user as an admin and sign in. In development the OTP is printed to the console.

```bash
node --env-file=.env src/cli.ts create-client "NexoraApp iOS" ios
node --env-file=.env src/cli.ts create-user 9876543210
```

## Docs

- [docs/api.md](docs/api.md): every endpoint, request and response.
- [docs/architecture.md](docs/architecture.md): modules, the order lifecycle, the decisions taken, and what's still open.
- [docs/deploy-fly.md](docs/deploy-fly.md): deploying to Fly.io with Postgres and a static egress IP.

## Configuration

See [.env.example](.env.example) for every setting and its default. The ones that matter most:

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | `postgres://…` in production; `pglite:<dir>` or `pglite:memory` for development. |
| `ENCRYPTION_KEYS` | `1:<base64>,2:<base64>`: 32-byte keys by version. New ciphertexts use `ENCRYPTION_KEY_VERSION` (default: the highest). **Back them up.** |
| `JWT_PRIVATE_KEY` | Ed25519 private key (PEM) that signs access tokens. `node src/cli.ts gen-jwt-key`. |
| `ADMIN_TOKEN` | Bearer token for `/admin/*`. Unset turns admin off. |
| `LIVE_TRADING` | `false` (default): writes to live accounts are logged, not sent. |
| `BILLING_ENABLED` | `false` (default): everyone may trade. `true` needs the Razorpay settings. |
| `OTP_PROVIDER` | `msg91` in production; `console` prints codes (refused in production). |
| `CONSENT_VERSION` | Version of the sign-up consent wording, stored with each consent. Bump it when the text changes. |

## Development

```bash
npm run typecheck
npm test
npm run coverage    # fails below 95% line coverage
```

Tests run against real Postgres semantics (PGlite in-process) and fake brokers. No test touches the network or a real broker. The rules for contributors (and for Claude Code) are in [CLAUDE.md](CLAUDE.md).

## Disclaimer

This software places real orders when an account is live and `LIVE_TRADING=true`. Trading carries substantial risk, and you are responsible for every order the server places. Check the regulatory position (SEBI's algo framework, broker empanelment) before serving anyone other than yourself; see docs/architecture.md.
