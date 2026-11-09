/**
 * Generated tests: a {@link GSchema} written as SQL DDL in one dialect, with
 * the style knobs that must not change what is imported (quoting, keyword
 * case, line endings, a BOM, inline or ALTER TABLE foreign keys, a schema
 * qualifier, comments in odd places), and one {@link Span} per table for
 * `breaks.ts`. Also each dialect's {@link FormatKit}.
 */
import * as fc from 'fast-check';
import type { SqlDdlFile, SqlDialect } from '../../../src/services/sqlDdlImport';
import type { FormatKit, Span } from './breaks';
import { prng } from './breaks';
import { BIG_RUN, isPlain, RESERVED_WORDS, type GSchema, type GType } from './schemaArbitraries';

export interface SqlStyle {
  /** `needed`: only names that need quotes; `all`: every name in the dialect's own quotes. */
  quote: 'needed' | 'all';
  keywordCase: 'upper' | 'lower';
  eol: '\n' | '\r\n';
  bom: boolean;
  fkStyle: 'inline' | 'alter';
  /** A single-column key written on its column (`id int PRIMARY KEY`). */
  inlinePk: boolean;
  /** Comments between tokens, at line ends and between statements (holding `;`, `(` and quotes). */
  noise: boolean;
  /** Every table qualified by this schema. */
  schema?: string;
  /** Drives where the noise goes. */
  seed: number;
}

export function sqlStyleArb(): fc.Arbitrary<SqlStyle> {
  return fc.record({
    quote: fc.constantFrom<'needed' | 'all'>('needed', 'all'),
    keywordCase: fc.constantFrom<'upper' | 'lower'>('upper', 'lower'),
    eol: fc.constantFrom<'\n' | '\r\n'>('\n', '\r\n'),
    bom: fc.boolean(),
    fkStyle: fc.constantFrom<'inline' | 'alter'>('inline', 'alter'),
    inlinePk: fc.boolean(),
    noise: fc.boolean(),
    schema: fc.option(fc.constantFrom('sales', 'dw', 'staging'), { nil: undefined }),
    seed: fc.nat(),
  }, { requiredKeys: ['quote', 'keywordCase', 'eol', 'bom', 'fkStyle', 'inlinePk', 'noise', 'seed'] });
}

export const SQL_TYPES: Readonly<Record<SqlDialect, Readonly<Record<GType, string>>>> = {
  postgres: { int: 'integer', bigint: 'bigint', text: 'text', varchar: 'varchar(100)', decimal: 'numeric(10,2)', timestamp: 'timestamp', date: 'date', boolean: 'boolean' },
  mysql: { int: 'int', bigint: 'bigint', text: 'text', varchar: 'varchar(100)', decimal: 'decimal(10,2)', timestamp: 'datetime', date: 'date', boolean: 'tinyint(1)' },
  sqlserver: { int: 'int', bigint: 'bigint', text: 'nvarchar(max)', varchar: 'nvarchar(100)', decimal: 'decimal(10,2)', timestamp: 'datetime2', date: 'date', boolean: 'bit' },
  snowflake: { int: 'number(38,0)', bigint: 'number(38,0)', text: 'varchar', varchar: 'varchar(100)', decimal: 'number(10,2)', timestamp: 'timestamp_ntz', date: 'date', boolean: 'boolean' },
  databricks: { int: 'int', bigint: 'bigint', text: 'string', varchar: 'string', decimal: 'decimal(10,2)', timestamp: 'timestamp', date: 'date', boolean: 'boolean' },
};

/** A name in the dialect's own quotes, an embedded quote doubled. */
export function sqlQuote(dialect: SqlDialect, name: string): string {
  switch (dialect) {
    case 'mysql': case 'databricks': return `\`${name.replace(/`/g, '``')}\``;
    case 'sqlserver': return `[${name.replace(/]/g, ']]')}]`;
    default: return `"${name.replace(/"/g, '""')}"`;
  }
}

const sqlString = (text: string): string => `'${text.replace(/'/g, "''")}'`;

