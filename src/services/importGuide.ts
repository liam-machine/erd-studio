/**
 * **Bring In Your Data Model…** (`erdStudio.showImportGuide`): the
 * guide to turning the model a team already has — in Databricks, Snowflake,
 * Power BI, Fabric, SQL Server, PostgreSQL, MySQL, a DBML tool or another
 * modelling tool — into DBML, an open format, with ERD Studio's own imports.
 *
 * One card per source: what to export, the exact step or command (a **Copy**
 * button on each command), and the button that runs the right import with
 * the source preselected — Import SQL DDL… with its dialect, Import Semantic
 * Model…, Import DBML…, Import…, Import from dbt (its card only in a dbt
 * project) — and a **Not yet** card (live connections) whose Send Feedback
 * lets people ask for theirs. Oracle, BigQuery, Redshift and SQLite scripts
 * are read by Import SQL DDL… (the other-tools card's Import…); they have no
 * card of their own yet, as each card's button is a telemetry key. The
 * Databricks, SQL Server, PostgreSQL and MySQL cards also give a catalog query whose CSV
 * Import SQL DDL… reads (`catalogCsvImport.ts`), in a section of its own with
 * its own button label that runs the card's action (one key per card still):
 * only the engines it was run on (`test/fixtures/catalog-csv/`). The folder's suggested
 * start (`startIntentFor`) leads: a "Found in this folder" card for a direct
 * import, the dbt card in a dbt project; then the sources in the order
 * telemetry sees them.
 *
 * Every command, argument and snippet is a fixed constant here: the page
 * posts only an action id, a snippet id or `openFolder` (validated by
 * {@link isImportGuideToHost}); nothing it sends is ever run or copied as
 * given. Nonce-only CSP, no remote resource, `--vscode-*` colours only. The
 * page writes nothing; each import asks its own questions and shows its dry
 * run before it writes.
 *
 * Pure and vscode-free; the host half is `src/providers/ImportGuidePanel.ts`.
 */

import { escapeHtml } from './dbmlConversionReview';
import { IMPORT_GUIDE_LOGOS } from './importGuideLogos';
import type { SqlDialect } from './sqlDdlImport';
import type { TelemetryFeature } from './telemetryPayload';
import {
  IMPORT_GUIDE_COMMAND,
  IMPORT_GUIDE_LABEL,
  START_ACTION_COMMANDS,
  START_INTENT_REASONS,
  importGuideCommandLink,
  startActionArgs,
  type StartIntent,
} from '../types/startActions';

export { IMPORT_GUIDE_COMMAND, IMPORT_GUIDE_LABEL, importGuideCommandLink };
/** The command's title, as the palette names it (category ERD Studio): the guide's one label. */
export const IMPORT_GUIDE_COMMAND_TITLE = IMPORT_GUIDE_LABEL;
export const IMPORT_GUIDE_VIEW_TYPE = 'erdStudio.importGuide';
/** The tab's title: the same words, without the ellipsis. */
export const IMPORT_GUIDE_TITLE = IMPORT_GUIDE_LABEL.replace(/…$/, '');

// ---------------------------------------------------------------------------
// Where it was opened from (the command's one optional argument)
// ---------------------------------------------------------------------------

/**
 * The surfaces that link the guide: the Welcome panel's start card, the
 * walkthrough's blank start step, the empty Diagrams view's blank variant,
 * Import…'s picker, the start quick pick, the nothing-found notification
 * (no longer shown: kept so an old link still counts) and a draft's Other
 * Ways to Start (`draft`). The palette passes nothing.
 */
export const IMPORT_GUIDE_SURFACES = ['welcome', 'walkthrough', 'sidebar', 'picker', 'startPick', 'prompt', 'draft'] as const;
export type ImportGuideSurface = (typeof IMPORT_GUIDE_SURFACES)[number];

/** The command's argument: `{ from }`, or undefined for anything else (the palette, a stray value). */
export function parseImportGuideArgs(arg: unknown): ImportGuideSurface | undefined {
  if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) return undefined;
  const from = (arg as { from?: unknown }).from;
  return (IMPORT_GUIDE_SURFACES as readonly unknown[]).includes(from) ? from as ImportGuideSurface : undefined;
}

/** The last item of Import…'s picker and of the start quick pick ("More ways to start…"). */
export const IMPORT_GUIDE_PICK_ITEM = {
  label: `$(question) ${IMPORT_GUIDE_LABEL}`,
  detail: 'How to export from Databricks, Snowflake, Power BI, Fabric and more',
} as const;

// ---------------------------------------------------------------------------
// The cards
// ---------------------------------------------------------------------------

export type ImportGuideCardId =
  | 'found' | 'dbt' | 'databricks' | 'snowflake' | 'powerBi' | 'fabric'
  | 'sqlServer' | 'postgres' | 'mysql' | 'dbml' | 'otherTools' | 'notYet';

/** What a card's button does: one fixed command each. */
export const IMPORT_GUIDE_ACTIONS = [
  'found', 'dbt', 'databricks', 'snowflake', 'powerBi', 'fabric', 'fabricWarehouse',
  'sqlServer', 'postgres', 'mysql', 'dbml', 'otherTools', 'feedback',
] as const;
export type ImportGuideAction = (typeof IMPORT_GUIDE_ACTIONS)[number];

