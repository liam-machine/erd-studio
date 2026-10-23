-- How the workspace builds its physical tables (dbt, sqlmesh, fabric, …) and on
-- which data platform (databricks, snowflake, …), as JSON arrays of fixed values.
-- NULL when the client did not look that day, or predates the fields.
-- Must be applied BEFORE the Worker that writes these columns is deployed;
-- deploy.yml applies migrations first.
ALTER TABLE heartbeats ADD COLUMN physical_tools TEXT;
ALTER TABLE heartbeats ADD COLUMN platforms TEXT;
