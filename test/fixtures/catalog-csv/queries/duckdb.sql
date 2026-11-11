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
ORDER BY 1, 2, 6, 13, 14;
