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
