# Import analysis: Harbor database migrations (PostgreSQL, golang-migrate)

**Verdict: imported, with problems.** All 48 tables, 397 columns and 47 primary keys match, with no errors. 2 of the 14 relationships are wrong: a dropped FK is shown and a DO-block FK is missing. Dropped unique keys stay, and WITH TIME ZONE is cut from 3 columns, with no message for either.

## Tested with

- ERD Studio 2.0 (`feat/native-dbml-storage` at `d04c4167`). The real extension ran in VS Code 1.145.2. The output channel and the CLI print `1.7.2` because only `deploy.yml` sets the root `version`.
- Sample: Harbor `make/migrations/postgresql/`, 39 `*.up.sql` files at upstream commit `3852755e`. See `SOURCE.md`. Source paths below are relative to `test/fixtures/real-world-imports/migrations-harbor/`.
- Import path:
  - Sidebar start screen ("No diagrams yet. This folder has CREATE TABLE scripts."), then "Or: More ways to start…", then **Import…**, then **SQL DDL scripts** (tagged "found in this folder").
  - In the Import SQL DDL dialog I picked the whole `make/migrations/postgresql/` folder.
  - Dialect: **PostgreSQL** (tagged "detected").
  - No layer question was asked, so the diagram went to Main. I changed the name from `postgresql` to `harbor`.
  - In the draft I opened **Show details**, then clicked **Keep as Diagram**.
- Output: 52 files under `.erd-studio/` in the imported project, a scratch copy that is not committed. They are `README.md`, `layers.json`, `main/diagrams/harbor.dbml`, `main/relationships/main.dbml` and 48 `main/tables/main/*.dbml` files. Imported paths below start at `.erd-studio/`.
- Video: `import-review.mp4` in the sample folder. It is the re-rendered cut, 116 s.

## Source vs imported

| Check | Source (final schema) | Imported | Result |
|---|---|---|---|
| Tables | 48 | 48 | ok. Same names, and none of the 13 dropped tables appear |
| Columns | 397 | 397 | ok. Same per-table counts, names and order |
| Primary keys | 47 (all single-column; `alembic_version` has none) | 47 | ok |
| Relationships (FKs) | 14 | 14 | **13 right, 1 extra, 1 missing** |
| Exact column types | 397 | 394 | 3 lost `WITH TIME ZONE` |
| NOT NULL and defaults | n/a | all match | ok |
| Unique keys | n/a | 3 stale, 1 missing; 2 unique indexes not kept | Bugs 4 and 2, Gap 1 |
| Renames, drops, retypes, SET/DROP NOT NULL | n/a | replayed | ok ("144 later schema changes were applied in file order") |
| Import errors | n/a | none | ok |

How I counted:
- **Tables, columns and primary keys:** I re-ran `erd-studio inventory --json` on the imported project. It lists 48 logical tables, the column counts add up to 397, and 47 tables have a one-column primary key. Every table's column count equals the hand-replayed count in `SOURCE.md`.
- **Relationships:** I counted the `Ref:` lines in `main/relationships/main.dbml`. There are 14, at lines 19-41, and I compared each one with the 14 FKs listed in `SOURCE.md`. Inventory's own `relationships` array is empty, because it only covers dbt.
- **The 394 exact types** come from the analyst's column-by-column compare. I re-checked the 3 misses on disk. A grep shows no `TIME ZONE` text in any imported table except the two `WITHOUT TIME ZONE` columns on `retention_policy`.

The relationship total of 14 is right only because one error cancels the other.

## Findings

### Errors

None. No error, warning or modal appeared, and the Problems view stayed at 0 errors and 0 warnings. `erd-studio doctor --no-dbt` reports "1 diagram, 48 tables — storage DBML" and "Ready".

### Bugs (silently lost or wrong)

