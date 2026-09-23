/**
 * Logical model YAML text -> SemanticModel.
 *
 * Model files live at `.erd-studio/logical-models/{model_name}.yml`. Reading
 * them (and caching, and deciding what a read failure means) is the host's
 * job; turning the text into a model is done here so every host reads the
 * same file the same way.
 */

import { parseDocument, isAlias, isMap, isScalar, isSeq, visit } from 'yaml';
import type { Alias, Document } from 'yaml';

import type { ColumnDef, SemanticModel } from './types/semantic.js';
import { checkLimit } from './limits.js';

/** Name of the model directory under the semantic dir (`.erd-studio/logical-models/`). */
export const LOGICAL_MODELS_DIR = 'logical-models';

/** Rationale keys ERD Studio reads from (and writes to) a model file. */
export const RATIONALE_KEYS = ['purpose', 'design', 'grainChoice', 'roleChoice', 'scdStrategy', 'measures'] as const;

/**
 * A model file expands to more YAML nodes than the caller allows.
 *
 * Anchors and aliases let a few hundred bytes describe an exponentially large
 * document (the "billion laughs" shape). Hosts that read files they do not
 * trust pass `maxNodes` to `parseLogicalModelText` and get this error instead
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

export interface ParseLogicalModelOptions {
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
}

/**
 * Shape of a model as stored in YAML.
 * Matches SemanticModel but with explicit field types for YAML serialization.
 */
interface YamlModel {
  name: string;
  schema?: string;
  description?: string;
  grain?: string;
  modelRole?: string;
  rationale?: Record<string, string>;
  columns?: YamlColumn[];
}

interface YamlColumn {
  name: string;
  dataType: string;
  description?: string;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  isNaturalKey?: boolean;
  scdType?: number;
  additiveType?: string;
}

/** Per-document state threaded through `toPlain`. */
interface ToPlainState {
  /** What each alias in the document refers to; see `aliasTargets`. */
  readonly aliases: ReadonlyMap<Alias, unknown>;
  remaining: number;
  readonly maxNodes: number;
  /** Characters of scalar text still allowed; see `ParseLogicalModelOptions.maxChars`. */
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
 * model with no `name`. Throws on YAML syntax errors (the first error yaml
 * reports), `YamlNodeLimitError` when `maxNodes` is set and exceeded, and
 * `YamlCharLimitError` when `maxChars` is. A limit that is not a number of at
 * least 0 (or Infinity) throws a TypeError.
 * `fallbackName` names the model when its `name` is not a usable string.
 */
export function parseLogicalModelText(
  text: string,
  fallbackName: string,
  opts: ParseLogicalModelOptions = {},
): SemanticModel | null {
  const { maxNodes = Infinity, maxChars = Infinity } = opts;
  checkLimit('parseLogicalModelText', 'maxNodes', maxNodes);
  checkLimit('parseLogicalModelText', 'maxChars', maxChars);
  const raw = parseModelFile(text, maxNodes, maxChars);
  if (!raw || raw.name === undefined || raw.name === null || raw.name === '') {
    return null;
  }
  return yamlToModel(raw, fallbackName);
}

/**
 * Whether a model name can be used as a file name under `logical-models/`:
 * a non-blank string with no path separators and no `..`.
 */
export function isSafeModelName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.trim() !== '' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..')
  );
}

/**
 * Parse a model file into a plain object without scalar coercion.
 *
 * The `yaml` package resolves `007` to `7` and (under a `%YAML 1.1`
 * directive) `2024-01-01` to a Date. Model fields are strings by contract,
 * so every non-string scalar is read back from its original source text
 * instead of its resolved value. Booleans and nulls are kept as-is.
 * Returns null for an empty file or a file whose root is not a mapping.
 * Throws on YAML syntax errors.
 */
function parseModelFile(content: string, maxNodes: number, maxChars: number): YamlModel | null {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    throw doc.errors[0];
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
    return null;
  }
  return raw as YamlModel;
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
      obj[String(toPlain(doc, pair.key, state))] = toPlain(doc, pair.value, state);
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
  return node ?? null;
}

/** Resolved value for strings/booleans/null; original source text for anything else. */
function scalarValue(node: { value: unknown; source?: string }): unknown {
  const v = node.value;
  if (typeof v === 'string' || typeof v === 'boolean' || v === null || v === undefined) {
    return v ?? null;
  }
  return node.source ?? String(v);
}

function yamlToModel(raw: YamlModel, fallbackName: string): SemanticModel {
  const str = (v: unknown): string | undefined =>
    v === undefined || v === null ? undefined : String(v);
  const bool = (v: unknown): boolean =>
    v === true || (typeof v === 'string' && /^(true|yes|on)$/i.test(v.trim()));

  const model: SemanticModel = {
    name: str(raw.name) || fallbackName,
  };

  const schema = str(raw.schema);
  const description = str(raw.description);
  const grain = str(raw.grain);
  const modelRole = str(raw.modelRole);
  if (schema) model.schema = schema;
  if (description) model.description = description;
  if (grain) model.grain = grain;
  if (modelRole) model.modelRole = modelRole as SemanticModel['modelRole'];
  if (raw.rationale && typeof raw.rationale === 'object') {
    model.rationale = {};
    for (const key of RATIONALE_KEYS) {
      const value = str((raw.rationale as Record<string, unknown>)[key]);
      if (value) model.rationale[key] = value;
    }
  }

  if (raw.columns && Array.isArray(raw.columns)) {
    model.columns = raw.columns
      .filter((col): col is YamlColumn => !!col && typeof col === 'object')
      .map((col) => {
        const column: ColumnDef = {
          name: str(col.name) ?? '',
          dataType: str(col.dataType) ?? 'unknown',
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
        return column;
      });
  }

  return model;
}
