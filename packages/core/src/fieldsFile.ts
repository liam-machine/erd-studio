/**
 * `.erd-studio/fields.yml`: the fields a project records, read into a
 * resolved {@link FieldList} (and written back as text, for a host that
 * shows a project the starting set as a file).
 *
 * ```yaml
 * version: 1
 * tables:
 *   - grain                    # a bare name: the built-in, as shipped
 *   - key: decisions           # a built-in in the team's own words
 *     guidance: Choices finance signed off, and why.
 *   - key: owner               # a field of the team's own
 *     label: Owner
 *     type: value              # text (default) | value | choice | yes-no
 *     filled_by: dbt           # anyone (default) | people | dbt
 * columns:
 *   - natural_key
 * left_out: [dimension, metrics]
 * ```
 *
 * Reading never fails: every problem is reported as a
 * {@link FieldsFileProblem} with a stable `code`, and what can be read is
 * used. A file that is not YAML, or not a map, gives the starting set. A
 * missing `tables:` (or `columns:`) gives the starting set's fields for that
 * scope; `tables: []` (or a bare `tables:`) means none. No `version:` is 1;
 * a newer one is read for what this core understands. Unknown top-level keys
 * and unknown entry keys are ignored.
 *
 * Read from repositories ERD Studio does not control, so anchors and aliases
 * are followed one at a time against the optional `maxNodes` / `maxChars`
 * budgets (the same idea as `parseTableText`'s): a file over budget is
 * reported, never expanded.
 */