const NOISE_BLOCKS = ['/* note: it\'s (draft); */', '/* "quoted" ; */', '/* 顧客 — ü */', '/**/', '/* a ( b */', '/* -- not a line comment */'];
const NOISE_LINES = ['-- trailing; note (x)', "-- don't", '-- 注文 ;', '--'];

export interface WrittenSql {
  files: SqlDdlFile[];
  spans: Span[];
}

/** The schema as one SQL file in `dialect`, styled by `style`. */
export function writeSql(schema: GSchema, dialect: SqlDialect, style: SqlStyle, fileName = 'schema.sql'): WrittenSql {
  const rand = prng(style.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const noisy = (p: number): boolean => style.noise && rand() < p;
  const block = (): string => pick(NOISE_BLOCKS);
  const line = (): string => (dialect === 'mysql' && rand() < 0.3 ? '# hash comment; (x)' : pick(NOISE_LINES));
  const eol = style.eol;
  const kw = (s: string): string => (style.keywordCase === 'lower' ? s.toLowerCase() : s);
  const q = (name: string): string => (style.quote === 'all' || !isPlain(name) ? sqlQuote(dialect, name) : name);
  const tableName = (name: string): string => (style.schema ? `${q(style.schema)}.${q(name)}` : q(name));
  const cols = (names: readonly string[]): string => names.map(q).join(', ');
  const inlineComments = dialect === 'mysql' || dialect === 'databricks' || dialect === 'snowflake';
  const types = SQL_TYPES[dialect];

  const statements: Array<{ text: string; table?: string; header?: string }> = [];
  const alters: string[] = [];
  schema.tables.forEach((t, ti) => {
    const header = `${kw('CREATE TABLE')} ${tableName(t.name)} (`;
    const lines: string[] = [];
    const inlinePk = style.inlinePk && t.pk.length === 1 && dialect !== 'databricks';
    for (const c of t.columns) {
      const parts = [q(c.name)];
      if (noisy(0.1)) parts.push(block());
      parts.push(types[c.type]);
      if (c.notNull) parts.push(kw('NOT NULL'));
      if (inlinePk && t.pk[0] === c.name) parts.push(kw('PRIMARY KEY'));
      if (c.unique && dialect !== 'databricks') parts.push(kw('UNIQUE'));
      if (c.comment && inlineComments) parts.push(`${kw('COMMENT')} ${sqlString(c.comment)}`);
      lines.push(`  ${parts.join(' ')}`);
    }
    if (t.pk.length && !inlinePk) lines.push(`  ${kw('CONSTRAINT')} pk_${ti} ${kw('PRIMARY KEY')} (${cols(t.pk)})`);
    if (dialect !== 'databricks') t.fks.forEach((fk, n) => { if (fk.oneToOne && fk.columns.length > 1) lines.push(`  ${kw('CONSTRAINT')} uq_${ti}_${n} ${kw('UNIQUE')} (${cols(fk.columns)})`); });
    const fkClause = (n: number): string => {
      const fk = t.fks[n];
      return `${kw('CONSTRAINT')} fk_${ti}_${n} ${kw('FOREIGN KEY')} (${cols(fk.columns)}) ${kw('REFERENCES')} ${tableName(fk.table)} (${cols(fk.references)})`;
    };
    if (style.fkStyle === 'inline') t.fks.forEach((_fk, n) => lines.push(`  ${fkClause(n)}`));
    else t.fks.forEach((_fk, n) => alters.push(`${kw('ALTER TABLE')} ${tableName(t.name)} ${kw('ADD')} ${fkClause(n)};`));
    const body = lines.map((l, i) => {
      const last = i === lines.length - 1;
      return `${l}${last ? '' : ','}${noisy(0.15) ? ` ${line()}` : ''}`;
    });
    let tail = '';
    if (t.comment && inlineComments) {
      tail = dialect === 'mysql' ? ` ${kw('COMMENT')}=${sqlString(t.comment)}` : dialect === 'snowflake' ? ` ${kw('COMMENT')} = ${sqlString(t.comment)}` : ` ${kw('COMMENT')} ${sqlString(t.comment)}`;
    }
    const open = noisy(0.3) ? ` ${block()}` : '';
    const close = noisy(0.2) ? `${eol}  ${block()}` : '';
    const end = noisy(0.2) ? ` ${block()}` : '';
    let text = `${header}${open}${eol}${body.join(eol)}${close}${eol})${tail}${end};`;
    if (!inlineComments && dialect !== 'sqlserver') {
      if (t.comment) text += `${eol}${kw('COMMENT ON TABLE')} ${tableName(t.name)} ${kw('IS')} ${sqlString(t.comment)};`;
      for (const c of t.columns) if (c.comment) text += `${eol}${kw('COMMENT ON COLUMN')} ${tableName(t.name)}.${q(c.name)} ${kw('IS')} ${sqlString(c.comment)};`;
    }
    statements.push({ text, table: t.name, header });
  });

  const sep = dialect === 'sqlserver' ? `${eol}GO${eol}${eol}` : `${eol}${eol}`;
  let out = style.bom ? '﻿' : '';
  if (style.noise) out += `${line()}${eol}${block()}${eol}`;
  const spans: Span[] = [];
  for (const s of statements) {
    if (noisy(0.3)) out += `${line()}${eol}`;
    const start = out.length;
    out += s.text;
    spans.push({ table: s.table!, start, end: out.length, header: s.header!, file: fileName });
    out += sep;
  }
  for (const a of alters) out += `${a}${sep}`;
  return { files: [{ name: fileName, text: out }], spans };
}

/** What `breaks.ts` needs to know about each dialect. */
export function sqlKit(dialect: SqlDialect): FormatKit {
  const foreign: Record<SqlDialect, string[]> = {
    postgres: ['AUTO_INCREMENT', 'IDENTITY(1,1)', 'CHARACTER SET utf8mb4', 'ENCODE zstd', 'COMMENT \'x\''],
    mysql: ['IDENTITY(1,1)', 'COLLATE "C"', 'GENERATED BY DEFAULT AS IDENTITY', 'WITH (fillfactor = 70)', 'MASKING POLICY p'],
    sqlserver: ['AUTO_INCREMENT', 'COMMENT \'x\'', 'COLLATE "C"', 'CHARACTER SET utf8mb4', 'GENERATED ALWAYS AS IDENTITY'],
    snowflake: ['AUTO_INCREMENT', 'IDENTITY(1,1)', 'COLLATE "C"', 'ON UPDATE CURRENT_TIMESTAMP', 'SPARSE'],
    databricks: ['AUTO_INCREMENT', 'IDENTITY(1,1)', 'COLLATE "C"', 'CHARACTER SET utf8mb4', 'SPARSE'],
  };
  return {
    types: Object.values(SQL_TYPES[dialect]),
    unknownTypes: ['frobnicator', 'geography(point,4326)', 'my_schema.money_t', 'int4range[]', 'VECTOR(FLOAT, 768)', 'tsvector', 'MAP<STRING, ARRAY<INT>>', 'hierarchyid', 'ENUM(\'a\',\'b\')', 'SET(\'x\')'],
    reservedWords: RESERVED_WORDS,
    foreignFragments: foreign[dialect],
    garbageLines: ['\\connect warehouse', 'GO', '@@@ ### !!!', 'PRAGMA foreign_keys=ON;', 'SET NAMES utf8mb4;', '\u0000�', 'USE [db];', 'DELIMITER ;', '\\.', '/*'],
    longBody: (n, eol) => {
      const columns = (BIG_RUN ? [250, 1000, 2500, 5000] : [40, 150, 400, 900])[n - 1];
      let out = '';
      for (let i = 0; i < columns; i++) out += `  extra_${String(i).padStart(5, '0')} ${SQL_TYPES[dialect].int},${eol}`;
      return out;
    },
    quotes: dialect === 'sqlserver' ? "'[]" : dialect === 'mysql' || dialect === 'databricks' ? "'`" : "'\"",
    memberLine: /^ {2}(?!CONSTRAINT\b|constraint\b)((?:"[^"\n]*"|`[^`\n]*`|\[[^\]\n]*\]|[A-Za-z_][\w]*)) (?!KEY|PRIMARY|FOREIGN)/,
  };
}
