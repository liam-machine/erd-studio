# Import analysis: AdventureWorks OLTP (SQL Server)

**Verdict: import failed.** Six typed XML columns in 4 tables stop all 71 tables, and nothing is written. With those columns fixed by hand, all 71 tables and primary keys come in exactly, but only 46 of 90 relationships survive. All 530 descriptions and the 59 alternate keys are also lost, and the UI says nothing about it.

## Tested with

- **Build:** ERD Studio 2.0 (`feat/native-dbml-storage` at `d04c4167`), run in the real extension. The output channel reports the version as `ERD Studio 1.7.2`.
- **Source:** `instawdb.sql` in this folder, copied byte for byte from microsoft/sql-server-samples at commit `8fe3fd0c`, under the MIT licence. `SOURCE.md` has the hash and the expected counts.
- **Import path:**
  1. Activity Bar, then ERD Studio. The start screen said "No diagrams yet. This folder has CREATE TABLE scripts."
  2. **More ways to start…**, then **Import…**, then **SQL DDL scripts** (marked "found in this folder").
  3. The simple open dialog "Import SQL DDL", where I picked `instawdb.sql`.
  4. The dialect pick listed **SQL Server / Azure SQL** first and marked it "detected". I chose it.
  5. The import failed at this point. It never reached the layer step, the diagram-name step or the dry-run preview.
- **Other paths tried:**
  - **Open File** on the error toast.
  - The start screen's **Import your SQL scripts** button (the quick path).
  - PostgreSQL, picked by hand (filmed).
  - MySQL / MariaDB, Snowflake, Databricks / Spark SQL and the notification's **Show Me** (in rehearsal, not filmed).
- **Video:** `import-review.mp4` in this folder. It shows the filmed import, a source-vs-imported card and the closing "Import failed" card.

## Source vs imported

| | Source | Imported (filmed) | Workaround* |
|---|---|---|---|
| Tables | 71 | 0 | 71 |
| Columns | 486 | 0 | 486, in source order |
| Primary keys | 71 (23 composite) | 0 | 71 (23 composite) |
| Relationships (FKs) | 90 (1 composite) | 0 | 46 (composite lost) |
| Descriptions (table + column) | 69 + 461 = 530 | 0 | 0 |
| Alternate keys (unique indexes) | 59 (57 on tables, 2 on views) | 0 | 0 |
| Computed columns | 10 | 0 | 10, with the expression as the type |
| Alias-typed columns (UDTs) | 42 | 0 | 42, with the alias as the type |
| One-to-one links (FK = whole PK) | 6 | 0 | 6, as many-to-one |
| Typed `XML(schema)` columns | 6 in 4 tables | 0 | 6, as plain `XML` (stripped by hand) |

\* **Workaround (not filmed).** I made an in-memory copy of `instawdb.sql` with the six `([schema].[collection])` qualifiers removed, so `[XML](...)` became `[XML]`. Nothing else was changed. I ran it through the same build's converter (`sqlDdlToDbml` in `src/services/sqlImportEngine.ts`, dialect `sqlserver`).

**How I counted.**
- **Imported (filmed):** the demo folder has no `.erd-studio` after the import. `erd-studio inventory --json` on it returns `"code": "no-project"` with "No .erd-studio/ folder found in {path} (--project must be the folder that holds it)." The CLI redacts the path as `{path}`.
- **Source:** from `SOURCE.md`, plus my own re-count over `instawdb.sql`:
  - 71 `CREATE TABLE` and 90 `REFERENCES`.
  - 46 `ALTER TABLE … ADD` statements carry FKs, one per table. 28 of them list more than one FK, which adds 44 more FKs.
  - 59 `CREATE UNIQUE … INDEX`: 56 `AK_…` and `IX_Address_…` on tables, plus 2 on the views `vProductAndDescription` and `vStateProvinceCountryRegion`.
  - 538 `sp_addextendedproperty` calls, 6 `CREATE TYPE` and 434 `GO`.
- **Workaround:** I bundled the converter with esbuild to stdout and piped it into node, so no files were written. In the converted DBML I counted:
  - 71 `Table` blocks.
  - 486 column lines.
  - 71 tables with a PK, 23 of them through an `Indexes { (…) [pk] }` block.
  - 46 `Ref` lines, all `>`.
  - 0 notes.
  - 1 `unique`, on `Document.rowguid`.
  - 10 columns typed `"AS …"`.
