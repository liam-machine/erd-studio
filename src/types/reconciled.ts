/**
 * Types for reconciled domain data.
 *
 * The ReconciliationService merges semantic domain JSON with dbt manifest data
 * to produce a ReconciledDomain. This enriched data includes:
 *   - Resolved columns (from manifest for built models, inline for design)
 *   - Column status (built vs planned)
 *   - Model status (built, design, or missing)
 *
 * The webview receives ReconciledDomain instead of raw SemanticDomain.
 */

import type { Cardinality, Layer, ModelTemplate, ViewConfig } from './semantic';

// ---------------------------------------------------------------------------
// Column status
// ---------------------------------------------------------------------------

/**
 * Status of a resolved column:
 * - `built` — column exists in manifest (green)
 * - `planned` — column is in plannedColumns but not in manifest (orange)
 * - `missing` — PK/FK reference to a column that doesn't exist (orange ghost)
 */
export type ColumnStatus = 'built' | 'planned' | 'missing';

// ---------------------------------------------------------------------------
// Model status
// ---------------------------------------------------------------------------

/**
 * Status of a resolved model:
 * - `built` — repo model found in manifest (green)
 * - `design` — design model not in manifest (orange)
 * - `missing` — repo model NOT found in manifest (grey/warning)
 */
export type ModelStatus = 'built' | 'design' | 'missing';

// ---------------------------------------------------------------------------
// Reconciled column
// ---------------------------------------------------------------------------

/** A column with resolved status and PK/FK flags. */
export interface ReconciledColumn {
  name: string;
  dataType: string;
  description: string;
  status: ColumnStatus;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
}

// ---------------------------------------------------------------------------
// Reconciled model
// ---------------------------------------------------------------------------

/** A model with resolved columns and status. */
export interface ReconciledModel {
  name: string;
  status: ModelStatus;
  schema: string;
  description: string;
  /**
   * Resolved columns in display order:
   * 1. Built columns (from manifest) — green
   * 2. Planned columns (not in manifest) — orange
   * 3. Missing PK/FK ghost columns — orange
   */
  columns: ReconciledColumn[];
}

// ---------------------------------------------------------------------------
// Reconciled relationship
// ---------------------------------------------------------------------------

/** Relationship status for edge colouring. */
export type RelationshipStatus = 'built' | 'design';

/** A relationship with resolved status. */
export interface ReconciledRelationship {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: Cardinality;
  status: RelationshipStatus;
}

// ---------------------------------------------------------------------------
// Reconciled domain
// ---------------------------------------------------------------------------

/**
 * A fully reconciled semantic domain ready for the webview.
 *
 * This is the payload sent via `domainLoaded` message to the webview.
 * All columns are resolved, statuses are determined, and the data is
 * ready for direct rendering.
 */
export interface ReconciledDomain {
  schemaVersion: number;
  domain: string;
  layer: Layer;
  description: string;
  models: ReconciledModel[];
  relationships: ReconciledRelationship[];
  viewConfig: ViewConfig;
  /**
   * Available model templates loaded from semantic/templates/*.json.
   * Used by the New Model dialog to create models with preset columns.
   */
  templates: ModelTemplate[];
}
