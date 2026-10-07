/**
 * Types for display-ready domain data sent to the webview.
 *
 * These types replace the old ReconciledDomain/ReconciledModel/ReconciledColumn
 * types. In the stage architecture, there is no manifest-merge reconciliation;
 * instead, each stage (logical/physical) produces a DisplayDomain
 * directly from its data source.
 */

import type { Cardinality, Layer, Meta, ModelLoadError, ModelRole, ModelTemplate, Rationale, Stage, ViewConfig } from './semantic.js';
import type { LayerConfig } from './layer.js';
import type { RelationshipEnds, RelationshipIssueCode, RelationshipSeverity, RelationshipSource } from '../relationships.js';

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

/**
 * What a dbt project's tests say about one column — evidence for which way a
 * relationship points (`resolveDirection`). Each field is absent when dbt
 * says nothing either way.
 */
export interface DbtColumnEvidence {
  /** true: a `unique` test covers the column alone. false: dbt is known to treat it as not unique. */
  unique?: boolean;
  /** The column is one of several in a `unique_combination_of_columns` test. */
  inCompositeUnique?: boolean;
  /** A `relationships` test on this column points at another model. */
  relationshipsTest?: boolean;
  /**
   * Where those `relationships` tests point. A unique column counts as
   * "pointing at the other end" of a relationship only when one of these names
   * that end — a test aimed at an unrelated model is no evidence about the pair.
   */
  relationshipsTo?: Array<{ model: string; column: string }>;
}

/** Column ready for webview display. */
export interface DisplayColumn {
  name: string;
  dataType: string;
  description: string;
  isPrimaryKey: boolean;
  /**
   * The FK badge: true when the model file marks the column as a foreign key
   * or the column is the `from` end of a drawn relationship.
   */
  isForeignKey: boolean;
  /**
   * True only when the model file itself says `isForeignKey` (logical stage).
   * Unlike `isForeignKey` it is never inferred from relationships, so a wrong
   * relationship cannot reinforce itself — key evidence (`resolveDirection`)
   * reads this one. Absent when false.
   */
  isForeignKeyDeclared?: boolean;
  isNaturalKey: boolean;
  /** What the dbt project's tests say about this column, when the host knows (logical stage, editable). */
  dbtEvidence?: DbtColumnEvidence;
  scdType?: 0 | 1 | 2;
  additiveType?: 'additive' | 'semi-additive' | 'non-additive';
  /** Structured metadata from the model file (logical stage only). */
  meta?: Meta;
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
  /** Structured metadata from the model file (logical stage only). */
  meta?: Meta;
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
  /**
   * The model's file exists but could not be read (logical stage only): the
   * node shows the error instead of an empty column list.
   */
  loadError?: ModelLoadError;
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
  /** Optional label for the link, e.g. `ship date` (see `Relationship.role`). */
  role?: string;
  /** Where the relationship was read from (logical stage; see `Relationship.source`). */
  source?: RelationshipSource;
  /**
   * The record's ends exactly as stored on disk (logical stage). The webview
   * sends these as the original key of an update, edit or remove.
   */
  stored?: RelationshipEnds;
  /** Codes of what is wrong with this link, for an edge badge (logical stage). */
  issues?: RelationshipIssueCode[];
  /**
   * Physical stage: a `one-to-one` dbt tests from both ends, so neither end is
   * known to hold the foreign key. A comparison then does not hold the
   * direction against the other stage. Runtime only.
   */
  directionUnknown?: boolean;
}

/** A relationship finding summarised for the canvas banner. */
export interface DisplayRelationshipIssue {
  code: RelationshipIssueCode;
  severity: RelationshipSeverity;
  message: string;
  /** The `linkKey` it is about, when it is about one link. */
  link?: string;
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
  /**
   * Where a new relationship drawn on this canvas is stored (editable logical
   * payload only): the model library, or this domain file.
   */
  relationshipHome?: 'library' | 'domain';
  /** Relationship findings for this domain (editable logical payload only); absent when there are none. */
  relationshipIssues?: DisplayRelationshipIssue[];
}
