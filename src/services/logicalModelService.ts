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
import { Document, parseDocument, isAlias, isMap, isScalar, isSeq } from 'yaml';
import type { YAMLMap, YAMLSeq } from 'yaml';

import type { ColumnDef, SemanticModel } from '../types/semantic';
import type { YmlModelInfo } from '../types/ymlData';
import type { ManifestData, ManifestModelInfo } from '../types/manifest';

/**
 * Stringify options for model files. `lineWidth: 0` disables folding so
 * long descriptions are never re-wrapped, keeping diffs limited to the
 * fields that actually changed.
 */
const STRINGIFY_OPTIONS = { lineWidth: 0 } as const;

/** Keys ERD Studio owns on a model file. Unknown keys are left untouched. */
const MODEL_KEYS = ['name', 'schema', 'description', 'grain', 'modelRole', 'rationale', 'columns'] as const;
const RATIONALE_KEYS = ['purpose', 'design', 'grainChoice', 'roleChoice', 'scdStrategy', 'measures'] as const;
const COLUMN_KEYS = [
  'name', 'dataType', 'description',
  'isPrimaryKey', 'isForeignKey', 'isNaturalKey',
  'scdType', 'additiveType',
] as const;

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

  constructor(workspaceRoot: string, semanticDir = '.erd-studio') {
    this.modelsDir = path.join(workspaceRoot, semanticDir, 'logical-models');
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
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const raw = this.parseModelFile(content);
      if (!raw) {
        return null;
      }
      return this.yamlToModel(raw, name);
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
        const content = fs.readFileSync(path.join(this.modelsDir, file), 'utf-8');
        const raw = this.parseModelFile(content);
        if (raw && raw.name !== undefined && raw.name !== null && raw.name !== '') {
          models.push(this.yamlToModel(raw, file.replace(/\.yml$/, '')));
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
   * Save a model to its YAML file. Creates the file if it doesn't exist.
   *
   * When the file already exists it is edited in place: only the keys that
   * actually changed are touched, so comments, key order, unknown keys and
   * scalar styles that a user or AI agent put in the file survive UI edits.
   * (One caveat of the `yaml` Document API: folded `>` block scalars are
   * re-emitted on a single line — their value is unchanged.) A file that
   * fails to parse is rewritten from scratch.
   */
  saveModel(model: SemanticModel): void {
    this.ensureDir();
    const filePath = this.modelPath(model.name);
    const doc = this.loadEditableDocument(filePath) ?? new Document(this.modelToPlain(model));
    if (isMap(doc.contents)) {
      this.applyModel(doc, doc.contents, model);
    }
    fs.writeFileSync(filePath, doc.toString(STRINGIFY_OPTIONS), 'utf-8');
  }

  /**
   * Delete a model's YAML file.
   */
  deleteModel(name: string): void {
    const filePath = this.modelPath(name);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  /**
   * Rename a model file and update the name field inside the YAML.
   */
  renameModel(oldName: string, newName: string): void {
    const model = this.getModel(oldName);
    if (!model) {
      throw new Error(`Model "${oldName}" not found in logical-models/`);
    }
    // Carry the existing document (comments, key order, extra keys) across
    // to the new file rather than regenerating it from the parsed model.
    const doc = this.loadEditableDocument(this.modelPath(oldName));
    if (doc) {
      this.ensureDir();
      doc.set('name', newName);
      fs.writeFileSync(this.modelPath(newName), doc.toString(STRINGIFY_OPTIONS), 'utf-8');
    } else {
      model.name = newName;
      this.saveModel(model);
    }
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

  /**
   * Parse a model file into a plain object without scalar coercion.
   *
   * The `yaml` package resolves `007` to `7` and (under a `%YAML 1.1`
   * directive) `2024-01-01` to a Date. Model fields are strings by contract,
   * so every non-string scalar is read back from its original source text
   * instead of its resolved value. Booleans and nulls are kept as-is.
   * Returns null for an empty file or a file whose root is not a mapping.
   * Throws on YAML syntax errors.
   */
  private parseModelFile(content: string): YamlModel | null {
    const doc = parseDocument(content);
    if (doc.errors.length > 0) {
      throw doc.errors[0];
    }
    const raw = this.toPlain(doc, doc.contents);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    return raw as YamlModel;
  }

  /** Convert a node tree to plain JS, preserving scalar source text for non-string values. */
  private toPlain(doc: Document, node: unknown): unknown {
    if (isAlias(node)) {
      return this.toPlain(doc, node.resolve(doc));
    }
    if (isMap(node)) {
      const obj: Record<string, unknown> = {};
      for (const pair of node.items) {
        obj[String(this.toPlain(doc, pair.key))] = this.toPlain(doc, pair.value);
      }
      return obj;
    }
    if (isSeq(node)) {
      return node.items.map((item) => this.toPlain(doc, item));
    }
    if (isScalar(node)) {
      return this.scalarValue(node);
    }
    return node ?? null;
  }

  /** Resolved value for strings/booleans/null; original source text for anything else. */
  private scalarValue(node: { value: unknown; source?: string }): unknown {
    const v = node.value;
    if (typeof v === 'string' || typeof v === 'boolean' || v === null || v === undefined) {
      return v ?? null;
    }
    return node.source ?? String(v);
  }

  private yamlToModel(raw: YamlModel, fallbackName: string): SemanticModel {
    const str = (v: unknown): string | undefined =>
      v === undefined || v === null ? undefined : String(v);
    const bool = (v: unknown): boolean =>
      v === true || (typeof v === 'string' && /^(true|yes|on)$/i.test(v.trim()));

    const model: SemanticModel = {
      name: str(raw.name) || fallbackName,
    };

    const schema = str(raw.schema);
    const description = str(raw.description);
    const grain = str(raw.grain);
    const modelRole = str(raw.modelRole);
    if (schema) model.schema = schema;
    if (description) model.description = description;
    if (grain) model.grain = grain;
    if (modelRole) model.modelRole = modelRole as SemanticModel['modelRole'];
    if (raw.rationale && typeof raw.rationale === 'object') {
      model.rationale = {};
      for (const key of RATIONALE_KEYS) {
        const value = str((raw.rationale as Record<string, unknown>)[key]);
        if (value) model.rationale[key] = value;
      }
    }

    if (raw.columns && Array.isArray(raw.columns)) {
      model.columns = raw.columns
        .filter((col): col is YamlColumn => !!col && typeof col === 'object')
        .map((col) => {
          const column: ColumnDef = {
            name: str(col.name) ?? '',
            dataType: str(col.dataType) ?? 'unknown',
            description: str(col.description) ?? '',
          };
          if (bool(col.isPrimaryKey)) column.isPrimaryKey = true;
          if (bool(col.isForeignKey)) column.isForeignKey = true;
          if (bool(col.isNaturalKey)) column.isNaturalKey = true;
          if (col.scdType !== undefined && col.scdType !== null) {
            const scdType = Number(col.scdType);
            if (Number.isFinite(scdType)) column.scdType = scdType as ColumnDef['scdType'];
          }
          const additiveType = str(col.additiveType);
          if (additiveType) column.additiveType = additiveType as ColumnDef['additiveType'];
          return column;
        });
    }

    return model;
  }

  /**
   * Parse an existing model file for in-place editing. Returns null when the
   * file is missing, malformed, or its root is not a mapping — callers then
   * fall back to regenerating the file.
   */
  private loadEditableDocument(filePath: string): Document | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const doc = parseDocument(fs.readFileSync(filePath, 'utf-8'));
      if (doc.errors.length > 0 || !isMap(doc.contents)) {
        return null;
      }
      return doc;
    } catch (err) {
      console.warn(`[LogicalModelService] Rewriting unparseable model file ${filePath}:`, err);
      return null;
    }
  }

  /**
   * Apply a model onto an existing document, touching only managed keys
   * whose value differs. Keys ERD Studio does not know about are preserved.
   */
  private applyModel(doc: Document, root: YAMLMap, model: SemanticModel): void {
    this.syncMap(doc, root, this.modelToPlain(model), MODEL_KEYS);
  }

  /**
   * Bring `map` in line with `desired` for the given managed keys:
   * absent keys are removed, unchanged keys are left alone (preserving
   * comments and scalar style), nested `rationale` maps and `columns`
   * sequences are merged recursively.
   */
  private syncMap(
    doc: Document,
    map: YAMLMap,
    desired: Record<string, unknown>,
    managedKeys: readonly string[],
  ): void {
    for (const key of managedKeys) {
      if (!(key in desired)) {
        if (map.has(key)) map.delete(key);
        continue;
      }
      const value = desired[key];
      const existing = map.get(key, true);

      if (key === 'rationale' && isMap(existing) && value && typeof value === 'object' && !Array.isArray(value)) {
        this.syncMap(doc, existing, value as Record<string, unknown>, RATIONALE_KEYS);
        continue;
      }
      if (key === 'columns' && isSeq(existing) && Array.isArray(value)) {
        this.syncColumns(doc, existing, value as Record<string, unknown>[]);
        continue;
      }
      if (isScalar(existing)) {
        if (existing.value === value) continue;
        if (this.scalarValue(existing) === value) {
          // Same text, but the parser coerced it (e.g. `007` -> 7). Pin the
          // node to the string the model actually uses so it is not written
          // back as `7`; the node's comments are untouched.
          existing.value = value;
          continue;
        }
        // YAMLMap.set updates the existing Scalar's value in place, keeping
        // its style and comments.
        map.set(key, value);
        continue;
      }
      map.set(key, this.isScalarLike(value) ? value : doc.createNode(value));
    }
  }

  /**
   * Merge desired columns into an existing sequence. Columns are matched by
   * name (falling back to position for renames) so per-column comments and
   * unknown keys follow the column; order follows the model.
   */
  private syncColumns(doc: Document, seq: YAMLSeq, desired: Record<string, unknown>[]): void {
    const existing: (YAMLMap | null)[] = seq.items.map((item) => (isMap(item) ? item : null));
    const claimed = new Set<number>();

    const nameOf = (item: YAMLMap): string | undefined => {
      const nameNode = item.get('name', true);
      if (isScalar(nameNode)) {
        const v = this.scalarValue(nameNode);
        return v === null ? undefined : String(v);
      }
      return nameNode === undefined || nameNode === null ? undefined : String(nameNode);
    };

    // Pass 1: match by name.
    const matches: (YAMLMap | null)[] = desired.map((col) => {
      const idx = existing.findIndex((item, i) => item !== null && !claimed.has(i) && nameOf(item) === String(col.name));
      if (idx === -1) return null;
      claimed.add(idx);
      return existing[idx];
    });

    // Pass 2: unmatched desired columns reuse an unclaimed existing node at
    // the same position (a rename keeps its comments).
    desired.forEach((_, i) => {
      if (matches[i] !== null) return;
      const candidate = existing[i];
      if (candidate && !claimed.has(i)) {
        claimed.add(i);
        matches[i] = candidate;
      }
    });

    seq.items = desired.map((col, i) => {
      const node = matches[i];
      if (node) {
        this.syncMap(doc, node, col, COLUMN_KEYS);
        return node;
      }
      return doc.createNode(col);
    });
  }

  private isScalarLike(value: unknown): boolean {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value);
  }

  /**
   * Build a clean plain object for serialisation, omitting undefined/empty
   * fields. Key order here defines the order used for new files.
   */
  private modelToPlain(model: SemanticModel): Record<string, unknown> {
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

    return obj;
  }
}
