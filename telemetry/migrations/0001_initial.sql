-- ERD Studio usage telemetry: the contract v1 table, as first deployed.
--
-- Applied by `wrangler d1 migrations apply erd-studio-telemetry --remote`,
-- which records each file in the `d1_migrations` table and applies it once
-- (deploy.yml runs it before every Worker deploy). Wrangler tracks files by
-- name only, so never change the SQL of an applied migration: add the next
-- number instead, and update schema.sql, which shows the result.
--
-- One row per install per UTC day. No IP, user-agent, geo or header is ever
-- stored; `received_day` is the date the Worker received the row, and the daily
-- cron deletes rows whose received_day is more than 90 days old.
CREATE TABLE IF NOT EXISTS heartbeats (
  install_id TEXT NOT NULL,
  day TEXT NOT NULL,
  received_day TEXT NOT NULL,
  ext_version TEXT NOT NULL,
  vscode_major TEXT NOT NULL,
  os TEXT NOT NULL,
  tenure TEXT NOT NULL,
  activation TEXT NOT NULL,
  has_semantic_dir INTEGER NOT NULL,
  domain_count TEXT NOT NULL,
  activations INTEGER NOT NULL,
  canvas_opens INTEGER NOT NULL,
  stages TEXT NOT NULL,          -- JSON array
  schema_formats TEXT NOT NULL,  -- JSON array
  model_count TEXT NOT NULL,
  manifest TEXT NOT NULL,
  catalog INTEGER NOT NULL,
  features TEXT NOT NULL,        -- JSON object
  errors TEXT NOT NULL,          -- JSON object
  PRIMARY KEY (install_id, day)
);
CREATE INDEX IF NOT EXISTS idx_heartbeats_day ON heartbeats(day);
CREATE INDEX IF NOT EXISTS idx_heartbeats_received ON heartbeats(received_day);
