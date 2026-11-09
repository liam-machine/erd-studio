/**
 * The SQL fidelity variant generator: one schema written every way a real
 * script declares structure, in each dialect, with the truth it must import
 * as. Where `sqlSpec.ts` varies how a file is written (line endings,
 * placeholders, table options), this varies where the structure is said:
 *
 *  - types as each dialect spells them, details and all (`timestamp with
 *    time zone`, `int unsigned`, `numeric(10, 2)`, `[decimal](18, 2)`);
 *  - foreign keys inline, in the table, one ALTER TABLE each, or one ALTER
 *    TABLE action list (`ADD CONSTRAINT a …, CONSTRAINT b …`);
 *  - uniqueness inline, as a table constraint (named or not), MySQL's
 *    `UNIQUE KEY`, an ALTER TABLE, or a `CREATE UNIQUE INDEX`, before or
 *    after the foreign keys;
 *  - the schema qualified on every name, or set once by `USE` /
 *    `SET search_path` / `USE SCHEMA`;
 *  - the ALTERs wrapped in the dialect's procedural block (`DO $$ … $$`,
 *    `IF NOT EXISTS (…) BEGIN … END`, `EXECUTE IMMEDIATE $$ … $$`);
 *  - a stale foreign key and unique key added and dropped again (by the
 *    name written, or by PostgreSQL's generated name);
 *  - descriptions in the dialect's own form (`COMMENT ON`, `COMMENT '…'`,
 *    `sp_addextendedproperty`), with quotes and semicolons in them.
 *
 * The truth: every table in schema `shop`, each column's type, the unique
 * keys, the relationships with their cardinality (two are one-to-one: an FK
 * that is its table's whole key, an FK that is unique, and a composite FK
 * that is its table's whole key) and FK actions, and the descriptions.
 */

import type { SqlDdlFile, SqlDialect } from '../../../src/services/sqlDdlImport';

export type FkStyle = 'table' | 'alter' | 'alterList';
export type UniqueStyle = 'inline' | 'table' | 'named' | 'mysqlKey' | 'alter' | 'index';

export interface FidelityKnobs {
  dialect: SqlDialect;
  /** Where foreign keys are declared (default `table`). */
  fk?: FkStyle;
  /** Where the unique keys (customer.email, account.owner_id) are declared (default `named`). */
  unique?: UniqueStyle;
  /** For `alter` / `index` uniqueness: write it before the foreign keys (default after). */
  uniqueFirst?: boolean;
  /** Names qualified with the schema, or the schema set once for the file (default `qualified`). */
  schema?: 'qualified' | 'context';
  /** Every ALTER TABLE wrapped in the dialect's procedural block (PostgreSQL, SQL Server, Snowflake). */
  procedural?: boolean;
  /** A stale foreign key and unique key, added and dropped again. */
  replay?: boolean;
  /** Descriptions on a table and a column, in the dialect's own form. */
  descriptions?: boolean;
  /** SQL Server: `[bracketed]` names and types. */
  brackets?: boolean;
  /** SQL Server: the ALTER list's `WITH CHECK` / `WITH NOCHECK`. */
  withCheck?: 'CHECK' | 'NOCHECK';
  lineEnding?: '\n' | '\r\n';
  keywordCase?: 'upper' | 'lower';
}

export interface FidelityTruthTable {
  name: string;
  columns: Array<{ name: string; type: string }>;
  description?: string;
  columnDescriptions?: Record<string, string>;
}

export interface FidelityTruthRelationship {
  from: string;
  fromColumns: string[];
  to: string;
  toColumns: string[];
  cardinality: 'many-to-one' | 'one-to-one';
  onDelete?: string;
}

export interface FidelityTruth {
  schema: string;
  tables: FidelityTruthTable[];
  /** Unique keys (single or composite) the tables keep, the primary keys aside. */
  uniques: Array<{ table: string; columns: string[] }>;
  relationships: FidelityTruthRelationship[];
}

