/**
 * Read a DBML file into one plain shape for **Import DBML…** — the reading
 * half of the import; the pure planner is `src/services/dbmlImport.ts`.
 *
 * The parser is the pinned `@dbml/parse` 11.0.0 (the one dbdiagram.io runs),
 * bundled into `dist/extension.js` (one copy, shared with
 * `@erd-studio/core/dbml`). Its raw model is close to what the import needs,
 * but not quite, so this module evens it out:
 *
 *  - custom-property values come as a plain string up to 10.x and as
 *    `{ value, type, token }` from 11.0 (where an unquoted `2` or `true` is
 *    also allowed); both read as text here;
 *  - a `TablePartial`'s fields, indexes, checks, note and header colour are
 *    injected into each table that uses it (the raw model only names the
 *    partial), in the order the file writes them: the table's own field wins
 *    over a partial's, and a later partial over an earlier one;
 *  - a `[ref: …]` written on a column is in the raw model's `refs` with its
 *    ends swapped (the referenced table first), and one written in a partial
 *    is not there at all; every ref here names the end that declared it, which
 *    is the end holding the foreign key;
 *  - names keep their exact spelling (quoted, odd or schema-qualified), and a
 *    table's DBML alias (`Table users as U`) is resolved by the parser.
 *
 * Pure: no `vscode`, no file access — text in, model or diagnostics out.
 */

import { Compiler, DEFAULT_ENTRY, MemoryProjectLayout } from '@dbml/parse';
import { ERD_STUDIO_DBML_HEADER_PREFIX } from '@erd-studio/core';

// ---------------------------------------------------------------------------
// The normalised model
// ---------------------------------------------------------------------------

/** A problem the parser found, 1-based like an editor shows it. */
export interface DbmlDiagnostic {
  line: number;
  column: number;
  message: string;
}

/** A custom property map (`[role: 'dim', grain: '…']`), every value as text. */
export type DbmlProperties = Record<string, string>;

export interface DbmlCheck {
  expression: string;
  name?: string;
}

export interface DbmlField {
  name: string;
  /** The type as written, schema-qualified when the file qualifies it (`varchar(255)`, `ecommerce.status`). */
  type: string;
  note: string;
  pk: boolean;
  unique: boolean;
  notNull: boolean;
  increment: boolean;
  /** `default:` as written; an expression keeps its backticks out (`now()`) and says so in `type`. */
  default?: { type: 'number' | 'string' | 'boolean' | 'expression'; value: string };
  checks: DbmlCheck[];
  properties: DbmlProperties;
  /** The partial the field was injected from, when it was. */
  fromPartial?: string;
}

export interface DbmlIndex {
  /** Each column, or an expression index's text (`expression: true`). */
  columns: Array<{ value: string; expression: boolean }>;
  pk: boolean;
  unique: boolean;
  name?: string;
  type?: string;
  note?: string;
}

export interface DbmlTable {
  name: string;
  /** As written; null when the file names no schema. */
  schema: string | null;
  /** The DBML alias (`Table users as U`), which only DBML uses. */
  alias: string | null;
  note: string;
  headerColor?: string;
  properties: DbmlProperties;
  /** Own fields and injected partial fields, in file order. */
  fields: DbmlField[];
  indexes: DbmlIndex[];
  checks: DbmlCheck[];
  /** The partials injected, in order. */
  partials: string[];
  /** 1-based line of the table's declaration. */
  line: number;
}

/** One end of a ref. `relation` is the parser's: `'1'`, `'*'`, `'0..1'`, `'1..*'`, … */
export interface DbmlRefEnd {
  schema: string | null;
  table: string;
  columns: string[];
  relation: string;
}

export interface DbmlRef {
  name: string | null;
  ends: [DbmlRefEnd, DbmlRefEnd];
  /** The end whose column declared the ref (`[ref: > …]`): it holds the foreign key. */
  declaredAt?: 0 | 1;
  onDelete?: string;
  onUpdate?: string;
  color?: string;
  inactive: boolean;
  /** 1-based line of the ref. */
  line: number;
}

export interface DbmlEnumValue {
  name: string;
  /** The value's own note (`running_low [note: 'less than 20']`), when it has one. */
  note?: string;
}

export interface DbmlEnum {
  name: string;
  schema: string | null;
  values: DbmlEnumValue[];
}