/** The text each Copy button copies, exactly. */
export const IMPORT_GUIDE_SNIPPETS = {
  databricksSchema: [
    'catalog, schema = "main", "sales"  # your catalog and schema',
    'tables = spark.sql(f"""',
    '  SELECT table_name FROM {catalog}.information_schema.tables',
    "  WHERE table_schema = '{schema}' AND table_type IN ('MANAGED', 'EXTERNAL')",
    '""").collect()',
    'for t in tables:',
    '    ddl = spark.sql(f"SHOW CREATE TABLE `{catalog}`.`{schema}`.`{t.table_name}`").first()[0]',
    '    print(ddl.rstrip().rstrip(";") + ";\\n")',
  ].join('\n'),
  snowflakeSchema: "SELECT GET_DDL('SCHEMA', '<database>.<schema>');",
  postgres: 'pg_dump --schema-only --no-owner --no-privileges -d <database> -f schema.sql',
  mysql: 'mysqldump --no-data --result-file=schema.sql <database>',
  // The catalog queries: test/fixtures/catalog-csv/queries/ holds each as it was run (importGuide.test.ts keeps them equal).
  databricksCatalog: [
    '-- One row per column of every table and view in a catalog, for ERD Studio. Put your catalog on the WHERE line.',
    'SELECT c.table_schema,',
    '       c.table_name,',
    '       t.table_type,',
    '       coalesce(t.comment, \'\') AS table_comment,',
    '       c.column_name,',
    '       c.ordinal_position,',
    '       c.full_data_type AS data_type,',
    '       c.is_nullable,',
    '       coalesce(c.column_default, \'\') AS column_default,',
    '       coalesce(c.comment, \'\') AS column_comment,',
    '       CASE WHEN pk.column_name IS NOT NULL THEN \'YES\' ELSE \'NO\' END AS is_primary_key,',
    '       coalesce(cast(pk.ordinal_position AS STRING), \'\') AS pk_ordinal,',
    '       coalesce(fk.constraint_name, \'\') AS fk_constraint_name,',
    '       coalesce(cast(fk.fk_ordinal AS STRING), \'\') AS fk_ordinal,',
    '       coalesce(fk.fk_table_catalog, \'\') AS fk_table_catalog,',
    '       coalesce(fk.fk_table_schema, \'\') AS fk_table_schema,',
    '       coalesce(fk.fk_table, \'\') AS fk_table,',
    '       coalesce(fk.fk_column, \'\') AS fk_column,',
    '       count(*) OVER () AS total_rows',
    'FROM system.information_schema.columns c',
    'JOIN system.information_schema.tables t',
    '  ON t.table_catalog = c.table_catalog AND t.table_schema = c.table_schema AND t.table_name = c.table_name',
    'LEFT JOIN (',
    '  SELECT k.table_catalog, k.table_schema, k.table_name, k.column_name, k.ordinal_position',
    '  FROM system.information_schema.table_constraints tc',
    '  JOIN system.information_schema.key_column_usage k',
    '    ON k.constraint_catalog = tc.constraint_catalog AND k.constraint_schema = tc.constraint_schema AND k.constraint_name = tc.constraint_name',
    '   AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name',
    '  WHERE tc.constraint_type = \'PRIMARY KEY\'',
    ') pk ON pk.table_catalog = c.table_catalog AND pk.table_schema = c.table_schema AND pk.table_name = c.table_name AND pk.column_name = c.column_name',
    'LEFT JOIN (',
    '  SELECT k.table_catalog, k.table_schema, k.table_name, k.column_name, k.constraint_name, k.ordinal_position AS fk_ordinal,',
    '         r.table_catalog AS fk_table_catalog, r.table_schema AS fk_table_schema, r.table_name AS fk_table, r.column_name AS fk_column',
    '  FROM system.information_schema.table_constraints tc',
    '  JOIN system.information_schema.key_column_usage k',
    '    ON k.constraint_catalog = tc.constraint_catalog AND k.constraint_schema = tc.constraint_schema AND k.constraint_name = tc.constraint_name',
    '   AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name',
    '  JOIN system.information_schema.referential_constraints rc',
    '    ON rc.constraint_catalog = k.constraint_catalog AND rc.constraint_schema = k.constraint_schema AND rc.constraint_name = k.constraint_name',
    '  JOIN system.information_schema.key_column_usage r',
    '    ON r.constraint_catalog = rc.unique_constraint_catalog AND r.constraint_schema = rc.unique_constraint_schema AND r.constraint_name = rc.unique_constraint_name',
    '   AND r.ordinal_position = k.position_in_unique_constraint',
    '  WHERE tc.constraint_type = \'FOREIGN KEY\'',
    ') fk ON fk.table_catalog = c.table_catalog AND fk.table_schema = c.table_schema AND fk.table_name = c.table_name AND fk.column_name = c.column_name',
    'WHERE c.table_catalog = \'my_catalog\'',
    '  AND c.table_schema <> \'information_schema\'',
    'ORDER BY c.table_schema, c.table_name, c.ordinal_position, fk.constraint_name;',
  ].join('\n'),
  postgresCatalog: [
    '-- One row per column of every table and view, for ERD Studio (PostgreSQL 12 or later). System schemas and partitions are left out.',
    'SELECT n.nspname AS table_schema,',
    '       c.relname AS table_name,',
    '       CASE c.relkind WHEN \'v\' THEN \'VIEW\' WHEN \'m\' THEN \'MATERIALIZED VIEW\' WHEN \'f\' THEN \'FOREIGN TABLE\' ELSE \'BASE TABLE\' END AS table_type,',
    '       obj_description(c.oid, \'pg_class\') AS table_comment,',
    '       a.attname AS column_name,',
    '       a.attnum AS ordinal_position,',
    '       format_type(a.atttypid, a.atttypmod) AS data_type,',
    '       CASE WHEN a.attnotnull THEN \'NO\' ELSE \'YES\' END AS is_nullable,',
    '       pg_get_expr(d.adbin, d.adrelid) AS column_default,',
    '       col_description(c.oid, a.attnum) AS column_comment,',
    '       CASE WHEN pk.ord IS NOT NULL THEN \'YES\' ELSE \'NO\' END AS is_primary_key,',
    '       pk.ord AS pk_ordinal,',
    '       uq.unique_name AS unique_constraint_name,',
    '       fk.conname AS fk_constraint_name,',
    '       fk.ord AS fk_ordinal,',
    '       fk.ref_schema AS fk_table_schema,',
    '       fk.ref_table AS fk_table,',
    '       fk.ref_column AS fk_column,',
    '       count(*) OVER () AS total_rows',
    'FROM pg_class c',
    'JOIN pg_namespace n ON n.oid = c.relnamespace',
    'JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped',
    'LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum',
    'LEFT JOIN LATERAL (',
    '  SELECT k.ord FROM pg_constraint p, unnest(p.conkey) WITH ORDINALITY AS k(attnum, ord)',
    '  WHERE p.conrelid = c.oid AND p.contype = \'p\' AND k.attnum = a.attnum',
    ') pk ON true',
    'LEFT JOIN LATERAL (',
    '  -- Each unique key (constraint or index) the column is in, over columns only: never partial or on an expression.',
    '  SELECT ic.relname AS unique_name FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid',
    '  WHERE i.indrelid = c.oid AND i.indisunique AND NOT i.indisprimary AND i.indpred IS NULL AND i.indexprs IS NULL',
    '    AND a.attnum = ANY ((i.indkey::int2[])[0:i.indnkeyatts - 1])',
    ') uq ON true',
    'LEFT JOIN LATERAL (',
    '  -- A partitioned table\'s foreign keys include those declared on its partitions, pointing at the referenced table\'s root.',
    '  SELECT f.conname, k.ord, rn.nspname AS ref_schema, rc.relname AS ref_table, ra.attname AS ref_column',
    '  FROM pg_constraint f',
    '  CROSS JOIN LATERAL unnest(f.conkey, f.confkey) WITH ORDINALITY AS k(attnum, refattnum, ord)',
    '  JOIN pg_attribute fa ON fa.attrelid = f.conrelid AND fa.attnum = k.attnum',
    '  JOIN pg_attribute ra ON ra.attrelid = f.confrelid AND ra.attnum = k.refattnum',
    '  JOIN pg_class rc ON rc.oid = coalesce(pg_partition_root(f.confrelid), f.confrelid)',
    '  JOIN pg_namespace rn ON rn.oid = rc.relnamespace',
    '  WHERE f.contype = \'f\' AND f.conparentid = 0 AND fa.attname = a.attname',
    '    AND (f.conrelid = c.oid OR f.conrelid IN (SELECT relid FROM pg_partition_tree(c.oid)))',
    ') fk ON true',
    'WHERE c.relkind IN (\'r\', \'p\', \'v\', \'m\', \'f\') AND NOT c.relispartition',
    '  AND n.nspname NOT IN (\'pg_catalog\', \'information_schema\') AND n.nspname NOT LIKE \'pg\\_%\'',
    'ORDER BY 1, 2, 6, 13, 14;',
  ].join('\n'),
  mysqlCatalog: [
    '-- One row per column of every table and view, for ERD Studio (MySQL 8 or MariaDB 10.2 or later). System schemas are left out.',
    'SELECT c.TABLE_SCHEMA AS table_schema,',
    '       c.TABLE_NAME AS table_name,',
    '       t.TABLE_TYPE AS table_type,',
    '       t.TABLE_COMMENT AS table_comment,',
    '       c.COLUMN_NAME AS column_name,',
    '       c.ORDINAL_POSITION AS ordinal_position,',
    '       c.COLUMN_TYPE AS data_type,',
    '       c.IS_NULLABLE AS is_nullable,',
    '       c.COLUMN_DEFAULT AS column_default,',
    '       c.EXTRA AS extra,',
    '       c.COLUMN_COMMENT AS column_comment,',
    '       CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN \'YES\' ELSE \'NO\' END AS is_primary_key,',
    '       pk.ORDINAL_POSITION AS pk_ordinal,',
    '       uq.INDEX_NAME AS unique_constraint_name,',
    '       fk.CONSTRAINT_NAME AS fk_constraint_name,',
    '       fk.ORDINAL_POSITION AS fk_ordinal,',
    '       fk.REFERENCED_TABLE_SCHEMA AS fk_table_schema,',
    '       fk.REFERENCED_TABLE_NAME AS fk_table,',
    '       fk.REFERENCED_COLUMN_NAME AS fk_column,',
    '       COUNT(*) OVER () AS total_rows',
    'FROM information_schema.COLUMNS c',
    'JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME',
    'LEFT JOIN information_schema.KEY_COLUMN_USAGE pk',
    '       ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME AND pk.CONSTRAINT_NAME = \'PRIMARY\'',
    'LEFT JOIN information_schema.STATISTICS uq',
    '       ON uq.TABLE_SCHEMA = c.TABLE_SCHEMA AND uq.TABLE_NAME = c.TABLE_NAME AND uq.COLUMN_NAME = c.COLUMN_NAME',
    '      AND uq.NON_UNIQUE = 0 AND uq.INDEX_NAME <> \'PRIMARY\'',
    '      -- Unique on whole columns only: never on an expression or a prefix of a column.',
    '      AND NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS e',
    '                      WHERE e.TABLE_SCHEMA = uq.TABLE_SCHEMA AND e.TABLE_NAME = uq.TABLE_NAME AND e.INDEX_NAME = uq.INDEX_NAME',
    '                        AND (e.COLUMN_NAME IS NULL OR e.SUB_PART IS NOT NULL))',
    'LEFT JOIN information_schema.KEY_COLUMN_USAGE fk',
    '       ON fk.TABLE_SCHEMA = c.TABLE_SCHEMA AND fk.TABLE_NAME = c.TABLE_NAME AND fk.COLUMN_NAME = c.COLUMN_NAME AND fk.REFERENCED_TABLE_NAME IS NOT NULL',
    'WHERE c.TABLE_SCHEMA NOT IN (\'mysql\', \'sys\', \'information_schema\', \'performance_schema\')',
    'ORDER BY 1, 2, 6, 14, 15;',
  ].join('\n'),
  sqlServerCatalog: [
    '-- One row per column of every table and view, for ERD Studio (SQL Server 2017 or later, Azure SQL Database, Azure SQL Managed Instance).',
    'SELECT s.name AS table_schema,',
    '       o.name AS table_name,',
    '       CASE o.type WHEN \'V\' THEN \'VIEW\' ELSE \'BASE TABLE\' END AS table_type,',
    '       CAST(tp.value AS nvarchar(max)) AS table_comment,',
    '       c.name AS column_name,',
    '       c.column_id AS ordinal_position,',
    '       CASE WHEN ty.is_user_defined = 1 THEN SCHEMA_NAME(ty.schema_id) + \'.\' + ty.name',
    '            WHEN ty.name IN (\'varchar\', \'char\', \'varbinary\', \'binary\') THEN ty.name + \'(\' + CASE WHEN c.max_length = -1 THEN \'max\' ELSE CAST(c.max_length AS varchar(10)) END + \')\'',
    '            WHEN ty.name IN (\'nvarchar\', \'nchar\') THEN ty.name + \'(\' + CASE WHEN c.max_length = -1 THEN \'max\' ELSE CAST(c.max_length / 2 AS varchar(10)) END + \')\'',
    '            WHEN ty.name IN (\'decimal\', \'numeric\') THEN ty.name + \'(\' + CAST(c.precision AS varchar(5)) + \',\' + CAST(c.scale AS varchar(5)) + \')\'',
    '            WHEN ty.name IN (\'datetime2\', \'time\', \'datetimeoffset\') THEN ty.name + \'(\' + CAST(c.scale AS varchar(5)) + \')\'',
    '            WHEN ty.name = \'xml\' AND c.xml_collection_id <> 0 THEN \'xml(\' + CASE WHEN c.is_xml_document = 1 THEN \'DOCUMENT \' ELSE \'CONTENT \' END',
    '                 + (SELECT SCHEMA_NAME(x.schema_id) + \'.\' + x.name FROM sys.xml_schema_collections x WHERE x.xml_collection_id = c.xml_collection_id) + \')\'',
    '            ELSE ty.name END AS data_type,',
    '       CASE WHEN c.is_nullable = 1 THEN \'YES\' ELSE \'NO\' END AS is_nullable,',
    '       -- SQL Server keeps a default in parentheses, a number in two: (\'AU\'), ((0)), (getdate()).',
    '       CASE WHEN dc.d LIKE \'(%)\' AND TRY_CONVERT(float, SUBSTRING(dc.d, 2, LEN(dc.d) - 2)) IS NOT NULL THEN SUBSTRING(dc.d, 2, LEN(dc.d) - 2)',
    '            WHEN dc.d LIKE \'N\'\'%\'\'\' THEN SUBSTRING(dc.d, 2, LEN(dc.d) - 1)',
    '            ELSE dc.d END AS column_default,',
    '       CAST(cp.value AS nvarchar(max)) AS column_comment,',
    '       CASE WHEN c.is_identity = 1 THEN \'YES\' ELSE \'NO\' END AS is_identity,',
    '       CASE WHEN pk.key_ordinal IS NOT NULL THEN \'YES\' ELSE \'NO\' END AS is_primary_key,',
    '       pk.key_ordinal AS pk_ordinal,',
    '       uq.name AS unique_constraint_name,',
    '       fk.name AS fk_constraint_name,',
    '       fk.ord AS fk_ordinal,',
    '       fk.ref_schema AS fk_table_schema,',
    '       fk.ref_table AS fk_table,',
    '       fk.ref_column AS fk_column,',
    '       COUNT(*) OVER () AS total_rows',
    'FROM sys.objects o',
    'JOIN sys.schemas s ON s.schema_id = o.schema_id',
    'JOIN sys.columns c ON c.object_id = o.object_id',
    'JOIN sys.types ty ON ty.user_type_id = c.user_type_id',
    'LEFT JOIN sys.extended_properties tp ON tp.class = 1 AND tp.major_id = o.object_id AND tp.minor_id = 0 AND tp.name = \'MS_Description\'',
    'LEFT JOIN sys.extended_properties cp ON cp.class = 1 AND cp.major_id = o.object_id AND cp.minor_id = c.column_id AND cp.name = \'MS_Description\'',
    'LEFT JOIN (',
    '  SELECT parent_object_id, parent_column_id, SUBSTRING(definition, 2, LEN(definition) - 2) AS d FROM sys.default_constraints',
    ') dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id',
    'LEFT JOIN (',
    '  SELECT ic.object_id, ic.column_id, ic.key_ordinal',
    '  FROM sys.key_constraints kc',
    '  JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id',
    '  WHERE kc.type = \'PK\'',
    ') pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id',
    'LEFT JOIN (',
    '  -- Each unique key (constraint or index) the column is a key column of: never a filtered or disabled index, never an included column.',
    '  SELECT i.object_id, ic.column_id, i.name',
    '  FROM sys.indexes i',
    '  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0 AND ic.is_included_column = 0',
    '  WHERE i.is_unique = 1 AND i.is_primary_key = 0 AND i.has_filter = 0 AND i.is_disabled = 0 AND i.is_hypothetical = 0',
    ') uq ON uq.object_id = c.object_id AND uq.column_id = c.column_id',
    'LEFT JOIN (',
    '  SELECT fkc.parent_object_id, fkc.parent_column_id, f.name, fkc.constraint_column_id AS ord,',
    '         SCHEMA_NAME(r.schema_id) AS ref_schema, r.name AS ref_table, rc.name AS ref_column',
    '  FROM sys.foreign_keys f',
    '  JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = f.object_id',
    '  JOIN sys.objects r ON r.object_id = fkc.referenced_object_id',
    '  JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id',
    ') fk ON fk.parent_object_id = c.object_id AND fk.parent_column_id = c.column_id',
    'WHERE o.type IN (\'U\', \'V\') AND o.is_ms_shipped = 0 AND NOT (s.name = \'dbo\' AND o.name = \'sysdiagrams\')',
    'ORDER BY table_schema, table_name, ordinal_position, unique_constraint_name, fk_constraint_name;',
  ].join('\n'),
  postgresCatalogRun: 'psql -d <database> --csv -f catalog.sql -o catalog.csv',
  mysqlCatalogRun: 'mysql --batch --execute="source catalog.sql" > catalog.tsv',
} as const satisfies Record<string, string>;
export type ImportGuideSnippet = keyof typeof IMPORT_GUIDE_SNIPPETS;

