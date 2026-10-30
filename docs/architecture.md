# Architecture

This implements the *Multi-Broker Trading Assistant — Backend Build Prompt* (30 Oct 2026) on the existing nexora-backend stack. This page covers how it's built, where it departs from the brief and why, and what's still open.

## Modules

It's a modular monolith with Clean Architecture layers: `domain` (pure rules), then `brokers` and `data` (I/O), then `usecases`, then `http`. `src/container.ts` is the only place things are wired together. No module reads another module's tables.

| Module | Code | Tables |
|---|---|---|
| Broker gateway | `brokers/*`, `usecases/gateway.ts`, `usecases/broker-accounts.ts` | `broker_accounts`, `paper_orders` |
| Identity | `usecases/identity.ts`, `usecases/tokens.ts`, `data/identity.ts` | `users`, `clients`, `sessions`, `refresh_tokens`, `otp_codes` |
| Order orchestration | `usecases/orders.ts`, `usecases/legs.ts`, `usecases/reconcile.ts`, `data/orders.ts` | `parent_orders`, `order_legs`, `order_events`, `idempotency_keys`, `positions`, `reconciliation_issues` |
| Risk | `usecases/risk.ts`, `domain/risk.ts` | `settings` (kill switch), `market_holidays` |
| Billing | `usecases/billing.ts`, `usecases/entitlements.ts`, `brokers/razorpay.ts` | `plans`, `subscriptions`, `payment_events` |
| Instruments | `usecases/instruments.ts`, `data/instruments.ts` | `instruments`, `instrument_mappings` |
| Analytics | `usecases/analytics.ts`, `data/analytics.ts` | `analytics_outbox`, `analytics_leg_facts`, `analytics_execution_daily`, `analytics_position_snapshots` |
| Notifications | `usecases/events.ts`, `/stream` | — |

### The adapter seam

`src/brokers/adapter.ts` is the whole contract. Order, routing and storage code never name a broker. Adding a fifth broker means writing `src/brokers/<code>/index.ts` (an implementation of `BrokerAdapter`) and adding one line to `src/brokers/registry.ts`. The adapter contract follows the brief, with these refinements:

- `completeLink(ctx, …)` takes the account context, since token exchange needs the API secret.
- `toBrokerSymbol` is replaced by the `instrument_mappings` table. A missing mapping means the leg is refused (`INVALID_SYMBOL`) before anything is sent.
- `modifyProblem(current, req)` is where partial-fill and modify rules live. The core never guesses them.
- `parseWebhook` returns a *hint*: the order id, plus a signature check when the broker signs updates. The core then re-reads the order from the broker.
- Every call goes through `BrokerHttp` (`src/brokers/http.ts`), which handles the per-account rate-limit token, timeouts, dry run, error normalisation for timeouts, 5xx and 429, and a credential-free record of each request and response for the audit trail.

### The broker gateway

`BrokerGateway` is the only code that decrypts credentials, and plaintext exists only for the duration of one call. Its interface is plain data (account id + request → ack/order/positions). It runs in-process today. Moving it into its own pinned-IP service means putting that interface behind an internal HTTP API; the order module doesn't change. With one Fly machine, the whole server already sits on the one whitelisted IP.

## Order lifecycle

1. **Before anything is sent:** the entitlement check (`402` if not paid), intent validation (lot size, tick, price/trigger vs. order type), and risk (kill switch, market hours and holidays, fan-out width, daily cap, order value). Per-leg pre-checks follow: broker capabilities, the plan's brokers, and the instrument mapping. Refused legs are stored as `REJECTED` with a reason.
2. The parent and its legs are stored as `PENDING_SUBMIT`, all in one transaction.
3. **Each leg is submitted in parallel.** On an ack the leg becomes `SUBMITTED`, and the order is then *read back* to get its real state. A timeout, network error or 5xx makes it `UNKNOWN` with reconciliation scheduled. Any other error makes it `REJECTED` with the normalised code.
4. Every change writes an `order_events` row (append-only, enforced by a trigger) with the raw exchange, recomputes the parent's status from its legs, publishes to `/stream`, and, when the leg is finished, writes an analytics outbox row in the same transaction.
5. **Reconciliation** has three paths. Polling re-reads every unfinished leg with backoff from 2 s up to 5 min; an `UNKNOWN` leg is found by its client reference (the broker order tag). Broker webhooks trigger a re-read. A 16:00 IST end-of-day comparison with each broker's order book applies the broker's version and records mismatches in `reconciliation_issues` for a human.

Cancel, modify and exit hold a lock on the parent order (a Postgres advisory lock plus an in-process mutex), and so does reconciliation, so two exits can't double a square-off. Every write endpoint needs an `Idempotency-Key`. Keys are stored in Postgres for 24 hours.

