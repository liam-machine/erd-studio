# Catalog exports (real)

Real exports of the catalog queries the import guide ships (**Bring In Your Data Model…** and `docs/import-existing-models.md`), each the unchanged file the engine or its client wrote. `test/unit/catalogCsvImport.fixtures.test.ts` imports every one and checks the result; `test/unit/importGuide.test.ts` holds each query in `queries/` to the guide's and the docs' copy, byte for byte.

| File | Engine | How it was written | Schema |
|---|---|---|---|
| `databricks/probe.csv` | Azure Databricks, serverless SQL warehouse (dbsql 2026.44, Spark 4.2.0) | the SQL editor's **Download CSV**, 2026-11-11 (the API's result is byte-identical); see `databricks/SOURCE.md` | a synthetic probe schema |
| `postgres/probe.csv`, `postgres/pagila.csv` | PostgreSQL 18.6 (Homebrew, a scratch cluster) | `psql -d <database> --csv -f postgres.sql -o catalog.csv`, 2026-11-11 | `postgres/probe-schema.sql`; Pagila (`real-world-imports/postgres-pagila/pagila-schema.sql`, with its 55 payment partitions) |
| `mysql/probe.tsv`, `mysql/sakila.tsv` | MySQL 8.0.42 (Homebrew, a scratch data directory) | `mysql --batch --execute="source mysql.sql" > catalog.tsv`, 2026-11-11 (tab-separated, `NULL` written out, line breaks as `\n`) | `mysql/probe-schema.sql`; Sakila (`real-world-imports/mysql-sakila/sakila-schema.sql`) |
| `duckdb/probe.csv` | DuckDB 2.0.0 (Python) | `COPY (<duckdb.sql>) TO 'catalog.csv' (HEADER)`, 2026-11-11 | `duckdb/probe-schema.sql` |

The probe schemas are made up for these tests (two schemas, a composite key and a composite foreign key, a self-reference, a one-to-one, a view, comments with commas, quotes and line breaks, a reserved word and a mixed-case name). The engines ran on scratch data directories that were deleted afterwards.

`queries/` holds the four queries exactly as the guide and the docs give them. PostgreSQL, MySQL and DuckDB were run as they are here. The Databricks export was made with the query in `databricks/query-as-run.sql`, which is `queries/databricks.sql` without its `total_rows` column (added afterwards, for the truncation check; the shipped query was parsed by Apache Spark 4.3's parser but not run on Databricks again).
