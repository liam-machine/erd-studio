/**
 * LogicalModelService — reads and writes canonical model definitions
 * stored as YAML files in .erd-studio/logical-models/.
 *
 * Each model is a single YAML file, either at the top of the library
 * (logical-models/{model_name}.yml) or one folder down
 * (logical-models/{folder}/{model_name}.yml). The folder is purely
 * organisational — by convention the layer id of the domain the model was
 * created in — and never part of the model's identity: domain JSON files
 * reference models by name (string[]), so names stay unique across the whole
 * library, exactly as dbt requires of model names across a project.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Document, parseDocument, isMap, isScalar, isSeq } from 'yaml';
import type { YAMLMap, YAMLSeq } from 'yaml';

import { LOGICAL_MODELS_DIR, RATIONALE_KEYS, parseLogicalModelText } from '@erd-studio/core';
import type { ColumnDef, SemanticModel } from '../types/semantic';
import type { YmlModelInfo } from '../types/ymlData';
import type { ManifestData, ManifestModelInfo } from '../types/manifest';
import { OwnWriteTracker, ownWrites } from './ownWriteTracker';

// The directory name and the YAML -> SemanticModel parsing live in
// @erd-studio/core; re-exported so existing imports of this module keep working.
export { LOGICAL_MODELS_DIR } from '@erd-studio/core';

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

/**
 * Folders the extension itself may create under logical-models/: the layer id
 * format (`LayerService` / core `validateLayersConfig` use the same pattern).
 * Reading is more tolerant — any one-level, non-dot folder a user made by hand
 * is indexed — but a new file only ever lands in a folder with a layer-shaped
 * name, so nothing a domain file says can make the extension write elsewhere.
 */
const MODEL_FOLDER_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** One model file found in the library. */
export interface ModelFileEntry {
  /** Model name (the file stem). */
  readonly name: string;
  /** Sub-folder under logical-models/ (`''` for a file at the top level). */
  readonly folder: string;
  /** Absolute path to the yml file. */
  readonly filePath: string;
  /**
   * Set when another file with the same name wins the lookup (top level
   * first, then folders alphabetically): the path of the file that is used.
   * A shadowed file is never read for a domain.
   */
  readonly shadowedBy?: string;
}

