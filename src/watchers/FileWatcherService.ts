/**
 * FileWatcherService — manages file system watchers for dbt project files.
 *
 * Watches:
 * - {target-path}/{manifest.json,catalog.json} (dbt artifacts) → manifest and
 *   catalog cache invalidation, as two separate events off one watcher
 * - {semanticDir}/**\/*.{json,dbml} (diagrams and DBML relationships files,
 *   default .erd-studio) → tree and editor refresh
 * - {semanticDir}/{logical-models,tables}/**\/*.yml and
 *   {semanticDir}/*\/tables/*\/*.dbml (table files) → one batch per burst
 * - {semanticDir}/layers.json → layer config reload (onLayerConfigChanged)
 * - {model,seed,snapshot-paths}/**\/*.{yml,yaml,sql,py,csv} (dbt sources) →
 *   physical stage refresh (onDbtYmlChanged)
 * - dbt_project.yml (project configuration) → reload prompt only when path config changes
 *
 * The dbt-only watchers (artifacts, dbt sources, dbt_project.yml) are not
 * created when the root has no dbt_project.yml (`{ dbt: false }`,
 * logical-only mode): a plain folder's `models/` or `target/` is not dbt's.
 *
 * All change events are debounced by 300ms to prevent rapid-fire triggers
 * during batch operations (e.g., git checkout, dbt compile). Delete events for
 * domain files are additionally coalesced into a single onSemanticFileDeleted
 * event carrying every deleted URI, so a branch switch that removes N domains
 * produces one event rather than N.
 *
 * Table file events are coalesced too: one debounce for every table file,
 * one log line for the batch, then one `onTableChanged` per table and one
 * `onTablesChanged` with them all.
 *
 * A bulk change (at least {@link BULK_CHANGE_MIN_EVENTS} events on the
 * project's files in a row, each within the debounce of the last: Edit >
 * Undo of Convert Project to DBML, a branch switch) raises
 * `onBulkChangeStarted`, holds every project-file callback until the files
 * have been quiet for one debounce, then runs them and raises
 * `onBulkChangeSettled`, so the extension holds its refreshes for the burst
 * and refreshes once after it.
 *
 * Events caused by the extension's own writes (recorded in OwnWriteTracker by
 * the service that wrote the file, and matched by content however late the
 * debounced callback runs) are swallowed so a save does not bounce back as a
 * spurious "external change". While a write the editor announced is still
 * being saved, the callback waits another debounce (`debounceOwnWrite`).
 *
 * Usage:
 *   const watcher = new FileWatcherService(workspaceRoot);
 *   context.subscriptions.push(
 *     watcher.onManifestChanged(() => manifestService.invalidate()),
 *     watcher.onSemanticFileChanged(({ uri }) => treeProvider.refresh()),
 *     watcher,
 *   );
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { classifySemanticFile } from '@erd-studio/core';

import { LOGICAL_MODELS_DIR, TABLES_DIR, tablesDirIsLayer } from '../services/logicalModelService';
import { NON_SUBJECT_AREA_DIRS } from '../services/domainService';
import { LAYERS_CONFIG_FILE } from '../services/layerService';
import { OwnWriteTracker, ownWrites } from '../services/ownWriteTracker';
import {
  readDbtProjectConfig,
  resolveTargetDir,
  sourcePathsGlob,
  type DbtProjectConfig,
} from '../services/dbtProjectConfig';
import { log, plural } from '../services/logger';

const DEBOUNCE_DELAY_MS = 300;

/** Events on the project's files, each within the debounce of the last, that make a bulk change. */
export const BULK_CHANGE_MIN_EVENTS = 20;

/** The debounce key of a bulk change's settling (see {@link FileWatcherService.onBulkChangeSettled}). */
const BULK_SETTLE_KEY = 'bulk-settle';

/** How many table names the batch's log line names before "and N more". */
const LOGGED_TABLE_NAMES = 3;

export interface FileWatcherOptions {
  /**
   * False when the root has no dbt_project.yml (logical-only mode): only the
   * semantic-dir watchers are created, never the manifest / catalog, dbt
   * source or dbt_project.yml ones. Defaults to true.
   */
  dbt?: boolean;
}

