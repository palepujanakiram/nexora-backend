# nexora-backend

Node.js + TypeScript server for NexoraApp. It fans one order out to many broker accounts (Zerodha, Upstox, Angel One, Groww) from one static IP and tracks each leg until it's terminal. See [README.md](README.md) and [docs/architecture.md](docs/architecture.md).

## Architecture

- Clean Architecture: `src/domain` (pure rules, no I/O) → `src/brokers` and `src/data` (I/O) → `src/usecases` → `src/http`. Dependencies point inwards; `src/container.ts` is the only place they're wired.
- The outside world (fetch, clock, sleep) is injected through `Runtime`; never call global `fetch`, `Date.now()` or `Math.random()` from use cases or broker clients.
- Nothing outside `src/brokers/<name>/` may know which broker it talks to. A new broker is one adapter folder plus one line in `src/brokers/registry.ts`. Every broker HTTP call goes through `BrokerHttp` (`ctx.http`).
- Money is integer paise (`domain/money.ts`), never floats. Rupees exist only in JSON and broker payloads.
- Every broker write is confirmed by reading the order back. A timeout or 5xx on a write is `UNKNOWN` (reconciled), never a failure. A leg's status changes only through `LegTracker`/`OrderRepository.updateLeg`, which writes the append-only audit event.
- Cancel, modify and exit are never gated by the subscription.
- The signal parser mirrors nexora-app's Dart code. When you change one, change the other, and port the tests too.
- Broker API keys, secrets and access tokens are stored only encrypted (`SecretBox`, versioned keys), decrypted only by the broker gateway, and never returned by the API, written to logs, or included in error messages. Log fields pass an allowlist (`LOGGABLE_FIELDS` in `src/logging.ts`); add a field there deliberately.
- New accounts default to paper mode. Live orders also need `LIVE_TRADING=true` (otherwise writes are dry-run: logged, not sent). Never place a real order from tests or tooling.
- Schema changes: append a migration to `src/data/schema.ts`; never edit an applied one.
- TypeScript runs directly on Node 24 (type stripping): use only erasable syntax (no `enum`, no parameter properties, no namespaces) and import with `.ts` extensions.

## Strict typing

The compiler runs in `strict` mode plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` and the unused/unreachable checks (`tsconfig.json`). On top of that, `npm run lint` runs typescript-eslint's `strict-type-checked` rules, and CI fails on any finding.

- No `any`, written or inferred. Untyped input (JSON, broker payloads, database rows) is `unknown` until it's checked: parse it with a zod schema, or read fields with `textOf` / `objectOf` / `positivePaise`.
- No non-null `!`. Use a narrowing check, or `must(value, what)` / `single(rows, what)` from `src/domain/invariant.ts` for values the code itself guarantees (a row it just wrote, a regex group that matched).
- No `as` to change a type you haven't checked. Use a type guard (`isExchange`, `isInstrumentType`, `isClientPlatform`) instead. The one sanctioned assertion is where `Db.query<T>` types its rows.
- No `eslint-disable`, `@ts-ignore` or `@ts-expect-error`. Every function that returns a promise is `async`, so errors always arrive as rejections.

## Code coverage is mandatory

Every change comes with tests. **Line coverage of `src/` must stay at or above 95%**, and CI fails below that.

- Add or update tests in the same change as the code. A new file under `src/` needs tests that execute it.
- Check before you finish:
  ```bash
  npm run typecheck && npm run coverage
  ```
- Don't add coverage exclusions or lower the thresholds to get a change through. If code is hard to test, restructure it (inject the dependency, return instead of exiting) and say so in the PR.
- Test behaviour: assert on responses, stored state and error messages, including failure paths.

## Testing conventions

- Tests mirror `src/` under `test/`. Shared builders and the fake fetch are in `test/helpers.ts`; extend them there.
- Broker HTTP calls are tested with `fakeFetch` from `test/helpers.ts`, asserting on the recorded URL, headers and body. Tests never call the network or a real broker.
- Storage tests use `testDb()` from `test/db.ts` (PGlite: real Postgres in-process, cloned from a migrated template). Service tests use `harness()` and HTTP tests use `testApp()` / `signIn()` from `test/app.ts`.
- Order flows run the real adapters against the stateful fakes in `test/fakes.ts` (`FakeKite`, `FakeUpstox`, `brokerWorld`).
- Use the fixed clock (`NOW`, Tue 27 Oct 2026 09:30 IST, market open), or `testClock()` to move it, so expiry, market-hours and reconciliation timing are deterministic.

## Commands

```bash
npm install
npm run typecheck     # must report no errors
npm run lint          # strict type-aware lint, must report nothing
npm run coverage      # all tests + 95% coverage gate
npm run build         # compile to dist/
```
