# Import analysis: Grid Reliability predictive maintenance (Snowflake)

**Verdict: failed.** 0 of 18 tables were imported. Three gaps in the Snowflake grammar break 10 tables, and one failure blocks all 18. Most messages give no cause, and only 3 of the 10 problems are shown. In a test where every table parses, the types and keys come through, but 4 of the 12 foreign keys drop with a false "not in the files" note.

## Tested with

- ERD Studio 2.0 (`feat/native-dbml-storage` at `d04c4167`), as a frozen build. The output log calls it "ERD Studio 1.7.2" because the root version is not bumped on the branch. The SQL engine is `@dbml/core` 11.0.0.
- An isolated VS Code 1.145.2 window, opened on a copy of this sample folder.
- Path A (filmed): ERD Studio sidebar → `More ways to start…` → `Import…` → `SQL DDL scripts` (marked "found in this folder") → tick the `scripts` folder, so both files import together → dialect **Snowflake**, which was marked "detected" and listed first.
- Path B (filmed, the obvious retry): the sidebar button `Import your SQL scripts` → dialect **Databricks / Spark SQL**.
- Rehearsal only, not filmed: the start toast's `Show Me` with Snowflake gave the same 10-problem refusal.
- Engine checks outside VS Code: the frozen build's `sqlDdlToDbml` (`dist/sqlImport.js`), run on the same two files.
- Video: `import-review.mp4` in this folder.

## Numbers

| | Source | Imported | Readable by the parser (8 tables alone) | Once all 18 parse (what-if) |
|---|---:|---:|---:|---:|
| Tables | 18 | 0 | 8 | 18 |
| Columns | 237 | 0 | 85 | 237 |
| Primary keys | 18 | 0 | 8 | 18 |
| Foreign keys → relationships | 12 | 0 | 3 resolved (5 declared) | 8 |
| `AUTOINCREMENT` → `increment` | 8 | 0 | – | 8 |
| `DEFAULT` → `default:` | 28 | 0 | – | 28 |
| Table `COMMENT` → `Note` | 13 | 0 | – | 13 |
| Schemas (RAW, ML, STAGING, UNSTRUCTURED) | 4 | 0 | 0 | 0 |
| Files written to `.erd-studio/` | – | none | – | – |

How I counted:

- **Source:** from `SOURCE.md`. A standalone stdlib Python counter split each `CREATE OR REPLACE TABLE` body on top-level commas, and the result was checked by reading both files. `DOCUMENT_SEARCH_INDEX` (a CTAS) and the view `VW_ENRICHED_ASSET_FEATURES` are not counted.
- **Imported:** `node dist/cli.js inventory --json --project <demo copy>` returns `"code": "no-project"` ("No .erd-studio/ folder found"), exit 3. The demo copy holds only `scripts/`, `SOURCE.md` and `UPSTREAM-LICENSE.txt`.
- **Readable:** I re-ran the frozen engine as Snowflake on both scripts with the 10 failing `CREATE TABLE` statements removed.
  - It gives 8 tables, 85 columns, 8 `pk` and 3 Refs:
    - MODEL_PERFORMANCE → MODEL_REGISTRY
    - FEATURE_IMPORTANCE → MODEL_REGISTRY
    - CV_DETECTIONS → VISUAL_INSPECTIONS
  - The other 2 declared FKs (VISUAL_INSPECTIONS.ASSET_ID and CV_DETECTIONS.ASSET_ID → `RAW.ASSET_MASTER`) are skipped.
  - The analysis said 4 relationships. The verifier said 3, the fixer confirmed it, and my re-run gives 3. The final video shows "3 (5 declared)".
- **What-if:** I re-ran the frozen engine on a copy with three edits: every `CLUSTER BY (…)` removed, `FILE_FORMAT` quoted, and `VECTOR(FLOAT, 768)` replaced with `ARRAY`.
  - `ok: true`, 18 tables, `refCount` 8, 237 column lines, 18 `pk`, 8 `increment`, 28 `default:` and 13 table `Note:` lines.
  - No table name has a schema prefix, and no `FK_` constraint name survives.

## Errors

### E1. The import refused the whole folder and wrote nothing

The dialect was correct and was detected. The import showed an error toast and nothing else: no draft preview, no layer or name prompt, no `.erd-studio/` folder and no `.dbml` file.

