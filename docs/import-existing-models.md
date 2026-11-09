# Bring in the data model you already have

Your data model probably exists already: as tables in Databricks or Snowflake, as a Power BI or Fabric semantic model, in a database, or in a modelling tool. ERD Studio turns it into DBML, an open format your team can read, review and diff in Git, and that other DBML tools open. ERD Studio is free to use, source available under the PolyForm Shield License.

The same steps are inside ERD Studio: run **ERD Studio: Bring In Your Data Model…**, or choose it under **More ways to start…** on the walkthrough or the empty **Diagrams** view. Each card there has a **Copy** button for its command and a button that runs the right import, with the source already chosen.

Every import works the same way once you have the files: you pick the files (or a folder), a layer and a name, and ERD Studio shows what it will create before anything is written. **Review All…** lists every table, relationship and anything it left out: from SQL scripts, anything that is not a table (views, indexes, grants and the like) is listed as not imported. **ERD Studio: Show Import Report** (also a link on the draft) lists what the last import imported, repaired, could not import and skipped, grouped and counted, each with its file and line. Nothing leaves your machine.

- [Databricks (Unity Catalog)](#databricks-unity-catalog)
- [Snowflake](#snowflake)
- [Power BI](#power-bi)
- [Microsoft Fabric](#microsoft-fabric)
- [SQL Server and Azure SQL](#sql-server-and-azure-sql)
- [PostgreSQL](#postgresql)
- [MySQL and MariaDB](#mysql-and-mariadb)
- [dbdiagram.io and other DBML tools](#dbdiagramio-and-other-dbml-tools)
- [Other modelling tools](#other-modelling-tools)
- [dbt](#dbt)
- [Not yet](#not-yet)

## Databricks (Unity Catalog)

Export the `CREATE TABLE` statements of your tables. Declared `PRIMARY KEY` and `FOREIGN KEY` constraints become keys and relationships.

One table: run this in a notebook or the SQL editor, and copy the result into a `.sql` file in your project folder.

```sql
SHOW CREATE TABLE <catalog>.<schema>.<table>;
```

A whole schema: run this in a Python notebook cell, then copy what it prints into `schema.sql`.

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

## Snowflake

Snowflake writes the DDL of a whole schema in one call. Run this in a worksheet and copy the result into a `.sql` file:

```sql
SELECT GET_DDL('SCHEMA', '<database>.<schema>');
```

Or a whole database:

```sql
SELECT GET_DDL('DATABASE', '<database>');
```

Then run **ERD Studio: Import SQL DDL…** and choose **Snowflake**. Anything in the output that is not a table (views, sequences and the like) is skipped and listed as not imported.

## Power BI

A report saved as a Power BI project keeps its semantic model in a `<Name>.SemanticModel` folder, which ERD Studio reads as TMDL or as `model.bim`.

1. In Power BI Desktop, choose **File → Save as**, pick **Power BI project files (`*.pbip`)**, and save it in your project folder.
2. No such option? Turn on **Power BI Project (.pbip) save option** in **File → Options and settings → Options → Preview features**, then restart Power BI Desktop.
3. Run **ERD Studio: Import Power BI or Fabric Semantic Model…** and pick the folder.

Tables, columns and relationships come across; DAX measures stay in Power BI.

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

## MySQL and MariaDB

`mysqldump` writes the tables without the data (MariaDB also calls it `mariadb-dump`). Add `-h`, `-u` and `-p` as you connect:

```sh
mysqldump --no-data --result-file=schema.sql <database>
```

`--result-file` writes the file as it is on every system (a `>` redirect in Windows PowerShell can change its encoding). Then run **ERD Studio: Import SQL DDL…** and choose **MySQL / MariaDB**.

## dbdiagram.io and other DBML tools

DBML is the open-source schema language behind dbdiagram.io, so ERD Studio imports it as it is.

- **dbdiagram.io:** copy all the code from the editor into a file such as `model.dbml` in your project folder.
- **Another DBML tool:** save or export the `.dbml` file into your project folder.

Then run **ERD Studio: Import DBML…**. More on moving between ERD Studio and dbdiagram.io: [Leaving ERD Studio (and coming back)](leaving-erd-studio.md).

## Other modelling tools

erwin Data Modeler, ER/Studio, DbSchema, DBeaver, DataGrip, Visual Paradigm and most other tools can generate SQL DDL (often called forward engineering) or export DBML. Generate the DDL for PostgreSQL, MySQL, SQL Server, Snowflake or Databricks (or export DBML), save it in your project folder, then run **ERD Studio: Import…** and pick **SQL DDL scripts** or **DBML file**.

## dbt

dbt is optional. If your folder is a dbt project, **Import from dbt** copies your dbt models and their relationship tests into a diagram, with no export step: see [Using ERD Studio with dbt](dbt.md).

## Not yet

- **Oracle:** the SQL importer does not read Oracle DDL yet.
- **BigQuery:** its DDL (`OPTIONS(…)` on columns and `project.dataset.table` names) does not read yet.
- **Live database connections:** ERD Studio reads files you export, never a database.

Need one of these, or another source? Run **ERD Studio: Send Feedback** and tell us which.