/** One step: plain text (`code` in backticks), and the command to copy, if any. */
export interface ImportGuideStep {
  text: string;
  snippet?: ImportGuideSnippet;
}

/**
 * A part of a card: its steps, any notes, and the button that imports what
 * they made. Steps are consecutive actions: one step shows on its own, never
 * as "1.", with the button under it; two or more are numbered, and the import
 * is the last number. An alternative or a fallback (a whole database instead
 * of a schema, an option Power BI hides) is a note, shown quietly after the
 * action, never a numbered step. Getting the DDL out is at schema or database
 * grain, never one table at a time.
 */
export interface ImportGuideSection {
  heading?: string;
  steps: readonly ImportGuideStep[];
  notes?: readonly string[];
  action: ImportGuideAction;
  /**
   * Set on the one section of a card to use unless you have a reason not to,
   * when the card offers two ways to the same import. It is listed first and
   * is the only way an open card shows; the reason is said where the choice
   * is made, on the other way's {@link useWhen} line.
   */
  recommended?: true;
  /**
   * On the other way: the one line it folds behind, a need and what to use
   * for it ("Need column defaults? Use a notebook instead."). Opening the
   * line shows that way's steps.
   */
  useWhen?: string;
  /**
   * The button's label when it is not the action's own: a second way into
   * the same import (a catalog query's CSV), counted under the same action.
   */
  label?: string;
}

