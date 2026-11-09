# Database truth for the real-world import samples

The scorecard (`test/unit/realWorldImports.scorecard.test.ts`) compares each import with `test/fixtures/real-world-imports/expected.json`, a truth counted by hand from the upstream files. For twelve of the sixteen SQL samples (Pagila counts twice: partitions folded and kept) that truth is also checked against the real database engines: each sample is loaded into its engine, the schema is read back from the engine's catalog, and the read-back is compared with `expected.json` item by item. The samples added from the import corpus (`snowflake-realtime-datavault`, `snowflake-sqldbm-adventureworksdw`, `databricks-uc-catalog-as-code`, `databricks-adidas-table-manager`) took their truth from the read-back itself: structure, keys and comments from the engine, names and types as the files write them. Four have no read-back, for want of a local engine (`NOT_ENGINE_VERIFIED` in `test/unit/realWorldEngineTruth.ts` says why for each): `oracle-hr` (Oracle Database runs only as a multi-gigabyte container, not captured yet), `bigquery-cloud-learning-platform` and `bigquery-shibarium` (BigQuery; the open-source goccy/bigquery-emulator 0.6.6, tried in Docker, refuses `NOT ENFORCED` primary keys and every `ALTER TABLE`, which is how `bigquery-shibarium` adds its keys) and `redshift-tpch` (Amazon Redshift), which run only as cloud services. Their truth is `scripts/corpus/count_source.py`'s count (sqlglot) checked by hand in each `SOURCE.md`. The test fails when a SQL sample in `expected.json` is in neither list.

| Path | What it is |
|---|---|
| `test/real-world-truth/readback.py` | Loads each SQL sample into its engine and writes the read-back (standard library only). |
| `test/real-world-truth/snowflake_readback.py`, `spark_readback.py` | The Snowflake and Databricks halves, run in a Python that has the emulator installed. |
| `test/real-world-truth/engine/<sample>.json` | The captured read-back: engine and version, the files loaded, every statement the engine refused, then tables (schema, comment, primary key, columns with type, NOT NULL, comment), unique constraints and indexes, and foreign keys with their column lists. |
| `test/real-world-truth/differences.json` | Every difference between `expected.json` and the read-back, with its resolution. |
| `test/unit/realWorldEngineTruth.ts` / `.test.ts` | The comparison, and the test that keeps `differences.json` exact. |

`npm test` runs only the comparison (on the committed JSON); it never starts an engine.

## The engines

