# nexora-backend API

Requests and responses are JSON. Prices are rupee strings with up to two decimals (`"420.05"`); numbers are also accepted on input. Internally every price is integer paise.

**Authentication.** Endpoints need `Authorization: Bearer <accessToken>` unless marked *public* or *admin*. Admin endpoints take `Authorization: Bearer <ADMIN_TOKEN>` instead.

**Tracing.** Send a W3C `traceparent` header to continue your trace. Every response carries one.

**Errors** look like this:

```json
{ "error": { "code": "subscription_required", "message": "…", "details": { "required_plan": "pro" } } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | Missing or invalid fields; the message names the field. Also a missing `Idempotency-Key`. |
| 401 | `unauthorized`, `otp_invalid`, `otp_expired`, `refresh_reused`, `bad_signature`, `broker_login_failed` | Not signed in, wrong code, a reused refresh token (the session is ended), a bad webhook signature, or a failed broker login. |
| 402 | `subscription_required`, `plan_limit` | No active subscription (exit-only), or over a plan limit. `details` names the plan or limit and gives `upgrade_url`. |
| 403 | `forbidden` | Wrong admin credential, or a client not allowed that grant. |
| 404 | `not_found` | No such resource (or it's someone else's), or no such endpoint. |
| 409 | `conflict`, `order_busy`, `idempotency_in_progress` | Duplicate, another change to the same order is running, or the same key is still being processed. |
| 422 | `market_closed`, `max_notional`, `idempotency_mismatch` | A risk check refused the order, or the key was used for a different request. |
| 429 | `rate_limited`, `daily_order_cap`, `otp_attempts` | Too many requests, too many orders today, or too many wrong codes. `details.retry_after_seconds` when known. |
| 502 | `broker_error`, `payment_provider_error`, `otp_send_failed` | An outside provider failed. |
| 503 | `kill_switch`, `billing_unavailable`, `otp_unavailable` | Trading paused, or a feature not configured. |
| 500 | `internal` | A bug. Details are in the server log only. |

## Sign-in (OTP, multi-client)

Every front end is registered as a **client** (`POST /admin/clients`) with its own token lifetimes. Access tokens are EdDSA JWTs that live 15 minutes by default. Refresh tokens are opaque and rotate on every use; replaying an old one ends the whole session.

### `POST /auth/otp/request` (public)

```json
{ "phone": "+91 98765 43210" }
```

`200 { "sent": true, "expiresInSeconds": 300 }`. The answer is the same for unregistered numbers, but no SMS is sent to them. Limits: 3 codes per number per hour and 20 per IP per hour (`429` with `retry_after_seconds`). Codes are valid for 5 minutes and allow 5 tries.

### `POST /auth/otp/verify` (public)

```json
{ "phone": "9876543210", "code": "123456", "clientId": "cl_…", "device": "iPhone 16" }
```

`200`:

```json
{
  "accessToken": "eyJ…", "tokenType": "Bearer", "expiresIn": 900,
  "refreshToken": "rt_…", "refreshExpiresAt": "2026-11-26T04:00:00.000Z", "sessionId": "ses_…",
  "user": { "id": "usr_…", "phone": "+919876543210", "email": null, "createdAt": "…" }
}
```

### `POST /auth/refresh` (public)

`{ "refreshToken": "rt_…", "clientId": "cl_…" }` returns a new pair with the same shape (without `user`). Throw the old refresh token away.

### Sessions

| | |
|---|---|
| `GET /me` | The signed-in user. |
| `POST /auth/logout` | Ends this session. `204`. |
| `GET /auth/sessions` | `{ sessions: [{ id, clientId, device, ip, createdAt, lastUsedAt, expiresAt, current }] }` |
| `DELETE /auth/sessions/:id` | Signs one device out. `204`. |
| `GET /.well-known/jwks.json` (public) | Public keys for verifying access tokens locally. |

Entitlements are deliberately **not** in the access token. They're checked on every order.

## Admin

| | |
|---|---|
| `POST /admin/users` | `{ phone, email? }` → `201` user. The only way users are created. |
| `POST /admin/clients`, `GET /admin/clients` | `{ name, platform: web\|ios\|android\|partner\|other, grantTypes?, accessTtlSeconds? (60–3600, default 900), refreshTtlSeconds? (default 30 days) }` |
| `GET /admin/kill-switch`, `POST /admin/kill-switch` | `{ on: true, reason: "bad fills" }`. Takes effect on the next order. While on, every outbound order (entry, modify, exit) is refused with `503 kill_switch`; cancels still go out. |
| `POST /admin/plans` | Upsert a plan: `{ code, name, price, interval: monthly\|yearly, maxAccounts, maxOrdersPerDay, maxFanout, brokers: [...], razorpayPlanId, active }`. |
| `POST /admin/holidays`, `GET /admin/holidays` | `{ day: "2026-11-09", name: "Diwali" }`: no new entries on these days. |
| `POST /admin/instruments/refresh` | `{ brokers?: [...] }`: downloads the brokers' instrument masters now (it also runs daily at 08:15 IST). |
| `GET /admin/reconciliation/issues`, `POST /admin/reconciliation/issues/:id/resolve` | Mismatches the end-of-day comparison found, for a human to check. |
| `POST /admin/jobs/:name/run` | `reconcile`, `eod_reconcile`, `analytics`, `sessions_refresh`, `reencrypt` (after adding a key version). |

## Brokers and accounts

### `GET /brokers`

```json
{ "brokers": [{ "code": "zerodha", "label": "Zerodha (Kite Connect)",
  "capabilities": { "orderTypes": ["MARKET","LIMIT","SL","SL_M"], "products": ["DELIVERY","INTRADAY","CARRYFORWARD"],
                    "exchanges": ["NSE","BSE","NFO","BFO"], "modifiable": ["price","quantity","triggerPrice","orderType"],
                    "ratePerSecond": 10, "headlessRefresh": false, "webhooks": true },
  "credentialFields": [{ "name": "apiKey", "label": "API key", "secret": false, "required": true }, …] }, …] }
