# databricks/probe.csv

- **Platform:** Azure Databricks, serverless SQL warehouse (dbsql 2026.44, Spark 4.2.0), Unity Catalog.
- **Exported:** 2026-11-11, through the SQL editor's **Download CSV** (the file the browser saved is byte-identical to the same query's result through the API).
- **Query:** `query-as-run.sql` (the shipped `../queries/databricks.sql` without its `total_rows` column, so this file has no truncation check).
- **Schema:** a synthetic probe schema made for this test (two schemas, `probe_ref` and `probe_sales`): no real data, names or comments.
- **Changed after export:** the catalog's name is replaced with `my_catalog` everywhere it appears. Nothing else.

What it shows: `ordinal_position` is 0-based in Unity Catalog's `information_schema.columns`; `full_data_type` holds whole types (`varchar(3)`, `decimal(18,4)`, `struct<a:int,b:array<string>>`); a column in two foreign keys is two rows (`order_line_note.ord_id`); a composite foreign key pairs by `fk_ordinal`; comments keep commas, doubled quotes, backslashes and line breaks; the view's rows say `VIEW` in `table_type`. Unity Catalog's `information_schema` reports no column default or identity for these tables (`type_zoo.id` is an identity column and `c_string` has a default; the export shows neither).
