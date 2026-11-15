-- Whether a project's ERD Studio files are one person's or a team's: the number
-- of distinct commit authors under its `.erd-studio/` directory in the last 90
-- days, as a bucket ('0', '1', '2-3', '4-10', '10+'). The extension counts them
-- on the device from `git log`; no name, email, remote, hash or path is sent,
-- so the bucket cannot say which project or which people. NULL when it was not
-- counted that day (no project, no git, an untrusted workspace) or from a
-- client that predates it.
-- Must be applied BEFORE the Worker that writes this column is deployed;
-- deploy.yml applies migrations first.
ALTER TABLE heartbeats ADD COLUMN contributors TEXT;
