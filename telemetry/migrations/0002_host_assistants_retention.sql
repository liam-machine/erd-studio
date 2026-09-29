-- Extension 1.6.3: editor app, remote kind, dev-host flag, detected AI
-- assistants, installed harnesses and on-device retention buckets.
-- Apply once to the existing database BEFORE deploying the Worker that writes
-- these columns:
--   npx wrangler d1 execute erd-studio-telemetry --remote --file migrations/0002_host_assistants_retention.sql
-- A fresh database gets them from schema.sql instead.
ALTER TABLE heartbeats ADD COLUMN host TEXT;
ALTER TABLE heartbeats ADD COLUMN remote TEXT;
ALTER TABLE heartbeats ADD COLUMN dev INTEGER;
ALTER TABLE heartbeats ADD COLUMN assistants TEXT;
ALTER TABLE heartbeats ADD COLUMN harnesses TEXT;
ALTER TABLE heartbeats ADD COLUMN active_days_28 TEXT;
ALTER TABLE heartbeats ADD COLUMN canvas_days_28 TEXT;
ALTER TABLE heartbeats ADD COLUMN first_canvas TEXT;
