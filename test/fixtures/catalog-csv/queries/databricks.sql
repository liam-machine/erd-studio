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