/** Each logical type as the dialect spells it (with the details an import must keep). */
const TYPES: Readonly<Record<SqlDialect, Readonly<Record<'int' | 'varchar' | 'tz' | 'numeric' | 'list' | 'text', string>>>> = {
  postgres: { int: 'integer', varchar: 'character varying(100)', tz: 'timestamp with time zone', numeric: 'numeric(10, 2)', list: 'text[]', text: 'text' },
  mysql: { int: 'int unsigned', varchar: 'varchar(100)', tz: 'datetime(3)', numeric: 'decimal(10,2)', list: 'json', text: 'text' },
  sqlserver: { int: 'int', varchar: 'nvarchar(100)', tz: 'datetimeoffset(7)', numeric: 'decimal(18, 2)', list: 'nvarchar(max)', text: 'nvarchar(max)' },
  snowflake: { int: 'NUMBER(38,0)', varchar: 'VARCHAR(100)', tz: 'TIMESTAMP_TZ(9)', numeric: 'NUMBER(10,2)', list: 'ARRAY', text: 'VARCHAR' },
  databricks: { int: 'BIGINT', varchar: 'STRING', tz: 'TIMESTAMP', numeric: 'DECIMAL(10,2)', list: 'ARRAY<STRING>', text: 'STRING' },
};

/** Whether the dialect writes FK actions (`ON DELETE …`) the grammar and the import read. */
const ACTIONS: ReadonlySet<SqlDialect> = new Set<SqlDialect>(['postgres', 'mysql', 'sqlserver']);

export const TABLE_DESCRIPTION = 'It\'s the "customer"; one row each.';
export const COLUMN_DESCRIPTION = 'Login; unique, case kept.';

interface SpecColumn { name: string; type: keyof (typeof TYPES)['postgres']; notNull?: boolean; pk?: boolean }
interface SpecFk { name: string; columns: string[]; table: string; references: string[]; cardinality: 'many-to-one' | 'one-to-one'; onDelete?: string }
interface SpecTable { name: string; columns: SpecColumn[]; pk: string[]; fks: SpecFk[]; uniques: Array<{ name: string; columns: string[] }> }

function spec(): SpecTable[] {
  return [
    {
      name: 'customer',
      columns: [
        { name: 'id', type: 'int', notNull: true }, { name: 'email', type: 'varchar', notNull: true }, { name: 'created', type: 'tz' },
        { name: 'score', type: 'numeric' }, { name: 'tags', type: 'list' }, { name: 'remark', type: 'text' },
      ],
      pk: ['id'], fks: [], uniques: [{ name: 'uq_customer_email', columns: ['email'] }],
    },
    {
      name: 'customer_profile',
      columns: [{ name: 'customer_id', type: 'int', notNull: true }, { name: 'bio', type: 'text' }],
      pk: ['customer_id'],
      fks: [{ name: 'fk_profile_customer', columns: ['customer_id'], table: 'customer', references: ['id'], cardinality: 'one-to-one', onDelete: 'cascade' }],
      uniques: [],
    },
    {
      name: 'account',
      columns: [{ name: 'id', type: 'int', notNull: true }, { name: 'owner_id', type: 'int', notNull: true }],
      pk: ['id'],
      fks: [{ name: 'fk_account_owner', columns: ['owner_id'], table: 'customer', references: ['id'], cardinality: 'one-to-one' }],
      uniques: [{ name: 'uq_account_owner', columns: ['owner_id'] }],
    },
    {
      name: 'orders',
      columns: [{ name: 'id', type: 'int', notNull: true }, { name: 'customer_id', type: 'int', notNull: true }, { name: 'billing_account_id', type: 'int' }, { name: 'old_ref', type: 'int' }],
      pk: ['id'],
      fks: [
        { name: 'fk_orders_customer', columns: ['customer_id'], table: 'customer', references: ['id'], cardinality: 'many-to-one', onDelete: 'restrict' },
        { name: 'fk_orders_billing', columns: ['billing_account_id'], table: 'account', references: ['id'], cardinality: 'many-to-one', onDelete: 'set null' },
      ],
      uniques: [],
    },
    {
      name: 'order_line',
      columns: [{ name: 'order_id', type: 'int', notNull: true }, { name: 'line_no', type: 'int', notNull: true }, { name: 'amount', type: 'numeric' }],
      pk: ['order_id', 'line_no'],
      // Part of its key: many-to-one.
      fks: [{ name: 'fk_line_order', columns: ['order_id'], table: 'orders', references: ['id'], cardinality: 'many-to-one' }],
      uniques: [],
    },
    {
      name: 'shipment',
      columns: [{ name: 'order_id', type: 'int', notNull: true }, { name: 'line_no', type: 'int', notNull: true }, { name: 'shipped_at', type: 'tz' }],
      pk: ['order_id', 'line_no'],
      // The whole (composite) key: one-to-one.
      fks: [{ name: 'fk_shipment_line', columns: ['order_id', 'line_no'], table: 'order_line', references: ['order_id', 'line_no'], cardinality: 'one-to-one' }],
      uniques: [],
    },
  ];
}

