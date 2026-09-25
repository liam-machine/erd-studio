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

import {
  DomainFileError,
  NON_DOMAIN_DIRS,
  buildUnifiedDomain,
  parseDomainJson,
  toLogicalStage,
  validateDomainDocument,
} from '@erd-studio/core';
import type { DomainSummary, SemanticDomain, UnifiedDomain } from '../types/semantic';
import type { DisplayDomain, DisplayModel, DisplayColumn, DisplayRelationship, PhysicalColumnSource } from '../types/display';
import type { ManifestData } from '../types/manifest';
import type { CatalogData, CatalogColumn } from '../types/catalog';
import type { YmlData } from '../types/ymlData';
import type { Cardinality } from '../types/semantic';
import type { LayerService } from './layerService';
import type { LogicalModelService } from './logicalModelService';
import { normaliseName } from './nameUtils';

// The pure domain parsing lives in @erd-studio/core; these are re-exported so
// existing imports of this module keep working.
export { DomainFileError, NON_DOMAIN_DIRS } from '@erd-studio/core';
export type { DomainFileErrorReason } from '@erd-studio/core';

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
   * Every failure before validation is raised as a `DomainFileError` so
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

    // Empty / invalid JSON (DomainFileError), then validation and repair
    // (DomainValidationError, warnings) — shared with every other host.
    const { obj, format } = validateDomainDocument(parseDomainJson(raw, filePath), filePath);
    return buildUnifiedDomain(obj, format, {
      filePath,
      domainNameFallback: path.basename(filePath, '.json'),
      parentDirName: path.basename(path.dirname(filePath)),
      layers: this.layerService,
      getModel: this.logicalModelService
        ? (name) => this.logicalModelService!.getModel(name)
        : undefined,
      warn: (message) => console.warn(`[DomainService] ${message}`),
    });
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
    return toLogicalStage(unified);
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
