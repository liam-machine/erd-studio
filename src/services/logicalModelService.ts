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
import { OwnWriteTracker, ownWrites } from './ownWriteTracker';

/** Name of the model directory under the semantic dir (`.erd-studio/logical-models/`). */
export const LOGICAL_MODELS_DIR = 'logical-models';

/** Parsed model cached against the file's mtime + size. */
interface CachedModel {
  readonly signature: string;
  readonly model: SemanticModel;
}

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
   * Returns null when the file is missing, empty, not a mapping, or has no
   * `name`; throws on read/parse failure.
   */
  private readModelFile(filePath: string, fallbackName: string): SemanticModel | null {
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
    const raw = this.parseModelFile(content);
    if (!raw || raw.name === undefined || raw.name === null || raw.name === '') {
      this.cache.delete(filePath);
      return null;
    }
    const model = this.yamlToModel(raw, fallbackName);
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
      return this.readModelFile(filePath, name);
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
        const model = this.readModelFile(path.join(this.modelsDir, file), file.replace(/\.yml$/, ''));
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
   * Save a model to its YAML file. Creates the file if it doesn't exist.
   *
   * When the file already exists it is edited in place: only the keys that
   * actually changed are touched, so comments, key order, unknown keys and
   * scalar styles that a user or AI agent put in the file survive UI edits.
   * (One caveat of the `yaml` Document API: folded `>` block scalars are
   * re-emitted on a single line — their value is unchanged.) A file that
   * fails to parse is rewritten from scratch.
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
    this.writeAtomic(filePath, this.renderModel(model, filePath));
  }

  /**
   * Serialize a model to the YAML text that `saveModel` would write, without
   * touching disk. Used by the editor to route yml writes through a
   * WorkspaceEdit so they share an undo step with the domain file change.
   * When the model file already exists on disk the text is produced by the
   * same in-place edit `saveModel` performs, so hand-written comments, key
   * order and unknown keys survive editor-driven saves too.
   *
   * `fromName` names the model file whose existing document supplies those
   * comments / key order / unknown keys. It exists for renames: the target
   * file does not exist yet, so without it the document would be regenerated
   * from scratch and everything hand-written in the old file would be lost.
   */
  serializeModel(model: SemanticModel, fromName?: string): string {
    return this.renderModel(model, this.modelPath(fromName ?? model.name));
  }

  /**
   * Produce the full YAML text for a model: the existing document at
   * `filePath` edited in place when it can be parsed, otherwise a fresh
   * document generated from the model.
   */
  private renderModel(model: SemanticModel, filePath: string): string {
    const doc = this.loadEditableDocument(filePath) ?? new Document(this.modelToPlain(model));
    if (isMap(doc.contents)) {
      this.applyModel(doc, doc.contents, model);
    }
    return doc.toString(STRINGIFY_OPTIONS);
  }

  /**
   * Atomically write `content` to `filePath` (temp file + rename), record it
   * as our own write so the logical-model watcher does not bounce it back as
   * an external change (which would trigger a second identical domainLoaded),
   * and drop any cached parse for the path.
   */
  private writeAtomic(filePath: string, content: string): void {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* temp file may not exist */ }
      throw err;
    }
    this.ownWriteTracker.recordWrite(filePath);
    this.cache.delete(filePath);
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
   * Rename a model file and update the name field inside the YAML, carrying
   * the existing document (comments, key order, extra keys) across.
   * Throws if the target name already exists — a model file may be shared by
   * several domains, so it must never be silently overwritten.
   *
   * Like `saveModel`, this bypasses VS Code's undo stack, so it is for
   * non-editor callers. The editor renames through a WorkspaceEdit and gets
   * the same document carry-over via `serializeModel(model, fromName)`.
   */
  renameModel(oldName: string, newName: string): void {
    const model = this.getModel(oldName);
    if (!model) {
      throw new Error(`Model "${oldName}" not found in logical-models/`);
    }
    if (newName !== oldName && this.modelExists(newName)) {
      throw new Error(`Model "${newName}" already exists in logical-models/`);
    }
    // Carry the existing document (comments, key order, extra keys) across
    // to the new file rather than regenerating it from the parsed model.
    const doc = this.loadEditableDocument(this.modelPath(oldName));
    if (doc) {
      this.ensureDir();
      doc.set('name', newName);
      this.writeAtomic(this.modelPath(newName), doc.toString(STRINGIFY_OPTIONS));
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

    this.saveModel(this.ymlToSemanticModel(ymlModel));
    return true;
  }

  /**
   * Convert dbt .yml model info to a SemanticModel, without touching disk.
   * Used by `createFromYml` and by the editor, which seeds a new library file
   * through a WorkspaceEdit instead of writing it directly.
   */
  ymlToSemanticModel(ymlModel: YmlModelInfo): SemanticModel {
    const columns: ColumnDef[] = ymlModel.columns.map((col) => ({
      name: col.name,
      dataType: col.dataType ?? 'unknown',
      description: col.description ?? '',
    }));

    return {
      name: ymlModel.name,
      description: ymlModel.description,
      columns,
    };
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
   *
   * The name is used verbatim as a file name, so anything that would resolve
   * outside `logical-models/` (path separators, `..`, absolute paths) is
   * rejected rather than silently written elsewhere in the workspace.
   */
  modelPath(name: string): string {
    if (typeof name !== 'string' || !name.trim() || name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new Error(`Invalid model name "${String(name)}": must not contain path separators.`);
    }
    const modelsDir = path.resolve(this.modelsDir);
    const resolved = path.resolve(modelsDir, `${name}.yml`);
    if (path.dirname(resolved) !== modelsDir) {
      throw new Error(`Invalid model name "${name}": resolves outside the logical-models directory.`);
    }
    return resolved;
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
