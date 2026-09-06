/**
 * MigrationService — handles domain file schema version upgrades.
 *
 * v4 → v5 migration:
 *   - Extracts inline model objects from domain files
 *   - Creates YAML model files in .erd-studio/logical-models/
 *   - Converts domain logical.models from SemanticModel[] to string[]
 *   - Bumps schemaVersion to 5
 *
 * Conflict resolution: when the same model exists in multiple v4 domains
 * with different definitions, the "richest" version wins (most columns
 * with design annotations).
 */

import * as fs from 'fs';
import * as path from 'path';

import { LogicalModelService } from './logicalModelService';
import { LayerService } from './layerService';
import type { SemanticModel, Relationship, ViewConfig } from '../types/semantic';
import { CURRENT_SCHEMA_VERSION, detectDomainFormat, getRawDomainModelNames } from '../types/semantic';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface V4DomainFile {
  schemaVersion: number;
  domain: string;
  layer: string;
  description?: string;
  modelFolder?: string;
  logical: {
    models: SemanticModel[];
    relationships: Relationship[];
  };
  viewConfig?: ViewConfig;
}

/**
 * Inline SemanticModel objects from a raw domain document, whether they live
 * under `logical.models` (v4 / hybrid) or a legacy top-level `models` array.
 * String entries (v5 name references) are ignored.
 */
function inlineModelsOf(raw: unknown): SemanticModel[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const obj = raw as Record<string, unknown>;
  const logicalModels = (obj.logical as Record<string, unknown> | undefined)?.models;
  const source: unknown[] = Array.isArray(logicalModels)
    ? logicalModels
    : Array.isArray(obj.models)
      ? obj.models
      : [];
  return source.filter(
    (m): m is SemanticModel =>
      !!m && typeof m === 'object' && !Array.isArray(m) && typeof (m as SemanticModel).name === 'string',
  );
}

export interface MigrationResult {
  /** Number of domain files migrated. */
  domainsConverted: number;
  /** Number of model files created in logical-models/. */
  modelsCreated: number;
  /** Model names where multiple definitions were found — richest was kept. */
  mergeConflicts: string[];
}

// ---------------------------------------------------------------------------
// Legacy directory migration (erd-studio/ → .erd-studio/)
// ---------------------------------------------------------------------------

const DEFAULT_SEMANTIC_DIR = '.erd-studio';
const LEGACY_SEMANTIC_DIR = 'erd-studio';

/** Files/dirs whose presence identifies a folder as an ERD Studio data dir. */
const ERD_DIR_MARKERS = ['layers.json', 'logical-models', 'templates'];

/**
 * Returns the absolute path of a legacy erd-studio/ data directory that
 * should be renamed to .erd-studio/, or null when no migration applies.
 *
 * Migration applies only when ALL of:
 *   - the effective semanticDir is the default '.erd-studio' (a custom
 *     setting means the user manages the location themselves)
 *   - '.erd-studio' does not already exist
 *   - 'erd-studio' exists, is a directory, and looks like an ERD data dir
 *     (has a known marker, or a layer subdirectory containing .json files)
 */
export function findLegacySemanticDir(
  workspaceRoot: string,
  semanticDir: string,
): string | null {
  if (semanticDir !== DEFAULT_SEMANTIC_DIR) return null;
  if (fs.existsSync(path.join(workspaceRoot, semanticDir))) return null;

  const legacy = path.join(workspaceRoot, LEGACY_SEMANTIC_DIR);
  if (!fs.existsSync(legacy) || !fs.statSync(legacy).isDirectory()) return null;

  const hasMarker = ERD_DIR_MARKERS.some((m) => fs.existsSync(path.join(legacy, m)));
  if (hasMarker) return legacy;

  const hasLayerWithDomains = fs.readdirSync(legacy).some((entry) => {
    const sub = path.join(legacy, entry);
    return (
      fs.statSync(sub).isDirectory() &&
      fs.readdirSync(sub).some((f) => f.endsWith('.json'))
    );
  });
  return hasLayerWithDomains ? legacy : null;
}

/**
 * Rename a legacy erd-studio/ directory to .erd-studio/ in place.
 * Returns true when a rename happened.
 */