/**
 * Top-level dbt_project.yml keys whose value feeds a watcher glob. Includes the
 * pre-dbt-1.0 aliases (`source-paths` for model-paths, `data-paths` for
 * seed-paths) that `readDbtProjectConfig()` also honours.
 */
const PROJECT_PATH_KEY_RE =
  /^(target-path|model-paths|source-paths|seed-paths|data-paths|snapshot-paths)\s*:/;

/** What {@link classifySemanticPath} says a path under the semantic directory is. */
export type SemanticPathKind = 'domain' | 'table' | 'relationships' | 'layer-config' | 'other';

/**
 * Classify a path under the semantic directory.
 *
 * A JSON domain file is exactly `{semanticDir}/{layer}/{domain}.json` where
 * the layer segment is not hidden and not one of the reserved directories.
 * A `.dbml` file is classified by core's single classifier
 * (`classifySemanticFile`, by path only): `{layer}/diagrams/{name}.dbml` is
 * a `domain` too, `{layer}/tables/{schema}/{name}.dbml` a `table` and
 * `{layer}/relationships/{name}.dbml` `relationships`; any other `.dbml`
 * (a 1.9 pre-release file included) is `other`.
 */
export function classifySemanticPath(
  semanticRoot: string,
  fsPath: string,
): SemanticPathKind {
  const rel = path.relative(semanticRoot, fsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return 'other';
  }
  const segments = rel.split(path.sep);
  if (segments.length === 1) {
    return segments[0] === LAYERS_CONFIG_FILE ? 'layer-config' : 'other';
  }
  const file = segments[segments.length - 1];
  if (file.endsWith('.dbml') || (file.endsWith('.yml') && segments.length <= 3)) {
    // Only a path under `tables/` depends on whether `tables` is a layer: nothing else lists the folder.
    const kind = classifySemanticFile(segments.join('/'), { tablesDirIsLayer: segments[0] === TABLES_DIR && tablesDirIsLayer(semanticRoot) }).kind;
    switch (kind) {
      case 'diagram': return 'domain';
      case 'table': return 'table';
      case 'relationships': return 'relationships';
      default: return 'other';
    }
  }
  if (segments.length !== 2) {
    return 'other';
  }
  const [dir] = segments;
  if (dir.startsWith('.') || NON_SUBJECT_AREA_DIRS.has(dir) || !file.endsWith('.json') || file.startsWith('.')) {
    return 'other';
  }
  return 'domain';
}

/**
 * {@link classifySemanticPath} for the semantic watcher, answered from the
 * path alone for a table of the DBML tree (`{layer}/tables/{schema}/{name}.dbml`,
 * which the watcher ignores: the table watcher has it), so a burst of N
 * table writes (Convert, a checkout, an assistant) costs nothing per event.
 */
export function classifyWatchedSemanticPath(semanticRoot: string, fsPath: string): SemanticPathKind {
  const rel = path.relative(semanticRoot, fsPath);
  const segments = rel.split(path.sep);
  if (segments.length === 4 && segments[1] === TABLES_DIR && segments[3].endsWith('.dbml')
    && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return 'table';
  }
  return classifySemanticPath(semanticRoot, fsPath);
}

export class FileWatcherService implements vscode.Disposable {
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();

  // Event emitters (private — fire events internally)
  private readonly _onManifestChanged = new vscode.EventEmitter<void>();
  private readonly _onCatalogChanged = new vscode.EventEmitter<void>();
  /** `created` is true when the file was created (not changed) and is a `{layer}/{domain}.json`. */
  private readonly _onSemanticFileChanged = new vscode.EventEmitter<{ uri: vscode.Uri; created?: boolean }>();
  private readonly _onSemanticFileDeleted = new vscode.EventEmitter<{ uris: vscode.Uri[] }>();
  private readonly _onLayerConfigChanged = new vscode.EventEmitter<void>();
  private readonly _onTableChanged = new vscode.EventEmitter<{ uri: vscode.Uri; modelName: string }>();
  private readonly _onTablesChanged = new vscode.EventEmitter<{ tables: Array<{ uri: vscode.Uri; modelName: string }> }>();
  private readonly _onRelationshipsChanged = new vscode.EventEmitter<{ uri: vscode.Uri }>();
  private readonly _onForeignFormatCreated = new vscode.EventEmitter<{ uri: vscode.Uri }>();
  private readonly _onDbtYmlChanged = new vscode.EventEmitter<void>();
  private readonly _onProjectConfigChanged = new vscode.EventEmitter<void>();
  private readonly _onBulkChangeStarted = new vscode.EventEmitter<void>();
  private readonly _onBulkChangeSettled = new vscode.EventEmitter<{ reported: number }>();

