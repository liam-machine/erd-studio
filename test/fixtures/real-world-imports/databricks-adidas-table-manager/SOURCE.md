# Table manager test files, adidas lakehouse-engine (Databricks)

Import type: **SQL DDL, Databricks / Spark SQL**. Pick both files in `table/` in **Import SQL DDL…**; the dialect is detected (Databricks / Spark SQL).

## What it is

adidas' open-source `lakehouse-engine` has a table manager that splits DDL files into statements before it runs
them. These two files are its tests: Delta tables (`USING DELTA PARTITIONED BY (year, month, day) LOCATION 'file:///…'`)
whose column `COMMENT`s hold `;`, brackets, `<>`, `/*`, `*/` and `--` in single and double quotes, with `\"` escapes,
a block comment between two statements, and no semicolon after the last statement of either file.

What it adds to the samples: a statement-splitter torture test in Spark SQL's own string rules (a backslash escape
inside a string), and a primary key written only as a tool property (`TBLPROPERTIES('lakehouse.primary_key'=' id, `col1`')`),
which is not a declared key.

## Where it came from

- Project: https://github.com/adidas/lakehouse-engine
- Pin: commit `7d543c5ae3a3427870722cec19ab36d5306217d2`, as pinned by the import corpus (`scripts/corpus/manifest.json`, entry `databricks-adidas-lakehouse-engine-table-manager`, pinned 2026-11-09).
- Files (`tests/resources/feature/table_manager/create/table/` upstream, `table/` here):
  - https://raw.githubusercontent.com/adidas/lakehouse-engine/7d543c5ae3a3427870722cec19ab36d5306217d2/tests/resources/feature/table_manager/create/table/test_table_complex_default_scenario.sql
  - https://raw.githubusercontent.com/adidas/lakehouse-engine/7d543c5ae3a3427870722cec19ab36d5306217d2/tests/resources/feature/table_manager/create/table/test_table_simple_split_scenario.sql
- SHA-256:
  - `table/test_table_complex_default_scenario.sql` (2,197 bytes): `21da661b66821b9fe3323df0c2a91adf9a9a574b42e269d45f5bb2646399c74b`
  - `table/test_table_simple_split_scenario.sql` (359 bytes): `b99a23fdecaaacfe49ac3f9e95acb56f8065761bebcb4c1c87eac38e19f88d0c`
- Downloaded 2026-11-09; each file's SHA-256 checked against the pinned manifest.

## Licence

Apache-2.0 (`LICENSE.txt`), copied to `UPSTREAM-LICENSE.txt`. The repository has no `NOTICE` file and the
files carry no header; they are unchanged.

## What was copied

- `tests/resources/feature/table_manager/create/table/test_table_complex_default_scenario.sql` and
  `test_table_simple_split_scenario.sql`, byte for byte, as `table/`.
- Not copied: the sibling `*_different_delimiter_scenario.sql`, which uses the tool's own `===` delimiter and is not Spark SQL.

## Expected counts

Read back with Apache Spark 4.3's SQL parser (`spark_readback.py`). Spark reads `\"` inside a string as `"`, so
a description holds the quote, not the backslash (an equivalence in `differences.json`). `scripts/corpus/count_source.py`
reads both statements of the first file only approximately (its structural reader stops at the `/*` inside a string), so
the truth is the engine's.

- Tables: **3**
- Columns: **24**
- Primary keys: **0**
- Foreign keys / relationships: **0**
- Descriptions (tables and columns): **16**

| Schema | Table | Columns | Primary key | Foreign keys (column → target) |
|---|---|---|---|---|
| test_db | DummyTableBronzeComplexDefaultScenario1 | 8 | – | – |
| test_db | DummyTableBronzeComplexDefaultScenario2 | 8 | – | – |
| test_db | DummyTableBronzeSimpleSplitScenario | 8 | – | – |
