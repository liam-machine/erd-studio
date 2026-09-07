/**
 * FileWatcherService — manages file system watchers for dbt project files.
 *
 * Watches:
 * - {target-path}/manifest.json (dbt compile output) → triggers manifest cache invalidation
 * - {semanticDir}/**\/*.json (semantic domain files, default .erd-studio) → triggers tree and editor refresh
 * - {semanticDir}/layers.json → layer config reload (onLayerConfigChanged)
 * - dbt_project.yml (project configuration) → reload prompt only when path config changes
 *
 * All change events are debounced by 300ms to prevent rapid-fire triggers
 * during batch operations (e.g., git checkout, dbt compile). Delete events for
 * domain files are additionally coalesced into a single onSemanticFileDeleted
 * event carrying every deleted URI, so a branch switch that removes N domains
 * produces one event rather than N.
 *
 * Events caused by the extension's own writes (recorded in OwnWriteTracker by
 * the service that wrote the file) are swallowed so a save does not bounce
 * back as a spurious "external change".
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

import { LOGICAL_MODELS_DIR } from '../services/logicalModelService';
import { LAYERS_CONFIG_FILE } from '../services/layerService';
import { OwnWriteTracker, ownWrites } from '../services/ownWriteTracker';
import {
  modelPathsGlob,
  readDbtProjectConfig,
  type DbtProjectConfig,
} from '../services/dbtProjectConfig';

const DEBOUNCE_DELAY_MS = 300;

/**
 * Sub-directories of the semantic dir that never contain domain files.
 * Deletes inside these must not surface as "Domain file deleted".
 */
const NON_DOMAIN_DIRS = new Set(['templates', LOGICAL_MODELS_DIR, 'logical', 'physical']);

/**
 * Classify a path under the semantic directory.
 * A domain file is exactly `{semanticDir}/{layer}/{domain}.json` where the
 * layer segment is not hidden and not one of the reserved directories.
 */
export function classifySemanticPath(
  semanticRoot: string,
  fsPath: string,
): 'domain' | 'layer-config' | 'other' {
  const rel = path.relative(semanticRoot, fsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return 'other';
  }
  const segments = rel.split(path.sep);
  if (segments.length === 1) {
    return segments[0] === LAYERS_CONFIG_FILE ? 'layer-config' : 'other';
  }
  if (segments.length !== 2) {
    return 'other';
  }
  const [dir, file] = segments;
  if (dir.startsWith('.') || NON_DOMAIN_DIRS.has(dir) || !file.endsWith('.json') || file.startsWith('.')) {
    return 'other';
  }
  return 'domain';
}

export class FileWatcherService implements vscode.Disposable {
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();

  // Event emitters (private — fire events internally)
  private readonly _onManifestChanged = new vscode.EventEmitter<void>();
  private readonly _onSemanticFileChanged = new vscode.EventEmitter<{ uri: vscode.Uri }>();
  private readonly _onSemanticFileDeleted = new vscode.EventEmitter<{ uris: vscode.Uri[] }>();
  private readonly _onLayerConfigChanged = new vscode.EventEmitter<void>();
  private readonly _onLogicalModelChanged = new vscode.EventEmitter<{ uri: vscode.Uri; modelName: string }>();
  private readonly _onDbtYmlChanged = new vscode.EventEmitter<void>();
  private readonly _onProjectConfigChanged = new vscode.EventEmitter<void>();

  // Public event subscriptions (consumers listen to these)
  readonly onManifestChanged = this._onManifestChanged.event;
  readonly onSemanticFileChanged = this._onSemanticFileChanged.event;
  /**
   * Fires once per burst of domain-file deletions with every deleted
   * `{layer}/{domain}.json` URI. Never fires for layers.json, templates/,
   * logical-models/ or dotfiles such as .sync-plan.json.
   */
  readonly onSemanticFileDeleted = this._onSemanticFileDeleted.event;
  /** Fires when {semanticDir}/layers.json is created, modified or deleted externally. */
  readonly onLayerConfigChanged = this._onLayerConfigChanged.event;
  /** Fires when a YAML model file in {semanticDir}/logical-models/ changes. */
  readonly onLogicalModelChanged = this._onLogicalModelChanged.event;
  /** Fires when any dbt schema .yml/.yaml file under models/ changes. */
  readonly onDbtYmlChanged = this._onDbtYmlChanged.event;
  /** Fires when target-path or model-paths change in dbt_project.yml. */
  readonly onProjectConfigChanged = this._onProjectConfigChanged.event;