- Toast (path A, Snowflake): "Import SQL DDL: nothing was imported. 02_structured_data_schema.sql line 79: CREATE TABLE ASSET_MASTER could not be read: the SQL parser could not read this statement. 02_structured_data_schema.sql line 111: CREATE TABLE SENSOR_READINGS could not be read: the SQL parser could not read this statement. 02_structured_data_schema.sql line 159: CREATE TABLE MAINTENANCE_HISTORY could not be read: the SQL parser could not read this statement. And 7 more problems. They were read as Snowflake." Buttons: `Open File` | `Try Another Dialect`.
- Code path:
  - `src/commands/importSqlDdl.ts:305` calls `engine.sqlDdlToDbml`.
  - On `!result.ok`, lines 309-318 show `describeImportProblems(…)` and return.
  - The refusal itself is at `src/services/sqlDdlImport.ts:2011`: `if (converter.problems.length) return { ok: false, problems: converter.problems };`.
  - Each table goes to the engine at `src/services/sqlDdlImport.ts:971`, which calls `src/services/sqlImportEngine.ts:40` (`Parser.parseSnowflakeToJSON`).

### E2. `COMMENT = '…'` followed by `CLUSTER BY (…)` crashes the Snowflake grammar (8 tables)

- Affected: ASSET_MASTER, SENSOR_READINGS, MAINTENANCE_HISTORY, FAILURE_EVENTS, WEATHER_DATA, SCADA_EVENTS, TRAINING_DATA and MODEL_PREDICTIONS.
- The clauses are at `scripts/02_structured_data_schema.sql:104-105`, `149-150`, `175-176`, `198-199`, `218-219`, `240-241`, `270-271` and `325-326`.
- Each clause parses on its own. Only the pair fails, and it fails as a grammar crash (a TypeError in `visitCreate_table`), not as a syntax error.
- Removing every `CLUSTER BY` lets all 14 tables in script 02 parse.
- Messages: 02 lines 79, 111, 159, 182, 205, 225, 253 and 300, each "the SQL parser could not read this statement".

### E3. `VECTOR(FLOAT, 768)` is not in the grammar (2 columns)

- Affected: TECHNICAL_MANUALS.EMBEDDING (`scripts/03_unstructured_data_schema.sql:136`) and MAINTENANCE_LOG_DOCUMENTS.EMBEDDING (`03:98`).
- Message at 03 line 136: "CREATE TABLE TECHNICAL_MANUALS could not be read: no viable alternative at input 'CREATE OR REPLACE TABLE TECHNICAL_MANUALS ( … EMBEDDING VECTOR'". It is one of the 7 hidden problems.

### E4. An unquoted column named `FILE_FORMAT` is rejected (1 table)

- Source: `scripts/03_unstructured_data_schema.sql:78`, `FILE_FORMAT VARCHAR(20)`.
- Snowflake accepts this name unquoted. The grammar treats it as a keyword, and the quoted form `"FILE_FORMAT"` parses.
- MAINTENANCE_LOG_DOCUMENTS stops here first (message at 03 line 78). With `FILE_FORMAT` quoted, the same table still fails at `VECTOR` on line 98, so it has 2 blockers.

## Bugs (silently lost or wrong)

### B1. Syntax-error messages echo the raw SQL, comments included

- The 2 non-crash problems (03 line 78 and 03 line 136) pass ANTLR's text through unchanged.
- Run on script 03 alone, they are 550 and 847 characters long. Verbatim start: "CREATE TABLE MAINTENANCE_LOG_DOCUMENTS could not be read: no viable alternative at input 'CREATE OR REPLACE TABLE MAINTENANCE_LOG_DOCUMENTS (\n    DOCUMENT_ID VARCHAR(50) PRIMARY KEY,\n    ASSET_ID VARCHAR(50) NOT NULL,\n    DOCUMENT_TYPE VARCHAR(50), -- 'INSPECTION_REPORT', 'WORK_ORDER', …".
- This breaks the module's own contract at `src/services/sqlDdlImport.ts:49-51`: "Never echoes file contents in a message beyond a table, column or constraint name".
- Cause: `firstDiagnostic` (`src/services/sqlDdlImport.ts:1861-1869`) replaces only grammar-crash messages (`/Cannot read properties|is not a function|undefined/`). Syntax errors pass through.
- It is hidden in this run because these are problems 9 and 10 and the toast lists 3. It shows if `scripts/03_unstructured_data_schema.sql` is imported alone.

### B2. Latent, seen once all 18 tables parse: `USE SCHEMA` is ignored, so schemas are lost and 4 foreign keys drop with a false note

- `USE` is skipped as a session statement (`src/services/sqlDdlImport.ts:911-913`).
- Unqualified tables then get no schema (`:960`).
- `REFERENCES RAW.ASSET_MASTER` then fails `findTable` and is skipped (`:1657-1658`).
- In the what-if run, all 18 tables come in unqualified, in one schema. Nothing tells the user the RAW, ML, STAGING and UNSTRUCTURED schemas were dropped.
- 4 of 12 FKs drop: MODEL_PREDICTIONS (`02:322`), MAINTENANCE_LOG_DOCUMENTS (`03:105`), VISUAL_INSPECTIONS (`03:176`) and CV_DETECTIONS (`03:204`), each on ASSET_ID.
- The note for each drop is false. Verbatim: "foreign key MODEL_PREDICTIONS(ASSET_ID) → RAW.ASSET_MASTER: that table is not in the files", and the same for the other 3. ASSET_MASTER is in the files at `02:79`, under `USE SCHEMA RAW` at `02:73`. The user is told a table is missing when it is not.