export interface ImportGuideCard {
  id: ImportGuideCardId;
  title: string;
  /** What to export, in a sentence or two. */
  what: string;
  sections: readonly ImportGuideSection[];
}

/** Each button's label: says which import runs, and for SQL which dialect it reads. */
export const IMPORT_GUIDE_ACTION_LABELS: Readonly<Record<Exclude<ImportGuideAction, 'found'>, string>> = {
  dbt: 'Import from dbt',
  databricks: 'Import Databricks DDL…',
  snowflake: 'Import Snowflake DDL…',
  powerBi: 'Import Semantic Model…',
  fabric: 'Import Semantic Model…',
  fabricWarehouse: 'Import SQL Server DDL…',
  sqlServer: 'Import SQL Server DDL…',
  postgres: 'Import PostgreSQL DDL…',
  mysql: 'Import MySQL DDL…',
  dbml: 'Import DBML…',
  otherTools: 'Import…',
  feedback: 'Send Feedback',
};

/** The "Found in this folder" card's button: the start surfaces' own label for that import. */
export const IMPORT_GUIDE_FOUND_LABELS: Readonly<Record<FoundIntent, string>> = {
  importSqlDdl: 'Import your SQL scripts',
  importSemanticModel: 'Import your Power BI semantic model',
  importDbmlFile: 'Import your DBML file',
};

/** The suggestions that lead the guide with a "Found in this folder" card: the three direct imports. */
export type FoundIntent = 'importSqlDdl' | 'importSemanticModel' | 'importDbmlFile';
export function isFoundIntent(intent: StartIntent | undefined): intent is FoundIntent {
  return intent === 'importSqlDdl' || intent === 'importSemanticModel' || intent === 'importDbmlFile';
}

const FOUND_TEXT: Readonly<Record<FoundIntent, string>> = {
  importSqlDdl: 'ERD Studio works out which SQL dialect they are written in: PostgreSQL, MySQL, SQL Server, Snowflake, Databricks, Oracle, BigQuery, Redshift or SQLite.',
  importSemanticModel: 'Its tables, columns and relationships become a diagram; measures stay in Power BI.',
  importDbmlFile: 'Its tables and relationships become a diagram.',
};

