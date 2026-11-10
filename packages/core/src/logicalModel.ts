/**
 * Logical model YAML text -> SemanticTable.
 *
 * Model files live at `.erd-studio/logical-models/{model_name}.yml`. Reading
 * them (and caching, and deciding what a read failure means) is the host's
 * job; turning the text into a model is done here so every host reads the
 * same file the same way.
 */

import { parseDocument, isAlias, isMap, isNode, isPair, isScalar, isSeq, visit } from 'yaml';
import type { Alias, Document, Node, Pair } from 'yaml';

import type { Cardinality, ColumnDef, TableLoadWarning, TableRelationship, TableWithLoadWarning, SemanticTable } from './types/semantic.js';
import { readMeta } from './meta.js';
import { checkLimit } from './limits.js';
import { normaliseCompositeKey, normaliseRelationshipRole } from './relationships.js';
import { findConflictMarkers } from './mergeConflict.js';
import { RATIONALE_FIELD_KEYS } from './fields.js';

/** Name of the model directory under the semantic dir (`.erd-studio/logical-models/`). */
export const LOGICAL_MODELS_DIR = 'logical-models';

/**
 * The v6 name of the table library (`.erd-studio/tables/`, #162). Read
 * alongside `logical-models/`, which is searched first; a project that
 * writes the v6 naming creates its table files here (#182). A project made before v6 may have a layer called `tables`, so a
 * host that can list directories checks before treating it as the library.
 */
export const TABLES_DIR = 'tables';

/** The library folders, in the order a table name is looked up. */
export const TABLE_LIBRARY_DIRS: readonly string[] = [LOGICAL_MODELS_DIR, TABLES_DIR];

/**
 * Legacy: the six rationale keys of the releases before context fields, kept
 * exported (and unchanged) for hosts that list them. A model file's
 * `rationale:` map is read for every catalogue rationale key,
 * `RATIONALE_FIELD_KEYS` (`fields.ts`), which starts with these six in this
 * relative order.
 */
export const RATIONALE_KEYS = ['purpose', 'design', 'grainChoice', 'roleChoice', 'scdStrategy', 'measures'] as const;

/**
 * A model file expands to more YAML nodes than the caller allows.
 *
 * Anchors and aliases let a few hundred bytes describe an exponentially large
 * document (the "billion laughs" shape). Hosts that read files they do not
 * trust pass `maxNodes` to `parseTableText` and get this error instead
 * of an unbounded expansion.
 */
export class YamlNodeLimitError extends Error {
  constructor(readonly maxNodes: number) {
    super(`YAML document expands to more than ${maxNodes} nodes`);
    this.name = 'YamlNodeLimitError';
  }
}

/**
 * A model file's text expands to more characters than the caller allows.
 *
 * Aliases let one long scalar appear many times in the parsed model at the
 * cost of a few bytes each, so a small file can expand to a very large one
 * while staying well inside a node budget. `maxChars` bounds that.
 */
export class YamlCharLimitError extends Error {
  constructor(readonly maxChars: number) {
    super(`YAML document expands to more than ${maxChars} characters of text`);
    this.name = 'YamlCharLimitError';
  }
}

/**
 * A model file that does not parse because it holds unresolved git merge
 * conflicts (#145). `line` is the first `<<<<<<<`, not where the YAML parser
 * happened to stop; `classifyTableLoadError` turns it into a `TableLoadError`
 * with `mergeConflict` set. Not exported from the package: hosts see the flag.
 */
export class TableMergeConflictError extends Error {
  readonly mergeConflict = true;

  constructor(readonly line: number, yamlError: unknown) {
    super(`Unresolved git merge conflict (first at line ${line})`);
    this.name = 'TableMergeConflictError';
    // As `new Error(message, { cause })` sets it (that form needs ES2022 lib typings).
    Object.defineProperty(this, 'cause', { value: yamlError, writable: true, configurable: true });
  }
}

