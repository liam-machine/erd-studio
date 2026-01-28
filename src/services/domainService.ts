/**
 * DomainService — reads semantic domain JSON files from disk.
 *
 * Domain files live at {dbt_project}/models/semantic/{layer}/{domain}.json
 * where layer is one of bronze, silver, gold.
 *
 * Provides read operations for Phase 1:
 * - listDomains(): discover all domain files grouped by layer
 * - getDomain(): read and parse a specific domain file
 *
 * Write operations are added in Phase 2 (F207).
 */

import * as fs from 'fs';
import * as path from 'path';

import type { DomainSummary, Layer, SemanticDomain } from '../types/semantic';
import { CURRENT_SCHEMA_VERSION, VALID_LAYERS } from '../types/semantic';

const DEFAULT_SEMANTIC_DIR = 'models/semantic';

export class DomainService {
  /**
   * Discover all semantic domain JSON files under models/semantic/,
   * grouped by layer. Returns lightweight summaries (no full parse).
   *
   * Directory structure expected:
   *   models/semantic/bronze/*.json
   *   models/semantic/silver/*.json
   *   models/semantic/gold/*.json
   */
  listDomains(projectPath: string, semanticDir = DEFAULT_SEMANTIC_DIR): DomainSummary[] {
    const basePath = path.join(projectPath, semanticDir);

    if (!fs.existsSync(basePath)) {
      return [];
    }

    const summaries: DomainSummary[] = [];

    for (const layer of VALID_LAYERS) {
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
   * Read and parse a semantic domain JSON file.
   *
   * Validates the schemaVersion field. Throws if the file does not exist,
   * contains invalid JSON, or has an unsupported schema version.
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
   * Validate parsed JSON and return a typed SemanticDomain.
   * Applies defaults for optional fields.
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

    // Validate required fields with sensible defaults for optional data
    const domain: SemanticDomain = {
      schemaVersion: obj.schemaVersion,
      domain: typeof obj.domain === 'string' ? obj.domain : path.basename(filePath, '.json'),
      layer: this.parseLayer(obj.layer, filePath),
      description: typeof obj.description === 'string' ? obj.description : '',
      models: Array.isArray(obj.models) ? (obj.models as SemanticDomain['models']) : [],
      relationships: Array.isArray(obj.relationships) ? (obj.relationships as SemanticDomain['relationships']) : [],
      viewConfig: this.parseViewConfig(obj.viewConfig),
    };

    return domain;
  }

  private parseLayer(value: unknown, filePath: string): Layer {
    if (typeof value === 'string' && VALID_LAYERS.includes(value as Layer)) {
      return value as Layer;
    }

    // Fall back to inferring from directory name
    const parentDir = path.basename(path.dirname(filePath));
    if (VALID_LAYERS.includes(parentDir as Layer)) {
      return parentDir as Layer;
    }

    throw new Error(
      `Domain file ${filePath} has invalid layer "${String(value)}". ` +
      `Expected one of: ${VALID_LAYERS.join(', ')}`
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
