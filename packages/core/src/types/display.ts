/**
 * Types for display-ready domain data sent to the webview.
 *
 * These types replace the old ReconciledDomain/ReconciledModel/ReconciledColumn
 * types. In the stage architecture, there is no manifest-merge reconciliation;
 * instead, each stage (logical/physical) produces a DisplaySubjectArea
 * directly from its data source.
 */

import type { Cardinality, Layer, Meta, TableLoadError, TableLoadWarning, TableRole, TableTemplate, Rationale, Stage, ViewConfig } from './semantic.js';
import type { LayerConfig } from './layer.js';
import type { DbtKeyHint } from '../keyEvidence.js';
import type { FieldList } from '../fields.js';

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
export interface ExistingTablePreview extends ManifestModelPreview {
  source: 'logical' | 'yml' | 'manifest';
  /** Relative file path showing where this model is defined (e.g. "models/silver/dim_customer.yml") */
  sourcePath: string;
  /**
   * A Table Library row whose file has not been read yet (a large library
   * opened before its files were read): `schema` and `description` are
   * empty and `columnCount` is 0 until it is. The extension asks for the
   * read rows when the Add Existing Table dialog opens. Absent on every row
   * that was read, and on every row an older host sends.
   */
  detailsPending?: true;
  /**
   * A DBML table's layer and schema folder (`<layer>/tables/<schema>/`), where
   * the host tells two tables of one name apart by them: the dialog shows
   * them beside the name. Absent on every other row, and from an older host.
   */
  layer?: string;
  schemaFolder?: string;
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
  /** Structured metadata from the model file (logical stage only). */
  meta?: Meta;
  /**
   * The model file's own foreign-key flag, set only when true (logical stage
   * only). `isForeignKey` is the badge, which the foreign-key end of a
   * relationship (`foreignKeyEnd`) also shows; key evidence needs the flag the user set (#133 L1).
   */
  isForeignKeyDeclared?: boolean;
  /**
   * What dbt's tests say about the column (the editable logical payload
   * only, never stored): how a new relationship is oriented when the model
   * flags no key (#133 L1).
   */
  dbtKey?: DbtKeyHint;
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
export interface DisplayTable {
  /**
   * What the diagram calls the table, unique within it: what relationship
   * ends, positions keys, `stubColumns` and sticky-note links name. The
   * table's name, except on a DBML diagram that shows two tables of one name
   * from different schema folders: each is then `<schema>.<name>`.
   */
  name: string;
  /**
   * The table's own name, present only when `name` is not it (the
   * `<schema>.<name>` case above): what a header, an export or a dbt lookup
   * shows. Absent: `name`. Older cores never set it.
   */
  tableName?: string;
  schema: string;
  /**
   * The layer whose folder holds the table's file (`<layer>/tables/<schema>/`,
   * DBML storage; logical stage only). A diagram belongs to one layer but can
   * show tables from any, so the canvas badges each table with its own.
   * Absent for a YAML table, on the physical stage and from older cores: the
   * table is then drawn as in the diagram's layer.
   */
  layer?: Layer;
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
  modelRole?: TableRole;
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
  loadError?: TableLoadError;
  /**
   * The model's file was read, but something in it needs fixing (logical stage
   * only): a key written twice, whose last value is shown (#164). Absent from
   * older cores, which left such a model out instead.
   */
  loadWarning?: TableLoadWarning;
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
  /** Set only on the members of a valid composite foreign key (see `Relationship.compositeKey`). */
  compositeKey?: string;
  /**
   * Set (only ever `true`) on a logical relationship stored the way round its
   * keys contradict (#163, `keysContradictedRelationships`): it starts at a
   * model's whole key, so it was probably drawn backwards. Absent when the
   * keys do not decide, and in a DisplaySubjectArea from a core before it.
   */
  keysContradict?: true;
  /**
   * Set (only ever `true`) by the editor on a logical relationship the open
   * diagram file holds itself (a YAML/JSON domain's `logical.relationships`),
   * which removing one of its tables from the diagram removes too. Absent on
   * a relationship stored in the Table Library, and from older cores.
   */
  inDiagramFile?: true;
}

// ---------------------------------------------------------------------------
// Display domain
// ---------------------------------------------------------------------------

/** Domain ready for webview rendering. */
export interface DisplaySubjectArea {
  schemaVersion: number;
  domain: string;
  layer: Layer;
  stage: Stage;
  description: string;
  modelFolder?: string;
  models: DisplayTable[];
  relationships: DisplayRelationship[];
  viewConfig: ViewConfig;
  /** Available templates (only for editable stages). */
  templates?: TableTemplate[];
  /** Manifest models available to add (only for editable stages). @deprecated Use existingModels. */
  manifestModels?: ManifestModelPreview[];
  /** Models available to add from logical-models/ and manifest (only for editable stages). */
  existingModels?: ExistingTablePreview[];
  /** Layer config for badge styling. */
  layerConfig?: LayerConfig;
  /**
   * Every configured layer (layers.json), so a table from another layer
   * (`DisplayTable.layer`) is drawn in its own layer's colour. Absent from
   * older cores and when no table names a layer.
   */
  layerConfigs?: LayerConfig[];
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
   * Set by the editor on an editable logical stage: whether the diagram file
   * holds relationships of its own (`DisplayRelationship.inDiagramFile`).
   * `false` means every relationship lives in the Table Library (a DBML
   * diagram, or a domain with none of its own), so removing a table from the
   * diagram keeps them. Absent from older cores: treated as `true`, the old
   * warning that a table's relationships go with it.
   */
  relationshipsInDiagramFile?: boolean;
  /**
   * Set by the editor on an editable logical stage whose new tables are DBML:
   * where New Table puts one (`<dir>/<layer>/tables/<schema>/`). `dir` is the
   * semantic dir relative to the project (`.erd-studio`), `schemas` the
   * schema folders the layer's tables already use, `defaultSchema` the one
   * most of this diagram's tables in the layer use, else the layer id.
   * Absent for a YAML project and from older cores: the dialog asks for no
   * schema and the table goes where it always did.
   */
  newTableSchemas?: { dir: string; layer: string; schemas: string[]; defaultSchema: string };
  /**
   * The project's field list (`.erd-studio/fields.yml`), fully resolved: every
   * definition carries its label, type, values, guidance, `filledBy` and
   * `showFor`, so a renderer draws the fields without the catalogue. Set only
   * when the project has a fields.yml. Absent (no file, or an older core)
   * means the starting set: read it as `fields ?? STARTING_FIELD_LIST`.
   */
  fields?: FieldList;
}
