# Bring in the data model you already have

Your data model probably exists already: as tables in Databricks or Snowflake, as a Power BI or Fabric semantic model, in a database, or in a modelling tool. ERD Studio turns it into DBML, an open format your team can read, review and diff in Git, and that other DBML tools open. ERD Studio is free to use, source available under the PolyForm Shield License.

The same steps are inside ERD Studio: run **ERD Studio: Bring In Your Data Model…**, or choose it under **More ways to start…** on the walkthrough or the empty **Diagrams** view. Each card there has a **Copy** button for its command and a button that runs the right import, with the source already chosen.

Every import works the same way once you have the files: you pick the files (or a folder), a layer and a name, and ERD Studio shows what it will create before anything is written. A table whose name your project already has is used as it is only when it has the same columns; otherwise the import keeps the file's table as its own, named after the new diagram (`warehouse_customer`), and the draft says so (step by step, it asks first). **Review All…** lists every table, relationship and anything it left out: from SQL scripts, anything that is not a table (views, indexes, grants and the like) is listed as not imported. **ERD Studio: Show Import Report** (also a link on the draft) lists what the last import imported, repaired, could not import and skipped, grouped and counted, each with its file and line. A large set of SQL scripts shows its progress with a **Cancel** button and stops at a time limit (two minutes by default; the `erdStudio.import.timeLimitSeconds` setting changes it, `0` for none): either way the tables read so far are imported, and the report lists the rest from the line where each file stopped. Nothing leaves your machine.

A lakehouse often declares no foreign keys, so its import has tables and no relationships. When the new diagram has none, ERD Studio offers **Review Suggestions**: the relationships the column names and keys point at, each with its reasons, only the ones a declared key backs ticked. Nothing is added until you press OK, and **Edit > Undo** takes them all back. **ERD Studio: Suggest Relationships…** runs the same review on any diagram.

