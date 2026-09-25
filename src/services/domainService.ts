/**
 * DomainService — reads semantic domain JSON files from disk.
 *
 * Domain files live at {dbt_project}/.erd-studio/{layer}/{domain}.json
 * Each file is a UnifiedDomain containing logical stage data.
 *
 * Physical domains are not stored on disk — they are derived at runtime
 * by projecting a logical domain's model list through the dbt manifest
 * via buildPhysicalDomain().
 */

import * as fs from 'fs';
import * as path from 'path';

import type { DomainFormat, DomainSummary, Layer, NodePosition, Relationship, SemanticDomain, SemanticModel, StageData, UnifiedDomain, ViewConfig } from '../types/semantic';
import { CURRENT_SCHEMA_VERSION, describeUnsupportedDomainFormat, detectDomainFormat } from '../types/semantic';
import type { DisplayDomain, DisplayModel, DisplayColumn, DisplayRelationship, PhysicalColumnSource } from '../types/display';
import type { ManifestData } from '../types/manifest';
import type { CatalogData, CatalogColumn } from '../types/catalog';
import type { YmlData } from '../types/ymlData';
import type { Cardinality } from '../types/semantic';
import type { LayerService } from './layerService';
import { LOGICAL_MODELS_DIR } from './logicalModelService';
import type { LogicalModelService } from './logicalModelService';
import { normaliseName } from './nameUtils';

/**
 * Minimal relationship test shape accepted by derivePhysicalRelationships().
 * Both ManifestRelationshipTest and YmlRelationshipTest satisfy this interface.
 */
interface RelationshipTest {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
}

const DEFAULT_SEMANTIC_DIR = '.erd-studio';

/**
 * Sub-directories of the semantic dir that never contain domain files.
 *
 * The single source of truth for "is this `{semanticDir}/x/y.json` a domain?".
 * The watcher classifies delete events through it, and the custom editor
 * refuses to render a canvas for anything it excludes — a template opened from
 * the explorer is a JSON file to edit, not a diagram to draw.
 */
export const NON_DOMAIN_DIRS: ReadonlySet<string> = new Set([
  'templates', LOGICAL_MODELS_DIR, 'logical', 'physical',
]);

/**
 * Does `fsPath` have the shape of a domain file — `{layer}/{domain}.json`,
 * where the parent segment is a layer rather than one of the reserved
 * directories, and neither segment is hidden?
 *
 * Shape only: it says nothing about whether the layer is configured or the
 * file parses. Callers that know the semantic root should prefer
 * `classifySemanticPath()`, which also proves the path is *under* it; this one
 * exists for the custom editor, which is handed a document whose path the
 * `**​/.erd-studio/*​/*.json` selector has already placed.
 */
export function isDomainFilePath(fsPath: string): boolean {
  const file = path.basename(fsPath);
  const dir = path.basename(path.dirname(fsPath));
  return (
    file.endsWith('.json') &&
    !file.startsWith('.') &&
    !dir.startsWith('.') &&
    !NON_DOMAIN_DIRS.has(dir)
  );
}

/** Why a domain file could not be turned into a `UnifiedDomain`. */
export type DomainFileErrorReason = 'missing' | 'unreadable' | 'empty' | 'invalid-json';

/**
 * A domain file that could not be read or parsed.
 *
 * `transient` is the point of the type. A domain file is replaced, not patched
 * in place — by `git checkout`, by a formatter, by an AI agent following the
 * installed harness — and for a few milliseconds mid-replacement it is empty
 * or truncated. Reading it in that window is not an error about the project;
 * it is an error about the timing of the read, and the fix is to read again.
 * `ManifestService` already treats a malformed `manifest.json` this way (dbt
 * mid-write); this is the same courtesy for the file the canvas is built from.
 */
export class DomainFileError extends Error {
  readonly transient: boolean;

  constructor(
    readonly reason: DomainFileErrorReason,
    readonly filePath: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainFileError';
    this.transient = reason === 'empty' || reason === 'invalid-json';
  }
}

const VALID_CARDINALITIES: ReadonlySet<Cardinality> = new Set<Cardinality>([
  'many-to-one', 'one-to-one', 'one-to-many', 'many-to-many',
]);

/**
 * Physical column sources, most authoritative first.
 *
 * The warehouse catalog observed what was built; a schema .yml `data_type:` is
 * the author's assertion; the manifest is a compiled copy of that assertion; a
 * bare source file proves only that the model exists. Used to pick the one
 * source a model's `provenance.types` names.
 */
const SOURCE_AUTHORITY: readonly PhysicalColumnSource[] = ['catalog', 'yml', 'manifest', 'file'];

/**
 * Rewrite the `domain` slug in the raw text of a domain file.
 *
 * Operates on the parsed JSON document rather than DomainService's resolved
 * UnifiedDomain so that v5 model name references, `stubColumns`, and any
 * unknown keys survive byte-for-byte (apart from re-indentation). Used by the
 * Rename Domain command.
 */
