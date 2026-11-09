# Power BI, Tabular Editor Save to Folder: SpaceParts

## What it is

A real Power BI semantic model saved with Tabular Editor's **Save to Folder**:
`database.json` plus one JSON file per table, column, measure, partition,
hierarchy, shared expression and culture. It is the SpaceParts demo model
from Tabular Editor's own webinar archive ("CI/CD and version control for
Fabric", 2025-12-10), published by Tabular Editor ApS. It is a sales and
supply-chain model (Invoices, Orders, Budget and Forecast facts; Customers,
Products, Brands, Regions, Employees, Date and exchange-rate dimensions),
with the extras a real model collects: field parameters, calculation groups,
measure tables, a DAX date table, auto date/time tables, a DAX user-defined
function and incremental-refresh parameters.

It is saved with `LocalRelationships`, `LocalPerspectives` and
`LocalTranslations` on (`TabularEditor_SerializeOptions` in `database.json`):
there is **no `relationships/` folder**; every relationship is in its
from-table's own file, in a `TabularEditor_Relationships` annotation whose
JSON text is split one string per line. The two perspectives are named in
the model's `TabularEditor_Perspectives` annotation.

## Where it came from

- Repository: https://github.com/TabularEditor/SessionArchive
- Pinned commit: `f5f9153f015392ed953c5419ad6c038331455208` (2026-08-05, "Add semantic bridge webinar materials"); the folder was last changed in `725c4c73f5f456268ca69ca84ff40a07ca52201e` (2026-01-02).
- Folder: https://github.com/TabularEditor/SessionArchive/tree/f5f9153f015392ed953c5419ad6c038331455208/Webinars/2025-12-10%20-%20CICD%20and%20version%20control%20for%20Fabric/src/solution/model/SpacePartsSaveToFolder
- Downloaded 2026-11-09, file by file from raw.githubusercontent.com at the pinned commit (454 files).

## Licence

MIT, Copyright (c) 2023 Tabular Editor ApS. MIT asks for the notice to be
kept, so it is copied as `UPSTREAM-LICENSE.txt`.

## What was copied

The whole `SpacePartsSaveToFolder/` folder, with upstream file names and
layout (454 JSON files, about 1.8 MB). Nothing inside the files was changed.

## Expected counts

Counted from the JSON files with a small script (each `tables/<T>/<T>.json`,
its `columns/*.json`, and the `TabularEditor_Relationships` annotations),
not with ERD Studio. Auto date/time tables (5 `LocalDateTable_…` and 1
`DateTableTemplate_…`) and the 5 relationships into them are not counted
(Power BI makes them), nor `RowNumber-…` columns.

| Total | Count |
|---|---|
| Tables | 30 (8 calculated tables, 7 calculation groups) |
| Columns | 186 |
| Primary keys (`isKey`) | 1 (`Date[Date]`) |
| Relationships | 22 (27 with the auto date/time ones; 1 inactive) |
| Measures | 137 |
| Calculation items | 43 |
| Hierarchies | 5 (and 6 more in the auto date/time tables) |

Date-only columns (`UnderlyingDateTimeDataType = Date`): 9.

## Notable features an importer might drop or mangle

- **Relationships kept with their table** (`LocalRelationships`), in an
  annotation whose value is JSON split one line per string.
- **Names that do not start with a letter** (`1) Selected Metric`) and names
  with `%`, `#`, `(…)`, `&` (`Workdays MTD %`, `Calendar Month # (ie 1)`,
  `Taxes & Commercial Fees`).
- **Calculated tables**: field parameters, measure tables (`__Measures`), the
  DAX `Date` table; **calculation groups** (`Z01CG1 - Quantity`…).
- **Descriptions** written as an array of lines.
- Power Query partitions reading `dbo.*` tables from a Fabric SQL endpoint
  (`Sql.Database(#"SqlEndpoint", #"Database")`, with the navigation spread
  over several lines), shared expressions and parameters.
- A DAX user-defined function (`Comparison.RelativeToTarget`) in `database.json`.
- `joinOnDateBehavior: datePartOnly` on the auto date/time relationships.
