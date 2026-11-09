# Oracle HR sample schema (Oracle)

Import type: **SQL DDL, Oracle**. Pick `human_resources/hr_create.sql` in **Import SQL DDL…**; the dialect is detected.

## What it is

Oracle's own HR (Human Resources) sample schema: the script `sqlplus` runs to create it. It is a SQL*Plus
script, not plain DDL: `rem` header lines, `SET` and `Prompt` commands between the statements, `VARCHAR2` and
`NUMBER` types, inline `CONSTRAINT name NOT NULL`, an `ORGANIZATION INDEX` table, `CREATE UNIQUE INDEX` on every key
column, and every primary and foreign key added afterwards by `ALTER TABLE t ADD ( CONSTRAINT … , CONSTRAINT … )`,
the parenthesised list Oracle writes. Two foreign keys reference their table's primary key with no column list
(`REFERENCES departments`). Sequences, a view, indexes and `COMMENT ON` descriptions follow.

Before the Oracle dialect it read as PostgreSQL and lost 6 of 7 primary keys and all 10 foreign keys without a
word (the `ADD ( … )` list was skipped as "other statement").

## Where it came from

- Project: https://github.com/oracle-samples/db-sample-schemas
- Pin: commit `e3325a83e56c516815844025418a96ecaf219751` (tag `v23.3`), as pinned by the import corpus (`scripts/corpus/manifest.json` in this repository, pinned 2026-11-09).
- Files (`human_resources/` upstream, `human_resources/` here):
  - https://raw.githubusercontent.com/oracle-samples/db-sample-schemas/e3325a83e56c516815844025418a96ecaf219751/human_resources/hr_create.sql
- SHA-256:
  - `human_resources/hr_create.sql` (17,112 bytes): `7d5b1e75a450f4e96a2efb23d9bac81963d8331974a72feacee712464091dd47`
- Downloaded 2026-11-09; each file's SHA-256 checked against the pinned manifest.

## Licence

MIT (`LICENSE.txt` at the repository root, "Copyright (c) 2023 Oracle and/or its affiliates"; the same
notice heads the script). Copied to `UPSTREAM-LICENSE.txt`; the script is unchanged.

## What was copied

- `human_resources/hr_create.sql`, byte for byte.
- Nothing else from the repository.

## Expected counts

Counted by sqlglot 27.29 (oracle) over the upstream file, never through ERD Studio (62 of 63 DDL statements; countries, an ORGANIZATION INDEX table, read structurally), types re-read as written. Primary and foreign keys are the ALTER TABLE ... ADD ( CONSTRAINT ... ) lists; emp_dept_fk and emp_manager_fk reference their table's primary key (REFERENCES with no column list). Its one unique key is employees(email), the inline `CONSTRAINT emp_email_uk UNIQUE`; the 6 `CREATE UNIQUE INDEX` statements are each on exactly its table's primary key columns (the index that primary key uses), so they are not unique keys of their own. Descriptions are the COMMENT ON TABLE / COLUMN statements.

- Tables: **7**
- Columns: **35**
- Primary keys: **7**
- Foreign keys / relationships: **10**
- Unique keys: **1**
- Descriptions: **42**

| Table | Columns | Primary key | Foreign keys (column → target) |
|---|---|---|---|
| regions | 2 | region_id | – |
| countries | 3 | country_id | region_id → regions |
| locations | 6 | location_id | country_id → countries |
| departments | 4 | department_id | location_id → locations; manager_id → employees |
| jobs | 4 | job_id | – |
| employees | 11 | employee_id | department_id → departments; job_id → jobs; manager_id → employees |
| job_history | 5 | employee_id, start_date | job_id → jobs; employee_id → employees; department_id → departments |

Oracle Database agrees item by item: run by SQL*Plus as `hr_install.sql` runs it, on Oracle AI Database 26ai Free 23.26.0 (Docker), the script loads with no error, and the catalog (`ALL_TABLES`, `ALL_TAB_COLUMNS`, `ALL_CONSTRAINTS`, `ALL_CONS_COLUMNS`, `ALL_TAB_COMMENTS`, `ALL_COL_COMMENTS`) holds these 7 tables, 35 columns with their types and NOT NULL, 7 primary keys, the 1 unique key, 10 foreign keys and 42 comments, with no difference (`test/real-world-truth/engine/oracle-hr.json`, `docs/dev/real-world-truth.md`). The 6 `CREATE UNIQUE INDEX` statements are the indexes the primary keys use: Oracle lists no unique index of its own besides them.
