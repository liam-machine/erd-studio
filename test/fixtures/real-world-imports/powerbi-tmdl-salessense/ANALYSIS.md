# Import analysis: SM_SalesSense (Power BI / Fabric TMDL semantic model)

**Verdict: Imported, with gaps (minor gaps).** There were no errors. 8 of 10 tables, 84 of 88 columns, the keys and all 5 relationships came in. Measures and calculation groups were left out, and the import said so. Hierarchies, roles, translations, the perspective, M sources and column formats were dropped without notice. All 11 date/time columns became `timestamp`, and 6 of the 7 kept descriptions gained a full stop.

## Tested with

- **Build:** ERD Studio 2.0, `feat/native-dbml-storage` at `d04c4167` (tag `prerelease-v1.9.9`). It ran as a frozen build in an isolated VS Code 1.145.2 with a fresh profile. Note that the Output log and the CLI both report the version as `1.7.2`.
- **Source:** `SM_SalesSense.SemanticModel/` from RuiRomano/fabric-cli-powerbi-cicd-sample at `1df48c9c` (MIT). It uses the Fabric Git layout: `.platform` is present, and there is no `.pbip` file and no `.Report` folder. `SOURCE.md` gives the provenance.
- **Import path:**
  1. ERD Studio sidebar, Diagrams view, **+ (New…)**, then **Import Power BI or Fabric Semantic Model…**. The start screen's "Import your Power BI semantic model" button was not used.
  2. The folder dialog opened on the workspace root. I pressed Import without picking a folder, and the model was found.
  3. No layer question appeared, because the project had no layers, so the Main layer was used.
  4. I kept the suggested diagram name `sm_sales-sense`. No dialect step applies to this source.
  5. In the draft preview I skipped the draft guide, opened Show details, then pressed **Keep as Diagram**.
- **Video:** `import-review.mp4` in this folder, 118.7 s, as re-rendered by the fixer.
- **Where paths point:** source lines are in `SM_SalesSense.SemanticModel/definition/`. Imported paths are under the import's `.erd-studio/main/`.

## Numbers

| | Source | Imported | Notes |
|---|---|---|---|
| Tables | 10 | 8 | The calculation groups `Smart Calcs` and `Time Intelligence` were skipped, and the import said so |
| Columns | 88 | 84 | The 4 calculation-group columns went with their tables. Every other table matches column for column |
| Primary keys | 3 (`isKey`) | 4 | `calendar.date` was inferred because relationships point at it. The import says so |
| Relationships | 5 (1 inactive) | 5 | The inactive `Sales.DeliveryDate → Calendar.Date` is kept as `Ref "inactive in Power BI"` |
| Hidden columns | 25 | 24 | The 25th is `Smart Calcs.Ordinal` (`tables/Smart Calcs.tmdl:69`), dropped with its calculation group |
| Measures | 27 | 0 | Skipped, and listed table by table: Sales 19, Costs 5, Customer 1, Product 1, Store 1 |
| Calculation groups | 2 | 0 | Skipped, with notice |
| Hierarchies | 2 | 0 | Dropped without notice |
| `dateTime` columns | 11 (9 date-only, 2 time-only) | 11, all `timestamp` | See the first bug |
| Errors / warnings | | 0 / 0 | Status bar after Keep as Diagram |

**How I counted.** For the source, I used grep over `definition/tables/*.tmdl`:
- columns: lines that start with a tab and then `column `;
- primary keys: `isKey`;
- hidden columns: `isHidden` indented two tabs;
- date/time columns: `dataType: dateTime`;
- relationships: `relationship` blocks in `relationships.tmdl`;
- date-only and time-only: the `UnderlyingDateTimeDataType` annotations.

For the import, `node dist/cli.js inventory --json` lists 8 logical tables, 84 columns, and PKs on `calendar.date`, `customer.customer_key`, `product.product_key` and `store.store_key`. Inventory's `relationships` array is for dbt and is empty here, so I counted relationships from the 5 `Ref` lines in `relationships/main.dbml`. Grep counts 24 `power_bi_hidden` lines and 11 `timestamp` columns under `tables/main/`.

These numbers match the final video's term card and closing card.

## Findings

### Errors