```

### `POST /broker-accounts`

```json
{ "broker": "zerodha", "label": "Kite – main", "mode": "paper",
  "credentials": { "apiKey": "…", "apiSecret": "…" } }
```

The `credentials` keys are the broker's `credentialFields` (Upstox also needs `redirectUri`; Angel One needs `clientCode` and `pin`). They're optional for paper accounts and required to switch to live. `201`:

```json
{ "account": { "id": "ba_…", "broker": "zerodha", "label": "Kite – main", "mode": "live", "apiKeyMasked": "ki••••23",
               "token": { "state": "none", "expiresAt": null, "lastAuthAt": null, "message": null }, "createdAt": "…" },
  "link": { "kind": "redirect", "url": "https://kite.zerodha.com/connect/login?…", "message": "…" } }
```

`link` says how to log in to the broker. **`redirect`**: open `url`. The broker redirects to `<PUBLIC_URL>/broker-callback/<broker>`, which finishes the link and shows a confirmation page. If the app catches the redirect itself, post its parameters to `/link` instead. **`input`**: ask the user for `fields` (a TOTP for Angel One; optional for Groww), then post them to `/link`.

| | |
|---|---|
| `GET /broker-accounts` | Every account with token health: `token.state` is `valid`, `expired`, `needs_user_action` or `none`. |
| `GET /broker-accounts/:id` | One account. |
| `PATCH /broker-accounts/:id` | `{ mode: "live" \| "paper" }` |
| `GET /broker-accounts/:id/relink` | A fresh `link` challenge, for daily re-login. |
| `POST /broker-accounts/:id/link` | `{ params: { request_token: "…" } }` (Kite), `{ params: { code: "…" } }` (Upstox), `{ params: { totp: "123456" } }` (Angel One, and Groww optionally), or `{ params: { url: "<the full redirect URL>" } }`. |
| `DELETE /broker-accounts/:id` | Unlinks and deletes the stored credentials. `204`. |

Sessions end daily: Kite and Groww at 06:00 IST, Upstox at 03:30 IST. A job at 06:05 IST renews Angel One sessions headlessly and flags the others as `needs_user_action`; the app gets a `relink_needed` event on `/stream`.

## Instruments

`GET /instruments?underlying=NIFTY&type=CE&expiry=2026-10-29&exchange=NFO&limit=100`:

```json
{ "instruments": [{ "id": "NFO:CE:NIFTY:2026-10-29:2450000", "exchange": "NFO", "type": "CE", "underlying": "NIFTY",
                    "expiry": "2026-10-29", "strike": "24500.00", "lotSize": 75, "tickSize": "0.05" }] }
