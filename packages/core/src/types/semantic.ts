/**
 * Types for semantic domain JSON files.
 *
 * Domain files live at {dbt_project}/.erd-studio/{layer}/{domain}.json
 * and describe FK-based relationships between dbt models within a business
 * domain at a particular design stage (logical or physical).
 */

/**
 * Layer identifier type - dynamic string validated at runtime.
 * Layer configuration is managed by LayerService and stored in layers.json.
 */
export type Layer = string;

/** The two design stages of a domain. */
export type Stage = 'logical' | 'physical';

/**
 * The newest schema version this version of core reads, in any format: 7, a
 * DBML diagram (native DBML storage, ERD Studio 2.0). A JSON subject area may
 * declare at most {@link CURRENT_JSON_SCHEMA_VERSION}; a DBML diagram whose
 * `erd_schema_version` is higher than this one is refused with "Please update
 * the extension" rather than read as an empty diagram. Writers use
 * {@link WRITTEN_SCHEMA_VERSION} (JSON) or {@link DBML_SCHEMA_VERSION} (DBML).
 */
export const CURRENT_SCHEMA_VERSION = 7;

/**
 * The newest schema version a JSON subject area file may declare. A JSON file
 * declaring a higher one is refused with "Please update the extension" (the
 * same words as before 7 existed), so a JSON file that says 7 is still refused.
 */
export const CURRENT_JSON_SCHEMA_VERSION = 6;

/**
 * The version a DBML diagram declares, as `erd_schema_version: '7'` on its
 * Project. Table and relationships files carry none: the diagram's version
 * gates the format. A DBML diagram is read into a v5-shaped object that keeps
 * `schemaVersion` {@link WRITTEN_SCHEMA_VERSION}; this one travels beside it
 * and reaches only the Unified and Display `schemaVersion`.
 */
export const DBML_SCHEMA_VERSION = 7;

/**
 * Schema v6 (#162): the table naming. `tables/` for the library,
 * `logical.tables`, `subjectArea`, `fromTable` / `toTable`, `tableRole` and
 * `linkedTable`. Read alongside v5, and written by a project that uses it
 * (#182: see `detectProjectNaming`).
 */
export const TABLE_NAMING_SCHEMA_VERSION = 6;

/** Schema v5: model name references into the central `logical-models/` library. */
export const LIBRARY_SCHEMA_VERSION = 5;

/**
 * The schema version of a subject area written under the v5 keys: a v5
 * project's new files, and the v4 → v5 migration. A project that writes
 * the v6 naming stamps {@link TABLE_NAMING_SCHEMA_VERSION} instead, through
 * `toTableNamingDocument` (#182), so no file mixes the two.
 */
export const WRITTEN_SCHEMA_VERSION = LIBRARY_SCHEMA_VERSION;

/** Previous schema version (inline models). */
export const LEGACY_SCHEMA_VERSION = 4;

// ---------------------------------------------------------------------------
// Free-form metadata
// ---------------------------------------------------------------------------

/**
 * One value in a `meta` map. Numbers are carried as their YAML source text
 * (`tier: 1` reads as `'1'`), the same rule every other model field follows,
 * so a value that is written back unchanged keeps its exact spelling.
 */
export type MetaValue = string | boolean | null | MetaValue[] | { [key: string]: MetaValue };

/**
 * Structured metadata on a model or a column — owner, lineage, source system,
 * anything the team wants to record. Named after dbt's `meta:`. ERD Studio
 * shows it and edits top-level text values; it never compares or syncs it.
 */
export type Meta = Record<string, MetaValue>;

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

/** Column definition for a model. */
export interface ColumnDef {
  name: string;
  dataType: string;
  description: string;
  isPrimaryKey?: boolean;
  /** Stored FK flag for design-time FK intent (separate from computed FK from relationships). */
  isForeignKey?: boolean;
  /** Natural key flag — business identifier like email, SKU, customer_code. */
  isNaturalKey?: boolean;
  /**
   * SCD type for dimension columns: how this attribute handles changes over time.
   * 0 = Never changes, 1 = Overwrite, 2 = Track history.
   * Only meaningful on dimension-role models but stored unconditionally.
   */
  scdType?: 0 | 1 | 2;
  /**
   * Additive type for fact measure columns: how this measure aggregates across dimensions.
   * Only meaningful on fact-role models but stored unconditionally.
   */
  additiveType?: 'additive' | 'semi-additive' | 'non-additive';
  /** Free-form structured metadata (dbt-style `meta:`). */
  meta?: Meta;
}

