-- One row per column of every table and view, for ERD Studio (SQL Server 2017 or later, Azure SQL Database, Azure SQL Managed Instance).
SELECT s.name AS table_schema,
       o.name AS table_name,
       CASE o.type WHEN 'V' THEN 'VIEW' ELSE 'BASE TABLE' END AS table_type,
       CAST(tp.value AS nvarchar(max)) AS table_comment,
       c.name AS column_name,
       c.column_id AS ordinal_position,
       CASE WHEN ty.is_user_defined = 1 THEN SCHEMA_NAME(ty.schema_id) + '.' + ty.name
            WHEN ty.name IN ('varchar', 'char', 'varbinary', 'binary') THEN ty.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
            WHEN ty.name IN ('nvarchar', 'nchar') THEN ty.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
            WHEN ty.name IN ('decimal', 'numeric') THEN ty.name + '(' + CAST(c.precision AS varchar(5)) + ',' + CAST(c.scale AS varchar(5)) + ')'
            WHEN ty.name IN ('datetime2', 'time', 'datetimeoffset') THEN ty.name + '(' + CAST(c.scale AS varchar(5)) + ')'
            WHEN ty.name = 'xml' AND c.xml_collection_id <> 0 THEN 'xml(' + CASE WHEN c.is_xml_document = 1 THEN 'DOCUMENT ' ELSE 'CONTENT ' END
                 + (SELECT SCHEMA_NAME(x.schema_id) + '.' + x.name FROM sys.xml_schema_collections x WHERE x.xml_collection_id = c.xml_collection_id) + ')'
            ELSE ty.name END AS data_type,
       CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END AS is_nullable,
       -- SQL Server keeps a default in parentheses, a number in two: ('AU'), ((0)), (getdate()).
       CASE WHEN dc.d LIKE '(%)' AND TRY_CONVERT(float, SUBSTRING(dc.d, 2, LEN(dc.d) - 2)) IS NOT NULL THEN SUBSTRING(dc.d, 2, LEN(dc.d) - 2)
            WHEN dc.d LIKE 'N''%''' THEN SUBSTRING(dc.d, 2, LEN(dc.d) - 1)
            ELSE dc.d END AS column_default,
       CAST(cp.value AS nvarchar(max)) AS column_comment,
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
LEFT JOIN sys.extended_properties tp ON tp.class = 1 AND tp.major_id = o.object_id AND tp.minor_id = 0 AND tp.name = 'MS_Description'
LEFT JOIN sys.extended_properties cp ON cp.class = 1 AND cp.major_id = o.object_id AND cp.minor_id = c.column_id AND cp.name = 'MS_Description'
LEFT JOIN (
  SELECT parent_object_id, parent_column_id, SUBSTRING(definition, 2, LEN(definition) - 2) AS d FROM sys.default_constraints
) dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
LEFT JOIN (
  SELECT ic.object_id, ic.column_id, ic.key_ordinal
  FROM sys.key_constraints kc
  JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
  WHERE kc.type = 'PK'
) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
LEFT JOIN (
  -- Each unique key (constraint or index) the column is a key column of: never a filtered or disabled index, never an included column.
  SELECT i.object_id, ic.column_id, i.name
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0 AND ic.is_included_column = 0
  WHERE i.is_unique = 1 AND i.is_primary_key = 0 AND i.has_filter = 0 AND i.is_disabled = 0 AND i.is_hypothetical = 0
) uq ON uq.object_id = c.object_id AND uq.column_id = c.column_id
LEFT JOIN (
  SELECT fkc.parent_object_id, fkc.parent_column_id, f.name, fkc.constraint_column_id AS ord,
         SCHEMA_NAME(r.schema_id) AS ref_schema, r.name AS ref_table, rc.name AS ref_column
  FROM sys.foreign_keys f
  JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = f.object_id
  JOIN sys.objects r ON r.object_id = fkc.referenced_object_id
  JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
) fk ON fk.parent_object_id = c.object_id AND fk.parent_column_id = c.column_id
WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 AND NOT (s.name = 'dbo' AND o.name = 'sysdiagrams')
ORDER BY table_schema, table_name, ordinal_position, unique_constraint_name, fk_constraint_name;
