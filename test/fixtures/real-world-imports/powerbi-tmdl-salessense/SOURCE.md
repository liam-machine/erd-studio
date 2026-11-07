# Power BI TMDL: SM_SalesSense

## What it is

A real Power BI / Microsoft Fabric semantic model saved in TMDL. It is the
sample model of Rui Romano's "Fabric CLI Power BI CI/CD sample" repository
(Rui Romano is on the Power BI product team at Microsoft). It is a small sales
star schema (Sales fact; Customer, Product, Store and Calendar dimensions) plus
the extra objects a real model collects: calculation groups, a field
parameter, a disconnected table, roles, a perspective and a translation.

## Where it came from

- Repository: https://github.com/RuiRomano/fabric-cli-powerbi-cicd-sample
- Pinned commit: `1df48c9cf7b56eccb6a646d49d95d8283d81dbbf` (2025-05-14, "fix")
- Folder: https://github.com/RuiRomano/fabric-cli-powerbi-cicd-sample/tree/1df48c9cf7b56eccb6a646d49d95d8283d81dbbf/src/SM_SalesSense.SemanticModel
- Downloaded as the commit's tarball from codeload.github.com.

## Licence

MIT, Copyright (c) 2025 Rui Romano. MIT asks for the notice to be kept, so it
is copied as `UPSTREAM-LICENSE.txt`.

## What was copied

The whole `SM_SalesSense.SemanticModel/` folder, with upstream file names and
layout: `definition.pbism`, `.platform`, `diagramLayout.json` and
`definition/` (`model.tmdl`, `database.tmdl`, `relationships.tmdl`,
`expressions.tmdl`, `tables/*.tmdl`, `roles/*.tmdl`, `perspectives/Sales.tmdl`,
`cultures/en-US.tmdl`, `cultures/pt-PT.tmdl`).

Left out:

- `SM_SalesSense.SemanticModel/.pbi/editorSettings.json` (a local editor file).
- Everything else in the repo (the `.Report`-free Fabric items, pipelines,
  notebooks, scripts). The repo is a Fabric Git-integration layout, so it has
  **no `.pbip` file** and no `.Report` folder for this model.

Nothing inside the copied files was changed. `cultures/en-US.tmdl` is about
200 KB of Q&A linguistic metadata. The folder is about 300 KB.

## Expected counts

Counted by reading the TMDL files with a small line-based script plus `grep`,
not with ERD Studio. A table is a `table` block in `tables/` (all 10 are also
listed as `ref table` in `model.tmdl`). A column is a `column` line at one tab
of indent. A primary key is a column marked `isKey`. A relationship is a
`relationship` block in `relationships.tmdl`. Measures are `measure` lines.

| Total | Count |
|---|---|
| Tables | 10 |
| Columns | 88 (2 are DAX calculated columns) |
| Primary keys (`isKey`) | 3 (all single-column) |
| Relationships | 5 (4 active, 1 inactive) |
| Measures | 27 |
| Calculation groups / items | 2 / 11 |
| Hierarchies | 2 |

| Table | Columns | `isKey` | Measures | Kind / notes |
|---|---|---|---|---|
| About | 3 | – | 0 | M `#table` literal; has a `///` description |
| Calendar | 13 | – | 0 | M-generated date table; hierarchy `Year-Month-Day`; no `isKey` even though `Date` is the one side of two relationships |
| Costs | 15 | – | 5 | Disconnected: has `StoreKey` and `ProductKey` but no relationship; measures have `///` descriptions |
| Customer | 13 | CustomerKey | 1 | `Age` is a calculated column (multi-line DAX in a ```` ``` ```` block, no `dataType`) |
| Field Parameter | 3 | – | 0 | Calculated table (`partition … = calculated`, DAX table constructor); no column has a `dataType` |
| Product | 14 | ProductKey | 1 | Hierarchy `Product Hierarchy` |
| Sales | 13 | – | 19 | Fact table; column `CustomerKey` has a `///` description; most columns hidden |
| Smart Calcs | 2 | – | 0 | Calculation group, 4 items |
| Store | 10 | StoreKey | 1 | `Column` is a calculated column (`[Store] & "SSS"`, no `dataType`) |
| Time Intelligence | 2 | – | 0 | Calculation group, 7 items; description `fff` |

Relationships (none sets cardinality or cross-filter, so all use the TMDL
defaults: many-to-one, single direction):

| From (many) | To (one) | Active |
|---|---|---|
| Sales.CustomerKey | Customer.CustomerKey | yes |
| Sales.ProductKey | Product.ProductKey | yes |
| Sales.StoreKey | Store.StoreKey | yes |
| Sales.OrderDate | Calendar.Date | yes |
| Sales.DeliveryDate | Calendar.Date | **no** (`isActive: false`) |

Data types used: `string`, `int64`, `dateTime`, `double`, `decimal`,
`boolean`. Five columns have no `dataType` at all: the 2 calculated columns
and the 3 field-parameter columns. The 4 calculation-group columns do declare
one.

## Notable features an importer might drop or mangle

- An **inactive relationship** (`Sales.DeliveryDate → Calendar.Date`) on the
  same target column as an active one: a role-playing date.
- Relationships to a column (`Calendar.Date`) that is **not `isKey`**.
- A **disconnected table** (Costs) whose key-looking columns have no relationship.
- **Calculated columns** (`column X = <DAX>`) with no `dataType`, one using a
  multi-line ```` ``` ```` block.
- A **calculated table** (field parameter) whose columns have no `dataType`,
  `relatedColumnDetails` and an `extendedProperty` JSON block.
- **Calculation groups** (`calculationGroup` / `calculationItem`) as tables.
- **27 DAX measures**, many with `formatString`, some multi-line, some with
  `///` descriptions.
- **Descriptions** as `///` doc comments on tables, a column and measures.
- **Quoted names with spaces** (`'Field Parameter'`, `'Month Name'`,
  `'Smart Calcs'`), an unquoted hyphen (`Year-Month`), double spaces and
  Unicode in names (`'Sales Amount  (Δ LY)'`, `'Label - ▲ LY'`), `%` and `#`
  (`YOY%`, `'# Sales'`). Table file names contain spaces.
- `dataCategory` (City, StateOrProvince, Country, Continent), `sortByColumn`,
  `summarizeBy`, `isHidden`, `changedProperty`, `lineageTag` and many
  `annotation` lines.
- **Power Query (M) partitions** reading `raw.customer`, `raw.product`,
  `raw.store` from a Fabric SQL endpoint, and **shared expressions**
  (`Server`, `Database`, `Randomizer` parameters and the
  `SalesDateAdjustedAndSalesRandomized` query that feeds Sales, Costs and
  Calendar).
- **Row-level security roles** (`Store - Canada`, `Store - United States`),
  a **perspective** (`Sales`) and a **pt-PT translation** culture.
- `definition.pbism` version `4.0`; `database.tmdl` compatibility level 1601.
