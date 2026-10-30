# Deploy nexora-backend on Fly.io

This guide runs the server in Fly's **Singapore (`sin`)** region, the closest to Indian brokers (Fly has no Indian region). Orders leave from a **static egress IP** that you register with every broker. The data lives in **Postgres**, and the keys are Fly secrets.

> **Why one machine?** Brokers accept orders only from the IP you register. One machine with an app-scoped egress IP keeps that simple. Locks and jobs already work across several machines (they use Postgres advisory locks), but every machine would need the same whitelisted IP. Don't scale out until the broker gateway is split into its own service (see [architecture.md](architecture.md)).

## 1. Install flyctl and create the app

```bash
brew install flyctl
fly auth login
fly launch --no-deploy --copy-config --region sin
```

Put your app's name in `fly.toml` (`app = "…"`) and set `PUBLIC_URL` there to `https://<your-app>.fly.dev`.

## 2. Create the database

Use Postgres 16 in Singapore, next to the app: every order makes several database round trips.

```bash
fly mpg create --name nexora-backend-db --region sin --plan basic --org <your-org>
fly mpg status <cluster-id>          # shows the "Direct IP" host
```

Set `DATABASE_URL` to the cluster's **direct** host, not the PgBouncer one that `fly mpg create` prints and `fly mpg attach` sets. PgBouncer pools by transaction, which breaks the session-level advisory locks that stop two exits on the same order from running at once. Take the user, password and database from the printed connection string:

```bash
fly secrets set --stage DATABASE_URL="postgres://fly-user:<password>@direct.<cluster-id>.flympg.net:5432/fly-db?sslmode=verify-full"
```

`sslmode=verify-full` encrypts the connection and checks the cluster's certificate (a `*.<cluster-id>.flympg.net` certificate from a public CA), as Fly recommends. The private network is already encrypted, so this is defence in depth.

Any other hosted Postgres works too (Neon, Supabase, RDS in `ap-southeast-1`), as long as the connection isn't through a transaction-pooling proxy. The server applies its migrations on start, under an advisory lock.

## 3. Set the secrets

```bash
fly secrets set --stage ENCRYPTION_KEYS="1:$(openssl rand -base64 32)"
fly secrets set --stage JWT_PRIVATE_KEY="$(node src/cli.ts gen-jwt-key | base64)"
fly secrets set --stage ADMIN_TOKEN="$(openssl rand -hex 32)"
fly secrets set MSG91_AUTH_KEY="your-msg91-auth-key" MSG91_TEMPLATE_ID="your-dlt-template-id"
```

- `--stage` stores a secret without restarting the running machine; it takes effect at the next deploy.
- An existing `ENCRYPTION_KEY` (from 1.x) keeps working: it's read as key version 1. Don't set `ENCRYPTION_KEYS` as well unless you mean to rotate.
- **Keep a copy of `ENCRYPTION_KEYS` and `ADMIN_TOKEN`** in a password manager. You can't read them back from Fly, and without the encryption keys every stored broker credential is unreadable.
- The MSG91 template must carry the `##OTP##` placeholder. If your MSG91 key is locked to IPs, add the egress IP from step 4.
- For the Flutter web build: `fly secrets set CORS_ORIGINS="https://your-web-app.example.com"`.
- For paid plans: `fly secrets set BILLING_ENABLED=true RAZORPAY_KEY_ID=… RAZORPAY_KEY_SECRET=… RAZORPAY_WEBHOOK_SECRET=…`, and point the Razorpay webhook at `https://<your-app>.fly.dev/webhooks/razorpay` with the `subscription.*` events.

## 4. Allocate the static egress IP

```bash
fly ips allocate-egress --region sin
fly ips allocate-v4 --shared
fly ips allocate-v6
fly ips list
```

Note the egress IPv4: brokers see every order coming from it. Once an app has an egress IP, Fly stops giving it inbound addresses automatically, which is why the shared v4 and the v6 are added by hand.

## 5. Deploy and bootstrap

```bash
fly deploy
fly scale count 1
curl https://<your-app>.fly.dev/health
```

