# Import analysis: Sakila (MySQL)

**Verdict: imported, with problems.** There were no errors, and the structure is right: 16 tables, 16 primary keys (2 composite) and 22 relationships. But several MySQL details were lost with no message, and a draft note says they were not lost. A procedure body was also read as DDL. Its effects cancel out in this file only by luck. The one-to-one store manager link is drawn as many-to-one.

## Tested with

- **Build:** ERD Studio 2.0, `feat/native-dbml-storage` at `d04c4167`. The real extension ran in VS Code with a fresh, isolated profile. The extension's own log reports version 1.7.2.
- **Source:** `sakila-schema.sql` (Sakila 1.5, byte for byte from the official download). See `SOURCE.md`.
- **Folder:** a logical-only folder with no `dbt_project.yml`.
- **Path:**
  1. Activity Bar > ERD Studio > Diagrams welcome view > "More ways to start…".
  2. Quick pick "Import…" > "SQL DDL scripts" (marked "found in this folder").
  3. File dialog: ticked `sakila-schema.sql` and pressed "Import".
  4. Dialect: picked "MySQL / MariaDB", which was listed first and marked "detected".
  5. No layer question came up. A new project defaults to the Main layer.
  6. Name: accepted the prefilled "sakila-schema".
  7. Draft preview: pressed "Skip guide", opened "Show details", then pressed "Keep as Diagram".
- The start-suggestion toast appeared, but the take did not use its "Show Me" button.
- **Video:** `import-review.mp4` in this folder, about 2 minutes, narrated.

## Source vs imported

| | Source | Imported |
|---|---|---|
| Tables | 16 | 16 |
| Columns | 90 | 89 (`address.location` missing) |
| Primary keys | 16 (2 composite) | 16 (2 composite) |
| Foreign keys → relationships | 22 | 22 (all saved optional, `>?`) |
| FK columns NOT NULL | 20 of 22 | 0 of 22 Refs required |
| FK ON DELETE / ON UPDATE actions | 22 | 0 |
| `UNSIGNED` on columns | 37 (38 in the file, one inside the procedure body) | 0 |
| `ON UPDATE CURRENT_TIMESTAMP` | 15 | 0 |
| Views / routines (not tables) | 7 / 9 | skipped; the log says 6 / 4 |
| Errors shown | – | none |

**How the source was counted:**
- Columns and FKs were counted per `CREATE TABLE` block. Key, constraint and index lines were excluded. `FOREIGN KEY` appears 22 times, all single-column.
- NOT NULL was checked per FK column. Only `film.original_language_id` (line 143) and `payment.rental_id` (line 273) are nullable.
- `UNSIGNED` was counted with grep: 38 in the file, minus 1 at line 513 inside `rewards_report`.
- `ON UPDATE CURRENT_TIMESTAMP` was counted with grep: 15. The analysis said 16, but `film_text` has no `last_update`, so the fixer's 15 is right.

**How the import was counted:**
- I re-ran `erd-studio inventory --json` on the imported project. It reports 16 tables, 89 columns and 16 tables with a key. The two composite keys are `film_actor (actor_id, film_id)` and `film_category (film_id, category_id)`.
- `relationships/main.dbml` has 22 `Ref` lines, all `>?`.
- `doctor` reports "✓ ERD Studio: 1 diagram, 16 tables — storage DBML" and "Ready".

These numbers match the video's final term card.

## Findings

Imported paths below are under `.erd-studio/main/`. Source lines are in `sakila-schema.sql`.

### Errors

None. No error, warning toast or refusal appeared at any step. The output log had no `[warning]` or `[error]` lines, and Problems showed 0 errors and 0 warnings.

### Bugs (silently lost or wrong)

**1. Procedure and trigger bodies are read as DDL.**
- The statement splitter does not understand `DELIMITER ;;`, `//` or `$$` (lines 213, 477, 544 and later). It splits routine bodies at every `;` (`splitStatements`, `src/services/sqlDdlImport.ts:464`).
- So `CREATE TEMPORARY TABLE tmpCustomer (customer_id SMALLINT UNSIGNED NOT NULL PRIMARY KEY);` inside `rewards_report` (line 513) is imported as a table.
- The procedure's own `DROP TABLE tmpCustomer;` (line 539) is then applied as a schema change that deletes it (`src/services/sqlDdlImport.ts:914`).
- That drop is what the draft note "1 later schema change was applied in file order (columns added, renamed, changed or dropped; tables renamed or dropped)." refers to. It is not a real schema change.
- The final count of 16 is right only by luck. On a copy with line 539 changed to `SELECT 1;`, the converter returns 17 tables, including a phantom `Table "tmpCustomer" { customer_id SMALLINT [pk] }`, and the note disappears.
- The start toast said "ERD Studio found CREATE TABLE scripts in this folder (17 tables)." `countCreateTablesWithColumns` (`src/services/sqlDdlImport.ts:527`) returns 17 for this file and 16 with the temp table removed, so `tmpCustomer` is the 17th.
- The skipped list says "4 functions, procedures or triggers". The file has 9: 3 triggers, 3 procedures and 3 functions. The body fragments are counted instead as "13 other statements", "2 data statements (INSERT, UPDATE…)" and "2 queries".

