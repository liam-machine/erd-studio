# Import analysis: Open Retail Data Model canonical core (Databricks / Spark SQL)

**Verdict: import failed.** The `${catalog}.${schema}` table names are not read, so 0 of 34 tables came in and nothing was written. The error blames a missing column list, and choosing another dialect can't fix it. With the names filled in by hand, the converter reads all 34 tables, 635 columns and 43 relationships.

## Tested with

- ERD Studio 2.0, branch `feat/native-dbml-storage` at `d04c4167` (PR #226). The build reports itself as 1.7.2. It ran from a frozen extension build in a fresh, isolated VS Code window.
- Import path: ERD Studio sidebar, then **More ways to start…**, then **Import…**, then **SQL DDL scripts**. In the open dialog I ticked the whole `canonical-core/` folder (51 `.sql` files) and pressed Import. For the dialect I picked **Databricks / Spark SQL**, which was tagged "detected". After the error I clicked **Try Another Dialect** and picked **Snowflake**. The run never reached the layer, diagram-name or dry-run steps.
- Video: [`import-review.mp4`](import-review.mp4) (98.6 s). Source and expected counts: [`SOURCE.md`](SOURCE.md).

## Source vs imported

| | Source | Imported (filmed) | Placeholders filled in by hand* |
|---|---|---|---|
| Tables | 34 | 0 | 34 |
| Columns | 635 | 0 | 635 |
| Primary keys | 34 | 0 | 34 (`pk, increment`) |
| Foreign keys → relationships | 43 | 0 | 43 (25 cross-schema) |
| NOT NULL | 149 | 0 | 149 |
| Comments (column / table) | 635 / 34 | 0 / 0 | 635 / 34 |
| CHECK constraints | 101 | 0 | 0 (skipped, listed) |

\* An off-screen run of the same SQL converter (`dist/sqlImport.js`, `sqlDdlToDbml`), not the filmed import.

How I counted:

- **Source:** the numbers in `SOURCE.md` come from a standalone script. I re-checked some of them with grep:
  - 44 `FOREIGN KEY` hits, one of them in a comment, so 43 FKs.
  - 101 `CHECK (`.
  - 58 `SET TAGS`.
  - 16 `SET MASK`.
  - 633 `${` in total: 630 in statements and 3 in comment lines.
  - 15 distinct `${…_schema}` placeholders.
- **Imported:** `erd-studio inventory --json` on the demo copy returns `no-project` ("No .erd-studio/ folder found in {path}"), exit 3. The demo folder holds only `canonical-core/`, `SOURCE.md` and `UPSTREAM-LICENSE.txt`.
- **Placeholders filled:** I re-ran the converter in memory and edited no files. I dropped `${catalog}.`, replaced `${order_schema}` with `orders`, and replaced each other `${x}` with `x`. With the Databricks dialect it returned `ok`, `tableCount` 34 and `refCount` 43. The DBML holds:
  - 635 column lines;
  - 34 `pk`;
  - 149 `not null`;
  - 635 column notes and 34 table `Note:` lines;
  - 25 refs whose schemas differ.
  
  Its skip lines add up to 175 skipped ALTER TABLEs (101 CHECK + 58 SET TAGS + 16 SET MASK) and 4 functions. The fixer filled the names with upstream's `databricks.yml` defaults instead and got the same counts. The analysis, the fixer and the final storyboard agree on every number.

## Findings

### Errors

**1. The import failed: no table was read, nothing was written.**
- Every CREATE TABLE, ALTER TABLE and REFERENCES uses a templated name. For example, `canonical-core/store/tables/store.sql:15` reads `CREATE TABLE IF NOT EXISTS ${catalog}.${store_schema}.store (`. The FKs look the same, as in `canonical-core/customer/relationships.sql:21-23`: `ALTER TABLE ${catalog}.${customer_schema}.address … REFERENCES ${catalog}.${customer_schema}.profile (profile_sk);`
- UI: "Import SQL DDL: nothing was imported. No CREATE TABLE statements with a column list were found in the files. They were read as Databricks / Spark SQL."
- The code path is under "Why the import failed" below.

### Bugs (silently lost or wrong)

**2. The error names the wrong cause and points at no file or line.**
- All 34 CREATE TABLEs have a column list (for example `store.sql:15-44`).
- The real reason, the templated name, is recorded per statement and then dropped. Each statement is skipped as `ctas` ("CREATE TABLE without a column list (AS SELECT, LIKE, CLONE)", `src/services/sqlDdlImport.ts:823`, `:946`). `convertSqlDdl` then returns early at `src/services/sqlDdlImport.ts:2012-2016`, before it builds the skipped summary at `:2031`.
- The problem's `file` is `''` because more than one file was read, so the toast has no **Open File** button (`src/commands/importSqlDdl.ts:311-313`).

**3. Try Another Dialect is the only action, and no dialect can help.**
- The tokenizer and `readName()` are the same for every dialect.
- On camera, Snowflake gave the same error: "Import SQL DDL: nothing was imported. No CREATE TABLE statements with a column list were found in the files. They were read as Snowflake."
- I re-ran the converter on the unchanged files with `databricks`, `postgres`, `mysql`, `sqlserver` and `snowflake`. All five return the same single `noCreateTable` problem with `file: ''`.
- After the retry, the dialect pick still lists Databricks first, tagged "detected". Nothing says it already failed (`src/commands/importSqlDdl.ts:290`, `:314-316`).

**4. The same cause hides the SQL from the start screen.** This is the same bug as finding 1, not a second detection bug.
- The folder look counts tables with `sqlScriptTableCount` → `countSqlCreateTables` → `countCreateTablesWithColumns`:
  - `src/commands/importModel.ts:220`
  - `src/commands/importSqlDdl.ts:391`
  - `src/services/importSources.ts:59`, `:87`
  - `src/services/sqlDdlImport.ts:527-549`
- That count uses the same tokenizer and `readName()`, so it is 0 for every file.
- As a result, opening the sidebar opened ERD Studio's own example with the wrong message "Nothing here to draw from yet, so this is an example: 6 tables, 8 relationships. Nothing is saved yet."
- In the Import picker, "SQL DDL scripts" was not tagged "found in this folder".
- One cause, three symptoms: the missed folder look, the misleading message, and a failure in every dialect.

**5. Minor, converter only: files that hold only CHECKs or masks are called empty, then listed again.**
- In the filled run, the skip list says `canonical-core/calendar/relationships.sql: no tables, keys or comments in it` and then `canonical-core/calendar/relationships.sql: skipped 11 ALTER TABLEs other than a key or a column change`.
- The same happens for the marketing, store and supplier `relationships.sql` files and both `masks.sql` files (`src/services/sqlDdlImport.ts:2008`, `:2032`).
- The filmed run stopped before this step.

### Gaps (unsupported)

**6. Templated `${…}` identifiers are not supported. The user is not told.**
- Deploy-time placeholders are common in Databricks Asset Bundle and notebook DDL. This project has 630 in its statements across 51 files, with 15 schema placeholders.
- No message mentions placeholders or how to fill them in.

**7. The failure is not written to the output log.**
- The `!result.ok` branch sends telemetry and shows the toast, and nothing else (`src/commands/importSqlDdl.ts:309-318`; `invalid()` at `:239-243`).
- The ERD Studio output channel for the whole take ends at "[Table Library] Background read of the Table Library finished: 0 file(s) in 0 slice(s), 1 ms after it started".
- The user does see the toast.

**8. Converter only: the 101 CHECK constraints are dropped. The user is told.**
- The CHECKs hold enums and ranges, such as `chk_account_status` in `customer/relationships.sql`. They are skipped as "ALTER TABLE other than a key or a column change" (`src/services/sqlDdlImport.ts:825`).
- The skip lines list them per file. The allowed values survive only because the column comments repeat them.
- The 58 `SET TAGS`, 16 `SET MASK` and 4 mask functions are also skipped and listed. That is reasonable for a logical model.

**Caution (not an importer bug):** if you fill `${order_schema}` as `order`, the run fails on `order/tables/customer_order_line.sql:18` with "CREATE TABLE order.customer_order_line could not be read: no viable alternative at input 'CREATE TABLE   order'". `ORDER` is a reserved word, which is why upstream's default is `orders`.

### What came through correctly

- The dialect was detected correctly: "Databricks / Spark SQL  detected" was listed first (`src/commands/importSqlDdl.ts:284-290`).
- A failed import wrote nothing: no `.erd-studio` folder and no half-written library or diagram. The sidebar still says "No diagrams yet."
- Converter only, placeholders filled: the conversion is exact.
  - 34 tables and 635 columns, in source order.
  - Types match the source: STRING 299, TIMESTAMP 88, BIGINT 78, DATE 67, DECIMAL 38 (all 11 sizes kept, for example `fx_rate.rate DECIMAL(18,8)`), BOOLEAN 33, INT 29, DOUBLE 3.
  - 34 single-column PKs (`pk, increment`, from `GENERATED ALWAYS AS IDENTITY`) and 149 NOT NULL.
  - 635 column comments and 34 table comments. That includes table comments placed after `USING DELTA` / `CLUSTER BY` / `TBLPROPERTIES`, and the 85 comments with a `;` inside the quotes.
  - All 43 FKs became many-to-one refs pointing the right way. 25 of them cross schemas.
  - No refs were made from the business-key joins that appear only in comments, including the self-reference `account.parent_account_id -> account.account_id` (`customer/relationships.sql:65`).

## What the import showed

There was no dry-run summary. The conversion failed before that step. Verbatim:

- Sidebar, before any import: "Example: a coffee-shop star schema · 6 tables, 8 relationships · not saved" / "Keep saves it as coffee-shop in the Main layer (.erd-studio/main/diagrams/coffee-shop.dbml)."
- Guide popover: "An example  1 of 3  Nothing here to draw from yet, so this is an example: 6 tables, 8 relationships. Nothing is saved yet."
- Import picker: "SQL DDL scripts / CREATE TABLE .sql files: PostgreSQL, MySQL, SQL Server, Snowflake or Databricks". No item was tagged "found in this folder".
- Dialect pick, placeholder "Which SQL dialect are the scripts written in?": "Databricks / Spark SQL  detected"; "PostgreSQL"; "MySQL / MariaDB"; "SQL Server / Azure SQL"; "Snowflake".
- Error notification (Source: ERD Studio, button "Try Another Dialect"): "Import SQL DDL: nothing was imported. No CREATE TABLE statements with a column list were found in the files. They were read as Databricks / Spark SQL."
- After Try Another Dialect → Snowflake: "Import SQL DDL: nothing was imported. No CREATE TABLE statements with a column list were found in the files. They were read as Snowflake."
- Output channel: no line about the import or its failure.

## Why the import failed

1. `tokenize()` in `src/services/sqlDdlImport.ts:395-396` reads `$` as the start of a dollar-quoted string only when the text matches `/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/`. `${catalog}` does not match, so `$`, `{` and `}` each become a punctuation token (`:445`).
2. `readName()` needs a word or a quoted identifier first (`isName`, `:666`; `:688-689`). It returns `undefined` for `${catalog}.${store_schema}.store`.
3. `readCreateTable` then skips each table as `ctas` (`:946`), and `readAlterTable` skips each FK statement as `alter` (`:1231-1232`).
4. With no tables read, `convertSqlDdl` returns the single `noCreateTable` problem with `file: ''` (`:2012-2016`).
5. `src/commands/importSqlDdl.ts:309-318` shows the toast with only **Try Another Dialect** and writes nothing.

What a user has to do today:

1. Copy the scripts and replace the placeholders before importing. For example, drop `${catalog}.` and replace each `${<domain>_schema}` with a plain schema name. Upstream's `databricks.yml` defaults work, and `${order_schema}` must become `orders`, not `order`.
2. Import the copy. The CHECK constraints, tags and masks will still be skipped and listed.

Nothing in the UI tells the user to do this. This review only reports the problem: no product code was changed.