None. The import worked on the first try. The status bar showed 0 errors and 0 warnings, and no error or warning notification appeared at any point.

### Bugs (silently lost or wrong)

**1. Every `dateTime` column becomes `timestamp`.**

All 11 `dateTime` columns came in as `timestamp`. The source marks each one as date-only or time-only with `annotation UnderlyingDateTimeDataType`.

9 are date-only and should be `date`:
- `Calendar.Date` (`tables/Calendar.tmdl:59`) became `calendar.dbml:8` `date timestamp [pk, …]`.
- `Calendar.Year-Month` (`:84`) became `calendar.dbml:10`.
- `Customer.Birthday` (`tables/Customer.tmdl:93`) became `customer.dbml:12` `birthday timestamp`.
- `Costs.PurchaseDate` and `Costs.ShippingDate` (`tables/Costs.tmdl:51`, `:62`) became `costs.dbml:4-5`.
- `Sales.OrderDate` and `Sales.DeliveryDate` (`tables/Sales.tmdl:274`, `:288`) became `sales.dbml:19-20`.
- `Store.OpenDate` and `Store.CloseDate` (`tables/Store.tmdl:91`, `:102`) became `store.dbml:16-17`.

2 are time-only and should be `time`:
- `Costs.Time` (`tables/Costs.tmdl:128`) became `costs.dbml:12` `time timestamp`.
- `Sales.Time` (`tables/Sales.tmdl:242`) became `sales.dbml:16` `time timestamp`.

Cause: `SEMANTIC_MODEL_TYPE_MAP` maps `datetime: 'timestamp'` (`src/services/semanticModelImport.ts:851`). The importer never reads the annotation. It also ignores the `formatString` (`Long Date`, `Long Time`, `mmm yyyy`), which says the same thing. The user is not told.

**2. Descriptions get a full stop added.**

6 of the 7 kept descriptions were changed: 5 on tables and 1 on a column.

| Source | Imported |
|---|---|
| `/// Customer data` (`tables/Customer.tmdl:1`) | `customer.dbml:2` `Note: 'Customer data.'` |
| `/// Calendar table` (`tables/Calendar.tmdl:1`) | `calendar.dbml:2` `'Calendar table.'` |
| `/// Store metadata` (`tables/Store.tmdl:1`) | `store.dbml:2` `'Store metadata.'` |
| `/// Product Catalog` (`tables/Product.tmdl:1`) | `product.dbml:2` `'Product Catalog.'` |
| `/// Sales table for year over year analysis` (`tables/Sales.tmdl:1`) | `sales.dbml:2` `'… analysis.'` |
| `/// sdsdsssgs` (column `Sales.CustomerKey`, `tables/Sales.tmdl:193`) | `sales.dbml:8` `note: 'sdsdsssgs.'` (the source text itself is junk) |

`About`'s description is unchanged because it already ends in `...`. Cause: `sentenceJoin` (`src/services/semanticModelImport.ts:946-948`) appends `.` to every part that does not end in `.`, `!` or `?`. It runs on the user's own text even when nothing is being joined to it.

**3. Minor: the suggested diagram name mixes `_` and `-`.**

`SM_SalesSense` is suggested as `sm_sales-sense`. The original underscore is kept, and the camel-case split adds a hyphen. The name goes into `diagrams/sm_sales-sense.dbml` and `Project "sm_sales-sense"` (line 11). A consistent name would be `sm-sales-sense` or `sm_sales_sense`. Cause: `suggestDbmlSubjectAreaName` (`src/services/dbmlImport.ts:351`) runs `splitWords` (`:363`) and then a slug step that keeps `_`.

### Gaps (unsupported)

These were left out, and the user **was told**:
- **27 measures and 2 calculation groups.**
  - Source: `tables/Sales.tmdl:5-186`, `tables/Costs.tmdl:4-21`, `tables/Smart Calcs.tmdl`, `tables/Time Intelligence.tmdl`.
  - The draft lists them under "Not imported (2)": "27 measures: DAX calculations, not columns" and "2 calculation groups: they hold DAX, not data". The Output log names each measure.
  - Also lost with them: the 4 calculation-group columns, their 11 calculation items and the measures' `///` descriptions.