  // Public event subscriptions (consumers listen to these)
  readonly onManifestChanged = this._onManifestChanged.event;
  /**
   * Fires when {target-path}/catalog.json is written, replaced or removed.
   * Deliberately separate from onManifestChanged: `dbt docs generate` writes
   * manifest.json first and catalog.json seconds-to-minutes later, once it has
   * finished querying the warehouse, so a catalog consumer that listened to the
   * manifest event would refresh before the file it cares about had landed.
   */
  readonly onCatalogChanged = this._onCatalogChanged.event;
  readonly onSemanticFileChanged = this._onSemanticFileChanged.event;
  /**
   * Fires once per burst of domain-file deletions with every deleted
   * `{layer}/{domain}.json` URI. Never fires for layers.json, templates/,
   * logical-models/ or dotfiles such as .sync-plan.json.
   */
  readonly onSemanticFileDeleted = this._onSemanticFileDeleted.event;
  /** Fires when {semanticDir}/layers.json is created, modified or deleted externally. */
  readonly onLayerConfigChanged = this._onLayerConfigChanged.event;
  /** Fires when a YAML model file in {semanticDir}/logical-models/ (or one of its layer folders) changes. */
  readonly onTableChanged = this._onTableChanged.event;
  /**
   * Fires once per batch of table files changed outside ERD Studio, after
   * that batch's `onTableChanged` events, with every one of them: the work a
   * batch needs once (the library index, the views, the context keys) is
   * done once, not once per table.
   */
  readonly onTablesChanged = this._onTablesChanged.event;
  /**
   * Fires when a DBML relationships file (`{layer}/relationships/{name}.dbml`)
   * is created, changed or deleted externally. Never an `onTableChanged`:
   * the file holds Refs, not a table, and a Ref in any file can attach to
   * any table, so every open canvas is refreshed (§5.4).
   */
  readonly onRelationshipsChanged = this._onRelationshipsChanged.event;
  /**
   * Fires when a `.yml` table or a `.json` diagram is CREATED by something
   * other than ERD Studio (an AI helper set up before 2.0, say). The
   * extension warns once per session when the project stores DBML (§5.4).
   * Fires before the matching change event.
   */
  readonly onForeignFormatCreated = this._onForeignFormatCreated.event;
  /** Fires when any dbt schema .yml/.yaml file under models/ changes. */
  readonly onDbtYmlChanged = this._onDbtYmlChanged.event;
  /** Fires when target-path or model-paths change in dbt_project.yml. */
  readonly onProjectConfigChanged = this._onProjectConfigChanged.event;
  /**
   * Fires once when the project's files start changing in bulk (Edit > Undo
   * of Convert Project to DBML, a branch switch): the events for them are
   * held until the burst settles, and the listener can hold its refreshes.
   */
  readonly onBulkChangeStarted = this._onBulkChangeStarted.event;
  /**
   * Fires once the bulk change has settled and every event it held has run:
   * `reported` is how many of them were outside changes (not our own writes).
   */
  readonly onBulkChangeSettled = this._onBulkChangeSettled.event;

  /** Snapshot of path-related keys from dbt_project.yml at startup. */
  private lastProjectPaths: string;

  /** Domain-file deletions accumulated while the coalescing debounce is pending. */
  private pendingDeletes = new Map<string, vscode.Uri>();

  /** Table files changed while the table debounce is pending, by model name (the latest file wins). */
  private readonly pendingTables = new Map<string, vscode.Uri>();

