/**
 * Types for display-ready domain data sent to the webview.
 *
 * These types replace the old ReconciledDomain/ReconciledModel/ReconciledColumn
 * types. In the stage architecture, there is no manifest-merge reconciliation;
 * instead, each stage (logical/physical) produces a DisplayDomain
 * directly from its data source.
 */

import type { Cardinality, Layer, ModelRole, ModelTemplate, Rationale, Stage, ViewConfig } from './semantic.js';
import type { LayerConfig } from './layer.js';

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
 * - 'logical': model has a YAML definition in .erd-studio/logical-models/ (Library)
 * - 'yml': model defined in a dbt .yml schema file (dbt)
 * - 'manifest': model exists in compiled manifest only, no .yml file (Compiled)
 */
export interface ExistingModelPreview extends ManifestModelPreview {
  source: 'logical' | 'yml' | 'manifest';
  /** Relative file path showing where this model is defined (e.g. "models/silver/dim_customer.yml") */
  sourcePath: string;
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

/**
 * A source that can contribute physical columns or data types to a model.
 *
 * Ordered by authority, most authoritative first: the warehouse catalog is an
 * observation of what was actually built; a schema .yml `data_type:` is the
 * author's assertion; the manifest is a compiled copy of that assertion; a bare
 * source file proves only that the model exists.
 */
export type PhysicalColumnSource = 'catalog' | 'yml' | 'manifest' | 'file';

/** Where a physical model's shape came from. */
export interface PhysicalProvenance {
  /** Every source that contributed a column, most authoritative first. Never empty. */
  columns: PhysicalColumnSource[];
  /** Highest-authority source that supplied at least one data type — what the canvas chip names. */
  types: PhysicalColumnSource;
}

/** Model ready for webview display. */
export interface DisplayModel {
  name: string;
  schema: string;
  /**
   * Warehouse table name when it differs from the model name (dbt `alias`).
   * Logical stage: the model file's `alias`. Physical stage: the alias dbt
   * builds the model under, falling back to the logical one. Absent when the
   * table is simply named after the model.
   */
  alias?: string;
  description: string;
  columns: DisplayColumn[];
  rationale?: Rationale;
  grain?: string;
  modelRole?: ModelRole;
  /**
   * True when the model was found in the dbt project — a .sql/.py/.csv file
   * under model/seed/snapshot paths, a schema .yml declaration, a manifest node,
   * or a catalog relation (physical stage only).
   *
   * Optional because `undefined` means "logical stage, not applicable". The
   * predecessor of this field was `existsInManifest`, which asked a narrower
   * question — it was renamed rather than redefined so that nothing keeps
   * reading it as "the compiled manifest has this model".
   */
  existsInProject?: boolean;
  /**
   * Why the model does not exist, set only alongside `existsInProject: false`.
   * 'disabled' means dbt knows the model but refuses to build it (it is in
   * `manifest.disabled`, so `ref()` to it fails); 'absent' means nothing in the
   * project mentions it at all.
   */
  missingReason?: 'absent' | 'disabled';
  /** Where the physical columns and types came from (physical stage only). */
  provenance?: PhysicalProvenance;
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
  /**
   * Which dbt artifacts fed this stage (physical stage only).
   *
   * The physical canvas no longer greys itself out when dbt has not been
   * compiled, so this is what tells the webview to say so instead.
   */
  physicalSources?: { yml: boolean; manifest: boolean; catalog: boolean };
}