export function migrateLegacySemanticDir(
  workspaceRoot: string,
  semanticDir: string,
): boolean {
  const legacy = findLegacySemanticDir(workspaceRoot, semanticDir);
  if (!legacy) return false;
  fs.renameSync(legacy, path.join(workspaceRoot, semanticDir));
  return true;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MigrationService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly layerService: LayerService,
    private readonly logicalModelService: LogicalModelService,
  ) {}

  // -------------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------------

  /**
   * Scan all domain files and return paths of those that need migrating to v5:
   * - `v4` files with inline model objects
   * - `hybrid` files (schemaVersion 5 with inline objects, or mixed entries)
   * - `legacy` pre-v4 files (schemaVersion < 4 or top-level `models`)
   *
   * Uses the shared {@link detectDomainFormat} so this agrees with DomainService.
   */
  findV4Domains(): string[] {
    const semanticDir = path.join(this.workspaceRoot, '.erd-studio');
    if (!fs.existsSync(semanticDir)) {
      return [];
    }

    const v4Paths: string[] = [];
    const layers = this.layerService.getAllLayers();

    for (const layer of layers) {
      const layerDir = path.join(semanticDir, layer.id);
      if (!fs.existsSync(layerDir)) continue;

      const files = fs.readdirSync(layerDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(layerDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const parsed = JSON.parse(content) as unknown;
          const format = detectDomainFormat(parsed);
          if (format === 'hybrid' || format === 'legacy') {
            v4Paths.push(filePath);
          } else if (format === 'v4') {
            // Only v4 files that actually carry inline models need converting
            const models = (parsed as V4DomainFile).logical?.models ?? [];
            if (models.length > 0) {
              v4Paths.push(filePath);
            }
          }
        } catch {
          // Skip unparseable files
        }
      }
    }

    return v4Paths;
  }

  /**
   * Returns true if any v4 domain files exist that need migration.
   */
  needsMigration(): boolean {
    return this.findV4Domains().length > 0;
  }

  // -------------------------------------------------------------------------
  // Migration
  // -------------------------------------------------------------------------

  /**
   * Migrate all v4 domain files to v5 format.
   *
   * 1. For each domain file with inline models:
   *    - Extract each model to logical-models/{name}.yml (if not already there)
   *    - Convert models array from objects to string names
   *    - Bump schemaVersion to 5
   *    - Write updated domain file
   *
   * 2. When the same model exists in multiple domains with different definitions,
   *    the "richest" version (most design annotations) is kept.
   */
  migrate(): MigrationResult {
    const v4Paths = this.findV4Domains();
    const result: MigrationResult = {
      domainsConverted: 0,
      modelsCreated: 0,
      mergeConflicts: [],
    };

    if (v4Paths.length === 0) {
      return result;
    }

    // Ensure logical-models directory exists
    this.logicalModelService.ensureDir();

    // Phase 1: Extract all models across all domains, resolve conflicts
    const allModels = new Map<string, { model: SemanticModel; sources: string[] }>();

    for (const filePath of v4Paths) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content) as unknown;

        // Inline objects only — string entries (hybrid files) already live in
        // logical-models/ and must not be overwritten with a placeholder.
        for (const model of inlineModelsOf(parsed)) {
          if (!model.name) continue;

          const existing = allModels.get(model.name);
          if (!existing) {
            allModels.set(model.name, { model, sources: [filePath] });
          } else {
            existing.sources.push(filePath);
            // Keep the richer version
            if (this.richness(model) > this.richness(existing.model)) {
              existing.model = model;
              result.mergeConflicts.push(model.name);
            } else if (this.richness(model) < this.richness(existing.model)) {
              result.mergeConflicts.push(model.name);
            }
            // If equal richness, keep the first one found
          }
        }
      } catch {
        // Skip unparseable files
      }
    }

    // Phase 2: Write model files (skip if already exists from a prior partial migration)
    for (const [name, { model }] of allModels) {
      if (!this.logicalModelService.modelExists(name)) {
        this.logicalModelService.saveModel(model);
        result.modelsCreated++;
      }
    }

    // Phase 3: Convert domain files to v5 format
    for (const filePath of v4Paths) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content) as Record<string, unknown>;

        // Convert models (inline objects and/or existing name strings) to a
        // de-duplicated list of name references. Handles legacy top-level
        // `models` as well as `logical.models`.
        const modelNames = Array.from(new Set(getRawDomainModelNames(parsed)));

        // Legacy (pre-v4) layout: lift top-level models/relationships into
        // a `logical` section and drop the obsolete `stage` field.
        const logical: Record<string, unknown> =
          parsed.logical && typeof parsed.logical === 'object' && !Array.isArray(parsed.logical)
            ? (parsed.logical as Record<string, unknown>)
            : {};
        if (!Array.isArray(logical.relationships)) {
          logical.relationships = Array.isArray(parsed.relationships) ? parsed.relationships : [];
        }
        delete parsed.models;
        delete parsed.relationships;
        delete parsed.stage;

        parsed.schemaVersion = CURRENT_SCHEMA_VERSION;
        logical.models = modelNames;
        parsed.logical = logical;
        if (!parsed.viewConfig || typeof parsed.viewConfig !== 'object') {
          parsed.viewConfig = {};
        }

        const updatedContent = JSON.stringify(parsed, null, 2) + '\n';
        fs.writeFileSync(filePath, updatedContent, 'utf-8');
        result.domainsConverted++;
      } catch (err) {
        console.error(`[MigrationService] Failed to migrate ${filePath}:`, err);
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Compute a "richness" score for a model definition.
   * Higher score = more design annotations = better candidate for the canonical version.
   */
  private richness(model: SemanticModel): number {
    let score = 0;
    const columns = model.columns ?? [];

    // Column count
    score += columns.length * 2;

    // Design annotations on columns
    for (const col of columns) {
      if (col.isPrimaryKey) score += 3;
      if (col.isForeignKey) score += 2;
      if (col.isNaturalKey) score += 3;
      if (col.scdType !== undefined) score += 2;
      if (col.additiveType) score += 2;
      if (col.description) score += 1;
    }

    // Model-level metadata
    if (model.grain) score += 5;
    if (model.modelRole) score += 5;
    if (model.description) score += 3;
    if (model.rationale) {
      const r = model.rationale;
      if (r.purpose) score += 3;
      if (r.design) score += 3;
      if (r.grainChoice) score += 2;
      if (r.roleChoice) score += 2;
      if (r.scdStrategy) score += 2;
      if (r.measures) score += 2;
    }

    return score;
  }
}