  /** Debounce keys of the project-file callbacks (`debounceOwnWrite`), which a bulk change waits for. */
  private readonly projectKeys = new Set<string>();
  /** When the last event on a project file arrived, and how many arrived since the files were last quiet. */
  private lastProjectEventAt = 0;
  private projectEvents = 0;
  /** A bulk change is under way, and how many outside changes it has reported so far. */
  private bulkActive = false;
  private bulkReported = 0;

  private readonly semanticRoot: string;

  /** Resolved dbt paths (target-path / model-paths) the watchers are built from. */
  private readonly dbtConfig: DbtProjectConfig;

  constructor(
    private readonly workspaceRoot: string,
    private readonly semanticDir: string = '.erd-studio',
    dbtConfig?: DbtProjectConfig,
    private readonly ownWriteTracker: OwnWriteTracker = ownWrites,
    options: FileWatcherOptions = {},
  ) {
    const watchDbt = options.dbt !== false;
    this.dbtConfig = dbtConfig ?? readDbtProjectConfig(workspaceRoot);
    this.semanticRoot = path.join(workspaceRoot, semanticDir);
    this.lastProjectPaths = watchDbt ? this.readProjectPaths() : '';
    if (watchDbt) { this.setupArtifactWatcher(); }
    this.setupSemanticWatcher();
    if (watchDbt) { this.setupProjectConfigWatcher(); }
    this.setupTableWatcher();
    if (watchDbt) { this.setupDbtSourceWatcher(); }
  }

  /**
   * Watch {target-path}/{manifest.json,catalog.json} for changes.
   * Fires when dbt writes an artifact, and when one is removed (`dbt clean`)
   * so the physical stage stops showing an artifact that no longer exists.
   *
   * One watcher, two events, two debounce keys. The events are separate
   * because the artifacts are written minutes apart (see onCatalogChanged);
   * the keys are separate because `debounce()` is keyed by string and
   * REPLACES the pending callback, so a shared key would let whichever
   * artifact was written last swallow the other.
   */
  private setupArtifactWatcher(): void {
    // `targetPath` may be absolute (DBT_TARGET_PATH, or an absolute /
    // env_var() target-path): then watch that folder itself.
    const pattern = path.isAbsolute(this.dbtConfig.targetPath)
      ? new vscode.RelativePattern(resolveTargetDir(this.workspaceRoot, this.dbtConfig), '{manifest.json,catalog.json}')
      : new vscode.RelativePattern(this.workspaceRoot, `${this.dbtConfig.targetPath}/{manifest.json,catalog.json}`);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handleChange = (uri: vscode.Uri) => {
      if (path.basename(uri.fsPath) === 'catalog.json') {
        this.debounce('catalog', () => {
          log.debug('[FileWatcherService] External change: catalog.json');
          this.safeFireEvent(() => this._onCatalogChanged.fire());
        });
        return;
      }
      this.debounce('manifest', () => {
        log.debug('[FileWatcherService] External change: manifest.json');
        this.safeFireEvent(() => this._onManifestChanged.fire());
      });
    };

    // Track event subscriptions for disposal
    this.subscriptions.push(watcher.onDidChange(handleChange));
    this.subscriptions.push(watcher.onDidCreate(handleChange));
    this.subscriptions.push(watcher.onDidDelete(handleChange));

    this.watchers.push(watcher);
  }