- **Not re-run by me:** the rename of `[Database Version]` and the many-to-one cardinality come from `planDbmlImport` (`src/services/dbmlImport.ts`). The verifier and the fixer both ran it and agreed.
- **Built-in types:** 486 − 10 computed − 42 alias − 6 typed XML = 428 columns whose built-in type comes through exactly.

The analysis, the fix and the final storyboard agree on all of these numbers.

## Findings

### Errors

**Typed XML columns stop the whole import.**
- **Where:** four tables have a column typed `[XML]([schema].[collection])`. There are six such columns in all:
  - `instawdb.sql:1204` `HumanResources.JobCandidate.Resume`
  - `:1240` and `:1241` `Person.Person.AdditionalContactInfo` and `Demographics`
  - `:1371` and `:1372` `Production.ProductModel.CatalogDescription` and `Instructions`
  - `:1715` `Sales.Store.Demographics`
- **Error:** the SQL Server grammar stops with `mismatched input '(' expecting {'INDEX', ')', ','}`. Plain `xml` reads fine, for example `instawdb.sql:165` `[XmlEvent] [xml]` and `:1196` `[Diagram] [XML]`.
- **Code path:**
  - `src/services/sqlDdlImport.ts:971` calls the parser, and `:973-981` records the problem with the line of the failing column.
  - `src/services/sqlDdlImport.ts:2011` returns `{ ok: false }` if there is any problem, so 4 bad tables throw away the 67 that read.
  - `src/commands/importSqlDdl.ts:309-319` shows the toast.
- **What the user is told:** the toast is accurate but raw. It does not say that the schema-typed XML is the cause, and **Try Another Dialect** cannot help.
- **Other dialects:** PostgreSQL fails on all 71 tables at `'CREATE TABLE ['`. That is expected for T-SQL.

**Nothing was written.**
- No `.erd-studio` folder, model file, `.dbml` or diagram was created. The demo folder still holds only `instawdb.sql`, `SOURCE.md` and `UPSTREAM-LICENSE.txt`.

### Bugs (silently lost or wrong)

These were found with the workaround, and they would hit a user as soon as the XML error is fixed.

**Only the first FK in each `ALTER TABLE … ADD` list is kept (44 of 90 lost).**
- **Source:** `instawdb.sql:3530-3548` adds three FKs to `BillOfMaterials` in one statement. Only `ProductAssemblyID` is kept. `ComponentID` (`:3537`) and `UnitMeasureCode` (`:3543`) are lost.
- **Composite FK:** the only composite FK, `SalesOrderDetail(SpecialOfferID, ProductID) → SpecialOfferProduct` (`:3967`), is lost.
- **Converted DBML:** `Ref: "Production"."BillOfMaterials"."ProductAssemblyID" > "Production"."Product"."ProductID"` is the only BillOfMaterials Ref.
- **Cause:** `readAlterTable` (`src/services/sqlDdlImport.ts:1227`) splits the list on commas but reads only an item that starts with `ADD` (`:1251`). The second and later items start with `CONSTRAINT`, so they fall into `unhandled = true` (`:1346-1348`) and the statement is counted as skipped (`:1352`).
- **What the user is told:** nothing in the UI. The log says `28 ALTER TABLEs other than a key or a column change` (label at `:825`). That label is wrong, because each of those 28 statements adds foreign keys.

**All 530 descriptions are lost.**
- **Source:** the `MS_Description` calls name their objects with bracketed identifiers, not strings. For example, `instawdb.sql:5955`: `… N'SCHEMA', [Person], N'TABLE', [Address], NULL, NULL;`.
- **Cause:** `readExec` (`src/services/sqlDdlImport.ts:1544`) stores an argument only if it is a string token (`:1558`). The level names are therefore empty, and each call is skipped as a comment (`:1564`).
- **What the user is told:** nothing in the UI. The log counts them inside `538 comments on something other than a table or column`, which is the 530 descriptions plus the database, 5 schemas, 1 trigger and the filegroup.

