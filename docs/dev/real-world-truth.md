# Database truth for the real-world import samples

The scorecard (`test/unit/realWorldImports.scorecard.test.ts`) compares each import with `test/fixtures/real-world-imports/expected.json`, a truth counted by hand from the upstream files. For nine of the eleven SQL samples (Pagila counts twice: partitions folded and kept) that truth is also checked against the real database engines: each sample is loaded into its engine, the schema is read back from the engine's catalog, and the read-back is compared with `expected.json` item by item. Two have no read-back, for want of a local engine (`NOT_ENGINE_VERIFIED` in `test/unit/realWorldEngineTruth.ts` says why for each): `bigquery-cloud-learning-platform` (BigQuery) and `redshift-tpch` (Amazon Redshift), which run only as cloud services. Their truth is `scripts/corpus/count_source.py`'s count (sqlglot) checked by hand in each `SOURCE.md`. The test fails when a SQL sample in `expected.json` is in neither list.

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
| `oracle-hr` | Oracle AI Database 26ai Free 23.26.0 | Docker only (`gvenzl/oracle-free:23.26.0-slim-faststart`, pulled 2026-11-09 as `sha256:a72748b7ecd651182bf64c01d26ec728b1e654191aab7c8d3e40c94cf444a3fc`; native `linux/arm64` and `amd64`, about 1.2 GB; Oracle has no macOS build). The script runs in SQL*Plus inside the container, as the upstream installer runs it: `hr_install.sql` (same commit, not in the sample) creates the `HR` user with its grants, sets `CURRENT_SCHEMA=HR` and calls `@@hr_create.sql` as the installing administrator; the read-back does the same as `SYSTEM` in `FREEPDB1`, without the data and code scripts. Every file goes through SQL*Plus's own `@`, in one session, with `WHENEVER SQLERROR CONTINUE`, so `rem`, `SET`, `Prompt` and blank-line rules are SQL*Plus's. The catalog is `ALL_TABLES`, `ALL_TAB_COLUMNS` (with `ALL_TAB_COLS` for virtual columns), `ALL_CONSTRAINTS`, `ALL_CONS_COLUMNS`, `ALL_TAB_COMMENTS`, `ALL_COL_COMMENTS` and, for unique indexes no key uses, `ALL_INDEXES` / `ALL_IND_COLUMNS`, for the schema's owner, printed by SQL*Plus one `JSON_OBJECT` per line. Types are spelled as Oracle's DDL writes them (`VARCHAR2(25)`, `NUMBER(8,2)`, `NUMBER(*,0)` for `INTEGER`, `TIMESTAMP(6)`); `canonType` knows the `INT`, `VARCHAR`, `DECIMAL`, `FLOAT` and `TIMESTAMP` spellings. Materialized views' container tables and IOT overflow segments are not tables. |
| `sqlite-chinook` | SQLite 3 (Python's `sqlite3`) | The standard library's `sqlite3` in memory: each statement as `sqlite3.complete_statement` splits them (the 15,000 `INSERT`s too), then `pragma_table_info`, `pragma_index_list` / `pragma_index_info` and `pragma_foreign_key_list`. SQLite keeps each column's declared type as written. Nothing to install. |
| `databricks-open-retail-data-model` | Apache Spark 4.3 SQL parser | Open-source Spark's catalog cannot hold primary or foreign keys (they are Unity Catalog's), so this is Spark's parser, not a catalog: each statement goes through `sqlParser.parsePlan` after Spark's own `${var}` substitution (each variable set to its own name, so `${store_schema}` is the schema `store_schema`), and the parsed `CREATE TABLE` and `ADD CONSTRAINT` plans are replayed. Spark's parser marks a primary key column NOT NULL, as Databricks does. |

The PostgreSQL and MySQL read-backs were also run with `RWT_DOCKER=1` (official `postgres:18` and `mysql:8.0` images, and `pgvector/pgvector:pg18` for Pagila); the catalogs were identical to the Homebrew ones.

## Rerun

