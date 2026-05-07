/**
 * DomainService — reads semantic domain JSON files from disk.
 *
 * Domain files live at {dbt_project}/erd-studio/{layer}/{domain}.json
 * Each file is a UnifiedDomain containing logical stage data.
 *
 * Physical domains are not stored on disk — they are derived at runtime
 * by projecting a logical domain's model list through the dbt manifest
 * via buildPhysicalDomain().
 */

import * as fs from 'fs';
import * as path from 'path';

import type { DomainSummary, Layer, SemanticDomain, SemanticModel, StageData, UnifiedDomain, ViewConfig } from '../types/semantic';
import { CURRENT_SCHEMA_VERSION } from '../types/semantic';
import type { DisplayDomain, DisplayModel, DisplayColumn, DisplayRelationship } from '../types/display';
import type { ManifestData } from '../types/manifest';
import type { YmlData } from '../types/ymlData';
import type { Cardinality } from '../types/semantic';
import type { LayerService } from './layerService';
import type { LogicalModelService } from './logicalModelService';

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

const DEFAULT_SEMANTIC_DIR = 'erd-studio';

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
   * Discover all semantic domain JSON files under erd-studio/,
   * grouped by layer. Returns lightweight summaries (no full parse).
   *
   * Directory structure:
   *   erd-studio/{layer}/*.json
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
   */
  getDomain(filePath: string): UnifiedDomain {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Domain file not found: ${filePath}`);
    }

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read domain file: ${message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid JSON in domain file ${filePath}: ${message}`);
    }

    return this.validateDomain(parsed, filePath);
  }

  /**
   * Extract the logical stage from a UnifiedDomain, returning a SemanticDomain.
   *
   * Physical stage is not supported here — use buildPhysicalDomain() instead.
   */
  getDomainStage(filePath: string): SemanticDomain {
    const unified = this.getDomain(filePath);
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
   * stage through the dbt manifest.
   *
   * Physical domains are not stored on disk — they are derived at runtime.
   * For each model in the logical stage:
   *   - If found in manifest: creates a DisplayModel with manifest columns
   *   - If not found: creates a ghost DisplayModel with existsInManifest=false
   *
   * Uses the global viewConfig for positions so layout is consistent across all stages.
   */
  /**
   * Build a physical DisplayDomain from yml source files (primary) with
   * optional manifest enrichment for data_type and schema resolution.
   *
   * Falls back to manifest-only derivation when no yml data is available.
   */
  buildPhysicalDomain(
    unifiedDomain: UnifiedDomain,
    ymlData: YmlData,
    manifest?: ManifestData,
  ): DisplayDomain {
    // Fallback: if no yml data, derive entirely from manifest (legacy path)
    if (ymlData.models.size === 0 && manifest && manifest.models.size > 0) {
      return this.buildPhysicalDomainFromManifest(unifiedDomain, manifest);
    }

    const logicalStage = unifiedDomain.logical;
    const physicalModelNames = new Set<string>();

    // Physical models = logical models that exist in yml source files
    const models: DisplayModel[] = logicalStage.models.flatMap(model => {
        const ymlModel = ymlData.models.get(model.name);
        if (!ymlModel) { return []; }
        const manifestModel = manifest?.models.get(model.name);
        physicalModelNames.add(model.name);

        // Columns come from yml; data_type enriched from manifest when available
        const columns: DisplayColumn[] = (ymlModel.columns ?? []).map(col => {
          // Enrich data_type from manifest if yml has none
          const manifestCol = manifestModel?.columns.find(mc => mc.name === col.name);
          const dataType = col.dataType ?? manifestCol?.data_type ?? '';

          return {
            name: col.name,
            dataType,
            description: col.description || manifestCol?.description || '',
            isPrimaryKey: false,
            isForeignKey: false,
            isNaturalKey: false,
          };
        });

        // Carry forward PK/FK/NK flags from logical domain columns
        const logicalColumns = model.columns ?? [];
        for (const dc of columns) {
          const logicalCol = logicalColumns.find(c => c.name === dc.name);
          if (logicalCol) {
            dc.isPrimaryKey = logicalCol.isPrimaryKey ?? false;
            dc.isForeignKey = logicalCol.isForeignKey ?? false;
            dc.isNaturalKey = logicalCol.isNaturalKey ?? false;
            if (logicalCol.scdType !== undefined) { dc.scdType = logicalCol.scdType; }
            if (logicalCol.additiveType !== undefined) { dc.additiveType = logicalCol.additiveType; }
          }
        }

        return [{
          name: model.name,
          // Schema only comes from manifest (resolved from dbt_project.yml + macros)
          schema: manifestModel?.schema ?? '',
          description: ymlModel.description || manifestModel?.description || model.description || '',
          columns,
          rationale: model.rationale,
          grain: model.grain,
          modelRole: model.modelRole,
          existsInManifest: manifestModel !== undefined,
        }];
      });

    // Derive relationships from yml tests, with uniqueness info from both sources
    const mergedUniqueColumns = mergeUniqueMaps(
      ymlData.uniqueColumns,
      manifest?.uniqueColumns,
    );
    const mergedCompositeGroups = mergeCompositeGroups(
      ymlData.compositeUniqueGroups,
      manifest?.compositeUniqueGroups,
    );

    const relationships = derivePhysicalRelationships(
      ymlData.relationshipTests,
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
    };
  }

  /**
   * Legacy fallback: derive physical domain entirely from manifest.
   * Used when no yml data is available (e.g. pre-existing projects without .yml files).
   */
  private buildPhysicalDomainFromManifest(
    unifiedDomain: UnifiedDomain,
    manifest: ManifestData,
  ): DisplayDomain {
    const logicalStage = unifiedDomain.logical;
    const physicalModelNames = new Set<string>();

    const models: DisplayModel[] = logicalStage.models
      .filter(model => manifest.models.has(model.name))
      .map(model => {
        const manifestModel = manifest.models.get(model.name)!;
        physicalModelNames.add(model.name);

        const columns: DisplayColumn[] = manifestModel.columns.map(col => ({
          name: col.name,
          dataType: col.data_type ?? '',
          description: col.description,
          isPrimaryKey: false,
          isForeignKey: false,
          isNaturalKey: false,
        }));

        const logicalColumns = model.columns ?? [];
        for (const dc of columns) {
          const logicalCol = logicalColumns.find(c => c.name === dc.name);
          if (logicalCol) {
            dc.isPrimaryKey = logicalCol.isPrimaryKey ?? false;
            dc.isForeignKey = logicalCol.isForeignKey ?? false;
            dc.isNaturalKey = logicalCol.isNaturalKey ?? false;
            if (logicalCol.scdType !== undefined) { dc.scdType = logicalCol.scdType; }
            if (logicalCol.additiveType !== undefined) { dc.additiveType = logicalCol.additiveType; }
          }
        }

        return {
          name: model.name,
          schema: manifestModel.schema,
          description: manifestModel.description || model.description || '',
          columns,
          rationale: model.rationale,
          grain: model.grain,
          modelRole: model.modelRole,
          existsInManifest: true,
        };
      });

    const relationships = derivePhysicalRelationships(
      manifest.relationshipTests,
      physicalModelNames,
      manifest.uniqueColumns,
      manifest.compositeUniqueGroups,
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

    return this.validateDomainFields(obj, filePath);
  }

  /**
   * Validate a unified domain file.
   */
  private validateDomainFields(obj: Record<string, unknown>, filePath: string): UnifiedDomain {
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
      logical: this.parseStageData(obj.logical) ?? { ...emptyStage },
      ...(stubColumns && stubColumns.length > 0 ? { stubColumns } : {}),
      viewConfig: globalViewConfig,
    };
  }

  /**
   * Parse a stage data section from a domain file.
   * Handles both v4 (inline SemanticModel[]) and v5 (string[] name references).
   * For v5, resolves model names via LogicalModelService.
   * Returns null if the section is missing or invalid.
   */
  private parseStageData(value: unknown): StageData | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const obj = value as Record<string, unknown>;
    const rawModels = Array.isArray(obj.models) ? obj.models : [];
    const relationships = Array.isArray(obj.relationships) ? (obj.relationships as StageData['relationships']) : [];

    // Detect v5 format: models array contains strings (name references)
    const isV5 = rawModels.length > 0 && typeof rawModels[0] === 'string';

    let models: SemanticModel[];
    if (isV5 && this.logicalModelService) {
      // Resolve model name references from logical-models/*.yml
      models = [];
      for (const name of rawModels as string[]) {
        const model = this.logicalModelService.getModel(name);
        if (model) {
          models.push(model);
        } else {
          // Broken reference — create a placeholder so the UI can show an error
          console.warn(`[DomainService] Model "${name}" not found in logical-models/`);
          models.push({ name, columns: [] });
        }
      }
    } else if (isV5) {
      // v5 format but no LogicalModelService available (e.g., testing)
      // Create placeholder models from names
      models = (rawModels as string[]).map(name => ({ name, columns: [] }));
    } else {
      // v4 format: inline model objects
      models = rawModels as SemanticModel[];
    }

    return { models, relationships };
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
        ? (obj.positions as Record<string, { x: number; y: number }>)
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
}

