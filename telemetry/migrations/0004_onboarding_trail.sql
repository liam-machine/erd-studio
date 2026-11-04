-- The onboarding trail: the day's events in order, as a JSON array of
-- [event, gap seconds, window, repeat] with fixed event ids only, and the count
-- of entries past its cap. NULL on a day the client did not keep one (after an
-- install's first week, unless the guide ran), or from a client that predates it.
-- Must be applied BEFORE the Worker that writes these columns is deployed;
-- deploy.yml applies migrations first.
ALTER TABLE heartbeats ADD COLUMN trail TEXT;
ALTER TABLE heartbeats ADD COLUMN trail_dropped INTEGER;
