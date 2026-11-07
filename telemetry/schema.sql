-- ERD Studio usage telemetry — D1 schema (contract v1), current shape.
--
-- REFERENCE ONLY: do not apply this file. The database is built by
-- migrations/, applied with `wrangler d1 migrations apply` (see README.md).
-- This is what those migrations add up to, in one place to read;
-- test/schema.test.mjs fails when the two disagree.
--
-- heartbeats: one row per install per UTC day. No IP, user-agent, geo or header
-- is ever stored; `received_day` is the date the Worker received the row, and
-- the daily cron deletes rows whose received_day is more than 90 days old.
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
  -- Added for extension 1.6.3 (migrations/0002_host_assistants_retention.sql).
  -- NULL on rows from older clients.
  host TEXT,
  remote TEXT,
  dev INTEGER,
  assistants TEXT,               -- JSON array
  harnesses TEXT,                -- JSON array
  active_days_28 TEXT,
  canvas_days_28 TEXT,
  first_canvas TEXT,
  -- Added by migrations/0003_physical_tooling.sql. NULL when the client did not
  -- look that day, or predates the fields.
  physical_tools TEXT,           -- JSON array
  platforms TEXT,                -- JSON array
  -- Added by migrations/0004_onboarding_trail.sql. NULL on a day without a trail.
  trail TEXT,                    -- JSON array of [event, gap, window, repeat]
  trail_dropped INTEGER,
  PRIMARY KEY (install_id, day)
);
CREATE INDEX IF NOT EXISTS idx_heartbeats_day ON heartbeats(day);
CREATE INDEX IF NOT EXISTS idx_heartbeats_received ON heartbeats(received_day);

-- Added by migrations/0005_worker_daily.sql: the Worker's own ledger, one row
-- per UTC day the Worker received requests, extension version family
-- (major.minor, or 'other'), outcome ('ok' / 'denied') and reason ('none',
-- 'body_size', 'json' or 'shape_<field>'): how many heartbeats arrived and how
-- many unknown features / errors keys and trail events were dropped from the
-- accepted ones. No install id, IP, header, body text or key name. The daily
-- cron deletes rows whose day is more than 90 days old.
CREATE TABLE IF NOT EXISTS worker_daily (
  day TEXT NOT NULL,
  ext_family TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  dropped_features INTEGER NOT NULL DEFAULT 0,
  dropped_errors INTEGER NOT NULL DEFAULT 0,
  dropped_trail INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ext_family, outcome, reason)
);
