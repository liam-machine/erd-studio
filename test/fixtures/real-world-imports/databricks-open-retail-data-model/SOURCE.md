# Open Retail Data Model, canonical core (Databricks)

Import type: **SQL DDL, Databricks / Spark SQL**.

## What it is

The canonical core of the Open Retail Data Model (ORDM), published by Databricks
Industry Solutions. It is the conformed "silver" layer of a retail data model:
customer, product, store, order, sales, payment, supplier, procurement,
inventory, logistics, equipment, labor, marketing, calendar and interaction.
There is one Delta table per file, written for Unity Catalog.

Each domain folder holds `tables/*.sql` (one `CREATE TABLE IF NOT EXISTS ...
USING DELTA` each), a `relationships.sql` that adds the informational foreign
keys and `CHECK` constraints with `ALTER TABLE` after the tables exist, and
sometimes a `masks.sql` (column-mask functions). Import the whole
`canonical-core/` folder: most foreign keys point at tables in another
domain's folder.

Every table name is templated: `${catalog}.${customer_schema}.profile`. The
`${...}` placeholders are filled in by the project's deploy tooling, so an
importer sees them as they are. There are 15 schema placeholders, one per domain.

Upstream marks these files "LLM-generated: true (maintainer-reviewed before
release)". They are still the real, published DDL of a Databricks project.

## Where it came from

- Project: https://github.com/databricks-industry-solutions/open-retail-data-model (Databricks Industry Solutions organisation)
- Pin: commit `fb0ceba6ff3d6b288ce89eb278ad285b4088ae5d` on `main` (2026-10-16). The repo `VERSION` file says `0.5`. `canonical-core/` last changed in `43d983d0397a02b2ee3af4b190a55356361eb772` (2026-10-14).
- Files: `https://raw.githubusercontent.com/databricks-industry-solutions/open-retail-data-model/fb0ceba6ff3d6b288ce89eb278ad285b4088ae5d/canonical-core/<domain>/...`
- Downloaded 2026-11-07. All 51 copied files are byte for byte the same as upstream at the pin.

## Licence

