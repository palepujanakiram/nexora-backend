# Deploy nexora-backend on Fly.io

This guide puts the server in Fly's **Singapore (`sin`)** region, the closest to Indian brokers now that Fly has no Indian region, with a **static outgoing IP** that you register with your brokers. The database lives on a persistent volume, and the keys are stored as Fly secrets.

**Time:** about 15 minutes. **Cost:** roughly US $5–7 a month. That covers one always-on shared-CPU machine with 512 MB, a 1 GB volume and one static egress IPv4 (about $3.60/month). Check [fly.io/docs/about/pricing](https://fly.io/docs/about/pricing/) for current prices.

> **Why one machine?** Brokers accept orders only from the IP you register, and the duplicate-order guard runs inside the server. One machine in one region keeps both simple. The `fly.toml` here is set up that way, so don't scale it out.

## 1. Install flyctl and sign in

```bash
brew install flyctl
fly auth login
```

On other platforms, see [fly.io/docs/flyctl/install](https://fly.io/docs/flyctl/install/).

## 2. Create the app

Pick a unique name and put it in `fly.toml` (`app = "…"`). Then, from this folder:

```bash
fly launch --no-deploy --copy-config --region sin
```

If it asks to tweak settings, say no. It should keep the existing `fly.toml`.

## 3. Create the volume for the database

```bash
fly volumes create nexora_data --region sin --size 1
```

## 4. Set the secrets

```bash
fly secrets set ENCRYPTION_KEY="$(openssl rand -base64 32)"
fly secrets set SIGNUP_CODE="pick-a-long-invite-code"
```

- **Save a copy of `ENCRYPTION_KEY` somewhere safe**, for example a password manager. You can't read it back from Fly. If it's lost, every stored broker secret becomes unreadable, and accounts have to be added again.
- `SIGNUP_CODE` is what you and your family type in the app to create logins. You can remove it later (`fly secrets unset SIGNUP_CODE`) to close sign-up.
- For **mobile number + OTP sign-in**, add your [MSG91](https://msg91.com) settings (the same ones ManageMyFloor uses). The auth key comes from the MSG91 panel. Without these settings, OTP sign-in is off and email sign-in still works.

  ```bash
  fly secrets set OTP_PROVIDER=msg91 MSG91_TEMPLATE_ID=6a589bd3dcc71da369052be4 MSG91_OTP_LENGTH=6 MSG91_OTP_EXPIRY_MINUTES=5 MSG91_AUTH_KEY="your-msg91-auth-key"
  ```

  MSG91 auth keys can be locked to IP addresses. If yours is, add the static egress IP from step 5 to it.
- If you'll use the Flutter **web** build, also allow its address:

  ```bash
  fly secrets set CORS_ORIGINS="https://your-web-app.example.com"
  ```

## 5. Allocate the static egress IP

This IP is what brokers will see every order coming from:

```bash
fly ips allocate-egress --region sin
fly ips list
```

Note the egress IPv4 address (Fly's docs: [Static egress IPs](https://fly.io/docs/networking/egress-ips/)). An app-scoped egress IP stays with the app when machines are replaced.

## 6. Deploy

```bash
fly deploy
```

Fly builds the Docker image on its own builders, so you don't need Docker locally. When it finishes:

```bash
curl https://<your-app>.fly.dev/health
# {"status":"ok","service":"nexora-backend","version":"1.0.0","liveTrading":false}
```

Make sure exactly one machine is running:

```bash
fly scale count 1
```

## 7. Check the IP brokers will see

Sign up first: in the app, or with the API (see [api.md](api.md)). Then:

```bash
curl -H "Authorization: Bearer <token>" https://<your-app>.fly.dev/v1/server/ip
```

The `ip` it returns must be the egress IP from step 5. If it isn't, run `fly machine restart` and check again.

## 8. Register that IP with each broker

| Broker | Where |
|---|---|
| Zerodha | [developers.kite.trade](https://developers.kite.trade) → Profile → **IP whitelist** |
| Upstox | [account.upstox.com/developer/apps](https://account.upstox.com/developer/apps) → your app → **Primary IP** |
| Groww | Trade API → **API keys** → **Add static IP** |

Brokers may let you change the registered IP only about once a week, so finish step 7 before you register it.

## 9. Try it with paper accounts, then go live

1. In NexoraApp, set the server URL (`https://<your-app>.fly.dev`) and sign in.
2. Add your broker accounts. They start in paper mode.
3. Log in to each broker for the day, and send a test signal. Check that the contract, quantity and price look right in the activity log.
4. When you're ready for real orders:

   ```bash
   fly secrets set LIVE_TRADING=true      # restarts the server
   ```

5. Turn off **Paper mode** on the accounts that should trade live.

## Everyday operations

| Task | Command |
|---|---|
| Logs | `fly logs` |
| Create a user without the invite code | `fly ssh console -C "sh -c 'NEXORA_PASSWORD=\"long password\" node dist/cli.js create-user you@example.com'"` |
| Back up the database | `fly ssh sftp get /data/nexora.db ./nexora-backup.db` (keep it with the `ENCRYPTION_KEY` backup; one is useless without the other) |
| Stop all live orders immediately | `fly secrets set LIVE_TRADING=false` |
| Update | `git pull && fly deploy` |

Fly also takes daily snapshots of the volume, kept for 5 days by default (`fly volumes snapshots list nexora_data`).

## Troubleshooting

| Problem | Fix |
|---|---|
| Broker says the IP isn't allowed (Upstox **UDAPI1154**, Kite "IP not whitelisted") | `GET /v1/server/ip` must match the IP registered with the broker. Restart the machine if it shows something else. |
| `Live trading is turned off on this server` | `fly secrets set LIVE_TRADING=true`. |
| `Session expired — log in to … first` | Broker sessions end daily (06:00 IST for Kite and Groww, 03:30 IST for Upstox). Log in again from the app. |
| `Already placed on this account at …` | Another device already sent this signal in the last 15 minutes. Use **Place anyway** in the app if you really want a second order. |
| Server won't start: `ENCRYPTION_KEY must be 32 bytes` | Set it again with `openssl rand -base64 32`. If accounts already exist, use the original key. |