/** The SQL import for each SQL card, with its dialect chosen (`erdStudio.importSqlDdl` with `{ dialect }`). */
export const IMPORT_GUIDE_SQL_DIALECTS: Readonly<Partial<Record<ImportGuideAction, SqlDialect>>> = {
  databricks: 'databricks',
  snowflake: 'snowflake',
  fabricWarehouse: 'sqlserver',
  sqlServer: 'sqlserver',
  postgres: 'postgres',
  mysql: 'mysql',
};

/** The fixed Send Feedback prefill of the Not yet card (`erdStudio.reportBug`'s argument). */
export const IMPORT_GUIDE_FEEDBACK_PREFILL = {
  kind: 'feature',
  title: 'Import from another source',
  description: 'I would like to bring in my data model from: ',
} as const;

/**
 * The command (and arguments) each button runs: fixed here, never from the
 * page. `found` runs the suggestion's own quick import; without a direct
 * import suggested it runs nothing (undefined).
 */
export function importGuideActionCommand(action: ImportGuideAction, intent: StartIntent | undefined): { command: string; args: unknown[] } | undefined {
  const dialect = IMPORT_GUIDE_SQL_DIALECTS[action];
  if (dialect) return { command: 'erdStudio.importSqlDdl', args: [{ dialect }] };
  switch (action) {
    case 'found':
      return isFoundIntent(intent) ? { command: START_ACTION_COMMANDS[intent], args: startActionArgs(intent) } : undefined;
    case 'dbt':
      return { command: 'erdStudio.drawFromDbt', args: [] };
    case 'powerBi':
    case 'fabric':
      return { command: 'erdStudio.importSemanticModel', args: [] };
    case 'dbml':
      return { command: 'erdStudio.importDbml', args: [] };
    case 'otherTools':
      return { command: 'erdStudio.importModel', args: [] };
    case 'feedback':
      return { command: 'erdStudio.reportBug', args: [{ ...IMPORT_GUIDE_FEEDBACK_PREFILL }] };
    default:
      return undefined;
  }
}

/** Whether a button needs an open folder (every import does; Send Feedback does not). */
export function importGuideActionNeedsFolder(action: ImportGuideAction): boolean {
  return action !== 'feedback';
}

/** The sources in the order the guide lists them after the suggestion (telemetry's, most used first). */
export const IMPORT_GUIDE_ORDER: readonly ImportGuideCardId[] = [
  'databricks', 'snowflake', 'powerBi', 'fabric', 'sqlServer', 'postgres', 'mysql', 'dbml', 'otherTools',
];

/** Where the guide stands: is a folder open, is it a dbt project, and what does it suggest. */
export interface ImportGuideContext {
  hasProject: boolean;
  hasDbt: boolean;
  intent?: StartIntent;
}

/**
 * The cards, in order: the folder's suggestion first (a "Found in this
 * folder" card for a direct import; the dbt card in a dbt project, the only
 * place it shows), then every source in {@link IMPORT_GUIDE_ORDER}, then Not
 * yet.
 */
export function importGuideCards(ctx: ImportGuideContext): ImportGuideCardId[] {
  const lead: ImportGuideCardId[] = [];
  if (ctx.hasProject && isFoundIntent(ctx.intent)) lead.push('found');
  if (ctx.hasProject && ctx.hasDbt) lead.push('dbt');
  return [...lead, ...IMPORT_GUIDE_ORDER, 'notYet'];
}