  /**
   * Watch {semanticDir}/**\/*.{json,dbml} for changes. Each event is
   * classified ({@link classifySemanticPath}):
   * - a domain (JSON or DBML diagram, its positions included): created,
   *   modified or deleted externally;
   * - a relationships file: `onRelationshipsChanged`;
   * - a table: ignored here (the table watcher alone raises one event per table file);
   * - any other `.dbml`: ignored. A non-domain `.json` (a template,
   *   `.sync-plan.json`) still raises a change, as before.
   */
  private setupSemanticWatcher(): void {
    const pattern = new vscode.RelativePattern(
      this.workspaceRoot,
      `${this.semanticDir}/**/*.{json,dbml}`,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    // A create stays a create until the debounce fires, even if a change
    // event for the same file arrives in between.
    const createdPending = new Set<string>();
    const handleChange = (uri: vscode.Uri, created = false) => {
      const kind = classifyWatchedSemanticPath(this.semanticRoot, uri.fsPath);
      if (kind === 'layer-config') {
        this.handleLayerConfigEvent(uri);
        return;
      }
      if (kind === 'relationships') {
        this.handleRelationshipsEvent(uri);
        return;
      }
      if (kind === 'table') return;
      const isJson = uri.fsPath.endsWith('.json');
      if (kind === 'other' && !isJson) return;
      if (created && kind === 'domain') { createdPending.add(uri.toString()); }
      // Per-file debounce key allows parallel updates to different files
      this.debounceOwnWrite(`semantic:${uri.toString()}`, () => [uri.fsPath], () => {
        const wasCreated = createdPending.delete(uri.toString());
        if (this.ownWriteTracker.consume(uri.fsPath)) {
          log.trace(`[FileWatcherService] Own write, ignored: ${uri.fsPath}`);
          return;
        }
        log.debug(`[FileWatcherService] External change to a diagram or table file: ${uri.fsPath}`);
        if (wasCreated && isJson) this.safeFireEvent(() => this._onForeignFormatCreated.fire({ uri }));
        this.report(() => this._onSemanticFileChanged.fire(wasCreated ? { uri, created: true } : { uri }));
      });
    };

    const handleDelete = (uri: vscode.Uri) => {
      const kind = classifyWatchedSemanticPath(this.semanticRoot, uri.fsPath);
      if (kind === 'layer-config') {
        this.handleLayerConfigEvent(uri);
        return;
      }
      if (kind === 'relationships') {
        this.handleRelationshipsEvent(uri);
        return;
      }
      if (kind !== 'domain') {
        // layers.json, templates/, logical-models/, table and relationships
        // files, .sync-plan.json etc. are not domains — never surface them
        // as "Domain file deleted".
        return;
      }
      this.pendingDeletes.set(uri.toString(), uri);
      // Single debounce key: a checkout that deletes N domains yields one event
      this.debounceOwnWrite('semantic-del', () => [...this.pendingDeletes.values()].map((u) => u.fsPath), () => {
        const uris = Array.from(this.pendingDeletes.values())
          .filter((u) => !this.ownWriteTracker.consume(u.fsPath));
        this.pendingDeletes = new Map();
        if (uris.length === 0) {
          return;
        }
        log.debug(`[FileWatcherService] External delete: ${uris.length} diagram or table file(s)`);
        this.report(() => this._onSemanticFileDeleted.fire({ uris }));
      });
    };

    // Track event subscriptions for disposal
    this.subscriptions.push(watcher.onDidChange((uri) => { this.noteProjectEvent(); handleChange(uri); }));
    this.subscriptions.push(watcher.onDidCreate((uri) => { this.noteProjectEvent(); handleChange(uri, true); }));
    this.subscriptions.push(watcher.onDidDelete((uri) => { this.noteProjectEvent(); handleDelete(uri); }));

    this.watchers.push(watcher);
  }

  /** A relationships file's create/change/delete → one debounced onRelationshipsChanged per file; own writes swallowed. */
  private handleRelationshipsEvent(uri: vscode.Uri): void {
    this.debounceOwnWrite(`relationships:${uri.toString()}`, () => [uri.fsPath], () => {
      if (this.ownWriteTracker.consume(uri.fsPath)) {
        log.trace(`[FileWatcherService] Own write, ignored: ${uri.fsPath}`);
        return;
      }
      log.debug(`[FileWatcherService] External change to a relationships file: ${uri.fsPath}`);
      this.report(() => this._onRelationshipsChanged.fire({ uri }));
    });
  }

  /**
   * layers.json create/change/delete → single debounced onLayerConfigChanged.
   * Own writes (LayerService.saveConfig) are swallowed like any other own write.
   */
  private handleLayerConfigEvent(uri: vscode.Uri): void {
    this.debounceOwnWrite('layer-config', () => [uri.fsPath], () => {
      if (this.ownWriteTracker.consume(uri.fsPath)) {
        log.trace('[FileWatcherService] Own write to layers.json, ignored');
        return;
      }
      log.debug('[FileWatcherService] External change: layers.json');
      this.report(() => this._onLayerConfigChanged.fire());
    });
  }

  /**
   * Watch dbt_project.yml for changes to path-related keys.
   * Only fires onProjectConfigChanged when a path key the watchers are built
   * from actually changes, ignoring irrelevant edits (name, version, vars, etc.).
   */
  private setupProjectConfigWatcher(): void {
    const pattern = new vscode.RelativePattern(
      this.workspaceRoot,
      'dbt_project.yml',
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handleChange = () => {
      this.debounce('project', () => {
        const current = this.readProjectPaths();
        if (current !== this.lastProjectPaths) {
          log.debug('[FileWatcherService] External change: dbt_project.yml paths');
          this.lastProjectPaths = current;
          this.safeFireEvent(() => this._onProjectConfigChanged.fire());
        }
      });
    };

    this.subscriptions.push(watcher.onDidChange(handleChange));
    this.subscriptions.push(watcher.onDidCreate(handleChange));
    this.watchers.push(watcher);
  }

  /**
   * Read the path keys from dbt_project.yml — exactly the set
   * `readDbtProjectConfig()` consumes, so the reload prompt covers every key a
   * watcher glob is built from. `seed-paths` / `snapshot-paths` are in the set
   * because the source watcher now derives its glob from them as well; without
   * them, moving seeds to a custom directory would leave that watcher pointed
   * at the old one, silently, until the next window reload.
   * Uses simple line matching to avoid a full YAML dependency.
   * Captures both inline values (`model-paths: ["models"]`) and block-sequence
   * continuations (`model-paths:\n  - "models"\n  - "other"`).
   * Returns a stable string for comparison; empty string if file is unreadable.
   */
  private readProjectPaths(): string {
    try {
      const content = fs.readFileSync(
        path.join(this.workspaceRoot, 'dbt_project.yml'),
        'utf-8',
      );
      const lines = content.split('\n');
      const pathLines: string[] = [];
      let collecting = false;
      for (const line of lines) {
        if (PROJECT_PATH_KEY_RE.test(line)) {
          pathLines.push(line.trim());
          collecting = true;
        } else if (collecting && /^\s+-/.test(line)) {
          // Block-sequence continuation item (e.g. "  - models")
          pathLines.push(line.trim());
        } else if (collecting) {
          collecting = false;
        }
      }
      return pathLines.sort().join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Watch the table files for changes, with two watchers sharing one
   * handler: {semanticDir}/{logical-models,tables}/**\/*.yml (YAML: the top
   * level and the layer folders alike; v6's `tables/` library too, #162) and
   * {semanticDir}/*\/tables/*\/*.dbml (the DBML tree's
   * `{layer}/tables/{schema}/{name}.dbml`).
   * Fires when model definition files are created, modified, or deleted.
   * Used to refresh open domain editors that reference the changed model.
   * Moving a file between folders arrives as a delete + create of the same
   * model name, which the batch folds into one event. Every table file shares
   * one debounce: a burst of N (a branch switch, Edit > Undo of Convert) is
   * one batch and one log line, not N.
   */
  private setupTableWatcher(): void {
    const yamlWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
      this.workspaceRoot,
      `${this.semanticDir}/{${LOGICAL_MODELS_DIR},${TABLES_DIR}}/**/*.yml`,
    ));
    const dbmlWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
      this.workspaceRoot,
      `${this.semanticDir}/*/${TABLES_DIR}/*/*.dbml`,
    ));

    const createdPending = new Set<string>();
    const handleChange = (uri: vscode.Uri, created = false) => {
      const fileName = uri.fsPath.replace(/^.*[/\\]/, '');
      const dbml = fileName.endsWith('.dbml');
      // A `.dbml` is a table only where the single classifier says so (a
      // DBML layer's schema folder: never `tables/tables/…`, a reserved layer).
      if (dbml && classifySemanticPath(this.semanticRoot, uri.fsPath) !== 'table') return;
      // The model name is the listed stem.
      const modelName = fileName.replace(/\.(yml|dbml)$/, '');
      if (created && !dbml) createdPending.add(uri.toString());
      this.pendingTables.delete(modelName);
      this.pendingTables.set(modelName, uri);
      this.debounceOwnWrite('tables', () => [...this.pendingTables.values()].map((u) => u.fsPath), () => {
        const outside: Array<{ uri: vscode.Uri; modelName: string; wasCreated: boolean }> = [];
        for (const [name, tableUri] of this.pendingTables) {
          const wasCreated = createdPending.delete(tableUri.toString());
          if (this.ownWriteTracker.consume(tableUri.fsPath)) {
            log.trace(`[FileWatcherService] Own write to table file, ignored: ${name}`);
            continue;
          }
          outside.push({ uri: tableUri, modelName: name, wasCreated });
        }
        this.pendingTables.clear();
        if (outside.length === 0) return;
        const names = outside.map((t) => t.modelName);
        log.debug(names.length === 1
          ? `[FileWatcherService] External change to table file: ${names[0]}`
          : `[FileWatcherService] External change to ${plural(names.length, 'table file')}: ${names.slice(0, LOGGED_TABLE_NAMES).join(', ')}` +
            `${names.length > LOGGED_TABLE_NAMES ? ` and ${names.length - LOGGED_TABLE_NAMES} more` : ''}`);
        for (const t of outside) {
          if (t.wasCreated) this.safeFireEvent(() => this._onForeignFormatCreated.fire({ uri: t.uri }));
          this.report(() => this._onTableChanged.fire({ uri: t.uri, modelName: t.modelName }));
        }
        this.safeFireEvent(() => this._onTablesChanged.fire({ tables: outside.map(({ uri: u, modelName }) => ({ uri: u, modelName })) }));
      });
    };

    for (const watcher of [yamlWatcher, dbmlWatcher]) {
      this.subscriptions.push(watcher.onDidChange((uri) => { this.noteProjectEvent(); handleChange(uri); }));
      this.subscriptions.push(watcher.onDidCreate((uri) => { this.noteProjectEvent(); handleChange(uri, true); }));
      this.subscriptions.push(watcher.onDidDelete((uri) => { this.noteProjectEvent(); handleChange(uri); }));
      this.watchers.push(watcher);
    }
  }

