# Harbor database migrations (PostgreSQL)

## What it is

Harbor is a CNCF container registry. Its database schema is built by a folder of
ordered PostgreSQL up-migrations, run by golang-migrate. There are 39 files,
from `0001_initial_schema.up.sql` (Harbor 1.6) to `0190_2.16.0_schema.up.sql`
(Harbor 2.16). Later files rename tables, add, rename and drop columns, change
column types, drop tables and add and drop constraints. This makes it a good
test of importing a migrations folder as its final schema.

## Where it came from

- Repository: https://github.com/goharbor/harbor
- Folder: https://github.com/goharbor/harbor/tree/3852755e06aa621ebfc7b665545de1e7d0032b47/make/migrations/postgresql
- Pinned commit: `3852755e06aa621ebfc7b665545de1e7d0032b47` (`main`, 2026-11-06).
  The last commit to touch the folder is `37dc02fdff10f3b93dc4668d3c13b9c104959ed4` (2026-09-29).
  The latest release tag at the time was `v2.14.6`; `main` already holds the 2.15 and 2.16 migrations.
- Downloaded file by file from `raw.githubusercontent.com` at the pinned commit.

## Licence

Apache License 2.0. Redistribution is allowed if a copy of the licence goes with
the files. It is kept here as `UPSTREAM-LICENSE.txt`. Harbor has no `NOTICE` file.
The files are unchanged.

## What was copied

All 39 `*.up.sql` files of `make/migrations/postgresql/`, byte for byte, at the
same relative path (`make/migrations/postgresql/`). The folder holds no down
migrations, so nothing was removed. Nothing else from the repository was copied.

The numbers have gaps (0005 → 0010 → 0015 → 0030 …). Ordered by name (numeric),
the files run in the same order as golang-migrate runs them.

## How the counts were made

I read every file by hand and kept a running list of tables and columns through
each CREATE TABLE, ALTER TABLE (ADD / DROP / RENAME COLUMN, RENAME TO) and
DROP TABLE. I then checked the result with a small throwaway Python script of my
own that replays the same statements (it skips comments, string literals and
`$$ … $$` bodies). Both gave the same tables and columns. These counts were made
before ERD Studio was run, so they do not depend on it. What the import got right and
wrong is in `ANALYSIS.md` and `import-review.mp4`.

Counts are for the **final schema**, after all 39 files have run.