## Gaps (unsupported)

### G1. All or nothing: the 8 tables that parse are dropped too (user told)

- The 8 tables are MODEL_REGISTRY, MODEL_PERFORMANCE, FEATURE_IMPORTANCE, SENSOR_STAGING, ASSET_STAGING, FAILURE_TYPE_REFERENCE, VISUAL_INSPECTIONS and CV_DETECTIONS.
- Together they hold 85 columns, 8 PKs and 3 resolvable relationships, but no partial draft is offered.
- The toast does say "nothing was imported". Cause: `src/services/sqlDdlImport.ts:2011`.

### G2. 8 of 10 messages name no cause, and `Open File` lands on the statement's first line (user told only "could not read")

- `firstDiagnostic` replaces the grammar crash with "the SQL parser could not read this statement" (`src/services/sqlDdlImport.ts:1868`). Nothing names `CLUSTER BY`.
- `Open File` opened `02_structured_data_schema.sql` at "Ln 79, Col 1" (`CREATE OR REPLACE TABLE ASSET_MASTER`). The lines to change are 104-105.

### G3. 7 of 10 problems are hidden and never logged (user told only a count)

- The toast names 3 problems and says "And 7 more problems" (`src/services/importSources.ts:297`, `PROBLEMS_SHOWN = 3`).
- `showError` in `src/commands/importSqlDdl.ts:215` logs only when a button action fails, not the problem list.
- The ERD Studio output channel holds activation lines only. It ends at "[Table Library] Background read of the Table Library finished: 0 file(s) in 0 slice(s), 1 ms after it started". The status-bar Problems count stays 0.
- The `VECTOR` and `FILE_FORMAT` problems are never shown. A user who fixes the 3 tables shown hits new errors on the next try.

### G4. `Try Another Dialect` cannot help (user not told)

Every other dialect rejects the scripts:

- **Databricks / Spark SQL: 17 problems.** Every table fails except FAILURE_TYPE_REFERENCE.
  - `AUTOINCREMENT` causes 8: "mismatched input 'AUTOINCREMENT' expecting ')'" at 02 lines 112, 206, 226, 254, 301, 370, 392 and 406.
  - `DEFAULT CURRENT_TIMESTAMP()` causes 7: "missing {Integral, BinaryIntegral, OctalIntegral, HexadecimalIntegral} at ')'" at 02 lines 100, 171, 194, 291 and 359, and 03 lines 165 and 201.
  - A grammar crash ("could not read this statement") hits the 2 `VECTOR` tables, at 03 lines 67 and 115.
  - The Databricks line numbers point inside statements (100 for ASSET_MASTER, against 79 as Snowflake).
- **PostgreSQL and MySQL: 18 problems each**, "no viable alternative at input 'CREATE OR REPLACE …'".
- **SQL Server: 18 problems**, "… 'CREATEORREPLACE…'".

### G5. Constraint names are not kept (user not told)

- 8 FKs are named, for example `CONSTRAINT FK_SENSOR_ASSET` at `02:147`.
- In the what-if output no Ref carries a name: 0 matches for `FK_`.

### G6. Minor: the file label in the error depends on the entry point (cosmetic)

- Through `Import…` with a folder pick, the error names a bare `02_structured_data_schema.sql`.
- Through the sidebar button or `Show Me`, it names `scripts/02_structured_data_schema.sql`.

## What came through correctly

- **Detection.** The start toast counted 18 tables, which excludes the CTAS at `03:271` and the view at `03:212` (`countCreateTablesWithColumns`, `src/services/sqlDdlImport.ts:527`). The source pick said "found in this folder". Snowflake was marked "detected" and listed first (`src/services/sqlDdlImport.ts:270-273`).
- **Non-table statements were skipped without error.** All 10 problems are `CREATE TABLE` statements. The engine's skip notes, verbatim:
  - "scripts/02_structured_data_schema.sql: skipped 6 schema or database statements, 9 session statements (SET, USE…), 6 other statements, 2 functions, procedures or triggers, 1 data statement (INSERT, UPDATE…), 38 permission statements (GRANT, REVOKE), 4 queries"
  - "scripts/03_unstructured_data_schema.sql: skipped 4 session statements (SET, USE…), 1 schema or database statement, 3 other statements, 1 view, 1 CREATE TABLE without a column list (AS SELECT, LIKE, CLONE), 14 permission statements (GRANT, REVOKE), 7 queries"
