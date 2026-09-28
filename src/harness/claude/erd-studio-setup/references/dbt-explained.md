# Plain-English glossary

Use these definitions the first time a term comes up. Each is short on purpose: say the one
line, then get back to the task. If the user wants more, expand in your own words.

## dbt

| Term | Say this |
|---|---|
| **dbt** | A tool that turns SQL files into tables and views in a data warehouse, in the right order. Your team writes the SQL; dbt runs it. |
| **model** | One SQL file in a dbt project, which becomes one table or view. `fct_order.sql` builds `fct_order`. |
| **seed** | A small CSV file dbt loads into the warehouse as a table — handy for lookup lists like country codes. |
| **snapshot** | A dbt model that keeps history: it records how rows change over time instead of overwriting them. |
| **schema yml** | A `.yml` file next to the SQL that describes models: their columns, descriptions and tests. |
| **`data_type:`** | An optional line in a schema yml that states a column's type, e.g. `data_type: varchar`. |
| **test** | A check dbt runs on the data. `unique` says a column has no duplicates; `not_null` says it is never empty. |
| **`relationships` test** | A test saying every value in one column exists in another table's column — in other words, a link between two tables. ERD Studio draws these as lines. |
| **manifest.json** | dbt's map of the whole project — every model, column and test. `dbt parse` writes it in seconds, without touching the warehouse. |
| **catalog.json** | The real column names and types, read from the warehouse. `dbt docs generate` (or `dbt compile --write-catalog` on dbt Fusion) writes it, and it needs a live connection. |
| **profiles.yml** | The file that tells dbt which warehouse to connect to and how to sign in. It usually lives in `~/.dbt/` so passwords stay out of the project. |
| **adapter** | The plug-in that lets dbt talk to one kind of warehouse, e.g. `dbt-snowflake` or `dbt-duckdb`. |
| **warehouse** | The database where your company's analytics data lives — Snowflake, BigQuery, Databricks, Postgres, DuckDB and so on. |
| **venv** (virtual environment) | A private folder of Python tools for one project, often called `.venv`, so its versions do not clash with anything else on the computer. |
| **dbt Core** | The free, open-source dbt you install on your own computer (version 1.x). |
| **dbt Fusion** | dbt's newer, faster engine (version 2.x). It reads the same projects. |
| **dbt Cloud CLI** | A command-line tool that runs your project on dbt's hosted platform instead of your own computer. |

## ERD Studio

| Term | Say this |
|---|---|
| **ERD** | Entity-relationship diagram: boxes for tables, lines for how they connect. |
| **logical vs physical** | *Physical* is what really exists in the dbt project, worked out by ERD Studio and read-only. *Logical* is your design — the tables, keys and connections you mean to have. |
| **domain** | One focused diagram of related tables for one business area, like "orders". Saved as `.erd-studio/<layer>/<domain>.json`. |
| **layer** | A folder for organising diagrams, usually a stage of the warehouse such as silver (cleaned) or gold (ready for reporting). |
| **logical model file** | One `.erd-studio/logical-models/<name>.yml` per table (or `logical-models/<layer>/<name>.yml` in a library grouped by layer), holding its columns and keys. Shared by every domain that uses the table. |
| **PK** (primary key) | The column that uniquely identifies each row, like `order_id`. |
| **FK** (foreign key) | A column that points at another table's primary key, like `customer_id` in an orders table. |
| **NK** (natural key) | The real-world identifier a source system uses, like a customer code or product code, as opposed to an ID made up inside the warehouse. |
| **grain** | What one row means: "one row per order", "one row per customer per day". |
| **cardinality** | How many rows on each side of a link can match: *many-to-one* means many orders belong to one customer. |
| **fact / dimension** | A *fact* table records events or measurements (orders, payments); a *dimension* describes things (customers, products). |
| **drift** | Any difference between the logical design and what dbt actually has — a missing column, a different type, a missing link. |
| **diff** | ERD Studio's comparison of logical against physical. The same check as the **⊕ Diff** button in the canvas toolbar. |
| **canvas** | The diagram view inside VS Code where ERD Studio draws a domain. |
| **ghost / phantom** | A table in the diagram that the dbt project does not have — usually a typo or something not built yet. |

## Modelling styles

| Term | Say this |
|---|---|
| **modelling approach** | The rules your team follows when designing tables — a named method like Kimball or Data Vault, or your own house rules. Saved in `.erd-studio/modelling-approach.md`. |
| **Kimball / star schema** | The most common analytics style: a fact table in the middle, joined to the dimension tables that describe it, like a star. |
| **surrogate key** | A made-up ID the warehouse assigns to each row (like `customer_sk`), used instead of the source system's own ID so joins stay stable. |
| **SCD** (slowly changing dimension) | How a dimension handles changes: Type 0 never changes, Type 1 overwrites the old value, Type 2 adds a new row so history is kept. |
| **conformed dimension** | One dimension, such as customer or date, shared by every business area so their numbers line up. |
| **additive measure** | A number you can add up across everything (sales amount). *Semi-additive* adds up across some things but not time (a bank balance); *non-additive* never adds up (a percentage). |
| **snowflaked dimension** | A dimension split into several linked tables (product → category → department) instead of one flat table. |
| **Data Vault** | A style built from *hubs* (one row per business key, like each customer number), *links* (connections between hubs) and *satellites* (descriptive details, with full history). |
| **Inmon / 3NF** | A style that keeps a central, fully normalised warehouse — each fact stored once — and builds reporting marts from it. |
| **One Big Table** | A style that pre-joins everything into one wide table per analysis, so reports need no joins. |
| **target design** | A logical model that shows where you *want* the dbt project to get to. Its differences from dbt are intentional — a to-do list, not errors. |