**Computed columns get their expression as the data type (10 columns).**
- `instawdb.sql:1485` becomes `"TotalDue" "AS ISNULL([SubTotal] + [TaxAmt] + [Freight], 0) PERSISTED" [not null]`. `PERSISTED` ends up inside the type.
- `:1536` becomes `"TotalDue" "AS ISNULL([SubTotal] + [TaxAmt] + [Freight], 0)"`.
- Nothing marks these columns as computed.

### Gaps (unsupported)

**Alias UDTs are not resolved (42 columns).**
- `CREATE TYPE [Name] FROM nvarchar(50) NULL;` (`instawdb.sql:331-336`) is skipped.
- `[FirstName] [Name] NOT NULL` becomes `"FirstName" Name [not null]`, so the base type is lost. The counts are `Name` 28, `Flag` 9, `AccountNumber` 2, and `NameStyle`, `Phone` and `OrderNumber` 1 each.
- **Told?** Only in the log, as `6 types other than enums`. It does not say that 42 columns use them.

**One-to-one links come in as many-to-one (6 relationships).**
- These are Person, Store and Vendor → BusinessEntity, Employee and Password → Person, and SalesPerson → Employee. Example: `instawdb.sql:3662` (Employee).
- The converter writes every FK as `>` (`src/services/sqlDdlImport.ts:40`), so the planner gives each one `cardinality: many-to-one`.
- **Told?** No.

**Unique indexes are skipped, so alternate keys are lost (59).**
- Example: `AK_Product_Name` at `instawdb.sql:3331`. Indexes are skipped at `src/services/sqlDdlImport.ts:930`.
- The only uniqueness that survives is the inline `UNIQUE` on `Production.Document.rowguid` (`:1132`).
- **Told?** Only in the log, as part of `106 indexes`.

**Small physical details are dropped.**
- The IDENTITY seed: `IDENTITY (100000, 1)` at `instawdb.sql:1722` becomes a plain increment.
- `ROWGUIDCOL`, `NONCLUSTERED`, and the 2 `ON DELETE CASCADE` actions. The cascade actions are dropped by design (`src/services/sqlDdlImport.ts:40-42`).
- **Told?** No.

**Views, routines and other objects are skipped.**
- The converter's skipped line counts them: 20 views and 54 functions, procedures or triggers, among others.
- **Told?** This line is only shown in the log and the dry-run preview, and the failed import never reached either. The user saw none of it.

### Smaller UI issues seen in the failed run

**The quick path falls back without a word.**
- **Import your SQL scripts** and **Show Me** try every dialect, find none that reads the whole file, and open the step-by-step dialect pick. There is no message, and that pick again marks SQL Server as "detected", which is the dialect that just failed.
- Code: `src/commands/importSqlDdl.ts:427-452`. The fallback is at `:445-452`.

**Most problems are hidden.**
- The toast lists only 3 problems ("And 1 more problem", "And 68 more problems"). `PROBLEMS_SHOWN = 3` is at `src/services/importSources.ts:297`, and the message is built at `:305-316`.
- The failed import writes nothing to the output channel. `invalid()` (`src/commands/importSqlDdl.ts:239-243`) sends only telemetry.
- In the recording, the toast was gone after **Open File** was clicked.

**Raw escapes in some messages.**
- The MySQL and Databricks messages show literal `\r\n` escapes.
- Their line 158/224/972, against 157/223/971 for PostgreSQL and Snowflake, is not an off-by-one. Each parser reports the line where it stopped: `IDENTITY` or `[` on the column line.

### What came through correctly

- **Dialect detection:** SQL Server / Azure SQL is detected and offered first.
- **Error lines:** every error line points at the failing column, even with the UTF-8 BOM (stripped at `src/services/sqlDdlImport.ts:882`) and CRLF line endings. **Open File** lands on `instawdb.sql:1204`.
- **Script noise:** SQLCMD `:setvar`, 434 `GO` batches, `IF/BEGIN/RAISERROR`, dynamic SQL and `BULK INSERT` cause no errors.
- **Once the XML qualifiers are removed:**
  - All 71 tables come in, in the right schemas (Production 25, Sales 19, Person 13, HumanResources 6, Purchasing 5, dbo 3), with 486 columns in source order.
  - All 71 PKs are exact, including the 70 added by later `ALTER TABLE` and the 23 composite ones. `DatabaseLog` gets its later nonclustered PK as `"DatabaseLogID" int [pk, increment]`.
  - Nullability, defaults, named CHECKs and IDENTITY flags are kept.
  - 428 columns keep their built-in type exactly, for example `nvarchar(25)`, `decimal(8,2)`, `varbinary(MAX)`, `hierarchyid` (also as a PK), `geography`, `sysname` and `smallmoney`.