```

Ids: `NSE:EQ:RELIANCE`, `NFO:FUT:NIFTY:2026-10-29`, `BFO:PE:SENSEX:2026-10-29:7310000` (the strike is in paise).

`POST /signals/parse` `{ text: "BUY NIFTY 29 OCT 24500 CALL AT 120-125 SL 100 TGT 150" }` returns the parsed `signal`, its `instrumentId` (null if it isn't in the master), and suggested `order` fields. It places nothing.

## Orders

Every write needs an **`Idempotency-Key`** header (8–200 characters, unique per intended action) and answers **`207`** with one result per leg. Sending the same key and body again returns the stored answer with `Idempotent-Replayed: true`, and nothing is sent twice. If a request is refused before anything reaches a broker (validation, `402`, risk), the key is freed and can be retried.

### `POST /orders`: fan-out place (needs an active subscription)

```json
{ "instrumentId": "NFO:CE:NIFTY:2026-10-29:2450000", "side": "BUY", "quantity": 150,
  "orderType": "LIMIT", "product": "CARRYFORWARD", "price": "420.00",
  "referencePrice": "419.50", "accountIds": ["ba_1", "ba_2", "ba_3"] }
```

- `orderType`: `MARKET`, `LIMIT`, `SL` (stop-loss limit: `price` and `triggerPrice`) or `SL_M` (stop-loss market: `triggerPrice`).
- `product`: `DELIVERY` (equity cash), `INTRADAY`, or `CARRYFORWARD` (overnight F&O).
- `quantity`: units, a multiple of the lot size. It's the same on every account.
- `referencePrice`: the price the user saw. It's required for market orders (for the order-value check) and is used to measure slippage.

`207`:

```json
{
  "parentOrderId": "po_…",
  "status": "IN_PROGRESS",
  "legs": [
    { "legId": "leg_…", "accountId": "ba_1", "broker": "zerodha", "mode": "live", "status": "OPEN",
      "brokerOrderId": "250110400012345", "quantity": 150, "filledQty": 0, "avgPrice": null,
      "orderType": "LIMIT", "price": "420.00", "triggerPrice": null, "reconcileScheduled": true },
    { "legId": "leg_…", "accountId": "ba_2", "broker": "angelone", "status": "REJECTED",
      "error": { "code": "INSUFFICIENT_FUNDS", "message": "Angel One: …" }, "reconcileScheduled": false, … },
    { "legId": "leg_…", "accountId": "ba_3", "broker": "upstox", "status": "UNKNOWN",
      "error": { "code": "TIMEOUT", "message": "upstox did not answer within 8000 ms." }, "reconcileScheduled": true, … }
  ]
}
```

**Leg status:** `PENDING_SUBMIT → SUBMITTED → OPEN → (PARTIALLY_FILLED) → FILLED | CANCELLED | REJECTED | EXPIRED`, plus `UNKNOWN`: the broker may or may not have the order. Reconciliation resolves it by finding our client reference in the broker's order book. If the broker still has no record after several minutes, the leg becomes `REJECTED` with `NOT_FOUND`.

**Parent status** is derived from the legs: `IN_PROGRESS` while any leg is unresolved; `COMPLETE` when all filled; `PARTIAL` when some filled; `FAILED` when none were accepted; `CANCELLED` when accepted legs were cancelled or expired unfilled.

**Error codes on legs:** `AUTH_EXPIRED`, `INSUFFICIENT_FUNDS`, `RATE_LIMITED`, `MARKET_CLOSED`, `INVALID_SYMBOL` (also: no mapping for that broker), `REJECTED_BY_EXCHANGE`, `UNSUPPORTED` (the broker can't do this order type, product or exchange; refused before sending), `NOT_IN_PLAN`, `NOT_FOUND`, `TIMEOUT` / `BROKER_UNAVAILABLE` (the leg is `UNKNOWN`), `DRY_RUN` (`LIVE_TRADING` is off), `UNKNOWN`.

Before any leg is sent the server checks the kill switch, market hours (09:15–15:30 IST on weekdays, minus `/admin/holidays`), the plan's fan-out width, the daily order cap (plan, and `RISK_MAX_ORDERS_PER_DAY`), and the order value per account (`RISK_MAX_NOTIONAL_RUPEES`).

### `POST /orders/:id/cancel` (never gated by subscription)

`{ accountIds?: [...] }` (default: every leg). Each leg gets an `outcome`:

- `cancelled`: the broker confirmed it.
- `cancel_requested`: accepted but not yet confirmed; reconciliation follows it.
- `not_cancellable`: with `reason`, e.g. "Already filled.".
- `unknown`: the broker hasn't confirmed it has the order.
- `failed`: with `reason`.

### `POST /orders/:id/modify` (never gated by subscription)

`{ accountIds?, quantity?, price?, triggerPrice?, orderType? }`. Outcomes: `modified`, `modify_requested`, `not_modifiable` (with `reason`: finished, a bad combination, or the broker's partial-fill rule), `failed`, `unknown`. Users in exit-only mode can reduce quantity but not add to it.

### `POST /orders/:id/exit` (never gated by subscription)

`{ accountIds?: [...] }`. For each account this cancels whatever is still open on the entry, reads the live position from the broker, and sends an opposite-side **market** order for the quantity actually held. That's never more than this order filled minus earlier exits.

```json
{ "parentOrderId": "po_entry", "exitOrderId": "po_exit", "exitStatus": "IN_PROGRESS",
  "legs": [
    { "accountId": "ba_1", "outcome": "exit_placed", "heldQty": 150, "cancelledRemainder": false, "exitLeg": { … } },
    { "accountId": "ba_2", "outcome": "nothing_to_exit", "reason": "Already exited." } ] }
