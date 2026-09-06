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
 * Validate a model name. The name is used as a file name under
 * `logical-models/`, so path separators, `..`, and leading digits are rejected
 * (the pattern only admits `[a-z][a-z0-9_]*`, but the explicit checks give a
 * clearer error and guard against future pattern loosening).
 */
export function validateModelName(name: unknown): string | null {
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
  if (!MODEL_NAME_PATTERN.test(trimmed)) {
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