// ---------------------------------------------------------------------------
// Model role
// ---------------------------------------------------------------------------

/**
 * Classifies a model's role in the data warehouse architecture.
 * Maps to entity types from dimensional modelling methodology.
 */
export type TableRole =
  | 'conformed-dim'        // Shared dimension reused across domains
  | 'domain-dim'           // New dimension specific to this domain
  | 'transaction-fact'     // Discrete event fact
  | 'periodic-snapshot'    // Recurring measurement per period
  | 'accumulating-snapshot'// Lifecycle with milestones
  | 'factless-fact'        // M:M bridge table, FKs only
  | 'reference'            // Low-cardinality lookup
  | 'gold-fact'            // Pre-joined Gold view
  | 'gold-dim';            // Flattened Gold dimension view

// ---------------------------------------------------------------------------
// Design rationale
// ---------------------------------------------------------------------------

/** Design rationale metadata for a model — explains architectural decisions. */
export interface Rationale {
  /** What requirements or purpose this model fulfils. */
  purpose?: string;
  /** Why this model was designed the way it was. */
  design?: string;
  /** Why this grain was chosen over alternatives. */
  grainChoice?: string;
  /** Why this model role / fact type was selected. */
  roleChoice?: string;
  /** Overall SCD strategy explanation across dimension attributes. */
  scdStrategy?: string;
  /** Why measures are structured this way — additive type choices, component storage. */
  measures?: string;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/**
 * A model entry in a semantic domain.
 *
 * In the stage architecture, models are simple data containers.
 * The stage is determined by the section (logical) within
 * the unified domain file, not by a field on the model.
 */
export interface SemanticTable {
  name: string;
  /** Schema the model will be materialised in. */
  schema?: string;
  /**
   * Name of the table or view in the warehouse, when it differs from the model
   * name — dbt's `alias` config. The model name stays the unique identity
   * (domain files, relationships and positions all use it); the alias is what
   * lets `silver_date` and `gold_date` both build a table called `date`, and
   * what the canvas shows as the model's label.
   */
  alias?: string;
  /** Model description. */
  description?: string;
  /** Column definitions. */
  columns?: ColumnDef[];
  /** Design rationale: what this model does and why it was designed this way. */
  rationale?: Rationale;
  /** Grain statement — "One row per ___". The single most critical design decision. */
  grain?: string;
  /** Model's role in the data warehouse architecture (e.g. conformed-dim, transaction-fact). */
  modelRole?: TableRole;
  /** Free-form structured metadata (dbt-style `meta:`). */
  meta?: Meta;
  /**
   * Relationships that leave this model, stored once in its library file
   * (issue #126) so every domain holding both ends draws the same edge. Read
   * from `logical-models/*.yml` only — never from inline v4 models.
   */
  relationships?: TableRelationship[];
}

/**
 * The placeholder a host puts in a stage's `models` for a model whose file
 * exists but could not be read. Runtime-only: `loadError` is never written to
 * a model file, which is why it is not a field of {@link SemanticTable} (the
 * on-disk shape).
 */
export interface UnreadableTablePlaceholder extends SemanticTable {
  loadError: TableLoadError;
}

/** The load error carried by an {@link UnreadableTablePlaceholder}, if `model` is one. */
export function tableLoadErrorOf(model: SemanticTable): TableLoadError | undefined {
  const candidate = (model as Partial<UnreadableTablePlaceholder>).loadError;
  return candidate && typeof candidate === 'object' ? candidate : undefined;
}

/**
 * Something wrong in a model file that was still read (#164). Runtime-only,
 * like `loadError`: never written to a model file. Today the one case is a key
 * written twice in one block — the last value is used, as dbt's PyYAML does,
 * and the file stays refused for writing until one copy is removed.
 */
export interface TableLoadWarning {
  kind: 'yamlDuplicateKey';
  /** The key written twice, as the file spells it (the first one found). */
  key: string;
  /** 1-based line of its later copy, the one whose value is used. */
  line: number;
}

/** A model read from a file with a {@link TableLoadWarning}. */
export interface TableWithLoadWarning extends SemanticTable {
  loadWarning: TableLoadWarning;
}

/** The load warning carried by a model read from a flawed file, if any. */
export function tableLoadWarningOf(model: SemanticTable): TableLoadWarning | undefined {
  const candidate = (model as Partial<TableWithLoadWarning>).loadWarning;
  return candidate && typeof candidate === 'object' ? candidate : undefined;
}

/**
 * Why a model file that exists could not be read. A fixed set derived from
 * the YAML parser's error code (never its message), so it is safe to branch on
 * in the UI and to count in usage telemetry.
 */
export type TableLoadErrorKind =
  | 'read'
  | 'yamlIndent'
  | 'yamlScalar'
  | 'yamlStructure'
  | 'yamlDuplicateKey'
  | 'yamlOther'
  /** A `.dbml` table file with a DBML syntax error (codes 1000–1999), or unresolved merge conflicts. */
  | 'dbmlSyntax'
  /** A `.dbml` table file DBML rejects (codes 3000–3999 and 5000+): an unquoted value, a bad setting, … */
  | 'dbmlInvalid'
  /** A `.dbml` table file that is not one self-contained Table (ERD Studio's own rules, or a binding error). */
  | 'dbmlStructure';

/**
 * A model file that exists but is broken, as the canvas shows it. Carries no
 * parser message (which may quote the file) — only the kind and the position.
 */
export interface TableLoadError {
  kind: TableLoadErrorKind;
  /** 1-based line of the error, when the parser reported one. */
  line?: number;
  /**
   * The file holds unresolved git merge conflicts (#145); `line` is then the
   * first `<<<<<<<`. Absent otherwise, and from older cores — which read the
   * same file as a YAML error on some line, still true.
   */
  mergeConflict?: true;
  /**
   * The parser's code, never its message: a YAML error code (`BAD_INDENT`), a
   * DBML diagnostic code as text (`'3025'`), or `'structure:<rule>'` for one
   * of ERD Studio's own DBML table-file rules (`notOneTable`, `nameMismatch`,
   * `unsupportedElement`, `metadataTarget`). Optional, and absent from older cores.
   */
  code?: string;
  /**
   * For `structure:metadataTarget` only: the table or column a `Metadata`
   * block names that the file does not declare, so the message can name it.
   * Optional, and absent from older cores.
   */
  target?: DbmlMetadataTarget;
}

/** What a `Metadata Table <name>` or `Metadata Column <table>.<name>` block targets (D25). */
export interface DbmlMetadataTarget {
  element: 'table' | 'column';
  /** The table's or column's name as the block spells it (a column without its table). */
  name: string;
}

/**
 * A model definition used when creating new models via addModel message.
 */
export interface DesignTable {
  name: string;
  schema?: string;
  description: string;
  columns: ColumnDef[];
  /** Model's role in the data warehouse architecture. Auto-suggested from template. */
  modelRole?: TableRole;
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

/** FK relationship cardinality. */
export type Cardinality = 'many-to-one' | 'one-to-one' | 'one-to-many' | 'many-to-many';

/**
 * An FK relationship between two models in a domain.
 *
 * Identity is the composite key: (fromModel, fromColumn, toModel, toColumn).
 */
export interface Relationship {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: Cardinality;
  /**
   * Optional label for what this link means, e.g. `order date` and `ship date`
   * for two columns pointing at the same date dimension. A label only: it is
   * not part of the relationship's identity, which the columns already give.
   */
  role?: string;
  /**
   * Entries sharing this value, in one file and from one model, form one
   * composite foreign key: one relationship over several column pairs (#133
   * L2). Grouping only, like `role`: each entry is still its own link.
   */
  compositeKey?: string;
}

/**
 * A relationship as stored in its from-model's library file: the same fields
 * as {@link Relationship} without `fromModel`, which is the file's own model.
 * The from-model is the "many" (foreign-key) side — `canonicalRelationship`
 * turns a `one-to-many` round before it is stored (issue #133).
 */
export type TableRelationship = Omit<Relationship, 'fromModel'>;

// ---------------------------------------------------------------------------
// View configuration
// ---------------------------------------------------------------------------

/** Persisted x/y position for a model node on the canvas. */
export interface NodePosition {
  x: number;
  y: number;
}

/** ELK layout options stored as string key-value pairs. */
export type LayoutOptions = Record<string, string>;

// ---------------------------------------------------------------------------
// Annotations (build notes)
// ---------------------------------------------------------------------------

/** Colour options for canvas annotations. */
export type AnnotationColor = 'yellow' | 'blue' | 'green' | 'pink' | 'orange';

/**
 * A free-form canvas annotation (post-it note).
 *
 * Annotations are temporary build notes — visible on the canvas while
 * constructing a model, then removed once the work is done. They live
 * in viewConfig (view-layer data), not in logical (semantic data).
 */
export interface Annotation {
  id: string;
  text: string;
  x: number;
  y: number;
  color?: AnnotationColor;
  width?: number;
  height?: number;
  /** Optional link to a model — renders a dashed edge on the canvas. */
  linkedModel?: string;
}

/** View configuration for a domain's graph editor. */
export interface ViewConfig {
  showFkEdges?: boolean;
  layoutOptions?: LayoutOptions;
  /** Persisted node positions keyed by model name. */
  positions?: Record<string, NodePosition>;
  /** Free-form canvas annotations (build notes). */
  annotations?: Annotation[];
}

// ---------------------------------------------------------------------------
// Stage data (structure for the logical section)
// ---------------------------------------------------------------------------

/** The models and relationships for a design stage. */
export interface StageData {
  models: SemanticTable[];
  relationships: Relationship[];
}

// ---------------------------------------------------------------------------
// Top-level domain
// ---------------------------------------------------------------------------

/** A full semantic domain as stored in JSON. */
export interface SemanticSubjectArea {
  schemaVersion: number;
  domain: string;
  layer: Layer;
  stage: Stage;
  description: string;
  /**
   * Optional folder filter for models (e.g., "models/silver").
   * When set, only manifest models with originalFilePath matching this prefix
   * will appear in the "Add Existing Model" dialog.
   * Undefined or null means no filter (show all models).
   */
  modelFolder?: string;
  models: SemanticTable[];
  relationships: Relationship[];
}

/**
 * Unified domain file format (v4).
 *
 * A single JSON file at .erd-studio/{layer}/{domain}.json containing
 * logical stage data. Physical stage is derived at runtime from
 * the logical models projected through the dbt manifest.
 */
export interface UnifiedSubjectArea {
  schemaVersion: number;
  domain: string;
  layer: Layer;
  description: string;
  modelFolder?: string;
  logical: StageData;
  /**
   * Model names whose physical-only columns are suppressed during discrepancy comparison.
   * Useful for conformed dimensions and reference tables that are included in a domain
   * only to anchor relationships — they define a few key columns (PK/NK) but not all
   * physical columns. Missing-column discrepancies for these models are hidden.
   */
  stubColumns?: string[];
  /** Global view configuration shared across all stages. */
  viewConfig: ViewConfig;
}

// ---------------------------------------------------------------------------
// V5 on-disk format (model references instead of inline models)
// ---------------------------------------------------------------------------

/**
 * Stage data as stored on disk in v5 domain files.
 * Models are string references (names) that resolve to logical-models/*.yml files.
 */
export interface StageDataV5 {
  models: string[];
  relationships: Relationship[];
}

/**
 * Unified domain file format (v5).
 *
 * Same as v4 but `logical.models` contains model name strings instead of
 * inline SemanticTable objects. Models are stored centrally in
 * .erd-studio/logical-models/{name}.yml.
 */
export interface UnifiedSubjectAreaV5 {
  schemaVersion: number;
  domain: string;
  layer: Layer;
  description: string;
  modelFolder?: string;
  logical: StageDataV5;
  /** See UnifiedSubjectArea.stubColumns. */
  stubColumns?: string[];
  viewConfig: ViewConfig;
}

/**
 * Raw on-disk domain format — may be v4 (inline models) or v5 (model references).
 * Used during parsing before version detection.
 */
export interface RawSubjectAreaFile {
  schemaVersion: number;
  domain: string;
  layer: Layer;
  description?: string;
  modelFolder?: string;
  logical: {
    models: SemanticTable[] | string[];
    relationships: Relationship[];
  };
  viewConfig?: ViewConfig;
}

/**
 * On-disk format of a raw (JSON.parse'd) domain document.
 *
 * - `v6`     — `logical.tables` is an array of table name strings, under the v6
 *              naming (`subjectArea`, `fromTable` / `toTable`, the `tables/` library).
 *              Read and normalised to the in-memory shape; written back by
 *              `toTableNamingDocument` (#182).
 * - `v5`     — `logical.models` is an array of model name strings (central model store).
 * - `v4`     — `logical.models` is an array of inline SemanticTable objects (deprecated,
 *              migratable via "ERD Studio: Migrate Subject Areas to the Central Table Library").
 * - `hybrid` — the document contradicts itself: `schemaVersion >= 5` with inline model
 *              objects, a mix of strings and objects, entries that are neither, or
 *              v5 and v6 names in one file.
 *              Must be repaired (migration) before it can be loaded or edited.
 * - `legacy` — pre-v4 layout: `schemaVersion < 4` and/or a top-level `models` array
 *              instead of a `logical` section. Not supported by the editor.
 */
export type SubjectAreaFormat = 'v4' | 'v5' | 'v6' | 'hybrid' | 'legacy';

/** The formats whose `logical` list holds table names resolved through the library (v5 and v6). */
export function usesTableLibrary(format: SubjectAreaFormat): format is 'v5' | 'v6' {
  return format === 'v5' || format === 'v6';
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Whether a raw domain document uses any of the v6 names (`logical.tables`,
 * `subjectArea`) or the v5 ones (`logical.models`, `domain`). Only the keys
 * a file is recognised by: relationship and annotation keys are read either
 * way by the normaliser.
 */
function namingKeys(obj: Record<string, unknown>): { v5: boolean; v6: boolean } {
  const logical = plainObject(obj.logical);
  return {
    v5: (logical !== undefined && 'models' in logical) || 'domain' in obj,
    v6: (logical !== undefined && 'tables' in logical) || 'subjectArea' in obj,
  };
}

/**
 * Whether a raw domain document mixes the v5 and v6 namings: it uses a v6
 * name (`logical.tables`, `subjectArea`) at all, or the v5 names under
 * `schemaVersion` 6 or more. A `hybrid` file that does is a hand-edit to undo
 * (its error says which key or number to change), not an inline-table file
 * the v5 migration repairs.
 */
export function mixesTableNaming(raw: unknown): boolean {
  const obj = plainObject(raw);
  if (obj === undefined) return false;
  const naming = namingKeys(obj);
  const version = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : undefined;
  return naming.v6 || (naming.v5 && version !== undefined && version >= TABLE_NAMING_SCHEMA_VERSION);
}

/**
 * Single source of truth for domain file format detection.
 *
 * Every reader/writer of domain JSON (SubjectAreaService, SemanticEditorProvider,
 * TableLibraryTreeProvider, MigrationService) must use this so that a file is
 * never read as one format and written as another.
 *
 * Rules (in order):
 * 1. `schemaVersion < 4` or a top-level `models` array → `legacy`
 * 2. v5 and v6 names in one file, or v6 names under `schemaVersion < 6` (an
 *    older reader would ignore them and draw an empty diagram), or v5 names
 *    under `schemaVersion >= 6` → `hybrid`
 * 3. `schemaVersion >= 6` → `v6` when every `logical.tables` entry is a string, else `hybrid`
 * 4. Any `logical.models` entry that is neither a string nor a plain object,
 *    or a mix of strings and objects → `hybrid`
 * 5. All entries are objects: `hybrid` if `schemaVersion >= 5`, else `v4`
 * 6. All entries are strings → `v5` (content wins over a stale schemaVersion)
 * 7. Empty `logical.models`: `v5` if `schemaVersion >= 5`, else `v4`
 */
export function detectSubjectAreaFormat(raw: unknown): SubjectAreaFormat {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'legacy';
  }
  const obj = raw as Record<string, unknown>;
  const version = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : undefined;

  if (version !== undefined && version < LEGACY_SCHEMA_VERSION) return 'legacy';
  if (Array.isArray(obj.models)) return 'legacy';

  const naming = namingKeys(obj);
  const tableNaming = version !== undefined && version >= TABLE_NAMING_SCHEMA_VERSION;
  if ((naming.v5 && naming.v6) || (naming.v6 && !tableNaming) || (naming.v5 && tableNaming)) {
    return 'hybrid';
  }

  const logical = plainObject(obj.logical);
  if (tableNaming) {
    const tables = logical?.tables;
    if (tables === undefined) return 'v6';
    return Array.isArray(tables) && tables.every((entry) => typeof entry === 'string') ? 'v6' : 'hybrid';
  }

  const models: unknown[] = Array.isArray(logical?.models) ? logical.models as unknown[] : [];

  let strings = 0;
  let objects = 0;
  for (const entry of models) {
    if (typeof entry === 'string') {
      strings++;
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      objects++;
    } else {
      return 'hybrid';
    }
  }

  if (strings > 0 && objects > 0) return 'hybrid';
  if (objects > 0) {
    return version !== undefined && version >= LIBRARY_SCHEMA_VERSION ? 'hybrid' : 'v4';
  }
  if (strings > 0) return 'v5';
  return version !== undefined && version >= LIBRARY_SCHEMA_VERSION ? 'v5' : 'v4';
}

/**
 * Human-readable explanation for a domain format the editor cannot load,
 * including the remediation. Returns null for `v4`, `v5` and `v6`. Pass the
 * raw document to name a v5 / v6 naming mix rather than the inline-table one.
 */
export function describeUnsupportedSubjectAreaFormat(format: SubjectAreaFormat, filePath: string, raw?: unknown): string | null {
  switch (format) {
    case 'legacy':
      return (
        `Subject area file ${filePath} uses a pre-v${LEGACY_SCHEMA_VERSION} layout ` +
        `(schemaVersion < ${LEGACY_SCHEMA_VERSION} or a top-level "models" array) that is no longer supported. ` +
        'Run "ERD Studio: Migrate Subject Areas to the Central Table Library" to convert it, or move "models"/"relationships" ' +
        `under a "logical" section and set "schemaVersion" to ${WRITTEN_SCHEMA_VERSION}.`
      );
    case 'hybrid': {
      const obj = plainObject(raw);
      if (obj) {
        const naming = namingKeys(obj);
        const version = obj.schemaVersion;
        if (naming.v5 && naming.v6) {
          return (
            `Subject area file ${filePath} mixes the v5 names ("logical.models", "domain") with the v6 names ` +
            '("logical.tables", "subjectArea"). Keep one set: the v6 names with "schemaVersion": 6, or the v5 names with "schemaVersion": 5.'
          );
        }
        if (naming.v6) {
          return (
            `Subject area file ${filePath} uses the v6 names ("logical.tables", "subjectArea") but declares schemaVersion ${String(version)}. ` +
            `Set "schemaVersion" to ${TABLE_NAMING_SCHEMA_VERSION}, or rename the keys back to "logical.models" and "domain".`
          );
        }
        if (naming.v5 && typeof version === 'number' && version >= TABLE_NAMING_SCHEMA_VERSION) {
          return (
            `Subject area file ${filePath} declares schemaVersion ${version} but uses the v5 names ("logical.models", "domain"). ` +
            `Set "schemaVersion" to ${LIBRARY_SCHEMA_VERSION}, or rename the keys to "logical.tables" and "subjectArea".`
          );
        }
        if (typeof version === 'number' && version >= TABLE_NAMING_SCHEMA_VERSION) {
          return `Subject area file ${filePath} has a "logical.tables" entry that is not a table name string.`;
        }
      }
      return (
        `Subject area file ${filePath} mixes inline table objects with table name references ` +
        `(or declares schemaVersion ${LIBRARY_SCHEMA_VERSION} with inline tables). ` +
        'Run "ERD Studio: Migrate Subject Areas to the Central Table Library" to repair it, or edit the file so every entry in ' +
        '"logical.models" is a table name string.'
      );
    }
    default:
      return null;
  }
}

/**
 * Extract model names from a raw domain document regardless of its format.
 * String entries are used as-is; inline objects contribute their `name`;
 * anything else is skipped. v6's `logical.tables` and legacy top-level
 * `models` arrays are honoured.
 */
export function getRawSubjectAreaTableNames(raw: unknown): string[] {
  const obj = plainObject(raw);
  if (!obj) return [];
  const logical = plainObject(obj.logical);
  const source: unknown[] = Array.isArray(logical?.tables)
    ? logical.tables as unknown[]
    : Array.isArray(logical?.models)
      ? logical.models as unknown[]
      : Array.isArray(obj.models)
        ? obj.models
        : [];

  const names: string[] = [];
  for (const entry of source) {
    if (typeof entry === 'string') {
      names.push(entry);
    } else if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).name === 'string') {
      names.push((entry as Record<string, unknown>).name as string);
    }
  }
  return names;
}