const SOURCE_CARDS: Readonly<Record<Exclude<ImportGuideCardId, 'found'>, ImportGuideCard>> = {
  dbt: {
    id: 'dbt',
    title: 'dbt',
    what: 'This folder is a dbt project: Import from dbt copies your dbt models and their relationship tests into a diagram, and the Physical tab compares your design with what dbt built.',
    sections: [{ steps: [{ text: 'Nothing to export: ERD Studio reads the project as it is.' }], action: 'dbt' }],
  },
  databricks: {
    id: 'databricks',
    title: 'Databricks (Unity Catalog)',
    what: 'Run one query and download its result, or export the CREATE TABLE statements of a whole schema in one notebook cell. Declared PRIMARY KEY and FOREIGN KEY constraints become keys and relationships either way.',
    sections: [
      {
        heading: 'One query, downloaded as CSV',
        recommended: true,
        steps: [
          { text: 'Copy this query.', snippet: 'databricksCatalog' },
          { text: 'Run it in the Databricks SQL editor with your catalog on its `WHERE` line, and download the whole result as CSV into this folder.' },
        ],
        notes: ['Unity Catalog\'s information_schema does not show column defaults or identity columns, so they do not come in. A download of only the first rows is refused: the query counts its rows.'],
        action: 'databricks',
        label: 'Import the CSV…',
      },
      {
        heading: 'CREATE TABLE statements, from a notebook',
        useWhen: 'Need column defaults or identity columns? Use a notebook instead.',
        steps: [
          { text: 'Copy this notebook cell.', snippet: 'databricksSchema' },
          { text: 'Run it in a Python notebook with your catalog and schema, and copy what it prints into `schema.sql` in this folder.' },
        ],
        notes: ['A comment with a backslash in it can come in changed: SHOW CREATE TABLE writes the backslash as it is.'],
        action: 'databricks',
      },
    ],
  },
  snowflake: {
    id: 'snowflake',
    title: 'Snowflake',
    what: 'Snowflake writes the DDL of a whole schema, or a whole database, in one call.',
    sections: [{
      steps: [
        { text: 'Copy this and run it in a worksheet.', snippet: 'snowflakeSchema' },
        { text: 'Copy the result into a `.sql` file in this folder.' },
      ],
      notes: ["For a whole database: `SELECT GET_DDL('DATABASE', '<database>');`"],
      action: 'snowflake',
    }],
  },
  powerBi: {
    id: 'powerBi',
    title: 'Power BI',
    what: 'A report saved as a Power BI project keeps its semantic model in a `<Name>.SemanticModel` folder, which ERD Studio reads (TMDL or `model.bim`).',
    sections: [{
      steps: [
        { text: 'In Power BI Desktop, choose File → Save as, pick Power BI project files (`*.pbip`), and save it in this folder.' },
      ],
      notes: ['No such option? Turn on Power BI Project (.pbip) save option in File → Options and settings → Options → Preview features, then restart Power BI Desktop.'],
      action: 'powerBi',
    }],
  },
  fabric: {
    id: 'fabric',
    title: 'Microsoft Fabric',
    what: 'A semantic model comes in through Fabric\'s Git integration; a Warehouse or a Lakehouse\'s SQL analytics endpoint through its CREATE TABLE scripts.',
    sections: [
      {
        heading: 'Semantic model',
        steps: [
          { text: 'Connect the workspace to a Git repository (Workspace settings → Git integration) and commit. Each semantic model is a `<Name>.SemanticModel` folder in the repository: open the repository here.' },
        ],
        action: 'fabric',
      },
      {
        heading: 'Warehouse or SQL analytics endpoint',
        steps: [
          { text: 'Connect to its SQL connection string in SQL Server Management Studio, select the tables in Object Explorer Details (F7), right-click → Script Table as → CREATE To → File…, and save the `.sql` file in this folder. ERD Studio reads it as SQL Server.' },
        ],
        action: 'fabricWarehouse',
      },
    ],
  },
  sqlServer: {
    id: 'sqlServer',
    title: 'SQL Server and Azure SQL',
    what: 'One query reads every table\'s columns, keys, defaults and descriptions from the database, or SQL Server Management Studio scripts the tables, keys and foreign keys into one file.',
    sections: [
      {
        heading: 'One query, saved as CSV',
        recommended: true,
        steps: [
          { text: 'Copy this query.', snippet: 'sqlServerCatalog' },
          { text: 'Run it on your database in VS Code with Microsoft\'s SQL Server (mssql) extension (Execute Query), then press Save as CSV beside the result and save the file in this folder.' },
        ],
        notes: ['CHECK constraints do not come in; Generate Scripts keeps them. A filtered unique index (one with a WHERE) is not a unique key, so it does not come in. Save the whole result: a part of it is refused, as is sqlcmd\'s output, which does not quote a comment with a comma or a line break in it.'],
        action: 'sqlServer',
        label: 'Import the CSV…',
      },
      {
        heading: 'Generate Scripts, in SQL Server Management Studio',
        useWhen: 'Need CHECK constraints, or already in SQL Server Management Studio? Use Generate Scripts instead.',
        steps: [
          { text: 'Right-click the database → Tasks → Generate Scripts…, choose the tables, and on Set Scripting Options save to one file in this folder. Schema only is the default (Advanced → Types of data to script).' },
        ],
        notes: ['Leave out `dbo.sysdiagrams` (SQL Server Management Studio\'s own diagrams) when you choose the tables, or it comes in as a table. A computed column comes in without its type.'],
        action: 'sqlServer',
      },
    ],
  },
  postgres: {
    id: 'postgres',
    title: 'PostgreSQL',
    what: 'pg_dump writes the schema without the data, or one query reads every table\'s columns and keys from the catalog.',
    sections: [
      {
        heading: 'pg_dump',
        recommended: true,
        steps: [{ text: 'Run this in a terminal in this folder (add `-n <schema>` for one schema):', snippet: 'postgres' }],
        action: 'postgres',
      },
      {
        heading: 'One query, saved as CSV',
        useWhen: 'Can\'t run pg_dump? Use one query instead.',
        steps: [
          { text: 'Save this query as `catalog.sql` in this folder:', snippet: 'postgresCatalog' },
          { text: 'Run it with psql (PostgreSQL 12 or later), which writes the CSV:', snippet: 'postgresCatalogRun' },
        ],
        notes: ['Partitions come in as their parent table. CHECK constraints and identity columns do not come in; pg_dump keeps them.'],
        action: 'postgres',
        label: 'Import the CSV…',
      },
    ],
  },
  mysql: {
    id: 'mysql',
    title: 'MySQL and MariaDB',
    what: 'mysqldump writes the tables without the data (MariaDB also calls it mariadb-dump), or one query reads every table\'s columns and keys from the catalog. Add `-h`, `-u` and `-p` as you connect.',
    sections: [
      {
        heading: 'mysqldump',
        recommended: true,
        steps: [{ text: 'Run this in a terminal in this folder:', snippet: 'mysql' }],
        action: 'mysql',
      },
      {
        heading: 'One query, saved as TSV',
        useWhen: 'Can\'t run mysqldump? Use one query instead.',
        steps: [
          { text: 'Save this query as `catalog.sql` in this folder:', snippet: 'mysqlCatalog' },
          { text: 'Run it with the mysql client (MySQL 8, or MariaDB 10.2 or later), which writes the result tab-separated:', snippet: 'mysqlCatalogRun' },
        ],
        notes: ['CHECK constraints do not come in; mysqldump keeps them.'],
        action: 'mysql',
        label: 'Import the TSV…',
      },
    ],
  },
  dbml: {
    id: 'dbml',
    title: 'dbdiagram.io and other DBML tools',
    what: 'DBML is the open-source schema language behind dbdiagram.io: ERD Studio imports it as it is.',
    sections: [{
      steps: [
        { text: 'dbdiagram.io: copy all the code from the editor into a file such as `model.dbml` in this folder.' },
      ],
      notes: ['Another DBML tool: save or export the `.dbml` file into this folder.'],
      action: 'dbml',
    }],
  },
  otherTools: {
    id: 'otherTools',
    title: 'Other modelling tools',
    what: 'erwin Data Modeler, ER/Studio, DbSchema, DBeaver, DataGrip, Visual Paradigm and most other tools can generate SQL DDL (often called forward engineering) or export DBML.',
    sections: [{
      steps: [
        { text: 'Generate the DDL for PostgreSQL, MySQL, SQL Server, Snowflake or Databricks (or export DBML), save it in this folder, then pick it in Import….' },
      ],
      notes: ['Oracle, BigQuery, Amazon Redshift and SQLite: save the CREATE TABLE scripts in this folder (a SQL*Plus script, `INFORMATION_SCHEMA.TABLES.ddl`, `SHOW TABLE` output, a `.schema` dump), then pick them in Import….'],
      action: 'otherTools',
    }],
  },
  notYet: {
    id: 'notYet',
    title: 'Not yet',
    what: 'Some sources do not come in yet. Tell us which one you need.',
    sections: [{
      steps: [
        { text: 'Live database connections: ERD Studio reads files you export, never a database.' },
      ],
      action: 'feedback',
    }],
  },
};

/** A card's content; the "Found in this folder" card follows the suggestion (undefined without a direct import). */
export function importGuideCard(id: ImportGuideCardId, intent?: StartIntent): ImportGuideCard | undefined {
  if (id !== 'found') return SOURCE_CARDS[id];
  if (!isFoundIntent(intent)) return undefined;
  return {
    id: 'found',
    title: 'Found in this folder',
    what: START_INTENT_REASONS[intent] ?? '',
    sections: [{ steps: [{ text: FOUND_TEXT[intent] }], action: 'found' }],
  };
}

/** A button's label (the found card's follows the suggestion). */
export function importGuideActionLabel(action: ImportGuideAction, intent?: StartIntent): string {
  if (action === 'found') return isFoundIntent(intent) ? IMPORT_GUIDE_FOUND_LABELS[intent] : '';
  return IMPORT_GUIDE_ACTION_LABELS[action];
}

// ---------------------------------------------------------------------------
// Telemetry: fixed keys only (never a name, a path or what was copied)
// ---------------------------------------------------------------------------

export const IMPORT_GUIDE_OPENED_FEATURE = 'importGuideOpened' satisfies TelemetryFeature;
export const IMPORT_GUIDE_COPIED_FEATURE = 'importGuideCopied' satisfies TelemetryFeature;

