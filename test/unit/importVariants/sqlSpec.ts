/**
 * A tiny spec → SQL DDL generator for the import variant corpora.
 *
 * A {@link SqlSpec} says what a schema holds (tables, columns, keys, foreign
 * keys, comments); {@link specToDdl} writes it in one dialect, with knobs for
 * the ways real files differ that should not change what is imported (line
 * endings, a BOM, keyword case, quoting, template placeholders, trailing
 * table options, where the foreign keys are declared, files per table, huge
 * copies) — and returns the truth counts beside the files. Because the
 * generator knows the truth, a variant test asserts conservation
 * (source = imported + reported) without a second SQL parser.
 *
 * Test-only; pure.
 */
import type { SqlDdlFile, SqlDialect } from '../../../src/services/sqlDdlImport';

export type SpecType = 'int' | 'bigint' | 'text' | 'varchar' | 'decimal' | 'timestamp' | 'date' | 'boolean';

export interface SpecColumn {
  name: string;
  type: SpecType;
  notNull?: boolean;
  /** A single-column primary key, inline. */
  pk?: boolean;
  unique?: boolean;
  comment?: string;
  /** A literal default, as SQL (`0`, `'new'`). */
  default?: string;
}

export interface SpecForeignKey {
  columns: string[];
  table: string;
  references: string[];
  name?: string;
}

export interface SpecTable {
  name: string;
  columns: SpecColumn[];
  /** A composite (or table-level) primary key. */
  primaryKey?: string[];
  uniques?: string[][];
  foreignKeys?: SpecForeignKey[];
  comment?: string;
}

export interface SqlSpec {
  tables: SpecTable[];
}

/** Template placeholder syntaxes, as a schema qualifier (`${schema}.orders`). */
export const PLACEHOLDER_SYNTAXES = {
  dollarBrace: '${schema}',
  jinja: '{{ schema }}',
  dollarParen: '$(schema)',
  atAt: '@schema@',
  erb: '<%= schema %>',
  percentS: '%(schema)s',
  ampersand: '&schema.',
} as const;
export type PlaceholderSyntax = keyof typeof PLACEHOLDER_SYNTAXES;

/** Table options after the column list, per dialect (each a real one the dialect accepts). */
export const TRAILING_OPTIONS: Readonly<Record<SqlDialect, readonly string[]>> = {
  postgres: ['WITH (fillfactor = 70)', 'TABLESPACE pg_default'],
  mysql: ['ENGINE=InnoDB', 'DEFAULT CHARSET=utf8mb4', 'ROW_FORMAT=DYNAMIC'],
  sqlserver: ['ON [PRIMARY]', 'WITH (DATA_COMPRESSION = PAGE)'],
  snowflake: ['CLUSTER BY (id)', 'DATA_RETENTION_TIME_IN_DAYS = 1', "COMMENT = 'generated'"],
  databricks: ['USING DELTA', 'CLUSTER BY (id)', "TBLPROPERTIES ('delta.feature.allowColumnDefaults' = 'supported')", "LOCATION '/mnt/x'"],
  oracle: ['TABLESPACE users', 'PCTFREE 10 STORAGE (INITIAL 64K NEXT 1M)', 'NOCOMPRESS LOGGING'],
  bigquery: ['PARTITION BY _PARTITIONDATE', 'CLUSTER BY id', "OPTIONS(labels = [('team', 'sales')])"],
  redshift: ['DISTSTYLE KEY', 'DISTKEY (id)', 'COMPOUND SORTKEY (id)', 'BACKUP NO'],
  sqlite: ['WITHOUT ROWID', 'STRICT'],
};