/**
 * Type guard: returns true if the domain file uses v5 format (model name references).
 *
 * @deprecated Use {@link detectSubjectAreaFormat} — it distinguishes `hybrid` and
 * `legacy` documents that this boolean cannot express.
 */
export function isSubjectAreaV5(raw: RawSubjectAreaFile): boolean {
  return detectSubjectAreaFormat(raw) === 'v5';
}

// ---------------------------------------------------------------------------
// Project naming (v5 vs v6)
// ---------------------------------------------------------------------------

/**
 * The file naming a project uses (#162): `v5` (`logical-models/`,
 * `logical.models`, …), `v6` (`tables/`, `logical.tables`, …) or `mixed`
 * when the project holds both. The single answer to "which names does this
 * project write?" (#182): a `v5` project keeps writing v5 until it
 * migrates; a `v6` or `mixed` one writes v6.
 */
export type ProjectNaming = 'v5' | 'v6' | 'mixed';

/** What {@link detectProjectNaming} decides from: what a host found on disk. */
export interface ProjectNamingEvidence {
  /** `{semanticDir}/logical-models/` exists. */
  hasLogicalModelsDir: boolean;
  /**
   * `{semanticDir}/tables/` exists and is the table library, not a layer
   * folder (a project made before v6 may have a layer called `tables`; the
   * host decides, see the extension's `tablesDirIsLayer`).
   */
  hasTablesLibrary: boolean;
  /** The format of every subject area file in the project. */
  subjectAreaFormats: Iterable<SubjectAreaFormat>;
}