## Decisions taken for this build

Each of these departs from, or settles a question left open by, the brief.

| Brief | What was built | Why |
|---|---|---|
| Node 22, Fastify + `fastify-type-provider-zod`, Drizzle | Node 24 (type stripping), Fastify + Zod parsed in handlers, plain SQL | It keeps the existing stack and conventions. SQL lives in the `data/` repositories only. |
| PostgreSQL 16 | Postgres via `pg` in production; PGlite (real Postgres in-process) in tests and local development | You chose Postgres. PGlite keeps tests hermetic and fast while still using real Postgres semantics. |
| Redis (OTP, idempotency, locks, entitlement cache), BullMQ | Postgres tables, Postgres advisory locks, an in-memory entitlement cache (30 s TTL, dropped on webhook), and an in-process scheduler with per-job locks | You chose to evolve the current single-machine stack. Each sits behind a small class that can be swapped later. |
| KMS/Vault envelope encryption | AES-256-GCM per field with versioned keys from the environment, plus a re-encryption job | No KMS in this deployment. `TODO(KMS)` in `data/crypto.ts`; only `SecretBox` changes. |
| ClickHouse/Timescale | Separate Postgres analytics tables fed by a transactional outbox | It satisfies "never read the live order tables" without new infrastructure. |
| OpenTelemetry + Loki/Tempo | `traceparent` is accepted and returned, and trace ids go in every log line. pino logs pass through a field allowlist at the logger. | There's no collector to export to yet. Adding the OTel SDK exporter is a follow-up. |
| A separate gateway service | An in-process gateway behind a plain-data interface | There's one machine and one IP today (see above). |
| Public signup | None. Users are created only by `POST /admin/users` or the CLI. | As the brief asks. |
| v1 for one operator or external users? | Undecided. Built for multiple users, with `BILLING_ENABLED=false` meaning everyone is entitled. | It works for either answer. Settle compliance first (below). |

Choices the brief didn't specify:

- **Exit** cancels the open remainder of the entry first, then sells `min(held at the broker, filled by this order − earlier exits)` at market. That way it never closes a position the user opened elsewhere. An exit is its own parent order (`kind: EXIT`).
- **Modify** isn't gated, but users in exit-only mode can't increase quantity on an entry.
- The **kill switch** blocks entries, modifies and exits. Cancels still go out.
- **Market orders need `referencePrice`** (the price the user saw), for the order-value check and for slippage.
- **OTP requests for unknown numbers** get the normal answer and no SMS, so the endpoint doesn't reveal who has an account.
- **Paper accounts** use a simulated broker. Market orders, and limit orders at or better than the reference price, fill at the reference price; everything else rests `OPEN`.
- **Upgrade path:** the old `/v1` API (email/password, signal execution with GTT stop-loss/target) is gone. GTT/bracket exits are out of scope per the brief. `POST /signals/parse` stays as a helper that places nothing. The Flutter app must move to this API. Old SQLite data isn't migrated; re-create users and re-link accounts.

## Open items

These need a decision or outside confirmation before going live. They're also marked as `TODO` in the code.

1. **Compliance (blocking for external users).** Third-party platforms that place orders for others most likely need exchange empanelment through each broker, and every order needs the exchange-issued **Algo ID**. `ALGO_ID` is stored on every order, but no adapter sends it yet (`TODO(SEBI algo id)`), because brokers haven't published the request field.
2. **Groww API access.** Confirm with Groww that a third-party platform can use its order API. Several field names are `TODO(verify)` in `brokers/groww`.
3. **Unverified broker API details.** Each adapter marks assumptions as `TODO(verify)`: rate limits; Angel One's session lifetime, error codes and header values; position field names. Exercise each broker in its sandbox or with a tiny live order before relying on it. (The Upstox, Angel One and Groww public instrument masters were downloaded and parsed successfully on 30 Oct 2026.)
4. **Email OTP fallback.** The channel chain exists (`OtpChannel`), but no email provider has been chosen (`TODO(email OTP)`).
5. **Broker WebSocket order streams.** These are not used yet (`TODO(broker streams)`); polling and webhooks cover it in the meantime.
6. **Muhurat and special sessions.** These aren't modelled in market hours. List them as holidays or turn `RISK_ENFORCE_MARKET_HOURS` off for that day.
7. **Instrument master memory.** Angel One's scrip master is about 40 MB of JSON and is parsed whole. Watch memory on a 512 MB machine, or stream it.
8. **Load test against mocked brokers** (milestone 6) hasn't been run.