**2. `CREATE DEFINER=… VIEW` is not recognised as a view.** This only affects the counts.
- `CREATE DEFINER=CURRENT_USER SQL SECURITY INVOKER VIEW actor_info` (line 445) is counted under "other statements", so the log says "6 views" (the file has 7).
- The cause: `readCreate` skips leading words to find the object type, but stops at the `=` (`src/services/sqlDdlImport.ts:924`).
- With the `DEFINER=… SQL SECURITY INVOKER` words removed, the log says "7 views" and "other statements" drops from 13 to 12. This cause is separate from bug 1.

**3. `address.location` (GEOMETRY) is dropped with no message.**
- The column is declared only inside MySQL versioned comments: line 67, `/*!50705 location GEOMETRY */ /*!80003 SRID 0 */ /*!50705 NOT NULL,*/`. Its `SPATIAL KEY` (line 71) is in one too.
- The tokenizer strips every `/* … */` block, including `/*! … */` (`src/services/sqlDdlImport.ts:366-372`). The file still parses only because line 64 ends with its own comma.
- In `tables/main/address.dbml`, `phone` (line 8) is followed directly by `last_update` (line 9).
- The drawer says "address 8 columns · primary key address_id · 1 foreign key". No note mentions the loss.

**4. `UNSIGNED` is dropped from every integer column.**
- Examples: line 45 `actor_id SMALLINT UNSIGNED` became `tables/main/actor.dbml:2` `SMALLINT`. Line 80 `TINYINT UNSIGNED` became `category.dbml:2` `TINYINT`. Line 243 `MEDIUMINT UNSIGNED` became `inventory.dbml:2` `MEDIUMINT`.
- `UNSIGNED` appears nowhere under `.erd-studio`, not even in `meta_json`.

**5. `ON UPDATE CURRENT_TIMESTAMP` is dropped from all 15 `last_update` columns.**
- Line 48 `DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP` became `actor.dbml:5-6` `"default":"`CURRENT_TIMESTAMP`"` only.
- The auto-update behaviour is lost.

**6. The column-level charset and collation on `staff.password` are dropped.**
- Line 322 `password VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL` became `staff.dbml:11` `password "VARCHAR(40)" [meta_json: '{"dbml":{"default":"null"}}']`.
- No file under `.erd-studio` mentions utf8 or collation.

**7. All 22 FK actions are dropped.**
- Example: line 280 `ON DELETE SET NULL ON UPDATE CASCADE` became `relationships/main.dbml:38` `Ref: main.payment.rental_id >? main.rental.rental_id`.
- The SQL converter drops these on purpose (`src/services/sqlDdlImport.ts:41-42`), but the user is never told.

**8. Every relationship is saved as optional, and an SQL import gets no note about it.**
- All 22 Refs in `relationships/main.dbml:18-49` are written `>?`.
- Writing every Ref as `>?` is by design in a DBML project (D18, `docs/dev/dbml.md:86`). The bug is that the user is not told.
- A `.dbml` import shows "Every relationship is saved as optional…". For SQL that note is suppressed by `!options.origin` (`src/services/dbmlImport.ts:1445` and `:1574`).
- 20 of the 22 FK columns are NOT NULL, so the saved cardinality is wrong for 20 relationships. The not-null flags survive only in `meta_json`.

**9. The draft says details "are not lost". For this file that is false.**
- The draft's note: "Not null, defaults and other details ERD Studio has no field for are kept in the table files, so they are not lost." The text comes from `src/services/dbmlImport.ts:1547`.
- Bugs 3 to 8 are all losses. The only message the user sees about details says nothing was lost.

**10. The one-to-one store manager link is drawn as many-to-one.**
- `store.manager_staff_id` has `UNIQUE KEY idx_unique_manager` (line 341), is NOT NULL, and has an FK (line 343). So store → staff (manager) is one-to-one.
- The column keeps `"unique":true` (`store.dbml:3`). But the Ref is `Ref: main.store.manager_staff_id >? main.staff.staff_id` (`relationships/main.dbml:49`).
- The drawer says "many-to-one", and the canvas draws 1 at staff and * at store.

**11. Minor:**
- `DEFAULT NULL` is stored as `"default":"null"`, a string (for example `address.dbml:4`, `film.dbml:4`).
- In the film detail panel, the long `SET(…)` type squeezes the `special_features` column name out of view.

### Gaps (unsupported)

- **ENUM is saved as a bare type name with no `Enum` block. The user was not told.**
  - Line 148 `rating ENUM('G','PG','PG-13','R','NC-17') DEFAULT 'G'` became `film.dbml:12-14`: `rating film_rating_enum [meta_json: '{"dbml":{"default":"G","enum":["G","PG","PG-13","R","NC-17"]}}']`.
  - No `Enum film_rating_enum { … }` block is written anywhere under `.erd-studio`, although the converter's own DBML had one.
