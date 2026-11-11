# Catalog exports (real)

Real exports of the catalog queries the import guide ships (**Bring In Your Data Model…** and `docs/import-existing-models.md`), each the unchanged file the engine or its client wrote. `test/unit/catalogCsvImport.fixtures.test.ts` imports every one and checks the result; `test/unit/importGuide.test.ts` holds each query in `queries/` to the guide's and the docs' copy, byte for byte.

| File | Engine | How it was written | Schema |
|---|---|---|---|
| `databricks/probe.csv` | Azure Databricks, serverless SQL warehouse (dbsql 2026.44, Spark 4.2.0) | the SQL editor's **Download CSV**, 2026-11-11 (the API's result is byte-identical); see `databricks/SOURCE.md` | a synthetic probe schema |
| `postgres/probe.csv`, `postgres/pagila.csv` | PostgreSQL 18.6 (Homebrew, a scratch cluster) | `psql -d <database> --csv -f postgres.sql -o catalog.csv`, 2026-11-11 | `postgres/probe-schema.sql`; Pagila (`real-world-imports/postgres-pagila/pagila-schema.sql`, with its 55 payment partitions) |
| `mysql/probe.tsv`, `mysql/sakila.tsv` | MySQL 8.0.42 (Homebrew, a scratch data directory) | `mysql --batch --execute="source mysql.sql" > catalog.tsv`, 2026-11-11 (tab-separated, `NULL` written out, line breaks as `\n`) | `mysql/probe-schema.sql`; Sakila (`real-world-imports/mysql-sakila/sakila-schema.sql`) |
| `duckdb/probe.csv` | DuckDB 2.0.0 (Python) | `COPY (<duckdb.sql>) TO 'catalog.csv' (HEADER)`, 2026-11-11 | `duckdb/probe-schema.sql` |
| `sqlserver/probe.csv` | SQL Server 2022 CU27 (16.0.4315.2, Developer, the `mcr.microsoft.com/mssql/server:2022-latest` image in Docker) | SqlToolsService 6.0.20261002.1's **Save as CSV** request (`query/saveCsv`, what the VS Code SQL Server extension 1.47.0 sends), 2026-11-11; see `sqlserver/SOURCE.md` | `sqlserver/probe-schema.sql` |

The probe schemas are made up for these tests (two schemas, a composite key and a composite foreign key, a self-reference, a one-to-one, a view, comments with commas, quotes and line breaks, a reserved word and a mixed-case name). The engines ran on scratch data directories that were deleted afterwards.

`queries/` holds the four guide queries exactly as the guide and the docs give them (and `sqlserver.sql`, below, which is in neither yet). PostgreSQL, MySQL and DuckDB were run as they are here. The Databricks export was made with the query in `databricks/query-as-run.sql`, which is `queries/databricks.sql` without its `total_rows` column (added afterwards, for the truncation check; the shipped query was parsed by Apache Spark 4.3's parser but not run on Databricks again).

## SQL Server

`sqlserver/run_sqlserver.sh` makes the SQL Server export again (Docker; about 1.5 GB to pull the first time): SQL Server 2022 in a container, the synthetic `sqlserver/probe-schema.sql`, the query run and saved through the VS Code SQL Server extension's own service and **Save as CSV** request (`sqlserver/sts-save-csv.mjs` speaks to SqlToolsService as the extension does), a lossless JSON copy of the same rows (`probe.rows.json`), and SMO's script of the same database (`probe-smo-script.sql`, UTF-16 as written) for the DDL route. `test/unit/catalogCsvImport.sqlserver.test.ts` checks both routes against `sqlserver/truth.json`. The probe schema adds what only SQL Server has: an alias type, a computed column, `MS_Description` with a CRLF and a backslash, a filtered unique index and one with an included column (neither may become a unique key), a plain unique index, a column in two foreign keys, a composite foreign key whose columns sit in the table the other way round, and SSMS's `dbo.sysdiagrams` (left out). The Save as CSV click in VS Code itself was not driven; the request it sends was.