```

The exit is its own order (`kind: "EXIT"`, `exitOf` the entry), tracked the same way.

### Reads

| | |
|---|---|
| `GET /orders?limit=50&before=<ISO time>` | Newest first, each with its legs. |
| `GET /orders/:id` | `{ parentOrderId, kind, exitOf, status, instrumentId, side, quantity, orderType, product, price, triggerPrice, referencePrice, algoId, clientId, createdAt, updatedAt, legs }` |
| `GET /orders/:id/legs/:legId/events` | The leg's audit trail: every transition with the raw broker request and response (no credentials). |

## Positions

`GET /positions` (never gated): live from each broker. An account whose broker call fails is reported with `error` rather than dropped.

```json
{ "accounts": [{ "accountId": "ba_1", "broker": "zerodha", "mode": "live", "syncedAt": "…",
  "positions": [{ "instrumentId": "NFO:CE:NIFTY:…", "tradingSymbol": "NIFTY26O2924500CE", "exchange": "NFO",
                  "product": "CARRYFORWARD", "netQty": 150, "avgPrice": "420.00", "lastPrice": "425.50", "pnl": "825.00" }] }] }
```

## Billing

| | |
|---|---|
| `GET /plans` | Active plans with their limits. |
| `GET /subscription` | `{ mode: "full" \| "exit_only", reason, warning, plan, subscription: { status, currentPeriodEnd, graceUntil, cancelAtPeriodEnd, checkoutUrl } }` |
| `POST /subscription/checkout` | `{ planCode }` → `{ subscriptionId, checkoutUrl, status: "created" }`. Open `checkoutUrl` to authorise the UPI AutoPay / e-mandate. |
| `POST /subscription/cancel` | Cancels at the end of the paid period. |
| `POST /webhooks/razorpay` (public) | Razorpay's webhook: checks `X-Razorpay-Signature`, is idempotent by `X-Razorpay-Event-Id`, and is the only thing that makes a subscription active. |

If a renewal fails, trading stays allowed for `GRACE_DAYS` (3) with a `warning`, then drops to exit-only.

## Analytics

These read only the analytics tables, never the live order tables. They're refreshed every minute from the order outbox.

- `GET /analytics/execution?from=2026-10-01&to=2026-10-31&groupBy=broker|instrument` →
  `{ from, to, rows: [{ broker, instrumentId?, side?, legs, filled, rejected, fillRate, rejectionRate, rejectionsByReason, avgSlippageBps, avgTimeToFillMs }] }`. Slippage is in basis points against the price at submission; positive means worse for you. Group by `instrument` to compare the same contract across brokers.
- `GET /analytics/pnl?from=…&to=…` → `{ from, to, realisedTotal, realised: [{ accountId, instrumentId, realised }], unrealised: [{ accountId, tradingSymbol, netQty, unrealised, asOf }] }`. Realised P&L uses the average-cost method. Unrealised comes from the last positions the brokers reported.

## Live updates: `WS /stream`

Connect with `Authorization: Bearer <accessToken>`, or `?access_token=` from a browser. Messages:

```json
{ "type": "ready" }
{ "type": "leg", "parentOrderId": "po_…", "parentStatus": "PARTIAL", "leg": { …same as in the 207… } }
{ "type": "relink_needed", "accountId": "ba_…", "broker": "zerodha", "message": "…" }
{ "type": "entitlement", "mode": "exit_only" }
```

A bad token closes the socket with code `4401`.

## Webhooks and redirects (public)

- `GET /broker-callback/:broker`: where Kite and Upstox send the browser after login. The encrypted `state` names the account and expires after 15 minutes.
- `POST /webhooks/:broker`: broker order postbacks (Kite's are checked against the account's API secret). They only trigger a fresh read of the order from the broker; their contents are never trusted.

## Other

- `GET /health` (public): `{ status, service, version, liveTrading, billing }`
- `GET /server/ip`: the egress IP brokers see. Register it with every broker.
