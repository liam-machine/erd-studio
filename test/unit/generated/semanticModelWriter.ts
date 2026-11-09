/**
 * Generated tests: a {@link GSchema} written as a Power BI semantic model,
 * in TMDL (a `definition/` folder: model.tmdl, one file per table,
 * relationships.tmdl) and in TMSL (one model.bim), with one {@link Span}
 * per table for `breaks.ts`, and each format's {@link FormatKit}.
 *
 * Power BI has no composite keys, so schemas for it are drawn with
 * `composite: false`.
 */
import * as fc from 'fast-check';
import type { SemanticModelFile } from '../../../src/services/semanticModelImport';
import type { FormatKit, Span } from './breaks';
import { BIG_RUN, isPlain, RESERVED_WORDS, type GSchema, type GType } from './schemaArbitraries';

export const PBI_TYPES: Readonly<Record<GType, string>> = {
  int: 'int64', bigint: 'int64', text: 'string', varchar: 'string', decimal: 'decimal', timestamp: 'dateTime', date: 'dateTime', boolean: 'boolean',
};

export interface TmdlStyle {
  eol: '\n' | '\r\n';
  bom: boolean;
  /** Quote every name, not only those that need it. */
  quoteAll: boolean;
  /** Descriptions (`///`) on tables and columns. */
  descriptions: boolean;
  /** Indent with four spaces instead of tabs (TMDL allows either, consistently). */
  spaces: boolean;
}

export function tmdlStyleArb(): fc.Arbitrary<TmdlStyle> {
  return fc.record({ eol: fc.constantFrom<'\n' | '\r\n'>('\n', '\r\n'), bom: fc.boolean(), quoteAll: fc.boolean(), descriptions: fc.boolean(), spaces: fc.boolean() });
}

export const MODEL_ROOT = 'Gen.SemanticModel';

