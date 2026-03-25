/**
 * Types for display-ready domain data sent to the webview.
 *
 * These types replace the old ReconciledDomain/ReconciledModel/ReconciledColumn
 * types. In the stage architecture, there is no manifest-merge reconciliation;
 * instead, each stage (logical/physical) produces a DisplayDomain
 * directly from its data source.
 */

import type { Cardinality, Layer, ModelRole, ModelTemplate, Rationale, Stage, ViewConfig } from './semantic';
import type { LayerConfig } from './layer';

// ---------------------------------------------------------------------------
// Existing model preview (for Add Existing Model dialog)
// ---------------------------------------------------------------------------

/**
 * Lightweight preview of a manifest model for the "Add Existing Model" dialog.
 * Contains only what's needed for display and selection — full column details
 * are resolved after the model is added to the domain.
 */
export interface ManifestModelPreview {
  name: string;
  schema: string;
  description: string;
  columnCount: number;
}

/**
 * Enhanced model preview for the "Add Existing Model" dialog.
 * Extends ManifestModelPreview with source information.
 *
 * - 'logical': model has a YAML definition in erd-studio/logical-models/
 * - 'manifest': model exists in compiled manifest only (no logical model file yet)
 */
export interface ExistingModelPreview extends ManifestModelPreview {
  source: 'logical' | 'manifest';
}

// ---------------------------------------------------------------------------
// Display column
// ---------------------------------------------------------------------------

/** Column ready for webview display. */
export interface DisplayColumn {
  name: string;
  dataType: string;
  description: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isNaturalKey: boolean;
  scdType?: 0 | 1 | 2;
  additiveType?: 'additive' | 'semi-additive' | 'non-additive';
}

// ---------------------------------------------------------------------------
// Display model
// ---------------------------------------------------------------------------

/** Model ready for webview display. */
export interface DisplayModel {
  name: string;
  schema: string;
  description: string;
  columns: DisplayColumn[];
  rationale?: Rationale;
  grain?: string;
  modelRole?: ModelRole;
  /** True if model exists in manifest (physical stage only). */
  existsInManifest?: boolean;
}

// ---------------------------------------------------------------------------
// Display relationship
// ---------------------------------------------------------------------------

/** Relationship ready for webview display. */
export interface DisplayRelationship {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: Cardinality;
}

// ---------------------------------------------------------------------------
// Display domain
// ---------------------------------------------------------------------------

/** Domain ready for webview rendering. */
export interface DisplayDomain {
  schemaVersion: number;
  domain: string;
  layer: Layer;
  stage: Stage;
  description: string;
  modelFolder?: string;
  models: DisplayModel[];
  relationships: DisplayRelationship[];
  viewConfig: ViewConfig;
  /** Available templates (only for editable stages). */
  templates?: ModelTemplate[];
  /** Manifest models available to add (only for editable stages). @deprecated Use existingModels. */
  manifestModels?: ManifestModelPreview[];
  /** Models available to add from logical-models/ and manifest (only for editable stages). */
  existingModels?: ExistingModelPreview[];
  /** Layer config for badge styling. */
  layerConfig?: LayerConfig;
  /** Whether this stage is read-only for data mutations (physical). */
  readOnly: boolean;
  /** Whether nodes can be dragged to reposition (true for all stages). */
  positionDraggable: boolean;
  /**
   * Model names whose physical-only columns are suppressed in discrepancy comparison.
   * Reflects the domain JSON stubColumns list; included so the UI can show the toggle state.
   */
  stubColumns?: string[];
}