/** Where it was opened from, beside `importGuideOpened` (the palette has none). */
export const IMPORT_GUIDE_SURFACE_FEATURES: Readonly<Record<ImportGuideSurface, TelemetryFeature>> = {
  welcome: 'importGuideFromWelcome',
  walkthrough: 'importGuideFromWalkthrough',
  sidebar: 'importGuideFromSidebar',
  picker: 'importGuideFromPicker',
  startPick: 'importGuideFromStartPick',
  prompt: 'importGuideFromPrompt',
  draft: 'importGuideFromDraft',
};

/** Which card's button was pressed. */
export const IMPORT_GUIDE_ACTION_FEATURES: Readonly<Record<ImportGuideAction, TelemetryFeature>> = {
  found: 'importGuideActionFound',
  dbt: 'importGuideActionDbt',
  databricks: 'importGuideActionDatabricks',
  snowflake: 'importGuideActionSnowflake',
  powerBi: 'importGuideActionPowerBi',
  fabric: 'importGuideActionFabric',
  fabricWarehouse: 'importGuideActionFabricWarehouse',
  sqlServer: 'importGuideActionSqlServer',
  postgres: 'importGuideActionPostgres',
  mysql: 'importGuideActionMysql',
  dbml: 'importGuideActionDbml',
  otherTools: 'importGuideActionOtherTools',
  feedback: 'importGuideActionFeedback',
};

// ---------------------------------------------------------------------------
// The page's protocol
// ---------------------------------------------------------------------------

export type ImportGuideToHost =
  /** A card's button: the host runs that action's fixed command. */
  | { type: 'run'; action: ImportGuideAction }
  /** A Copy button: the host copies that snippet's fixed text. */
  | { type: 'copy'; snippet: ImportGuideSnippet }
  /** No folder open: VS Code's own folder picker. */
  | { type: 'openFolder' };