export interface DbmlTableGroup {
  name: string;
  tables: Array<{ name: string; schema: string | null }>;
  color?: string;
  note: string;
}

/** A sticky note: a top-level `Note name { '…' }`. */
export interface DbmlStickyNote {
  name: string;
  content: string;
  color?: string;
  properties: DbmlProperties;
}

export interface DbmlProject {
  name: string | null;
  note: string;
  /** Every other project setting (`database_type`, …). */
  properties: DbmlProperties;
}

/** What a DBML file says, in the shape the import planner reads. */
export interface DbmlModel {
  /** True when the file starts with an ERD Studio export header (plain or rich). */
  erdStudioExport: boolean;
  /**
   * True for ERD Studio's plain (v1) export, which writes a one-to-one with
   * the FK end first (`from.col - to.col`); the rich (v2) export writes it
   * the DBML way round, key end first. Optional: absent reads as false.
   */
  erdStudioPlainExport?: boolean;
  project: DbmlProject | null;
  tables: DbmlTable[];
  refs: DbmlRef[];
  enums: DbmlEnum[];
  tableGroups: DbmlTableGroup[];
  notes: DbmlStickyNote[];
  /** `Records` blocks: sample rows, which ERD Studio does not keep. */
  records: Array<{ schema: string | null; table: string; rows: number }>;
  /** Dependency arrows (`Dep`, DBML 10+) and `DiagramView`s, which ERD Studio does not keep. */
  dependencies: number;
  diagramViews: number;
}

export type ReadDbmlResult =
  | { ok: true; model: DbmlModel }
  /** `importsOtherFiles`: the file has a `use` declaration (§5.7), so it is part of a multi-file project; nothing was parsed. */
  | { ok: false; diagnostics: DbmlDiagnostic[]; importsOtherFiles?: true };

/**
 * Import DBML's refusal for a file with `use` lines (native DBML storage,
 * §5.7): `Parser.parse` rejects `use`, and the file is one part of a
 * multi-file project, so Import names the route that works instead.
 */
export const IMPORT_MULTI_FILE_MESSAGE =
  'This DBML file imports other files (`use`), so it is part of a multi-file project, such as another ERD Studio 2.0 project. ' +
  'Import reads one self-contained file: open that project\'s diagram in ERD Studio and use **Export Diagram… → DBML (rich)**, then import the exported file.';

/**
 * The 1-based line of the first `use` declaration in `text` (a line whose
 * first token is `use`, outside a comment or a string), or undefined.
 */