export interface VariantKnobs {
  dialect: SqlDialect;
  lineEnding?: '\n' | '\r\n';
  bom?: boolean;
  keywordCase?: 'upper' | 'lower' | 'mixed';
  /** `dialect`: every name in the dialect's own quotes (`"x"`, `` `x` ``, `[x]`). */
  quoting?: 'none' | 'dialect';
  /** Every table name qualified by a template placeholder. */
  placeholder?: PlaceholderSyntax;
  /** Indexes into the dialect's {@link TRAILING_OPTIONS}, in the order written after each column list. */
  trailingOptions?: readonly number[];
  /** Where foreign keys go: inside the table, one ALTER TABLE each, or one ALTER TABLE listing all of a table's. */
  fkStyle?: 'table' | 'alter' | 'alterList';
  /** The table's COMMENT before its other options (Snowflake's `COMMENT = '…' CLUSTER BY (…)`), not after. */
  tableCommentFirst?: boolean;
  /** One file per table (and one for the ALTERs), instead of one file. */
  filePerTable?: boolean;
  /** The spec's tables this many times (names suffixed `_2`, `_3`…): a huge file. */
  copies?: number;
  /**
   * Extra columns on every table, one per class, that the dialect's grammar
   * may not read as written (the repair ladder's classes): an exotic type, a
   * column named like a keyword (unquoted), a column modifier.
   */
  extras?: readonly ExtraColumnClass[];
  /** One more table no dialect reads (an empty column definition): it must be reported, the rest imported. */
  brokenTable?: boolean;
  /** A routine whose body holds a CREATE TABLE and semicolons (MySQL: in a DELIMITER block; elsewhere its own quoting): never imported. */
  routine?: boolean;
}

export type ExtraColumnClass = 'exoticType' | 'keywordColumn' | 'modifier';

/** Per dialect, a column of each extra class (name, then the rest of its definition). */
export const EXTRA_COLUMNS: Readonly<Record<SqlDialect, Readonly<Record<ExtraColumnClass, string>>>> = {
  postgres: { exoticType: 'geom geometry(Point,4326)', keywordColumn: 'order int', modifier: 'hours numeric(4,2) GENERATED ALWAYS AS (1.5) VIRTUAL' },
  mysql: { exoticType: 'spot POINT NOT NULL SRID 4326', keywordColumn: 'key int', modifier: 'touched timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP INVISIBLE' },
  sqlserver: { exoticType: 'doc XML(dbo.DocSchemaCollection) NULL', keywordColumn: 'user nvarchar(20)', modifier: 'note nvarchar(10) SPARSE NULL' },
  snowflake: { exoticType: 'embedding VECTOR(FLOAT, 768)', keywordColumn: 'FILE_FORMAT varchar(20)', modifier: 'secret varchar(9) WITH MASKING POLICY mask_secret' },
  databricks: { exoticType: 'attrs MAP<STRING, ARRAY<INT>>', keywordColumn: 'date DATE', modifier: 'masked_email STRING MASK mask_email USING COLUMNS (id)' },
  oracle: { exoticType: 'seen TIMESTAMP(6) WITH LOCAL TIME ZONE', keywordColumn: 'timestamp TIMESTAMP', modifier: 'margin NUMBER(10,2) GENERATED ALWAYS AS (1.5) VIRTUAL' },
  bigquery: { exoticType: 'tags ARRAY<STRUCT<k STRING, v INT64>>', keywordColumn: 'timestamp TIMESTAMP', modifier: "code STRING COLLATE 'und:ci'" },
  redshift: { exoticType: 'payload SUPER', keywordColumn: 'type varchar(10)', modifier: 'note varchar(10) ENCODE zstd' },
  sqlite: { exoticType: 'big UNSIGNED BIG INT', keywordColumn: 'action TEXT', modifier: 'code TEXT COLLATE NOCASE' },
};

