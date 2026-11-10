# Import analysis: Pagila (PostgreSQL)

**Verdict: failed.** One PostgreSQL 18 `VIRTUAL` column on line 453 blocked all 71 tables, and no dialect reads the file as it is.

## Tested with

- ERD Studio 2.0 (`feat/native-dbml-storage` at `d04c4167`), frozen build, in an isolated VS Code.
- Source: `pagila-schema.sql` from devrimgunduz/pagila at `6ea53f81` (pg_dump, 3035 lines). See `SOURCE.md`.
- Import path:
  1. On launch a toast offered to diagram the scripts. It was closed with its X; Show Me was not clicked.
  2. ERD Studio sidebar, Diagrams view, start screen, `More ways to start…`, then `Import…`, then `SQL DDL scripts` (marked "found in this folder").
  3. In the "Import SQL DDL" file dialog, `pagila-schema.sql` was ticked and Import pressed.
  4. The dialect picker listed PostgreSQL first, marked "detected", and it was picked. An error followed. No layer or name prompt and no dry run was reached.
  5. The toast's `Try Another Dialect` was clicked, then `Databricks / Spark SQL`. It failed on the same line.
  6. `Open File` was clicked.
  7. Last, the start screen's one-click `Import your SQL scripts` button was tried. It reopened the dialect picker, which was dismissed with Escape.
- Video: `import-review.mp4` in this folder.

## Source vs imported

| | Source | Imported | After `VIRTUAL` → `STORED` (offline) |
|---|---|---|---|
| Tables | 71 (16 base + 55 `payment` partitions) | 0 | 71 |
| Columns | 479 (94 base + 55 × 7) | 0 | 479 |
| Primary keys | 16 (3 composite) | 0 | 16 (3 composite) |
| Relationships (FKs) | 37 (19 base + 18 on partitions) | 0 | 37 (all many-to-one) |
| `timestamptz` columns | 73 | 0 | 0 (all 73 became `timestamp`) |
| Unique indexes on tables | 5 | 0 | 0 |
| Files written | | none | |

How these numbers were counted:

- **Source.** Counts are from `SOURCE.md`. The PKs are 15 `ALTER TABLE ONLY … PRIMARY KEY` plus the inline key on `payment`. The `CREATE TEMPORARY TABLE` inside the `rewards_report` function body was left out. Views (7) and the materialized view are not counted as tables.
- **Imported.** The demo copy holds only `pagila-schema.sql`, `SOURCE.md` and `UPSTREAM-LICENSE.txt`. `node dist/cli.js inventory --json --project <demo>` returns `"code": "no-project"` ("No .erd-studio/ folder found").
- **Offline column.** I re-ran the frozen build's converter (`dist/sqlImport.js`, `sqlDdlToDbml`, dialect `postgres`) on a copy of the file with the one word changed. The sample itself is unchanged.
  - The result gave `tableCount 71` and `refCount 37`.
  - Counting column lines per `Table` block gives 479.
  - PKs are 13 inline `[pk]` plus 3 composite `Indexes { (…) [pk] }` blocks, so 16.
  - There are 73 `timestamp` columns.
- **Timestamp count.** The source has 79 matches of `timestamp with time zone`. Six are in function signatures (`get_customer_balance`, `last_day`), not columns. The remaining 73 are 18 base-table columns plus 55 `payment_pNNNN.payment_date`. The video's term card uses 73, and that is confirmed.
- **Unique indexes.** The source has 6 `CREATE UNIQUE INDEX` statements (lines 2536, 2543, 2592, 2599, 2606, 2613). The one at 2592 is on the materialized view `rental_by_category`, so 5 are on tables.

## Errors

**1. The import fails on `film.length_hours VIRTUAL`, and nothing is written.**
- Source: `pagila-schema.sql:453`:
  ```sql
  length_hours numeric(4,2) GENERATED ALWAYS AS (round(length / 60.0, 2)) VIRTUAL
  ```
- UI: "Import SQL DDL: nothing was imported. pagila-schema.sql line 453: CREATE TABLE public.film could not be read: mismatched input 'VIRTUAL' expecting 'STORED'. They were read as PostgreSQL."
- PostgreSQL was detected correctly. `@dbml/core` 11.0.0's PostgreSQL grammar only accepts `STORED` after `GENERATED ALWAYS AS (…)`.

**2. `Try Another Dialect` cannot help, because no dialect reads the file.** Re-run offline against the frozen build:

| Dialect | First problem | Tables failing |
|---|---|---|
| PostgreSQL (detected) | line 453: `CREATE TABLE public.film could not be read: mismatched input 'VIRTUAL' expecting 'STORED'` | 1 |
| Databricks / Spark SQL | line 453: `CREATE TABLE public.film could not be read: extraneous input 'VIRTUAL' expecting ')'` (filmed) | 1 |
| MySQL / MariaDB | line 273: `CREATE TABLE public.customer could not be read: no viable alternative at input '… DEFAULT nextval'` | 71 |
| Snowflake | line 273: same message as MySQL | 71 |
| SQL Server / Azure SQL | line 272: `CREATE TABLE public.customer could not be read: the SQL parser could not read this statement` | 71 |

