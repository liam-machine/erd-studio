# Real-time Data Vault (Snowflake)

Import type: **SQL DDL, Snowflake**. Pick the five `.sql` files in **Import SQL DDL…**; the dialect is detected (Snowflake).

## What it is

A real-time Data Vault 2.0 on Snowflake, built from TPC-H sample data: a staging area fed by Snowpipe (`l00_stg`),
a raw vault of hubs, links, satellites and reference tables (`l10_rdv`), a business vault (`l20_bdv`) and information
delivery views (`l30_id`). The tables sit among the warehouse, streams, stages, pipes, tasks whose bodies are
`MERGE` statements, views and the queries the walkthrough runs. Each schema is set by `USE SCHEMA`, and names are
unquoted (Snowflake reads them in upper case).

What it adds to the samples: composite primary keys (`PRIMARY KEY(sha1_hub_customer, ldts)`), `FOREIGN KEY (c) REFERENCES
hub_customer` with no column list (the referenced table's primary key), `BINARY` hash keys, and five
`CREATE TABLE ... AS SELECT` tables, three of them (`ref_region`, `ref_nation`, `sat_order_bv`) with a full column list,
primary key and foreign key before the `AS SELECT`.

## Where it came from

- Project: https://github.com/dandekarp/RealTime-DataVault_Snowflake
- Pin: commit `d6a29ab7aaaec811d5fb28758e35529a8ce87ee1`, as pinned by the import corpus (`scripts/corpus/manifest.json`, entry `snowflake-realtime-datavault`, pinned 2026-11-09).
- Files (the repository root):
  - https://raw.githubusercontent.com/dandekarp/RealTime-DataVault_Snowflake/d6a29ab7aaaec811d5fb28758e35529a8ce87ee1/environment_setup.sql
  - https://raw.githubusercontent.com/dandekarp/RealTime-DataVault_Snowflake/d6a29ab7aaaec811d5fb28758e35529a8ce87ee1/staging.sql
  - https://raw.githubusercontent.com/dandekarp/RealTime-DataVault_Snowflake/d6a29ab7aaaec811d5fb28758e35529a8ce87ee1/raw_data_vault.sql
  - https://raw.githubusercontent.com/dandekarp/RealTime-DataVault_Snowflake/d6a29ab7aaaec811d5fb28758e35529a8ce87ee1/business_data_vault.sql
  - https://raw.githubusercontent.com/dandekarp/RealTime-DataVault_Snowflake/d6a29ab7aaaec811d5fb28758e35529a8ce87ee1/information_delivery.sql
- SHA-256:
  - `environment_setup.sql` (1,334 bytes): `54cb269785e56c0baf2235396d7fa70fbf200ae5c4e47928974dd9b8e715d3b1`
  - `staging.sql` (5,403 bytes): `a6fd41af96e78d7018fc4d39f2ef448c8fe0e9d04b9064b2e41c15e100508676`
  - `raw_data_vault.sql` (7,518 bytes): `f61750d196bb9c6fe2f2e67f808bcbcf940434ab445eddd5a815c3b1ec2e81b1`
  - `business_data_vault.sql` (3,776 bytes): `c6e09cb68dc188d3182b5e70ab56263613003a151a23219b41ff7af361caac42`
  - `information_delivery.sql` (3,400 bytes): `effc42764220613139c5bb29339524fd1d63c755cad6431cab92475a1e4dc200`
- Downloaded 2026-11-09; each file's SHA-256 checked against the pinned manifest.

## Licence

Apache-2.0 (the repository's `LICENSE`, by dandekarp). The licence text is copied to `UPSTREAM-LICENSE.txt`;
the files are unchanged. The repository has no `NOTICE` file and the files carry no header.

## What was copied

- The five `.sql` files at the repository root, byte for byte: `environment_setup.sql`, `staging.sql`, `raw_data_vault.sql`,
  `business_data_vault.sql`, `information_delivery.sql`.
- Nothing else (the repository holds only these, a `README.md` and the licence).

## Expected counts

Read back from fakesnow 0.12.1 (test/real-world-truth/, `snowflake_readback.py`), the files run in the Data Vault's
own order (the README gives none): environment, staging, raw vault, business vault, delivery. The staging tables copy
`NATION` and `REGION` from the `SNOWFLAKE_SAMPLE_DATA` share every Snowflake account has, so those two are created first
as the share defines them. fakesnow cannot take a column list with `AS SELECT` (the three tables are created from
their column list, which is what sets their columns) or a foreign key to another schema (`sat_order_bv` → `l10_rdv.hub_order`,
read from sqlglot's parse); both are listed under `workarounds` in the read-back. Names and types are as the files write
them. Cross-checked against `scripts/corpus/count_source.py` (sqlglot 27.29.0), which reads 10 tables, 76 columns, 8 keys and
6 relationships and agrees with the read-back on those tables' column names and primary keys. It does not count the two `SELECT src.*`
tables, `stg_nation` and `stg_region` (11 columns: "no column list … not counted"): their columns come only from the
read-back, from the share's `NATION` and `REGION` as `test/real-world-truth/readback.py` defines them (TPC-H's columns, by hand), plus the two the query adds.

- Tables: **12**
- Columns: **87**
- Primary keys: **8**
- Foreign keys / relationships: **6**
- Descriptions (tables and columns): **0**

| Schema | Table | Columns | Primary key | Foreign keys (column → target) |
|---|---|---|---|---|
| L00_STG | stg_customer | 5 | – | – |
| L00_STG | stg_nation | 6 | – | – |
| L00_STG | stg_orders | 13 | – | – |
| L00_STG | stg_region | 5 | – | – |
| L10_RDV | hub_customer | 4 | sha1_hub_customer | – |
| L10_RDV | hub_order | 4 | sha1_hub_order | – |
| L10_RDV | lnk_customer_order | 5 | sha1_lnk_customer_order | sha1_hub_customer → hub_customer; sha1_hub_order → hub_order |
| L10_RDV | ref_nation | 6 | nationcode | regioncode → ref_region |
| L10_RDV | ref_region | 5 | regioncode | – |
| L10_RDV | sat_customer | 11 | sha1_hub_customer, ldts | sha1_hub_customer → hub_customer |
| L10_RDV | sat_order | 11 | sha1_hub_order, ldts | sha1_hub_order → hub_order |
| L20_BDV | sat_order_bv | 12 | sha1_hub_order, ldts | sha1_hub_order → hub_order |
