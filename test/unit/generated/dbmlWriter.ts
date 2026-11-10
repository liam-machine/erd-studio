/**
 * Generated tests: a {@link GSchema} written as DBML, with the style knobs
 * that must not change what is imported (inline or block Refs, composite
 * keys as `indexes { (a, b) [pk] }`, notes, a schema qualifier, quoting,
 * comments, CRLF, a BOM), one {@link Span} per table, and DBML's
 * {@link FormatKit}.
 */
import * as fc from 'fast-check';
import type { FormatKit, Span } from './breaks';
import { prng } from './breaks';
import { BIG_RUN, isPlain, type GSchema, type GType } from './schemaArbitraries';

export interface DbmlStyle {
  eol: '\n' | '\r\n';
  bom: boolean;
  /** Single-column foreign keys as `[ref: > t.c]` on the column, else a `Ref:` line each. */
  inlineRefs: boolean;
  /** Quote every name. */
  quoteAll: boolean;
  notes: boolean;
  /** Line and block comments between lines and at line ends. */
  noise: boolean;
  schema?: string;
  /** A `Project` block first. */
  project: boolean;
  seed: number;
}

export function dbmlStyleArb(): fc.Arbitrary<DbmlStyle> {
  return fc.record({
    eol: fc.constantFrom<'\n' | '\r\n'>('\n', '\r\n'),
    bom: fc.boolean(),
    inlineRefs: fc.boolean(),
    quoteAll: fc.boolean(),
    notes: fc.boolean(),
    noise: fc.boolean(),
    schema: fc.option(fc.constantFrom('sales', 'dw', 'public'), { nil: undefined }),
    project: fc.boolean(),
    seed: fc.nat(),
  }, { requiredKeys: ['eol', 'bom', 'inlineRefs', 'quoteAll', 'notes', 'noise', 'project', 'seed'] });
}

export const DBML_TYPES: Readonly<Record<GType, string>> = {
  int: 'int', bigint: 'bigint', text: 'text', varchar: 'varchar(100)', decimal: 'decimal(10,2)', timestamp: 'timestamp', date: 'date', boolean: 'boolean',
};

/** A DBML name: bare when plain, else in double quotes. */
export const dbmlQuote = (name: string, all = false): string => (!all && isPlain(name) ? name : `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);

const dbmlString = (text: string): string => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function writeDbml(schema: GSchema, style: DbmlStyle): { text: string; spans: Span[] } {
  const rand = prng(style.seed);
  const noisy = (p: number): boolean => style.noise && rand() < p;
  const q = (n: string): string => dbmlQuote(n, style.quoteAll);
  const full = (t: string): string => (style.schema ? `${q(style.schema)}.${q(t)}` : q(t));
  const comment = (): string => (rand() < 0.5 ? ' // note: it\'s { [ "x" ]' : ' /* c } */');
  const lines: string[] = [];
  const spans: Span[] = [];
  let at = style.bom ? 1 : 0;
  const eolLen = style.eol.length;
  const push = (line: string): void => { lines.push(line); at += line.length + eolLen; };
  if (style.project) {
    push('Project gen {');
    push("  database_type: 'PostgreSQL'");
    if (style.notes) push("  Note: 'Generated'");
    push('}');
    push('');
  }
  const refs: string[] = [];
  schema.tables.forEach((t) => {
    if (noisy(0.3)) push(comment().trim());
    const start = at;
    const settings = style.notes && t.comment ? ` [note: ${dbmlString(t.comment)}]` : '';
    const header = `Table ${full(t.name)}${settings} {`;
    push(`${header}${noisy(0.2) ? comment() : ''}`);
    const inline = new Map<string, string>();
    if (style.inlineRefs) {
      for (const fk of t.fks) if (fk.columns.length === 1) inline.set(fk.columns[0], `ref: ${fk.oneToOne ? '-' : '>'} ${full(fk.table)}.${q(fk.references[0])}`);
    }
    for (const c of t.columns) {
      const s: string[] = [];
      if (t.pk.length === 1 && t.pk[0] === c.name) s.push('pk');
      if (c.notNull && !(t.pk.length === 1 && t.pk[0] === c.name)) s.push('not null');
      if (c.unique) s.push('unique');
      if (style.notes && c.comment) s.push(`note: ${dbmlString(c.comment)}`);
      const ref = inline.get(c.name);
      if (ref) s.push(ref);
      push(`  ${q(c.name)} ${DBML_TYPES[c.type]}${s.length ? ` [${s.join(', ')}]` : ''}${noisy(0.15) ? comment() : ''}`);
    }
    const uniqueKeys = t.fks.filter((fk) => fk.oneToOne && fk.columns.length > 1).map((fk) => fk.columns);
    if (t.pk.length > 1 || uniqueKeys.length) {
      push('');
      push('  indexes {');
      if (t.pk.length > 1) push(`    (${t.pk.map(q).join(', ')}) [pk]`);
      for (const u of uniqueKeys) push(`    (${u.map(q).join(', ')}) [unique]`);
      push('  }');
    }
    push('}');
    spans.push({ table: t.name, start, end: at - eolLen, header: `Table ${full(t.name)}` + (settings ? settings : '') + ' {' });
    push('');
    for (const fk of t.fks) {
      if (fk.columns.length === 1 && inline.has(fk.columns[0])) continue;
      const from = fk.columns.length === 1 ? q(fk.columns[0]) : `(${fk.columns.map(q).join(', ')})`;
      const to = fk.references.length === 1 ? q(fk.references[0]) : `(${fk.references.map(q).join(', ')})`;
      refs.push(`Ref: ${full(t.name)}.${from} ${fk.oneToOne ? '-' : '>'} ${full(fk.table)}.${to}`);
    }
  });
  for (const r of refs) push(r);
  const text = lines.join('\n') + '\n';
  return { text: (style.bom ? '﻿' : '') + (style.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text), spans };
}

export function dbmlKit(): FormatKit {
  return {
    types: Object.values(DBML_TYPES),
    unknownTypes: ['frobnicator', 'geometry(Point,4326)', 'int[]', '"double precision"', 'MAP<STRING,INT>', 'varchar(max)', 'enum_status', 'x.y'],
    reservedWords: ['Table', 'Ref', 'Note', 'Enum', 'indexes', 'Project', 'TableGroup', 'pk', 'note', 'ref', 'null', 'TablePartial', 'Records'],
    foreignFragments: [' NOT NULL', ' PRIMARY KEY', ' AUTO_INCREMENT', ',', ';', ' DEFAULT 0', ' REFERENCES x(y)', ' [pk', ' [note: \'unclosed]', ' ]'],
    garbageLines: ['CREATE TABLE x (id int);', 'use { a } from "./x"', '}', '{', '@@@ ###', '<<<<<<< HEAD', '// a comment', '\u0000', 'Ref: nowhere.x > elsewhere.y', 'Table'],
    longBody: (n, eol) => {
      const count = (BIG_RUN ? [300, 1500, 4000, 8000] : [50, 200, 600, 1200])[n - 1];
      let out = '';
      for (let i = 0; i < count; i++) out += `  extra_${i} int${eol}`;
      return out;
    },
    quotes: `"'\``,
    brackets: '{}[]()',
    memberLine: /^ {2}("(?:[^"\\\n]|\\.)*"|[A-Za-z_]\w*) (?!\{)/,
  };
}
