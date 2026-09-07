/**
 * Runtime validation for webview → extension message payloads.
 *
 * The message types in src/types/messages.ts are compile-time only. The
 * webview bundle and the extension host can drift across updates, and the
 * host writes payload values straight into domain JSON / model YAML files,
 * so every value that ends up on disk is checked here first.
 *
 * All functions are pure and return either `null` (valid) or an error string,
 * or act as type guards — no vscode imports so they are trivially testable.
 */

import type { Cardinality, ColumnDef, ModelRole, Stage } from '../types/semantic';
import { COLUMN_NAME_PATTERN, MODEL_NAME_PATTERN, MODEL_NAME_RULE, findDuplicateNames } from '../types/naming';

// ---------------------------------------------------------------------------
// Model names
// ---------------------------------------------------------------------------

/**
 * Path-safety check for a model name, independent of authoring style.
 *
 * A model name becomes a file name under `logical-models/`, so anything that
 * could resolve outside that directory — path separators, `..`, an absolute
 * path, a Windows drive prefix, a NUL byte — is rejected. Nothing else is:
 * names that come from the user's own dbt project (Add Existing Model) are
 * whatever dbt allows, including uppercase and digit-leading names.
 */
export function validateModelNameSafety(name: unknown): string | null {
  if (typeof name !== 'string') {
    return 'Model name is required.';
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Model name cannot be empty.';
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return 'Model name cannot contain path separators.';
  }
  if (trimmed.includes('\0') || /^[A-Za-z]:/.test(trimmed) || trimmed === '.') {
    return 'Model name cannot be a file system path.';
  }
  return null;
}

/**
 * Validate a model name the user authored (New Model dialog, rename). On top
 * of {@link validateModelNameSafety} this enforces the project's naming
 * convention (`[a-z][a-z0-9_]*`) so newly created models stay consistent.
 *
 * Do NOT use this for names discovered in the dbt project — see
 * {@link validateModelNameSafety}.
 */
export function validateModelName(name: unknown): string | null {
  const safetyError = validateModelNameSafety(name);
  if (safetyError) {
    return safetyError;
  }
  if (!MODEL_NAME_PATTERN.test((name as string).trim())) {
    return MODEL_NAME_RULE;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** Validate a single column definition (name + data type). */
export function validateColumnDef(column: unknown): string | null {
  if (typeof column !== 'object' || column === null) {
    return 'Column definition is required';
  }
  const col = column as Partial<ColumnDef>;
  const trimmedName = typeof col.name === 'string' ? col.name.trim() : '';
  if (!trimmedName) {
    return 'Column name is required';
  }
  if (!COLUMN_NAME_PATTERN.test(trimmedName)) {
    return 'Column name must use lowercase letters, numbers, and underscores';
  }
  if (typeof col.dataType !== 'string' || !col.dataType.trim()) {
    return 'Data type is required';
  }
  return null;
}

/**
 * Validate a list of column definitions: each must pass `validateColumnDef`
 * and names must be unique within the list.
 */
export function validateColumnDefs(columns: unknown): string | null {
  if (!Array.isArray(columns)) {
    return 'Columns must be a list.';
  }
  const seen = new Set<string>();
  for (const column of columns) {
    const error = validateColumnDef(column);
    if (error) {
      return error;
    }
    const name = (column as ColumnDef).name.trim();
    if (seen.has(name)) {
      return `Duplicate column name "${name}".`;
    }
    seen.add(name);
  }
  return null;
}

export { findDuplicateNames };

// ---------------------------------------------------------------------------
// Enumerated values
// ---------------------------------------------------------------------------

export const CARDINALITIES: readonly Cardinality[] = [
  'many-to-one',
  'one-to-one',
  'one-to-many',
  'many-to-many',
];

export function isValidCardinality(value: unknown): value is Cardinality {
  return typeof value === 'string' && (CARDINALITIES as readonly string[]).includes(value);
}

export const MODEL_ROLES: readonly ModelRole[] = [
  'conformed-dim',
  'domain-dim',
  'transaction-fact',
  'periodic-snapshot',
  'accumulating-snapshot',
  'factless-fact',
  'reference',
  'gold-fact',
  'gold-dim',
];

export function isValidModelRole(value: unknown): value is ModelRole {
  return typeof value === 'string' && (MODEL_ROLES as readonly string[]).includes(value);
}

export type KeyType = 'PK' | 'FK' | 'NK';

export const KEY_TYPES: readonly KeyType[] = ['PK', 'FK', 'NK'];

export function isValidKeyType(value: unknown): value is KeyType {
  return typeof value === 'string' && (KEY_TYPES as readonly string[]).includes(value);
}

export function isValidStage(value: unknown): value is Stage {
  return value === 'logical' || value === 'physical';
}

// ---------------------------------------------------------------------------
// Numbers / positions
// ---------------------------------------------------------------------------

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate an `{ x, y }` point with finite numeric coordinates. */
export function validatePoint(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return 'Position must be an object with x and y.';
  }
  const point = value as { x?: unknown; y?: unknown };
  if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) {
    return 'Position coordinates must be finite numbers.';
  }
  return null;
}