| Sample | Engine | How |
|---|---|---|
| `postgres-pagila` (and `postgres-pagila-partitions-kept`) | PostgreSQL 18.6 | Homebrew `postgresql@18` and `pgvector` (the dump creates the `vector` extension), on a scratch cluster. PostgreSQL 18 is needed for `film.length_hours`, a `VIRTUAL` generated column. |
| `migrations-harbor` | PostgreSQL 18.6 | The 39 up-migrations in name order, as golang-migrate runs them, after creating golang-migrate's own `schema_migrations` table (two migrations alter it). That table is left out of the read-back. |
| `mysql-sakila` | MySQL 8.0 | Homebrew `mysql@8.0` on a scratch data directory, `mysql --force` so one failing statement does not stop the rest. |
| `sqlserver-adventureworks` | SQL Server 2025 | Docker only (`mcr.microsoft.com/mssql/server:2025-latest`, `linux/amd64`): the script targets SQL Server 2025 (`OPTIMIZED_LOCKING`). Run with `sqlcmd -i` in SQLCMD mode, as the script asks. The sample has no data files, so its 68 `BULK INSERT`s fail; the schema does not depend on them. |
| `snowflake-grid-reliability` | fakesnow 0.12 (an emulator on DuckDB) | Statements split by the Snowflake connector's own splitter. DuckDB cannot reference a table in another schema and has no `VECTOR`, so a `CREATE TABLE` that fails on either is run again without it, and that part is read from sqlglot's Snowflake parse (fakesnow's own parser), marked `"via": "sqlglot"` and listed in `workarounds`: 4 foreign keys to `RAW.ASSET_MASTER` and 2 `VECTOR(FLOAT, 768)` columns. |
| `sqlite-chinook` | SQLite 3 (Python's `sqlite3`) | The standard library's `sqlite3` in memory: each statement as `sqlite3.complete_statement` splits them (the 15,000 `INSERT`s too), then `pragma_table_info`, `pragma_index_list` / `pragma_index_info` and `pragma_foreign_key_list`. SQLite keeps each column's declared type as written. Nothing to install. |
| `databricks-open-retail-data-model` | Apache Spark 4.3 SQL parser | Open-source Spark's catalog cannot hold primary or foreign keys (they are Unity Catalog's), so this is Spark's parser, not a catalog: each statement goes through `sqlParser.parsePlan` after Spark's own `${var}` substitution (each variable set to its own name, so `${store_schema}` is the schema `store_schema`), and the parsed `CREATE TABLE` and `ADD CONSTRAINT` plans are replayed. Spark's parser marks a primary key column NOT NULL, as Databricks does. |
| `snowflake-realtime-datavault` | fakesnow 0.12 | The five files in the Data Vault's order (environment, staging, raw vault, business vault, delivery), after creating the `SNOWFLAKE_SAMPLE_DATA.TPCH_SF10` share's `NATION` and `REGION` (empty, as the share defines them) that staging copies. Workarounds, each in the read-back's `workarounds`: `CREATE TABLE t (columns) AS SELECT` is created from its column list (DuckDB takes no column list with a query; the list is what sets the columns), and the business vault's foreign key to `L10_RDV.HUB_ORDER` (another schema) is read from sqlglot's parse. `REFERENCES hub_customer` with no column list is the referenced table's primary key. Streams, pipes, tasks, the warehouse and the queries are refused (`loadErrors`). |
| `snowflake-sqldbm-adventureworksdw` | fakesnow 0.12 | After `create database ADVENTUREWORKSDW` (the script expects it). Quoted names keep their case, unquoted ones are upper-cased, as Snowflake stores them. 4 foreign keys to a table created later in the file are read from the parse (DuckDB checks the table exists; Snowflake does not). |
| `databricks-uc-catalog-as-code` | Apache Spark 4.3 SQL parser | Every `.sql` under `atlas_demo/src` in path order, as for the retail model. `ALTER … SET TAGS` is Databricks SQL that open-source Spark does not parse (16, `loadErrors`). |
| `databricks-adidas-table-manager` | Apache Spark 4.3 SQL parser | Both files. Spark reads a backslash escape inside a string, so a `COMMENT 'with \" and ;'` holds a quote. |

fakesnow 0.12 also drops every column `COMMENT` ("CommentColumnConstraint unsupported"): the Snowflake helper reads them from sqlglot's parse of each statement that ran, marked `"commentVia": "sqlglot"`. Each helper takes the sample's files in load order and setup statements (`--setup`) from `readback.py`.

The PostgreSQL and MySQL read-backs were also run with `RWT_DOCKER=1` (official `postgres:18` and `mysql:8.0` images, and `pgvector/pgvector:pg18` for Pagila); the catalogs were identical to the Homebrew ones.

## Rerun

```bash
# One-off setup (macOS)
brew install postgresql@18 pgvector       # mysql@8.0 too, if it is not installed
uv venv -p 3.12 /tmp/rwt-snow && uv pip install -p /tmp/rwt-snow/bin/python fakesnow==0.12.1 'snowflake-connector-python<4'
uv venv -p 3.12 /tmp/rwt-spark && uv pip install -p /tmp/rwt-spark/bin/python pyspark==4.3.0   # needs Java

# Every sample (Docker must be running for SQL Server)
RWT_SNOWFLAKE_PYTHON=/tmp/rwt-snow/bin/python RWT_SPARK_PYTHON=/tmp/rwt-spark/bin/python \
  python3 -I test/real-world-truth/readback.py all

# Or some samples
python3 -I test/real-world-truth/readback.py postgres-pagila migrations-harbor sqlite-chinook

# Then compare
npx vitest run test/unit/realWorldEngineTruth.test.ts
```

Settings (environment variables): `RWT_PG_BIN`, `RWT_MYSQL_BIN` (Homebrew paths by default); `RWT_MYSQL_LIBS` (a Homebrew `mysql@8.0` built against an older abseil than the one brew now links: point it at the old keg, e.g. `/opt/homebrew/Cellar/abseil/20240722.1/lib`); `RWT_DOCKER=1` with `RWT_PG_IMAGE`, `RWT_PG_VECTOR_IMAGE`, `RWT_MYSQL_IMAGE`; `RWT_MSSQL_IMAGE`; `RWT_OUT` (write somewhere other than `engine/`). Each engine runs on a temporary directory and a free port on 127.0.0.1 (or in a throwaway container with the samples mounted read-only), and is stopped and removed afterwards. The sample files are only sent to the engine as SQL; Python never runs them, and it is run with `-I`.

The SQL Server error lines are `batchLine`, the line within the `GO` batch, as `sqlcmd` reports them.

## When the comparison fails

`realWorldEngineTruth.test.ts` fails when a difference appears that `differences.json` does not list, or one it lists has gone. Decide which side is wrong, using the engine output as the reference:

- **The truth was wrong**: fix `expected.json` (cite the engine read-back in the sample's `notes`), move the entry to `resolved`. A fix that lowers a scorecard floor needs a written reason in `notes`.
- **The importer was wrong**: fix it in general (not for the sample), with a test, then the truth if needed; record it in `resolved` with `importerBefore` and `importer`.
- **A deliberate modelling choice** (partition folding, D18 optional relationships, a table the truth leaves out): `modellingChoices`, never a truth edit.
- **The engine cannot hold it** (an emulator limit): `differences` with `resolution: "engine-limit"`.
- **The same thing spelled two ways**: teach `canonType` (or the key comparison) the equivalence, with a test in `realWorldEngineTruth.test.ts`, and note it in `equivalences`.

Every statement an engine refused is listed by pattern and count in `loadErrors`; a new one fails the test.

Write `ENGINE_TRUTH_OUT=/tmp/claude-501/diffs.json npx vitest run test/unit/realWorldEngineTruth.test.ts` to get the current differences as JSON.
