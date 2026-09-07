/**
 * LogicalModelService — reads and writes canonical model definitions
 * stored as YAML files in .erd-studio/logical-models/.
 *
 * Each model is a single YAML file: logical-models/{model_name}.yml.
 * Domain JSON files reference models by name (string[]) instead of
 * embedding full model objects. This ensures a single source of truth
 * for model definitions across all domains.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import type { ColumnDef, SemanticModel } from '../types/semantic';
import type { YmlModelInfo } from '../types/ymlData';
import type { ManifestData, ManifestModelInfo } from '../types/manifest';
import { OwnWriteTracker, ownWrites } from './ownWriteTracker';

/** Name of the model directory under the semantic dir (`.erd-studio/logical-models/`). */
export const LOGICAL_MODELS_DIR = 'logical-models';

/** Parsed model cached against the file's mtime + size. */
interface CachedModel {
  readonly signature: string;
  readonly model: SemanticModel;
}

// ---------------------------------------------------------------------------
// YAML schema for model files
// ---------------------------------------------------------------------------

/**
 * Shape of a model as stored in YAML.
 * Matches SemanticModel but with explicit field types for YAML serialization.
 */
interface YamlModel {
  name: string;
  schema?: string;
  description?: string;
  grain?: string;
  modelRole?: string;
  rationale?: Record<string, string>;
  columns?: YamlColumn[];
}

interface YamlColumn {
  name: string;
  dataType: string;
  description?: string;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  isNaturalKey?: boolean;
  scdType?: number;
  additiveType?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class LogicalModelService {
  private readonly modelsDir: string;

  /**
   * In-memory parse cache keyed by file path. Each entry is validated against
   * the file's current mtime + size on read, so an external edit (or a change
   * missed by the watcher) is never served stale; invalidateCache() drops
   * entries eagerly when the logical-model watcher fires.
   */
  private readonly cache = new Map<string, CachedModel>();

  constructor(
    workspaceRoot: string,
    semanticDir = '.erd-studio',
    private readonly ownWriteTracker: OwnWriteTracker = ownWrites,
  ) {
    this.modelsDir = path.join(workspaceRoot, semanticDir, LOGICAL_MODELS_DIR);
  }

  /**
   * Drop cached parses. Pass a model name to drop a single entry, or nothing
   * to clear everything (e.g. after a bulk change on disk).
   */
  invalidateCache(name?: string): void {
    if (name === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(this.modelPath(name));
    }
  }

  /**
   * Read + parse a YAML model file, serving from the cache when the file on
   * disk is unchanged. Returns a fresh deep copy so callers may mutate freely.
   * Returns null when the file is missing; throws on read/parse failure.
   */
  private readModelFile(filePath: string): SemanticModel | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      this.cache.delete(filePath);
      return null;
    }
    const signature = `${stat.mtimeMs}:${stat.size}`;
    const cached = this.cache.get(filePath);
    if (cached && cached.signature === signature) {
      return structuredClone(cached.model);
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const raw = yaml.load(content) as YamlModel;
    if (!raw || !raw.name) {
      this.cache.delete(filePath);
      return null;
    }
    const model = this.yamlToModel(raw);
    this.cache.set(filePath, { signature, model: structuredClone(model) });
    return model;
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * Returns the path to the logical-models directory.
   */
  getModelsDir(): string {
    return this.modelsDir;
  }

  /**
   * Check if the logical-models directory exists.
   */
  dirExists(): boolean {
    return fs.existsSync(this.modelsDir);
  }

  /**
   * Ensure the logical-models directory exists, creating it if necessary.
   */
  ensureDir(): void {
    if (!fs.existsSync(this.modelsDir)) {
      fs.mkdirSync(this.modelsDir, { recursive: true });
    }
  }

  /**
   * Check if a model file exists.
   */
  modelExists(name: string): boolean {
    return fs.existsSync(this.modelPath(name));
  }

  /**
   * Read a single model from its YAML file.
   * Returns null if the file doesn't exist or is invalid.
   */
  getModel(name: string): SemanticModel | null {
    const filePath = this.modelPath(name);
    try {
      return this.readModelFile(filePath);
    } catch (err) {
      console.error(`[LogicalModelService] Failed to read model "${name}":`, err);
      return null;
    }
  }

  /**
   * Read all model files from the logical-models directory.
   * Skips files that fail to parse.
   */
  listModels(): SemanticModel[] {
    if (!fs.existsSync(this.modelsDir)) {
      return [];
    }
    const files = fs.readdirSync(this.modelsDir).filter((f) => f.endsWith('.yml'));
    const models: SemanticModel[] = [];
    for (const file of files) {
      try {
        const model = this.readModelFile(path.join(this.modelsDir, file));
        if (model) {
          models.push(model);
        }
      } catch {
        // Skip invalid files
      }
    }
    return models;
  }

  /**
   * List model names (without reading full content).
   */
  listModelNames(): string[] {
    if (!fs.existsSync(this.modelsDir)) {
      return [];
    }
    return fs
      .readdirSync(this.modelsDir)
      .filter((f) => f.endsWith('.yml'))
      .map((f) => f.replace(/\.yml$/, ''));
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  /**
   * Save a model to its YAML file. Creates the file if it doesn't exist,
   * overwrites if it does.
   *
   * The write is atomic: content goes to a sibling temp file first and is then
   * renamed over the target, so a crash mid-write never leaves a truncated yml.
   *
   * Note: this bypasses VS Code's undo stack. Editor-driven mutations should
   * go through the SemanticEditorProvider's WorkspaceEdit path instead (which
   * uses `serializeModel()`), so the yml change is undoable together with the
   * domain change. Use this for non-editor callers (migration, seeding, CLI).
   */
  saveModel(model: SemanticModel): void {
    this.ensureDir();
    const filePath = this.modelPath(model.name);
    const yamlContent = this.modelToYaml(model);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, yamlContent, 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* temp file may not exist */ }
      throw err;
    }
    // Record so the logical-model watcher does not bounce this save back as
    // an external change (which would trigger a second identical domainLoaded).
    this.ownWriteTracker.recordWrite(filePath);
    this.cache.delete(filePath);
  }