/** A TMDL name: bare when it can be, else in single quotes with `'` doubled. */
export function tmdlName(name: string, quoteAll = false): string {
  return !quoteAll && isPlain(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/** A table's file name, as Power BI writes it (characters a file name cannot hold replaced). */
const fileNameOf = (table: string, i: number): string => `${table.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80) || `table_${i}`}`;

export interface WrittenModel {
  files: SemanticModelFile[];
  /** One per table: its file, the whole file as the span. */
  spans: Span[];
  relationshipsFile?: string;
}

/** The schema as a TMDL definition folder. */
export function writeTmdl(schema: GSchema, style: TmdlStyle): WrittenModel {
  const eol = style.eol;
  const ind = (n: number): string => (style.spaces ? '    ' : '\t').repeat(n);
  const q = (name: string): string => tmdlName(name, style.quoteAll);
  const finish = (lines: string[]): string => {
    const text = lines.join('\n') + '\n';
    return (style.bom ? '﻿' : '') + (eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);
  };
  const files: SemanticModelFile[] = [];
  const spans: Span[] = [];
  const def = `${MODEL_ROOT}/definition`;
  files.push({ path: `${def}/model.tmdl`, text: finish(['model Model', `${ind(1)}culture: en-US`, '', ...schema.tables.map((t) => `ref table ${q(t.name)}`)]) });
  const used = new Set<string>();
  schema.tables.forEach((t, i) => {
    let base = fileNameOf(t.name, i);
    while (used.has(base.toLowerCase())) base += '_';
    used.add(base.toLowerCase());
    const lines: string[] = [];
    if (style.descriptions && t.comment) lines.push(`/// ${t.comment}`);
    lines.push(`table ${q(t.name)}`, `${ind(1)}lineageTag: 00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, '');
    t.columns.forEach((c, k) => {
      if (style.descriptions && c.comment) lines.push(`${ind(1)}/// ${c.comment}`);
      lines.push(`${ind(1)}column ${q(c.name)}`, `${ind(2)}dataType: ${PBI_TYPES[c.type]}`);
      if (t.pk.includes(c.name)) lines.push(`${ind(2)}isKey`);
      if (c.type === 'date') lines.push(`${ind(2)}formatString: Short Date`);
      lines.push(`${ind(2)}lineageTag: 00000000-0000-4000-8001-${String(i * 1000 + k).padStart(12, '0')}`, `${ind(2)}summarizeBy: none`, ...(isPlain(c.name) ? [`${ind(2)}sourceColumn: ${c.name}`] : []), '');
    });
    const item = t.name.replace(/"/g, '""');
    lines.push(
      `${ind(1)}partition ${q(t.name)} = m`, `${ind(2)}mode: import`, `${ind(2)}source = \`\`\``,
      `${ind(4)}let`, `${ind(5)}Source = Sql.Database("srv", "dw"),`, `${ind(5)}Data = Source{[Schema="dbo",Item="${item}"]}[Data]`, `${ind(4)}in`, `${ind(5)}Data`, `${ind(4)}\`\`\``,
      '', `${ind(1)}annotation PBI_ResultType = Table`,
    );
    const path = `${def}/tables/${base}.tmdl`;
    const text = finish(lines);
    files.push({ path, text });
    const header = `table ${q(t.name)}`;
    spans.push({ table: t.name, start: 0, end: text.length, header, file: path });
  });
  const rels: string[] = [];
  let r = 0;
  for (const t of schema.tables) {
    for (const fk of t.fks) {
      rels.push(`relationship 5e6f7a8b-${String(r++).padStart(4, '0')}-4000-8000-000000000001`, `${ind(1)}fromColumn: ${q(t.name)}.${q(fk.columns[0])}`, `${ind(1)}toColumn: ${q(fk.table)}.${q(fk.references[0])}`, '');
    }
  }
  const relationshipsFile = rels.length ? `${def}/relationships.tmdl` : undefined;
  if (relationshipsFile) files.push({ path: relationshipsFile, text: finish(rels) });
  return { files, spans, ...(relationshipsFile ? { relationshipsFile } : {}) };
}

export interface TmslStyle {
  eol: '\n' | '\r\n';
  bom: boolean;
  /** JSON indent (Power BI writes 2). */
  indent: 1 | 2 | 4;
  descriptions: boolean;
}

export function tmslStyleArb(): fc.Arbitrary<TmslStyle> {
  return fc.record({ eol: fc.constantFrom<'\n' | '\r\n'>('\n', '\r\n'), bom: fc.boolean(), indent: fc.constantFrom<1 | 2 | 4>(1, 2, 4), descriptions: fc.boolean() });
}

/** The schema as one model.bim; each table's span is its object in `model.tables`. */
export function writeTmsl(schema: GSchema, style: TmslStyle): WrittenModel {
  const tables = schema.tables.map((t, i) => ({
    name: t.name,
    ...(style.descriptions && t.comment ? { description: t.comment } : {}),
    lineageTag: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    columns: t.columns.map((c) => ({
      name: c.name,
      dataType: PBI_TYPES[c.type],
      ...(t.pk.includes(c.name) ? { isKey: true } : {}),
      ...(style.descriptions && c.comment ? { description: c.comment } : {}),
      sourceColumn: c.name,
      summarizeBy: 'none',
    })),
    partitions: [{ name: `partition-${i}`, mode: 'import', source: { type: 'm', expression: ['let', '    Source = Sql.Database("srv", "dw"),', `    Data = Source{[Schema="dbo",Item="${t.name.replace(/"/g, '""')}"]}[Data]`, 'in', '    Data'] } }],
  }));
  const relationships = schema.tables.flatMap((t) => t.fks.map((fk, n) => ({ name: `${t.name}-${n}`, fromTable: t.name, fromColumn: fk.columns[0], toTable: fk.table, toColumn: fk.references[0] })));
  // Placeholders mark each table object, so its span is known after JSON.stringify.
  const marked = { name: 'Gen', compatibilityLevel: 1567, model: { culture: 'en-US', tables: tables.map((_t, i) => `\u0001${i}\u0001`), relationships } };
  let text = JSON.stringify(marked, null, style.indent);
  const spans: Span[] = [];
  tables.forEach((t, i) => {
    const marker = JSON.stringify(`\u0001${i}\u0001`);
    const at = text.indexOf(marker);
    const indent = /[ ]*$/.exec(text.slice(0, at))![0];
    const body = JSON.stringify(t, null, style.indent).replace(/\n/g, `\n${indent}`);
    text = text.slice(0, at) + body + text.slice(at + marker.length);
    spans.push({ table: t.name, start: at, end: at + body.length, header: `"name": ${JSON.stringify(t.name)}`, file: `${MODEL_ROOT}/model.bim` });
  });
  // Offsets move with CRLF and a BOM: map them.
  const map = (offset: number): number => (style.bom ? 1 : 0) + (style.eol === '\r\n' ? offset + (text.slice(0, offset).match(/\n/g)?.length ?? 0) : offset);
  const out = (style.bom ? '﻿' : '') + (style.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);
  return { files: [{ path: `${MODEL_ROOT}/model.bim`, text: out }], spans: spans.map((s) => ({ ...s, start: map(s.start), end: map(s.end) })) };
}

export function tmdlKit(spaces = false): FormatKit {
  const ind = (n: number): string => (spaces ? '    ' : '\t').repeat(n);
  return {
    types: ['int64', 'string', 'double', 'decimal', 'dateTime', 'boolean'],
    unknownTypes: ['variant', 'int128', 'datetimezone', 'currency', 'Int64', 'STRING', 'binary', 'unknown'],
    reservedWords: ['table', 'column', 'measure', 'partition', 'relationship', 'model', 'expression', 'annotation', 'ref', 'isKey', ...RESERVED_WORDS.slice(0, 6)],
    foreignFragments: [' // a comment', ' = 1', ',', ' ;', ' [pk]', ' NOT NULL', ': int64', ' {', " 'x"],
    garbageLines: ['<<<<<<< HEAD', '=======', '>>>>>>> feature', '// a comment', '\u0000', 'createOrReplace', '{', `${ind(1)}annotation PBI_X = 1`, 'ref table Missing'],
    longBody: (n, eol) => {
      const count = (BIG_RUN ? [200, 1000, 3000, 6000] : [30, 120, 400, 900])[n - 1];
      let out = '';
      for (let i = 0; i < count; i++) out += `${ind(1)}column extra_${i}${eol}${ind(2)}dataType: int64${eol}${ind(2)}sourceColumn: extra_${i}${eol}${eol}`;
      return out;
    },
    quotes: "'`\"",
    brackets: '()[]{}',
    memberLine: new RegExp(`^${spaces ? ' {4}' : '\\t'}column ('(?:[^'\\n]|'')*'|[^\\s=]+)`),
  };
}

export function tmslKit(): FormatKit {
  return {
    types: ['int64', 'string', 'double', 'decimal', 'dateTime', 'boolean'],
    unknownTypes: ['variant', 'int128', 'datetimezone', 'currency', 'Int64', 'STRING', 'unknown'],
    reservedWords: [...RESERVED_WORDS.slice(0, 10), 'table', 'measure', 'relationship'],
    bareName: (w) => JSON.stringify(w),
    foreignFragments: [' // a comment', ',', ' "x": 1', ' NaN', ' undefined', ' /* c */', ' \'single\''],
    garbageLines: ['// comment', '/* c */', ',', '\u0000', '{', ']'],
    longBody: (n, eol) => `"description": ${JSON.stringify('A very long description. '.repeat((BIG_RUN ? [2000, 8000, 30000, 80000] : [200, 800, 3000, 8000])[n - 1]))},${eol}`,
    quotes: '"',
    brackets: '{}[]',
    memberLine: /^\s+"name": ("(?:[^"\\\n]|\\.)*")/,
  };
}