- **The refusal is clean.** Nothing was half-written.
- **`Open File` works.** It lands on the first rejected statement, `02:79`.
- **What-if, once the grammar reads every table:**
  - Types are kept as written: `NUMBER(p,s)`, `NUMBER(p)`, `NUMBER(38,0)`, `VARCHAR(16777216)`, `TIMESTAMP_NTZ`, `VARIANT`, `ARRAY` and `OBJECT`. For example, `02:102` became `"METADATA" VARIANT`.
  - All 18 PKs come through, and the 8 `AUTOINCREMENT` keys get `increment`. For example, `02:112` became `"READING_ID" NUMBER(38,0) [pk, increment]`.
  - All 28 defaults come through. For example, `02:303` became `[not null, default: `CURRENT_TIMESTAMP()`]`.
  - All 13 table notes come through. For example, `02:104` became `Note: 'Master inventory of T&D …'`.
  - Keyword-like column names survive (PRECISION at `02:341`, VERSION, MODEL, STATUS, DESCRIPTION).
  - The unnamed FK `CV_DETECTIONS.INSPECTION_ID → VISUAL_INSPECTIONS` (`03:203`) comes through.
  - No relationship is invented for TRAINING_DATA.ASSET_ID or FAILURE_EVENTS.FAILURE_TYPE.

## What the import showed

- Start toast: "ERD Studio found CREATE TABLE scripts in this folder (18 tables). Show them as a diagram? Nothing is saved until you keep it." Buttons: `Show Me` | `Don't Ask Again for This Folder`.
- Sidebar: "No diagrams yet. This folder has CREATE TABLE scripts." [Import your SQL scripts] "Or: More ways to start…"
- Dialect pick, placeholder "Which SQL dialect are the scripts written in?": Snowflake [detected] | PostgreSQL | MySQL / MariaDB | SQL Server / Azure SQL | Databricks / Spark SQL.
- Snowflake toast (path A): see E1, verbatim. Through `Show Me` (rehearsal) it is identical except the file reads `scripts/02_structured_data_schema.sql`.
- Databricks toast (path B): "Import SQL DDL: nothing was imported. scripts/02_structured_data_schema.sql line 100: CREATE TABLE ASSET_MASTER could not be read: missing {Integral, BinaryIntegral, OctalIntegral, HexadecimalIntegral} at ')'. scripts/02_structured_data_schema.sql line 112: CREATE TABLE SENSOR_READINGS could not be read: mismatched input 'AUTOINCREMENT' expecting ')'. scripts/02_structured_data_schema.sql line 171: CREATE TABLE MAINTENANCE_HISTORY could not be read: missing {Integral, BinaryIntegral, OctalIntegral, HexadecimalIntegral} at ')'. And 14 more problems. They were read as Databricks / Spark SQL." Buttons: `Open File` | `Try Another Dialect`.
- There was no dry-run summary or draft preview, because the import never got that far.
- ERD Studio output channel, complete: activation lines only ("ERD Studio 1.7.2 activating …", "Opened … (no dbt_project.yml: logical-only)", "Project: DBML storage, 0 table file(s), 0 diagram(s), no dbt project (logical only) …", "Activation prompt: startSuggestion", "Activated in 32 ms", "Activation prompt: startSuggestion shown", "[Table Library] Background read of the Table Library finished: 0 file(s) in 0 slice(s), 1 ms after it started"). There is nothing about either import.
- Explorer: no `.erd-studio` folder.

## Why it failed, and what a user would have to do

`importSqlDdl` (`src/commands/importSqlDdl.ts:305-318`) calls `sqlDdlToDbml`. The converter sends each `CREATE TABLE` to `@dbml/core` 11.0.0 (`src/services/sqlImportEngine.ts:40`, called from `src/services/sqlDdlImport.ts:971`). Ten statements throw. A single problem refuses the whole conversion (`src/services/sqlDdlImport.ts:2011`), and the command shows 3 problems and stops.

To get this schema in today, a user would have to edit the scripts:

1. Remove every `CLUSTER BY (…)` after a table `COMMENT`, or remove the `COMMENT` (8 tables).
2. Quote `"FILE_FORMAT"` at `03:78`.
3. Replace `VECTOR(FLOAT, 768)` at `03:98` and `03:136` with a type the grammar knows, such as `ARRAY`.

Nothing in the UI names these three changes. Even after them, the import loses the RAW, ML, STAGING and UNSTRUCTURED schemas. It also drops the 4 foreign keys to `RAW.ASSET_MASTER` with a note saying the table is not in the files. To keep them, the user would also have to strip the `RAW.` qualifier from those 4 `REFERENCES` clauses.
