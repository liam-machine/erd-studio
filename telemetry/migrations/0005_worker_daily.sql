-- The worker_daily ledger: per UTC day the Worker received requests, per
-- extension version family (major.minor, or 'other'), outcome ('ok' / 'denied')
-- and reason ('none', 'body_size', 'json' or 'shape_<field>' from a fixed list),
-- how many heartbeats arrived (n) and how many unknown features / errors keys
-- and trail events were dropped from the accepted ones. It tells a version
-- nobody runs from one whose heartbeats this Worker refuses or strips.
--
-- No install id, IP, header, body text or unknown key name is stored. `day` is
-- the Worker's own UTC date; the daily cron deletes rows older than 90 days.
-- Must be applied BEFORE the Worker that writes it is deployed; deploy.yml
-- applies migrations first.
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