1. **A dropped foreign key is still drawn.**
   - `0080_2.5.0_schema.up.sql:24` creates `FOREIGN KEY (subject_artifact_id) REFERENCES artifact(id)`.
   - `0110_2.8.0_schema.up.sql:20` drops it by its generated name: `alter table artifact_accessory drop CONSTRAINT IF EXISTS artifact_accessory_subject_artifact_id_fkey;`.
   - The import still writes it at `main/relationships/main.dbml:20`: `Ref: main.artifact_accessory.subject_artifact_id >? main.artifact.id`. The draft lists it under Relationships, and on the canvas the edge is selectable.
   - Cause: the `ALTER TABLE … DROP` branch in `src/services/sqlDdlImport.ts:1293-1303` handles only columns. `DROP CONSTRAINT` is marked unhandled and counted as an `alter` skip (`sqlDdlImport.ts:1352`).

2. **Constraints added inside `DO $$ … $$` blocks are lost.** The DO block is skipped as a whole. A `DO` statement falls to the `default` branch and is counted as an "other statement" (`src/services/sqlDdlImport.ts:916`).
   - **Missing FK.** `0190_2.16.0_schema.up.sql:55-64` is a DO block. Lines 60-62 add `fk_project_member_role FOREIGN KEY (role) REFERENCES role (role_id)`. The FK is not in `main/relationships/main.dbml`, and `main/tables/main/project_member.dbml:8` is a plain `role int`.
   - **Missing replacement unique key.** `0110_2.8.0_schema.up.sql:23-32` adds `UNIQUE (artifact_id, subject_artifact_digest)` in a DO block (line 30), replacing the key dropped at `0110:21`. It is absent. `main/tables/main/artifact_accessory.dbml:2` still holds the old pair `(artifact_id, subject_artifact_id)` from `0080:25`.
   - The user is told only a count. For example, "0190_2.16.0_schema.up.sql: skipped 2 other statements, …" and "0110_2.8.0_schema.up.sql: skipped … 3 other statements, …". The count includes the DO blocks, but nothing says a key was inside one.
   - Correction to the fixer's draft: it said DO blocks do not appear in "Not imported". They do appear, but only as an unnamed count.

3. **`TIMESTAMP WITH TIME ZONE` becomes `timestamp`.** There is no warning, and `meta_json` does not keep the zone.

   | Column | Source | Imported |
   |---|---|---|
   | `job_queue_status.update_time` | `0100_2.7.0_schema.up.sql:7` | `main/tables/main/job_queue_status.dbml:5` `timestamp` |
   | `role.created_at` | `0190_2.16.0_schema.up.sql:35` | `main/tables/main/role.dbml:10` `TIMESTAMP` |
   | `role.modified_at` | `0190_2.16.0_schema.up.sql:37` | `main/tables/main/role.dbml:12` `TIMESTAMP` |

   - Cause: column definitions, including ones from `ADD COLUMN`, are read through `@dbml/core` 11.0.0's Postgres grammar (`readColumnDefinitions`, `sqlDdlImport.ts:1410`). In the analyst's direct test that grammar dropped the zone in the same way.
   - `TIMESTAMP WITHOUT TIME ZONE` on `retention_policy` (`0080:2-3`, written at `retention_policy.dbml:7-8`) is kept as written. ERD Studio reads `ALTER COLUMN … TYPE` text itself (`alterColumn`, `sqlDdlImport.ts:1458`).