export function isImportGuideToHost(value: unknown): value is ImportGuideToHost {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const msg = value as { type?: unknown; action?: unknown; snippet?: unknown };
  switch (msg.type) {
    case 'run':
      return (IMPORT_GUIDE_ACTIONS as readonly unknown[]).includes(msg.action);
    case 'copy':
      return typeof msg.snippet === 'string' && Object.prototype.hasOwnProperty.call(IMPORT_GUIDE_SNIPPETS, msg.snippet);
    case 'openFolder':
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The HTML
// ---------------------------------------------------------------------------

/** The page's intro: what it is for, in the wording rules' words. */
export const IMPORT_GUIDE_INTRO =
  'Turn the data model you already have into DBML, an open format your team can read, review and diff in Git.';
export const IMPORT_GUIDE_INTRO_DRY_RUN = 'Each import shows you a draft first: nothing is saved until you keep it.';
export const IMPORT_GUIDE_NO_FOLDER = 'Open the folder you keep your data model in first: each import saves into it.';

export function buildImportGuideCsp(nonce: string): string {
  // img-src data: is for the sources' marks alone (importGuideLogos.ts): images built into the page, never fetched.
  return ["default-src 'none'", 'img-src data:', `style-src 'nonce-${nonce}'`, `script-src 'nonce-${nonce}'`].join('; ') + ';';
}

/** `code` in backticks becomes `<code>`; everything else is escaped text. */
function inline(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code class="ig-code">$1</code>');
}

export const IMPORT_GUIDE_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}
.ig { max-width: 880px; margin: 0 auto; padding: 24px 24px 48px; }
.ig__heading { margin: 0 0 8px; font-size: 1.5em; font-weight: 600; }
.ig__intro { margin: 0 0 6px; line-height: 1.5; max-width: 72ch; }
.ig__note { margin: 0 0 6px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
.ig__nofolder {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin: 14px 0 0; padding: 10px 14px;
  border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); border-radius: 4px;
}
.ig__nofolder-text { margin: 0; }
.ig__cards { display: grid; gap: 8px; margin: 20px 0 0; padding: 0; list-style: none; }
.ig-card {
  /* A grid item: without min-width 0 a long snippet line widens the card (and the page) past the view. */
  min-width: 0;
  padding: 10px 14px; border-radius: 4px;
  border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
}
.ig-card--lead { border-color: var(--vscode-focusBorder); }
/* Every source is one line until it is opened, so the whole list is in view at once; only the folder's own suggestion starts open. */
.ig-card__summary { cursor: pointer; }
.ig-card__logo { display: inline-block; width: 18px; height: 18px; margin: 0 8px 0 4px; vertical-align: -3px; object-fit: contain; }
.ig-card__summary:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.ig-card__fold[open] > .ig-card__summary { margin-bottom: 6px; }
.ig-card__title { display: inline; margin: 0; font-size: 1.1em; font-weight: 600; }
.ig-card__what { margin: 0 0 10px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
.ig-section { margin: 0 0 10px; }
.ig-section:last-child { margin-bottom: 0; }
.ig-section__heading { margin: 0 0 6px; font-weight: 600; }
/* Two parts of a card: a rule between them. The other way to the same import is one line until it is opened. */
.ig-section + .ig-section { padding-top: 10px; border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); }
.ig-alt__summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
.ig-alt__summary:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.ig-alt[open] > .ig-alt__summary { margin-bottom: 8px; }
.ig-steps { margin: 0 0 10px; padding: 0 0 0 20px; }
.ig-step { margin: 0 0 8px; line-height: 1.5; }
.ig-step--only { margin: 0 0 10px; }
.ig-step--import .ig-btn { margin-left: 6px; }
.ig-btn + .ig-note { margin-top: 10px; }

.ig-note { margin: 0 0 10px; line-height: 1.5; font-size: 0.95em; color: var(--vscode-descriptionForeground); }
.ig-code {
  font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
  padding: 0 3px; border-radius: 3px; background: var(--vscode-textCodeBlock-background);
}
.ig-snippet { display: flex; align-items: flex-start; gap: 8px; margin: 6px 0 0; }
.ig-snippet__code {
  /* A flex item: min-width 0 lets it shrink, so a long line scrolls inside it and Copy stays in view. */
  flex: 1 1 auto; min-width: 0; margin: 0; padding: 8px 10px; overflow-x: auto; white-space: pre;
  font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
  border-radius: 3px; background: var(--vscode-textCodeBlock-background);
}
/* A folded snippet takes the code's place in the row: the same shrink rule, so Copy stays in view open or shut. */
.ig-snippet__fold { flex: 1 1 auto; min-width: 0; border-radius: 3px; background: var(--vscode-textCodeBlock-background); }
.ig-snippet__summary { padding: 6px 10px; cursor: pointer; color: var(--vscode-textLink-foreground); }
.ig-snippet__summary:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.ig-snippet__fold .ig-snippet__code { max-height: 22em; overflow-y: auto; background: none; }
.ig-btn {
  padding: 5px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer;
  font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
}
.ig-btn:hover { background: var(--vscode-button-hoverBackground); }
.ig-btn:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.ig-btn--secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
.ig-btn--secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.ig-btn--copy { flex: none; }
`;

const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  document.addEventListener('click', function (event) {
    var el = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!el) { return; }
    var action = el.getAttribute('data-action');
    if (action === 'run') {
      vscode.postMessage({ type: 'run', action: el.getAttribute('data-guide-action') });
    } else if (action === 'copy') {
      vscode.postMessage({ type: 'copy', snippet: el.getAttribute('data-snippet') });
      var before = el.textContent;
      el.textContent = 'Copied';
      setTimeout(function () { el.textContent = before; }, 1600);
    } else if (action === 'openFolder') {
      vscode.postMessage({ type: 'openFolder' });
    }
  });
})();
`;

/** A snippet longer than this many lines starts folded, so a long query does not push the other cards off the page. */
export const IMPORT_GUIDE_FOLD_LINES = 6;

/**
 * A short snippet is shown whole. A long one (a catalog query, the Databricks
 * notebook cell) starts folded behind its line count, in a native `<details>`
 * (no script, so the CSP is unchanged); Copy stays outside the fold, so the
 * usual path — copy, paste, run — needs no unfolding.
 */
function renderSnippet(step: ImportGuideStep): string {
  if (!step.snippet) return '';
  const text = IMPORT_GUIDE_SNIPPETS[step.snippet];
  const lines = text.replace(/\n+$/, '').split('\n').length;
  const code = `<pre class="ig-snippet__code"><code>${escapeHtml(text)}</code></pre>`;
  const body = lines > IMPORT_GUIDE_FOLD_LINES
    ? `<details class="ig-snippet__fold"><summary class="ig-snippet__summary">Show all ${lines} lines</summary>${code}</details>`
    : code;
  return `<div class="ig-snippet">${body}` +
    `<button class="ig-btn ig-btn--secondary ig-btn--copy" type="button" data-action="copy" data-snippet="${step.snippet}">Copy</button></div>`;
}

/** The last numbered step of a way with several: the import itself, so the button is where the reading ends. */
export const IMPORT_GUIDE_IMPORT_STEP = 'Import the file.';

/**
 * A way in, top to bottom in the order it is done. One step stands on its own
 * (no "1."), with the button under it; two or more are numbered, and the
 * import is the last number, so the list is the whole job. Notes (what does
 * not come in, a fallback) follow, quietly, after the action.
 */
function renderSteps(section: ImportGuideSection, button: string): string {
  const steps = section.steps.length === 1
    ? `<div class="ig-step ig-step--only">${inline(section.steps[0].text)}${renderSnippet(section.steps[0])}</div>${button}`
    : `<ol class="ig-steps">${section.steps.map((step) => `<li class="ig-step">${inline(step.text)}${renderSnippet(step)}</li>`).join('')}` +
      `<li class="ig-step ig-step--import">${escapeHtml(IMPORT_GUIDE_IMPORT_STEP)} ${button}</li></ol>`;
  const notes = (section.notes ?? []).map((note) => `<p class="ig-note">${inline(note)}</p>`).join('');
  return steps + notes;
}

/**
 * The source's own mark beside its name, so a reader finds what they use at a
 * glance. An image (never inline SVG), so the page's styles cannot restyle a
 * mark; decorative, since the name is right beside it. A card with no mark
 * (DBML, other tools, Not yet) keeps the same slot, so the names line up.
 */
function renderLogo(id: ImportGuideCardId): string {
  const src = IMPORT_GUIDE_LOGOS[id];
  return src ? `<img class="ig-card__logo" alt="" src="${src}">` : '<span class="ig-card__logo"></span>';
}

/**
 * An open card shows one way in and one main button. Where a source has two
 * ways to the same import, the recommended one is the card and the other
 * folds behind the line that says when to use it; its button is a quiet one.
 * A card whose sections are different sources (Fabric) shows each, headed.
 * The opening sentence is left out where the steps already say it (a card
 * with a recommended way).
 */
function renderCard(card: ImportGuideCard, lead: boolean, intent: StartIntent | undefined): string {
  const hasRecommended = card.sections.some((section) => section.recommended);
  const sections = card.sections.map((section) => {
    const button = `<button class="ig-btn${section.useWhen ? ' ig-btn--secondary' : ''}" type="button" data-action="run" data-guide-action="${section.action}">${escapeHtml(section.label ?? importGuideActionLabel(section.action, intent))}</button>`;
    const body = renderSteps(section, button);
    if (section.useWhen) {
      return `
      <details class="ig-section ig-alt">
        <summary class="ig-alt__summary">${inline(section.useWhen)}</summary>
        ${body}
      </details>`;
    }
    return `
      <div class="ig-section">${section.heading && !hasRecommended ? `
        <h3 class="ig-section__heading">${escapeHtml(section.heading)}</h3>` : ''}
        ${body}
      </div>`;
  }).join('');
  return `
    <li class="ig-card${lead ? ' ig-card--lead' : ''}" data-card="${card.id}">
      <details class="ig-card__fold"${lead ? ' open' : ''}>
        <summary class="ig-card__summary">${renderLogo(card.id)}<h2 class="ig-card__title">${escapeHtml(card.title)}</h2></summary>${hasRecommended ? '' : `
        <p class="ig-card__what">${inline(card.what)}</p>`}${sections}
      </details>
    </li>`;
}

/**
 * The page: the intro, an open-a-folder line when none is open, then the
 * cards in {@link importGuideCards} order, each folded to its name. An open
 * card has one main button per way it shows; the other way's button, and
 * every Copy, is a quiet one.
 */
export function buildImportGuideHtml(ctx: ImportGuideContext, nonce: string): string {
  const n = escapeHtml(nonce);
  const ids = importGuideCards(ctx);
  const suggested = ids[0] === 'found' || ids[0] === 'dbt';
  const cards = ids
    .map((id) => importGuideCard(id, ctx.intent))
    .filter((card): card is ImportGuideCard => card !== undefined)
    .map((card, i) => renderCard(card, suggested && i === 0, ctx.intent))
    .join('');
  const noFolder = ctx.hasProject ? '' : `
  <div class="ig__nofolder">
    <p class="ig__nofolder-text">${escapeHtml(IMPORT_GUIDE_NO_FOLDER)}</p>
    <button class="ig-btn" type="button" data-action="openFolder">Open Folder&hellip;</button>
  </div>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(buildImportGuideCsp(nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(IMPORT_GUIDE_TITLE)}</title>
<style nonce="${n}">${IMPORT_GUIDE_STYLE}</style>
</head>
<body>
<main class="ig" data-project="${ctx.hasProject}">
  <h1 class="ig__heading">${escapeHtml(IMPORT_GUIDE_TITLE)}</h1>
  <p class="ig__intro">${escapeHtml(IMPORT_GUIDE_INTRO)}</p>
  <p class="ig__note">${escapeHtml(IMPORT_GUIDE_INTRO_DRY_RUN)}</p>${noFolder}
  <ol class="ig__cards">${cards}
  </ol>
</main>
<script nonce="${n}">${SCRIPT}</script>
</body>
</html>`;
}