The fixer's draft said SQL Server first fails at line 273. The re-run reports line 272, the `CREATE TABLE public.customer` line itself, because this message carries no inner line number. The table above is corrected.

## Bugs (silently lost or wrong)

None of these were reached in the filmed import, which failed first. They come from the offline run with `VIRTUAL` changed to `STORED`. In every case the result has `notes: []` and the skipped summary does not mention the loss.

1. **`timestamp with time zone` becomes `timestamp` on 73 columns.** The time zone is lost on every `last_update`, on `rental_date` and `return_date`, and on 55 `payment_date` columns. Source `:281`, `:772`. Converted DBML `"last_update" timestamp [default: now()]`, `"payment_date" timestamp [not null]`. The type name comes from the grammar's `type_name` (`src/services/sqlDdlImport.ts:1041-1042`).
2. **`public.vector(20)` becomes `public.vector`.** The dimension is lost. Source `:505`. Converted DBML `"embedding" public.vector [not null]`.
3. **The one-to-one `film_embedding` comes in as many-to-one.** `film_embedding.film_id` is the whole PK (`:2299`) and the FK to `film` (`:2797`). The converter writes every Ref as `>` (`src/services/sqlDdlImport.ts:40`), giving `Ref: "public"."film_embedding"."film_id" > "public"."film"."film_id"`.
4. **The 5 unique indexes on tables are dropped:**
   - `store.manager_staff_id`
   - the `rental (rental_date, inventory_id, customer_id)` natural key
   - `customer.uuid`
   - `rental.uuid`
   - `payment (uuid, payment_date)`

   pg_dump writes uniqueness as `CREATE UNIQUE INDEX`, and every `CREATE … INDEX` is skipped (`src/services/sqlDdlImport.ts:930`). The converter's own header says only "plain (non-unique) indexes" are left out and "unique constraints … are kept" (`src/services/sqlDdlImport.ts:42-44`). The summary only says "38 indexes".
5. **The generated expression is dropped.** `film.length_hours` comes in as a plain `numeric(4,2)`, and nothing marks it as computed. Source `:453`. Converted DBML `"length_hours" numeric(4,2)`.
6. **The domain's base type and CHECK are dropped.** `film.release_year` keeps the bare type name `public.year`, but the domain's `integer` base type and `CHECK (VALUE >= 1901 AND VALUE <= 2155)` are lost. Source `:442`, `:56-57`. Converted DBML `"release_year" public.year`. `CREATE DOMAIN` is counted as one of the "18 other statements" (`src/services/sqlDdlImport.ts:934`).

## Gaps (unsupported)

1. **PostgreSQL 18 `VIRTUAL` generated columns are not supported.** The user was told, exactly: the file, line, table and parser message.
2. **The import is all or nothing.** Any problem makes `convertSqlDdl` return `ok: false` (`src/services/sqlDdlImport.ts:2011`), so one column blocks 70 good tables. The user is told "nothing was imported" but gets no option to skip `film` and import the rest.
3. **The one-click import falls back without a reason.** `Import your SQL scripts` runs `quickImportSqlDdl`, which tries every dialect (`src/commands/importSqlDdl.ts:434-443`). When none reads the file, it calls `importSqlDdl(deps, gathered)` (`:451`), which just shows the dialect picker again. The user was not told why. The reason appears only after they pick a dialect.
4. **The failure is not logged.** The `invalid` handler only records telemetry (`src/commands/importSqlDdl.ts:239-243`), so the parse problem appears in the toast and nowhere in the ERD Studio output channel. The user was told by the toast only.
5. **Partitions come in as separate tables (offline).** The 55 `payment_pNNNN` partitions become 55 extra tables. The 18 partition FKs attach to `payment_p2022_01..06`, and the `payment` parent (`:766-776`, `PARTITION BY RANGE`) has no relationships. The user is told only through a count: the `ATTACH PARTITION` statements (`:1897` onward) fall under "147 ALTER TABLEs other than a key or a column change".
6. **Hand-editing line 453 is fiddly (offline).**
   - Changing `VIRTUAL` to `STORED` reads everything (71 tables, 37 refs).
   - Deleting only the word `VIRTUAL` fails: "missing 'STORED' at ')'".
   - Deleting the whole line leaves a trailing comma on line 452 and fails with a very long expected-token list.
   - Deleting the line together with its preceding comma works (71 tables, 37 refs).
7. **Version string (minor).** The output channel says "ERD Studio 1.7.2 activating", and `inventory` reports `"cliVersion": "1.7.2"`. That is the unbumped root `package.json` version on this branch build, not a real version.

## What came through correctly