export interface ParseTableOptions {
  /**
   * Most YAML nodes (map keys and values, sequence items, scalars, aliases
   * followed) the document may expand to. Unlimited by default.
   */
  maxNodes?: number;
  /**
   * Most characters of scalar text (keys and values, counted again each time
   * an alias repeats them) the document may expand to. Without aliases this
   * is never more than the length of the file. Unlimited by default.
   */
  maxChars?: number;
  /**
   * What a key written twice in one block does (#164). `'error'` (the
   * default) throws yaml's `DUPLICATE_KEY` error like any other. `'last'`
   * reads the file the way dbt's PyYAML does — the last copy wins — and puts
   * a {@link TableLoadWarning} on the model as `loadWarning`. Only a file whose
   * every error is a duplicate key is read; anything else still throws.
   */
  duplicateKeys?: 'error' | 'last';
}

/**
 * Shape of a model as stored in YAML.
 * Matches SemanticTable but with explicit field types for YAML serialization.
 */
interface YamlTable {
  name: string;
  schema?: string;
  alias?: string;
  description?: string;
  grain?: string;
  modelRole?: string;
  /** The v6 name of `modelRole` (#162); wins when both are written. */
  tableRole?: string;
  rationale?: Record<string, string>;
  meta?: unknown;
  columns?: YamlColumn[];
  relationships?: unknown;
}

interface YamlColumn {
  name: string;
  dataType: string;
  /**
   * dbt's spelling of `dataType` (a schema.yml column's `data_type:`), read as
   * an alias (#144). `dataType` wins whenever it holds a value; the extension
   * renames the key `dataType` the next time it writes this model's file.
   */
  data_type?: unknown;
  description?: string;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  isNaturalKey?: boolean;
  scdType?: number;
  additiveType?: string;
  meta?: unknown;
}

/** Per-document state threaded through `toPlain`. */
interface ToPlainState {
  /** What each alias in the document refers to; see `aliasTargets`. */
  readonly aliases: ReadonlyMap<Alias, unknown>;
  remaining: number;
  readonly maxNodes: number;
  /** Characters of scalar text still allowed; see `ParseTableOptions.maxChars`. */
  remainingChars: number;
  readonly maxChars: number;
}

/**
 * Resolve every alias in a document in one pass.
 *
 * `Alias.resolve(doc)` finds "the last node carrying the alias's anchor that
 * comes before the alias" in a pre-order `visit` of the document, but it
 * scans from the start of the document on every call, so a file with many
 * aliases costs quadratic time. This makes the same pre-order `visit` once,
 * remembering the latest node for each anchor name, and records each alias's
 * target as it is reached: the same answer, in linear time.
 */
function aliasTargets(doc: Document): Map<Alias, unknown> {
  const latest = new Map<string, unknown>();
  const targets = new Map<Alias, unknown>();
  visit(doc, {
    Node: (_key, node) => {
      if (isAlias(node)) {
        targets.set(node, latest.get(node.source));
      } else if (node.anchor) {
        latest.set(node.anchor, node);
      }
    },
  });
  return targets;
}

/**
 * Parse the text of a logical model file.
 *
 * Returns null for an empty file, a file whose root is not a mapping, or a
 * model with no `name`. Throws on YAML syntax errors: the first error yaml
 * reports, except that text holding unresolved git merge conflicts throws an
 * Error named `TableMergeConflictError` instead, with `mergeConflict: true`,
 * `line` (the 1-based line of the first `<<<<<<<`) and yaml's error as its
 * `cause` — `classifyTableLoadError` turns it into a `loadError` with
 * `mergeConflict` set. Also throws `YamlNodeLimitError` when `maxNodes` is
 * set and exceeded, and `YamlCharLimitError` when `maxChars` is. A limit that
 * is not a number of at least 0 (or Infinity) throws a TypeError.
 * `fallbackName` names the model when its `name` is not a usable string.
 */
export function parseTableText(
  text: string,
  fallbackName: string,
  opts: ParseTableOptions = {},
): SemanticTable | null {
  return parseTableTextWithUsage(text, fallbackName, opts).model;
}

/** What a parse of a model file used of its budgets; see {@link parseTableTextWithUsage}. */
export interface TableParse {
  model: SemanticTable | null;
  /** YAML nodes the document expanded to, or 0 when `maxNodes` was unlimited (nothing is counted then). */
  nodes: number;
  /** Characters of scalar text it expanded to, or 0 when `maxChars` was unlimited. */
  chars: number;
}