// ---------------------------------------------------------------------------
// Physical relationship derivation (manifest-only)
// ---------------------------------------------------------------------------

/**
 * Derive physical relationships entirely from manifest relationship tests.
 *
 * Each manifest relationship test becomes one edge. Cardinality is derived
 * from uniqueness tests in the manifest:
 * - `unique` test on a column → that side is "one"
 * - `unique_combination_of_columns` → side is "one" if all columns in the
 *   composite group are covered by relationship tests between the same model pair
 * - No uniqueness test → that side defaults to "many"
 *
 * Results are scoped to only models present in the domain's physical model set,
 * preventing conformed dimensions from pulling in relationships to models
 * outside the current domain.
 */
/**
 * Derive physical relationships from relationship tests (yml or manifest).
 * Accepts any object with the RelationshipTest shape (structural typing).
 *
 * Results are scoped to only models present in the domain's physical model set,
 * preventing conformed dimensions from pulling in relationships to models
 * outside the current domain.
 */
export function derivePhysicalRelationships(
  relationshipTests: RelationshipTest[],
  physicalModelNames: Set<string>,
  uniqueColumns: Map<string, Set<string>>,
  compositeUniqueGroups: Map<string, string[][]>,
): DisplayRelationship[] {
  // Filter to relationships where both models are in this domain
  const domainTests = relationshipTests.filter(
    rel => physicalModelNames.has(rel.fromModel) && physicalModelNames.has(rel.toModel),
  );

  // Group tests by (fromModel, toModel) pair for composite unique checks
  const pairKey = (from: string, to: string) => `${from}\0${to}`;
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
      uniqueColumns,
      compositeUniqueGroups,
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
 */
function isColumnEffectivelyUnique(
  model: string,
  column: string,
  side: 'from' | 'to',
  allTestsBetweenPair: RelationshipTest[],
  uniqueColumns: Map<string, Set<string>>,
  compositeUniqueGroups: Map<string, string[][]>,
): boolean {
  // 1. Single-column unique test
  if (uniqueColumns.get(model)?.has(column)) {
    return true;
  }

  // 2. Composite unique — column must be in the group, and ALL columns in
  //    the group must be covered by relationship tests for this model pair
  const groups = compositeUniqueGroups.get(model) ?? [];
  const pairColumns = new Set(
    allTestsBetweenPair.map(t => side === 'from' ? t.fromColumn : t.toColumn),
  );

  for (const group of groups) {
    if (group.includes(column) && group.every(col => pairColumns.has(col))) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Merge helpers — combine uniqueness data from yml (primary) and manifest
// ---------------------------------------------------------------------------

/** Merge two unique-column maps: union of columns per model. */
function mergeUniqueMaps(
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
function mergeCompositeGroups(
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
