# Import analysis: AdventureWorks tabular model (Analysis Services / Power BI model.bim)

**Verdict: Imported, with gaps (minor gaps).** All 9 tables, 174 columns (10 calculated, flagged) and 13 relationships came through with 0 errors. There is one key bug: Date's key is on `date`, but all 6 Date relationships join `date_key`. Measures are reported as left out. Hierarchies, the role, the date-table marking and some other model settings are dropped with no message.

## Tested with

- ERD Studio 2.0 (`feat/native-dbml-storage` at `d04c4167`), as a frozen extension build. The build logs itself as "ERD Studio 1.7.2". It ran in an isolated VS Code 1.145.2 profile on a folder with no `.erd-studio`.
- Import path: Activity Bar > ERD Studio > "Or: More ways to start…" > **Import…** > **Power BI or Fabric semantic model**. The picker listed it first, marked "found in this folder".
- Choices:
  - In the folder dialog, I accepted the project root. The `.bim` sits one level down, in `AsPartitionProcessing.AdventureWorks/`, and was found.
  - No layer question was asked, so the diagram went to Main.
  - The suggested name was `semantic-model`. I replaced it with `adventure-works`.
  - The import opened a read-only Draft. I opened "Show details", then pressed **Keep as Diagram**.
- No dialect question applies to this source.
- Video: `test/fixtures/real-world-imports/powerbi-bim-adventureworks/import-review.mp4` (123 s, no music). Source facts are in `SOURCE.md` in the same folder.

## Source vs imported

| | `Model.bim` | ERD Studio | Note |
|---|---|---|---|
| Tables | 9 | 9 | all kept |
| Columns | 174 | 174 | 25+15+37+9+27+27+3+4+27 |
| Calculated columns (flagged) | 10 | 10 | each has `power_bi_calculated: 'true'` and a note |
| Data types matching the map | 174 | 174 | 0 mismatches |
| Tables with a key | 7 | 7 | Date's key is on the wrong column (Bug 1) |
| Foreign-key flags | 13 | 13 | `foreign_key: 'true'` on the many side |
| Relationships (4 inactive) | 13 | 13 Refs | the 4 inactive Refs are named `"inactive in Power BI"` |
| Measures (DAX) | 21 | 0 | left out, and reported |
| Hierarchies | 4 | 0 | dropped, not reported |
| Errors / warnings shown | – | 0 / 0 | status bar and Problems both 0 / 0 |

How I counted:
- **Source:** a Python script loaded `Model.bim` and walked `model.tables[].columns`, `measures` and `hierarchies`, plus `model.relationships`. It gave 9 tables, 174 columns, 10 with `type: calculated`, 21 measures, 4 hierarchies and 13 relationships, 4 of them `isActive: false`.
- **Source keys:** only `Date[Date]` has `isKey`. "7" counts the tables that are the one side of a relationship (the six dimensions plus Date), which is the same as the tables with a key column.
- **Output:** `node dist/cli.js inventory --json` on the demo project gave 9 `logicalTables`, a `columnCount` sum of 174, and 7 tables with a non-empty `primaryKey`. The fact tables have none.
- **Output relationships and flags:** the CLI's `relationships` array is for dbt and is empty here. So I counted the 13 `Ref` lines (4 named) in `.erd-studio/main/relationships/main.dbml` by hand. Grep found 13 `foreign_key: 'true'` and 10 `power_bi_calculated` lines in `tables/main/*.dbml`.
- **Health check:** `doctor --no-dbt` reported "✓ ERD Studio: 1 diagram, 9 tables — storage DBML".
- **Agreement:** these numbers match the final video's term cards and closing card. The analysis and the fix agree on every count.

## Findings

### Errors

None. No error toast appeared. The status bar showed 0 errors and 0 warnings. Every import line in the output channel is informational.

### Bugs (silently lost or wrong)

**1. Date's primary key is on `date`, but all 6 Date relationships join `date_key`, and nothing says so.**
- **Source:** `Date[Date]` is the only `isKey` column (`Model.bim:649`). Date is marked as a date table (`Model.bim:638-639`, `showAsVariationsOnly`, `dataCategory: Time`). All 6 relationships into Date use `toColumn: DateKey` (`Model.bim:1575-1670`).
- **Output:** `.erd-studio/main/tables/main/date.dbml:2-3`:
  ```
  date_key                 bigint    [power_bi_name: 'DateKey']
  date                     timestamp [pk, power_bi_name: 'Date']
  ```
  `.erd-studio/main/relationships/main.dbml:15-17` and `:24-26` all end in `main.date.date_key`, a column that is neither a key nor unique.
