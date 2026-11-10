# Grid Reliability (Snowflake)

Import type: **SQL DDL, Snowflake**.

## What it is

The setup scripts from Snowflake's own quickstart "AI-powered predictive grid
maintenance". They build a utility's asset and sensor database: transformers and
substations, sensor readings, maintenance history, failures, SCADA alarms, ML
models and predictions, plus documents and computer-vision inspections. They are
real deployment scripts, so the `CREATE TABLE` statements sit among databases,
warehouses, stages, functions, roles, grants, an `INSERT` and `SELECT`s.

The two scripts are imported together as one folder (`scripts/`). Script 03
points foreign keys at `RAW.ASSET_MASTER` in script 02, so it only makes sense
with 02 beside it.

## Where it came from

- Project: https://github.com/Snowflake-Labs/sfguide-ai-powered-predictive-grid-maintenance (published by Snowflake Inc. under the Snowflake-Labs organisation)
- Pin: commit `3bde66d4fcc3b8cfc7ed3183819fba82d44a5745` on `main` (2026-02-19). Both files last changed in `69181e59ed2c2b69475d5f255fa673687c796103`.
- Files:
  - https://raw.githubusercontent.com/Snowflake-Labs/sfguide-ai-powered-predictive-grid-maintenance/3bde66d4fcc3b8cfc7ed3183819fba82d44a5745/scripts/02_structured_data_schema.sql
  - https://raw.githubusercontent.com/Snowflake-Labs/sfguide-ai-powered-predictive-grid-maintenance/3bde66d4fcc3b8cfc7ed3183819fba82d44a5745/scripts/03_unstructured_data_schema.sql
- SHA-256:
  - `02_structured_data_schema.sql` (23,597 bytes): `c3af206ec35fd5ca9c66ac92b5a57b534d857ea5f50699e79f307b27b71a1541`
  - `03_unstructured_data_schema.sql` (13,644 bytes): `22407ef63bf56658bac4e5fefc225adb4db5926102b9ec58da0dd72188fe14ca`
- Downloaded 2026-11-07.

## Licence

Apache-2.0 (repo `LICENSE`, and an `SPDX-License-Identifier: Apache-2.0`
header with "Copyright 2026 Snowflake Inc." in each script). Redistribution is
allowed with a copy of the licence and the notices kept. The headers are
unchanged and the licence is copied to `UPSTREAM-LICENSE.txt`. The repo has no
`NOTICE` file.

## What was copied

- `scripts/02_structured_data_schema.sql` and `scripts/03_unstructured_data_schema.sql`, byte for byte, in the upstream `scripts/` folder.
- Not copied: the other 18 scripts in `scripts/` (infrastructure, ML, views, semantic model, agent, loads, sample queries). `01_infrastructure_setup.sql` only makes schemas and stages, no tables. Also not copied: data generators, the Streamlit app and the shell scripts.

## Expected counts

Counted by a small Python script (not ERD Studio) that strips comments, splits
statements on `;`, tracks `USE SCHEMA`, and splits each `CREATE OR REPLACE TABLE
name (...)` body on top-level commas. A column is any entry that does not start
with `CONSTRAINT`, `FOREIGN KEY` or `PRIMARY KEY`. Checked by reading both files.

- Tables: **18** (with a column list). Plus 1 `CREATE TABLE ... AS SELECT` and 1 view, which are not counted.
- Columns: **237** (167 in script 02, 70 in script 03)
- Primary keys: **18**, all single-column and inline (`col TYPE PRIMARY KEY`)
- Foreign keys / relationships: **12**, all single-column, all many-to-one

| Schema | Table | File | Columns | Primary key | Foreign keys (column → target) |
|---|---|---|---|---|---|
| RAW | ASSET_MASTER | 02 | 23 | ASSET_ID | – |
| RAW | SENSOR_READINGS | 02 | 20 | READING_ID | ASSET_ID → ASSET_MASTER |
| RAW | MAINTENANCE_HISTORY | 02 | 12 | MAINTENANCE_ID | ASSET_ID → ASSET_MASTER |
| RAW | FAILURE_EVENTS | 02 | 12 | EVENT_ID | ASSET_ID → ASSET_MASTER |
| RAW | WEATHER_DATA | 02 | 11 | WEATHER_ID | – |
| RAW | SCADA_EVENTS | 02 | 11 | EVENT_ID | ASSET_ID → ASSET_MASTER |
| RAW | FAILURE_TYPE_REFERENCE | 02 | 5 | FAILURE_TYPE_CODE | – |
| ML | TRAINING_DATA | 02 | 9 | RECORD_ID | – |
| ML | MODEL_REGISTRY | 02 | 15 | MODEL_ID | – |
| ML | MODEL_PREDICTIONS | 02 | 13 | PREDICTION_ID | ASSET_ID → RAW.ASSET_MASTER; MODEL_ID → MODEL_REGISTRY |
| ML | MODEL_PERFORMANCE | 02 | 18 | EVAL_ID | MODEL_ID → MODEL_REGISTRY |
| ML | FEATURE_IMPORTANCE | 02 | 6 | IMPORTANCE_ID | MODEL_ID → MODEL_REGISTRY |
| STAGING | SENSOR_STAGING | 02 | 6 | STAGING_ID | – |
| STAGING | ASSET_STAGING | 02 | 6 | STAGING_ID | – |
| UNSTRUCTURED | MAINTENANCE_LOG_DOCUMENTS | 03 | 24 | DOCUMENT_ID | ASSET_ID → RAW.ASSET_MASTER |
| UNSTRUCTURED | TECHNICAL_MANUALS | 03 | 17 | MANUAL_ID | – |
| UNSTRUCTURED | VISUAL_INSPECTIONS | 03 | 16 | INSPECTION_ID | ASSET_ID → RAW.ASSET_MASTER |
| UNSTRUCTURED | CV_DETECTIONS | 03 | 13 | DETECTION_ID | INSPECTION_ID → VISUAL_INSPECTIONS; ASSET_ID → RAW.ASSET_MASTER |

