/**
 * Types for the sync reconciliation plan.
 *
 * The extension generates a `.sync-plan.json` file containing user-approved
 * actions to reconcile logical and physical models.  An AI coding skill
 * (Claude, Copilot, etc.) reads this file and executes the changes.
 */

import type { Cardinality, Stage } from './semantic';

// ---------------------------------------------------------------------------
// Ground truth selection
// ---------------------------------------------------------------------------

/** Which stage the user considers authoritative for a given discrepancy. */
export type GroundTruth = 'logical' | 'physical';

// ---------------------------------------------------------------------------
// Selection keys  (used in the webview to track per-item choices)
// ---------------------------------------------------------------------------

/**
 * Build a selection key for a discrepancy item.
 * Keys are deterministic strings used as Map keys in the Zustand store.
 */
export function modelKey(modelName: string): string {
  return `model:${modelName}`;
}

export function columnKey(modelName: string, columnName: string): string {
  return `col:${modelName}:${columnName}`;
}

export function relationshipKey(
  fromModel: string,
  fromColumn: string,
  toModel: string,
  toColumn: string,
): string {
  return `rel:${fromModel}:${fromColumn}:${toModel}:${toColumn}`;
}

// ---------------------------------------------------------------------------
// Resolution types  (one per discrepancy that the user resolved)
// ---------------------------------------------------------------------------

export type ModelAction =
  | 'add-to-logical'
  | 'remove-from-logical'
  | 'add-to-physical'
  | 'remove-from-physical';

export interface ModelResolution {
  modelName: string;
  discrepancyStatus: 'extra' | 'missing';
  groundTruth: GroundTruth;
  action: ModelAction;
}

export type ColumnAction =
  | 'add-column-to-logical'
  | 'remove-column-from-logical'
  | 'add-column-to-physical'
  | 'remove-column-from-physical'
  | 'update-type-in-logical'
  | 'update-type-in-physical';

export interface ColumnResolution {
  modelName: string;
  columnName: string;
  discrepancyStatus: 'extra' | 'missing' | 'type-mismatch';
  groundTruth: GroundTruth;
  action: ColumnAction;
  /** Data type in the source stage (the stage being viewed). */
  sourceDataType?: string;
  /** Data type in the target stage (the comparison stage). */
  targetDataType?: string;
}

export type RelationshipAction =
  | 'add-relationship-to-logical'
  | 'remove-relationship-from-logical'
  | 'add-relationship-test-to-physical'
  | 'remove-relationship-test-from-physical'
  | 'update-cardinality-in-logical'
  | 'update-cardinality-in-physical';

export interface RelationshipResolution {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  discrepancyStatus: 'extra' | 'missing' | 'cardinality-mismatch';
  groundTruth: GroundTruth;
  action: RelationshipAction;
  sourceCardinality?: Cardinality;
  targetCardinality?: Cardinality;
}

// ---------------------------------------------------------------------------
// Model context  (file paths for the AI skill to locate files)
// ---------------------------------------------------------------------------

export interface ModelContext {
  modelName: string;
  /** Relative path to the logical model YAML (e.g. erd-studio/logical-models/dim_customer.yml). */
  logicalModelPath: string;
  /** Relative path to the dbt SQL file (from manifest originalFilePath). Null if not in manifest. */
  dbtSqlPath: string | null;
  /** Relative path to the dbt schema YAML. Null if not determinable. */
  dbtSchemaPath: string | null;
}

// ---------------------------------------------------------------------------
// The sync plan  (written to erd-studio/.sync-plan.json)
// ---------------------------------------------------------------------------

export interface SyncPlan {
  /** ISO 8601 timestamp of when the plan was generated. */
  generatedAt: string;
  /** Domain name. */
  domain: string;
  /** Layer (e.g. silver, gold). */
  layer: string;
  /** The stage the user was viewing when they ran the comparison. */
  sourceStage: Stage;
  /** The stage compared against. */
  targetStage: Stage;
  /** File path context for every model referenced in the actions. */
  modelContext: Record<string, ModelContext>;
  /** Model-level resolutions. */
  models: ModelResolution[];
  /** Column-level resolutions. */
  columns: ColumnResolution[];
  /** Relationship-level resolutions. */
  relationships: RelationshipResolution[];
  /** True if any action targets the physical side (dbt files), meaning dbt compile is needed after. */
  requiresCompile: boolean;
}