- **Detection.** The launch toast and the start screen both found the CREATE TABLE script. Import marked `SQL DDL scripts` "found in this folder", and PostgreSQL was listed first and marked "detected".
- **Error quality.** The error names the file, line 453, `public.film` and the parser's expectation, and says plainly that nothing was imported. `Open File` jumps to `pagila-schema.sql` Ln 453, Col 1.
- **Clean failure.** No `.erd-studio` folder and no partial files were written.
- **Offline, after the one-word edit:**
  - 71 tables, 479 columns, 16 PKs and 37 relationships, all pointing from FK to PK.
  - The three composite keys are whole and in order: `film_actor (actor_id, film_id)` `:2283`, `film_category (film_id, category_id)` `:2291`, `payment (payment_date, payment_id)` `:774`.
  - Both `film` → `language` FKs are present (`language_id`, `original_language_id`).
  - No relationship was invented for `store.manager_staff_id`.
  - The `mpaa_rating` enum keeps its 5 values (`:41`), and `film.rating` keeps its default.
  - These types read correctly: `integer`, `smallint`, `numeric(p,s)`, `text`, `boolean`, `date`, `uuid`, `text[]`, `tsvector`, `bytea`.
  - `NOT NULL` and defaults are kept (`nextval(...)`, `now()`, `uuidv7()`, numeric literals). The analyst's planner run reported `keptInMeta 464`; I did not re-check that figure.
  - Views, indexes, routines, sequences and grants are skipped and counted.
  - No descriptions were invented. The source has no table or column comments.

## What the import showed

Verbatim, in order:

1. Launch toast: "ERD Studio found CREATE TABLE scripts in this folder. Show them as a diagram? Nothing is saved until you keep it." [Show Me] [Don't Ask Again for This Folder]
2. Start screen: "No diagrams yet. This folder has CREATE TABLE scripts." [Import your SQL scripts] "Or: More ways to start…"
3. Dialect picker: "Which SQL dialect is the script written in?" listing "PostgreSQL" (detected), "MySQL / MariaDB", "SQL Server / Azure SQL", "Snowflake", "Databricks / Spark SQL".
4. After PostgreSQL: "Import SQL DDL: nothing was imported. pagila-schema.sql line 453: CREATE TABLE public.film could not be read: mismatched input 'VIRTUAL' expecting 'STORED'. They were read as PostgreSQL." [Open File] [Try Another Dialect]
5. After Databricks / Spark SQL: "Import SQL DDL: nothing was imported. pagila-schema.sql line 453: CREATE TABLE public.film could not be read: extraneous input 'VIRTUAL' expecting ')'. They were read as Databricks / Spark SQL." [Open File] [Try Another Dialect]
6. Open File: `pagila-schema.sql` at Ln 453, Col 1: `length_hours numeric(4,2) GENERATED ALWAYS AS (round(length / 60.0, 2)) VIRTUAL`
7. One-click `Import your SQL scripts`: no message. It went straight to the same dialect picker.
8. Problems panel: 0 errors, 0 warnings. The output channel has no entry for the failed import.

No dry-run summary was reached. Offline, after the edit, the skipped summary would read: "pagila-schema.sql: skipped 11 session statements (SET, USE…), 1 query, 18 other statements, 25 functions, procedures or triggers, 13 sequences, 147 ALTER TABLEs other than a key or a column change, 1 comment on something other than a table or column, 8 views, 38 indexes, 2 permission statements (GRANT, REVOKE)".

## Why it failed

1. `importSqlDdl` calls `engine.sqlDdlToDbml({ files, dialect })` (`src/commands/importSqlDdl.ts:305`).
2. For PostgreSQL the engine is `Parser.parsePostgresToJSONv2` from `@dbml/core` 11.0.0 (`src/services/sqlImportEngine.ts:37`).
3. The converter sends each `CREATE TABLE` to it (`src/services/sqlDdlImport.ts:971`). The grammar throws on `VIRTUAL`, and the converter records a parse problem: "CREATE TABLE public.film could not be read: …" (`:973-978`).
4. Any problem makes `convertSqlDdl` return `ok: false` (`:2011`), so no table survives.
5. `importSqlDdl` then shows the error with `Open File` and `Try Another Dialect` (`src/commands/importSqlDdl.ts:309-318`) and writes nothing.
6. The one-click path tries every dialect in rank order. None succeeds, so it calls `importSqlDdl(deps, gathered)` without a message (`src/commands/importSqlDdl.ts:434-451`).

What a user would have to do:
1. Edit line 453 of `pagila-schema.sql` and change `VIRTUAL` to `STORED`. For a diagram the two mean the same thing.
2. Run the import again and pick PostgreSQL. It then reads 71 tables and 37 relationships.
3. Expect the silent losses listed under Bugs. Also expect the 55 partitions as separate tables. To avoid that, delete their `CREATE TABLE` blocks first.

Deleting the line also works if its preceding comma on line 452 goes with it.
