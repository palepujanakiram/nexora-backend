/**
 * Each entry upgrades the schema by one version (tracked in `schema_migrations`).
 * Never edit an applied entry; append a new one.
 *
 * Money is integer paise (`*_paise bigint`), never floating point. Tables are
 * grouped by module, and no module reads another module's tables directly.
 */
export const MIGRATIONS: readonly string[] = [
  `
  -- Identity -------------------------------------------------------------
  CREATE TABLE users (
    id text PRIMARY KEY,
    phone text NOT NULL UNIQUE,
    email text UNIQUE,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at timestamptz NOT NULL
  );

  CREATE TABLE clients (
    id text PRIMARY KEY,
    name text NOT NULL,
    platform text NOT NULL CHECK (platform IN ('web', 'ios', 'android', 'partner', 'other')),
    grant_types text[] NOT NULL,
    access_ttl_seconds integer NOT NULL CHECK (access_ttl_seconds BETWEEN 60 AND 3600),
    refresh_ttl_seconds integer NOT NULL CHECK (refresh_ttl_seconds BETWEEN 300 AND 31536000),
    created_at timestamptz NOT NULL
  );

  -- One row per signed-in device. Refresh tokens rotate within it; reusing an
  -- old one revokes the whole session.
  CREATE TABLE sessions (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id text NOT NULL REFERENCES clients(id),
    device text NOT NULL,
    ip text NOT NULL,
    created_at timestamptz NOT NULL,
    last_used_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoked_reason text
  );
  CREATE INDEX sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;

  CREATE TABLE refresh_tokens (
    token_hash text PRIMARY KEY,
    session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL,
    used_at timestamptz
  );
  CREATE INDEX refresh_tokens_session ON refresh_tokens(session_id);

  -- Only a hash of each code is stored.
  CREATE TABLE otp_codes (
    id text PRIMARY KEY,
    -- Insertion order, so "latest" is exact even for codes sent in the same millisecond.
    seq bigserial NOT NULL,
    phone text NOT NULL,
    ip text NOT NULL,
    code_hash text NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    used_at timestamptz
  );
  CREATE INDEX otp_codes_phone ON otp_codes(phone, seq DESC);
  CREATE INDEX otp_codes_ip ON otp_codes(ip, created_at DESC);

  -- Broker gateway --------------------------------------------------------
  -- Every *_enc column is AES-256-GCM ciphertext tagged with its key version.
  CREATE TABLE broker_accounts (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    broker text NOT NULL,
    label text NOT NULL,
    mode text NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper', 'live')),
    credentials_enc text NOT NULL,
    token_enc text,
    token_expires_at timestamptz,
    token_state text NOT NULL DEFAULT 'none'
      CHECK (token_state IN ('none', 'valid', 'expired', 'needs_user_action')),
    token_message text,
    last_auth_at timestamptz,
    created_at timestamptz NOT NULL,
    UNIQUE (user_id, label)
  );
  CREATE INDEX broker_accounts_user ON broker_accounts(user_id);

  -- Paper trading: a simulated broker for accounts in paper mode.
  CREATE TABLE paper_orders (
    id text PRIMARY KEY,
    broker_account_id text NOT NULL,
    native_id text NOT NULL,
    trading_symbol text NOT NULL,
    exchange text NOT NULL,
    side text NOT NULL,
    product text NOT NULL,
    order_type text NOT NULL,
    quantity integer NOT NULL,
    filled_qty integer NOT NULL,
    status text NOT NULL,
    price_paise bigint,
    trigger_paise bigint,
    avg_price_paise bigint,
    client_ref text NOT NULL,
    created_at timestamptz NOT NULL
  );
  CREATE INDEX paper_orders_account ON paper_orders(broker_account_id);

  -- Instruments -----------------------------------------------------------
  CREATE TABLE instruments (
    id text PRIMARY KEY,
    exchange text NOT NULL,
    type text NOT NULL CHECK (type IN ('EQ', 'FUT', 'CE', 'PE')),
    underlying text NOT NULL,
    expiry date,
    strike_paise bigint,
    lot_size integer NOT NULL CHECK (lot_size > 0),
    tick_paise integer NOT NULL CHECK (tick_paise > 0),
    refreshed_at timestamptz NOT NULL
  );
  CREATE INDEX instruments_lookup ON instruments(underlying, type, expiry);

  CREATE TABLE instrument_mappings (
    instrument_id text NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
    broker text NOT NULL,
    native_id text NOT NULL,
    trading_symbol text NOT NULL,
    broker_exchange text NOT NULL,
    refreshed_at timestamptz NOT NULL,
    PRIMARY KEY (instrument_id, broker)
  );
  CREATE INDEX instrument_mappings_native ON instrument_mappings(broker, native_id);

  -- Orders ----------------------------------------------------------------
  CREATE TABLE parent_orders (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id),
    client_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('ENTRY', 'EXIT')),
    exit_of text REFERENCES parent_orders(id),
    instrument_id text NOT NULL REFERENCES instruments(id),
    side text NOT NULL CHECK (side IN ('BUY', 'SELL')),
    quantity integer NOT NULL CHECK (quantity > 0),
    order_type text NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT', 'SL', 'SL_M')),
    product text NOT NULL CHECK (product IN ('DELIVERY', 'INTRADAY', 'CARRYFORWARD')),
    price_paise bigint,
    trigger_paise bigint,
    reference_price_paise bigint,
    algo_id text,
    idempotency_key text NOT NULL,
    status text NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETE', 'PARTIAL', 'FAILED', 'CANCELLED')),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  );
  CREATE INDEX parent_orders_user ON parent_orders(user_id, created_at DESC);

  CREATE TABLE order_legs (
    id text PRIMARY KEY,
    parent_order_id text NOT NULL REFERENCES parent_orders(id),
    broker_account_id text NOT NULL,
    broker text NOT NULL,
    mode text NOT NULL CHECK (mode IN ('paper', 'live')),
    client_ref text NOT NULL UNIQUE,
    broker_order_id text,
    status text NOT NULL CHECK (status IN (
      'PENDING_SUBMIT', 'SUBMITTED', 'OPEN', 'PARTIALLY_FILLED', 'FILLED',
      'CANCELLED', 'REJECTED', 'EXPIRED', 'UNKNOWN')),
    quantity integer NOT NULL,
    filled_qty integer NOT NULL DEFAULT 0,
    avg_price_paise bigint,
    order_type text NOT NULL,
    price_paise bigint,
    trigger_paise bigint,
    error_code text,
    error_message text,
    reconcile_at timestamptz,
    reconcile_attempts integer NOT NULL DEFAULT 0,
    submitted_at timestamptz,
    terminal_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (parent_order_id, broker_account_id)
  );
  CREATE INDEX order_legs_reconcile ON order_legs(reconcile_at) WHERE reconcile_at IS NOT NULL;
  CREATE INDEX order_legs_broker_order ON order_legs(broker, broker_order_id);
  CREATE INDEX order_legs_account ON order_legs(broker_account_id, created_at);

  -- Audit trail: append-only, enforced by the trigger below.
  CREATE TABLE order_events (
    id bigserial PRIMARY KEY,
    leg_id text NOT NULL REFERENCES order_legs(id),
    parent_order_id text NOT NULL,
    action text NOT NULL,
    from_status text,
    to_status text NOT NULL,
    source text NOT NULL,
    raw_request jsonb,
    raw_response jsonb,
    at timestamptz NOT NULL
  );
  CREATE INDEX order_events_leg ON order_events(leg_id, id);

  CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
  END $$;
  CREATE TRIGGER order_events_append_only BEFORE UPDATE OR DELETE ON order_events
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

  -- Replays of the same Idempotency-Key return the stored response.
  CREATE TABLE idempotency_keys (
    user_id text NOT NULL,
    key text NOT NULL,
    operation text NOT NULL,
    request_hash text NOT NULL,
    status_code integer,
    response jsonb,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  CREATE INDEX idempotency_keys_created ON idempotency_keys(created_at);

  CREATE TABLE positions (
    broker_account_id text NOT NULL,
    native_id text NOT NULL,
    instrument_id text,
    trading_symbol text NOT NULL,
    exchange text NOT NULL,
    product text NOT NULL,
    net_qty integer NOT NULL,
    avg_price_paise bigint,
    last_price_paise bigint,
    pnl_paise bigint,
    synced_at timestamptz NOT NULL,
    PRIMARY KEY (broker_account_id, native_id, product)
  );

  -- Legs whose broker state didn't match ours at end of day, for a human.
  CREATE TABLE reconciliation_issues (
    id bigserial PRIMARY KEY,
    leg_id text,
    broker_account_id text NOT NULL,
    broker_order_id text,
    kind text NOT NULL,
    detail text NOT NULL,
    found_at timestamptz NOT NULL,
    resolved_at timestamptz
  );

  -- Risk ------------------------------------------------------------------
  CREATE TABLE settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL
  );
  CREATE TABLE market_holidays (
    day date PRIMARY KEY,
    name text NOT NULL
  );

  -- Billing ---------------------------------------------------------------
  CREATE TABLE plans (
    code text PRIMARY KEY,
    name text NOT NULL,
    price_paise bigint NOT NULL,
    interval text NOT NULL CHECK (interval IN ('monthly', 'yearly')),
    max_accounts integer NOT NULL,
    max_orders_per_day integer NOT NULL,
    max_fanout integer NOT NULL,
    brokers text[] NOT NULL,
    razorpay_plan_id text,
    active boolean NOT NULL DEFAULT true
  );

  CREATE TABLE subscriptions (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id),
    plan_code text NOT NULL REFERENCES plans(code),
    status text NOT NULL CHECK (status IN (
      'created', 'active', 'past_due', 'halted', 'cancelled', 'expired')),
    current_period_end timestamptz,
    grace_until timestamptz,
    cancel_at_period_end boolean NOT NULL DEFAULT false,
    provider_ref text UNIQUE,
    checkout_url text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  );
  CREATE INDEX subscriptions_user ON subscriptions(user_id, created_at DESC);

  CREATE TABLE payment_events (
    id bigserial PRIMARY KEY,
    subscription_id text,
    provider_event_id text NOT NULL UNIQUE,
    type text NOT NULL,
    raw_payload jsonb NOT NULL,
    at timestamptz NOT NULL
  );
  CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON payment_events
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

  -- Analytics (read path; never joined to the order tables) ---------------
  -- Written in the same transaction as a leg's terminal transition, then
  -- moved into analytics_leg_facts by a background job.
  CREATE TABLE analytics_outbox (
    id bigserial PRIMARY KEY,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL
  );

  CREATE TABLE analytics_leg_facts (
    leg_id text PRIMARY KEY,
    user_id text NOT NULL,
    broker_account_id text NOT NULL,
    broker text NOT NULL,
    mode text NOT NULL,
    instrument_id text NOT NULL,
    kind text NOT NULL,
    side text NOT NULL,
    order_type text NOT NULL,
    status text NOT NULL,
    error_code text,
    quantity integer NOT NULL,
    filled_qty integer NOT NULL,
    avg_price_paise bigint,
    reference_price_paise bigint,
    submitted_at timestamptz,
    terminal_at timestamptz NOT NULL,
    day date NOT NULL
  );
  CREATE INDEX analytics_leg_facts_user_day ON analytics_leg_facts(user_id, day);

  CREATE TABLE analytics_execution_daily (
    day date NOT NULL,
    user_id text NOT NULL,
    broker text NOT NULL,
    instrument_id text NOT NULL,
    side text NOT NULL,
    legs integer NOT NULL,
    filled integer NOT NULL,
    rejected integer NOT NULL,
    rejections jsonb NOT NULL,
    slippage_bps_sum double precision NOT NULL,
    slippage_samples integer NOT NULL,
    fill_ms_sum bigint NOT NULL,
    fill_samples integer NOT NULL,
    PRIMARY KEY (day, user_id, broker, instrument_id, side)
  );

  CREATE TABLE analytics_position_snapshots (
    broker_account_id text NOT NULL,
    user_id text NOT NULL,
    native_id text NOT NULL,
    trading_symbol text NOT NULL,
    net_qty integer NOT NULL,
    pnl_paise bigint,
    at timestamptz NOT NULL,
    PRIMARY KEY (broker_account_id, native_id)
  );

  CREATE TABLE job_state (
    name text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL
  );
  `,
  `
  -- Identity: self sign-up -------------------------------------------------
  -- full_name is set for users who signed themselves up; null for users an admin created.
  -- created_via says how the user was created: 'admin' (POST /admin/users or the CLI; every
  -- user before this migration) or 'client' (self sign-up through a registered app, named by
  -- created_by_client_id).
  ALTER TABLE users
    ADD COLUMN full_name text,
    ADD COLUMN created_via text NOT NULL DEFAULT 'admin' CHECK (created_via IN ('admin', 'client')),
    ADD COLUMN created_by_client_id text REFERENCES clients(id),
    ADD CONSTRAINT users_created_by_client CHECK ((created_via = 'client') = (created_by_client_id IS NOT NULL));

  -- Each statement the user confirmed: when, from where, and the version of the wording they saw.
  CREATE TABLE user_consents (
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('terms', 'risk', 'data_use')),
    version text NOT NULL,
    accepted_at timestamptz NOT NULL,
    ip text NOT NULL,
    PRIMARY KEY (user_id, kind, version)
  );

  -- A sign-up code can't sign in, and a sign-in code can't sign up.
  ALTER TABLE otp_codes ADD COLUMN purpose text NOT NULL DEFAULT 'login' CHECK (purpose IN ('login', 'signup'));
  DROP INDEX otp_codes_phone;
  CREATE INDEX otp_codes_phone ON otp_codes(phone, purpose, seq DESC);
  `,
];