/** The truth of a variant (it does not depend on how the files say it). */
export function fidelityTruth(knobs: FidelityKnobs): FidelityTruth {
  const t = spec();
  return {
    schema: 'shop',
    tables: t.map((table) => ({
      name: table.name,
      columns: table.columns.map((c) => ({ name: c.name, type: TYPES[knobs.dialect][c.type] })),
      ...(knobs.descriptions && table.name === 'customer' ? { description: TABLE_DESCRIPTION, columnDescriptions: { email: COLUMN_DESCRIPTION } } : {}),
    })),
    uniques: t.flatMap((table) => table.uniques.map((u) => ({ table: table.name, columns: u.columns }))),
    relationships: t.flatMap((table) => table.fks.map((fk) => ({
      from: table.name,
      fromColumns: fk.columns,
      to: fk.table,
      toColumns: fk.references,
      cardinality: fk.cardinality,
      ...(fk.onDelete && ACTIONS.has(knobs.dialect) ? { onDelete: fk.onDelete } : {}),
    }))),
  };
}

/** Whether the dialect can write a variant (the knobs it does not have are left out of the corpus). */
export function fidelitySupports(knobs: FidelityKnobs): boolean {
  const d = knobs.dialect;
  if (knobs.unique === 'mysqlKey' && d !== 'mysql') return false;
  if (knobs.unique === 'index' && (d === 'snowflake' || d === 'databricks')) return false;
  if (knobs.procedural && !(d === 'postgres' || d === 'sqlserver' || d === 'snowflake')) return false;
  if (knobs.schema === 'context' && d === 'sqlserver') return false; // USE picks a database there, never a schema.
  if ((knobs.brackets || knobs.withCheck) && d !== 'sqlserver') return false;
  return true;
}