/**
 * `parseTableText`, also reporting how much of each finite budget the
 * document used, so a caller that repeats the model can charge every repeat.
 * Not part of the package's public API.
 */
export function parseTableTextWithUsage(
  text: string,
  fallbackName: string,
  opts: ParseTableOptions = {},
): TableParse {
  const { maxNodes = Infinity, maxChars = Infinity, duplicateKeys = 'error' } = opts;
  checkLimit('parseTableText', 'maxNodes', maxNodes);
  checkLimit('parseTableText', 'maxChars', maxChars);
  const { raw, state, loadWarning } = parseTableFile(text, maxNodes, maxChars, duplicateKeys === 'last');
  const nodes = maxNodes === Infinity ? 0 : maxNodes - state.remaining;
  const chars = maxChars === Infinity ? 0 : maxChars - state.remainingChars;
  if (!raw || raw.name === undefined || raw.name === null || raw.name === '') {
    return { model: null, nodes, chars };
  }
  const model = yamlToTable(raw, fallbackName);
  if (loadWarning) {
    (model as TableWithLoadWarning).loadWarning = loadWarning;
  }
  return { model, nodes, chars };
}

/**
 * A model alias (the warehouse table name): an unquoted SQL identifier. Case
 * is kept as written — `Date` and `date` are both fine — because some
 * warehouses show it, and dbt passes the alias through unchanged.
 */
const TABLE_ALIAS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Longest alias accepted (Snowflake and Postgres cap identifiers well below common limits). */
export const TABLE_ALIAS_MAX_LENGTH = 128;

/** Human-readable statement of the alias rule (used in error messages). */
export const TABLE_ALIAS_RULE =
  'A warehouse name must start with a letter or underscore and use only letters, numbers and underscores.';

/** Whether `alias` is a usable table name for a model's `alias`. */
export function isValidTableAlias(alias: unknown): alias is string {
  return typeof alias === 'string' && alias.length <= TABLE_ALIAS_MAX_LENGTH && TABLE_ALIAS_PATTERN.test(alias);
}

/** A C0 control character (NUL included) or DEL. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Whether a model name can be used as a file name under `logical-models/`:
 * a non-blank string with no path separators, no `..` and no control
 * characters (a NUL makes most file APIs throw rather than miss).
 */
export function isSafeTableName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.trim() !== '' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    !CONTROL_CHARACTER.test(name)
  );
}

/**
 * Parse a model file into a plain object without scalar coercion.
 *
 * The `yaml` package resolves `007` to `7` and (under a `%YAML 1.1`
 * directive) `2024-01-01` to a Date. Model fields are strings by contract,
 * so every non-string scalar is read back from its original source text
 * instead of its resolved value. Booleans and nulls are kept as-is.
 * `raw` is null for an empty file or a file whose root is not a mapping;
 * `state` holds what is left of the budgets. Throws on YAML syntax errors —
 * a `TableMergeConflictError` when the text holds git conflict markers.
 */
function parseTableFile(
  content: string,
  maxNodes: number,
  maxChars: number,
  lastDuplicateWins: boolean,
): { raw: YamlTable | null; state: ToPlainState; loadWarning?: TableLoadWarning } {
  let doc = parseDocument(content);
  let loadWarning: TableLoadWarning | undefined;
  if (doc.errors.length > 0) {
    // Checked only once the parse has failed: a marker-like line inside a
    // block scalar that parses is the user's text, not a conflict.
    const conflictLine = findConflictMarkers(content);
    if (conflictLine !== null) {
      throw new TableMergeConflictError(conflictLine, doc.errors[0]);
    }
    const firstError = doc.errors[0];
    if (!lastDuplicateWins || !doc.errors.every((e) => e.code === 'DUPLICATE_KEY')) {
      throw firstError;
    }
    // Read it as PyYAML does: a later pair overwrites an earlier one in toPlain.
    doc = parseDocument(content, { uniqueKeys: false });
    if (doc.errors.length > 0) {
      throw firstError;
    }
    loadWarning = firstDuplicateKey(doc, content) ?? {
      kind: 'yamlDuplicateKey',
      key: '',
      line: firstError.linePos?.[0]?.line ?? 1,
    };
  }
  const state: ToPlainState = {
    aliases: aliasTargets(doc),
    remaining: maxNodes,
    maxNodes,
    remainingChars: maxChars,
    maxChars,
  };
  const raw = toPlain(doc, doc.contents, state);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { raw: null, state };
  }
  return { raw: raw as YamlTable, state, ...(loadWarning ? { loadWarning } : {}) };
}