export function firstUseDeclarationLine(text: string): number | undefined {
  let line = 1;
  let atLineStart = true;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; atLineStart = true; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\uFEFF') { i++; continue; }
    if (text.startsWith('//', i)) {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let j = i; j < stop; j++) if (text[j] === '\n') line++;
      i = stop;
      atLineStart = false;
      continue;
    }
    if (text.startsWith("'''", i)) {
      const end = text.indexOf("'''", i + 3);
      const stop = end < 0 ? n : end + 3;
      for (let j = i; j < stop; j++) if (text[j] === '\n') line++;
      i = stop;
      atLineStart = false;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      atLineStart = false;
      continue;
    }
    if (atLineStart && /^use(?=[\s{*'"])/.test(text.slice(i, i + 4))) return line;
    atLineStart = false;
    i++;
  }
  return undefined;
}

/**
 * The parts of an `@dbml/parse` module the reader uses. Tests pass the 9.x and
 * 10.x releases (`dbml-parse-v9`, `dbml-parse-v10`) to read the same text with
 * each; the extension always uses the pinned `@dbml/parse` 11.0.0.
 */
export interface DbmlParserModule {
  // The parser's classes are typed per release; the reader only relies on this much.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Compiler: new (layout: any) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MemoryProjectLayout: new () => { setSource(entry: any, text: string): void };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DEFAULT_ENTRY: any;
}

const PINNED_PARSER: DbmlParserModule = { Compiler, MemoryProjectLayout, DEFAULT_ENTRY };

/**
 * The first line of ERD Studio's rich export starts with this
 * (`DBML_RICH_EXPORT_HEADER` in `@erd-studio/core` is the whole line). It
 * lives in core, where the file classifier reads it too.
 */
export { ERD_STUDIO_DBML_HEADER_PREFIX };

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Parse `text`. Any error the parser reports makes the file unreadable — the
 * parser builds no model then — and comes back as diagnostics, 1-based.
 * Warnings (a Records row a ref does not match, …) are ignored. Never throws.
 */
export function readDbml(text: string, parser: DbmlParserModule = PINNED_PARSER): ReadDbmlResult {
  const useLine = firstUseDeclarationLine(text);
  if (useLine !== undefined) {
    return { ok: false, importsOtherFiles: true, diagnostics: [{ line: useLine, column: 1, message: IMPORT_MULTI_FILE_MESSAGE }] };
  }
  let raw: unknown;
  try {
    const layout = new parser.MemoryProjectLayout();
    layout.setSource(parser.DEFAULT_ENTRY, text);
    const compiler = new parser.Compiler(layout);
    const errors: unknown[] = compiler.parse.errors(parser.DEFAULT_ENTRY) ?? [];
    if (errors.length > 0) {
      return { ok: false, diagnostics: errors.map((e) => diagnosticOf(e, text)) };
    }
    raw = compiler.parse.rawDb(parser.DEFAULT_ENTRY);
  } catch (err) {
    return { ok: false, diagnostics: [{ line: 1, column: 1, message: `The DBML parser stopped: ${messageOf(err)}` }] };
  }
  if (!isObject(raw)) {
    return { ok: false, diagnostics: [{ line: 1, column: 1, message: 'The DBML parser returned nothing for this file.' }] };
  }
  return {
    ok: true,
    model: normaliseRawDbml(raw, { erdStudioExport: isErdStudioExport(text), erdStudioPlainExport: isErdStudioPlainExport(text) }),
  };
}

/** The first non-blank line of `text`, trimmed. */
function firstLine(text: string): string | undefined {
  return text.replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim() !== '')?.trim();
}

/** Whether `text` is one of ERD Studio's own exports, plain or rich (its first non-blank line is the header). */
export function isErdStudioExport(text: string): boolean {
  return firstLine(text)?.startsWith(ERD_STUDIO_DBML_HEADER_PREFIX) === true;
}

/** Whether `text` is ERD Studio's plain (v1) export, `DBML_EXPORT_HEADER` in `@erd-studio/core`. */
export function isErdStudioPlainExport(text: string): boolean {
  return firstLine(text)?.startsWith(`${ERD_STUDIO_DBML_HEADER_PREFIX} v1`) === true;
}

function diagnosticOf(error: unknown, text: string): DbmlDiagnostic {
  const e = isObject(error) ? error : {};
  const message = typeof e.diagnostic === 'string' && e.diagnostic ? e.diagnostic : messageOf(error);
  const node = isObject(e.nodeOrToken) ? e.nodeOrToken : {};
  const pos = isObject(node.startPos) ? node.startPos : undefined;
  if (pos && typeof pos.line === 'number' && typeof pos.column === 'number') {
    // The parser counts lines and columns from 0.
    return { line: pos.line + 1, column: pos.column + 1, message };
  }
  if (typeof e.start === 'number') return { ...positionOf(text, e.start), message };
  return { line: 1, column: 1, message };
}

/** 1-based line and column of `offset` in `text`. */
function positionOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, offset));
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Normalising the raw model
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function list(value: unknown): Loose[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A `note` (`{ value }`, or a bare string from an older shape) as text, '' when absent. */
function noteText(value: unknown): string {
  if (typeof value === 'string') return value;
  return isObject(value) && typeof value.value === 'string' ? value.value : '';
}

/** 1-based line of an element's token, 0 when the parser gave none. */
function lineOf(value: Loose): number {
  const token = isObject(value.token) ? value.token : undefined;
  const start = token && isObject(token.start) ? token.start : undefined;
  return start && typeof start.line === 'number' ? start.line : 0;
}

function offsetOf(value: Loose): number {
  const token = isObject(value.token) ? value.token : undefined;
  const start = token && isObject(token.start) ? token.start : undefined;
  return start && typeof start.offset === 'number' ? start.offset : -1;
}

/**
 * One custom-property value as text, whichever parser wrote it: a plain
 * string (9.x / 10.x), or `{ value, type }` (11.x, whose value may also be
 * an unquoted number or `true` / `false`). Anything else reads as undefined.
 */
export function dbmlPropertyText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isObject(value) && 'value' in value) {
    const inner = value.value;
    if (typeof inner === 'string') return inner;
    if (typeof inner === 'number' || typeof inner === 'boolean') return String(inner);
    if (inner === null) return '';
  }
  return undefined;
}