- **Column with a space:** `dbo.AWBuildVersion.[Database Version]` (`instawdb.sql:994`) is renamed `Database_Version`. The plan reports the rename (`report.renamed`, reason `invalid-name`) and keeps the original in `meta.dbml.name`. This is reported, so it is not a bug.

## What the import showed

- **Startup notification:** "ERD Studio found CREATE TABLE scripts in this folder. Show them as a diagram? Nothing is saved until you keep it." (buttons Show Me / Don't Ask Again for This Folder)
- **Sidebar:** "No diagrams yet. This folder has CREATE TABLE scripts." [Import your SQL scripts] "Or: More ways to start…"
- **Dialect pick:** "Which SQL dialect is the script written in?" with the options "SQL Server / Azure SQL  detected", PostgreSQL, MySQL / MariaDB, Snowflake, Databricks / Spark SQL.
- **Error after SQL Server / Azure SQL** (buttons Open File / Try Another Dialect): "Import SQL DDL: nothing was imported. instawdb.sql line 1204: CREATE TABLE HumanResources.JobCandidate could not be read: mismatched input '(' expecting {'INDEX', ')', ','}. instawdb.sql line 1240: CREATE TABLE Person.Person could not be read: mismatched input '(' expecting {'INDEX', ')', ','}. instawdb.sql line 1371: CREATE TABLE Production.ProductModel could not be read: mismatched input '(' expecting {'INDEX', ')', ','}. And 1 more problem. They were read as SQL Server / Azure SQL." The hidden fourth problem is line 1715, `Sales.Store`.
- **Error after PostgreSQL:** "Import SQL DDL: nothing was imported. instawdb.sql line 157: CREATE TABLE dbo.DatabaseLog could not be read: no viable alternative at input 'CREATE TABLE ['. instawdb.sql line 223: CREATE TABLE dbo.ErrorLog could not be read: no viable alternative at input 'CREATE TABLE ['. instawdb.sql line 971: CREATE TABLE Person.Address could not be read: no viable alternative at input 'CREATE TABLE ['. And 68 more problems. They were read as PostgreSQL."
- **MySQL, Snowflake and Databricks** (rehearsal): the same "And 68 more problems". MySQL and Databricks quote the input with literal `\r\n`.
- **Quick path:** no message. It goes straight to the dialect pick.
- **Output channel:** only activation lines, ending with "[info] [Table Library] Background read of the Table Library finished: 0 file(s) in 0 slice(s)". Nothing from the import.
- **Problems panel:** 0 errors, 0 warnings.
- **Dry-run summary:** none, because the import never reached it. With the workaround, the converter's skipped line is: "instawdb.sql: skipped 543 other statements, 229 session statements (SET, USE…), 9 queries, 54 functions, procedures or triggers, 13 schema or database statements, 23 data statements (INSERT, UPDATE…), 6 types other than enums, 106 indexes, 28 ALTER TABLEs other than a key or a column change, 20 views, 538 comments on something other than a table or column".

## Why it failed and what a user has to do

**Why.** The SQL Server grammar in `@dbml/core` cannot parse an XML type with a schema-collection argument. ERD Studio sends each `CREATE TABLE` to that parser (`src/services/sqlDdlImport.ts:971`) and records each failure as a problem (`:973-981`). The converter then refuses the whole file if there is any problem (`:2011`). The command shows the first 3 problems in a toast and stops (`src/commands/importSqlDdl.ts:309-319`). There is no way to import the 67 tables that did read.

**What a user has to do:**
1. Make a copy of `instawdb.sql`.
2. Change the six `[XML]([schema].[Collection])` types to `[XML]` at lines 1204, 1240, 1241, 1371, 1372 and 1715.
3. Import the copy.

Nothing else in the file blocks the import. Even then, the user still has to add these by hand:
- 44 relationships, including the composite one.
- 530 descriptions.
- 59 alternate keys.
- The base types of 42 alias-typed columns.
- Proper types for 10 computed columns.
- One-to-one cardinality on 6 links.