- **Calculated DAX.**
  - `Customer.Age` (`tables/Customer.tmdl:95-103`) is kept as `customer.dbml:13` `age variant`.
  - `Store.Column` (`tables/Store.tmdl:59`) is kept as `store.dbml:12`.
  - The `Field Parameter` calculated table is kept as `field_parameter.dbml`.
  - Each is marked with `power_bi_calculated` and carries the note "Calculated column in Power BI; its DAX was not imported." (or "Calculated table…").

These were dropped, and the user **was not told** in the draft or the log. The importer's header calls them "skipped over" (`src/services/semanticModelImport.ts:21-22`):
- **Hierarchies:** `Year-Month-Day` (`tables/Calendar.tmdl:155`) and `'Product Hierarchy'` (`tables/Product.tmdl:145`).
- **Row-level security roles:** `roles/Store - Canada.tmdl` and `roles/Store - United States.tmdl` (`model.tmdl:33-34`).
- **The perspective:** `perspectives/Sales.tmdl` (`model.tmdl:36`).
- **Translations:** `cultures/pt-PT.tmdl` and the en-US linguistic metadata (`model.tmdl:38-39`).
- **M sources:** the partitions, for example `tables/Customer.tmdl:135-140`, which reads `Schema="raw",Item="customer"`, and the shared expressions in `expressions.tmdl`. No imported table records which warehouse table it comes from.
- **Column properties.** Only `isHidden` survives, as `power_bi_hidden`. These are lost:
  - `formatString`: `Long Date` (`tables/Customer.tmdl:86`), `mmm yyyy` (`tables/Calendar.tmdl:77`), `Long Time` (`tables/Sales.tmdl:235`);
  - `dataCategory`: City, StateOrProvince, Country, Continent (`tables/Customer.tmdl:51`, `:60`, `:69`, `:78`, `:129`; `tables/Store.tmdl:28`);
  - `sortByColumn`: `Month Name` by `Month` (`tables/Calendar.tmdl:67`), `Day Name` by `'Day of Week'` (`:113`);
  - `summarizeBy`;
  - `isDefaultLabel` (`tables/Customer.tmdl:34`, `tables/Store.tmdl:45`).

### What came through correctly

- **Tables and columns.** All 8 data tables came in, and their columns are complete and in source order. Per table, imported vs source columns:

  | about | calendar | costs | customer | field_parameter | product | sales | store |
  |---|---|---|---|---|---|---|---|
  | 3/3 | 13/13 | 15/15 | 13/13 | 3/3 | 14/14 | 13/13 | 10/10 |

- **Relationships.** All 5 are many-to-one from `sales`, in `relationships/main.dbml:8-12`, and every Ref uses `>?`. The role-playing date pair survives: the inactive link (`relationships.tmdl:17` `isActive: false`) becomes `Ref "inactive in Power BI": main.sales.delivery_date >? main.calendar.date`, next to the active `order_date` link. The sidebar shows "sales date ← delivery_date · 1:N · inactive in Power BI".
- **Keys.**
  - `customer_key`, `product_key` and `store_key` are PKs from `isKey`.
  - `Calendar.Date` has no `isKey`, but both date links point at it, so it became the PK, with the note "Calendar: date is marked as the primary key, because relationships point at it."
  - No key was invented for `sales`, `about`, `costs` or `field_parameter`.
- **Types.** `int64 → bigint`, `string → varchar`, `double → double`, `decimal → decimal` and `boolean → boolean` are right. For example, `Sales.UnitCost` is `double` and `Costs.UnitCost` is `decimal`, and each kept its own type. The 5 columns with no `dataType` (2 calculated columns and 3 field-parameter columns) came in as `variant`.
- **Names.** All 8 table names and 84 column names became snake_case, and each original is kept as `power_bi_name` (for example `Year-Month` became `year_month [power_bi_name: 'Year-Month']`). The reserved word `key` in `about` is quoted.
- **Hidden flags.** All 24 hidden columns in the imported tables carry `power_bi_hidden`.
- **The disconnected table.** `costs` is still unconnected, as in the source, even though it has `StoreKey` and `ProductKey`.
- **Project health.** The `doctor` CLI reported the project as ready: "1 diagram, 8 tables — storage DBML".

### Dropped claim