/**
 * The project's naming, from what is on disk. A project with nothing in
 * either naming (a new one) is `v6`, the naming ERD Studio writes since
 * #182 (before it, `v5`). Files that cannot load (`hybrid`, `legacy`) say
 * nothing either way.
 */
export function detectProjectNaming(evidence: ProjectNamingEvidence): ProjectNaming {
  let v5 = evidence.hasLogicalModelsDir;
  let v6 = evidence.hasTablesLibrary;
  for (const format of evidence.subjectAreaFormats) {
    if (format === 'v4' || format === 'v5') v5 = true;
    else if (format === 'v6') v6 = true;
  }
  if (v5 && v6) return 'mixed';
  return v5 ? 'v5' : 'v6';
}

/** Whether a project in `naming` writes the v6 names (#182): every one but a pure `v5` project. */
export function writesTableNaming(naming: ProjectNaming): boolean {
  return naming !== 'v5';
}

// ---------------------------------------------------------------------------
// Project storage (YAML/JSON vs native DBML)
// ---------------------------------------------------------------------------

/**
 * How a project stores its logical model: `yaml` (model `.yml` files and JSON
 * diagrams, ERD Studio 1.x), `dbml` (native DBML storage, 2.0: `.dbml` table,
 * relationships and diagram files) or `mixed` while it holds both. The single
 * answer to "which format do new files use?", kept apart from
 * {@link ProjectNaming} so its exhaustive switches stay as they are.
 */