  /**
   * Watch {model,seed,snapshot-paths}/**\/*.{yml,yaml,sql,py,csv} for changes.
   * Used to refresh the physical stage, which derives both what a model
   * contains (schema .yml) and whether it exists at all (a .sql/.py/.csv file
   * under one of dbt's source directories) from these files.
   *
   * Creates and deletes fire for every matched extension, because those are
   * the events that move existence: a new dim_x.sql makes the model real on
   * the physical canvas, deleting it turns the model back into a ghost.
   * A *change* fires only for .yml/.yaml — nothing this extension reads lives
   * inside a .sql/.py body or a seed .csv's rows, and firing would re-walk and
   * re-parse every schema yml on every keystroke-save of a model body.
   *
   * The event keeps the name onDbtYmlChanged: its subscriber (yml cache
   * invalidation + open-canvas refresh) is exactly the right response to a
   * source file appearing or disappearing too.
   */
  private setupDbtSourceWatcher(): void {
    const pattern = new vscode.RelativePattern(
      this.workspaceRoot,
      `${sourcePathsGlob(this.dbtConfig)}/**/*.{yml,yaml,sql,py,csv}`,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const fire = (reason: string) => {
      this.debounce('dbt-yml', () => {
        log.debug(`[FileWatcherService] External change: dbt source ${reason}`);
        this.safeFireEvent(() => this._onDbtYmlChanged.fire());
      });
    };

    const handleChange = (uri: vscode.Uri) => {
      if (!/\.ya?ml$/i.test(uri.fsPath)) {
        return;
      }
      fire('schema .yml changed');
    };

    this.subscriptions.push(watcher.onDidChange(handleChange));
    this.subscriptions.push(watcher.onDidCreate(() => fire('file created')));
    this.subscriptions.push(watcher.onDidDelete(() => fire('file deleted')));

    this.watchers.push(watcher);
  }

  /**
   * Debounce a callback by key.
   * Multiple calls with the same key within DEBOUNCE_DELAY_MS are collapsed into one.
   */
  private debounce(key: string, fn: () => void): void {
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      try {
        fn();
      } finally {
        // Delete timer after callback completes to prevent race conditions —
        // unless the callback debounced the key again (see debounceOwnWrite).
        if (this.debounceTimers.get(key) === timer) this.debounceTimers.delete(key);
      }
    }, DEBOUNCE_DELAY_MS);

