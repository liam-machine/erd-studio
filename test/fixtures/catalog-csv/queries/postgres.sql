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