Create the app clients and your user:

```bash
ADMIN="Authorization: Bearer <ADMIN_TOKEN>"
curl -X POST https://<your-app>.fly.dev/admin/clients -H "$ADMIN" -H 'content-type: application/json' \
  -d '{"name":"NexoraApp iOS","platform":"ios"}'
curl -X POST https://<your-app>.fly.dev/admin/clients -H "$ADMIN" -H 'content-type: application/json' \
  -d '{"name":"NexoraApp web","platform":"web","refreshTtlSeconds":604800}'
curl -X POST https://<your-app>.fly.dev/admin/users -H "$ADMIN" -H 'content-type: application/json' \
  -d '{"phone":"9876543210"}'
```

Each client's `id` goes into that app's build as its `clientId`.

Then load the instrument master. It also refreshes daily at 08:15 IST. Kite's master needs one logged-in Zerodha account, so run this again after linking one:

```bash
curl -X POST https://<your-app>.fly.dev/admin/instruments/refresh -H "$ADMIN" -H 'content-type: application/json' -d '{}'
```

### Deploy automatically from GitHub

CI deploys every push to `main` once the tests pass. Give it a deploy token:

```bash
fly tokens create deploy -a <your-app> | gh secret set FLY_API_TOKEN
```

## 6. Register the IP with each broker

`GET /server/ip`, signed in, must return the egress IP from step 4 (if not, run `fly machine restart`). Register that IP, and set the redirect URL for the redirect-login brokers:

| Broker | Static IP | Redirect URL |
|---|---|---|
| Zerodha | developers.kite.trade → your app → IP whitelist | `https://<your-app>.fly.dev/broker-callback/zerodha` |
| Upstox | account.upstox.com/developer/apps → Primary IP | `https://<your-app>.fly.dev/broker-callback/upstox` (also enter it as the account's `redirectUri`) |
| Angel One | SmartAPI → My apps → static IP | none (TOTP login) |
| Groww | Trade API → API keys → static IP | none (daily approval) |

For Kite postbacks, set the postback URL to `https://<your-app>.fly.dev/webhooks/zerodha`.

Brokers may only let you change the IP about once a week, so check it before you register it.

## 7. Paper first, then live

1. Link accounts in the app. They start in paper mode, and paper orders never reach a broker.
2. Switch one account to live (`PATCH /broker-accounts/:id {"mode":"live"}`) and log in to the broker. With `LIVE_TRADING=false`, its orders are **dry-run**: the exact broker request is logged (`fly logs`) and the leg shows `DRY_RUN`.
3. When the payloads look right: `fly secrets set LIVE_TRADING=true`.

## Everyday operations

| Task | How |
|---|---|
| Logs | `fly logs`. These are JSON lines; search by `parentOrderId` or `traceId`. |
| **Pause all trading now** | `POST /admin/kill-switch {"on":true,"reason":"…"}`. It takes effect on the next order, with no restart. Cancels still go out. |
| Stop live sends entirely | `fly secrets set LIVE_TRADING=false` (restarts the machine). |
| Market holiday | `POST /admin/holidays {"day":"2026-11-09","name":"Diwali"}` |
| Reconciliation mismatches | `GET /admin/reconciliation/issues`; the check runs daily at 16:00 IST. |
| Rotate the encryption key | Add `2:<new key>` to `ENCRYPTION_KEYS`, deploy, then `POST /admin/jobs/reencrypt/run`. Remove the old key only after that. |
| Rotate the JWT key | Set a new `JWT_PRIVATE_KEY` and `JWT_KEY_ID`, and put the old public key in `JWT_PREVIOUS_PUBLIC_KEYS` for at least the access-token lifetime. |
| Back up | Use your Postgres provider's backups. Keep them with the `ENCRYPTION_KEYS` backup; one is useless without the other. |

## Moving from the SQLite version (1.x)

The old `/v1` API and SQLite database are not migrated. Re-create users with `POST /admin/users`, then re-link broker accounts in the app. The old Fly volume (`nexora_data`) can be deleted once you no longer need its data: `fly volumes destroy`.
