# AdventureWorks tabular model (Analysis Services / Power BI model.bim)

This is a real Analysis Services tabular model in TMSL JSON (`Model.bim`, compatibility level 1400). Microsoft publishes it as the sample model for its **AsPartitionProcessing** tool. It is the classic AdventureWorks star schema: Internet Sales and Reseller Sales facts, with Customer, Product, Date, Geography and Employee dimensions. The same format is the `model.bim` inside a Power BI `.Dataset` / `.SemanticModel` folder.

## Where it came from

- Repo: https://github.com/microsoft/Analysis-Services
- File: `AsPartitionProcessing/AsPartitionProcessing.AdventureWorks/Model.bim`
- Pinned URL: https://raw.githubusercontent.com/microsoft/Analysis-Services/d3ccb5032c9029b097276b88412f7b61df6e73b8/AsPartitionProcessing/AsPartitionProcessing.AdventureWorks/Model.bim
- Pin: repo commit `d3ccb5032c9029b097276b88412f7b61df6e73b8` (`master`, 2026-11-07). The file was last changed in commit `9304105c694f4332615405ea8066c75a63107db6` (2017-04-18, "1400 v1").
- `Model.bim`: 62,707 bytes, SHA-256 `e05cce59fc9405171f296283275c3073033f6e49d5f207e137f627ae85fdc248`.
- Downloaded 2026-11-07.

## Licence

MIT, Copyright (c) 2016 Microsoft (repo `LICENSE`). MIT allows redistribution if the notice is kept, so it is copied to `UPSTREAM-LICENSE.txt`.

## What was copied

- `AsPartitionProcessing.AdventureWorks/Model.bim`, byte for byte (same hash as above). The upstream folder name is kept because ERD Studio shows it in the import picker and the draft banner. The suggested diagram name (`semantic-model`) and the Project Note ("Converted from the Power BI semantic model SemanticModel.") come from the TMSL database `name` (`"SemanticModel"`), because the folder is not a `<Name>.SemanticModel` or `<Name>.Dataset` folder.
- Nothing was removed or edited. Not copied: the rest of the repo (the C# partition-processing tool, its `.smproj` project file and other samples).
- Note: the file is unchanged, so it still holds what upstream committed: a `localhost\SP1` data source and a "General Users" role listing three `@microsoft.com` member names. Neither affects the import.

## Expected counts

Counted with a small Python script that loads the JSON and walks `model.tables[]` (`columns`, `measures`, `hierarchies`, `partitions`) and `model.relationships[]`. ERD Studio was not run.

- Tables: **9**
- Columns: **174** (164 data columns + 10 calculated columns)
- Primary keys: **7**. Tabular models have no primary keys. Only one column is flagged `isKey: true` (`Date[Date]`). The other keys are implied: each relationship's "to" (one) side, which gives Customer.CustomerKey, Product.ProductKey, Geography.GeographyKey, Product Subcategory.ProductSubcategoryKey, Product Category.ProductCategoryKey, Employee.EmployeeKey and Date.DateKey. So 7 of 9 tables have a key; the two fact tables have none. Date has two candidates (`Date` flagged, `DateKey` used by every relationship).
- Relationships: **13**, all single-column, many-to-one by default (no cardinality is written). **4 are inactive** (`isActive: false`).
- Measures: **21** (not columns; ERD Studio skips them and counts them).

| Table | Columns | Calculated | Measures | Hierarchies | Key | Relationships out (column → table) |
|---|---|---|---|---|---|---|
| Internet Sales | 27 | 1 (Margin) | 18 | 0 | – | CustomerKey → Customer; ProductKey → Product; OrderDateKey → Date; DueDateKey → Date (inactive); ShipDateKey → Date (inactive) |
| Customer | 25 | 0 | 0 | 0 | CustomerKey (implied) | GeographyKey → Geography |
| Date | 15 | 0 | 2 | 2 | Date (`isKey`), DateKey (implied) | – |
| Product | 27 | 2 | 0 | 1 | ProductKey (implied) | ProductSubcategoryKey → Product Subcategory |
| Geography | 9 | 0 | 0 | 0 | GeographyKey (implied) | – |
| Product Subcategory | 4 | 0 | 0 | 0 | ProductSubcategoryKey (implied) | ProductCategoryKey → Product Category |
| Product Category | 3 | 0 | 0 | 0 | ProductCategoryKey (implied) | – |
| Reseller Sales | 27 | 0 | 1 | 0 | – | EmployeeKey → Employee; ProductKey → Product; OrderDateKey → Date; DueDateKey → Date (inactive); ShipDateKey → Date (inactive) |
| Employee | 37 | 7 | 0 | 1 | EmployeeKey (implied) | – |
| **Total** | **174** | **10** | **21** | **4** | **7 tables** | **13 (4 inactive)** |

Data types used (`dataType`): int64 58, string 70, decimal 20, dateTime 15, boolean 6, double 5 (sum 174).

## Notable features

- **Table names with spaces**: `Internet Sales`, `Reseller Sales`, `Product Subcategory`, `Product Category`. Measure `YTD InternetTotalSales` also has spaces. An importer has to turn these into valid model names.
- **Role-playing date with inactive relationships**: both fact tables join Date three times (OrderDateKey active; DueDateKey and ShipDateKey inactive). The same pair of tables has three links.
- **Two fact tables share dimensions** (Product and Date).
- **Calculated columns (10)** with DAX: `Internet Sales[Margin]`, `Product[ProductSubCategoryName]` and `[ProductCategoryName]` (RELATED), and Employee's `FullName`, `Path` and `Level1`–`Level5` (PATH / LOOKUPVALUE). `Level2`'s expression is a JSON array of lines, not a string. All have `isDataTypeInferred: true`.
- **Measures (21)** with DAX time intelligence (TOTALQTD, PREVIOUSQUARTER, DATESYTD). Two carry a **KPI** and all 21 carry a `detailRowsDefinition`.
- **Self-referencing hierarchy with no relationship**: Employee has `ParentEmployeeKey`, but the parent-child link is built with DAX `PATH`, not a relationship. An importer should not invent one.
- **Dangling key columns**: `PromotionKey`, `CurrencyKey`, `SalesTerritoryKey`, `ResellerKey` point at tables that are not in the model, so they have no relationship.
- **Hierarchies (4)**: Date `Calendar` and `Fiscal`, Product `Category`, Employee `Organization`.
- **Column extras**: `sortByColumn` (EnglishMonthName by MonthNumberOfYear), `variations` on `Internet Sales[OrderDate]` (a "Calendar Reuse" variation tied to a relationship), Date table `dataCategory: Time` and `showAsVariationsOnly`.
- **Power Query (M) partitions**: one per table, several with `Table.RemoveColumns` (the Spanish / French columns are removed in M, so they are not columns in the model).
- **Model-level objects an ERD has no place for**: a structured `dataSources` entry, one perspective (`Internet Sales`), one role with row-level security (`Geography[CountryCode]="US"`) and a column permission hiding `Customer[Phone]`.
- No column or table descriptions, no hidden columns, no calculated tables, no calculation groups, no explicit cardinality or cross-filter settings.
