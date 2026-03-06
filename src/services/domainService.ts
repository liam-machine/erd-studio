/**
 * DomainService — reads semantic domain JSON files from disk.
 *
 * v3 layout: domain files live at {dbt_project}/erd-studio/{layer}/{domain}.json
 * Each file is a UnifiedDomain containing both conceptual and logical stage data.
 *
 * v1/v2 layout (legacy): {dbt_project}/erd-studio/{stage}/{layer}/{domain}.json
 * These are auto-upgraded in memory when read via getDomain().
 *
 * Physical domains are not stored on disk — they are derived at runtime
 * by projecting a logical domain's model list through the dbt manifest
 * via buildPhysicalDomain().
 */

import * as fs from 'fs';
import * as path from 'path';

import type { DomainSummary, Layer, SemanticDomain, StageData, UnifiedDomain } from '../types/semantic';
import { CURRENT_SCHEMA_VERSION } from '../types/semantic';
import type { DisplayDomain, DisplayModel, DisplayColumn, DisplayRelationship } from '../types/display';
import type { ManifestData } from '../types/manifest';
import type { LayerService } from './layerService';
import { hasLegacyLayout } from './migrationService';

const DEFAULT_SEMANTIC_DIR = 'erd-studio';

export class DomainService {
  constructor(private readonly layerService: LayerService) {}

  /**
   * Discover all semantic domain JSON files under erd-studio/,
   * grouped by layer. Returns lightweight summaries (no full parse).
   *
   * v3 directory structure:
   *   erd-studio/{layer}/*.json
   *
   * Only scans v3 paths. Callers should use hasLegacyDomains() to
   * detect unmigrated v1/v2 layouts and prompt the user to migrate.
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

      // Skip directories that are old stage directories (conceptual/logical)
      // to avoid treating them as layer directories
      if (layer === 'conceptual' || layer === 'logical') {
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
   * Check whether legacy v1/v2 stage directories exist and contain domains.
   * Delegates to migrationService.hasLegacyLayout().
   */
  hasLegacyDomains(projectPath: string, semanticDir = DEFAULT_SEMANTIC_DIR): boolean {
    return hasLegacyLayout(projectPath, semanticDir);
  }

