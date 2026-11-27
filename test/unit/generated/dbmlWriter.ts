/**
 * Generated tests: a {@link GSchema} written as DBML, with the style knobs
 * that must not change what is imported (inline or block Refs, composite
 * keys as `indexes { (a, b) [pk] }`, notes, a schema qualifier, quoting,
 * comments, CRLF, a BOM), one {@link Span} per table, and DBML's
 * {@link FormatKit}.
 *
 * Sample rows (D37): about half the tables get a `records` block, nested
 * (with a column list or none) or top-level, whose values each carry
 * {@link SAMPLE_VALUE_MARKER} (strings with escapes, one longer than the
 * no-echo limit) or are numbers (signed too), `null`, empty fields,
 * booleans and backtick expressions. With `dotted`, some values are dotted
 * bare words (`zqCELL7.doe`), which the parser reads as an enum reference
 * and refuses, quoting part of it: Import's message sanitiser is fuzzed.
 * Which tables get a block, and what it holds, is drawn from `seed` on its
 * own stream, so the other knobs draw as they always did.
 */
import * as fc from 'fast-check';
import type { FormatKit, Span } from './breaks';
import { prng } from './breaks';
import { SAMPLE_VALUE_MARKER } from './invariants';
import { BIG_RUN, isPlain, type GSchema, type GTable, type GType } from './schemaArbitraries';

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
  /** Sample rows: a `records` block in about half the tables (drawn from `seed`). */
  records?: boolean;
  /** In about a quarter of the files, some sample values are dotted bare words, which no parser reads (the file fails). */
  dotted?: boolean;
}

/** The style knobs; every style writes sample rows, and `dotted` ones a value no parser reads. */
export function dbmlStyleArb(options: { dotted?: boolean } = {}): fc.Arbitrary<DbmlStyle> {
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
  }, { requiredKeys: ['eol', 'bom', 'inlineRefs', 'quoteAll', 'notes', 'noise', 'project', 'seed'] })
    // Mapped, not drawn: the other knobs keep the draws they always had.
    .map((style) => ({ ...style, records: true, ...(options.dotted ? { dotted: true } : {}) }));
}

export const DBML_TYPES: Readonly<Record<GType, string>> = {
  int: 'int', bigint: 'bigint', text: 'text', varchar: 'varchar(100)', decimal: 'decimal(10,2)', timestamp: 'timestamp', date: 'date', boolean: 'boolean',
};

/** A DBML name: bare when plain, else in double quotes. */
export const dbmlQuote = (name: string, all = false): string => (!all && isPlain(name) ? name : `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);

const dbmlString = (text: string): string => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * One sample value as written: a marked string (an escape, a quote, one
 * longer than the no-echo limit), a number (signed too), `null`, an empty
 * field, a boolean, a backtick expression, or (with `dotted`) a dotted bare
 * word. `empty` allows an empty field (never the first of a row).
 */
function sampleValue(rand: () => number, n: number, dotted: boolean, empty: boolean): string {
  const r = rand();
  if (dotted && r < 0.15) return `${SAMPLE_VALUE_MARKER}${n}.doe`;
  if (r < 0.3) return dbmlString(`${SAMPLE_VALUE_MARKER}${n} it's "q" \\ x`);
  if (r < 0.4) return dbmlString(`${SAMPLE_VALUE_MARKER}${n} ${'long value '.repeat(12)}`);
  if (r < 0.5) return `"${SAMPLE_VALUE_MARKER}${n}"`;
  if (r < 0.62) return rand() < 0.5 ? `-${n}.50` : `${n}`;
  if (r < 0.72) return rand() < 0.5 ? 'null' : 'NULL';
  if (r < 0.8 && empty) return '';
  if (r < 0.9) return rand() < 0.5 ? 'true' : 'FALSE';
  return '`now()`';
}

/**
 * A `records` block for `t`, or undefined (about half the tables): nested
 * with a list (its columns in order) or none, or top-level (`Records
 * <table>(…)`, written after the Table); 1–3 rows.
 */
function recordsBlock(t: GTable, rand: () => number, records: boolean, dotted: boolean, q: (n: string) => string, full: string): { nested?: string[]; topLevel?: string[] } | undefined {
  if (!records || rand() < 0.5) return undefined;
  const form = rand();
  const list = `(${t.columns.map((c) => q(c.name)).join(', ')})`;
  const rows: string[] = [];
  const count = 1 + Math.floor(rand() * 3);
  for (let r = 0; r < count; r++) {
    // An empty field never first, so no row is all empty fields (a blank line, no row).
    rows.push(t.columns.map((_c, i) => sampleValue(rand, r * 10 + i, dotted, i > 0)).join(', '));
  }
  if (form < 0.3) return { topLevel: [`Records ${full}${list} {`, ...rows.map((row) => `  ${row}`), '}'] };
  const header = form < 0.5 ? '  records {' : `  records ${list} {`;
  return { nested: ['', header, ...rows.map((row) => `    ${row}`), '  }'] };
}

export function writeDbml(schema: GSchema, style: DbmlStyle): { text: string; spans: Span[] } {
  const rand = prng(style.seed);
  // Sample rows draw from their own stream, so every other knob draws as before.
  const sampleRand = prng((style.seed ^ 0x5a17c3) >>> 0);
  // Dotted values in about a quarter of the files, so the breaks still meet files that read.
  const dotted = style.dotted === true && sampleRand() < 0.25;
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
    const records = recordsBlock(t, sampleRand, style.records === true, dotted, q, full(t.name));
    for (const line of records?.nested ?? []) push(line);
    push('}');
    spans.push({ table: t.name, start, end: at - eolLen, header: `Table ${full(t.name)}` + (settings ? settings : '') + ' {' });
    for (const line of records?.topLevel ?? []) push(line);
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