```bash
# One-off setup (macOS)
brew install postgresql@18 pgvector       # mysql@8.0 too, if it is not installed
uv venv -p 3.12 /tmp/rwt-snow && uv pip install -p /tmp/rwt-snow/bin/python fakesnow==0.12.1 'snowflake-connector-python<4'
uv venv -p 3.12 /tmp/rwt-spark && uv pip install -p /tmp/rwt-spark/bin/python pyspark==4.3.0   # needs Java

# Every sample (Docker must be running for SQL Server and Oracle)
RWT_SNOWFLAKE_PYTHON=/tmp/rwt-snow/bin/python RWT_SPARK_PYTHON=/tmp/rwt-spark/bin/python \
  python3 -I test/real-world-truth/readback.py all

# Or some samples
python3 -I test/real-world-truth/readback.py postgres-pagila migrations-harbor sqlite-chinook
python3 -I test/real-world-truth/readback.py oracle-hr      # pulls gvenzl/oracle-free:23.26.0-slim-faststart (about 1.2 GB) on first use

# Then compare
npx vitest run test/unit/realWorldEngineTruth.test.ts
```

Settings (environment variables): `RWT_PG_BIN`, `RWT_MYSQL_BIN` (Homebrew paths by default); `RWT_MYSQL_LIBS` (a Homebrew `mysql@8.0` built against an older abseil than the one brew now links: point it at the old keg, e.g. `/opt/homebrew/Cellar/abseil/20240722.1/lib`); `RWT_DOCKER=1` with `RWT_PG_IMAGE`, `RWT_PG_VECTOR_IMAGE`, `RWT_MYSQL_IMAGE`; `RWT_MSSQL_IMAGE`; `RWT_ORACLE_IMAGE`; `RWT_OUT` (write somewhere other than `engine/`). Each engine runs on a temporary directory and a free port on 127.0.0.1 (or in a throwaway container with the samples mounted read-only), and is stopped and removed afterwards. The sample files are only sent to the engine as SQL; Python never runs them, and it is run with `-I`.

The SQL Server error lines are `batchLine`, the line within the `GO` batch, as `sqlcmd` reports them. Oracle errors have no line: SQL*Plus prints the failing line of the statement (kept as `statement`) and the `ORA-` / `SP2-` message.

The Oracle image is left in Docker after a run (the container is removed): `docker rmi gvenzl/oracle-free:23.26.0-slim-faststart` frees it. The image was checked for both architectures with `docker manifest inspect` before it was pinned.

### The other Oracle schemas in the import corpus

The corpus (`scripts/corpus/`) has four more Oracle schemas: `oracle-sh`, `oracle-co`, `oracle-chinook` and `oracle-omop-cdm`. They are cache-only, so nothing of theirs is committed, but they were run through the same `Oracle` class once (2026-11-09, at the pinned checksums): SH and CO as their installers run them (CO with HR's grants, SH with `CREATE DIMENSION` as well), Chinook as `SYSTEM` in the CDB root (it creates the common user `C##CHINOOK` and connects as it), and OMOP CDM 5.4 with `@cdmDatabaseSchema` rendered to a schema, as OHDSI's SqlRender does, then its DDL, primary keys, constraints and indices. SH, CO and Chinook read back exactly as `count_source.py` counts them and as the import draws them. OMOP CDM differs by two foreign keys: `concept.vocabulary_id` and `source_to_concept_map.target_vocabulary_id` reference `vocabulary(vocabulary_id)`, which the 5.4 Oracle scripts give no primary key, so Oracle refuses both (`ORA-02270`). The count and the import keep the two relationships the script declares.

## When the comparison fails

`realWorldEngineTruth.test.ts` fails when a difference appears that `differences.json` does not list, or one it lists has gone. Decide which side is wrong, using the engine output as the reference:

- **The truth was wrong**: fix `expected.json` (cite the engine read-back in the sample's `notes`), move the entry to `resolved`. A fix that lowers a scorecard floor needs a written reason in `notes`.
- **The importer was wrong**: fix it in general (not for the sample), with a test, then the truth if needed; record it in `resolved` with `importerBefore` and `importer`.
- **A deliberate modelling choice** (partition folding, D18 optional relationships, a table the truth leaves out): `modellingChoices`, never a truth edit.
- **The engine cannot hold it** (an emulator limit): `differences` with `resolution: "engine-limit"`.
- **The same thing spelled two ways**: teach `canonType` (or the key comparison) the equivalence, with a test in `realWorldEngineTruth.test.ts`, and note it in `equivalences`.

Every statement an engine refused is listed by pattern and count in `loadErrors`; a new one fails the test.

Write `ENGINE_TRUTH_OUT=/tmp/claude-501/diffs.json npx vitest run test/unit/realWorldEngineTruth.test.ts` to get the current differences as JSON.