/** A routine per dialect whose body holds a CREATE TABLE (never one of the schema's tables). */
const ROUTINES: Readonly<Record<SqlDialect, string>> = {
  postgres: 'CREATE FUNCTION f() RETURNS void AS $$\nBEGIN\n  CREATE TEMPORARY TABLE tmp_x (id int);\n  DROP TABLE tmp_x;\nEND;\n$$ LANGUAGE plpgsql;',
  mysql: 'DELIMITER ;;\nCREATE PROCEDURE p()\nBEGIN\n  CREATE TEMPORARY TABLE tmp_x (id int);\n  DROP TABLE tmp_x;\nEND ;;\nDELIMITER ;',
  sqlserver: 'CREATE PROCEDURE p AS\nBEGIN\n  CREATE TABLE #tmp_x (id int);\n  DROP TABLE #tmp_x;\nEND;',
  snowflake: "CREATE PROCEDURE p() RETURNS STRING LANGUAGE SQL AS $$\nBEGIN\n  CREATE TEMPORARY TABLE tmp_x (id int);\n  RETURN 'x';\nEND;\n$$;",
  databricks: 'CREATE FUNCTION f() RETURNS INT RETURN 1;',
  oracle: "CREATE OR REPLACE PROCEDURE p AS\nBEGIN\n  EXECUTE IMMEDIATE 'CREATE TABLE tmp_x (id NUMBER)';\n  NULL;\nEND;\n/",
  bigquery: 'CREATE PROCEDURE p()\nBEGIN\n  CREATE TEMP TABLE tmp_x (id INT64);\n  DROP TABLE tmp_x;\nEND;',
  redshift: 'CREATE OR REPLACE PROCEDURE p()\nAS $$\nBEGIN\n  CREATE TEMP TABLE tmp_x (id int);\n  DROP TABLE tmp_x;\nEND;\n$$ LANGUAGE plpgsql;',
  sqlite: 'CREATE TRIGGER trg AFTER INSERT ON customer\nBEGIN\n  INSERT INTO customer_profile (customer_id, vip) VALUES (new.id, 0);\n  UPDATE customer SET email = lower(email) WHERE id = new.id;\nEND;',
};

export interface SpecTruth {
  tables: number;
  /** Tables in the files that no dialect reads (each must be reported); absent: none. */
  unreadableTables?: number;
  columns: number;
  primaryKeys: number;
  /** Foreign keys, a composite once. */
  relationships: number;
  /** Foreign keys whose columns are all NOT NULL (D18's note counts these). */
  requiredRelationships: number;
  uniqueKeys: number;
  /** Table and column comments. */
  descriptions: number;
}

const TYPES: Readonly<Record<SqlDialect, Readonly<Record<SpecType, string>>>> = {
  postgres: { int: 'integer', bigint: 'bigint', text: 'text', varchar: 'varchar(100)', decimal: 'numeric(10,2)', timestamp: 'timestamp', date: 'date', boolean: 'boolean' },
  mysql: { int: 'int', bigint: 'bigint', text: 'text', varchar: 'varchar(100)', decimal: 'decimal(10,2)', timestamp: 'datetime', date: 'date', boolean: 'tinyint(1)' },
  sqlserver: { int: 'int', bigint: 'bigint', text: 'nvarchar(max)', varchar: 'nvarchar(100)', decimal: 'decimal(10,2)', timestamp: 'datetime2', date: 'date', boolean: 'bit' },
  snowflake: { int: 'number(38,0)', bigint: 'number(38,0)', text: 'varchar', varchar: 'varchar(100)', decimal: 'number(10,2)', timestamp: 'timestamp_ntz', date: 'date', boolean: 'boolean' },
  databricks: { int: 'int', bigint: 'bigint', text: 'string', varchar: 'string', decimal: 'decimal(10,2)', timestamp: 'timestamp', date: 'date', boolean: 'boolean' },
  oracle: { int: 'NUMBER(10)', bigint: 'NUMBER(19)', text: 'CLOB', varchar: 'VARCHAR2(100 CHAR)', decimal: 'NUMBER(10,2)', timestamp: 'TIMESTAMP(6)', date: 'DATE', boolean: 'NUMBER(1)' },
  bigquery: { int: 'INT64', bigint: 'INT64', text: 'STRING', varchar: 'STRING(100)', decimal: 'NUMERIC(10, 2)', timestamp: 'TIMESTAMP', date: 'DATE', boolean: 'BOOL' },
  redshift: { int: 'integer', bigint: 'bigint', text: 'varchar(max)', varchar: 'varchar(100)', decimal: 'decimal(10,2)', timestamp: 'timestamp', date: 'date', boolean: 'boolean' },
  sqlite: { int: 'INTEGER', bigint: 'INTEGER', text: 'TEXT', varchar: 'VARCHAR(100)', decimal: 'NUMERIC(10,2)', timestamp: 'DATETIME', date: 'DATE', boolean: 'BOOLEAN' },
};