/** The variant's files: the tables in one file, the ALTERs (and indexes, comments) in a second, in migration order. */
export function fidelitySpecToDdl(knobs: FidelityKnobs): { files: SqlDdlFile[]; truth: FidelityTruth } {
  const d = knobs.dialect;
  const fkStyle = knobs.fk ?? 'table';
  const uniqueStyle = knobs.unique ?? 'named';
  const eol = knobs.lineEnding ?? '\n';
  const kw = (s: string): string => (knobs.keywordCase === 'lower' ? s.toLowerCase() : s);
  const ss = d === 'sqlserver';
  const ident = (name: string): string => (knobs.brackets ? `[${name}]` : name);
  const context = knobs.schema === 'context';
  const tableName = (name: string): string => (context ? ident(name) : `${ident('shop')}.${ident(name)}`);
  const typeOf = (c: SpecColumn): string => {
    const type = TYPES[d][c.type];
    if (!knobs.brackets) return type;
    const m = /^(\w+)(.*)$/.exec(type);
    return m ? `[${m[1]}]${m[2]}` : type;
  };
  const go = ss ? `${eol}GO` : '';
  const list = (cols: readonly string[]): string => cols.map(ident).join(', ');
  const tables = spec();
  const actions = ACTIONS.has(d);
  const fkClause = (fk: SpecFk): string =>
    `${kw('CONSTRAINT')} ${ident(fk.name)} ${kw('FOREIGN KEY')} (${list(fk.columns)}) ${kw('REFERENCES')} ${tableName(fk.table)} (${list(fk.references)})${fk.onDelete && actions ? ` ${kw('ON DELETE')} ${kw(fk.onDelete.toUpperCase())}` : ''}`;
  const uniqueClause = (u: { name: string; columns: string[] }): string => `${kw('CONSTRAINT')} ${ident(u.name)} ${kw('UNIQUE')} (${list(u.columns)})`;

  const head: string[] = [];
  if (context) {
    if (d === 'postgres') head.push(`${kw('SET search_path TO')} shop, public;`);
    else if (d === 'snowflake') head.push(`${kw('USE DATABASE')} analytics;`, `${kw('USE SCHEMA')} shop;`);
    else head.push(`${kw('USE')} shop;`);
  }
  const creates: string[] = [];
  for (const t of tables) {
    const lines: string[] = [];
    for (const c of t.columns) {
      const inlineUnique = uniqueStyle === 'inline' && t.uniques.some((u) => u.columns.length === 1 && u.columns[0] === c.name);
      let line = `  ${ident(c.name)} ${typeOf(c)}${c.notNull ? ` ${kw('NOT NULL')}` : ''}${inlineUnique ? ` ${kw('UNIQUE')}` : ''}`;
      if (knobs.descriptions && d === 'mysql' && t.name === 'customer' && c.name === 'email') line += ` ${kw('COMMENT')} '${COLUMN_DESCRIPTION.replace(/'/g, "''")}'`;
      if (knobs.descriptions && d === 'databricks' && t.name === 'customer' && c.name === 'email') line += ` ${kw('COMMENT')} '${COLUMN_DESCRIPTION.replace(/'/g, "\\'")}'`;
      lines.push(line);
    }
    // The stale FK the replay drops again.
    if (knobs.replay && t.name === 'orders') {
      if (d === 'postgres') lines[lines.length - 1] += ` ${kw('REFERENCES')} ${tableName('account')} (id)`; // PostgreSQL names it orders_old_ref_fkey
    }
    lines.push(`  ${kw('CONSTRAINT')} ${ident(`pk_${t.name}`)} ${kw('PRIMARY KEY')} (${list(t.pk)})`);
    if (uniqueStyle === 'table') for (const u of t.uniques) lines.push(`  ${kw('UNIQUE')} (${list(u.columns)})`);
    if (uniqueStyle === 'named') for (const u of t.uniques) lines.push(`  ${uniqueClause(u)}`);
    if (uniqueStyle === 'mysqlKey') for (const u of t.uniques) lines.push(`  ${kw('UNIQUE KEY')} ${ident(u.name)} (${list(u.columns)})`);
    if (fkStyle === 'table') for (const fk of t.fks) lines.push(`  ${fkClause(fk)}`);
    if (knobs.replay && t.name === 'orders' && d === 'mysql') {
      lines.push(`  ${kw('CONSTRAINT')} fk_old ${kw('FOREIGN KEY')} (old_ref) ${kw('REFERENCES')} ${tableName('account')} (id)`, `  ${kw('UNIQUE KEY')} uq_old (old_ref)`);
    }
    let tail = '';
    if (knobs.descriptions && t.name === 'customer' && d === 'mysql') tail = ` ${kw('COMMENT')}='${TABLE_DESCRIPTION.replace(/'/g, "''")}'`;
    creates.push(`${kw('CREATE TABLE')} ${tableName(t.name)} (${eol}${lines.join(`,${eol}`)}${eol})${tail};${go}`);
  }

  // Second file: uniqueness, foreign keys, the replay, the descriptions, in that order (uniqueness first when asked).
  const later: string[] = [];
  const wrap = (stmt: string, name: string): string => {
    if (!knobs.procedural) return stmt;
    if (d === 'postgres') {
      const tag = name.length % 2 ? '$$' : '$body$';
      return `DO ${tag}${eol}BEGIN${eol}  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN${eol}    ${stmt}${eol}  END IF;${eol}END ${tag};`;
    }
    if (d === 'sqlserver') return `IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name = N'${name}') BEGIN ${stmt.replace(new RegExp(`${go}$`), '')} END${go}`;
    return `EXECUTE IMMEDIATE $$${eol}BEGIN${eol}  ${stmt}${eol}END;${eol}$$;`;
  };
  const uniqueStatements: string[] = [];
  for (const t of tables) {
    for (const u of t.uniques) {
      if (uniqueStyle === 'alter') uniqueStatements.push(wrap(`${kw('ALTER TABLE')} ${tableName(t.name)} ${kw('ADD')} ${uniqueClause(u)};${go}`, u.name));
      if (uniqueStyle === 'index') {
        const extra = ss ? ` ${kw('INCLUDE')} (${ident('id')})` : '';
        uniqueStatements.push(`${kw(ss ? 'CREATE UNIQUE NONCLUSTERED INDEX' : 'CREATE UNIQUE INDEX')} ${ident(u.name)} ${kw('ON')} ${tableName(t.name)} (${list(u.columns)})${extra};${go}`);
      }
    }
  }
  if (knobs.uniqueFirst) later.push(...uniqueStatements);
  for (const t of tables) {
    if (fkStyle === 'alter') for (const fk of t.fks) later.push(wrap(`${kw('ALTER TABLE')} ${tableName(t.name)} ${kw('ADD')} ${fkClause(fk)};${go}`, fk.name));
    if (fkStyle === 'alterList' && t.fks.length) {
      const check = knobs.withCheck ? ` ${kw(`WITH ${knobs.withCheck}`)}` : '';
      const items = ss ? `${kw('ADD')}${eol}    ${t.fks.map(fkClause).join(`,${eol}    `)}` : t.fks.map((fk) => `${kw('ADD')} ${fkClause(fk)}`).join(`,${eol}  `);
      later.push(wrap(`${kw('ALTER TABLE')} ${tableName(t.name)}${check} ${items};${go}`, t.fks[0].name));
    }
  }
  if (!knobs.uniqueFirst) later.push(...uniqueStatements);
  if (knobs.replay) {
    const orders = tableName('orders');
    if (d === 'postgres') {
      later.push(
        `${kw('ALTER TABLE')} ${orders} ${kw('DROP CONSTRAINT')} orders_old_ref_fkey;`,
        `${kw('ALTER TABLE')} ${orders} ${kw('ADD CONSTRAINT')} orders_stale_uq ${kw('UNIQUE')} (old_ref);`,
        `${kw('ALTER TABLE')} ${orders} ${kw('DROP CONSTRAINT IF EXISTS')} orders_stale_uq;`,
        `${kw('ALTER TABLE')} ${orders} ${kw('DROP CONSTRAINT IF EXISTS')} never_was;`,
      );
    } else if (d === 'mysql') {
      later.push(`${kw('ALTER TABLE')} ${orders} ${kw('DROP FOREIGN KEY')} fk_old, ${kw('DROP INDEX')} uq_old;`);
    } else if (ss) {
      later.push(
        `${kw('ALTER TABLE')} ${orders} ${kw('ADD CONSTRAINT')} ${ident('fk_old')} ${kw('FOREIGN KEY')} (${ident('old_ref')}) ${kw('REFERENCES')} ${tableName('account')} (${ident('id')}), ${kw('CONSTRAINT')} ${ident('uq_old')} ${kw('UNIQUE')} (${ident('old_ref')});${go}`,
        `${kw('ALTER TABLE')} ${orders} ${kw('DROP CONSTRAINT')} ${ident('fk_old')}, ${ident('uq_old')};${go}`,
      );
    } else {
      later.push(
        `${kw('ALTER TABLE')} ${orders} ${kw('ADD CONSTRAINT')} fk_old ${kw('FOREIGN KEY')} (old_ref) ${kw('REFERENCES')} ${tableName('account')} (id);`,
        `${kw('ALTER TABLE')} ${orders} ${kw('DROP CONSTRAINT')} fk_old;`,
      );
    }
  }
  if (knobs.descriptions) {
    const customer = tableName('customer');
    if (d === 'postgres' || d === 'snowflake') {
      later.push(`${kw('COMMENT ON TABLE')} ${customer} ${kw('IS')} '${TABLE_DESCRIPTION.replace(/'/g, "''")}';`);
      later.push(`${kw('COMMENT ON COLUMN')} ${customer}.email ${kw('IS')} ${d === 'postgres' ? `$$${COLUMN_DESCRIPTION}$$` : `'${COLUMN_DESCRIPTION}'`};`);
    } else if (ss) {
      later.push(`${kw('EXEC')} sys.sp_addextendedproperty @name = N'MS_Description', @value = N'${TABLE_DESCRIPTION.replace(/'/g, "''")}', @level0type = N'SCHEMA', @level0name = N'shop', @level1type = N'TABLE', @level1name = N'customer';${go}`);
      later.push(`${kw('EXECUTE')} [sys].[sp_addextendedproperty] N'MS_Description', N'${COLUMN_DESCRIPTION}', N'SCHEMA', [shop], N'TABLE', [customer], N'COLUMN', [email];${go}`);
    } else if (d === 'databricks') {
      later.push(`${kw('COMMENT ON TABLE')} ${customer} ${kw('IS')} '${TABLE_DESCRIPTION.replace(/'/g, "\\'")}';`);
    }
  }
  const join = (statements: readonly string[]): string => statements.join(`${eol}${eol}`) + eol;
  const files: SqlDdlFile[] = [{ name: '01_tables.sql', text: join([...head, ...creates]) }];
  if (later.length) files.push({ name: '02_constraints.sql', text: join([...head, ...later]) });
  return { files, truth: fidelityTruth(knobs) };
}