// ---------------------------------------------------------------------------
// Action derivation  (pure function, no I/O)
// ---------------------------------------------------------------------------

/**
 * Derive the concrete action from a discrepancy status, ground truth choice,
 * and which stage was the source (the stage being viewed).
 *
 * "extra" means the item exists in the source stage but not the target.
 * "missing" means the item exists in the target stage but not the source.
 *
 * When sourceStage is 'logical':
 *   extra  + logical truth  → no-op (item belongs in logical, already there)
 *   extra  + physical truth → remove from logical
 *   missing + logical truth → add to physical (make physical match logical)
 *   missing + physical truth → add to logical (make logical match physical)
 *
 * When sourceStage is 'physical', the semantics flip.
 */
export function deriveModelAction(
  status: 'extra' | 'missing',
  groundTruth: GroundTruth,
  sourceStage: Stage,
): ModelAction | null {
  const logicalIsSource = sourceStage === 'logical';

  if (status === 'extra') {
    // Item is in source, not in target
    if (logicalIsSource) {
      return groundTruth === 'logical' ? null : 'remove-from-logical';
    } else {
      return groundTruth === 'physical' ? null : 'remove-from-physical';
    }
  } else {
    // missing: item is in target, not in source
    if (logicalIsSource) {
      // missing from logical view = exists in physical only
      return groundTruth === 'logical' ? 'remove-from-physical' : 'add-to-logical';
    } else {
      // missing from physical view = exists in logical only
      return groundTruth === 'physical' ? 'remove-from-logical' : 'add-to-physical';
    }
  }
}

export function deriveColumnAction(
  status: 'extra' | 'missing' | 'type-mismatch',
  groundTruth: GroundTruth,
  sourceStage: Stage,
): ColumnAction | null {
  const logicalIsSource = sourceStage === 'logical';

  if (status === 'type-mismatch') {
    return groundTruth === 'logical' ? 'update-type-in-physical' : 'update-type-in-logical';
  }

  if (status === 'extra') {
    // extra = exists in source, not in target
    if (logicalIsSource) {
      return groundTruth === 'logical' ? 'add-column-to-physical' : 'remove-column-from-logical';
    } else {
      // source is physical: column exists in physical, not logical
      return groundTruth === 'physical' ? 'add-column-to-logical' : 'remove-column-from-physical';
    }
  } else {
    // missing
    if (logicalIsSource) {
      return groundTruth === 'logical' ? 'remove-column-from-physical' : 'add-column-to-logical';
    } else {
      return groundTruth === 'physical' ? 'remove-column-from-logical' : 'add-column-to-physical';
    }
  }
}

export function deriveRelationshipAction(
  status: 'extra' | 'missing' | 'cardinality-mismatch',
  groundTruth: GroundTruth,
  sourceStage: Stage,
): RelationshipAction | null {
  const logicalIsSource = sourceStage === 'logical';

  if (status === 'cardinality-mismatch') {
    return groundTruth === 'logical'
      ? 'update-cardinality-in-physical'
      : 'update-cardinality-in-logical';
  }

  if (status === 'extra') {
    // extra = exists in source, not in target
    if (logicalIsSource) {
      return groundTruth === 'logical'
        ? 'add-relationship-test-to-physical'
        : 'remove-relationship-from-logical';
    } else {
      // source is physical: relationship test exists in physical, not logical
      return groundTruth === 'physical'
        ? 'add-relationship-to-logical'
        : 'remove-relationship-test-from-physical';
    }
  } else {
    // missing
    if (logicalIsSource) {
      return groundTruth === 'logical'
        ? 'remove-relationship-test-from-physical'
        : 'add-relationship-to-logical';
    } else {
      return groundTruth === 'physical'
        ? 'remove-relationship-from-logical'
        : 'add-relationship-to-logical';
    }
  }
}