An earlier finding said the draft guide names an "Import…" entry that the **+** menu lacks (`src/types/onboardingGuide.ts:214`). I checked and dropped it. That guide step describes the draft banner's **More ways to start▾** button. That menu does offer `Import…`: `DRAFT_OTHER_START_LABELS.import` in `src/services/draftModel.ts:68` is `START_ACTION_LABELS.import`, which is `'Import…'` (`src/types/startActions.ts:63`). The step does not describe the **+** menu.

### Other observations (display, not data)

After Fit, the canvas zooms to 49%. The edge to `calendar` runs through the `store` table, so the "inactive in Power BI" label sits on top of store's rows. At that zoom the label is small and dim. It reads clearly only after jumping to the relationship from the sidebar, which zooms to 75%.

## What the import showed

- **Launch notification** (rehearsal and take 1): "ERD Studio found a Power BI or Fabric semantic model in this folder. Show it as a diagram? Nothing is saved until you keep it." Buttons: Show Me | Don't Ask Again for This Folder
- **Start screen:** "No diagrams yet. This folder has a Power BI or Fabric semantic model." Button "Import your Power BI semantic model". "Or: More ways to start…"
- **Folder dialog:** "Import Semantic Model: the folder that holds <Name>.SemanticModel"
- **Name box:** "Name the diagram. It is saved in the Main layer. (Press 'Enter' to confirm or 'Escape' to cancel)". The default was `sm_sales-sense`.
- **Draft banner:** "Draft from the semantic model SM_SalesSense · 8 tables, 5 relationships · not saved" / "Keep saves it as sm_sales-sense in the Main layer (.erd-studio/main/diagrams/sm_sales-sense.dbml)." / "2 notes, 2 left out: Show details"
- **Draft details:**
  - "New tables (8)": about 3 columns · no primary key; calendar 13 columns · primary key date; costs 15 columns · no primary key; customer 13 columns · primary key customer_key; field_parameter 3 columns · no primary key; product 14 columns · primary key product_key; sales 13 columns · no primary key · 5 foreign keys; store 10 columns · primary key store_key.
  - "Relationships (5)": four many-to-one links, plus "sales.delivery_date → calendar.date many-to-one · inactive in Power BI".
  - "Not imported (2)": "These stay in your own files only: the import writes none of them." 27 measures: DAX calculations, not columns; 2 calculation groups: they hold DAX, not data.
  - "Notes (2)": "8 table names and 84 column names written in snake_case; the original Power BI names are kept in the table files." / "Calendar: date is marked as the primary key, because relationships point at it."
- **Output log, "Import Semantic Model" lines:**
  - "19 measures in Sales (# Customers (w/ Sales), # Products (w/ Sales), Sales Qty, Sales Amount, Sales Amount  (Δ LY), Sales Amount (LY), Sales Amount (YTD, LY), Sales Amount (YTD), Sales Amount Avg per Day, Sales Amount  (% Δ LY), Margin, Margin (ly), # Sales, Sales Qty by Delivery Date, Sales Amount (12M average), Sales Amount (6M average), Margin %, Cost, Margin % Overall): measures are DAX calculations, not columns."
  - "1 measure in Product (# Products) …", "1 measure in Customer (# Customers) …", "1 measure in Store (# Stores) …"
  - "5 measures in Costs (Total Shipping Cost, Total Quantity, Total Unit Cost, Total Tax, Total Discount): measures are DAX calculations, not columns."
  - "Calculation group Smart Calcs (it holds DAX, not data)." / "Calculation group Time Intelligence (it holds DAX, not data)."
  - "Calendar: date is marked as the primary key, because relationships point at it."
- **After Keep:**
  - Canvas log: "[Canvas] Opened …/.erd-studio/main/diagrams/sm_sales-sense.dbml: 8 tables posted 11 ms after ready" and "Saved the positions of 8 tables … (layout only)".
  - Files written: `README.md`, `layers.json`, `main/diagrams/sm_sales-sense.dbml`, `main/relationships/main.dbml` and 8 files under `main/tables/main/`.
- **Column tooltips** (`customer.age`, `store.column`): "Calculated column in Power BI; its DAX was not imported."
- **Problems:** 0 errors and 0 warnings. No error or warning notification appeared.

The import succeeded, so there is no failure path to report.