/** A small schema with the shapes that matter: a composite PK and FK, a one-to-one (unique FK), required and optional FKs, comments, a unique key. */
export function sampleSpec(): SqlSpec {
  return {
    tables: [
      { name: 'customer', comment: 'People who buy.', columns: [
        { name: 'id', type: 'int', pk: true, notNull: true },
        { name: 'email', type: 'varchar', notNull: true, unique: true, comment: 'Login.' },
        { name: 'created_at', type: 'timestamp', notNull: true },
      ] },
      { name: 'orders', columns: [
        { name: 'id', type: 'bigint', pk: true, notNull: true },
        { name: 'customer_id', type: 'int', notNull: true },
        { name: 'status', type: 'varchar', default: "'new'" },
        { name: 'total', type: 'decimal', default: '0' },
        { name: 'billing_customer_id', type: 'int' },
      ], foreignKeys: [
        { columns: ['customer_id'], table: 'customer', references: ['id'], name: 'fk_orders_customer' },
        { columns: ['billing_customer_id'], table: 'customer', references: ['id'], name: 'fk_orders_billing' },
      ] },
      { name: 'order_line', primaryKey: ['order_id', 'line_no'], columns: [
        { name: 'order_id', type: 'bigint', notNull: true },
        { name: 'line_no', type: 'int', notNull: true },
        { name: 'product_code', type: 'varchar', comment: 'SKU.' },
        { name: 'quantity', type: 'int', notNull: true },
      ], foreignKeys: [{ columns: ['order_id'], table: 'orders', references: ['id'] }] },
      { name: 'shipment', columns: [
        { name: 'id', type: 'int', pk: true, notNull: true },
        { name: 'order_id', type: 'bigint' },
        { name: 'line_no', type: 'int' },
        { name: 'shipped_on', type: 'date' },
      ], foreignKeys: [{ columns: ['order_id', 'line_no'], table: 'order_line', references: ['order_id', 'line_no'], name: 'fk_shipment_line' }] },
      { name: 'customer_profile', columns: [
        { name: 'customer_id', type: 'int', pk: true, notNull: true },
        { name: 'vip', type: 'boolean', notNull: true, default: '0' },
        { name: 'notes', type: 'text' },
      ], uniques: [], foreignKeys: [{ columns: ['customer_id'], table: 'customer', references: ['id'] }] },
    ],
  };
}

const KEYWORD = /\b(CREATE|TABLE|NOT|NULL|PRIMARY|KEY|UNIQUE|FOREIGN|REFERENCES|CONSTRAINT|ALTER|ADD|DEFAULT|COMMENT|ON|IS|COLUMN|EXEC)\b/g;

function cased(text: string, mode: VariantKnobs['keywordCase']): string {
  if (!mode || mode === 'upper') return text;
  let n = 0;
  return text.replace(KEYWORD, (w) => {
    if (mode === 'lower') return w.toLowerCase();
    n++;
    return n % 2 ? w.toLowerCase() : w[0] + w.slice(1).toLowerCase();
  });
}

function quote(name: string, knobs: VariantKnobs): string {
  if (knobs.quoting !== 'dialect') return name;
  switch (knobs.dialect) {
    case 'mysql': case 'databricks': case 'bigquery': return `\`${name}\``;
    case 'sqlserver': case 'sqlite': return `[${name}]`;
    default: return `"${name}"`;
  }
}