Apache-2.0 (repo `LICENSE.md`). The repo also has a `NOTICE.md`
("Copyright 2026 Databricks, Inc. and the Open Retail Data Model
contributors"). Redistribution is allowed with the licence and the notice kept.
Both are copied, notice first, into `UPSTREAM-LICENSE.txt`. The files are not
modified.

## What was copied

- `canonical-core/<domain>/tables/*.sql`: 34 files, one table each.
- `canonical-core/<domain>/relationships.sql`: 15 files, foreign keys and `CHECK` constraints.
- `canonical-core/customer/masks.sql` and `canonical-core/interaction/masks.sql`: `CREATE OR REPLACE FUNCTION` mask functions and `ALTER COLUMN ... SET MASK`. Kept because a real folder import meets them.
- Upstream folder layout kept. About 280 KB in all.
- Not copied: each domain's `checks.sql` (data-quality `SELECT` queries, not DDL), `README.md`, `glossary.md` and `diagrams/` (Mermaid, SVG and DBML). Also not copied: the 12 outcome packages (gold tables and views that build on the core), the explorer app, tests, tools and synthetic data.

## Expected counts

Counted by a small Python script (not ERD Studio). It strips `--` comments
outside strings, finds each `CREATE TABLE ... (`, matches the body's brackets,
and splits it on top-level commas. An entry is a column unless it starts with
`CONSTRAINT`, `PRIMARY KEY`, `FOREIGN KEY`, `CHECK (` or `UNIQUE (`. Foreign keys
are the `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (...) REFERENCES ...`
statements in the `relationships.sql` files. The column total was checked a
second way, by counting column lines between `CREATE TABLE` and the
`CONSTRAINT pk_` line in each file (635 both ways).

- Tables: **34** (all `CREATE TABLE IF NOT EXISTS` with a column list; no CTAS, no views)
- Columns: **635**
- Primary keys: **34**, all single-column, all a table-level `CONSTRAINT pk_<table> PRIMARY KEY (<x>_sk)` on a `BIGINT GENERATED ALWAYS AS IDENTITY` surrogate
- Foreign keys / relationships: **43**, all single-column, all many-to-one, all declared by `ALTER TABLE` in `relationships.sql` (none inline). 25 of them cross from one domain schema to another. No self-references, no two links between the same pair of tables.

| Domain (schema placeholder) | Table | Columns | Primary key | Foreign keys (column → target) |
|---|---|---|---|---|
| calendar | fiscal_calendar | 23 | date_sk | – |
| calendar | fx_rate | 10 | fx_rate_sk | – |
| customer | account | 23 | account_sk | primary_contact_profile_sk → profile |
| customer | address | 22 | address_sk | profile_sk → profile |
| customer | channel_preference | 17 | channel_preference_sk | profile_sk → profile |
| customer | consent | 20 | consent_sk | profile_sk → profile |
| customer | contact | 15 | contact_sk | profile_sk → profile |
| customer | household | 12 | household_sk | – |
| customer | identity_link | 17 | identity_link_sk | profile_sk → profile |
| customer | profile | 23 | profile_sk | household_sk → household |
| equipment | equipment | 23 | equipment_sk | store_sk → store.store |
| equipment | equipment_reading | 16 | equipment_reading_sk | equipment_sk → equipment |
| interaction | touchpoint | 32 | touchpoint_sk | identity_link_sk → customer.identity_link; profile_sk → customer.profile; product_sk → product.product; store_sk → store.store |
| inventory | inventory_position | 18 | inventory_position_sk | product_sk → product.product; store_sk → store.store |
| labor | employee | 23 | employee_sk | home_store_sk → store.store |
| labor | employee_availability | 11 | employee_availability_sk | employee_sk → employee |
| labor | employee_skill | 11 | employee_skill_sk | employee_sk → employee |
| labor | employee_store_eligibility | 12 | employee_store_eligibility_sk | employee_sk → employee; store_sk → store.store |
| labor | labor_actuals | 17 | labor_actuals_sk | employee_sk → employee; store_sk → store.store; labor_schedule_sk → labor_schedule |
| labor | labor_schedule | 16 | labor_schedule_sk | employee_sk → employee; store_sk → store.store |
| logistics | lane | 21 | lane_sk | – |
| logistics | shipment | 18 | shipment_sk | supplier_sk → supplier.supplier; lane_sk → lane; destination_store_sk → store.store |
| logistics | shipment_line | 15 | shipment_line_sk | shipment_sk → shipment; product_sk → product.product; po_line_sk → procurement.purchase_order_line |
| logistics | shipment_tracking | 31 | shipment_tracking_sk | shipment_sk → shipment |
| marketing | audience | 21 | audience_sk | – |
| marketing | promotion | 21 | promo_sk | – |
| order | customer_order_line | 18 | order_line_sk | profile_sk → customer.profile; product_sk → product.product; store_sk → store.store |
| payment | payment | 14 | payment_sk | profile_sk → customer.profile |
| procurement | purchase_order_line | 23 | po_line_sk | supplier_sk → supplier.supplier; product_sk → product.product; store_sk → store.store |
| product | product | 25 | product_sk | – |
| product | product_price | 15 | product_price_sk | product_sk → product |
| store | store | 19 | store_sk | – |
| supplier | supplier | 16 | supplier_sk | – |
| transaction | sales | 17 | sales_sk | product_sk → product.product; store_sk → store.store; promo_sk → marketing.promotion |

Most referenced: `store` (11 foreign keys point at it), `profile` (9),
`product` (7), `employee` (5). Three tables have no relationship at all:
`fiscal_calendar`, `fx_rate` and `audience`. `household`, `lane`,
`promotion`, `product`, `store` and `supplier` are parents only.

Data types: STRING 299, TIMESTAMP 88, BIGINT 78, DATE 67, BOOLEAN 33, INT 29,
DOUBLE 3, and 38 `DECIMAL(p,s)` columns in 11 sizes (from `DECIMAL(5,2)` to
`DECIMAL(18,8)`).

## Notable features

- **Templated names.** Every table is `${catalog}.${<domain>_schema}.<table>`, in `CREATE TABLE`, `ALTER TABLE` and `REFERENCES`. 15 schema placeholders. An importer has to keep the table name and either keep, drop or tidy the `${...}` schema.
- **Foreign keys in separate files.** All 43 come from `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` in `relationships.sql`, which runs after the table files. 25 point into another domain's schema and folder.
- **Comments everywhere.** All 635 columns and all 34 tables have a `COMMENT '...'`. Some column comments are long and hold commas, brackets, `=` and `|`. 85 column comments contain a `;` inside the quotes, so a statement splitter that splits on every `;` breaks those tables. None has an escaped quote. The table comment sits after `USING DELTA ... TBLPROPERTIES (...)`.
- **Identity columns.** All 34 primary keys are `BIGINT GENERATED ALWAYS AS IDENTITY`, with the `COMMENT` on the next line.
- **NOT NULL** on 149 columns.
- **Delta options.** `USING DELTA`, `CLUSTER BY (...)` (liquid clustering, one or two columns) and `TBLPROPERTIES (delta.enableDeletionVectors = true)` on every table. Comment lines sit between these clauses.
- **CHECK constraints.** 101 of them, all added with `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)`, in `relationships.sql` and in some table files. They encode enums ("Allowed values" in the column comments) and ranges.
- **Unity Catalog tags.** 58 `ALTER TABLE ... SET TAGS (...)` and `ALTER COLUMN ... SET TAGS (...)` statements in the table files (table role and PII flags).
- **Column masks.** `masks.sql` has 4 `CREATE OR REPLACE FUNCTION` statements with SQL bodies and 16 `ALTER COLUMN ... SET MASK`. No tables there.
- **Relationships only in comments.** Each `relationships.sql` lists business-key joins (for example `account.parent_account_id -> account.account_id`, a self-reference) in a comment block, on purpose not declared, because under SCD2 the business key is not unique. An importer should not create these.
- **SCD2 masters.** Many tables carry `effective_from_date`, `effective_to_date`, `is_current` and a durable `<x>_id` business key next to the `<x>_sk` surrogate.
- **Primary keys not named `<table>_sk`.** `fiscal_calendar.date_sk`, `promotion.promo_sk`, `customer_order_line.order_line_sk`, `purchase_order_line.po_line_sk`.
- **Not present:** STRUCT, ARRAY, MAP and VARIANT types, views, CTAS, `DEFAULT` values, generated (computed) columns other than identity, `PARTITIONED BY`, composite keys, many-to-many link tables and quoted or mixed-case names. All names are lower-case snake_case.
