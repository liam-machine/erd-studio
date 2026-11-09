# AdventureWorksDW, forward-engineered by SqlDBM (Snowflake)

Import type: **SQL DDL, Snowflake**. Pick `assets/sample_schema.sql` in **Import SQL DDL…**; the dialect is detected (Snowflake).

## What it is

Snowflake's quickstart "Database modeling with SqlDBM" ships the DDL SqlDBM forward-engineers for Microsoft's
AdventureWorksDW star schema: `create or replace schema ADVENTUREWORKSDW.EDW`, then 23 tables with three-part names.
Every table and column name is quoted and mixed case (`ADVENTUREWORKSDW.EDW."DimCustomer"."GeographyKey"`), keys are
named constraints (`constraint PK_DimCustomer primary key ("CustomerKey")`), identities are `NOT NULL autoincrement`,
and columns and tables carry `COMMENT`s (`)COMMENT='…'` with no space).

What it adds to the samples: quoted mixed-case identifiers, named PRIMARY and FOREIGN KEY constraints in Snowflake, and
case folding: each foreign key names the referenced column unquoted (`references ADVENTUREWORKSDW.EDW."DimGeography"(GeographyKey)`),
which Snowflake folds to `GEOGRAPHYKEY`, so it matches the quoted `"GeographyKey"` only without regard to case. 4 foreign
keys reference a table created later in the file.

## Where it came from

- Project: https://github.com/Snowflake-Labs/sfquickstarts
- Pin: commit `4816f22b2e9fba6de36d1bd02dff79996a556a6d`, as pinned by the import corpus (`scripts/corpus/manifest.json`, entry `snowflake-sqldbm-adventureworksdw`, pinned 2026-11-09).
- Files (`site/sfguides/src/database-modeling-with-sqldbm/assets/` upstream, `assets/` here):
  - https://raw.githubusercontent.com/Snowflake-Labs/sfquickstarts/4816f22b2e9fba6de36d1bd02dff79996a556a6d/site/sfguides/src/database-modeling-with-sqldbm/assets/sample_schema.sql
- SHA-256:
  - `assets/sample_schema.sql` (19,461 bytes): `df3722567a6a699970e18db248c0e797ee9e8f019226896586b196031b15ce81`
- Downloaded 2026-11-09; each file's SHA-256 checked against the pinned manifest.

## Licence

Apache-2.0 (Snowflake-Labs/sfquickstarts, `LICENSE`). The model is AdventureWorksDW, Microsoft's sample data
warehouse, published under the MIT licence in microsoft/sql-server-samples. Both licences are in `UPSTREAM-LICENSE.txt`;
the file is unchanged.

## What was copied

- `site/sfguides/src/database-modeling-with-sqldbm/assets/sample_schema.sql`, byte for byte, as `assets/sample_schema.sql`.
- Nothing else from the repository.

## Expected counts

Read back from fakesnow 0.12.1 after `create database ADVENTUREWORKSDW` (the script expects the database to exist).
fakesnow drops column `COMMENT`s, so those are read from sqlglot's parse of each statement that ran (`commentVia`), and
the 4 foreign keys to a table not created yet are read from the parse too (DuckDB checks that the table exists; Snowflake
does not). `TIMESTAMP_NTZ(9)` reads back as `TIMESTAMP_NTZ`: 9 is the default precision (an equivalence in
`differences.json`). Cross-checked against `scripts/corpus/count_source.py`: the same 23 tables, 284 columns, 15 keys and
36 foreign keys.

- Tables: **23**
- Columns: **284**
- Primary keys: **15**
- Foreign keys / relationships: **36**
- Descriptions (tables and columns): **25**

| Schema | Table | Columns | Primary key | Foreign keys (column → target) |
|---|---|---|---|---|
| EDW | DimAccount | 10 | AccountKey | – |
| EDW | DimCurrency | 3 | CurrencyKey | – |
| EDW | DimCustomer | 29 | CustomerKey | GeographyKey → DimGeography |
| EDW | DimDate | 19 | DateKey | – |
| EDW | DimDepartmentGroup | 3 | DepartmentGroupKey | – |
| EDW | DimEmployee | 30 | EmployeeKey | ParentEmployeeKey → DimEmployee; SalesTerritoryKey → DimSalesTerritory |
| EDW | DimGeography | 11 | GeographyKey | – |
| EDW | DimOrganization | 5 | OrganizationKey | – |
| EDW | DimProduct | 33 | ProductKey | ProductSubcategoryKey → DimProductSubcategory |
| EDW | DimProductCategory | 5 | ProductCategoryKey | – |
| EDW | DimProductSubcategory | 6 | ProductSubcategoryKey | ProductCategoryKey → DimProductCategory |
| EDW | DimPromotion | 14 | PromotionKey | – |
| EDW | DimReseller | 20 | ResellerKey | GeographyKey → DimGeography |
| EDW | DimSalesTerritory | 5 | SalesTerritoryKey | – |
| EDW | DimScenario | 7 | ScenarioKey | – |
| EDW | FactCurrencyRate | 4 | – | CurrencyKey → DimCurrency; DateKey → DimDate |
| EDW | FactFinance | 7 | – | AccountKey → DimAccount; DateKey → DimDate; DepartmentGroupKey → DimDepartmentGroup; OrganizationKey → DimOrganization; ScenarioKey → DimScenario |
| EDW | FactInternetSales | 23 | – | CurrencyKey → DimCurrency; CustomerKey → DimCustomer; DueDateKey → DimDate; OrderDateKey → DimDate; ProductKey → DimProduct; PromotionKey → DimPromotion; SalesTerritoryKey → DimSalesTerritory; ShipDateKey → DimDate |
| EDW | FactProductInventory | 7 | – | DateKey → DimDate |
| EDW | FactResellerSales | 24 | – | CurrencyKey → DimCurrency; DueDateKey → DimDate; EmployeeKey → DimEmployee; OrderDateKey → DimDate; ProductKey → DimProduct; PromotionKey → DimPromotion; ResellerKey → DimReseller; SalesTerritoryKey → DimSalesTerritory; ShipDateKey → DimDate |
| EDW | FactSalesQuota | 6 | – | DateKey → DimDate |
| EDW | FactSurveyResponse | 7 | – | DateKey → DimDate; ProductCategoryKey → DimProductCategory |
| EDW | NewFactCurrencyRate | 6 | – | CurrencyKey → DimCurrency; DateKey → DimDate |