export function renameDomainInRaw(rawText: string, newSlug: string): string {
  const parsed = JSON.parse(rawText) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Domain file does not contain a JSON object');
  }
  const doc = parsed as Record<string, unknown>;
  doc.domain = newSlug;
  return JSON.stringify(doc, null, 2) + '\n';
}

export class DomainService {
  private logicalModelService: LogicalModelService | null = null;

  constructor(private readonly layerService: LayerService) {}

  /**
   * Set the LogicalModelService for resolving v5 model references.
   * Called after construction since DomainService may be instantiated before
   * LogicalModelService is available (circular dependency avoidance).
   */
  setLogicalModelService(service: LogicalModelService): void {
    this.logicalModelService = service;
  }

  /**
   * Discover all semantic domain JSON files under .erd-studio/,
   * grouped by layer. Returns lightweight summaries (no full parse).
   *
   * Directory structure:
   *   .erd-studio/{layer}/*.json
   */
  listDomains(projectPath: string, semanticDir = DEFAULT_SEMANTIC_DIR): DomainSummary[] {
    const basePath = path.join(projectPath, semanticDir);

    if (!fs.existsSync(basePath)) {
      return [];
    }

    const summaries: DomainSummary[] = [];
    const layers = this.layerService.getAllLayers();

    for (const layerConfig of layers) {
      const layer = layerConfig.id;
      const layerDir = path.join(basePath, layer);
      if (!fs.existsSync(layerDir)) {
        continue;
      }

      let entries: string[];
      try {
        entries = fs.readdirSync(layerDir);
      } catch (err) {
        console.warn(
          `[DomainService] Unable to read directory ${layerDir}: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith('.json')) {
          continue;
        }

        summaries.push({
          domain: path.basename(entry, '.json'),
          layer,
          filePath: path.join(layerDir, entry),
        });
      }
    }

    return summaries;
  }

  /**
   * Read and parse a domain JSON file, returning a UnifiedDomain.
   *
   * Every failure before `validateDomain` is raised as a `DomainFileError` so
   * callers can tell a file that is momentarily unreadable (empty or truncated
   * because something is writing it right now) from one that is genuinely
   * wrong. See `DomainFileError` for why that distinction is load-bearing.
   */
  getDomain(filePath: string): UnifiedDomain {
    if (!fs.existsSync(filePath)) {
      throw new DomainFileError('missing', filePath, `Domain file not found: ${filePath}`);
    }

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new DomainFileError('unreadable', filePath, `Failed to read domain file: ${message}`);
    }

    if (raw.trim() === '') {
      // Almost always a file mid-creation: the create event lands a zero-byte
      // file and the content follows milliseconds later. Say what is true of
      // the file rather than echoing "Unexpected end of JSON input", which
      // reads as corruption when nothing is corrupt.
      throw new DomainFileError('empty', filePath, `Domain file is empty: ${filePath}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new DomainFileError(
        'invalid-json',
        filePath,
        `Invalid JSON in domain file ${filePath}: ${message}`,
      );
    }

    return this.validateDomain(parsed, filePath);
  }

  /**
   * Extract the logical stage from a UnifiedDomain, returning a SemanticDomain.
   *
   * Physical stage is not supported here — use buildPhysicalDomain() instead.
   */
  getDomainStage(filePath: string): SemanticDomain {
    return DomainService.toLogicalStage(this.getDomain(filePath));
  }

  /**
   * Project an already-read `UnifiedDomain` onto its logical stage.
   *
   * Pure, and separate from `getDomainStage` so a caller holding a
   * `UnifiedDomain` does not have to read the file a second time — a second
   * read is a second chance to catch the file mid-replacement.
   */
  static toLogicalStage(unified: UnifiedDomain): SemanticDomain {
    const stageData = unified.logical;

    return {
      schemaVersion: unified.schemaVersion,
      domain: unified.domain,
      layer: unified.layer,
      stage: 'logical',
      description: unified.description,
      ...(unified.modelFolder ? { modelFolder: unified.modelFolder } : {}),
      models: stageData.models,
      relationships: stageData.relationships,
    };
  }

  /**
   * Build a physical DisplayDomain by projecting a unified domain's logical
   * stage through what exists in the dbt project.
   *
   * Physical domains are not stored on disk — they are derived at runtime.
   * A model EXISTS in the project when ANY of these holds: a `.sql`, `.py` or
   * `.csv` source file sits under a configured model / seed / snapshot path AND
   * dbt has not disabled the model; a dbt schema `.yml` declares it; the
   * compiled manifest carries a node for it; `target/catalog.json` carries a
   * relation for it. Existence deliberately does not require a compiled
   * manifest — greying out every node because `dbt compile` has not been run
   * recently says nothing true about the project.
   *
   * A yml-only model counts as existing even though it is not unambiguously
   * part of the project (dbt warns about a schema patch with no matching node,
   * and `ref()` on it fails to compile). Hiding a documented model is the worse
   * error, and it is the one users report as a bug.
   *
   * A model found in NO source is still EMITTED, with `existsInProject: false`,
   * a `missingReason` and no columns, so it ghosts on the canvas instead of
   * silently vanishing. Phantoms never join `physicalModelNames`, so no
   * relationship is ever derived for one.
   *
   * COLUMNS come from two KINDS of source. The DECLARED list is the yml when
   * present, otherwise the manifest, per model — one source, because the
   * manifest's column list is a compiled copy of the same yml patch, so where
   * they disagree the manifest is merely stale. The OBSERVED list is the
   * catalog, an independent look at the warehouse relation, so where it
   * disagrees that is information. When a catalog node resolves, the rendered
   * list is their UNION in catalog order with declared-only columns appended;
   * with no catalog it is the declared list alone, exactly as before.
   *
   * The union is deliberate and asymmetric. `dbt docs generate` runs far less
   * often than `dbt run`, so letting the catalog replace the list would hide a
   * column added to the SQL and the yml an hour ago and propose a sync plan
   * that DELETES it. The union's opposite cost — a yml documenting a column the
   * warehouse does not have renders a phantom column — is milder: the user
   * authored it, and a column that is shown is inspectable, while one that is
   * dropped is invisible.
   *
   * DATA TYPE is an n-source fallthrough: catalog, then the declared
   * `data_type:`, then the manifest's copy of it, then ''. DESCRIPTION runs the
   * other way — yml, then manifest, then (seeds and snapshots only) their
   * `seeds:` / `snapshots:` documentation, then the catalog comment — because
   * `persist_docs` writes the dbt description INTO the warehouse comment, so a
   * catalog comment is usually a stale echo of the yml.
   *
   * A column present in both sources keeps the DECLARED spelling for display.
   * Snowflake reports UPPERCASE column keys; letting them win would SHOUT every
   * label on the canvas and change every React key for no correctness gain,
   * since comparison keys on `normaliseName` either way.
   *
   * A model known only by its source file renders with zero columns: seeding it
   * with the logical columns would fabricate a shape nothing has verified, and
   * would make the discrepancy report call every one of them 'matched'.
   *
   * Relationship tests are the union of yml and manifest tests (deduped), and
   * cardinality uses uniqueness tests merged from both sources.
   *
   * Model and column name matching is case-insensitive (dbt identifiers are
   * case-insensitive on most warehouses); the logical spelling is kept for
   * display so positions and discrepancy keys stay stable.
   *
   * Uses the global viewConfig for positions so layout is consistent across all stages.
   */
  buildPhysicalDomain(
    unifiedDomain: UnifiedDomain,
    ymlData: YmlData,
    manifest?: ManifestData,
    catalog?: CatalogData,
  ): DisplayDomain {
    const logicalStage = unifiedDomain.logical;
    const physicalModelNames = new Set<string>();

    const ymlIndex = indexByNormalisedName(ymlData.models);
    const manifestIndex = manifest ? indexByNormalisedName(manifest.models) : undefined;

    const models: DisplayModel[] = logicalStage.models.map(model => {
        const key = normaliseName(model.name);
        const ymlModel = ymlData.models.get(model.name) ?? ymlIndex.get(key);
        const manifestModel = manifest?.models.get(model.name) ?? manifestIndex?.get(key);
        // `sourceFiles` is keyed by an already-normalised stem — look it up with
        // normaliseName(), never through indexByNormalisedName().
        const sourceFile = ymlData.sourceFiles?.get(key);
        // A disabled model's .sql is on disk but `ref()` to it fails, so the bare
        // file must not upgrade it to "exists". The veto applies to THAT branch
        // only: a disabled model still declared in a yml keeps what the yml says,
        // because that is a different question.
        const disabled = manifest?.disabledModels.has(key) ?? false;
        // unique_id FIRST: catalog keys ARE manifest unique_ids, so when a
        // manifest resolved the model that join is exact and already knows which
        // version dbt marks latest. byName is a best-effort index for the
        // manifest-absent case (highest version wins, first entry on a tie).
        const catalogNode =
          (manifestModel ? catalog?.byUniqueId.get(manifestModel.uniqueId) : undefined)
          ?? catalog?.byName.get(key);
        // Seed / snapshot documentation: DESCRIPTIONS ONLY. It never decides
        // existence, adds a column or pulls in an edge — those stay the job of
        // the model sources above, exactly as before seeds were documented.
        const ymlDoc = ymlData.resourceDocs?.get(key);
        const manifestDoc = manifest?.resourceDocs?.get(key);
        const docColumnDescriptions = new Map<string, string>();
        for (const dc of [...(manifestDoc?.columns ?? []), ...(ymlDoc?.columns ?? [])]) {
          // yml second so it overwrites the manifest's compiled copy.
          if (dc.description) { docColumnDescriptions.set(normaliseName(dc.name), dc.description); }
        }

        if (!ymlModel && !manifestModel && !catalogNode && !(sourceFile && !disabled)) {
          // Phantom: the design references a model the dbt project does not have.
          // Emitted (not dropped) so the canvas can say so, but kept out of
          // physicalModelNames so it pulls in no edges.
          return {
            name: model.name,
            schema: '',
            description: model.description || '',
            columns: [],
            rationale: model.rationale,
            grain: model.grain,
            modelRole: model.modelRole,
            existsInProject: false,
            missingReason: disabled ? ('disabled' as const) : ('absent' as const),
          };
        }
        physicalModelNames.add(model.name);

        // Columns come from yml when present, otherwise from the manifest. The
        // two are ONE 'declared' source with yml winning per model: the
        // manifest's column list is a compiled copy of the same yml patch, so
        // where they disagree the manifest is simply stale.
        const declaredSource: PhysicalColumnSource | undefined =
          ymlModel ? 'yml' : (manifestModel ? 'manifest' : undefined);
        const declaredColumns: { name: string; dataType: string | null; description: string }[] = ymlModel
          ? (ymlModel.columns ?? []).map(c => ({ name: c.name, dataType: c.dataType, description: c.description }))
          : (manifestModel?.columns ?? []).map(c => ({ name: c.name, dataType: c.data_type, description: c.description }));

        const manifestByCol = new Map(
          (manifestModel?.columns ?? []).map(mc => [normaliseName(mc.name), mc]),
        );
        const declaredByCol = new Map(
          declaredColumns.map(dc => [normaliseName(dc.name), dc]),
        );

        // The rendered list: catalog order first (the warehouse's own ordinal
        // positions), then any declared column the catalog has not seen. With no
        // catalog node it is the declared list, unchanged from before.
        type ColumnEntry = {
          key: string;
          declared?: { name: string; dataType: string | null; description: string };
          observed?: CatalogColumn;
        };
        const entries: ColumnEntry[] = [];
        const seenColumns = new Set<string>();
        if (catalogNode) {
          for (const cc of catalogNode.columns) {
            const ck = normaliseName(cc.name);
            if (seenColumns.has(ck)) { continue; }
            seenColumns.add(ck);
            entries.push({ key: ck, declared: declaredByCol.get(ck), observed: cc });
          }
        }
        for (const dc of declaredColumns) {
          const dk = normaliseName(dc.name);
          if (seenColumns.has(dk)) { continue; }
          seenColumns.add(dk);
          entries.push({ key: dk, declared: dc });
        }

        // Which sources actually supplied a data type, so provenance can name
        // the most authoritative one rather than guessing from the column list.
        const typeSources = new Set<PhysicalColumnSource>();

        const columns: DisplayColumn[] = entries.map(entry => {
          const manifestCol = manifestByCol.get(entry.key);

          // Ordered fallthrough — what the warehouse reports, then the declared
          // assertion, then the manifest's compiled copy of it, then ''.
          let dataType = '';
          if (entry.observed?.dataType) {
            dataType = entry.observed.dataType;
            typeSources.add('catalog');
          } else if (entry.declared?.dataType) {
            dataType = entry.declared.dataType;
            if (declaredSource) { typeSources.add(declaredSource); }
          } else if (manifestCol?.data_type) {
            dataType = manifestCol.data_type;
            typeSources.add('manifest');
          }

          return {
            // The declared spelling wins whenever there is one — see the
            // UPPERCASE note on this method.
            name: entry.declared?.name ?? entry.observed?.name ?? '',
            dataType,
            // The human's words beat the warehouse's echo of them: persist_docs
            // copies the dbt description into the relation comment.
            description: entry.declared?.description || manifestCol?.description
              || docColumnDescriptions.get(entry.key) || entry.observed?.comment || '',
            isPrimaryKey: false,
            isForeignKey: false,
            isNaturalKey: false,
          };
        });

        // Carry forward PK/FK/NK/SCD flags from logical domain columns
        const logicalColumns = model.columns ?? [];
        for (const dc of columns) {
          const dcKey = normaliseName(dc.name);
          const logicalCol = logicalColumns.find(c => normaliseName(c.name) === dcKey);
          if (logicalCol) {
            dc.isPrimaryKey = logicalCol.isPrimaryKey ?? false;
            dc.isForeignKey = logicalCol.isForeignKey ?? false;
            dc.isNaturalKey = logicalCol.isNaturalKey ?? false;
            if (logicalCol.scdType !== undefined) { dc.scdType = logicalCol.scdType; }
            if (logicalCol.additiveType !== undefined) { dc.additiveType = logicalCol.additiveType; }
          }
        }

        // Provenance: who contributed the column list, and who supplied the
        // types. `columns` is an array because a model's shape can come from
        // more than one source; a single label would lie about it.
        const columnSources: PhysicalColumnSource[] = [];
        if (catalogNode && catalogNode.columns.length > 0) { columnSources.push('catalog'); }
        if (declaredSource && declaredColumns.length > 0) { columnSources.push(declaredSource); }
        if (columnSources.length === 0) {
          // Nothing contributed a column: a declared or catalogued model with
          // none documented, or a model known only by the file that defines it.
          // Name whichever source resolved it, so the chip is never blank.
          columnSources.push(declaredSource ?? (catalogNode ? 'catalog' : 'file'));
        }
        const types = SOURCE_AUTHORITY.find(s => typeSources.has(s)) ?? columnSources[0];

        return {
          name: model.name,
          // MANIFEST FIRST, not catalog first. The two agree on the value and
          // disagree only on case — no adapter lowercases `metadata.schema`, so
          // Snowflake's catalog says ANALYTICS where the manifest carries the
          // lowercase `analytics` the user actually wrote. With neither source
          // the honest answer is '' and the node badge falls back to the layer.
          schema: manifestModel?.schema || catalogNode?.schema || '',
          description: ymlModel?.description || manifestModel?.description
            || ymlDoc?.description || manifestDoc?.description
            || catalogNode?.comment || model.description || '',
          columns,
          rationale: model.rationale,
          grain: model.grain,
          modelRole: model.modelRole,
          existsInProject: true,
          provenance: { columns: columnSources, types },
        };
      });

    // Relationship tests: union of yml (primary) and manifest, deduped.
    // Uniqueness info is likewise merged from both sources.
    const mergedRelationshipTests = mergeRelationshipTests(
      ymlData.relationshipTests,
      manifest?.relationshipTests,
    );
    const mergedUniqueColumns = mergeUniqueMaps(
      ymlData.uniqueColumns,
      manifest?.uniqueColumns,
    );
    const mergedCompositeGroups = mergeCompositeGroups(
      ymlData.compositeUniqueGroups,
      manifest?.compositeUniqueGroups,
    );

    const relationships = derivePhysicalRelationships(
      mergedRelationshipTests,
      physicalModelNames,
      mergedUniqueColumns,
      mergedCompositeGroups,
    );

    return {
      schemaVersion: unifiedDomain.schemaVersion,
      domain: unifiedDomain.domain,
      layer: unifiedDomain.layer,
      stage: 'physical',
      description: unifiedDomain.description,
      modelFolder: unifiedDomain.modelFolder,
      models,
      relationships,
      viewConfig: unifiedDomain.viewConfig,
      readOnly: true,
      positionDraggable: true,
      physicalSources: {
        yml: ymlData.models.size > 0,
        manifest: (manifest?.models.size ?? 0) > 0,
        catalog: (catalog?.byUniqueId.size ?? 0) > 0,
      },
    };
  }

  /**
   * Validate parsed JSON and return a typed UnifiedDomain.
   */
  private validateDomain(data: unknown, filePath: string): UnifiedDomain {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`Domain file ${filePath} does not contain a JSON object`);
    }

    const obj = data as Record<string, unknown>;

    // Schema version check
    if (typeof obj.schemaVersion !== 'number') {
      throw new Error(
        `Domain file ${filePath} is missing a valid "schemaVersion" field`
      );
    }

    if (obj.schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Domain file ${filePath} has schemaVersion ${obj.schemaVersion} ` +
        `but this extension only supports up to version ${CURRENT_SCHEMA_VERSION}. ` +
        'Please update the extension.'
      );
    }

    // Format check — legacy (pre-v4) and hybrid (mixed / self-contradicting)
    // documents are rejected with a remediation hint rather than silently
    // loaded as an empty or half-resolved domain.
    const format = detectDomainFormat(obj);
    const unsupported = describeUnsupportedDomainFormat(format, filePath);
    if (unsupported) {
      throw new Error(unsupported);
    }

    return this.validateDomainFields(obj, filePath, format);
  }

  /**
   * Validate a unified domain file.
   */
  private validateDomainFields(obj: Record<string, unknown>, filePath: string, format: DomainFormat): UnifiedDomain {
    const domain = typeof obj.domain === 'string' ? obj.domain : path.basename(filePath, '.json');
    const layer = this.parseLayer(obj.layer, filePath);

    const emptyStage: StageData = { models: [], relationships: [] };

    // Global viewConfig — fall back to stage-level viewConfig for existing files
    const globalViewConfig = this.parseViewConfig(
      obj.viewConfig
        ?? (obj.logical as Record<string, unknown> | undefined)?.viewConfig,
    );

    // Parse stubColumns — optional string[] of model names with stub display
    const stubColumns = Array.isArray(obj.stubColumns)
      ? (obj.stubColumns as unknown[]).filter((v): v is string => typeof v === 'string')
      : undefined;

    return {
      schemaVersion: obj.schemaVersion as number,
      domain,
      layer,
      description: typeof obj.description === 'string' ? obj.description : '',
      ...(typeof obj.modelFolder === 'string' ? { modelFolder: obj.modelFolder } : {}),
      logical: this.parseStageData(obj.logical, format, filePath) ?? { ...emptyStage },
      ...(stubColumns && stubColumns.length > 0 ? { stubColumns } : {}),
      viewConfig: globalViewConfig,
    };
  }

  /**
   * Parse a stage data section from a domain file.
   * Handles both v4 (inline SemanticModel[]) and v5 (string[] name references)
   * as decided by {@link detectDomainFormat} — hybrid/legacy documents are
   * rejected before this point, so every entry is guaranteed to match `format`.
   * For v5, resolves model names via LogicalModelService.
   * Returns null if the section is missing or invalid.
   */
  private parseStageData(value: unknown, format: DomainFormat, filePath: string): StageData | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const obj = value as Record<string, unknown>;
    const rawModels = Array.isArray(obj.models) ? obj.models : [];
    const relationships = this.parseRelationships(obj.relationships, filePath);

    let models: SemanticModel[];
    if (format === 'v5') {
      const names = rawModels.filter((m): m is string => typeof m === 'string');
      if (this.logicalModelService) {
        // Resolve model name references from logical-models/*.yml
        models = [];
        for (const name of names) {
          const model = this.logicalModelService.getModel(name);
          if (model) {
            models.push(model);
          } else {
            // Broken reference — create a placeholder so the UI can show an error
            console.warn(`[DomainService] Model "${name}" not found in logical-models/`);
            models.push({ name, columns: [] });
          }
        }
      } else {
        // v5 format but no LogicalModelService available (e.g., testing)
        // Create placeholder models from names
        models = names.map(name => ({ name, columns: [] }));
      }
    } else {
      // v4 format: inline model objects — each must carry a string name
      models = [];
      for (const entry of rawModels) {
        const candidate = entry as Record<string, unknown> | null;
        if (candidate && typeof candidate === 'object' && typeof candidate.name === 'string') {
          models.push(candidate as unknown as SemanticModel);
        } else {
          console.warn(`[DomainService] Skipping inline model without a string "name" in ${filePath}`);
        }
      }
    }

    return { models, relationships };
  }

  /**
   * Validate the relationships array entry-by-entry. Entries missing any of the
   * four string endpoints are dropped with a warning; an unrecognised
   * cardinality falls back to many-to-one.
   */
  private parseRelationships(value: unknown, filePath: string): Relationship[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const relationships: Relationship[] = [];
    for (const entry of value) {
      const r = entry as Record<string, unknown> | null;
      if (
        !r || typeof r !== 'object' || Array.isArray(r) ||
        typeof r.fromModel !== 'string' || typeof r.fromColumn !== 'string' ||
        typeof r.toModel !== 'string' || typeof r.toColumn !== 'string'
      ) {
        console.warn(`[DomainService] Skipping malformed relationship entry in ${filePath}: ${JSON.stringify(entry)}`);
        continue;
      }

      const cardinality = VALID_CARDINALITIES.has(r.cardinality as Cardinality)
        ? (r.cardinality as Cardinality)
        : 'many-to-one';
      if (cardinality !== r.cardinality) {
        console.warn(
          `[DomainService] Relationship ${r.fromModel}.${r.fromColumn} → ${r.toModel}.${r.toColumn} in ${filePath} ` +
          `has invalid cardinality ${JSON.stringify(r.cardinality)}; defaulting to many-to-one`,
        );
      }

      relationships.push({
        ...(r as unknown as Relationship),
        cardinality,
      });
    }
    return relationships;
  }

  private parseLayer(value: unknown, filePath: string): Layer {
    if (typeof value === 'string' && this.layerService.hasLayer(value)) {
      return value;
    }

    // Fall back to inferring from directory name
    const parentDir = path.basename(path.dirname(filePath));
    if (this.layerService.hasLayer(parentDir)) {
      return parentDir;
    }

    const validLayers = this.layerService.getValidLayerIds().join(', ');
    throw new Error(
      `Domain file ${filePath} has invalid layer "${String(value)}". ` +
      `Expected one of: ${validLayers}`,
    );
  }

  private parseViewConfig(value: unknown): ViewConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    const obj = value as Record<string, unknown>;
    return {
      showFkEdges: typeof obj.showFkEdges === 'boolean' ? obj.showFkEdges : undefined,
      layoutOptions: obj.layoutOptions && typeof obj.layoutOptions === 'object' && !Array.isArray(obj.layoutOptions)
        ? (obj.layoutOptions as Record<string, string>)
        : undefined,
      positions: obj.positions && typeof obj.positions === 'object' && !Array.isArray(obj.positions)
        ? this.parsePositions(obj.positions as Record<string, unknown>)
        : undefined,
      annotations: Array.isArray(obj.annotations)
        ? (obj.annotations as unknown[]).filter(
            (a): a is import('../types/semantic').Annotation => {
              const r = a as Record<string, unknown>;
              return typeof r?.id === 'string' && typeof r?.x === 'number' && typeof r?.y === 'number';
            },
          )
        : undefined,
    };
  }

  /**
   * Keep only position entries with finite numeric x/y. Malformed entries
   * (string coordinates, null, non-objects) are dropped so the model is
   * auto-positioned instead of reaching the canvas with NaN coordinates.
   */
  private parsePositions(value: Record<string, unknown>): Record<string, NodePosition> {
    const positions: Record<string, NodePosition> = {};
    for (const [name, entry] of Object.entries(value)) {
      const p = entry as Record<string, unknown> | null;
      if (
        p && typeof p === 'object' && !Array.isArray(p) &&
        typeof p.x === 'number' && Number.isFinite(p.x) &&
        typeof p.y === 'number' && Number.isFinite(p.y)
      ) {
        positions[name] = { x: p.x, y: p.y };
      } else {
        console.warn(`[DomainService] Ignoring malformed viewConfig.positions entry for "${name}"`);
      }
    }
    return positions;
  }
}

// ---------------------------------------------------------------------------
// Physical relationship derivation (yml + manifest tests)
// ---------------------------------------------------------------------------

/**
 * Derive physical relationships from relationship tests (yml and/or manifest).
 * Accepts any object with the RelationshipTest shape (structural typing).
 *
 * Each relationship test becomes one edge. Cardinality is derived from
 * uniqueness tests:
 * - `unique` test on a column → that side is "one"
 * - `unique_combination_of_columns` → side is "one" if all columns in the
 *   composite group are covered by relationship tests between the same model pair
 * - No uniqueness test → that side defaults to "many"
 *
 * Results are scoped to only models present in the domain's physical model set,
 * preventing conformed dimensions from pulling in relationships to models
 * outside the current domain. Model and column names are matched
 * case-insensitively; emitted edges use the spelling from `physicalModelNames`
 * so they line up with the physical DisplayModels.
 */
export function derivePhysicalRelationships(
  relationshipTests: RelationshipTest[],
  physicalModelNames: Set<string>,
  uniqueColumns: Map<string, Set<string>>,
  compositeUniqueGroups: Map<string, string[][]>,
): DisplayRelationship[] {
  // normalised name → display name (as used by the physical DisplayModels)
  const canonicalModelNames = new Map<string, string>();
  for (const name of physicalModelNames) {
    const key = normaliseName(name);
    if (!canonicalModelNames.has(key)) {
      canonicalModelNames.set(key, name);
    }
  }

  // Filter to relationships where both models are in this domain, rewriting
  // model names to the domain's spelling.
  const domainTests: RelationshipTest[] = [];
  for (const rel of relationshipTests) {
    const fromModel = canonicalModelNames.get(normaliseName(rel.fromModel));
    const toModel = canonicalModelNames.get(normaliseName(rel.toModel));
    if (fromModel && toModel) {
      domainTests.push({ ...rel, fromModel, toModel });
    }
  }

  // Uniqueness lookups keyed by normalised model / column name
  const normalisedUnique = new Map<string, Set<string>>();
  for (const [model, cols] of uniqueColumns) {
    const key = normaliseName(model);
    let set = normalisedUnique.get(key);
    if (!set) {
      set = new Set<string>();
      normalisedUnique.set(key, set);
    }
    for (const col of cols) { set.add(normaliseName(col)); }
  }
  const normalisedComposite = new Map<string, string[][]>();
  for (const [model, groups] of compositeUniqueGroups) {
    const key = normaliseName(model);
    const list = normalisedComposite.get(key) ?? [];
    for (const group of groups) { list.push(group.map(normaliseName)); }
    normalisedComposite.set(key, list);
  }

  // Group tests by (fromModel, toModel) pair for composite unique checks
  const pairKey = (from: string, to: string) => `${normaliseName(from)}\0${normaliseName(to)}`;
  const testsByPair = new Map<string, RelationshipTest[]>();
  for (const test of domainTests) {
    const key = pairKey(test.fromModel, test.toModel);
    let group = testsByPair.get(key);
    if (!group) {
      group = [];
      testsByPair.set(key, group);
    }
    group.push(test);
  }

  return domainTests.map(rel => ({
    fromModel: rel.fromModel,
    fromColumn: rel.fromColumn,
    toModel: rel.toModel,
    toColumn: rel.toColumn,
    cardinality: deriveCardinality(
      rel,
      testsByPair.get(pairKey(rel.fromModel, rel.toModel)) ?? [],
      normalisedUnique,
      normalisedComposite,
    ),
  }));
}

/**
 * True if a relationship references the given (model, column) on either endpoint.
 * Used to cascade-delete relationships when a column is removed.
 */
export function relationshipReferencesColumn(
  rel: { fromModel?: unknown; fromColumn?: unknown; toModel?: unknown; toColumn?: unknown },
  modelName: string,
  columnName: string,
): boolean {
  return (
    (rel.fromModel === modelName && rel.fromColumn === columnName) ||
    (rel.toModel === modelName && rel.toColumn === columnName)
  );
}

/**
 * Derive cardinality for a single relationship edge based on uniqueness tests.
 */
function deriveCardinality(
  rel: RelationshipTest,
  allTestsBetweenPair: RelationshipTest[],
  uniqueColumns: Map<string, Set<string>>,
  compositeUniqueGroups: Map<string, string[][]>,
): Cardinality {
  const fromUnique = isColumnEffectivelyUnique(
    rel.fromModel, rel.fromColumn, 'from',
    allTestsBetweenPair, uniqueColumns, compositeUniqueGroups,
  );
  const toUnique = isColumnEffectivelyUnique(
    rel.toModel, rel.toColumn, 'to',
    allTestsBetweenPair, uniqueColumns, compositeUniqueGroups,
  );

  if (fromUnique && toUnique) { return 'one-to-one'; }
  if (!fromUnique && toUnique) { return 'many-to-one'; }
  if (fromUnique && !toUnique) { return 'one-to-many'; }
  return 'many-to-many';
}

/**
 * Check if a column is effectively unique for cardinality purposes.
 *
 * A column is "unique" if:
 * 1. It has a standalone `unique` test, OR
 * 2. It's part of a `unique_combination_of_columns` group where ALL columns
 *    in that group are covered by relationship tests between the same model pair
 *    (meaning the full composite key is present in the relationship edges).
 *
 * `uniqueColumns` / `compositeUniqueGroups` must already be keyed by
 * normalised (lower-cased) model and column names.
 */
function isColumnEffectivelyUnique(
  model: string,
  column: string,
  side: 'from' | 'to',
  allTestsBetweenPair: RelationshipTest[],
  uniqueColumns: Map<string, Set<string>>,
  compositeUniqueGroups: Map<string, string[][]>,
): boolean {
  const modelKey = normaliseName(model);
  const columnKey = normaliseName(column);

  // 1. Single-column unique test
  if (uniqueColumns.get(modelKey)?.has(columnKey)) {
    return true;
  }

  // 2. Composite unique — column must be in the group, and ALL columns in
  //    the group must be covered by relationship tests for this model pair
  const groups = compositeUniqueGroups.get(modelKey) ?? [];
  const pairColumns = new Set(
    allTestsBetweenPair.map(t => normaliseName(side === 'from' ? t.fromColumn : t.toColumn)),
  );

  for (const group of groups) {
    if (group.includes(columnKey) && group.every(col => pairColumns.has(col))) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Merge helpers — combine data from yml (primary) and manifest
// ---------------------------------------------------------------------------

/** Build a lookup keyed by normalised model name (first entry wins on collision). */
function indexByNormalisedName<T>(map: Map<string, T>): Map<string, T> {
  const index = new Map<string, T>();
  for (const [name, value] of map) {
    const key = normaliseName(name);
    if (!index.has(key)) {
      index.set(key, value);
    }
  }
  return index;
}

/**
 * Union relationship tests from yml (primary) and manifest, deduped by
 * (fromModel, fromColumn, toModel, toColumn) — case-insensitive.
 */
function mergeRelationshipTests(
  primary: RelationshipTest[],
  secondary?: RelationshipTest[],
): RelationshipTest[] {
  if (!secondary || secondary.length === 0) { return primary; }

  const seen = new Set<string>();
  const merged: RelationshipTest[] = [];
  for (const test of [...primary, ...secondary]) {
    const key = [test.fromModel, test.fromColumn, test.toModel, test.toColumn]
      .map(normaliseName)
      .join('\0');
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(test);
    }
  }
  return merged;
}

/** Merge two unique-column maps: union of columns per model. */
export function mergeUniqueMaps(
  primary: Map<string, Set<string>>,
  secondary?: Map<string, Set<string>>,
): Map<string, Set<string>> {
  if (!secondary) { return primary; }

  const merged = new Map<string, Set<string>>();
  // Copy primary
  for (const [model, cols] of primary) {
    merged.set(model, new Set(cols));
  }
  // Union secondary
  for (const [model, cols] of secondary) {
    const existing = merged.get(model);
    if (existing) {
      for (const col of cols) { existing.add(col); }
    } else {
      merged.set(model, new Set(cols));
    }
  }
  return merged;
}

/** Merge two composite-unique-group maps: concatenate groups per model. */
export function mergeCompositeGroups(
  primary: Map<string, string[][]>,
  secondary?: Map<string, string[][]>,
): Map<string, string[][]> {
  if (!secondary) { return primary; }

  const merged = new Map<string, string[][]>();
  // Copy primary
  for (const [model, groups] of primary) {
    merged.set(model, [...groups]);
  }
  // Append secondary (dedupe by content)
  for (const [model, groups] of secondary) {
    const existing = merged.get(model) ?? [];
    for (const group of groups) {
      const key = [...group].sort().join('\0');
      const alreadyExists = existing.some(g => [...g].sort().join('\0') === key);
      if (!alreadyExists) {
        existing.push(group);
      }
    }
    merged.set(model, existing);
  }
  return merged;
}