import { LineCounter, Document, isAlias, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml';
import type { Alias, Node } from 'yaml';

import {
  BUILT_IN_FIELDS,
  FIELD_FILLED_BY,
  FIELD_KEY_PATTERN,
  FIELD_SHOW_FOR,
  FIELD_TYPES,
  STARTING_FIELD_LIST,
  builtInField,
  reservedFieldKeyReason,
  type FieldDefinition,
  type FieldFilledBy,
  type FieldList,
  type FieldScope,
  type FieldShowFor,
  type FieldType,
} from './fields.js';
import { checkLimit } from './limits.js';
import { findConflictMarkers } from './mergeConflict.js';

/** The file's name, directly in the semantic dir (next to `layers.json`). */
export const FIELDS_FILE_NAME = 'fields.yml';

/** The newest `version:` this core reads. */
export const FIELDS_FILE_VERSION = 1;

/**
 * Every problem code, stable across releases (new ones may be added):
 *
 * - `fieldsYamlInvalid` (error): not YAML, not a map, or over budget — the starting set is used.
 * - `fieldsSectionInvalid` (error): `tables:` / `columns:` / `left_out:` is not a list — that section is the starting set's (`left_out` none).
 * - `fieldsEntryInvalid` (error): an entry is neither a name nor a map with a `key` — skipped.
 * - `fieldsKeyInvalid` (error): a key that is not lower case letters, digits and underscores — skipped.
 * - `fieldsKeyReserved` (error): a key that is a DBML or ERD Studio setting — skipped.
 * - `fieldsKeyDuplicate` (error): a key listed twice in one section — the later copy is skipped.
 * - `fieldsTypeInvalid` (error): an unknown `type` — read as text.
 * - `fieldsChoiceWithoutValues` (error): a choice with fewer than two values — read as text.
 * - `fieldsFilledByInvalid` / `fieldsShowForInvalid` (error): an unknown value — the default is used.
 * - `fieldsUnknownName` (warning): a bare name that is not a built-in — skipped.
 * - `fieldsBuiltInOverride` (warning): a built-in's `type`, `values`, `show_for` or `home` — ignored.
 * - `fieldsRetiredListed` (warning): a retired built-in on the list — still shown.
 * - `fieldsVersionNewer` (warning): `version:` newer than {@link FIELDS_FILE_VERSION}.
 * - `fieldsVersionInvalid` (warning): `version:` is not a whole number of at least 1 — read as 1.
 * - `fieldsPropertyInvalid` (warning): a `label` or `guidance` that is not text — ignored.
 */
export type FieldsFileProblemCode =
  | 'fieldsYamlInvalid'
  | 'fieldsSectionInvalid'
  | 'fieldsEntryInvalid'
  | 'fieldsKeyInvalid'
  | 'fieldsKeyReserved'
  | 'fieldsKeyDuplicate'
  | 'fieldsTypeInvalid'
  | 'fieldsChoiceWithoutValues'
  | 'fieldsFilledByInvalid'
  | 'fieldsShowForInvalid'
  | 'fieldsUnknownName'
  | 'fieldsBuiltInOverride'
  | 'fieldsRetiredListed'
  | 'fieldsVersionNewer'
  | 'fieldsVersionInvalid'
  | 'fieldsPropertyInvalid';

/** Every {@link FieldsFileProblemCode}. */
export const FIELDS_FILE_PROBLEM_CODES: readonly FieldsFileProblemCode[] = Object.freeze([
  'fieldsYamlInvalid',
  'fieldsSectionInvalid',
  'fieldsEntryInvalid',
  'fieldsKeyInvalid',
  'fieldsKeyReserved',
  'fieldsKeyDuplicate',
  'fieldsTypeInvalid',
  'fieldsChoiceWithoutValues',
  'fieldsFilledByInvalid',
  'fieldsShowForInvalid',
  'fieldsUnknownName',
  'fieldsBuiltInOverride',
  'fieldsRetiredListed',
  'fieldsVersionNewer',
  'fieldsVersionInvalid',
  'fieldsPropertyInvalid',
] as FieldsFileProblemCode[]);

/**
 * One thing wrong with a fields.yml. `line` is 1-based; `key` is the field
 * key the problem is about, when there is one. The message names no file
 * (a host adds the path).
 */
export interface FieldsFileProblem {
  code: FieldsFileProblemCode;
  severity: 'error' | 'warning';
  line?: number;
  key?: string;
  message: string;
}

/** Budgets for {@link parseFieldsText}; both unlimited by default. */
export interface ParseFieldsOptions {
  /** Most YAML nodes the reading may visit (aliases followed count each time). */
  maxNodes?: number;
  /** Most characters of scalar text the reading may take in (counted again each time an alias repeats them). */
  maxChars?: number;
}

class BudgetExceeded extends Error {
  constructor(readonly what: 'nodes' | 'characters', readonly limit: number) {
    super(`fields.yml expands to more than ${limit} ${what}`);
  }
}

const SECTION_NAMES: Readonly<Record<FieldScope, string>> = { table: 'tables', column: 'columns' };
const LEFT_OUT = 'left_out';
const FIXED_BUILT_IN_PROPERTIES = ['type', 'values', 'show_for', 'home'] as const;

/** Reading state: budgets, alias targets and where each node starts. */
class Reader {
  private nodes: number;
  private chars: number;
  readonly problems: FieldsFileProblem[] = [];

  constructor(
    private readonly aliases: ReadonlyMap<Alias, unknown>,
    private readonly lines: LineCounter,
    private readonly maxNodes: number,
    private readonly maxChars: number,
  ) {
    this.nodes = maxNodes;
    this.chars = maxChars;
  }

  private chargeNode(): void {
    if (--this.nodes < 0) throw new BudgetExceeded('nodes', this.maxNodes);
  }

  /** `node` with aliases followed, each one charged. */
  deref(node: unknown): unknown {
    this.chargeNode();
    let current = node;
    for (let hops = 0; isAlias(current) && hops < 64; hops++) {
      this.chargeNode();
      current = this.aliases.get(current as Alias);
    }
    return isAlias(current) ? undefined : current;
  }

  /** The value node under `name` in a map node (aliases not yet followed), or undefined. */
  get(map: unknown, name: string): unknown {
    if (!isMap(map)) return undefined;
    for (const pair of map.items) {
      this.chargeNode();
      const key = this.deref(pair.key);
      if (isScalar(key) && String(key.value) === name) return pair.value ?? null;
    }
    return undefined;
  }

  /** Whether a map node has a pair named `name`. */
  has(map: unknown, name: string): boolean {
    return this.get(map, name) !== undefined;
  }

  /**
   * A scalar's text: a string as it is, a number or a boolean as written;
   * null for a YAML null; undefined for a map, a list or nothing.
   */
  text(node: unknown): string | null | undefined {
    const value = this.deref(node);
    if (!isScalar(value)) return value === null ? null : undefined;
    const v = value.value;
    if (v === null || v === undefined) return null;
    const out = typeof v === 'string' ? v : value.source ?? String(v);
    if ((this.chars -= out.length) < 0) throw new BudgetExceeded('characters', this.maxChars);
    return out;
  }

  /** The 1-based line `node` starts on. */
  line(node: unknown): number | undefined {
    const range = (node as Node | null | undefined)?.range;
    return range ? this.lines.linePos(range[0]).line : undefined;
  }

  problem(code: FieldsFileProblemCode, severity: 'error' | 'warning', node: unknown, message: string, key?: string): void {
    const line = this.line(node);
    this.problems.push({ code, severity, ...(line !== undefined ? { line } : {}), ...(key !== undefined ? { key } : {}), message });
  }
}

/** What each alias in the document refers to, in one pass (as `logicalModel.ts` resolves them). */
function aliasTargets(doc: Document): Map<Alias, unknown> {
  const latest = new Map<string, unknown>();
  const targets = new Map<Alias, unknown>();
  visit(doc, {
    Node: (_key, node) => {
      if (isAlias(node)) targets.set(node, latest.get(node.source));
      else if (node.anchor) latest.set(node.anchor, node);
    },
  });
  return targets;
}

function startingSet(): FieldList {
  return { tables: [...STARTING_FIELD_LIST.tables], columns: [...STARTING_FIELD_LIST.columns], leftOut: [] };
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length];
}