/** Set `key` as an own property: a property may be named `__proto__`, which plain assignment would swallow. */
function setOwn(map: DbmlProperties, key: string, value: string): void {
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A `metadata` map, every value as text (see {@link dbmlPropertyText}). */
export function dbmlProperties(metadata: unknown): DbmlProperties {
  const out: DbmlProperties = {};
  if (!isObject(metadata)) return out;
  for (const [key, value] of Object.entries(metadata)) {
    const read = dbmlPropertyText(value);
    if (read !== undefined) setOwn(out, key, read);
  }
  return out;
}

function colorOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function checksOf(value: unknown): DbmlCheck[] {
  return list(value)
    .filter((c) => typeof c.expression === 'string')
    .map((c) => ({ expression: c.expression as string, ...(typeof c.name === 'string' && c.name ? { name: c.name } : {}) }));
}

function typeOf(value: unknown): string {
  if (!isObject(value)) return '';
  const name = text(value.type_name) ?? '';
  const schema = text(value.schemaName);
  return schema ? `${schema}.${name}` : name;
}

function defaultOf(value: unknown): DbmlField['default'] {
  if (!isObject(value)) return undefined;
  const type = value.type;
  if (type !== 'number' && type !== 'string' && type !== 'boolean' && type !== 'expression') return undefined;
  const v = value.value;
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return undefined;
  return { type, value: String(v) };
}

function fieldOf(raw: Loose, fromPartial?: string): DbmlField {
  const field: DbmlField = {
    name: text(raw.name) ?? '',
    type: typeOf(raw.type),
    note: noteText(raw.note),
    pk: raw.pk === true,
    unique: raw.unique === true,
    notNull: raw.not_null === true,
    increment: raw.increment === true,
    checks: checksOf(raw.checks),
    properties: dbmlProperties(raw.metadata),
  };
  const dflt = defaultOf(raw.dbdefault);
  if (dflt) field.default = dflt;
  if (fromPartial) field.fromPartial = fromPartial;
  return field;
}

function indexOf(raw: Loose): DbmlIndex {
  const index: DbmlIndex = {
    columns: list(raw.columns)
      .filter((c) => typeof c.value === 'string')
      .map((c) => ({ value: c.value as string, expression: c.type === 'expression' })),
    pk: raw.pk === true,
    unique: raw.unique === true,
  };
  if (typeof raw.name === 'string' && raw.name) index.name = raw.name;
  if (typeof raw.type === 'string' && raw.type) index.type = raw.type;
  const note = noteText(raw.note);
  if (note) index.note = note;
  return index;
}

function refEndOf(raw: Loose): DbmlRefEnd {
  return {
    schema: text(raw.schemaName),
    table: text(raw.tableName) ?? '',
    columns: Array.isArray(raw.fieldNames) ? raw.fieldNames.filter((f): f is string => typeof f === 'string') : [],
    relation: text(raw.relation) ?? '1',
  };
}

/**
 * The two cardinalities of an inline ref's operator, its own column first:
 * `>` many-to-one, `<` one-to-many, `-` one-to-one, `<>` many-to-many. A `?`
 * on a side makes that side optional (`0..1`) as the parser's own refs do.
 */
function inlineRelations(op: string): [string, string] {
  const left = op.startsWith('?');
  const right = op.endsWith('?') && op.length > 1;
  const base = op.replace(/^\?/, '').replace(/\?$/, '');
  const [a, b] = base === '>' ? ['*', '1'] : base === '<' ? ['1', '*'] : base === '<>' ? ['*', '*'] : ['1', '1'];
  const optional = (r: string, opt: boolean): string => (opt && r === '1' ? '0..1' : r);
  return [optional(a, left), optional(b, right)];
}

interface PartialDef {
  fields: Loose[];
  indexes: Loose[];
  checks: Loose[];
  note: string;
  headerColor?: string;
}

/** A table's own fields and injected partials, merged in file order (see the module comment). */
function expandFields(
  rawTable: Loose,
  partials: ReadonlyMap<string, PartialDef>,
): { fields: Array<{ raw: Loose; fromPartial?: string }>; used: PartialDef[]; names: string[] } {
  type Item = { offset: number; order: number; own?: Loose; partial?: string };
  const items: Item[] = [];
  list(rawTable.fields).forEach((f, i) => items.push({ offset: offsetOf(f), order: i, own: f }));
  list(rawTable.partials).forEach((p, i) => {
    if (typeof p.name === 'string') items.push({ offset: offsetOf(p), order: typeof p.order === 'number' ? p.order : i, partial: p.name });
  });
  // Tokens give file order; without them, own fields first, then partials by their order.
  items.sort((a, b) => (a.offset >= 0 && b.offset >= 0 ? a.offset - b.offset : (a.own ? 0 : 1) - (b.own ? 0 : 1) || a.order - b.order));

  const ownNames = new Set(list(rawTable.fields).map((f) => String(f.name ?? '')));
  const slots: Array<{ raw: Loose; fromPartial?: string } | null> = [];
  const partialSlot = new Map<string, number>();
  const used: PartialDef[] = [];
  const names: string[] = [];
  for (const item of items) {
    if (item.own) {
      slots.push({ raw: item.own });
      continue;
    }
    const def = partials.get(item.partial!);
    if (!def) continue;
    used.push(def);
    names.push(item.partial!);
    for (const f of def.fields) {
      const name = String(f.name ?? '');
      if (ownNames.has(name)) continue;
      // A later partial's field replaces an earlier partial's, where the later one is injected.
      const earlier = partialSlot.get(name);
      if (earlier !== undefined) slots[earlier] = null;
      partialSlot.set(name, slots.length);
      slots.push({ raw: f, fromPartial: item.partial });
    }
  }
  return { fields: slots.filter((s): s is { raw: Loose; fromPartial?: string } => s !== null), used, names };
}

const endKey = (schema: string | null, table: string, columns: readonly string[]): string =>
  `${schema ?? ''}\u0000${table}\u0000${columns.join('\u0001')}`;

/**
 * The raw model `rawDb` returns (any 9.x–11.x shape) as a {@link DbmlModel}.
 * Exported for tests; {@link readDbml} is the entry point.
 */
export function normaliseRawDbml(raw: Loose, options: { erdStudioExport?: boolean; erdStudioPlainExport?: boolean } = {}): DbmlModel {
  const partials = new Map<string, PartialDef>();
  for (const p of list(raw.tablePartials)) {
    if (typeof p.name !== 'string') continue;
    partials.set(p.name, {
      fields: list(p.fields),
      indexes: list(p.indexes),
      checks: list(p.checks),
      note: noteText(p.note),
      headerColor: colorOf(p.headerColor),
    });
  }

  const tables: DbmlTable[] = [];
  // Inline refs: where the parser's own ref list has one, and the ones it lacks (from partials).
  const declared = new Map<number, { schema: string | null; table: string; column: string }>();
  const partialRefs: DbmlRef[] = [];
  for (const t of list(raw.tables)) {
    const name = text(t.name) ?? '';
    const schema = text(t.schemaName);
    const expanded = expandFields(t, partials);
    const fields = expanded.fields.map(({ raw: f, fromPartial }) => fieldOf(f, fromPartial));
    let note = noteText(t.note);
    let headerColor = colorOf(t.headerColor);
    const indexes = list(t.indexes).map(indexOf);
    const checks = checksOf(t.checks);
    for (const def of expanded.used) {
      indexes.push(...def.indexes.map(indexOf));
      checks.push(...checksOf(def.checks));
    }
    // The table's own note and colour win; otherwise the last partial that sets one.
    for (const def of [...expanded.used].reverse()) {
      if (!note && def.note) note = def.note;
      if (!headerColor && def.headerColor) headerColor = def.headerColor;
    }
    tables.push({
      name,
      schema,
      alias: text(t.alias),
      note,
      ...(headerColor ? { headerColor } : {}),
      properties: dbmlProperties(t.metadata),
      fields,
      indexes,
      checks,
      partials: expanded.names,
      line: lineOf(t),
    });

    for (const { raw: f, fromPartial } of expanded.fields) {
      for (const r of list(f.inline_refs)) {
        const column = String(f.name ?? '');
        if (!fromPartial) {
          declared.set(offsetOf(r), { schema, table: name, column });
          continue;
        }
        const [own, other] = inlineRelations(text(r.relation) ?? '-');
        partialRefs.push({
          name: null,
          ends: [
            { schema, table: name, columns: [column], relation: own },
            { ...refEndOf(r), relation: other },
          ],
          declaredAt: 0,
          inactive: false,
          line: lineOf(r),
        });
      }
    }
  }

  const refs: DbmlRef[] = [];
  for (const r of list(raw.refs)) {
    const endpoints = list(r.endpoints);
    if (endpoints.length !== 2) continue;
    const ends: [DbmlRefEnd, DbmlRefEnd] = [refEndOf(endpoints[0]), refEndOf(endpoints[1])];
    const ref: DbmlRef = { name: text(r.name), ends, inactive: r.inactive === true, line: lineOf(r) };
    const owner = declared.get(offsetOf(r));
    if (owner) {
      const at = ends.findIndex((e) => e.table === owner.table && e.schema === owner.schema
        && e.columns.length === 1 && e.columns[0] === owner.column);
      if (at === 0 || at === 1) ref.declaredAt = at;
    }
    if (typeof r.onDelete === 'string' && r.onDelete) ref.onDelete = r.onDelete;
    if (typeof r.onUpdate === 'string' && r.onUpdate) ref.onUpdate = r.onUpdate;
    const color = colorOf(r.color);
    if (color) ref.color = color;
    refs.push(ref);
  }
  // A partial's inline ref reaches every table that injects it, unless a ref already joins those columns.
  const seen = new Set(refs.flatMap((r) => [
    endKey(r.ends[0].schema, r.ends[0].table, r.ends[0].columns) + '\u0002' + endKey(r.ends[1].schema, r.ends[1].table, r.ends[1].columns),
    endKey(r.ends[1].schema, r.ends[1].table, r.ends[1].columns) + '\u0002' + endKey(r.ends[0].schema, r.ends[0].table, r.ends[0].columns),
  ]));
  for (const r of partialRefs) {
    const key = endKey(r.ends[0].schema, r.ends[0].table, r.ends[0].columns) + '\u0002' + endKey(r.ends[1].schema, r.ends[1].table, r.ends[1].columns);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(r);
  }

  const rawProject = isObject(raw.project) ? raw.project : undefined;
  let project: DbmlProject | null = null;
  if (rawProject && (typeof rawProject.name === 'string' || rawProject.note !== undefined || Object.keys(rawProject).length > 0)) {
    const properties: DbmlProperties = {};
    for (const [key, value] of Object.entries(rawProject)) {
      if (PROJECT_STRUCTURE_KEYS.has(key)) continue;
      const read = dbmlPropertyText(value);
      if (read !== undefined) setOwn(properties, key, read);
    }
    const name = text(rawProject.name);
    const note = noteText(rawProject.note);
    if (name !== null || note || Object.keys(properties).length > 0) project = { name, note, properties };
  }

  return {
    erdStudioExport: options.erdStudioExport === true,
    erdStudioPlainExport: options.erdStudioPlainExport === true,
    project,
    tables,
    refs,
    enums: list(raw.enums).map((e) => ({
      name: text(e.name) ?? '',
      schema: text(e.schemaName),
      values: list(e.values).flatMap((v): DbmlEnumValue[] => {
        const name = text(v.name);
        if (name === null) return [];
        const note = noteText(v.note);
        return [note ? { name, note } : { name }];
      }),
    })),
    tableGroups: list(raw.tableGroups).map((g) => ({
      name: text(g.name) ?? '',
      tables: list(g.tables).map((t) => ({ name: text(t.name) ?? '', schema: text(t.schemaName) })),
      ...(colorOf(g.color) ? { color: colorOf(g.color) } : {}),
      note: noteText(g.note),
    })),
    notes: list(raw.notes).map((n) => ({
      name: text(n.name) ?? '',
      content: text(n.content) ?? noteText(n.content),
      ...(colorOf(n.color) ? { color: colorOf(n.color) } : {}),
      properties: dbmlProperties(n.metadata),
    })),
    records: list(raw.records).map((r) => ({
      schema: text(r.schemaName),
      table: text(r.tableName) ?? '',
      rows: Array.isArray(r.values) ? r.values.length : 0,
    })),
    dependencies: Array.isArray(raw.deps) ? raw.deps.length : 0,
    diagramViews: Array.isArray(raw.diagramViews) ? raw.diagramViews.length : 0,
  };
}

/** Keys of a raw `Project` that are its structure, not a setting. */
const PROJECT_STRUCTURE_KEYS = new Set(['name', 'note', 'tables', 'refs', 'enums', 'tableGroups', 'tablePartials', 'records', 'token']);
