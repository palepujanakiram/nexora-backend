# nexora-backend

Node.js + TypeScript server for NexoraApp. It stores broker accounts and places signal orders on Zerodha, Upstox and Groww from one static IP. See [README.md](README.md).

## Architecture

- Clean Architecture: `src/domain` (pure rules, no I/O) → `src/brokers` and `src/data` (I/O) → `src/usecases` → `src/http`. Dependencies point inwards; `src/container.ts` is the only place they're wired.
- The outside world (fetch, clock, random) is injected through `Runtime`; never call global `fetch`, `Date.now()` or `Math.random()` from use cases or broker clients.
- Domain rules mirror nexora-app's Dart code (`lib/common/domain`, `lib/common/data/datasources/remote`). When you change one, change the other, and port the tests too.
- Broker API keys, secrets and access tokens are stored only encrypted (`SecretBox`) and never returned by the API, written to logs, or included in error messages.
- New accounts default to paper mode. Live orders also need `LIVE_TRADING=true`. Never place a real order from tests or tooling.
- TypeScript runs directly on Node 24 (type stripping): use only erasable syntax (no `enum`, no parameter properties, no namespaces) and import with `.ts` extensions.

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
- Storage tests use `openDb(':memory:')`. HTTP tests use `buildApp(...).inject(...)` with `createServices` on an in-memory database.
- Use the fixed clock (`NOW`, 27 Oct 2026 09:30 IST) so token-expiry and expiry-date logic is deterministic.

## Commands

```bash
npm install
npm run typecheck     # must report no errors
npm run coverage      # all tests + 95% coverage gate
npm run build         # compile to dist/
```