  /**
   * Read and parse a domain JSON file, returning a UnifiedDomain.
   *
   * Supports both v3 (unified) and v1/v2 (flat) formats. Legacy files
   * are auto-upgraded in memory: the flat content is placed into the
   * stage section inferred from the file path.
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
   * Extract a single stage from a UnifiedDomain, returning a SemanticDomain.
   *
   * This is what the editor calls to get stage-specific data for display.
   * For conceptual/logical: extracts the corresponding section.
   * Physical stage is not supported here — use buildPhysicalDomain() instead.
   */
  getDomainStage(filePath: string, stage: 'conceptual' | 'logical'): SemanticDomain {
    const unified = this.getDomain(filePath);
    const stageData = unified[stage];

    return {
      schemaVersion: unified.schemaVersion,
      domain: unified.domain,
      layer: unified.layer,
      stage,
      description: unified.description,
      ...(unified.modelFolder ? { modelFolder: unified.modelFolder } : {}),
      models: stageData.models,
      relationships: stageData.relationships,
      viewConfig: stageData.viewConfig,
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
   * Copies viewConfig.positions from the logical stage so layout mirrors logical.
   */
  buildPhysicalDomain(
    unifiedDomain: UnifiedDomain,
    manifest: ManifestData,
  ): DisplayDomain {
    const logicalStage = unifiedDomain.logical;

    const models: DisplayModel[] = logicalStage.models.map(model => {
      const manifestModel = manifest.models.get(model.name);

      if (manifestModel) {
        const columns: DisplayColumn[] = manifestModel.columns.map(col => ({
          name: col.name,
          dataType: col.data_type ?? '',
          description: col.description,
          isPrimaryKey: false,
          isForeignKey: false,
          isNaturalKey: false,
        }));

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
      }

      // Ghost model — not found in manifest
      return {
        name: model.name,
        schema: model.schema ?? '',
        description: model.description ?? '',
        columns: (model.columns ?? []).map(col => ({
          name: col.name,
          dataType: col.dataType,
          description: col.description,
          isPrimaryKey: col.isPrimaryKey ?? false,
          isForeignKey: col.isForeignKey ?? false,
          isNaturalKey: col.isNaturalKey ?? false,
          scdType: col.scdType,
          additiveType: col.additiveType,
        })),
        rationale: model.rationale,
        grain: model.grain,
        modelRole: model.modelRole,
        existsInManifest: false,
      };
    });

    const relationships: DisplayRelationship[] = logicalStage.relationships.map(rel => ({
      fromModel: rel.fromModel,
      fromColumn: rel.fromColumn,
      toModel: rel.toModel,
      toColumn: rel.toColumn,
      cardinality: rel.cardinality,
    }));

    return {
      schemaVersion: unifiedDomain.schemaVersion,
      domain: unifiedDomain.domain,
      layer: unifiedDomain.layer,
      stage: 'physical',
      description: unifiedDomain.description,
      modelFolder: unifiedDomain.modelFolder,
      models,
      relationships,
      viewConfig: logicalStage.viewConfig,
      readOnly: true,
    };
  }

  /**
   * Validate parsed JSON and return a typed UnifiedDomain.
   *
   * For v3 files: validates root fields and each stage section.
   * For v1/v2 files: wraps flat content into the appropriate stage section,
   * inferring stage from the grandparent directory name.
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

    // v3 unified format — has conceptual/logical sections
    if (obj.schemaVersion >= 3) {
      return this.validateV3Domain(obj, filePath);
    }

    // v1/v2 legacy flat format — auto-upgrade in memory
    return this.upgradeV2Domain(obj, filePath);
  }

  /**
   * Validate a v3 unified domain file.
   */
  private validateV3Domain(obj: Record<string, unknown>, filePath: string): UnifiedDomain {
    const domain = typeof obj.domain === 'string' ? obj.domain : path.basename(filePath, '.json');
    const layer = this.parseLayer(obj.layer, filePath);

    const emptyStage: StageData = { models: [], relationships: [], viewConfig: {} };

    return {
      schemaVersion: obj.schemaVersion as number,
      domain,
      layer,
      description: typeof obj.description === 'string' ? obj.description : '',
      ...(typeof obj.modelFolder === 'string' ? { modelFolder: obj.modelFolder } : {}),
      conceptual: this.parseStageData(obj.conceptual) ?? { ...emptyStage },
      logical: this.parseStageData(obj.logical) ?? { ...emptyStage },
    };
  }

  /**
   * Upgrade a v1/v2 flat domain file to UnifiedDomain in memory.
   *
   * The flat file's content (models, relationships, viewConfig) is placed
   * into the stage section inferred from the grandparent directory name.
   * The other stage gets empty defaults.
   */
  private upgradeV2Domain(obj: Record<string, unknown>, filePath: string): UnifiedDomain {
    const domain = typeof obj.domain === 'string' ? obj.domain : path.basename(filePath, '.json');
    const layer = this.parseLayer(obj.layer, filePath);
    const stage = this.inferStageFromPath(filePath);

    const stageData: StageData = {
      models: Array.isArray(obj.models) ? (obj.models as StageData['models']) : [],
      relationships: Array.isArray(obj.relationships) ? (obj.relationships as StageData['relationships']) : [],
      viewConfig: this.parseViewConfig(obj.viewConfig),
    };

    const emptyStage: StageData = { models: [], relationships: [], viewConfig: {} };

    return {
      schemaVersion: obj.schemaVersion as number,
      domain,
      layer,
      description: typeof obj.description === 'string' ? obj.description : '',
      ...(typeof obj.modelFolder === 'string' ? { modelFolder: obj.modelFolder } : {}),
      conceptual: stage === 'conceptual' ? stageData : { ...emptyStage },
      logical: stage === 'logical' ? stageData : { ...emptyStage },
    };
  }

  /**
   * Infer stage from grandparent directory for v1/v2 files.
   * Falls back to 'conceptual' if not determinable.
   */
  private inferStageFromPath(filePath: string): 'conceptual' | 'logical' {
    const grandparentDir = path.basename(path.dirname(path.dirname(filePath)));
    if (grandparentDir === 'logical') {
      return 'logical';
    }
    return 'conceptual';
  }

  /**
   * Parse a stage data section from a v3 unified domain.
   * Returns null if the section is missing or invalid.
   */
  private parseStageData(value: unknown): StageData | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const obj = value as Record<string, unknown>;
    return {
      models: Array.isArray(obj.models) ? (obj.models as StageData['models']) : [],
      relationships: Array.isArray(obj.relationships) ? (obj.relationships as StageData['relationships']) : [],
      viewConfig: this.parseViewConfig(obj.viewConfig),
    };
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

  private parseViewConfig(value: unknown): StageData['viewConfig'] {
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
    };
  }
}
