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
import { Document, parseDocument, isAlias, isMap, isPair, isScalar, isSeq, visit } from 'yaml';
import type { Pair, YAMLMap, YAMLSeq } from 'yaml';

import {
  LOGICAL_MODELS_DIR,
  RATIONALE_KEYS,
  classifyModelLoadError,
  linkKey,
  normaliseRelationshipRole,
  parseLogicalModelText,
} from '@erd-studio/core';
import type { CheckLibraryModel, CheckUnreadableModel, ModelLoadErrorKind } from '@erd-studio/core';
import type { Cardinality, ColumnDef, ModelRelationship, SemanticModel } from '../types/semantic';
import type { YmlModelInfo } from '../types/ymlData';
import type { ManifestData, ManifestModelInfo } from '../types/manifest';
import { OwnWriteTracker, ownWrites } from './ownWriteTracker';
import { sameName } from '../types/naming';

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
/**
 * Why a model file that exists could not be read. A fixed set, derived from
 * the `yaml` library's own error code (never the message text), so it is safe
 * to count in usage telemetry and to branch on in the UI.
 */
export type ModelFileErrorKind = ModelLoadErrorKind;

/**
 * A model file that exists but cannot be read or parsed. `message` is the
 * parser's own text and may quote the file — show it locally, never send it.
 */
export interface ModelFileError {
  name: string;
  filePath: string;
  kind: ModelFileErrorKind;
  /** 1-based, when the parser reported a position. */
  line?: number;
  column?: number;
  /** The `yaml` library's error code, e.g. `BLOCK_AS_IMPLICIT_KEY`. */
  code?: string;
  message: string;
}

/** Describe a failure thrown while reading or parsing a model file. */
export function describeModelFileError(name: string, filePath: string, err: unknown): ModelFileError {
  const message = err instanceof Error ? err.message : String(err);
  // The classification is core's, so the extension and loadDisplayDomain agree.
  return { name, filePath, ...classifyModelLoadError(err), message };
}

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

/**
 * Keys ERD Studio owns on a model file. Unknown keys are left untouched.
 * `relationships` is owned too, but synced entry by entry
 * (`syncRelationships`), never through the generic key sync.
 */
const MODEL_KEYS = ['name', 'schema', 'alias', 'description', 'grain', 'modelRole', 'rationale', 'meta', 'columns'] as const;

/** The four cardinalities a relationship entry may hold. */
const CARDINALITIES: ReadonlySet<string> = new Set<Cardinality>(['many-to-one', 'one-to-one', 'one-to-many', 'many-to-many']);

/**
 * A model file `checkRelationships` could not use: unreadable or with a YAML
 * error (`line` when known), or — `noModel` — read fine but holding no model
 * (empty, not a mapping, or no `name:`).
 */
export interface UncheckableModelFile extends CheckUnreadableModel {
  noModel?: true;
}