`ASSET_MASTER` is the hub: 8 of the 12 foreign keys point at it. `MODEL_REGISTRY`
takes 3. Not counted: `UNSTRUCTURED.DOCUMENT_SEARCH_INDEX` (a `CREATE OR REPLACE
TABLE ... AS SELECT` with 9 output columns and no column types) and the view
`UNSTRUCTURED.VW_ENRICHED_ASSET_FEATURES`.

## Notable features

Things an importer might drop or get wrong:

- **Schemas set by `USE SCHEMA`, not in the table name.** Every table is
  created unqualified (`CREATE OR REPLACE TABLE ASSET_MASTER (`). The schema
  comes from the last `USE SCHEMA` (RAW, ML, STAGING, back to RAW, then
  UNSTRUCTURED in script 03). An importer that ignores `USE` puts all 18 tables
  in one schema.
- **Cross-schema and cross-file foreign keys.** 4 foreign keys name
  `RAW.ASSET_MASTER` (schema-qualified), 3 of them from the other file. The
  other 8 use a bare table name.
- **Unnamed foreign keys.** The 4 in script 03 are bare
  `FOREIGN KEY (...) REFERENCES ...` with no `CONSTRAINT name`.
- **Semi-structured and vector types:** `VARIANT` (11 columns), `ARRAY` (5),
  `OBJECT` (2), `VECTOR(FLOAT, 768)` (2, with a comma inside the type's
  brackets).
- **Other types:** `NUMBER(p,s)`, `NUMBER(p)` with no scale, `NUMBER(38,0)`,
  `VARCHAR(n)`, `VARCHAR(16777216)` (Snowflake's max), `TIMESTAMP_NTZ` with no
  precision, `DATE`, `BOOLEAN`.
- **`AUTOINCREMENT`** on 8 primary keys (`NUMBER(38,0) AUTOINCREMENT PRIMARY KEY`).
- **Defaults** on 28 columns (21 in script 02, 7 in script 03): `DEFAULT CURRENT_TIMESTAMP()`, `DEFAULT FALSE`,
  `DEFAULT 'ACTIVE'`, `DEFAULT 'TRAINING'`, and `NOT NULL DEFAULT ...` on one column.
- **Table comments** (`COMMENT = '...'` after the column list) on 13 tables, all
  in script 02. There are no column `COMMENT` clauses. Column notes are `--` line
  comments only, which an importer will not keep.
- **`CLUSTER BY (...)`** after the comment on 8 tables.
- **Keyword-like column names:** `PRECISION` (MODEL_PERFORMANCE), `VERSION`,
  `MODEL`, `DESCRIPTION`, `STATUS`.
- **Repeated names:** `EVENT_ID` is the primary key of both FAILURE_EVENTS and
  SCADA_EVENTS. SENSOR_STAGING and ASSET_STAGING have the same six columns.
- **Undeclared links.** `TRAINING_DATA.ASSET_ID` and
  `FAILURE_EVENTS.FAILURE_TYPE` have no foreign key, so they should not become
  relationships.
- **Statements that are not tables:** `CREATE DATABASE`, `CREATE SCHEMA`,
  `CREATE WAREHOUSE`, `CREATE STAGE ... DIRECTORY = (ENABLE = TRUE)`,
  `CREATE FUNCTION` with a `$$ ... $$` body, `INSERT INTO ... SELECT
  PARSE_JSON(...)`, `CREATE ROLE`, many `GRANT`s, `USE ROLE` / `USE
  WAREHOUSE`, `SET var = (SELECT ...)`, `IDENTIFIER($var)`, `SELECT` and `SHOW`.
  The importer should skip them without an error.
- **Block comments** (`/* ... */`) at the top of each file, including the licence header.
- All identifiers are unquoted upper case. Nothing is quoted or mixed case.
