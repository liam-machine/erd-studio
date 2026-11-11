-- DRAFT, NEVER RUN ON FABRIC: not in the guide or the docs. The live check in the report (Fabric Warehouse and SQL analytics endpoint) decides whether it ships.
-- One row per column of every table and view, for ERD Studio (Fabric Warehouse or SQL analytics endpoint). DRAFT: never run on Fabric.
SELECT s.name AS table_schema,
       o.name AS table_name,
       CASE o.type WHEN 'V' THEN 'VIEW' ELSE 'BASE TABLE' END AS table_type,
       c.name AS column_name,
       c.column_id AS ordinal_position,
       CASE WHEN ty.name IN ('varchar', 'char', 'varbinary', 'binary') THEN ty.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
            WHEN ty.name IN ('decimal', 'numeric') THEN ty.name + '(' + CAST(c.precision AS varchar(5)) + ',' + CAST(c.scale AS varchar(5)) + ')'
            WHEN ty.name IN ('datetime2', 'time') THEN ty.name + '(' + CAST(c.scale AS varchar(5)) + ')'
            ELSE ty.name END AS data_type,
       CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END AS is_nullable,
       CASE WHEN c.is_identity = 1 THEN 'YES' ELSE 'NO' END AS is_identity,
       CASE WHEN pk.key_ordinal IS NOT NULL THEN 'YES' ELSE 'NO' END AS is_primary_key,
       pk.key_ordinal AS pk_ordinal,
       uq.name AS unique_constraint_name,
       fk.name AS fk_constraint_name,
       fk.ord AS fk_ordinal,
       fk.ref_schema AS fk_table_schema,
       fk.ref_table AS fk_table,
       fk.ref_column AS fk_column,
       COUNT(*) OVER () AS total_rows
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.columns c ON c.object_id = o.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN (
  -- Fabric keys are NOT ENFORCED constraints: their columns are read as dbt-fabric reads them (sys.key_constraints to sys.index_columns).
  SELECT kc.parent_object_id, ic.column_id, ic.key_ordinal
  FROM sys.key_constraints kc
  JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
  WHERE kc.type = 'PK'
) pk ON pk.parent_object_id = c.object_id AND pk.column_id = c.column_id
LEFT JOIN (
  SELECT kc.parent_object_id, ic.column_id, kc.name
  FROM sys.key_constraints kc
  JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id AND ic.key_ordinal > 0
  WHERE kc.type = 'UQ'
) uq ON uq.parent_object_id = c.object_id AND uq.column_id = c.column_id
LEFT JOIN (
  SELECT fkc.parent_object_id, fkc.parent_column_id, f.name, fkc.constraint_column_id AS ord,
         rs.name AS ref_schema, r.name AS ref_table, rc.name AS ref_column
  FROM sys.foreign_keys f
  JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = f.object_id
  JOIN sys.objects r ON r.object_id = fkc.referenced_object_id
  JOIN sys.schemas rs ON rs.schema_id = r.schema_id
  JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
) fk ON fk.parent_object_id = c.object_id AND fk.parent_column_id = c.column_id
WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'queryinsights')
ORDER BY table_schema, table_name, ordinal_position, unique_constraint_name, fk_constraint_name;