/**
 * The key written twice that comes first in the file, with the line of its
 * later copy (the one whose value is read), or null when there is none. Keys
 * are compared as yaml compares scalars: by their resolved text.
 */
function firstDuplicateKey(doc: Document, content: string): TableLoadWarning | null {
  let found: { key: string; offset: number } | null = null;
  visit(doc, {
    Map: (_key, map) => {
      const seen = new Set<string>();
      for (const pair of map.items) {
        const keyNode = pair.key;
        const key = isScalar(keyNode) ? String(keyNode.value) : String(keyNode);
        if (seen.has(key)) {
          const offset = isNode(keyNode) && keyNode.range ? keyNode.range[0] : Infinity;
          if (found === null || offset < found.offset) {
            found = { key, offset };
          }
        }
        seen.add(key);
      }
    },
  });
  if (found === null) {
    return null;
  }
  const { key, offset } = found as { key: string; offset: number };
  const line = offset === Infinity ? 1 : content.slice(0, offset).split('\n').length;
  return { kind: 'yamlDuplicateKey', key, line };
}

/** Convert a node tree to plain JS, preserving scalar source text for non-string values. */
function toPlain(doc: Document, node: unknown, state: ToPlainState): unknown {
  if (--state.remaining < 0) {
    throw new YamlNodeLimitError(state.maxNodes);
  }
  if (isAlias(node)) {
    const target = state.aliases.has(node) ? state.aliases.get(node) : node.resolve(doc);
    return toPlain(doc, target, state);
  }
  if (isMap(node)) {
    const obj: Record<string, unknown> = {};
    for (const pair of node.items) {
      // defineProperty, not assignment: a key named `__proto__` is data here.
      Object.defineProperty(obj, String(toPlain(doc, pair.key, state)), {
        value: toPlain(doc, pair.value, state), enumerable: true, writable: true, configurable: true,
      });
    }
    return obj;
  }
  if (isSeq(node)) {
    return node.items.map((item) => toPlain(doc, item, state));
  }
  if (isScalar(node)) {
    const value = scalarValue(node);
    if (typeof value === 'string' && (state.remainingChars -= value.length) < 0) {
      throw new YamlCharLimitError(state.maxChars);
    }
    return value;
  }
  if (isPair(node)) {
    chargePair(node, state);
    return node;
  }
  return node ?? null;
}

/**
 * Charge a raw pair to the budgets each time it is reached.
 *
 * `!!pairs` and `!!omap` sequences hold raw `Pair`s rather than nodes. They
 * are kept as they are, as the extension always has kept them, and the model
 * reads one back through `String()`, which is `JSON.stringify` of the pair's
 * whole subtree. An alias to such a sequence would otherwise cost one node
 * however large that text is, so a small file could expand without bound.
 * With a budget set, every node under the pair counts against `maxNodes`
 * (first, so the text below is only made for a subtree that fits), and the
 * text `String()` makes of it against `maxChars`. With no budget nothing is
 * counted or made, and the result is the same either way.
 */
function chargePair(pair: Pair, state: ToPlainState): void {
  if (state.maxNodes !== Infinity) {
    const count = (): void => {
      if (--state.remaining < 0) {
        throw new YamlNodeLimitError(state.maxNodes);
      }
    };
    visit(pair.key as Node | null, { Node: count });
    visit(pair.value as Node | null, { Node: count });
  }
  if (state.maxChars !== Infinity && (state.remainingChars -= String(pair).length) < 0) {
    throw new YamlCharLimitError(state.maxChars);
  }
}

/** Resolved value for strings/booleans/null; original source text for anything else. */
function scalarValue(node: { value: unknown; source?: string }): unknown {
  const v = node.value;
  if (typeof v === 'string' || typeof v === 'boolean' || v === null || v === undefined) {
    return v ?? null;
  }
  return node.source ?? String(v);
}