/** Options for rendering a model file (`serializeModel`, `serializeModelAt`, `saveModel`). */
export interface SerializeModelOptions {
  /**
   * Indices into `model.relationships` of the entries an edit wrote (see
   * `planRelationshipCommit`'s `written`). Each is rewritten in full — a
   * cardinality the reader could not read, a stray `fromModel:` key — where
   * every other entry keeps whatever it does not need to change.
   */
  relationshipTargets?: readonly number[];
}
const COLUMN_KEYS = [
  'name', 'dataType', 'description',
  'isPrimaryKey', 'isForeignKey', 'isNaturalKey',
  'scdType', 'additiveType', 'meta',
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
   * Told when a model file exists but cannot be read or parsed — at most
   * **once per file path per session** (#113), even if the file is fixed and
   * breaks again (an AI assistant's edit loop does exactly that). The
   * extension host counts these for usage telemetry and warns the user; other
   * callers (the MCP server, the CLI) leave it unset and ask
   * {@link getModelFileError}, which always reflects the live state.
   */
  onParseFailure?: (error: ModelFileError) => void;
  /** The last failure per file path, until the file reads cleanly again. */
  private readonly failedPaths = new Map<string, ModelFileError>();
  /** Paths already reported to {@link onParseFailure}; never cleared in a session. */
  private readonly reportedPaths = new Set<string>();

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
   * The library's spelling of a model whose name matches `name` ignoring
   * case, or null when there is none. {@link modelExists} asks the file
   * system, which ignores case on macOS/Windows but not on Linux; this lists
   * the files, so `dimdate.yml` blocks a new `DimDate` on every platform —
   * the two would be one file on a teammate's Mac and one table in dbt.
   */
  findModelNameIgnoringCase(name: string): string | null {
    return this.listModelFiles().find((e) => sameName(e.name, name))?.name ?? null;
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
      const error = describeModelFileError(name, filePath, err);
      // Once per broken file, not once per canvas refresh that re-reads it
      // (nor for getModelFileError's own re-read).
      const known = this.failedPaths.has(filePath);
      this.failedPaths.set(filePath, error);
      if (!known) {
        console.error(`[LogicalModelService] Failed to read model "${name}":`, err);
        if (!this.reportedPaths.has(filePath)) {
          this.reportedPaths.add(filePath);
          this.onParseFailure?.(error);
        }
      }
      return null;
    }
  }

  /**
   * Why `name`'s file could not be read, or null when it reads cleanly, is
   * missing, or its name is unsafe. Reads the file (through the cache), so the
   * answer is current — a file fixed since the last read reports null.
   */
  getModelFileError(name: string): ModelFileError | null {
    const filePath = this.resolveModelPath(name);
    if (filePath === null || !fs.existsSync(filePath)) {
      return null;
    }
    this.getModel(name);
    return this.failedPaths.get(filePath) ?? null;
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
   * Every model file as `checkRelationships` (`@erd-studio/core`) takes it:
   * the readable ones with their file, and the ones that exist but cannot be
   * read. A shadowed duplicate is skipped, as everywhere else. `fileName`
   * names a file in findings (e.g. project-relative); the default is its path.
   * This is the one lookup the canvas, its notification and Repair
   * Relationships… share, so all three see the same findings (D11).
   *
   * A file that parses but holds no model — empty, not a mapping, or with no
   * `name:` — is listed as unreadable too (`noModel: true`): its
   * relationships were never read, so a check over it is never clean.
   */
  relationshipCheckModels(fileName: (filePath: string) => string = (p) => p): {
    libraryModels: CheckLibraryModel[];
    unreadableModels: UncheckableModelFile[];
  } {
    const libraryModels: CheckLibraryModel[] = [];
    const unreadableModels: UncheckableModelFile[] = [];
    for (const entry of this.listModelFiles()) {
      if (entry.shadowedBy) continue;
      try {
        const model = this.readModelFile(entry.filePath, entry.name);
        if (model) libraryModels.push({ model, file: fileName(entry.filePath) });
        // Null from a file that is still there: it holds no model to read.
        // (A file deleted since it was listed is simply gone.)
        else if (fs.existsSync(entry.filePath)) unreadableModels.push({ name: entry.name, file: fileName(entry.filePath), noModel: true });
      } catch (err) {
        const error = describeModelFileError(entry.name, entry.filePath, err);
        unreadableModels.push({
          name: entry.name,
          file: fileName(entry.filePath),
          ...(error.line !== undefined ? { line: error.line } : {}),
        });
      }
    }
    return { libraryModels, unreadableModels };
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
  saveModel(model: SemanticModel, folder?: string, options: SerializeModelOptions = {}): void {
    const filePath = this.modelPath(model.name, folder);
    this.ensureDir(filePath);
    this.writeAtomic(filePath, this.renderModel(model, filePath, options));
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
  serializeModel(model: SemanticModel, fromName?: string, options: SerializeModelOptions = {}): string {
    return this.renderModel(model, this.modelPath(fromName ?? model.name), options);
  }

  /**
   * Like {@link serializeModel}, but the document that supplies comments, key
   * order and unknown keys is the file at `sourcePath`. Name lookups resolve to
   * the file that WINS a duplicated name, so the copy that is ignored can only
   * be addressed by its path.
   */
  serializeModelAt(model: SemanticModel, sourcePath: string, options: SerializeModelOptions = {}): string {
    return this.renderModel(model, sourcePath, options);
  }

  /**
   * Produce the full YAML text for a model: the existing document at
   * `filePath` edited in place when it can be parsed, otherwise a fresh
   * document generated from the model.
   */
  private renderModel(model: SemanticModel, filePath: string, options: SerializeModelOptions = {}): string {
    const doc = this.loadEditableDocument(filePath) ?? new Document(this.modelToPlain(model));
    if (isMap(doc.contents)) {
      this.applyModel(doc, doc.contents, model, options, filePath);
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
  private applyModel(
    doc: Document,
    root: YAMLMap,
    model: SemanticModel,
    options: SerializeModelOptions,
    filePath: string,
  ): void {
    this.syncMap(doc, root, this.modelToPlain(model), MODEL_KEYS);
    this.syncRelationships(doc, root, model, new Set(options.relationshipTargets ?? []), filePath);
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
      if (key === 'meta' && isMap(existing) && value && typeof value === 'object' && !Array.isArray(value)) {
        this.syncMeta(doc, existing, value as Record<string, unknown>);
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
   * Bring a `meta` map in line with `desired`. Unlike the managed keys, every
   * key here is the user's: a key missing from `desired` was removed, any
   * other is kept. A value whose text is unchanged is never touched — not
   * even re-pinned the way `syncMap` pins a coerced scalar — so `tier: 1`
   * stays an unquoted number and a nested map keeps its comments. Only a value
   * that really changed is replaced.
   */
  private syncMeta(doc: Document, map: YAMLMap, desired: Record<string, unknown>): void {
    // Keys are compared as the parser reads them (`2024:` is the key '2024'),
    // never through YAMLMap.get/set, whose strict match would miss a numeric or
    // boolean key and append a duplicate — which the next parse rejects.
    const keyOf = (pair: Pair): string =>
      isScalar(pair.key) ? String(this.scalarValue(pair.key)) : String(pair.key);
    const wanted = (key: string): boolean => Object.prototype.hasOwnProperty.call(desired, key);
    map.items = map.items.filter((pair) => wanted(keyOf(pair)));
    for (const [key, value] of Object.entries(desired)) {
      const pair = map.items.find((p) => keyOf(p) === key);
      if (!pair) {
        map.items.push(doc.createPair(key, value));
        continue;
      }
      if (this.sameMetaValue(doc, pair.value, value)) continue;
      if (isScalar(pair.value) && this.isScalarLike(value)) {
        // Keep the node, and with it any trailing comment on the line.
        pair.value.value = value;
      } else {
        pair.value = doc.createNode(value);
      }
    }
  }

  /**
   * Whether a YAML node holds `value`, reading it the way the parser does:
   * scalars as their source text, an alias as what it points at (so `*shared`
   * is left an alias rather than expanded into a copy), and a raw `!!pairs`
   * entry as the text the model reads it as.
   */
  private sameMetaValue(doc: Document, node: unknown, value: unknown): boolean {
    if (isAlias(node)) return this.sameMetaValue(doc, node.resolve(doc), value);
    if (isPair(node)) return String(node) === value;
    if (isScalar(node)) return this.scalarValue(node) === (value ?? null);
    if (isMap(node)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const obj = value as Record<string, unknown>;
      if (node.items.length !== Object.keys(obj).length) return false;
      return node.items.every((pair) => {
        const key = isScalar(pair.key) ? String(this.scalarValue(pair.key)) : String(pair.key);
        return key in obj && this.sameMetaValue(doc, pair.value, obj[key]);
      });
    }
    if (isSeq(node)) {
      return Array.isArray(value)
        && node.items.length === value.length
        && node.items.every((item, i) => this.sameMetaValue(doc, item, value[i]));
    }
    return false;
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

  /**
   * Bring a model file's `relationships:` list in line with
   * `model.relationships`, entry by entry (issue #133, R6) — never by
   * re-emitting the list:
   *
   * - an entry the reader could not read (not a mapping, an endpoint missing)
   *   is kept exactly as written, wherever it is;
   * - a readable entry is matched to a wanted one by link (`linkKey`, from =
   *   this file's model) and occurrence, and only the fields whose value
   *   differs from what the reader made of it are written — so comments,
   *   unknown keys, quoting and a cardinality the reader defaulted
   *   (`one_to_many` read as many-to-one) all stay, unless the entry is one
   *   of `targets` (the one an edit wrote), which is written in full;
   * - a readable entry no longer wanted is removed; a new one is appended.
   *
   * An entry an edit targets that cannot be edited in place (an alias, say)
   * is refused with the file and the entry named.
   */
  private syncRelationships(
    doc: Document,
    root: YAMLMap,
    model: SemanticModel,
    targets: ReadonlySet<number>,
    filePath: string,
  ): void {
    const desired = (model.relationships ?? []).map((rel) => this.relationshipToPlain(rel));
    const file = path.basename(filePath);
    const existing = root.get('relationships', true);
    if (existing === undefined || (isScalar(existing) && existing.value === null)) {
      if (desired.length > 0) root.set('relationships', doc.createNode(desired));
      return;
    }
    if (isAlias(existing)) {
      // `relationships: *shared` — the reader follows the alias, so the
      // canvas draws its entries. An edit elsewhere in the model leaves them
      // alone; only an edit that would change the list itself is refused,
      // because writing it here would cut the link to the anchored list.
      const target = existing.resolve(doc);
      const read = isSeq(target)
        ? target.items.map((item) => this.readRelationshipEntry(this.nodeToPlain(doc, item)))
          .filter((r): r is ModelRelationship => r !== null).map((r) => this.relationshipToPlain(r))
        : [];
      if (JSON.stringify(read) === JSON.stringify(desired)) return;
      throw new Error(
        `${file}: "relationships:" is an alias (*${existing.source}) of a list written elsewhere in the file, ` +
        'so ERD Studio cannot change it. Write the list out under "relationships:" by hand first.',
      );
    }
    if (!isSeq(existing)) {
      // Nothing was read from it, so nothing an edit could have changed.
      if (desired.length === 0) return;
      throw new Error(`${file}: "relationships:" is not a list, so ERD Studio cannot write to it. Fix it by hand first.`);
    }

    // What the reader made of each entry, and its link.
    const occurrences = new Map<string, number>();
    const readable = new Map<number, { read: ModelRelationship; key: string; occ: number }>();
    existing.items.forEach((item, pos) => {
      const read = this.readRelationshipEntry(this.nodeToPlain(doc, item));
      if (!read) return;
      const key = linkKey({ fromModel: model.name, ...read });
      const occ = occurrences.get(key) ?? 0;
      occurrences.set(key, occ + 1);
      readable.set(pos, { read, key, occ });
    });

    // Pass 1: match each wanted entry to the same link's entry (by occurrence).
    const wanted = new Map<string, number>();
    const posFor = new Map<number, number>(); // desired index -> sequence position
    const claimed = new Set<number>();
    desired.forEach((entry, i) => {
      const key = linkKey({ fromModel: model.name, fromColumn: entry.fromColumn, toModel: entry.toModel, toColumn: entry.toColumn });
      const occ = wanted.get(key) ?? 0;
      wanted.set(key, occ + 1);
      for (const [pos, r] of readable) {
        if (!claimed.has(pos) && r.key === key && r.occ === occ) {
          claimed.add(pos);
          posFor.set(i, pos);
          break;
        }
      }
    });
    // Pass 2: an entry whose ends changed (an edit, a column or model rename)
    // takes over the unclaimed entry at its own place among the readable ones,
    // keeping that entry's comments, unknown keys and position.
    // Only where that keeps the list in the wanted order.
    const readableOrder = [...readable.keys()];
    const inOrder = (i: number, pos: number): boolean =>
      [...posFor].every(([j, p]) => (j < i ? p < pos : p > pos));
    desired.forEach((_, i) => {
      if (posFor.has(i)) return;
      const pos = readableOrder[i];
      if (pos !== undefined && !claimed.has(pos) && inOrder(i, pos)) {
        claimed.add(pos);
        posFor.set(i, pos);
      }
    });

    const desiredAt = new Map([...posFor].map(([i, pos]) => [pos, i]));
    const items: unknown[] = [];
    existing.items.forEach((item, pos) => {
      const r = readable.get(pos);
      if (!r) {
        items.push(item); // unreadable: never deleted
        return;
      }
      const i = desiredAt.get(pos);
      if (i === undefined) return; // readable and no longer wanted
      items.push(this.updateRelationshipNode(doc, item, r.read, desired[i], targets.has(i), `${file}, relationship entry ${pos + 1}`));
    });
    desired.forEach((entry, i) => {
      if (!posFor.has(i)) items.push(doc.createNode(entry));
    });

    // An entry about to be removed may carry an anchor (`- &base {…}`) that
    // the file uses elsewhere (`*base`): removing it would leave that alias
    // pointing at nothing, so the edit is refused, naming the entry.
    const kept = new Set(items);
    const removed = existing.items
      .map((item, pos) => ({ item, pos }))
      .filter(({ item }) => items.length === 0 || !kept.has(item));
    for (const { item, pos } of removed) {
      const anchor = this.referencedAnchor(doc, item, items.length === 0 ? existing : null);
      if (anchor) {
        throw new Error(
          `${file}, relationship entry ${pos + 1} is marked &${anchor} and used elsewhere in the file (*${anchor}), ` +
          'so ERD Studio cannot remove it. Replace that reference by hand first.',
        );
      }
    }
    if (items.length === 0 && existing.anchor && this.aliasesTo(doc, new Set([existing.anchor]), existing)) {
      throw new Error(
        `${file}: "relationships:" is marked &${existing.anchor} and used elsewhere in the file (*${existing.anchor}), ` +
        'so ERD Studio cannot remove it. Replace that reference by hand first.',
      );
    }

    if (items.length === 0) {
      root.delete('relationships');
      return;
    }
    existing.items = items;
  }

  /**
   * An anchor defined inside `node` (or on it) that an alias outside it
   * still uses, or null. `scope`, when given, widens "inside" to that node:
   * aliases within it are going away too.
   */
  private referencedAnchor(doc: Document, node: unknown, scope: unknown): string | null {
    const anchors = new Set<string>();
    visit(node as Parameters<typeof visit>[0], {
      Node: (_key, n) => {
        if (!isAlias(n) && (n as { anchor?: string }).anchor) anchors.add((n as { anchor: string }).anchor);
      },
    });
    if (anchors.size === 0) return null;
    return this.aliasesTo(doc, anchors, scope ?? node);
  }

  /** The first of `anchors` an alias outside `inside` refers to, or null. */
  private aliasesTo(doc: Document, anchors: ReadonlySet<string>, inside: unknown): string | null {
    let found: string | null = null;
    visit(doc, {
      Node: (_key, n) => {
        if (n === inside) return visit.SKIP;
        if (isAlias(n) && anchors.has(n.source)) {
          found = n.source;
          return visit.BREAK;
        }
        return undefined;
      },
    });
    return found;
  }

  /** A relationship entry as written to a model file (no `fromModel`, no runtime fields). */
  private relationshipToPlain(rel: ModelRelationship): ModelRelationship {
    return {
      fromColumn: rel.fromColumn,
      toModel: rel.toModel,
      toColumn: rel.toColumn,
      cardinality: rel.cardinality,
      ...(rel.role ? { role: rel.role } : {}),
    };
  }

  /**
   * What the reader (core's `readRelationships`) makes of one entry, or null
   * for an entry it skips: not a mapping, or an endpoint missing or blank.
   */
  private readRelationshipEntry(value: unknown): ModelRelationship | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const r = value as Record<string, unknown>;
    for (const key of ['fromColumn', 'toModel', 'toColumn'] as const) {
      if (typeof r[key] !== 'string' || r[key] === '') return null;
    }
    const cardinality = typeof r.cardinality === 'string' && CARDINALITIES.has(r.cardinality)
      ? (r.cardinality as Cardinality)
      : 'many-to-one';
    const role = normaliseRelationshipRole(r.role);
    return {
      fromColumn: r.fromColumn as string,
      toModel: r.toModel as string,
      toColumn: r.toColumn as string,
      cardinality,
      ...(role ? { role } : {}),
    };
  }

  /** A node as plain data, the way the reader sees it: scalars as source text, aliases resolved. */
  private nodeToPlain(doc: Document, node: unknown, depth = 0): unknown {
    if (depth > 64) return null;
    if (isAlias(node)) return this.nodeToPlain(doc, node.resolve(doc), depth + 1);
    if (isMap(node)) {
      const obj: Record<string, unknown> = {};
      for (const pair of node.items) {
        Object.defineProperty(obj, String(this.nodeToPlain(doc, pair.key, depth + 1)), {
          value: this.nodeToPlain(doc, pair.value, depth + 1), enumerable: true, writable: true, configurable: true,
        });
      }
      return obj;
    }
    if (isSeq(node)) return node.items.map((item) => this.nodeToPlain(doc, item, depth + 1));
    if (isScalar(node)) return this.scalarValue(node);
    return node ?? null;
  }

  /**
   * Update one readable relationship entry in place. A field is written only
   * when the wanted value differs from what the reader made of it — or, for a
   * `target`, from what is written — so an untouched entry is left byte for
   * byte. A target also loses a stray `fromModel:` key.
   */
  private updateRelationshipNode(
    doc: Document,
    node: unknown,
    read: ModelRelationship,
    want: ModelRelationship,
    target: boolean,
    where: string,
  ): unknown {
    const unchanged = (['fromColumn', 'toModel', 'toColumn', 'cardinality', 'role'] as const).every((k) => read[k] === want[k]);
    if (!isMap(node)) {
      if (target) throw new Error(`${where} cannot be edited in place (it is not a plain mapping). Edit it by hand.`);
      return unchanged ? node : doc.createNode(this.relationshipToPlain(want));
    }
    // A name the parser coerced (`toColumn: 007` is the number 7) is read as
    // its source text; pin it to that text so writing the file back cannot
    // turn the relationship into one to column `7`.
    for (const key of ['fromColumn', 'toModel', 'toColumn', 'role'] as const) {
      const value = node.get(key, true);
      if (isScalar(value) && typeof value.value !== 'string' && typeof this.scalarValue(value) === 'string'
        && this.scalarValue(value) === read[key]) {
        value.value = this.scalarValue(value);
      }
    }
    if (unchanged && !target) return node;
    const written = (key: string): unknown => {
      const value = node.get(key, true);
      return isScalar(value) ? this.scalarValue(value) : value === undefined ? undefined : this.nodeToPlain(doc, value);
    };
    for (const key of ['fromColumn', 'toModel', 'toColumn', 'cardinality'] as const) {
      const differs = target ? written(key) !== want[key] : read[key] !== want[key];
      if (differs) node.set(key, want[key]);
    }
    // A role on disk that reads as the wanted one (a long or multi-line label
    // the reader shows shortened) is kept exactly as written.
    const storedRole = written('role');
    const roleDiffers = target
      ? (want.role === undefined
        ? node.has('role')
        : storedRole !== want.role && !(typeof storedRole === 'string' && normaliseRelationshipRole(storedRole) === want.role))
      : read.role !== want.role;
    if (roleDiffers) {
      if (want.role) node.set('role', want.role);
      else node.delete('role');
    }
    if (target && node.has('fromModel')) node.delete('fromModel');
    return node;
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

    if (model.meta && Object.keys(model.meta).length > 0) obj.meta = model.meta;

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
        if (col.meta && Object.keys(col.meta).length > 0) yamlCol.meta = col.meta;
        return yamlCol;
      });
    }

    if (model.relationships && model.relationships.length > 0) {
      obj.relationships = model.relationships.map((rel) => ({
        fromColumn: rel.fromColumn,
        toModel: rel.toModel,
        toColumn: rel.toColumn,
        cardinality: rel.cardinality,
        ...(rel.role ? { role: rel.role } : {}),
      }));
    }

    return obj;
  }
}
