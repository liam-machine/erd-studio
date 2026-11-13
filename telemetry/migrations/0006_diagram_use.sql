-- Use per diagram: the day's diagrams as a JSON array of [id, opens, edits].
-- `id` is a random number from 1 to 65535 that the extension made up for the
-- diagram and keeps on the device (0 adds up the diagrams past the 30 listed);
-- it is not derived from a name, path or contents, so it only says "the same
-- diagram as on another day" for that install. NULL on a day no diagram was
-- opened or edited, or from a client that predates it.
-- Must be applied BEFORE the Worker that writes this column is deployed;
-- deploy.yml applies migrations first.
ALTER TABLE heartbeats ADD COLUMN diagrams TEXT;
