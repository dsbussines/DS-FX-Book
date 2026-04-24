CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  pnl NUMERIC NOT NULL,
  note TEXT DEFAULT '',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS community_posts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  user_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id),
  broker TEXT NOT NULL,
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS mt5_webhook_events (
  event_id TEXT PRIMARY KEY,
  user_id BIGINT REFERENCES users(id),
  account TEXT,
  platform TEXT,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  received_at BIGINT NOT NULL,
  raw_payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trades_user_created_at ON trades(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_posts_created_at ON community_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mt5_events_user_received_at ON mt5_webhook_events(user_id, received_at DESC);