export type ProjectStorage = 'yaml' | 'dbml' | 'mixed';

/** What {@link detectProjectStorage} decides from: what a host found on disk. */
export interface ProjectStorageEvidence {
  /** Any `*.yml` table file in `logical-models/` or `tables/` (top level or one folder down). */
  hasYamlTables: boolean;
  /**
   * `logical-models/` exists, empty or not, and `tables/` is not the DBML
   * library: the folder an older version made, where its files go (the rule
   * the extension's `projectNamingOf` already applies).
   */
  hasV5Folder: boolean;
  /** Any `*.dbml` table file in `tables/` (`classifySemanticFile` → `'table'`), or any relationships file. */
  hasDbmlTables: boolean;
  /** The storage of every subject area file: `'json'` or `'dbml'`. */
  subjectAreaStorages: Iterable<'json' | 'dbml'>;
}

/**
 * The project's storage, from what is on disk. YAML evidence is a `.yml`
 * table, the v5 folder, or any JSON subject area; DBML evidence is a DBML
 * library file only, never a `.dbml` diagram alone (a stray export in a layer
 * folder must not make a team project write files 1.x teammates cannot read).
 * A project with neither, a new one, is `dbml`.
 */
export function detectProjectStorage(evidence: ProjectStorageEvidence): ProjectStorage {
  let yaml = evidence.hasYamlTables || evidence.hasV5Folder;
  if (!yaml) {
    for (const storage of evidence.subjectAreaStorages) {
      if (storage === 'json') {
        yaml = true;
        break;
      }
    }
  }
  const dbml = evidence.hasDbmlTables;
  if (yaml && dbml) return 'mixed';
  return yaml ? 'yaml' : 'dbml';
}