/**
 * Validate a `Record<modelName, { x, y }>` positions map as sent by
 * `updatePositions`. Keys must be non-empty strings; values finite points.
 */
export function validatePositions(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Positions must be a map of model name to { x, y }.';
  }
  for (const [name, point] of Object.entries(value as Record<string, unknown>)) {
    if (!name.trim()) {
      return 'Position keys must be non-empty model names.';
    }
    const error = validatePoint(point);
    if (error) {
      return `Position for "${name}" is invalid: ${error}`;
    }
  }
  return null;
}

export interface AnnotationPositionPayload {
  id: string;
  x: number;
  y: number;
}

/**
 * Validate the optional `annotations` list carried by `updatePositions`
 * (`[{ id, x, y }]`). Returns the validated list (empty when absent) or an
 * error string. Ids must be non-empty strings; coordinates finite numbers.
 */
export function validateAnnotationPositions(value: unknown): AnnotationPositionPayload[] | string {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return 'Annotation positions must be a list of { id, x, y }.';
  }
  const result: AnnotationPositionPayload[] = [];
  for (const entry of value) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id.trim()) {
      return 'Annotation position ids must be non-empty strings.';
    }
    const error = validatePoint(entry);
    if (error) {
      return `Position for annotation "${id}" is invalid: ${error}`;
    }
    const point = entry as { x: number; y: number };
    result.push({ id, x: point.x, y: point.y });
  }
  return result;
}

/**
 * Validate an `updateAnnotation` payload. The id addresses an existing note,
 * and every optional field is written straight into `viewConfig.annotations`,
 * so a non-finite width/height (which would serialise as `null` in the domain
 * JSON) or a non-string id/text/colour is rejected here.
 */
export function validateAnnotationUpdate(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Annotation update must be an object.';
  }
  const payload = value as {
    id?: unknown;
    text?: unknown;
    color?: unknown;
    linkedModel?: unknown;
    width?: unknown;
    height?: unknown;
  };
  if (typeof payload.id !== 'string' || !payload.id.trim()) {
    return 'Annotation id must be a non-empty string.';
  }
  if (payload.text !== undefined && typeof payload.text !== 'string') {
    return 'Annotation text must be a string.';
  }
  if (payload.color !== undefined && typeof payload.color !== 'string') {
    return 'Annotation colour must be a string.';
  }
  if (
    payload.linkedModel !== undefined &&
    payload.linkedModel !== null &&
    typeof payload.linkedModel !== 'string'
  ) {
    return 'Annotation linked model must be a model name or null.';
  }
  for (const key of ['width', 'height'] as const) {
    const size = payload[key];
    if (size !== undefined && !isFiniteNumber(size)) {
      return `Annotation ${key} must be a finite number.`;
    }
  }
  return null;
}