/** Keys ERD Studio owns on a model file. Unknown keys are left untouched. */
const MODEL_KEYS = ['name', 'schema', 'alias', 'description', 'grain', 'modelRole', 'rationale', 'columns'] as const;
const COLUMN_KEYS = [
  'name', 'dataType', 'description',
  'isPrimaryKey', 'isForeignKey', 'isNaturalKey',
  'scdType', 'additiveType',
] as const;

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

  /**
   * Told when a model file exists but cannot be read or parsed, once per file
   * until it reads cleanly again. The extension host counts these for usage
   * telemetry; other callers (the MCP server, the CLI) leave it unset.
   */
  onParseFailure?: () => void;
  private readonly failedPaths = new Set<string>();

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
      return;
    }
    // An unsafe name was never cached (nothing was read for it), so there is
    // nothing to drop — and dropping a cache entry must never throw.
    const filePath = this.resolveModelPath(name);
    if (filePath !== null) {
      this.cache.delete(filePath);
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
    const model = parseLogicalModelText(content, fallbackName);
    if (!model) {
      this.cache.delete(filePath);
      return null;
    }
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
   * Pass a model file path (from {@link modelPath}) to create its layer
   * folder as well; a path outside the library is refused.
   */
  ensureDir(forFile?: string): void {
    const root = path.resolve(this.modelsDir);
    const dir = forFile === undefined ? root : path.dirname(path.resolve(forFile));
    const rel = path.relative(root, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Refusing to create ${dir}: outside the logical-models directory.`);
    }
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Resolve a model name to its file path without throwing.
   *
   * Read paths must degrade rather than fail: a hand-edited or AI-written
   * domain file can reference a name that is not path-safe, and one bad entry
   * must show as one broken-reference node, not take down the whole canvas.
   * Write paths keep using {@link modelPath}, which throws.
   */
  resolveModelPath(name: string): string | null {
    try {
      return this.modelPath(name);
    } catch (err) {
      console.warn(`[LogicalModelService] Unsafe model name: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Check if a model file exists. An unsafe name has no file (and is never
   * looked up on disk), so this returns false rather than throwing.
   */
  modelExists(name: string): boolean {
    const filePath = this.resolveModelPath(name);
    return filePath !== null && fs.existsSync(filePath);
  }

  /**
   * Read a single model from its YAML file.
   * Returns null if the name is not path-safe, or the file doesn't exist or is
   * invalid — callers render a broken-reference placeholder for null.
   */
  getModel(name: string): SemanticModel | null {
    const filePath = this.resolveModelPath(name);
    if (filePath === null) {
      return null;
    }
    try {
      const model = this.readModelFile(filePath, name);
      this.failedPaths.delete(filePath);
      return model;
    } catch (err) {
      console.error(`[LogicalModelService] Failed to read model "${name}":`, err);
      // Once per broken file, not once per canvas refresh that re-reads it.
      if (!this.failedPaths.has(filePath)) {
        this.failedPaths.add(filePath);
        this.onParseFailure?.();
      }
      return null;
    }
  }

  /**
   * Every model file in the library: the top level first, then each
   * one-level sub-folder in alphabetical order, files sorted by name inside
   * each. A name that appears more than once is flagged `shadowedBy` on every
   * copy but the first (the one {@link findModelFile} resolves to).
   * Dot-folders, deeper nesting and symlinked folders are not scanned.
   */
  listModelFiles(): ModelFileEntry[] {
    if (!fs.existsSync(this.modelsDir)) {
      return [];
    }
    const entries: ModelFileEntry[] = [];
    const winners = new Map<string, string>();
    const add = (dir: string, folder: string): void => {
      let files: string[];
      try {
        files = fs.readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isFile() && d.name.endsWith('.yml'))
          .map((d) => d.name)
          .sort((a, b) => a.localeCompare(b));
      } catch {
        return;
      }
      for (const file of files) {
        const name = file.replace(/\.yml$/, '');
        const filePath = path.join(dir, file);
        const winner = winners.get(name);
        if (winner === undefined) {
          winners.set(name, filePath);
          entries.push({ name, folder, filePath });
        } else {
          entries.push({ name, folder, filePath, shadowedBy: winner });
        }
      }
    };
    add(this.modelsDir, '');
    for (const folder of this.listFolders()) {
      add(path.join(this.modelsDir, folder), folder);
    }
    return entries;
  }

  /**
   * One-level sub-folders of logical-models/ that are scanned for models,
   * sorted alphabetically. Dot-folders (`.git`, editor state) are skipped.
   */
  listFolders(): string[] {
    try {
      return fs.readdirSync(this.modelsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  /**
   * Read all model files from the logical-models directory (top level and
   * one folder down). A shadowed duplicate is skipped, and so are files that
   * fail to parse.
   */
  listModels(): SemanticModel[] {
    const models: SemanticModel[] = [];
    for (const entry of this.listModelFiles()) {
      if (entry.shadowedBy) continue;
      try {
        const model = this.readModelFile(entry.filePath, entry.name);
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
   * List model names (without reading full content), each once even when a
   * name is present in more than one folder.
   */
  listModelNames(): string[] {
    return this.listModelFiles().filter((e) => !e.shadowedBy).map((e) => e.name);
  }

  /**
   * Whether new models should be created in layer folders. Folders are
   * opt-in per project: true once any model file lives in a LAYER folder
   * (someone ran "Organise Model Library by Layer", or organised by hand),
   * and for an empty library, which has no flat convention to keep. A flat
   * library stays flat — a new file in a folder would switch every teammate's
   * view to the grouped layout, and hide the model from anyone still on an
   * extension version that only reads the top level.
   *
   * `layerIds` (the layers in layers.json) keeps a hand-made folder such as
   * `Staging/` from counting as opting in. Without it any folder counts.
   */
  groupsByFolder(layerIds?: ReadonlySet<string>): boolean {
    const entries = this.listModelFiles();
    return entries.length === 0 ||
      entries.some((e) => e.folder !== '' && (layerIds === undefined || layerIds.has(e.folder)));
  }

  /**
   * The folder a model's file lives in: `''` for the top level, the folder
   * name for a file one level down, or null when there is no file.
   */
  modelFolder(name: string): string | null {
    const filePath = this.findModelFile(name);
    if (filePath === null) return null;
    const dir = path.dirname(filePath);
    return dir === path.resolve(this.modelsDir) ? '' : path.basename(dir);
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
  saveModel(model: SemanticModel, folder?: string): void {
    const filePath = this.modelPath(model.name, folder);
    this.ensureDir(filePath);
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
   * Like {@link serializeModel}, but the document that supplies comments, key
   * order and unknown keys is the file at `sourcePath`. Name lookups resolve to
   * the file that WINS a duplicated name, so the copy that is ignored can only
   * be addressed by its path.
   */
  serializeModelAt(model: SemanticModel, sourcePath: string): string {
    return this.renderModel(model, sourcePath);
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
   * several domains, so it must never be silently overwritten. The renamed
   * file stays in the old file's folder.
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
    // The renamed file stays in the folder the old one was in.
    const folder = this.modelFolder(oldName) ?? '';
    const doc = this.loadEditableDocument(this.modelPath(oldName));
    if (doc) {
      const target = this.modelPath(newName, folder);
      this.ensureDir(target);
      doc.set('name', newName);
      this.writeAtomic(target, doc.toString(STRINGIFY_OPTIONS));
    } else {
      model.name = newName;
      this.saveModel(model, folder);
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
  createFromManifest(name: string, manifest: ManifestData, folder?: string): SemanticModel | null {
    if (this.modelExists(name)) {
      return this.getModel(name);
    }

    const manifestModel = manifest.models.get(name);
    if (!manifestModel) {
      return null;
    }

    const model = this.manifestToSemanticModel(manifestModel);
    this.saveModel(model, folder);
    return model;
  }

  /**
   * Create a new logical model file seeded from dbt .yml source data.
   * Returns true if the model was created, false if the yml model was not found.
   * If the model file already exists, returns true without overwriting.
   */
  createFromYml(name: string, ymlModel: YmlModelInfo, folder?: string): boolean {
    if (this.modelExists(name)) {
      return true;
    }

    this.saveModel(this.ymlToSemanticModel(ymlModel), folder);
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
   * Get the file path for a model: the file that already holds it (top level
   * first, then each folder alphabetically — see {@link findModelFile}), or,
   * when there is none, where a new one would be created — in
   * `logical-models/{folder}/` when `folder` is given and layer-shaped,
   * otherwise at the top level.
   *
   * The name is used verbatim as a file name, so anything that would resolve
   * outside `logical-models/` (path separators, `..`, absolute paths) is
   * rejected rather than silently written elsewhere in the workspace.
   */
  modelPath(name: string, folder?: string): string {
    return this.findModelFile(name) ?? this.newModelPath(name, folder);
  }

  /**
   * The path of the file that holds `name`, or null when no file does.
   * Throws on a name that is not path-safe (like {@link modelPath}).
   */
  findModelFile(name: string): string | null {
    const topLevel = this.newModelPath(name);
    if (fs.existsSync(topLevel)) {
      return topLevel;
    }
    for (const folder of this.listFolders()) {
      const candidate = path.join(path.resolve(this.modelsDir), folder, `${name}.yml`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Where a new file for `name` goes. A `folder` that is neither layer-shaped
   * (see MODEL_FOLDER_PATTERN) nor an existing library folder is ignored and
   * the top level used instead.
   */
  private newModelPath(name: string, folder?: string): string {
    if (typeof name !== 'string' || !name.trim() || name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new Error(`Invalid model name "${String(name)}": must not contain path separators.`);
    }
    const modelsDir = path.resolve(this.modelsDir);
    const resolved = path.resolve(modelsDir, `${name}.yml`);
    if (path.dirname(resolved) !== modelsDir) {
      throw new Error(`Invalid model name "${name}": resolves outside the logical-models directory.`);
    }
    // A layer-shaped name may be created; any folder already in the library
    // (listed by readdir, so it cannot hold a separator) may be written into —
    // that is what keeps a renamed file in a hand-made `Staging/` folder.
    if (folder && (LogicalModelService.isModelFolderName(folder) || this.listFolders().includes(folder))) {
      return path.join(modelsDir, folder, `${name}.yml`);
    }
    return resolved;
  }

  /** Whether `folder` may be created under logical-models/ (the layer id format). */
  static isModelFolderName(folder: string): boolean {
    return MODEL_FOLDER_PATTERN.test(folder);
  }

  // -------------------------------------------------------------------------
  // YAML ↔ SemanticModel conversion
  // -------------------------------------------------------------------------

  /** Resolved value for strings/booleans/null; original source text for anything else. */
  private scalarValue(node: { value: unknown; source?: string }): unknown {
    const v = node.value;
    if (typeof v === 'string' || typeof v === 'boolean' || v === null || v === undefined) {
      return v ?? null;
    }
    return node.source ?? String(v);
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
    if (model.alias) obj.alias = model.alias;
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