/**
 * Whether a project in `storage` writes DBML for new files: `dbml` and
 * `mixed`. The caller also checks that `tables/` is not a layer folder.
 */
export function writesDbml(storage: ProjectStorage): boolean {
  return storage !== 'yaml';
}

// ---------------------------------------------------------------------------
// Summary (lightweight, for tree view listing)
// ---------------------------------------------------------------------------

/** Lightweight summary returned by listSubjectAreas — avoids parsing full JSON. */
export interface SubjectAreaSummary {
  /** Domain slug (filename without extension). */
  domain: string;
  /** Layer derived from parent directory name. */
  layer: Layer;
  /** Absolute path to the domain JSON file. */
  filePath: string;
  /** The file's storage: a `.json` or a `.dbml` diagram. Optional: absent from a host older than native DBML storage. */
  storage?: 'json' | 'dbml';
  /** The same stem exists in both formats in one layer (`x.json` and `x.dbml`): the tree names each one's format. */
  conflict?: true;
}

// ---------------------------------------------------------------------------
// Model templates (configurable via JSON files)
// ---------------------------------------------------------------------------

/**
 * A model template definition loaded from semantic/templates/*.json files.
 *
 * Templates define preset columns and metadata for common model patterns
 * (dimension, fact, bridge, etc.). Users can add custom templates by
 * creating new JSON files in the templates directory.
 *
 * Placeholder syntax in column names/descriptions:
 * - {name} = model name minus prefix (e.g., "customer" from "dim_customer")
 * - {left} = left entity name (bridge templates only)
 * - {right} = right entity name (bridge templates only)
 */
export interface TableTemplate {
  /** Unique template identifier (e.g., "dimension", "fact", "bridge"). */
  id: string;
  /** Display label in the UI (e.g., "Dimension", "Fact Table"). */
  label: string;
  /** Model name prefix (e.g., "dim_", "fct_"). Empty string for no prefix. */
  prefix: string;
  /** Description of what this template is used for. */
  description: string;
  /** Whether this template requires a left entity name (bridge tables). */
  requiresLeftEntity?: boolean;
  /** Whether this template requires a right entity name (bridge tables). */
  requiresRightEntity?: boolean;
  /** Preset columns with placeholder syntax in name/description fields. */
  columns: ColumnDef[];
}
