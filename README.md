# nexora-backend

The server for [NexoraApp](https://github.com/palepujanakiram/nexora-app). It keeps your broker accounts in one place and places option signals on Zerodha, Upstox and Groww **from a single static IP**, so any number of phones, tablets or browsers can use the same broker API keys.

Under SEBI's rules for retail API trading, brokers accept API orders only from a static IP you register with them. When every device places orders itself, every device needs that IP. With nexora-backend, the devices talk to the server and the server talks to the brokers, so you register one IP: the server's.

```
 iPhone ─┐                                   ┌─▶ Zerodha (Kite Connect)
 Android ┼──HTTPS──▶  nexora-backend on Fly  ┼─▶ Upstox
 Web    ─┘            (static egress IP)     └─▶ Groww
```

## What it does

- **Accounts in one place.** Broker API keys, secrets and the day's access tokens are stored on the server and encrypted with AES-256-GCM. The app only ever sees a masked key.
- **One daily broker login, shared by every device.** Log in to Zerodha or Upstox once in the app (the in-app login sends the redirect to the server), or approve Groww for the day. Every device can then trade.
- **Signal execution.** Parses signals such as `BUY SENSEX 29 OCT 73100 PUT AT 400-420 SL 300 TGT1 540`, resolves the exact contract, and places the entry plus stop loss and target (Kite GTT OCO, Upstox GTT MULTIPLE; Groww entry only). Same rules as the app.
- **No duplicate orders.** If the same signal was already placed on an account in the last 15 minutes (from any device), the server refuses it unless the app asks to place it anyway. Two devices sending it at the same moment can't both get through.
- **Shared activity log.** Every device sees every execution.
- **Safety switches.**
  - New accounts start in paper mode.
  - Live orders need `LIVE_TRADING=true` on the server.
  - Sign-up needs an invite code, whether by email or mobile number.
  - Sign-in attempts are rate-limited, and SMS codes are limited per number and per IP, with 5 tries per code.

## Quick start (local)

Needs Node.js 24 or later.

```bash
npm install
cp .env.example .env              # then set ENCRYPTION_KEY (openssl rand -base64 32), SIGNUP_CODE and MSG91_AUTH_KEY (or empty OTP_PROVIDER)
node --env-file=.env src/server.ts
curl localhost:8080/health
```

Node runs the TypeScript directly. `npm run build && npm start` runs the compiled JavaScript, as production does.

## Deploy

See [docs/deploy-fly.md](docs/deploy-fly.md). It covers Fly.io in the Singapore region with a static egress IP, a volume for the database, and secrets. It takes about 15 minutes and costs a few dollars a month.

## API

See [docs/api.md](docs/api.md). Every endpoint is JSON over HTTPS. Apart from health and sign-in, endpoints need `Authorization: Bearer <token>`.

| Area | Endpoints |
|---|---|
| Health | `GET /health` |
| Sign-in | `POST /v1/auth/register`, `POST /v1/auth/login`, `POST /v1/auth/otp/start`, `POST /v1/auth/otp/verify`, `POST /v1/auth/logout`, `POST /v1/auth/password`, `GET /v1/me` |
| Accounts | `GET/POST /v1/accounts`, `GET/PATCH/DELETE /v1/accounts/:id` |
| Broker login | `GET /v1/accounts/:id/login`, `POST/DELETE /v1/accounts/:id/session` |
| Signals | `POST /v1/signals/parse`, `POST /v1/signals/execute` |
| Activity | `GET/DELETE /v1/activity` |
| Server | `GET /v1/server/ip`: the IP to register with your brokers |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ENCRYPTION_KEY` | required | 32 random bytes, base64. Encrypts broker secrets and tokens. **Back it up**: without it, stored secrets can't be read. |
| `SIGNUP_CODE` | unset | Invite code for `POST /v1/auth/register`, and for a new number's first `POST /v1/auth/otp/start`. Unset closes sign-up; create users with the CLI instead. |
| `OTP_PROVIDER` | unset | `msg91` turns on mobile + OTP sign-in, and then the server refuses to start without the two MSG91 settings below. Setting both also turns it on. |
| `MSG91_AUTH_KEY` | unset | [MSG91](https://msg91.com) auth key. Secret: sent only to MSG91, never logged or returned. |
| `MSG91_TEMPLATE_ID` | unset | MSG91 OTP template id (DLT-approved, with the `##OTP##` placeholder). |
| `MSG91_OTP_LENGTH` | `6` | Digits in an SMS code (4–9). |
| `MSG91_OTP_EXPIRY_MINUTES` | `5` | How long an SMS code stays valid (1–30). |
| `LIVE_TRADING` | `false` | Must be `true` for live (non-paper) accounts to send real orders. |
| `DATABASE_PATH` | `./data/nexora.db` | SQLite file. On Fly: `/data/nexora.db` on a volume. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where to listen. |
| `CORS_ORIGINS` | none | Web origins allowed to call the API, comma-separated. Only the Flutter web build needs this. |
| `SESSION_DAYS` | `30` | How long a device stays signed in. |
| `DUPLICATE_WINDOW_MINUTES` | `15` | How long a placed signal blocks a repeat on the same account. `0` turns the check off. |
| `RATE_LIMIT_PER_MINUTE` | `300` | Requests per minute per client IP. |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `10` | Sign-in and sign-up attempts per minute per client IP. |
| `LOG_LEVEL` | `info` | `fatal` … `trace`, or `silent`. |

### Admin CLI

```bash
NEXORA_PASSWORD='a long password' node dist/cli.js create-user you@example.com
node dist/cli.js gen-key          # prints a new ENCRYPTION_KEY
```

## Code layout

Clean Architecture, mirroring the app:

```
src/
  domain/      pure rules: signal parser, pricing, token expiry, IST dates, errors
  brokers/     Kite, Upstox and Groww clients, and the MSG91 OTP client (fetch injected; no global state)
  data/        SQLite (node:sqlite), repositories, encryption and password hashing
  usecases/    auth (email + password, mobile + OTP), accounts + broker login, signal execution with the duplicate guard
  http/        Fastify app, routes, request schemas (zod)
  container.ts wires everything; server.ts and cli.ts are the entry points
test/          mirrors src/; no test touches the network or a real broker
```

## Development

```bash
npm run typecheck
npm test
npm run coverage    # fails below 95% line coverage
```

The rules for contributors (and for Claude Code) are in [CLAUDE.md](CLAUDE.md).

## Disclaimer

This software places real orders when you turn off paper mode and set `LIVE_TRADING=true`. Options trading carries substantial risk, and you are responsible for every order the server places. Test with paper accounts first.