    this.debounceTimers.set(key, timer);
  }

  /**
   * {@link debounce} for a callback that asks the own-write tracker about
   * `paths()`: while ERD Studio is still saving one of them (announced with
   * `expectWrite`, not recorded yet), the callback waits another debounce
   * instead of deciding. When the extension host was busy, the debounce
   * timer can fire before the save's completion is processed; deciding then
   * would take our own save for an external change. The tracker bounds how
   * long a write stays pending, so this never waits for ever.
   */
  private debounceOwnWrite(key: string, paths: () => readonly string[], fn: () => void): void {
    this.projectKeys.add(key);
    this.debounce(key, () => {
      // A bulk change runs nothing until the files have been quiet for a debounce.
      const stillBusy = this.bulkActive && Date.now() - this.lastProjectEventAt < DEBOUNCE_DELAY_MS;
      if (stillBusy || paths().some((p) => this.ownWriteTracker.isPending(p))) {
        this.debounceOwnWrite(key, paths, fn);
        return;
      }
      fn();
    });
  }

  /**
   * An event on a project file (a diagram, table, relationships file
   * or layers.json) arrived: count it towards a bulk change, and (re)start
   * the wait for the files to settle.
   */
  private noteProjectEvent(): void {
    this.lastProjectEventAt = Date.now();
    this.projectEvents++;
    if (!this.bulkActive && this.projectEvents >= BULK_CHANGE_MIN_EVENTS) {
      this.bulkActive = true;
      this.bulkReported = 0;
      log.debug('[FileWatcherService] Many project files are changing: refreshes wait until they settle');
      this.safeFireEvent(() => this._onBulkChangeStarted.fire());
    }
    this.debounce(BULK_SETTLE_KEY, () => this.settleProjectEvents());
  }

  /** The files have been quiet for a debounce: once every held callback has run, end the bulk change. */
  private settleProjectEvents(): void {
    if ([...this.projectKeys].some((key) => this.debounceTimers.has(key))) {
      this.debounce(BULK_SETTLE_KEY, () => this.settleProjectEvents());
      return;
    }
    const events = this.projectEvents;
    this.projectEvents = 0;
    if (!this.bulkActive) return;
    this.bulkActive = false;
    const reported = this.bulkReported;
    log.debug(`[FileWatcherService] ${plural(events, 'project file event')} settled, ${reported} reported as outside changes`);
    this.safeFireEvent(() => this._onBulkChangeSettled.fire({ reported }));
  }

  /** Fire an outside change to a project file, counted towards the bulk change under way. */
  private report(fireFn: () => void): void {
    if (this.bulkActive) this.bulkReported++;
    this.safeFireEvent(fireFn);
  }

  /**
   * Safely fire an event, catching any errors from listeners.
   * Prevents consumer errors from crashing the file watcher.
   */
  private safeFireEvent(fireFn: () => void): void {
    try {
      fireFn();
    } catch (err) {
      log.error('[FileWatcherService] Error in event handler:', err);
    }
  }

  /**
   * Dispose all watchers and clear pending timers.
   * Called automatically when the extension deactivates.
   */
  dispose(): void {
    // Clear all pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.pendingDeletes.clear();
    this.pendingTables.clear();

    // Dispose all event subscriptions (onDidChange, onDidCreate, onDidDelete handlers)
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;

    // Dispose all file system watchers
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers.length = 0;

    // Dispose event emitters
    this._onManifestChanged.dispose();
    this._onCatalogChanged.dispose();
    this._onSemanticFileChanged.dispose();
    this._onSemanticFileDeleted.dispose();
    this._onLayerConfigChanged.dispose();
    this._onTableChanged.dispose();
    this._onTablesChanged.dispose();
    this._onRelationshipsChanged.dispose();
    this._onForeignFormatCreated.dispose();
    this._onDbtYmlChanged.dispose();
    this._onProjectConfigChanged.dispose();
    this._onBulkChangeStarted.dispose();
    this._onBulkChangeSettled.dispose();
  }
}