- **DBML-only settings are kept only in `meta_json`.** This is by design, but it is undercut by a misleading README line.
  - Not null, defaults, auto-increment, unique and the enum values all live inside ERD Studio's `meta_json` strings, not as native DBML settings. This is documented: D19, `docs/dev/dbml.md:77`, where hoisting them is a follow-up.
  - But the generated `.erd-studio/README.md` says "Other DBML tools read a diagram as a normal DBML project". Such a tool would see `film_rating_enum` as an undefined type, and no not-null, defaults or auto-increment on any column.
- **The schema `sakila` became `main`. The user was not told.**
  - Lines 37-38 `CREATE SCHEMA sakila; USE sakila;` were counted as skipped schema and session statements.
  - The tables were saved as `Table main.actor {` (`actor.dbml:1`), named after the default layer.
- **ENGINE and CHARSET table options are dropped. The user was not told.** These are physical details.
- **Non-unique indexes are not imported. The user was told.**
  - The source has 20 `KEY` lines plus the `FULLTEXT KEY` (line 204).
  - The drawer says "21 non-unique indexes inside tables (indexes are not imported)".

### What came through correctly

- **Tables:** all 16, with names unchanged, including `film_text` and the circular `store` ↔ `staff` foreign keys.
- **Primary keys:** all 16. AUTO_INCREMENT came in as `increment`.
- **Composite primary keys:** `film_actor` (line 167) and `film_category` (line 181) are intact as `(…) [pk]` in `film_actor.dbml` and `film_category.dbml`.
- **Relationships:** all 22 are correctly directed (`relationships/main.dbml:18-49`). This includes the forward references, the store ↔ staff pair, and both `film` → `language` FKs (lines 25-26).
- **Types as written:**
  - `YEAR`, `DECIMAL(4,2)`, `DECIMAL(5,2)`, `CHAR(20)`, `TEXT`, `BLOB`, `BOOLEAN`, `DATETIME`, `TIMESTAMP`.
  - `SET('Trailers','Commentaries','Deleted Scenes','Behind the Scenes')`, kept verbatim (`film.dbml:15`).
  - `INT`, `TINYINT`, `SMALLINT`, `MEDIUMINT` (without `UNSIGNED`).
- **Inside ERD Studio:**
  - Not-null flags, defaults (3, 4.99, 19.99, 'G', CURRENT_TIMESTAMP) and the unique keys are kept in `meta_json`.
  - The unique keys include `store.manager_staff_id` and the unnamed 3-column key on `rental` (line 299).
- **Skipped, not imported:** views, routines, `SET` / `USE` statements and indexes. None became a table, apart from the cancelled-out `tmpCustomer` (bug 1).
- **Identifiers:** mixed backtick-quoted and bare names caused no problems.
- **Dialect:** MySQL / MariaDB was auto-detected.

## What the import showed

- **Start toast:** "ERD Studio found CREATE TABLE scripts in this folder (17 tables). Show them as a diagram? Nothing is saved until you keep it."
- **Sidebar welcome view:** "No diagrams yet. This folder has CREATE TABLE scripts."
- **Dialect pick:** "MySQL / MariaDB" marked "detected".
- **Draft banner:** "Draft from 1 SQL file (MySQL / MariaDB) · 16 tables, 22 relationships · not saved" / "Keep saves it as sakila-schema in the Main layer (.erd-studio/main/diagrams/sakila-schema.dbml)." / "2 notes, 1 left out: Show details"
- **Draft guide 1 of 3:** "This is a draft of your model, drawn from 1 SQL file (MySQL / MariaDB): 16 tables, 22 relationships. Nothing is saved yet."
- **Details, Not imported (1):** "These stay in your own files only: the import writes none of them." "sakila-schema.sql: skipped 22 session statements (SET, USE…), 1 DROP statement, 1 schema or database statement, 21 non-unique indexes inside tables (indexes are not imported), 13 other statements, 4 functions, procedures or triggers, 2 data statements (INSERT, UPDATE…), 6 views, 2 queries"
- **Details, Notes (2):**
  - "1 later schema change was applied in file order (columns added, renamed, changed or dropped; tables renamed or dropped)."
  - "Not null, defaults and other details ERD Studio has no field for are kept in the table files, so they are not lost."
- **Output log:**
  - `[info] [ERD Studio] Import SQL DDL: sakila-schema.sql: skipped 22 session statements (SET, USE…), 1 DROP statement, 1 schema or database statement, 21 non-unique indexes inside tables (indexes are not imported), 13 other statements, 4 functions, procedures or triggers, 2 data statements (INSERT, UPDATE…), 6 views, 2 queries`
  - `[info] [ERD Studio] Import SQL DDL: 1 later schema change was applied in file order (columns added, renamed, changed or dropped; tables renamed or dropped).`
- **After Keep:**
  - Canvas footer: "16 tables | 22 relationships".
  - Problems: 0 errors, 0 warnings.
  - No toasts.

**Files written:**
- `.erd-studio/README.md`
- `layers.json` (one Main layer)
- `main/diagrams/sakila-schema.dbml`
- `main/relationships/main.dbml` (22 Refs)
- `main/tables/main/*.dbml` (16 files)

The import did not fail, so no recovery steps are needed.