/** The variants of the corpus, by label (each dialect writes the ones it supports). */
export function fidelityVariants(dialect: SqlDialect): Array<[string, FidelityKnobs]> {
  const all: Array<[string, Omit<FidelityKnobs, 'dialect'>]> = [
    ['plain', {}],
    ['fk alter', { fk: 'alter' }],
    ['fk alter list', { fk: 'alterList' }],
    ['fk alter list WITH CHECK', { fk: 'alterList', withCheck: 'CHECK' }],
    ['fk alter list WITH NOCHECK, brackets', { fk: 'alterList', withCheck: 'NOCHECK', brackets: true }],
    ['unique inline', { unique: 'inline' }],
    ['unique table constraint', { unique: 'table' }],
    ['unique KEY (MySQL)', { unique: 'mysqlKey' }],
    ['unique by ALTER after the FKs', { unique: 'alter', fk: 'alter' }],
    ['unique by ALTER before the FKs', { unique: 'alter', fk: 'alter', uniqueFirst: true }],
    ['unique index after the FKs', { unique: 'index', fk: 'alterList' }],
    ['unique index before the FKs', { unique: 'index', fk: 'alter', uniqueFirst: true }],
    ['schema context', { schema: 'context' }],
    ['schema context, ALTER list', { schema: 'context', fk: 'alterList' }],
    ['procedural blocks', { procedural: true, fk: 'alter', unique: 'alter' }],
    ['replay (drop and re-add)', { replay: true }],
    ['descriptions', { descriptions: true }],
    ['everything, crlf, lower case', { fk: 'alterList', unique: 'alter', schema: 'context', replay: true, descriptions: true, lineEnding: '\r\n', keywordCase: 'lower' }],
    ['brackets', { brackets: true, fk: 'alter', unique: 'index' }],
  ];
  return all.map(([label, k]): [string, FidelityKnobs] => [label, { dialect, ...k }]).filter(([, k]) => fidelitySupports(k));
}
