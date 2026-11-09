# TPC-H derived benchmark tables (Amazon Redshift)

Import type: **SQL DDL, Amazon Redshift**. Pick `3TB/ddl.sql` in **Import SQL DDL…**; the dialect is detected.

## What it is

AWS's Cloud Data Warehouse Benchmark derived from TPC-H, as published in `amazon-redshift-utils`: the eight
TPC-H tables with Redshift's table attributes (`distkey(…)`, `sortkey(…)`), then the `COPY` commands that load them
from S3 and a `SELECT count(*)` per table. Each table's `Primary Key(C_CUSTKEY)` names its columns in upper case
against lower-case column definitions: unquoted names fold case, so they are the same columns.

Before the Redshift dialect nothing imported: the keys' case did not match their columns, the converted DBML did
not read, and the problem pointed into the generated DBML instead of `ddl.sql`.

## Where it came from

- Project: https://github.com/awslabs/amazon-redshift-utils
- Pin: commit `f208c1100370eebca8b38d3e7d0654fb337e3463` (`master`), as pinned by the import corpus (`scripts/corpus/manifest.json` in this repository, pinned 2026-11-09).
- Files (`src/CloudDataWarehouseBenchmark/Cloud-DWB-Derived-from-TPCH/3TB/` upstream, `3TB/` here):
  - https://raw.githubusercontent.com/awslabs/amazon-redshift-utils/f208c1100370eebca8b38d3e7d0654fb337e3463/src/CloudDataWarehouseBenchmark/Cloud-DWB-Derived-from-TPCH/3TB/ddl.sql
- SHA-256:
  - `3TB/ddl.sql` (5,324 bytes): `f028f8981aab99cca7d84154f56910414d776d2372dcc84efa0960adf57ff033`
- Downloaded 2026-11-09; each file's SHA-256 checked against the pinned manifest.

## Licence

Apache-2.0 (`LICENSE.txt` at the repository root, with its `NOTICE.txt`: "Amazon Redshift Column Encoding
Utility, Copyright 2014 Amazon.com, Inc. or its affiliates"). Both are copied to `UPSTREAM-LICENSE.txt`; the file is
unchanged.

## What was copied

- `3TB/ddl.sql`, byte for byte.
- Nothing else from the repository.

## Expected counts

Counted structurally over the upstream file (sqlglot 27.29 cannot read Redshift's distkey/sortkey table attributes), never through ERD Studio, types as written. Each table's Primary Key(...) names its columns in upper case against lower-case column definitions: unquoted names fold case, so they are the same columns (pk lists the columns as defined). The file declares no foreign keys; its 8 COPY and 8 SELECT statements are data and queries, not design.

- Tables: **8**
- Columns: **61**
- Primary keys: **8**
- Foreign keys / relationships: **0**
- Descriptions: **0**

| Table | Columns | Primary key | Foreign keys (column → target) |
|---|---|---|---|
| customer | 8 | c_custkey | – |
| lineitem | 16 | l_orderkey, l_linenumber | – |
| nation | 4 | n_nationkey | – |
| orders | 9 | o_orderkey | – |
| part | 9 | p_partkey | – |
| partsupp | 5 | ps_partkey, ps_suppkey | – |
| region | 3 | r_regionkey | – |
| supplier | 7 | s_suppkey | – |