/** The built-in a misspelt name most likely means, in `scope` (retired ones never suggested). */
function closestBuiltIn(name: string, scope: FieldScope): string | undefined {
  const normalised = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  let best: { key: string; distance: number } | undefined;
  for (const def of BUILT_IN_FIELDS) {
    if (def.scope !== scope || def.status === 'retired') continue;
    const distance = def.key === normalised ? 0 : editDistance(normalised, def.key);
    if (distance <= Math.max(1, Math.min(2, Math.floor(def.key.length / 3))) && (!best || distance < best.distance)) {
      best = { key: def.key, distance };
    }
  }
  return best?.key;
}

function reservedMessage(key: string, scope: FieldScope): string {
  switch (reservedFieldKeyReason(key, scope)) {
    case 'dbmlSetting':
      return `${key} is a DBML setting and cannot be a field. Pick another key.`;
    case 'prefix':
      return `${key} starts with erd_, rationale_ or meta_, which ERD Studio uses for its own settings, and cannot be a field. Pick another key.`;
    case 'unsafe':
      return `${key} cannot be a field: some DBML tools mistake it for part of the language. Pick another key.`;
    default:
      return builtInField(key, scope === 'table' ? 'column' : 'table')
        ? `${key} is a built-in ${scope === 'table' ? 'column' : 'table'} field, so it cannot be a ${scope} field. Pick another key.`
        : `${key} is a name ERD Studio uses itself and cannot be a field. Pick another key.`;
  }
}

/** Read a section's entries into definitions. */
function readSection(reader: Reader, seq: unknown, scope: FieldScope): FieldDefinition[] {
  const section = SECTION_NAMES[scope];
  const out: FieldDefinition[] = [];
  const keys = new Set<string>();
  const items = isSeq(seq) ? seq.items : [];
  for (const item of items) {
    const node = reader.deref(item);
    const def = isMap(node) ? readMapEntry(reader, item, node, scope) : readNameEntry(reader, item, node, scope);
    if (!def) continue;
    if (keys.has(def.key)) {
      reader.problem('fieldsKeyDuplicate', 'error', item, `${def.key} is listed twice under ${section}:. The first one is used; remove the other.`, def.key);
      continue;
    }
    keys.add(def.key);
    out.push(def);
  }
  return out;
}

function retiredWarning(reader: Reader, item: unknown, def: FieldDefinition): void {
  reader.problem('fieldsRetiredListed', 'warning', item,
    `${def.key} is a retired field. Tables keep its text and it is still shown, but it is no longer offered. ${def.guidance ?? 'Move its text to Decisions.'}`,
    def.key);
}