  /**
   * Serialize a model to the YAML text that `saveModel` would write, without
   * touching disk. Used by the editor to route yml writes through a
   * WorkspaceEdit so they share an undo step with the domain file change.
   */
  serializeModel(model: SemanticModel): string {
    return this.modelToYaml(model);
  }

  /**
   * Delete a model's YAML file.
   */
  deleteModel(name: string): void {
    const filePath = this.modelPath(name);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      this.ownWriteTracker.recordDelete(filePath);
    }
    this.cache.delete(filePath);
  }

  /**
   * Rename a model file and update the name field inside the YAML.
   * Throws if the target name already exists — a model file may be shared by
   * several domains, so it must never be silently overwritten.
   */
  renameModel(oldName: string, newName: string): void {
    const model = this.getModel(oldName);
    if (!model) {
      throw new Error(`Model "${oldName}" not found in logical-models/`);
    }
    if (newName !== oldName && this.modelExists(newName)) {
      throw new Error(`Model "${newName}" already exists in logical-models/`);
    }
    model.name = newName;
    this.saveModel(model);
    this.deleteModel(oldName);
  }

  // -------------------------------------------------------------------------
  // Seeding from manifest
  // -------------------------------------------------------------------------

  /**
   * Create a new logical model file seeded from manifest data.
   * Returns the created SemanticModel.
   * If the model file already exists, returns the existing model without overwriting.
   */
  createFromManifest(name: string, manifest: ManifestData): SemanticModel | null {
    if (this.modelExists(name)) {
      return this.getModel(name);
    }

    const manifestModel = manifest.models.get(name);
    if (!manifestModel) {
      return null;
    }

    const model = this.manifestToSemanticModel(manifestModel);
    this.saveModel(model);
    return model;
  }

  /**
   * Create a new logical model file seeded from dbt .yml source data.
   * Returns true if the model was created, false if the yml model was not found.
   * If the model file already exists, returns true without overwriting.
   */
  createFromYml(name: string, ymlModel: YmlModelInfo): boolean {
    if (this.modelExists(name)) {
      return true;
    }

    const columns: ColumnDef[] = ymlModel.columns.map((col) => ({
      name: col.name,
      dataType: col.dataType ?? 'unknown',
      description: col.description ?? '',
    }));

    const model: SemanticModel = {
      name: ymlModel.name,
      description: ymlModel.description,
      columns,
    };

    this.saveModel(model);
    return true;
  }

  // -------------------------------------------------------------------------
  // Conversion helpers
  // -------------------------------------------------------------------------

  /**
   * Convert manifest model info to a SemanticModel.
   * Columns get name, dataType, and description from manifest.
   * Design metadata (keys, SCD, etc.) are left unset for the user to fill in.
   */
  manifestToSemanticModel(manifestModel: ManifestModelInfo): SemanticModel {
    const columns: ColumnDef[] = manifestModel.columns.map((col) => ({
      name: col.name,
      dataType: col.data_type ?? 'unknown',
      description: col.description ?? '',
    }));

    return {
      name: manifestModel.name,
      schema: manifestModel.schema,
      description: manifestModel.description,
      columns,
    };
  }

  /**
   * Get the file path for a model.
   */
  modelPath(name: string): string {
    return path.join(this.modelsDir, `${name}.yml`);
  }

  // -------------------------------------------------------------------------
  // YAML ↔ SemanticModel conversion
  // -------------------------------------------------------------------------

  private yamlToModel(raw: YamlModel): SemanticModel {
    const model: SemanticModel = {
      name: raw.name,
    };

    if (raw.schema) model.schema = raw.schema;
    if (raw.description) model.description = raw.description;
    if (raw.grain) model.grain = raw.grain;
    if (raw.modelRole) model.modelRole = raw.modelRole as SemanticModel['modelRole'];
    if (raw.rationale) {
      model.rationale = {};
      if (raw.rationale.purpose) model.rationale.purpose = raw.rationale.purpose;
      if (raw.rationale.design) model.rationale.design = raw.rationale.design;
      if (raw.rationale.grainChoice) model.rationale.grainChoice = raw.rationale.grainChoice;
      if (raw.rationale.roleChoice) model.rationale.roleChoice = raw.rationale.roleChoice;
      if (raw.rationale.scdStrategy) model.rationale.scdStrategy = raw.rationale.scdStrategy;
      if (raw.rationale.measures) model.rationale.measures = raw.rationale.measures;
    }

    if (raw.columns && Array.isArray(raw.columns)) {
      model.columns = raw.columns.map((col) => {
        const column: ColumnDef = {
          name: col.name,
          dataType: col.dataType ?? 'unknown',
          description: col.description ?? '',
        };
        if (col.isPrimaryKey) column.isPrimaryKey = true;
        if (col.isForeignKey) column.isForeignKey = true;
        if (col.isNaturalKey) column.isNaturalKey = true;
        if (col.scdType !== undefined) column.scdType = col.scdType as ColumnDef['scdType'];
        if (col.additiveType) column.additiveType = col.additiveType as ColumnDef['additiveType'];
        return column;
      });
    }

    return model;
  }

  private modelToYaml(model: SemanticModel): string {
    // Build a clean object for YAML serialization, omitting undefined/empty fields
    const obj: Record<string, unknown> = { name: model.name };

    if (model.schema) obj.schema = model.schema;
    if (model.description) obj.description = model.description;
    if (model.grain) obj.grain = model.grain;
    if (model.modelRole) obj.modelRole = model.modelRole;

    if (model.rationale) {
      const rat: Record<string, string> = {};
      if (model.rationale.purpose) rat.purpose = model.rationale.purpose;
      if (model.rationale.design) rat.design = model.rationale.design;
      if (model.rationale.grainChoice) rat.grainChoice = model.rationale.grainChoice;
      if (model.rationale.roleChoice) rat.roleChoice = model.rationale.roleChoice;
      if (model.rationale.scdStrategy) rat.scdStrategy = model.rationale.scdStrategy;
      if (model.rationale.measures) rat.measures = model.rationale.measures;
      if (Object.keys(rat).length > 0) obj.rationale = rat;
    }

    if (model.columns && model.columns.length > 0) {
      obj.columns = model.columns.map((col) => {
        const yamlCol: Record<string, unknown> = {
          name: col.name,
          dataType: col.dataType,
        };
        if (col.description) yamlCol.description = col.description;
        if (col.isPrimaryKey) yamlCol.isPrimaryKey = true;
        if (col.isForeignKey) yamlCol.isForeignKey = true;
        if (col.isNaturalKey) yamlCol.isNaturalKey = true;
        if (col.scdType !== undefined) yamlCol.scdType = col.scdType;
        if (col.additiveType) yamlCol.additiveType = col.additiveType;
        return yamlCol;
      });
    }

    return yaml.dump(obj, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
      quotingType: '"',
      forceQuotes: false,
    });
  }
}
