/**
 * DomainService — reads semantic domain JSON files from disk.
 *
 * Domain files live at {dbt_project}/erd-studio/{stage}/{layer}/{domain}.json
 * where stage is conceptual or logical, and layer is defined in layers.json.
 *
 * Physical domains are not stored on disk — they are derived at runtime
 * by projecting a logical domain's model list through the dbt manifest
 * via buildPhysicalDomain().
 */

import * as fs from 'fs';
import * as path from 'path';

import type { DomainSummary, Layer, SemanticDomain, Stage } from '../types/semantic';
import { CURRENT_SCHEMA_VERSION } from '../types/semantic';
import type { DisplayDomain, DisplayModel, DisplayColumn, DisplayRelationship } from '../types/display';
import type { ManifestData } from '../types/manifest';
import type { LayerService } from './layerService';

const DEFAULT_SEMANTIC_DIR = 'erd-studio';

/** Stages that are stored as files on disk. */
const DISK_STAGES: Stage[] = ['conceptual', 'logical'];

export class DomainService {
  constructor(private readonly layerService: LayerService) {}

  /**
   * Discover all semantic domain JSON files under erd-studio/,
   * grouped by stage and layer. Returns lightweight summaries (no full parse).
   *
   * Directory structure expected:
   *   erd-studio/{stage}/{layer}/*.json
   * where {stage} is conceptual or logical, and {layer} is defined in layers.json.
   *
   * Physical domains are not discovered — they are derived from the manifest.
   */
  listDomains(projectPath: string, semanticDir = DEFAULT_SEMANTIC_DIR): DomainSummary[] {
    const basePath = path.join(projectPath, semanticDir);

    if (!fs.existsSync(basePath)) {
      return [];
    }

    const summaries: DomainSummary[] = [];
    const layers = this.layerService.getAllLayers();

    for (const stage of DISK_STAGES) {
      const stageDir = path.join(basePath, stage);
      if (!fs.existsSync(stageDir)) {
        continue;
      }

      for (const layerConfig of layers) {
        const layer = layerConfig.id;
        const layerDir = path.join(stageDir, layer);
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
            stage,
            filePath: path.join(layerDir, entry),
          });
        }
      }
    }

    return summaries;
  }

  /**
   * Read and parse a semantic domain JSON file.
   *
   * Validates the schemaVersion field. Throws if the file does not exist,
   * contains invalid JSON, or has an unsupported schema version.
   *
   * The stage is inferred from the grandparent directory name:
   *   erd-studio/{stage}/{layer}/{domain}.json
   */
  getDomain(filePath: string): SemanticDomain {
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
   * Build a physical DisplayDomain by projecting a logical domain's model list
   * through the dbt manifest.
   *
   * Physical domains are not stored on disk — they are derived at runtime.
   * For each model in the logical domain:
   *   - If found in manifest: creates a DisplayModel with manifest columns
   *   - If not found: creates a ghost DisplayModel with existsInManifest=false
   *
   * Copies viewConfig.positions from the logical domain so layout mirrors logical.
   */
  buildPhysicalDomain(
    logicalDomain: SemanticDomain,
    manifest: ManifestData,
  ): DisplayDomain {
    const models: DisplayModel[] = logicalDomain.models.map(model => {
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

    const relationships: DisplayRelationship[] = logicalDomain.relationships.map(rel => ({
      fromModel: rel.fromModel,
      fromColumn: rel.fromColumn,
      toModel: rel.toModel,
      toColumn: rel.toColumn,
      cardinality: rel.cardinality,
    }));

    return {
      schemaVersion: logicalDomain.schemaVersion,
      domain: logicalDomain.domain,
      layer: logicalDomain.layer,
      stage: 'physical',
      description: logicalDomain.description,
      modelFolder: logicalDomain.modelFolder,
      models,
      relationships,
      viewConfig: logicalDomain.viewConfig,
      readOnly: true,
    };
  }

  /**
   * Validate parsed JSON and return a typed SemanticDomain.
   * Applies defaults for optional fields.
   * Infers stage from grandparent directory name.
   */
  private validateDomain(data: unknown, filePath: string): SemanticDomain {
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

    const domain: SemanticDomain = {
      schemaVersion: obj.schemaVersion,
      domain: typeof obj.domain === 'string' ? obj.domain : path.basename(filePath, '.json'),
      layer: this.parseLayer(obj.layer, filePath),
      stage: this.parseStage(obj.stage, filePath),
      description: typeof obj.description === 'string' ? obj.description : '',
      // Optional folder filter for models (e.g., "models/silver")
      ...(typeof obj.modelFolder === 'string' ? { modelFolder: obj.modelFolder } : {}),
      models: Array.isArray(obj.models) ? (obj.models as SemanticDomain['models']) : [],
      relationships: Array.isArray(obj.relationships) ? (obj.relationships as SemanticDomain['relationships']) : [],
      viewConfig: this.parseViewConfig(obj.viewConfig),
    };

    return domain;
  }

  /**
   * Parse and validate the stage field.
   * Falls back to inferring from the grandparent directory name.
   */
  private parseStage(value: unknown, filePath: string): Stage {
    const validStages: Stage[] = ['conceptual', 'logical', 'physical'];

    if (typeof value === 'string' && validStages.includes(value as Stage)) {
      return value as Stage;
    }

    // Infer from grandparent directory: erd-studio/{stage}/{layer}/{domain}.json
    const grandparentDir = path.basename(path.dirname(path.dirname(filePath)));
    if (validStages.includes(grandparentDir as Stage)) {
      return grandparentDir as Stage;
    }

    // Default to conceptual for backward compatibility with v1 files
    return 'conceptual';
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

  private parseViewConfig(value: unknown): SemanticDomain['viewConfig'] {
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