function readNameEntry(reader: Reader, item: unknown, node: unknown, scope: FieldScope): FieldDefinition | undefined {
  const section = SECTION_NAMES[scope];
  const raw = isScalar(node) && typeof node.value === 'string' ? reader.text(node) : undefined;
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') {
    reader.problem('fieldsEntryInvalid', 'error', item,
      `An entry under ${section}: must be a built-in field's name or a map with a key. It is skipped.`);
    return undefined;
  }
  const builtin = builtInField(name, scope);
  if (builtin) {
    if (builtin.status === 'retired') retiredWarning(reader, item, builtin);
    return builtin;
  }
  const otherScope: FieldScope = scope === 'table' ? 'column' : 'table';
  const elsewhere = builtInField(name, otherScope);
  const suggestion = closestBuiltIn(name, scope);
  const message = elsewhere
    ? `${name} is a built-in ${otherScope} field. List it under ${SECTION_NAMES[otherScope]}:.`
    : suggestion
      ? `${name} is not a built-in field. Did you mean ${suggestion}?`
      : `${name} is not a built-in field. To add a field of your own, write it as "- key: ${name}" with a label.`;
  reader.problem('fieldsUnknownName', 'warning', item, message, name);
  return undefined;
}

/** A `label` / `guidance` value: trimmed text, or undefined (reported when present but not text). */
function readTextProperty(reader: Reader, map: unknown, name: string, key: string): string | undefined {
  const node = reader.get(map, name);
  if (node === undefined) return undefined;
  const text = reader.text(node);
  if (text === null) return undefined;
  if (text === undefined) {
    reader.problem('fieldsPropertyInvalid', 'warning', node, `${key}: ${name} must be text. It is ignored.`, key);
    return undefined;
  }
  return text.trim() === '' ? undefined : text.trim();
}

function readEnum<T extends string>(
  reader: Reader,
  map: unknown,
  name: string,
  key: string,
  allowed: readonly T[],
  fallback: T,
  code: FieldsFileProblemCode,
): T {
  const node = reader.get(map, name);
  if (node === undefined) return fallback;
  const text = reader.text(node);
  if (text === null) return fallback;
  const value = typeof text === 'string' ? text.trim() : undefined;
  if (value !== undefined && (allowed as readonly string[]).includes(value)) return value as T;
  reader.problem(code, 'error', node,
    `${key}: ${name} ${value !== undefined ? `${value} ` : ''}is not one of ${allowed.join(', ')}. ${fallback} is used.`, key);
  return fallback;
}

function readMapEntry(reader: Reader, item: unknown, map: unknown, scope: FieldScope): FieldDefinition | undefined {
  const section = SECTION_NAMES[scope];
  const keyNode = reader.get(map, 'key');
  const rawKey = keyNode === undefined ? undefined : reader.text(keyNode);
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (key === '') {
    reader.problem('fieldsEntryInvalid', 'error', item, `An entry under ${section}: has no key. It is skipped.`);
    return undefined;
  }

  const builtin = builtInField(key, scope);
  if (builtin) {
    const ignored = FIXED_BUILT_IN_PROPERTIES.filter((name) => reader.has(map, name));
    if (ignored.length > 0) {
      reader.problem('fieldsBuiltInOverride', 'warning', item,
        `${key} is a built-in field: only its label, guidance and filled_by can change. Its ${ignored.join(', ')} ${ignored.length === 1 ? 'is' : 'are'} ignored.`,
        key);
    }
    if (builtin.status === 'retired') retiredWarning(reader, item, builtin);
    const label = readTextProperty(reader, map, 'label', key);
    const guidance = readTextProperty(reader, map, 'guidance', key);
    const filledBy = readEnum<FieldFilledBy>(reader, map, 'filled_by', key, FIELD_FILLED_BY, builtin.filledBy, 'fieldsFilledByInvalid');
    if (label === undefined && guidance === undefined && filledBy === builtin.filledBy) return builtin;
    return {
      ...builtin,
      ...(builtin.values ? { values: [...builtin.values] } : {}),
      home: { ...builtin.home },
      label: label ?? builtin.label,
      ...(guidance !== undefined || builtin.guidance !== undefined ? { guidance: guidance ?? builtin.guidance } : {}),
      filledBy,
    };
  }

  if (!FIELD_KEY_PATTERN.test(key)) {
    const lower = key.toLowerCase().replace(/[\s-]+/g, '_');
    const hint = FIELD_KEY_PATTERN.test(lower) ? ` Try ${lower}.` : '';
    reader.problem('fieldsKeyInvalid', 'error', keyNode,
      `${key} cannot be a field key: use lower case letters, digits and underscores, starting with a letter or an underscore, because DBML lower-cases setting names.${hint} It is skipped.`,
      key);
    return undefined;
  }
  if (reservedFieldKeyReason(key, scope) !== undefined) {
    reader.problem('fieldsKeyReserved', 'error', keyNode, reservedMessage(key, scope), key);
    return undefined;
  }

  let type = readEnum<FieldType>(reader, map, 'type', key, FIELD_TYPES, 'text', 'fieldsTypeInvalid');
  let values: string[] | undefined;
  if (type === 'choice') {
    const valuesNode = reader.get(map, 'values');
    const seq = valuesNode === undefined ? undefined : reader.deref(valuesNode);
    const read: string[] = [];
    if (isSeq(seq)) {
      for (const value of seq.items) {
        const text = reader.text(value);
        const trimmed = typeof text === 'string' ? text.trim() : '';
        if (trimmed !== '' && !read.includes(trimmed)) read.push(trimmed);
      }
    }
    if (read.length < 2) {
      reader.problem('fieldsChoiceWithoutValues', 'error', valuesNode ?? item,
        `${key}: a choice needs a list of at least two values. It is read as text until it has them.`, key);
      type = 'text';
    } else {
      values = read;
    }
  }
  const label = readTextProperty(reader, map, 'label', key);
  const guidance = readTextProperty(reader, map, 'guidance', key);
  const filledBy = readEnum<FieldFilledBy>(reader, map, 'filled_by', key, FIELD_FILLED_BY, 'anyone', 'fieldsFilledByInvalid');
  const showFor = readEnum<FieldShowFor>(reader, map, 'show_for', key, FIELD_SHOW_FOR, 'all', 'fieldsShowForInvalid');
  return {
    key,
    scope,
    label: label ?? key,
    type,
    ...(values ? { values } : {}),
    ...(guidance !== undefined ? { guidance } : {}),
    filledBy,
    showFor,
    status: 'team',
    home: { kind: 'meta' },
  };
}

