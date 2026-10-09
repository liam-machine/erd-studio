-- Extension 1.6.3: editor app, remote kind, dev-host flag, detected AI
-- assistants, installed harnesses and on-device retention buckets.
-- Must be applied BEFORE the Worker that writes these columns is deployed;
-- deploy.yml applies migrations first. (Applied by hand to the live database
-- before migrations were tracked; README.md's one-time baseline records it.)
ALTER TABLE heartbeats ADD COLUMN host TEXT;
ALTER TABLE heartbeats ADD COLUMN remote TEXT;
ALTER TABLE heartbeats ADD COLUMN dev INTEGER;
ALTER TABLE heartbeats ADD COLUMN assistants TEXT;
ALTER TABLE heartbeats ADD COLUMN harnesses TEXT;
ALTER TABLE heartbeats ADD COLUMN active_days_28 TEXT;
ALTER TABLE heartbeats ADD COLUMN canvas_days_28 TEXT;
ALTER TABLE heartbeats ADD COLUMN first_canvas TEXT;