function yamlToTable(raw: YamlTable, fallbackName: string): SemanticTable {
  const str = (v: unknown): string | undefined =>
    v === undefined || v === null ? undefined : String(v);
  const bool = (v: unknown): boolean =>
    v === true || (typeof v === 'string' && /^(true|yes|on)$/i.test(v.trim()));

  const model: SemanticTable = {
    name: str(raw.name) || fallbackName,
  };

  const schema = str(raw.schema);
  const alias = str(raw.alias)?.trim();
  const description = str(raw.description);
  const grain = str(raw.grain);
  // The v6 name wins only when it holds text: a stray non-string never hides a valid `modelRole`.
  const modelRole = str(typeof raw.tableRole === 'string' ? raw.tableRole : raw.modelRole);
  if (schema) model.schema = schema;
  if (alias) model.alias = alias;
  if (description) model.description = description;
  if (grain) model.grain = grain;
  if (modelRole) model.modelRole = modelRole as SemanticTable['modelRole'];
  if (raw.rationale && typeof raw.rationale === 'object') {
    model.rationale = {};
    // Every catalogue rationale key, camelCase only (`openQuestions`; a
    // snake_case `open_questions:` is not the field). Other keys are not read.
    for (const key of RATIONALE_FIELD_KEYS) {
      const value = str((raw.rationale as Record<string, unknown>)[key]);
      if (value) model.rationale[key] = value;
    }
  }
  const meta = readMeta(raw.meta);
  if (meta) model.meta = meta;

  if (raw.columns && Array.isArray(raw.columns)) {
    model.columns = raw.columns
      .filter((col): col is YamlColumn => !!col && typeof col === 'object')
      .map((col) => {
        const column: ColumnDef = {
          name: str(col.name) ?? '',
          // `dataType` holding any value (even '') wins; an absent or null
          // `dataType` falls back to dbt's `data_type` before the default (#144).
          dataType: str(col.dataType) ?? str(col.data_type) ?? 'unknown',
          description: str(col.description) ?? '',
        };
        if (bool(col.isPrimaryKey)) column.isPrimaryKey = true;
        if (bool(col.isForeignKey)) column.isForeignKey = true;
        if (bool(col.isNaturalKey)) column.isNaturalKey = true;
        if (col.scdType !== undefined && col.scdType !== null) {
          const scdType = Number(col.scdType);
          if (Number.isFinite(scdType)) column.scdType = scdType as ColumnDef['scdType'];
        }
        const additiveType = str(col.additiveType);
        if (additiveType) column.additiveType = additiveType as ColumnDef['additiveType'];
        const columnMeta = readMeta(col.meta);
        if (columnMeta) column.meta = columnMeta;
        return column;
      });
  }

  const relationships = readRelationships(raw.relationships);
  if (relationships.length > 0) model.relationships = relationships;

  return model;
}

const CARDINALITIES: ReadonlySet<string> = new Set<Cardinality>(['many-to-one', 'one-to-one', 'one-to-many', 'many-to-many']);

/**
 * A model file's `relationships:` list (issue #126). An entry without the three
 * string endpoints is skipped; an unrecognised cardinality reads as
 * many-to-one, as it does in a domain file.
 */
function readRelationships(value: unknown): TableRelationship[] {
  if (!Array.isArray(value)) return [];
  const relationships: TableRelationship[] = [];
  for (const entry of value) {
    const r = entry as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    // `toTable` is the v6 name of `toModel` (#162), and wins when both are written.
    const { fromColumn, toColumn, cardinality } = r;
    const toModel = typeof r.toTable === 'string' ? r.toTable : r.toModel;
    if (typeof fromColumn !== 'string' || typeof toModel !== 'string' || typeof toColumn !== 'string') continue;
    if (!fromColumn || !toModel || !toColumn) continue;
    const role = normaliseRelationshipRole(r.role);
    const compositeKey = normaliseCompositeKey(r.compositeKey);
    relationships.push({
      fromColumn,
      toModel,
      toColumn,
      cardinality: typeof cardinality === 'string' && CARDINALITIES.has(cardinality)
        ? cardinality as Cardinality
        : 'many-to-one',
      ...(role ? { role } : {}),
      ...(compositeKey ? { compositeKey } : {}),
    });
  }
  return relationships;
}