function readLeftOut(reader: Reader, node: unknown): string[] {
  const value = reader.deref(node);
  if (value === null || (isScalar(value) && (value.value === null || value.value === undefined))) return [];
  const out: string[] = [];
  const add = (text: string | null | undefined): void => {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
  };
  if (isScalar(value)) {
    add(reader.text(value));
    return out;
  }
  if (!isSeq(value)) {
    reader.problem('fieldsSectionInvalid', 'error', node, `${LEFT_OUT}: must be a list of dbt meta keys. It is ignored.`);
    return out;
  }
  for (const item of value.items) {
    const text = reader.text(item);
    if (typeof text !== 'string') {
      reader.problem('fieldsEntryInvalid', 'error', item, `An entry under ${LEFT_OUT}: must be a dbt meta key. It is skipped.`);
      continue;
    }
    add(text);
  }
  return out;
}

function readVersion(reader: Reader, root: unknown): void {
  const node = reader.get(root, 'version');
  if (node === undefined) return;
  const text = reader.text(node);
  const version = typeof text === 'string' && /^\s*\d+\s*$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(version) || version < 1) {
    reader.problem('fieldsVersionInvalid', 'warning', node,
      `version must be a whole number (${FIELDS_FILE_VERSION}). The file is read as version ${FIELDS_FILE_VERSION}.`);
  } else if (version > FIELDS_FILE_VERSION) {
    reader.problem('fieldsVersionNewer', 'warning', node,
      `This file is version ${version}, newer than this ERD Studio reads (${FIELDS_FILE_VERSION}). What it understands is used; update ERD Studio to read the rest.`);
  }
}

/**
 * Read the text of a fields.yml into a resolved {@link FieldList}, plus every
 * problem found. Never throws on any text (a budget option that is not a
 * number of at least 0, or Infinity, throws a TypeError, as
 * `parseTableText`'s do). See the module header for the rules.
 */