const sqlString = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/** The spec's tables `copies` times over, foreign keys pointing within each copy. */
function copied(spec: SqlSpec, copies: number): SpecTable[] {
  if (copies <= 1) return spec.tables;
  const out: SpecTable[] = [];
  for (let n = 1; n <= copies; n++) {
    const suffix = n === 1 ? '' : `_${n}`;
    for (const t of spec.tables) {
      out.push({
        ...t,
        name: `${t.name}${suffix}`,
        foreignKeys: (t.foreignKeys ?? []).map((fk) => ({ ...fk, table: `${fk.table}${suffix}`, ...(fk.name ? { name: `${fk.name}${suffix}` } : {}) })),
      });
    }
  }
  return out;
}

/** What the spec holds, counted. */
export function specTruth(spec: SqlSpec, copies = 1): SpecTruth {
  const tables = copied(spec, copies);
  const notNull = (t: SpecTable, c: string): boolean => {
    const col = t.columns.find((x) => x.name === c);
    return !!col && (col.notNull === true || col.pk === true || (t.primaryKey ?? []).includes(c));
  };
  return {
    tables: tables.length,
    columns: tables.reduce((n, t) => n + t.columns.length, 0),
    primaryKeys: tables.filter((t) => (t.primaryKey?.length ?? 0) > 0 || t.columns.some((c) => c.pk)).length,
    relationships: tables.reduce((n, t) => n + (t.foreignKeys?.length ?? 0), 0),
    requiredRelationships: tables.reduce((n, t) => n + (t.foreignKeys ?? []).filter((fk) => fk.columns.every((c) => notNull(t, c))).length, 0),
    uniqueKeys: tables.reduce((n, t) => n + t.columns.filter((c) => c.unique).length + (t.uniques?.length ?? 0), 0),
    descriptions: tables.reduce((n, t) => n + (t.comment ? 1 : 0) + t.columns.filter((c) => c.comment).length, 0),
  };
}