- **Tables: 48.** 61 tables are created over time; 13 are dropped.
  `schema_migrations` (golang-migrate's own table) is altered but never created
  in these files, so it is not counted.
- **Columns: 397.**
- **Primary keys: 47.** Every one is a single column. `alembic_version` has no primary key.
- **Foreign keys: 14** in the final schema.
  - 13 are written as plain `FOREIGN KEY … REFERENCES` in a CREATE TABLE.
  - 1 (`project_member.role → role.role_id`, file 0190) is added by
    `ALTER TABLE … ADD CONSTRAINT` **inside a `DO $$ … $$` block**. An importer
    that skips `DO` blocks will find 13.
  - 1 more was declared and later dropped: `artifact_accessory.subject_artifact_id → artifact.id`
    (created in 0080, dropped in 0110 by its Postgres auto-generated name
    `artifact_accessory_subject_artifact_id_fkey`). An importer that cannot match
    that name will show 15.

Many other `*_id` columns (for example `repository.project_id`, `robot.project_id`)
point at other tables but have no foreign key. They are not counted.

## Final tables

"Changed later" means a later file renamed the table, or added, renamed, dropped
or retyped one of its columns.

| # | Table | Columns | Primary key | Foreign keys (from this table) | Changed later |
|---|---|---|---|---|---|
| 1 | access | 3 | access_id | | |
| 2 | role | 11 | role_id | | 0190: 7 columns added (`created_at` and `modified_at` are TIMESTAMP WITH TIME ZONE), `name` widened to varchar(255) |
| 3 | harbor_user | 13 | user_id | | 0011: `password_version` added |
| 4 | project | 7 | project_id | owner_id → harbor_user.user_id | 0040: `registry_id` added |
| 5 | project_member | 7 | id | role → role.role_id (in a DO block) | 0190: FK added |
| 6 | project_metadata | 6 | id | project_id → project.project_id | 0010: `deleted` dropped |
| 7 | user_group | 6 | id | | |
| 8 | repository | 8 | repository_id | | |
| 9 | replication_policy | 20 | id | | 0004: `target_id` → `dest_registry_id`, `cron_str` → `trigger`, `project_id` dropped, 4 added; 0060–0170: 4 more added |
| 10 | registry | 13 | id | | 0004: renamed from `replication_target`; `username` → `access_key`, `password` → `access_secret`, `target_type` dropped, 4 added; 0180: `ca_certificate` added |
| 11 | properties | 3 | id | | `v` retyped twice, ends as text |
| 12 | harbor_label | 10 | id | | |
| 13 | alembic_version | 1 | none | | |
| 14 | job_log | 4 | log_id | | |
| 15 | robot | 14 | id | | 0015–0150: 6 added; 0190: `id` and `creator_ref` to bigint |
| 16 | oidc_user | 7 | id | user_id → harbor_user.user_id | |
| 17 | cve_allowlist | 6 | id | | 0040: renamed from `cve_whitelist` (`ALTER TABLE IF EXISTS … RENAME TO`) |
| 18 | blob | 8 | id | | 0040: 3 added |
| 19 | project_blob | 4 | id | | |
| 20 | artifact | 15 | id | | 0030: `kind` → `type`, `repo` → `repository_name`, `creation_time` and `tag` dropped, 6 added; 0040: `icon`; 0140: `artifact_type` |
| 21 | artifact_blob | 4 | id | | |
| 22 | quota | 7 | id | | 0070: `version` added |
| 23 | quota_usage | 7 | id | | 0070: `version` added |
| 24 | retention_policy | 7 | id | | 0080: `create_time`, `update_time` from time to timestamp (`USING`) |
| 25 | schedule | 11 | id | | 0040: `job_id`, `status` dropped, 5 added; 0050, 0052: 3 added; 0181: `revision` to bigint |
| 26 | notification_policy | 10 | id | | unique constraints dropped and re-added |
| 27 | scanner_registration | 14 | id | | |
| 28 | scan_report | 13 | id | | 0050: 8 dropped; 0120: 7 added |
| 29 | immutable_tag_rule | 5 | id | | |
| 30 | tag | 6 | id | artifact_id → artifact.id | |
| 31 | artifact_reference | 7 | id | parent_id → artifact.id; child_id → artifact.id | |
| 32 | artifact_trash | 6 | id | | |
| 33 | label_reference | 5 | id | label_id → harbor_label.id; artifact_id → artifact.id | |
| 34 | audit_log | 7 | id | | |
| 35 | execution | 11 | id | | 0050: `update_time` added |
| 36 | task | 14 | id | execution_id → execution.id | 0050: `vendor_type` added; 0181: `status_revision` to bigint |
| 37 | p2p_preheat_instance | 11 | id | | 0181: `setup_timestamp` to bigint |
| 38 | p2p_preheat_policy | 11 | id | | 0150 adds `scope`, 0160 drops it and adds `extra_attrs` |
| 39 | data_migrations | 4 | id | | |
| 40 | role_permission | 5 | id | | 0170: `id`, `permission_policy_id` to bigint; 0190: `role_id` to bigint |
| 41 | permission_policy | 6 | id | | 0170: `id` to bigint |
| 42 | vulnerability_record | 17 | id | registration_uuid → scanner_registration.uuid | 0170: `status` added |
| 43 | report_vulnerability_record | 3 | id | vuln_record_id → vulnerability_record.id; report_uuid → scan_report.uuid | |
| 44 | artifact_accessory | 10 | id | artifact_id → artifact.id | 0110: 2 added, FK on `subject_artifact_id` dropped; 0190: `source` added |
| 45 | system_artifact | 8 | id | | |
| 46 | job_queue_status | 4 | id | | none (`update_time` is timestamp with time zone, 0100:7) |
| 47 | sbom_report | 7 | id | | |
| 48 | audit_log_ext | 11 | id | | |
| | **Total** | **397** | **47** | **14** | |

### Tables created and later dropped (must not appear)

`access_log`, `replication_immediate_trigger`, `img_scan_job`, `img_scan_overview`,
`clair_vuln_timestamp`, `harbor_resource_label`, `admin_job`,
`replication_job` (renamed to `replication_schedule_job`, then dropped),
`replication_execution`, `replication_task`, `retention_execution`,
`retention_task`, `notification_job`.

## Notable features an importer might drop or mangle

- **Table renames:** `replication_target` → `registry`, `replication_job` →
  `replication_schedule_job` (then dropped), `cve_whitelist` → `cve_allowlist`
  (written `ALTER TABLE IF EXISTS … RENAME TO`).
- **Column renames:** 7 (`username` → `access_key`, `password` → `access_secret`,
  `target_id` → `dest_registry_id`, `cron_str` → `trigger`, `job_uuid` → `job_id`,
  `kind` → `type`, `repo` → `repository_name`).
- **Column drops** and a column added in one file and dropped in the next
  (`p2p_preheat_policy.scope`).
- **13 dropped tables**, mostly `DROP TABLE IF EXISTS`, some after their rows
  were moved by a `DO` block.
- **Type changes** with `ALTER COLUMN … TYPE`: `properties.v` varchar(128) →
  varchar(1024) → text; `registry.url` varchar(64) → varchar(256); `access_key`
  and `access_secret` to varchar(4096); `role.name` varchar(20) → varchar(255);
  SERIAL ids changed to BIGINT (`robot`, `vulnerability_record`,
  `report_vulnerability_record`, `role_permission`, `permission_policy`);
  other int columns to bigint: `role_permission.permission_policy_id` (0170),
  `p2p_preheat_instance.setup_timestamp`, `task.status_revision` and
  `schedule.revision` (0181), `robot.creator_ref` and `role_permission.role_id` (0190);
  `retention_policy` time → timestamp with a `USING` expression;
  `vendor_type` varchar(16) → varchar(64) on three tables.
- **Nullability changes:** `SET NOT NULL` on `artifact.repository_id`,
  `media_type`, `manifest_media_type`, `artifact_type` and `task.vendor_type`;
  `DROP NOT NULL` on `replication_policy.dest_registry_id`.
- **Repeated ADD COLUMN IF NOT EXISTS** of the same column: `artifact.icon`
  twice in 0040, `robot.secret` twice in 0050, `replication_policy.copy_by_chunk`
  in 0091 and 0100. Many `CREATE INDEX IF NOT EXISTS` are repeated too.
- **ALTER of a table these files never create:** `schema_migrations` (0030 adds
  `data_version`, 0040 drops it). It belongs to golang-migrate.
- **Constraints dropped by Postgres's generated names:**
  `artifact_accessory_subject_artifact_id_fkey` (a foreign key) and
  `notification_policy_name_key` (a unique constraint).
- **Constraint DDL inside `DO $$ … $$` blocks:** the `project_member.role` FK
  (0190) and a unique constraint on `artifact_accessory` (0110). There are 28
  `DO` blocks in all, most of them moving data.
- **Foreign keys to unique non-primary-key columns:** `scanner_registration.uuid`
  and `scan_report.uuid`, with differing types (text → varchar(64)).
- **Two foreign keys to the same table** from one table:
  `artifact_reference.parent_id` and `child_id` both → `artifact.id`.
- **`/*` inside a string literal** in 0004 (`'/**"}'`) and apostrophes inside
  comments (`doesn't`). A tokenizer that strips comments before strings will
  eat real statements.
- **PL/pgSQL:** one `CREATE FUNCTION … $$ … $$` and 17 `CREATE TRIGGER`
  statements (some dropped later).
- **Quoted identifiers** in 0050 (`"vulnerability_record"`, `"id"`, …).
- **Column names that are SQL keywords:** `trigger`, `type`, `role`, `action`,
  `scope`, `level`, `size`, `version`, `status`, `package`, `comment`.
- **Types:** SERIAL, BIGSERIAL, BIGINT, SMALLINT, char(1), varchar(n), text,
  boolean, JSON, JSONB, double precision, timestamp, timestamp with time zone
  (3 final columns: `job_queue_status.update_time` from 0100:7, and `role.created_at`
  and `role.modified_at` from 0190:35 and 0190:37), timestamp without time zone.
- **Defaults:** `CURRENT_TIMESTAMP`, `false`, `true`, `0`, `''`, `'sha256'`,
  `'none'`, `'local'`.
- **Inline UNIQUE** on columns (`uuid VARCHAR(64) UNIQUE NOT NULL`) and many
  composite UNIQUE constraints.
- **Indexes:** 48 `CREATE INDEX` statements, including a unique expression index
  `ON role (lower(name))`, a GIN index on a JSON expression and an expression
  index on `report::jsonb ->> 'sbom_digest'`.
- **Data changes mixed in with DDL:** INSERT, UPDATE, DELETE, `UPDATE … FROM`,
  CTE `WITH … UPDATE`, `ALTER SEQUENCE`.
- **Mixed keyword case:** `create table` and `CREATE TABLE` both appear.
- **Not present:** views, enums, domains, schemas other than the default,
  partitions, computed columns, `COMMENT ON`.