  /** Snapshot of path-related keys from dbt_project.yml at startup. */
  private lastProjectPaths: string;

  /** Domain-file deletions accumulated while the coalescing debounce is pending. */
  private pendingDeletes = new Map<string, vscode.Uri>();

  private readonly semanticRoot: string;

  /** Resolved dbt paths (target-path / model-paths) the watchers are built from. */
  private readonly dbtConfig: DbtProjectConfig;

  constructor(
    private readonly workspaceRoot: string,
    private readonly semanticDir: string = '.erd-studio',
    dbtConfig?: DbtProjectConfig,
    private readonly ownWriteTracker: OwnWriteTracker = ownWrites,
  ) {
    this.dbtConfig = dbtConfig ?? readDbtProjectConfig(workspaceRoot);
    this.semanticRoot = path.join(workspaceRoot, semanticDir);
    this.lastProjectPaths = this.readProjectPaths();
    this.setupManifestWatcher();
    this.setupSemanticWatcher();
    this.setupProjectConfigWatcher();
    this.setupLogicalModelWatcher();
    this.setupDbtYmlWatcher();
  }

  /**
   * Watch {target-path}/manifest.json for changes.
   * Fires when dbt compile generates a new manifest, and when it is removed
   * (`dbt clean`) so the physical stage stops showing a manifest that no
   * longer exists.
   */
  private setupManifestWatcher(): void {
    const pattern = new vscode.RelativePattern(
      this.workspaceRoot,
      `${this.dbtConfig.targetPath}/manifest.json`,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handleChange = () => {
      this.debounce('manifest', () => {
        console.log('[FileWatcherService] Manifest changed');
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
   * Watch {semanticDir}/**\/*.json for changes.
   * Fires when domain files are created, modified, or deleted externally.
   */
  private setupSemanticWatcher(): void {
    const pattern = new vscode.RelativePattern(
      this.workspaceRoot,
      `${this.semanticDir}/**/*.json`,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handleChange = (uri: vscode.Uri) => {
      if (classifySemanticPath(this.semanticRoot, uri.fsPath) === 'layer-config') {
        this.handleLayerConfigEvent(uri);
        return;
      }
      // Per-file debounce key allows parallel updates to different files
      this.debounce(`semantic:${uri.toString()}`, () => {
        if (this.ownWriteTracker.consume(uri.fsPath)) {
          console.log(`[FileWatcherService] Ignoring own write: ${uri.fsPath}`);
          return;
        }
        console.log(`[FileWatcherService] Semantic file changed: ${uri.fsPath}`);
        this.safeFireEvent(() => this._onSemanticFileChanged.fire({ uri }));
      });
    };

    const handleDelete = (uri: vscode.Uri) => {
      const kind = classifySemanticPath(this.semanticRoot, uri.fsPath);
      if (kind === 'layer-config') {
        this.handleLayerConfigEvent(uri);
        return;
      }
      if (kind !== 'domain') {
        // layers.json, templates/, logical-models/, .sync-plan.json etc. are
        // not domains — never surface them as "Domain file deleted".
        return;
      }
      this.pendingDeletes.set(uri.toString(), uri);
      // Single debounce key: a checkout that deletes N domains yields one event
      this.debounce('semantic-del', () => {
        const uris = Array.from(this.pendingDeletes.values())
          .filter((u) => !this.ownWriteTracker.consume(u.fsPath));
        this.pendingDeletes = new Map();
        if (uris.length === 0) {
          return;
        }
        console.log(`[FileWatcherService] ${uris.length} semantic file(s) deleted`);
        this.safeFireEvent(() => this._onSemanticFileDeleted.fire({ uris }));
      });
    };

    // Track event subscriptions for disposal
    this.subscriptions.push(watcher.onDidChange(handleChange));
    this.subscriptions.push(watcher.onDidCreate(handleChange));
    this.subscriptions.push(watcher.onDidDelete(handleDelete));

    this.watchers.push(watcher);
  }

  /**
   * layers.json create/change/delete → single debounced onLayerConfigChanged.
   * Own writes (LayerService.saveConfig) are swallowed like any other own write.
   */
  private handleLayerConfigEvent(uri: vscode.Uri): void {
    this.debounce('layer-config', () => {
      if (this.ownWriteTracker.consume(uri.fsPath)) {
        console.log('[FileWatcherService] Ignoring own write to layers.json');
        return;
      }
      console.log('[FileWatcherService] Layer config changed');
      this.safeFireEvent(() => this._onLayerConfigChanged.fire());
    });
  }

  /**
   * Watch dbt_project.yml for changes to path-related keys.
   * Only fires onProjectConfigChanged when target-path or model-paths actually change,
   * ignoring irrelevant edits (name, version, vars, etc.).
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
          console.log('[FileWatcherService] dbt_project.yml path config changed');
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
   * Read path-related keys (target-path, model-paths) from dbt_project.yml.
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
        if (/^(target-path|model-paths)\s*:/.test(line)) {
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
   * Watch {semanticDir}/logical-models/*.yml for changes.
   * Fires when model definition files are created, modified, or deleted.
   * Used to refresh open domain editors that reference the changed model.
   */
  private setupLogicalModelWatcher(): void {
    const pattern = new vscode.RelativePattern(
      this.workspaceRoot,
      `${this.semanticDir}/${LOGICAL_MODELS_DIR}/*.yml`,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handleChange = (uri: vscode.Uri) => {
      const modelName = uri.fsPath.replace(/^.*[/\\]/, '').replace(/\.yml$/, '');
      this.debounce(`logical-model:${modelName}`, () => {
        if (this.ownWriteTracker.consume(uri.fsPath)) {
          console.log(`[FileWatcherService] Ignoring own write to model: ${modelName}`);
          return;
        }
        console.log(`[FileWatcherService] Logical model changed: ${modelName}`);
        this.safeFireEvent(() => this._onLogicalModelChanged.fire({ uri, modelName }));
      });
    };

    this.subscriptions.push(watcher.onDidChange(handleChange));
    this.subscriptions.push(watcher.onDidCreate(handleChange));
    this.subscriptions.push(watcher.onDidDelete(handleChange));

    this.watchers.push(watcher);
  }

  /**
   * Watch {model-paths}/**\/*.{yml,yaml} for changes.
   * Fires when dbt schema files are created, modified, or deleted.
   * Used to refresh the physical stage which derives from .yml source files.
   */
  private setupDbtYmlWatcher(): void {
    const pattern = new vscode.RelativePattern(
      this.workspaceRoot,
      `${modelPathsGlob(this.dbtConfig)}/**/*.{yml,yaml}`,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handleChange = () => {
      this.debounce('dbt-yml', () => {
        console.log('[FileWatcherService] dbt schema .yml changed');
        this.safeFireEvent(() => this._onDbtYmlChanged.fire());
      });
    };

    this.subscriptions.push(watcher.onDidChange(handleChange));
    this.subscriptions.push(watcher.onDidCreate(handleChange));
    this.subscriptions.push(watcher.onDidDelete(handleChange));

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
        // Delete timer after callback completes to prevent race conditions
        this.debounceTimers.delete(key);
      }
    }, DEBOUNCE_DELAY_MS);

    this.debounceTimers.set(key, timer);
  }

  /**
   * Safely fire an event, catching any errors from listeners.
   * Prevents consumer errors from crashing the file watcher.
   */
  private safeFireEvent(fireFn: () => void): void {
    try {
      fireFn();
    } catch (err) {
      console.error('[FileWatcherService] Error in event handler:', err);
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
    this._onSemanticFileChanged.dispose();
    this._onSemanticFileDeleted.dispose();
    this._onLayerConfigChanged.dispose();
    this._onLogicalModelChanged.dispose();
    this._onDbtYmlChanged.dispose();
    this._onProjectConfigChanged.dispose();
  }
}