export function parseFieldsText(text: string, opts: ParseFieldsOptions = {}): { list: FieldList; problems: FieldsFileProblem[] } {
  const maxNodes = checkLimit('parseFieldsText', 'maxNodes', opts.maxNodes ?? Infinity);
  const maxChars = checkLimit('parseFieldsText', 'maxChars', opts.maxChars ?? Infinity);
  const source = typeof text === 'string' ? text : '';
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines });
  const invalid = (message: string, line?: number): { list: FieldList; problems: FieldsFileProblem[] } => ({
    list: startingSet(),
    problems: [{ code: 'fieldsYamlInvalid', severity: 'error', ...(line !== undefined ? { line } : {}), message }],
  });

  if (doc.errors.length > 0) {
    const conflict = findConflictMarkers(source);
    if (conflict !== null) {
      return invalid('The file has an unresolved Git merge conflict. The starting set is used until it is resolved.', conflict);
    }
    const first = doc.errors[0];
    const line = first.linePos?.[0]?.line;
    const reason = first.message.split('\n')[0];
    return invalid(`The file is not valid YAML (${reason}). The starting set is used until it is fixed.`, line);
  }

  const reader = new Reader(aliasTargets(doc), lines, maxNodes, maxChars);
  try {
    const root = reader.deref(doc.contents);
    if (root === null || root === undefined || (isScalar(root) && (root.value === null || root.value === undefined))) {
      return { list: startingSet(), problems: [] };
    }
    if (!isMap(root)) {
      return invalid('The file must be a map with tables: and columns: lists. The starting set is used until it is fixed.', reader.line(root));
    }
    readVersion(reader, root);
    const list = startingSet();
    for (const scope of ['table', 'column'] as const) {
      const name = SECTION_NAMES[scope];
      const node = reader.get(root, name);
      if (node === undefined) continue;
      const value = reader.deref(node);
      const empty = value === null || (isScalar(value) && (value.value === null || value.value === undefined));
      if (empty) {
        list[scope === 'table' ? 'tables' : 'columns'] = [];
      } else if (isSeq(value)) {
        list[scope === 'table' ? 'tables' : 'columns'] = readSection(reader, value, scope);
      } else {
        reader.problem('fieldsSectionInvalid', 'error', node,
          `${name}: must be a list of fields. The starting set's ${name} are used until it is fixed.`);
      }
    }
    const leftOut = reader.get(root, LEFT_OUT);
    if (leftOut !== undefined) list.leftOut = readLeftOut(reader, leftOut);
    return { list, problems: reader.problems };
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      return invalid(`The file is too large to read (it expands to more than ${err.limit} ${err.what}). The starting set is used.`);
    }
    throw err;
  }
}

/**
 * A field list as fields.yml text, which {@link parseFieldsText} reads back
 * as the same list: a built-in as its bare name (or with only its changed
 * label, guidance and filled_by), a team field with every property that is
 * not the default. For a host that shows a project its field list (the
 * starting set) as a file before one exists.
 */
export function renderFieldsText(list: FieldList): string {
  const section = (defs: readonly FieldDefinition[], scope: FieldScope): unknown[] =>
    defs.map((def) => {
      const builtin = def.scope === scope ? builtInField(def.key, scope) : undefined;
      if (builtin) {
        const entry: Record<string, unknown> = { key: def.key };
        if (def.label !== builtin.label) entry.label = def.label;
        if (def.guidance !== undefined && def.guidance !== builtin.guidance) entry.guidance = def.guidance;
        if (def.filledBy !== builtin.filledBy) entry.filled_by = def.filledBy;
        return Object.keys(entry).length === 1 ? def.key : entry;
      }
      const entry: Record<string, unknown> = { key: def.key };
      if (def.label !== def.key) entry.label = def.label;
      if (def.type !== 'text') entry.type = def.type;
      if (def.type === 'choice' && def.values) entry.values = [...def.values];
      if (def.guidance !== undefined) entry.guidance = def.guidance;
      if (def.filledBy !== 'anyone') entry.filled_by = def.filledBy;
      if (def.showFor !== 'all') entry.show_for = def.showFor;
      return entry;
    });
  const data: Record<string, unknown> = {
    version: FIELDS_FILE_VERSION,
    tables: section(list.tables, 'table'),
    columns: section(list.columns, 'column'),
  };
  if (list.leftOut.length > 0) data[LEFT_OUT] = [...list.leftOut];
  const doc = new Document(data);
  visit(doc, {
    Pair: (_key, pair) => {
      const name = isScalar(pair.key) ? pair.key.value : undefined;
      if ((name === 'values' || name === LEFT_OUT) && isSeq(pair.value)) pair.value.flow = true;
    },
  });
  doc.commentBefore =
    ' The fields this project records on tables and on columns, in the order the\n' +
    ' Detail panel shows them. A bare name is a built-in field as ERD Studio ships\n' +
    ' it; "- key: …" is a built-in in your own words, or a field of your own.';
  return doc.toString({ flowCollectionPadding: false });
}