- **Cause:** keys start from `isKey` columns (`src/services/semanticModelImport.ts:1015`). Key inference skips any table that already has one: `if (table.pk.size > 0 || columns.size !== 1) continue;` (`:1096`). The mapping table at `:30` describes the same rule.
- **Silent:** the drawer and the log carry six "… is marked as the primary key, because relationships point at it." notes (`:1099`), one for each dimension. They say nothing about Date. The drawer only says "date 15 columns · primary key date".

**2. The suggested name and the Project Note say "SemanticModel", not the folder name.**
- The import picker and the draft banner use the folder name: "Draft from the semantic model AsPartitionProcessing.AdventureWorks".
- The name prompt suggested `semantic-model`.
- `.erd-studio/main/diagrams/adventure-works.dbml:13` reads `Note: 'Converted from the Power BI semantic model SemanticModel.'`
- **Cause:** the name is `modelNameFromPath(file.path) ?? str(database.name) ?? …` (`src/services/semanticModelImport.ts:424`). `modelNameFromPath` (`:297`) only reads a `<Name>.SemanticModel` or `<Name>.Dataset` folder, so the TMSL database name `"SemanticModel"` (`Model.bim:2`) wins. The Visual Studio tools write that name by default. The Note is written at `:1110`.
- This is a small slip. The user can type over the suggested name, but the Note keeps the generic name.

### Gaps (unsupported)

**3. 21 DAX measures are left out. The user is told.**
- **Source:** 18 measures in Internet Sales, 2 in Date and 1 in Reseller Sales. Two of them carry KPIs (`Model.bim:310`, `:430`). `YTD InternetTotalSales` is at `Model.bim:476`.
- **Drawer:** "Not imported (1) — These stay in your own files only: the import writes none of them. — 21 measures: DAX calculations, not columns".
- **Log:** the output channel names every measure, table by table (`src/services/semanticModelImport.ts:1013`). This is by design.

**4. The DAX of the 10 calculated columns is not kept. Each column says so.**
- The columns are imported with their type, `power_bi_calculated: 'true'` and the note "Calculated column in Power BI; its DAX was not imported."
- For example, `Margin` (`Model.bim:176`) becomes `.erd-studio/main/tables/main/internet_sales.dbml:28-32`.
- `Level2`, whose expression is a JSON array of lines (`Model.bim:1492`), imports cleanly as `employee.dbml:49`.
- The user is told on every such column, in the file and as a ⓘ in the details panel.

**5. Model features dropped with no message. The user is not told.**
The TMSL reader only reads each table's columns (name, `dataType`, `isKey`, `isHidden`, `type`, `description`, `sourceColumn`; `src/services/semanticModelImport.ts:366-379`), its measures and partitions, and `model.relationships` (`:401`). None of the items below shows in the drawer, the log or the files:
- **4 hierarchies:** Date `Calendar` and `Fiscal` (`Model.bim:750`, `:770`), Product `Category` (`:953`) and Employee `Organization` (`:1543`).
- **The date-table marking:** Date's `dataCategory: Time` and `showAsVariationsOnly` (`Model.bim:638-639`). This marking is why `Date[Date]` has `isKey`, and dropping it is what hides Bug 1.
- **`sortByColumn`:** EnglishMonthName sorts by MonthNumberOfYear (`Model.bim:681`).
- **The "Calendar Reuse" variation** on `Internet Sales[OrderDate]` (`Model.bim:151-153`).
- **The "General Users" role** (`Model.bim:2027`):
  - Its row filter `Geography[CountryCode]="US"` (`:2052`) is dropped.
  - Its column permission hiding `Customer[Phone]` (`:2056`) is dropped. `customer.dbml:24` keeps `phone` with no hint that a role hides it.
- **The `Internet Sales` perspective** (`Model.bim:1672`).
- **The `AdventureWorks` data source** (`Model.bim:6`).

The comment at `src/services/semanticModelImport.ts:21-22` lists hierarchies, perspectives and roles as "skipped over", but it describes the TMDL reader, and it is a code comment, not a message to the user. None of these features has a natural place in an ERD. The gap is only that the user is not told.

**6. The details panel does not show the inactive flag.** The canvas edge labels and the Ref names in `main.dbml` say "inactive in Power BI". The details panel's relationship list does not. The user is told, but only on the canvas and in the file.

### What came through correctly