/** The spec written as `knobs` say: the files, and what they hold. */
export function specToDdl(spec: SqlSpec, knobs: VariantKnobs): { files: SqlDdlFile[]; truth: SpecTruth } {
  const d = knobs.dialect;
  const eol = knobs.lineEnding ?? '\n';
  const fkStyle = knobs.fkStyle ?? 'table';
  const tables = copied(spec, knobs.copies ?? 1);
  const prefix = knobs.placeholder ? `${PLACEHOLDER_SYNTAXES[knobs.placeholder]}` : '';
  const tableName = (name: string): string => (prefix ? `${prefix.endsWith('.') ? prefix : `${prefix}.`}${quote(name, knobs)}` : quote(name, knobs));
  const inlineComments = d === 'mysql' || d === 'databricks' || d === 'snowflake' || d === 'bigquery';
  // SQLite has no comments on tables or columns: its files hold none.
  const comments = d !== 'sqlite';
  const columnList = (cols: readonly string[]): string => cols.map((c) => quote(c, knobs)).join(', ');
  const fkClause = (fk: SpecForeignKey): string =>
    `${fk.name ? `CONSTRAINT ${quote(fk.name, knobs)} ` : ''}FOREIGN KEY (${columnList(fk.columns)}) REFERENCES ${tableName(fk.table)} (${columnList(fk.references)})`;

  const tableSql = new Map<string, string>();
  const alters: string[] = [];
  const after: string[] = [];
  for (const t of tables) {
    const lines: string[] = [];
    for (const c of t.columns) {
      const parts = [quote(c.name, knobs), TYPES[d][c.type]];
      if (c.notNull) parts.push('NOT NULL');
      if (c.default !== undefined) parts.push(`DEFAULT ${c.default}`);
      if (c.pk) parts.push('PRIMARY KEY');
      if (c.unique) parts.push('UNIQUE');
      if (c.comment && inlineComments) parts.push(d === 'bigquery' ? `OPTIONS(description = ${sqlString(c.comment)})` : `COMMENT ${sqlString(c.comment)}`);
      lines.push(`  ${parts.join(' ')}`);
    }
    for (const extra of knobs.extras ?? []) lines.push(`  ${EXTRA_COLUMNS[d][extra]}`);
    if (t.primaryKey?.length) lines.push(`  PRIMARY KEY (${columnList(t.primaryKey)})`);
    for (const u of t.uniques ?? []) lines.push(`  UNIQUE (${columnList(u)})`);
    if (fkStyle === 'table') for (const fk of t.foreignKeys ?? []) lines.push(`  ${fkClause(fk)}`);
    const options = (knobs.trailingOptions ?? []).map((i) => TRAILING_OPTIONS[d][i]).filter(Boolean);
    const tableComment = t.comment && inlineComments
      ? [d === 'mysql' ? `COMMENT=${sqlString(t.comment)}` : d === 'snowflake' ? `COMMENT = ${sqlString(t.comment)}` : d === 'bigquery' ? `OPTIONS(description = ${sqlString(t.comment)})` : `COMMENT ${sqlString(t.comment)}`]
      : [];
    const tail = knobs.tableCommentFirst ? [...tableComment, ...options] : [...options, ...tableComment];
    tableSql.set(t.name, `CREATE TABLE ${tableName(t.name)} (${eol}${lines.join(`,${eol}`)}${eol})${tail.length ? ` ${tail.join(' ')}` : ''};`);
    if (fkStyle === 'alter') for (const fk of t.foreignKeys ?? []) alters.push(`ALTER TABLE ${tableName(t.name)} ADD ${fkClause(fk)};`);
    if (fkStyle === 'alterList' && t.foreignKeys?.length) {
      alters.push(`ALTER TABLE ${tableName(t.name)} ADD ${t.foreignKeys.map(fkClause).join(`,${eol}  `)};`);
    }
    if (!inlineComments && comments) {
      const target = tableName(t.name);
      if (d === 'sqlserver') {
        const prop = (text: string, column?: string): string =>
          `EXEC sp_addextendedproperty @name = N'MS_Description', @value = N${sqlString(text)}, @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N${sqlString(t.name)}${column ? `, @level2type = N'COLUMN', @level2name = N${sqlString(column)}` : ''};`;
        if (t.comment) after.push(prop(t.comment));
        for (const c of t.columns) if (c.comment) after.push(prop(c.comment, c.name));
      } else {
        if (t.comment) after.push(`COMMENT ON TABLE ${target} IS ${sqlString(t.comment)};`);
        for (const c of t.columns) if (c.comment) after.push(`COMMENT ON COLUMN ${target}.${quote(c.name, knobs)} IS ${sqlString(c.comment)};`);
      }
    }
  }
  const sep = d === 'sqlserver' ? `${eol}GO${eol}${eol}` : `${eol}${eol}`;
  const finish = (statements: readonly string[]): string => {
    const text = cased(statements.join(sep), knobs.keywordCase) + eol;
    const normalised = eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text;
    return (knobs.bom ? '﻿' : '') + normalised;
  };
  const extraStatements = [
    ...(knobs.brokenTable ? [`CREATE TABLE ${tableName('broken')} (${eol}  id int,,${eol}  x int${eol});`] : []),
    ...(knobs.routine ? [ROUTINES[d]] : []),
  ];
  const truth = specTruth(spec, knobs.copies ?? 1);
  const adjusted: SpecTruth = {
    ...truth,
    ...(d === 'sqlite' ? { descriptions: 0 } : {}),
    columns: truth.columns + (knobs.extras?.length ?? 0) * truth.tables,
    ...(knobs.brokenTable ? { unreadableTables: 1 } : {}),
  };
  const files: SqlDdlFile[] = knobs.filePerTable
    ? [
      ...tables.map((t) => ({ name: `${t.name}.sql`, text: finish([tableSql.get(t.name)!]) })),
      ...((alters.length || after.length) ? [{ name: 'zz_constraints.sql', text: finish([...alters, ...after]) }] : []),
    ]
    : [{ name: `schema.${d}.sql`, text: finish([...tables.map((t) => tableSql.get(t.name)!), ...extraStatements, ...alters, ...after]) }];
  if (knobs.filePerTable && extraStatements.length) files.push({ name: 'zz_extra.sql', text: finish(extraStatements) });
  return { files, truth: adjusted };
}