- [Databricks (Unity Catalog)](#databricks-unity-catalog)
- [Snowflake](#snowflake)
- [Power BI](#power-bi)
- [Microsoft Fabric](#microsoft-fabric)
- [SQL Server and Azure SQL](#sql-server-and-azure-sql)
- [PostgreSQL](#postgresql)
- [MySQL and MariaDB](#mysql-and-mariadb)
- [Oracle](#oracle)
- [Google BigQuery](#google-bigquery)
- [Amazon Redshift](#amazon-redshift)
- [SQLite](#sqlite)
- [DuckDB](#duckdb)
- [A catalog export from another database](#a-catalog-export-from-another-database)
- [dbdiagram.io and other DBML tools](#dbdiagramio-and-other-dbml-tools)
- [Other modelling tools](#other-modelling-tools)
- [dbt](#dbt)
- [Not yet](#not-yet)

## Databricks (Unity Catalog)

Export the `CREATE TABLE` statements of a whole schema in one notebook cell. Declared `PRIMARY KEY` and `FOREIGN KEY` constraints become keys and relationships.

Run this in a Python notebook cell, with your catalog and schema, then copy what it prints into `schema.sql` in your project folder:

```python
catalog, schema = "main", "sales"  # your catalog and schema
tables = spark.sql(f"""
  SELECT table_name FROM {catalog}.information_schema.tables
  WHERE table_schema = '{schema}' AND table_type IN ('MANAGED', 'EXTERNAL')
""").collect()
for t in tables:
    ddl = spark.sql(f"SHOW CREATE TABLE `{catalog}`.`{schema}`.`{t.table_name}`").first()[0]
    print(ddl.rstrip().rstrip(";") + ";\n")
```

Then run **ERD Studio: Import SQL DDL…**, pick the file and choose **Databricks / Spark SQL** (the guide's **Import Databricks DDL…** button chooses it for you). Delta settings (`USING DELTA`, `TBLPROPERTIES`, `CLUSTER BY`, `LOCATION`) are left out; `ARRAY`, `STRUCT` and `MAP` columns keep their types.

This keeps column defaults and identity columns. A comment with a backslash in it can come in changed: `SHOW CREATE TABLE` writes the backslash as it is.

**Or one query, downloaded as CSV.** No notebook and nothing to copy by hand: run this in the SQL editor with your catalog on its `WHERE` line, and download the whole result as CSV into your project folder.

```sql
-- One row per column of every table and view in a catalog, for ERD Studio. Put your catalog on the WHERE line.
SELECT c.table_schema,
       c.table_name,
       t.table_type,
       coalesce(t.comment, '') AS table_comment,
       c.column_name,
       c.ordinal_position,
       c.full_data_type AS data_type,
       c.is_nullable,
       coalesce(c.column_default, '') AS column_default,
       coalesce(c.comment, '') AS column_comment,
       CASE WHEN pk.column_name IS NOT NULL THEN 'YES' ELSE 'NO' END AS is_primary_key,
       coalesce(cast(pk.ordinal_position AS STRING), '') AS pk_ordinal,
       coalesce(fk.constraint_name, '') AS fk_constraint_name,
       coalesce(cast(fk.fk_ordinal AS STRING), '') AS fk_ordinal,
       coalesce(fk.fk_table_catalog, '') AS fk_table_catalog,
       coalesce(fk.fk_table_schema, '') AS fk_table_schema,
       coalesce(fk.fk_table, '') AS fk_table,
       coalesce(fk.fk_column, '') AS fk_column,
       count(*) OVER () AS total_rows
FROM system.information_schema.columns c
JOIN system.information_schema.tables t
  ON t.table_catalog = c.table_catalog AND t.table_schema = c.table_schema AND t.table_name = c.table_name
LEFT JOIN (
  SELECT k.table_catalog, k.table_schema, k.table_name, k.column_name, k.ordinal_position
  FROM system.information_schema.table_constraints tc
  JOIN system.information_schema.key_column_usage k
    ON k.constraint_catalog = tc.constraint_catalog AND k.constraint_schema = tc.constraint_schema AND k.constraint_name = tc.constraint_name
   AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name
  WHERE tc.constraint_type = 'PRIMARY KEY'
) pk ON pk.table_catalog = c.table_catalog AND pk.table_schema = c.table_schema AND pk.table_name = c.table_name AND pk.column_name = c.column_name
LEFT JOIN (
  SELECT k.table_catalog, k.table_schema, k.table_name, k.column_name, k.constraint_name, k.ordinal_position AS fk_ordinal,
         r.table_catalog AS fk_table_catalog, r.table_schema AS fk_table_schema, r.table_name AS fk_table, r.column_name AS fk_column
  FROM system.information_schema.table_constraints tc
  JOIN system.information_schema.key_column_usage k
    ON k.constraint_catalog = tc.constraint_catalog AND k.constraint_schema = tc.constraint_schema AND k.constraint_name = tc.constraint_name
   AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name
  JOIN system.information_schema.referential_constraints rc
    ON rc.constraint_catalog = k.constraint_catalog AND rc.constraint_schema = k.constraint_schema AND rc.constraint_name = k.constraint_name
  JOIN system.information_schema.key_column_usage r
    ON r.constraint_catalog = rc.unique_constraint_catalog AND r.constraint_schema = rc.unique_constraint_schema AND r.constraint_name = rc.unique_constraint_name
   AND r.ordinal_position = k.position_in_unique_constraint
  WHERE tc.constraint_type = 'FOREIGN KEY'
) fk ON fk.table_catalog = c.table_catalog AND fk.table_schema = c.table_schema AND fk.table_name = c.table_name AND fk.column_name = c.column_name
WHERE c.table_catalog = 'my_catalog'
  AND c.table_schema <> 'information_schema'
ORDER BY c.table_schema, c.table_name, c.ordinal_position, fk.constraint_name;
```

Then run **ERD Studio: Import SQL DDL…** and pick the `.csv` file (the guide's **Import the CSV…** button). Unity Catalog's `information_schema` does not show column defaults or identity columns, so they do not come in this way. The query counts its own rows (`total_rows`), so a download of only the first rows (the SQL editor offers the first 1,000) is refused rather than imported half.

## Snowflake

Snowflake writes the DDL of a whole schema in one call. Run this in a worksheet and copy the result into a `.sql` file:

```sql
SELECT GET_DDL('SCHEMA', '<database>.<schema>');
```

For a whole database, use `GET_DDL('DATABASE', '<database>')` instead.

Then run **ERD Studio: Import SQL DDL…** and choose **Snowflake**. Anything in the output that is not a table (views, sequences and the like) is skipped and listed as not imported.

## Power BI

A report saved as a Power BI project keeps its semantic model in a `<Name>.SemanticModel` folder, which ERD Studio reads as TMDL or as `model.bim`. A model saved with Tabular Editor's **Save to Folder** (a `database.json` with a `tables/` folder of JSON files beside it) reads too: pick the folder it was saved to.

In Power BI Desktop, choose **File → Save as**, pick **Power BI project files (`*.pbip`)**, and save it in your project folder.

No such option? Turn on **Power BI Project (.pbip) save option** in **File → Options and settings → Options → Preview features**, then restart Power BI Desktop.

Then run **ERD Studio: Import Power BI or Fabric Semantic Model…** and pick the folder.

Tables, columns and relationships come across; DAX measures stay in Power BI. A file that does not read is left out and listed under **Not imported**, with the rest of the model imported.

## Microsoft Fabric

**A semantic model:** connect the workspace to a Git repository (**Workspace settings → Git integration**) and commit. Each semantic model is a `<Name>.SemanticModel` folder in the repository: open the repository in VS Code and run **ERD Studio: Import Power BI or Fabric Semantic Model…**.

**A Warehouse or a Lakehouse's SQL analytics endpoint:** connect to its SQL connection string in SQL Server Management Studio, select the tables in **Object Explorer Details** (F7), right-click → **Script Table as → CREATE To → File…**, and save the `.sql` file in your project folder. Then run **ERD Studio: Import SQL DDL…** and choose **SQL Server / Azure SQL**: keys declared `NOT ENFORCED` come across as keys and relationships.

## SQL Server and Azure SQL

In SQL Server Management Studio, right-click the database → **Tasks → Generate Scripts…**, choose the tables, and on **Set Scripting Options** save to one file in your project folder. Schema only is the default (**Advanced → Types of data to script**). Then run **ERD Studio: Import SQL DDL…** and choose **SQL Server / Azure SQL**. Column descriptions written as `MS_Description` extended properties come across as notes.

## PostgreSQL

`pg_dump` writes the schema without the data. Run this in a terminal in your project folder (add `-n <schema>` for one schema):

```sh
pg_dump --schema-only --no-owner --no-privileges -d <database> -f schema.sql
```

Then run **ERD Studio: Import SQL DDL…** and choose **PostgreSQL**. Keys that `pg_dump` adds afterwards (`ALTER TABLE … ADD CONSTRAINT`) are read with their tables.

**Or one query, saved as CSV** (PostgreSQL 12 or later). Save this as `catalog.sql` in your project folder:

```sql
-- One row per column of every table and view, for ERD Studio (PostgreSQL 12 or later). System schemas and partitions are left out.
SELECT n.nspname AS table_schema,
       c.relname AS table_name,
       CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'BASE TABLE' END AS table_type,
       obj_description(c.oid, 'pg_class') AS table_comment,
       a.attname AS column_name,
       a.attnum AS ordinal_position,
       format_type(a.atttypid, a.atttypmod) AS data_type,
       CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
       pg_get_expr(d.adbin, d.adrelid) AS column_default,
       col_description(c.oid, a.attnum) AS column_comment,
       CASE WHEN pk.ord IS NOT NULL THEN 'YES' ELSE 'NO' END AS is_primary_key,
       pk.ord AS pk_ordinal,
       uq.unique_name AS unique_constraint_name,
       fk.conname AS fk_constraint_name,
       fk.ord AS fk_ordinal,
       fk.ref_schema AS fk_table_schema,
       fk.ref_table AS fk_table,
       fk.ref_column AS fk_column,
       count(*) OVER () AS total_rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
LEFT JOIN LATERAL (
  SELECT k.ord FROM pg_constraint p, unnest(p.conkey) WITH ORDINALITY AS k(attnum, ord)
  WHERE p.conrelid = c.oid AND p.contype = 'p' AND k.attnum = a.attnum
) pk ON true
LEFT JOIN LATERAL (
  -- Each unique key (constraint or index) the column is in, over columns only: never partial or on an expression.
  SELECT ic.relname AS unique_name FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
  WHERE i.indrelid = c.oid AND i.indisunique AND NOT i.indisprimary AND i.indpred IS NULL AND i.indexprs IS NULL
    AND a.attnum = ANY ((i.indkey::int2[])[0:i.indnkeyatts - 1])
) uq ON true
LEFT JOIN LATERAL (
  -- A partitioned table's foreign keys include those declared on its partitions, pointing at the referenced table's root.
  SELECT f.conname, k.ord, rn.nspname AS ref_schema, rc.relname AS ref_table, ra.attname AS ref_column
  FROM pg_constraint f
  CROSS JOIN LATERAL unnest(f.conkey, f.confkey) WITH ORDINALITY AS k(attnum, refattnum, ord)
  JOIN pg_attribute fa ON fa.attrelid = f.conrelid AND fa.attnum = k.attnum
  JOIN pg_attribute ra ON ra.attrelid = f.confrelid AND ra.attnum = k.refattnum
  JOIN pg_class rc ON rc.oid = coalesce(pg_partition_root(f.confrelid), f.confrelid)
  JOIN pg_namespace rn ON rn.oid = rc.relnamespace
  WHERE f.contype = 'f' AND f.conparentid = 0 AND fa.attname = a.attname
    AND (f.conrelid = c.oid OR f.conrelid IN (SELECT relid FROM pg_partition_tree(c.oid)))
) fk ON true
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
  AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'
ORDER BY 1, 2, 6, 13, 14;
```

Run it with `psql`, which writes the CSV:

```sh
psql -d <database> --csv -f catalog.sql -o catalog.csv
```

Then run **ERD Studio: Import SQL DDL…** and pick `catalog.csv`. Partitions come in as their parent table. `CHECK` constraints and identity columns do not come in this way; `pg_dump` keeps them.

## MySQL and MariaDB

`mysqldump` writes the tables without the data (MariaDB also calls it `mariadb-dump`). Add `-h`, `-u` and `-p` as you connect:

```sh
mysqldump --no-data --result-file=schema.sql <database>
```

`--result-file` writes the file as it is on every system (a `>` redirect in Windows PowerShell can change its encoding). Then run **ERD Studio: Import SQL DDL…** and choose **MySQL / MariaDB**.

**Or one query, saved as TSV** (MySQL 8, or MariaDB 10.2 or later). Save this as `catalog.sql` in your project folder:

```sql
-- One row per column of every table and view, for ERD Studio (MySQL 8 or MariaDB 10.2 or later). System schemas are left out.
SELECT c.TABLE_SCHEMA AS table_schema,
       c.TABLE_NAME AS table_name,
       t.TABLE_TYPE AS table_type,
       t.TABLE_COMMENT AS table_comment,
       c.COLUMN_NAME AS column_name,
       c.ORDINAL_POSITION AS ordinal_position,
       c.COLUMN_TYPE AS data_type,
       c.IS_NULLABLE AS is_nullable,
       c.COLUMN_DEFAULT AS column_default,
       c.EXTRA AS extra,
       c.COLUMN_COMMENT AS column_comment,
       CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS is_primary_key,
       pk.ORDINAL_POSITION AS pk_ordinal,
       uq.INDEX_NAME AS unique_constraint_name,
       fk.CONSTRAINT_NAME AS fk_constraint_name,
       fk.ORDINAL_POSITION AS fk_ordinal,
       fk.REFERENCED_TABLE_SCHEMA AS fk_table_schema,
       fk.REFERENCED_TABLE_NAME AS fk_table,
       fk.REFERENCED_COLUMN_NAME AS fk_column,
       COUNT(*) OVER () AS total_rows
FROM information_schema.COLUMNS c
JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
LEFT JOIN information_schema.KEY_COLUMN_USAGE pk
       ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME AND pk.CONSTRAINT_NAME = 'PRIMARY'
LEFT JOIN information_schema.STATISTICS uq
       ON uq.TABLE_SCHEMA = c.TABLE_SCHEMA AND uq.TABLE_NAME = c.TABLE_NAME AND uq.COLUMN_NAME = c.COLUMN_NAME
      AND uq.NON_UNIQUE = 0 AND uq.INDEX_NAME <> 'PRIMARY'
      -- Unique on whole columns only: never on an expression or a prefix of a column.
      AND NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS e
                      WHERE e.TABLE_SCHEMA = uq.TABLE_SCHEMA AND e.TABLE_NAME = uq.TABLE_NAME AND e.INDEX_NAME = uq.INDEX_NAME
                        AND (e.COLUMN_NAME IS NULL OR e.SUB_PART IS NOT NULL))
LEFT JOIN information_schema.KEY_COLUMN_USAGE fk
       ON fk.TABLE_SCHEMA = c.TABLE_SCHEMA AND fk.TABLE_NAME = c.TABLE_NAME AND fk.COLUMN_NAME = c.COLUMN_NAME AND fk.REFERENCED_TABLE_NAME IS NOT NULL
WHERE c.TABLE_SCHEMA NOT IN ('mysql', 'sys', 'information_schema', 'performance_schema')
ORDER BY 1, 2, 6, 14, 15;
```

Run it with the `mysql` client, which writes the result tab-separated:

```sh
mysql --batch --execute="source catalog.sql" > catalog.tsv
```

Then run **ERD Studio: Import SQL DDL…** and pick `catalog.tsv`. `CHECK` constraints do not come in this way; `mysqldump` keeps them.

## Oracle

A SQL*Plus script that creates the tables imports as it is, such as Oracle's own sample schemas. To write one for an existing schema, run this in SQL*Plus or SQLcl as the schema's owner:

```sql
SET LONG 1000000 LONGCHUNKSIZE 1000000 PAGESIZE 0 LINESIZE 32767 TRIMSPOOL ON FEEDBACK OFF
EXEC DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', TRUE);
SPOOL schema.sql
SELECT DBMS_METADATA.GET_DDL('TABLE', table_name) FROM user_tables;
SPOOL OFF
```

Then run **ERD Studio: Import SQL DDL…** and choose **Oracle**. `VARCHAR2`, `NUMBER(p,s)` and the other Oracle types keep their names; identity columns stay identities, keys and foreign keys added later with `ALTER TABLE … ADD ( CONSTRAINT … )` are read with their tables, and `COMMENT ON` becomes the descriptions (`q'[…]'` quoting too). Storage, tablespace and partitioning clauses are left out, and so are `PROMPT`, `SET` and the other SQL*Plus commands, sequences, views and PL/SQL.

## Google BigQuery

BigQuery keeps each table's DDL. Run this in the BigQuery console with your project and dataset: it returns the DDL of every table in the dataset as one value. Save it into a `.sql` file:

```sql
SELECT STRING_AGG(ddl, '\n') FROM `my-project.my_dataset`.INFORMATION_SCHEMA.TABLES WHERE table_type = 'BASE TABLE';
```

Then run **ERD Studio: Import SQL DDL…** and choose **Google BigQuery**. A column's or table's `OPTIONS(description = …)` (also set later with `ALTER TABLE … SET OPTIONS`) becomes its description, `STRUCT<…>` and `ARRAY<…>` columns keep their types, and `` `project.dataset.table` `` names keep their dataset. `PARTITION BY`, `CLUSTER BY` and the table's other options are left out.

## Amazon Redshift

Redshift writes a table's DDL with `SHOW TABLE`; run it for each table and save the results in a `.sql` file:

```sql
SHOW TABLE my_schema.my_table;
```

Then run **ERD Studio: Import SQL DDL…** and choose **Amazon Redshift**. `ENCODE`, `DISTKEY`, `SORTKEY`, `DISTSTYLE` and `BACKUP` are left out (physical settings, listed as not imported); keys whose columns are written in another case (`Primary Key(L_ORDERKEY)`) still name their columns.

## SQLite

The `sqlite3` shell writes the schema of a database file:

```sh
sqlite3 my.db .schema > schema.sql
```

Then run **ERD Studio: Import SQL DDL…** and choose **SQLite**. Square-bracket names, `AUTOINCREMENT` and foreign keys inside the tables come across; a column without a type is imported as `unknown` (and listed), and virtual tables (`USING fts5` and the like), SQLite's own tables (`sqlite_sequence`, which `.schema` prints whenever a table uses `AUTOINCREMENT`) and triggers are left out.

## DuckDB

DuckDB has no `CREATE TABLE` export, so read its catalog instead. Run this in the `duckdb` shell (or any client) on your database file; it writes `catalog.csv`:

```sql
COPY (
-- One row per column of every table and view, for ERD Studio (DuckDB). DuckDB's own catalog is left out.
WITH rel AS (
  SELECT schema_name, table_name, table_oid, 'BASE TABLE' AS table_type, comment FROM duckdb_tables() WHERE NOT internal
  UNION ALL
  SELECT schema_name, view_name, view_oid, 'VIEW', comment FROM duckdb_views() WHERE NOT internal
), pk AS (
  SELECT table_oid, unnest(constraint_column_names) AS column_name, generate_subscripts(constraint_column_names, 1) AS ord
  FROM duckdb_constraints() WHERE constraint_type = 'PRIMARY KEY'
), uq AS (
  SELECT table_oid, constraint_name, unnest(constraint_column_names) AS column_name
  FROM duckdb_constraints() WHERE constraint_type = 'UNIQUE'
), fk AS (
  SELECT table_oid, constraint_name, schema_name AS ref_schema, referenced_table,
         unnest(constraint_column_names) AS column_name, unnest(referenced_column_names) AS ref_column,
         generate_subscripts(constraint_column_names, 1) AS ord
  FROM duckdb_constraints() WHERE constraint_type = 'FOREIGN KEY'
)
SELECT rel.schema_name AS table_schema, rel.table_name, rel.table_type, rel.comment AS table_comment,
       c.column_name, c.column_index AS ordinal_position, c.data_type,
       CASE WHEN c.is_nullable THEN 'YES' ELSE 'NO' END AS is_nullable,
       c.column_default, c.comment AS column_comment,
       CASE WHEN pk.ord IS NOT NULL THEN 'YES' ELSE 'NO' END AS is_primary_key, pk.ord AS pk_ordinal,
       uq.constraint_name AS unique_constraint_name,
       fk.constraint_name AS fk_constraint_name, fk.ord AS fk_ordinal,
       fk.ref_schema AS fk_table_schema, fk.referenced_table AS fk_table, fk.ref_column AS fk_column,
       count(*) OVER () AS total_rows
FROM rel
JOIN duckdb_columns() c ON c.table_oid = rel.table_oid
LEFT JOIN pk ON pk.table_oid = rel.table_oid AND pk.column_name = c.column_name
LEFT JOIN uq ON uq.table_oid = rel.table_oid AND uq.column_name = c.column_name
LEFT JOIN fk ON fk.table_oid = rel.table_oid AND fk.column_name = c.column_name
ORDER BY 1, 2, 6, 13, 14
) TO 'catalog.csv' (HEADER);
```

Then run **ERD Studio: Import SQL DDL…** and pick `catalog.csv`.

## A catalog export from another database

**ERD Studio: Import SQL DDL…** also reads a CSV (or TSV) of a database's columns, one row per column, from any database. The queries above write one; for another database, write a query over its catalog with the column names below and save the result as CSV. Column names are read in any case, with spaces or underscores. Only `table_name`, `column_name` and `data_type` are needed; every other column adds what it holds. ERD Studio reads only the file, never the database, and it does not guess which database wrote it.

| Column | Also read as | What it gives |
|---|---|---|
| `table_name` | `table`, `relname` | the table (required) |
| `column_name` | `column`, `col_name`, `name` | the column (required) |
| `data_type` | `full_data_type`, `column_type`, `type`, `type_name` | the type (required). A value with its size (`varchar(50)`, `decimal(18,4)`, `struct<…>`) is kept as it is |
| `table_schema` | `schema`, `schema_name`, `owner` | the schema |
| `table_catalog` | `catalog`, `catalog_name` | tells apart tables of one name in two catalogs |
| `table_type` | `object_type` | rows of a `VIEW` (or materialized view) are skipped, and said; without this column views come in as tables, and the import says so |
| `ordinal_position` | `column_id`, `ordinal`, `position` | the column order (0- or 1-based: only the order matters); without it, the file's row order |
| `is_nullable` | `nullable`; `notnull` the other way round | `NO` is NOT NULL |
| `character_maximum_length`, `numeric_precision`, `numeric_scale` | `data_length`, `data_precision`, `data_scale` | the size of a `varchar`, `char`, `decimal`, `numeric` or `number` given without one |
| `column_default` | `data_default`, `default` | the default |
| `column_comment` | `comment`, `comments`, `description`, `remarks` | the column's description |
| `table_comment` | `table_comments`, `table_description` | the table's description |
| `is_primary_key` | `primary_key`, `pk`; MySQL's `column_key` (`PRI`) | the primary key; `pk_ordinal` orders a composite one |
| `is_unique` | `unique`; `unique_constraint_name` groups a composite one | unique keys |
| `fk_constraint_name`, `fk_table_schema`, `fk_table`, `fk_column` | `referenced_table_schema`, `referenced_table_name`, `referenced_column_name` | foreign keys; `fk_ordinal` pairs a composite one's columns in order, and a column in two foreign keys is two rows |
| `constraint_name`, `constraint_type` | | the constraint-join shape: one row per column per constraint (`PRIMARY KEY`, `UNIQUE`, `FOREIGN KEY`, or Oracle's `P`, `U`, `R`) |
| `is_identity` | `extra` (`auto_increment`) | identity columns |
| `total_rows` | | the query's row count (`count(*) OVER ()`): a file with fewer rows than it says was cut short, and is refused |

A column that appears on several rows (one per constraint it is in) is read once. A file without key columns imports its tables and columns, and the draft says the file had no keys (not that the tables have none). `NULL` may be written as nothing, `NULL`, `null` or `\N`. System schemas (`information_schema`, `pg_catalog`, `sys`) are left out. A file with more than 100,000 rows is refused: export one schema at a time.

## dbdiagram.io and other DBML tools

DBML is the open-source schema language behind dbdiagram.io, so ERD Studio imports it as it is.

- **dbdiagram.io:** copy all the code from the editor into a file such as `model.dbml` in your project folder.
- **Another DBML tool:** save or export the `.dbml` file into your project folder.

Then run **ERD Studio: Import DBML…**. More on moving between ERD Studio and dbdiagram.io: [Leaving ERD Studio (and coming back)](leaving-erd-studio.md).

## Other modelling tools

erwin Data Modeler, ER/Studio, DbSchema, DBeaver, DataGrip, Visual Paradigm and most other tools can generate SQL DDL (often called forward engineering) or export DBML. Generate the DDL for PostgreSQL, MySQL, SQL Server, Snowflake, Databricks, Oracle, BigQuery, Redshift or SQLite (or export DBML), save it in your project folder, then run **ERD Studio: Import…** and pick **SQL DDL scripts** or **DBML file**.

## dbt

dbt is optional. If your folder is a dbt project, **Import from dbt** copies your dbt models and their relationship tests into a diagram, with no export step: see [Using ERD Studio with dbt](dbt.md).

## Not yet

- **Live database connections:** ERD Studio reads files you export, never a database.

Need one of these, or another source? Run **ERD Studio: Send Feedback** and tell us which.