- **Tables and columns:** all 9 tables and 174 columns. Names with spaces and all column names became snake_case, and each keeps its original name in `power_bi_name`. For example, `Model.bim` "Internet Sales" becomes `internet_sales.dbml:1` `Table main.internet_sales [power_bi_name: 'Internet Sales']`. The drawer says "9 table names and 174 column names written in snake_case; the original Power BI names are kept in the table files."
- **Types:** all 174 follow the type map: `int64`→`bigint`, `string`→`varchar`, `decimal`→`decimal`, `double`→`double`, `dateTime`→`timestamp`, `boolean`→`boolean`. There are 0 mismatches, calculated columns included.
- **Relationships:** all 13 come in as many-to-one, the right way round (`main.dbml:12-28`).
  - Each fact keeps its three role-playing Date links.
  - The 4 inactive ones (`Model.bim:1638`, `:1646`, `:1654`, `:1662`) are named Refs (`main.dbml:15`, `:17`, `:24`, `:26`) and are labelled on the canvas.
  - The many side gets `foreign_key: 'true'` (13 flags).
- **Inferred keys:** the six dimension keys (customer, product, geography, product_subcategory, product_category, employee) are inferred from the relationships, and each one is reported.
- **Nothing invented:**
  - Employee gets no self-reference. Its parent-child link is DAX `PATH` on `ParentEmployeeKey` (`Model.bim:1325`), which becomes the plain column `employee.dbml:3`.
  - The dangling keys get no Refs: `PromotionKey` (`Model.bim:58` becomes `internet_sales.dbml:7`), `CurrencyKey`, `SalesTerritoryKey` and `ResellerKey`.
  - There are exactly 13 Refs.
- **Power Query:** columns removed by `Table.RemoveColumns` in the M partitions are correctly not columns.
- **Draft preview:** the draft showed 9 tables and 13 relationships, with per-table keys and foreign keys, before anything was saved.
- **Health:** the project passes `doctor`. The analyst's check found that the written DBML parses in `@dbml/core` 11.0.0 (9 tables, 13 refs).

## What the import showed

- **Sidebar start screen:** "No diagrams yet. This folder has a Power BI or Fabric semantic model." with the button "Import your Power BI semantic model" and the link "Or: More ways to start…".
- **Import picker:** "Power BI or Fabric semantic model — found in this folder — A <Name>.SemanticModel folder, saved as TMDL or as model.bim".
- **Folder dialog:** "Import Semantic Model: the folder that holds <Name>.SemanticModel" (button Import).
- **Name prompt:** "Import Semantic Model — Name the diagram. It is saved in the Main layer." with the default value `semantic-model`.
- **Draft banner:** "Draft from the semantic model AsPartitionProcessing.AdventureWorks · 9 tables, 13 relationships · not saved" / "Keep saves it as adventure-works in the Main layer (.erd-studio/main/diagrams/adventure-works.dbml)." / "7 notes, 1 left out: Show details" with the buttons [Keep as Diagram] [More ways to start ▾] [Discard].
- **Details drawer, new tables (9):** customer 25 columns · primary key customer_key · 1 foreign key; date 15 columns · primary key date; employee 37 columns · primary key employee_key; geography 9 columns · primary key geography_key; internet_sales 27 columns · no primary key · 5 foreign keys; product 27 columns · primary key product_key · 1 foreign key; product_category 3 columns · primary key product_category_key; product_subcategory 4 columns · primary key product_subcategory_key · 1 foreign key; reseller_sales 27 columns · no primary key · 5 foreign keys.
- **Details drawer, relationships (13):** all many-to-one. The four due and ship date links are tagged "· inactive in Power BI".
- **Details drawer, not imported (1):** "These stay in your own files only: the import writes none of them. — 21 measures: DAX calculations, not columns".
- **Details drawer, notes (7):** "9 table names and 174 column names written in snake_case; the original Power BI names are kept in the table files." / "Customer: customer_key is marked as the primary key, because relationships point at it." The same line follows for Product, Geography, Product Subcategory, Product Category and Employee.
- **Output channel (ERD Studio):**
  - "[ERD Studio] Import Semantic Model: 18 measures in Internet Sales (InternetDistinctCountSalesOrder, …, YTD InternetTotalSales): measures are DAX calculations, not columns."
  - "[ERD Studio] Import Semantic Model: 2 measures in Date (DaysCurrentQuarterToDate, DaysInCurrentQuarter): measures are DAX calculations, not columns."
  - "[ERD Studio] Import Semantic Model: 1 measure in Reseller Sales (ResellerTotalSales): measures are DAX calculations, not columns."
  - "[ERD Studio] Import Semantic Model: Customer: customer_key is marked as the primary key, because relationships point at it." The same line follows for the other five dimensions.
  - "[Canvas] Saved the positions of 9 tables in …/.erd-studio/main/diagrams/adventure-works.dbml in 33 ms (layout only)".
- **Status bar:** Problems 0 errors, 0 warnings.
- **Startup toast:** "ERD Studio found a Power BI or Fabric semantic model in this folder. Show it as a diagram? Nothing is saved until you keep it." [Show Me] [Don't Ask Again for This Folder]. It appeared in the rehearsal only. It did not show in time during the take.

The import succeeded, so there is no failure to explain.