4. **`DROP CONSTRAINT` is ignored, so dropped unique keys stay.**

   | Drop | What it removed | Still in the import |
   |---|---|---|
   | `0030_2.0.0_schema.up.sql:200` `DROP CONSTRAINT unique_project_id` | `notification_policy UNIQUE (project_id)` (`0010_1.9.0_schema.up.sql:167`) | `notification_policy.dbml:6` unique on `project_id` |
   | `0040_2.1.0_schema.up.sql:123` `DROP CONSTRAINT IF EXISTS notification_policy_name_key` | `UNIQUE (name)` (`0030:206`) | `notification_policy.dbml:5` unique on `name` |
   | `0110_2.8.0_schema.up.sql:21` `drop CONSTRAINT IF EXISTS unique_artifact_accessory` | `UNIQUE (artifact_id, subject_artifact_id)` (`0080:25`) | `artifact_accessory.dbml:2` composite unique index |

   - `notification_policy` does get its replacement `UNIQUE (name, project_id)` (`0040:125`, `notification_policy.dbml:2`). The `artifact_accessory` replacement is lost (Bug 2).
   - The dry run shows the four DROP CONSTRAINTs (these three plus Bug 1's FK drop) only as "1 ALTER TABLE other than a key or a column change" for 0030 and 0040, and "2 ALTER TABLEs other than a key or a column change" for 0110. That label is wrong, because these are key changes. Nothing warns that the model still holds the FK and the three unique keys those statements removed.

5. **Low: "Not imported (44)" double-lists 10 files.**
   - 0031, 0041, 0051, 0053, 0061, 0071, 0081, 0082, 0111 and 0171 each appear once as "no tables, keys or comments in it" and again with their own "skipped N …" line. The two lines contradict each other.
   - The 44 rows are 10 duplicates, 32 per-file skipped lines and 2 `schema_migrations` notes, so there are 34 distinct entries. I counted them in the drawer text: 10, 32 and 2.
   - Cause: `src/services/sqlDdlImport.ts:2032-2033` concatenates the `unused` list with `skippedSummary` for every file.

6. **Low (UI): the startup prompt goes stale.** "ERD Studio found CREATE TABLE scripts in this folder. Show them as a diagram? …" stays on screen through the import and after Keep. By then a diagram exists.

### Gaps (unsupported)

1. **`CREATE UNIQUE INDEX` is skipped like a plain index.**
   - `0002_1.7.0_schema.up.sql:12` `CREATE UNIQUE INDEX job_log_uuid ON job_log (job_uuid)`: `main/tables/main/job_log.dbml:3` has no `unique`.
   - `0190_2.16.0_schema.up.sql:45` `CREATE UNIQUE INDEX IF NOT EXISTS uq_role_name ON role (lower(name))`, an expression index: `role.dbml:5` has no `unique`.
   - Cause: `readCreate` sends every `CREATE [UNIQUE] INDEX` to the index count (`sqlDdlImport.ts:930`).
   - Told: partly. The drawer says only "1 index" or "2 indexes", not that uniqueness was lost.

2. **Relationship optionality ignores NOT NULL.**
   - Every Ref is stored `>?`, even when the FK column is NOT NULL. For example, `tag.artifact_id int NOT NULL` (`0030_2.0.0_schema.up.sql:69`, FK at `:73`) is written `Ref: main.tag.artifact_id >? main.artifact.id` at `main/relationships/main.dbml:37`.
   - The flag survives only in `tag.dbml:6` `meta_json` (`not_null: true`).
   - Told: not at import. The general Note says "Not null, defaults and other details ERD Studio has no field for are kept in the table files, so they are not lost."

3. **No source schema.**
   - The source tables are unqualified, so Postgres puts them in `public`.
   - They are written under the layer name instead, for example `Table main.access {` at `main/tables/main/access.dbml:1`, and `main."project"` is quoted because `project` is a DBML keyword. Nothing records `public`.
   - Told: no.

4. **Skipped objects are counted, not named.**
   - The 48 indexes, 1 `CREATE FUNCTION`, 17 `CREATE TRIGGER`s, 28 DO blocks and all INSERT/UPDATE/DELETE are listed per file as counts, and the counts add up.
   - None are named, so a reviewer cannot see which skipped statements carried keys (Bugs 2 and 4).
   - Told: yes, as counts.

### What came through correctly

- **Tables:**
  - All 48 final tables are present, and the 13 dropped tables are absent. They include `access_log`, `replication_job`/`replication_schedule_job` and `notification_job`.
  - `schema_migrations`, golang-migrate's own table, was not invented. Both ALTERs on it were reported with file and line and not applied.
- **Table renames:**
  - `replication_target` became `registry` (`0004:57`), and `cve_whitelist` became `cve_allowlist` via `ALTER TABLE IF EXISTS … RENAME TO` (`0040:2`).
  - The unique on `registry.name`, added before the rename (`0002:58`), followed the table (`registry.dbml:3`).
- **Column changes:**
  - Renames: `access_key` and `access_secret` (`0004:60-61` to `registry.dbml:5-6`); `dest_registry_id` and `trigger` (`0004:78,84` to `replication_policy.dbml:4,12`); `artifact.type` and `repository_name` (`0030:30,63` to `artifact.dbml:6,8`).
  - `p2p_preheat_policy.scope` is added in 0150 and dropped in 0160, and is absent.
  - Repeated `ADD COLUMN IF NOT EXISTS` (`artifact.icon`, `robot.secret`, `copy_by_chunk`) gives one column each.
- **Retypes:** these are applied, including the bigint changes in 0080, 0170, 0181 and 0190.
  - `properties.v` ends as `text`.
  - `robot.id` is `bigint` and still increments.
  - The `retention_policy` `USING` retype worked.
  - `char(1)`, `smallint`, `json`, `jsonb`, `double precision` and `BIGSERIAL` are kept.
  - Types keep their source spelling, for example `varchar (30)` at `access.dbml:4`.
- **Nullability and defaults:**
  - `SET NOT NULL` and `DROP NOT NULL` are applied, for example on `artifact.artifact_type`, `task.vendor_type` and `replication_policy.dest_registry_id`.
  - The defaults `CURRENT_TIMESTAMP`, `'sha256'`, `'none'`, `'local'`, `0`, `''` and the booleans are kept.
- **Foreign keys:** the 13 correct FKs are many-to-one from the FK side. That includes both `artifact_reference` to `artifact` keys (`main.dbml:22-23`) and the keys to unique non-PK `uuid` columns with differing types (`main.dbml:34, 41`).
- **Tricky SQL:** the `'/**"}'` string in 0004, apostrophes in comments, quoted identifiers in 0050, keyword column names and mixed keyword case caused no problems.

## What the import showed

Startup notification, which stayed up after Keep:
> ERD Studio found CREATE TABLE scripts in this folder. Show them as a diagram? Nothing is saved until you keep it. [Show Me] [Don't Ask Again for This Folder]

Draft banner:
> Draft from 39 SQL files (PostgreSQL) · 48 tables, 14 relationships · not saved
> Keep saves it as harbor in the Main layer (.erd-studio/main/diagrams/harbor.dbml).
> 2 notes, 44 left out: Show details

Guide:
> Your draft 1 of 3 — This is a draft of your model, drawn from 39 SQL files (PostgreSQL): 48 tables, 14 relationships. Nothing is saved yet.

Details, Relationships (14):
- The list includes "artifact_accessory.subject_artifact_id → artifact.id many-to-one".
- There is no `project_member.role` line.

Details, Notes (2):
> 144 later schema changes were applied in file order (columns added, renamed, changed or dropped; tables renamed or dropped).
> Not null, defaults and other details ERD Studio has no field for are kept in the table files, so they are not lost.

Details, Not imported (44), shown the same way in the output channel, where each line starts "[ERD Studio] Import SQL DDL:":
> These stay in your own files only: the import writes none of them.

- `0031_2.0.3`, `0041_2.1.4`, `0051_2.2.1`, `0053_2.2.3`, `0061_2.3.4`, `0071_2.4.2`, `0081_2.5.2`, `0082_2.5.3`, `0111_2.8.1`, `0171_2.14.1` `_schema.up.sql`: no tables, keys or comments in it
- 0001_initial_schema.up.sql: skipped 7 data statements (INSERT, UPDATE…), 16 functions, procedures or triggers, 10 indexes
- 0002_1.7.0_schema.up.sql: skipped 1 data statement (INSERT, UPDATE…), 1 index, 2 other statements
- 0004_1.8.0_schema.up.sql: skipped 2 functions, procedures or triggers, 16 data statements (INSERT, UPDATE…), 6 DROP statements, 2 indexes, 2 other statements
- 0005_1.8.2_schema.up.sql: skipped 1 other statement, 1 data statement (INSERT, UPDATE…)
- 0010_1.9.0_schema.up.sql: skipped 3 data statements (INSERT, UPDATE…)
- 0011_1.9.1_schema.up.sql: skipped 1 data statement (INSERT, UPDATE…)
- 0015_1.10.0_schema.up.sql: skipped 6 DROP statements, 1 data statement (INSERT, UPDATE…)
- 0030_2.0.0_schema.up.sql: skipped 14 data statements (INSERT, UPDATE…), 1 other statement, 1 ALTER TABLE other than a key or a column change
- 0031_2.0.3_schema.up.sql: skipped 5 data statements (INSERT, UPDATE…)
- 0040_2.1.0_schema.up.sql: skipped 5 data statements (INSERT, UPDATE…), 2 indexes, 1 other statement, 1 ALTER TABLE other than a key or a column change
- 0041_2.1.4_schema.up.sql: skipped 1 data statement (INSERT, UPDATE…)
- 0050_2.2.0_schema.up.sql: skipped 12 data statements (INSERT, UPDATE…), 12 other statements
- 0051_2.2.1_schema.up.sql: skipped 1 data statement (INSERT, UPDATE…), 1 index
- 0052_2.2.2_schema.up.sql: skipped 1 data statement (INSERT, UPDATE…)
- 0053_2.2.3_schema.up.sql: skipped 4 indexes
- 0060_2.3.0_schema.up.sql: skipped 1 data statement (INSERT, UPDATE…), 5 indexes
- 0061_2.3.4_schema.up.sql: skipped 1 data statement (INSERT, UPDATE…)
- 0070_2.4.0_schema.up.sql: skipped 2 data statements (INSERT, UPDATE…)
- 0071_2.4.2_schema.up.sql: skipped 1 data statement (INSERT, UPDATE…)
- 0080_2.5.0_schema.up.sql: skipped 2 other statements, 1 index
- 0081_2.5.2_schema.up.sql: skipped 1 index
- 0082_2.5.3_schema.up.sql: skipped 1 other statement
- 0090_2.6.0_schema.up.sql: skipped 1 data statement (INSERT, UPDATE…), 6 indexes, 1 other statement
- 0110_2.8.0_schema.up.sql: skipped 5 data statements (INSERT, UPDATE…), 3 other statements, 2 ALTER TABLEs other than a key or a column change, 3 queries
- 0111_2.8.1_schema.up.sql: skipped 1 index
- 0120_2.9.0_schema.up.sql: skipped 7 indexes, 2 data statements (INSERT, UPDATE…), 2 other statements
- 0130_2.10.0_schema.up.sql: skipped 1 index
- 0140_2.11.0_schema.up.sql: skipped 1 data statement (INSERT, UPDATE…)
- 0160_2.13.0_schema.up.sql: skipped 4 indexes
- 0170_2.14.0_schema.up.sql: skipped 2 other statements
- 0171_2.14.1_schema.up.sql: skipped 1 other statement
- 0190_2.16.0_schema.up.sql: skipped 2 other statements, 2 indexes, 1 DROP statement, 1 data statement (INSERT, UPDATE…)
- 0030_2.0.0_schema.up.sql line 22: a column added on schema_migrations, which is not in the files (not applied)
- 0040_2.1.0_schema.up.sql line 141: a column dropped (data_version) on schema_migrations, which is not in the files (not applied)

After Keep, in the output channel:
> [Canvas] Opened …/.erd-studio/main/diagrams/harbor.dbml: 48 tables posted 17 ms after ready
> [Canvas] Saved the positions of 48 tables in …/harbor.dbml in 20 ms (layout only)

## If the import failed

It did not. The import succeeded on the first try. A user who needs exact constraints would have to fix these by hand after importing:
- Remove the stale `artifact_accessory.subject_artifact_id` Ref.
- Add `project_member.role → role.role_id`.
- Correct the unique keys on `notification_policy` and `artifact_accessory`.
- Restore `WITH TIME ZONE` on the three columns.
