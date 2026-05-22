/**
 * FileWatcherService — manages file system watchers for dbt project files.
 *
 * Watches:
 * - target/manifest.json (dbt compile output) → triggers manifest cache invalidation
 * - erd-studio/**\/*.json (semantic domain files) → triggers tree and editor refresh
 * - dbt_project.yml (project configuration) → reload prompt only when path config changes
 *
 * All change events are debounced by 300ms to prevent rapid-fire triggers
 * during batch operations (e.g., git checkout, dbt compile).
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

const DEBOUNCE_DELAY_MS = 300;

export class FileWatcherService implements vscode.Disposable {
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();

  // Event emitters (private — fire events internally)
  private readonly _onManifestChanged = new vscode.EventEmitter<void>();
  private readonly _onSemanticFileChanged = new vscode.EventEmitter<{ uri: vscode.Uri }>();
  private readonly _onSemanticFileDeleted = new vscode.EventEmitter<{ uri: vscode.Uri }>();
  private readonly _onLogicalModelChanged = new vscode.EventEmitter<{ uri: vscode.Uri; modelName: string }>();
  private readonly _onDbtYmlChanged = new vscode.EventEmitter<void>();
  private readonly _onProjectConfigChanged = new vscode.EventEmitter<void>();

  // Public event subscriptions (consumers listen to these)
  readonly onManifestChanged = this._onManifestChanged.event;
  readonly onSemanticFileChanged = this._onSemanticFileChanged.event;
  readonly onSemanticFileDeleted = this._onSemanticFileDeleted.event;
  /** Fires when a YAML model file in erd-studio/logical-models/ changes. */
  readonly onLogicalModelChanged = this._onLogicalModelChanged.event;
  /** Fires when any dbt schema .yml/.yaml file under models/ changes. */
  readonly onDbtYmlChanged = this._onDbtYmlChanged.event;
  /** Fires when target-path or model-paths change in dbt_project.yml. */
  readonly onProjectConfigChanged = this._onProjectConfigChanged.event;

  /** Snapshot of path-related keys from dbt_project.yml at startup. */
  private lastProjectPaths: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly semanticDir: string = 'erd-studio',
  ) {
    this.lastProjectPaths = this.readProjectPaths();
    this.setupManifestWatcher();
    this.setupSemanticWatcher();
    this.setupProjectConfigWatcher();
    this.setupLogicalModelWatcher();
    this.setupDbtYmlWatcher();
  }

  /**
   * Watch target/manifest.json for changes.
   * Fires when dbt compile generates a new manifest.
   */
  private setupManifestWatcher(): void {
    const pattern = new vscode.RelativePattern(
      this.workspaceRoot,
      'target/manifest.json',
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
    // Note: onDidDelete not handled — missing manifest is handled gracefully by ManifestService

    this.watchers.push(watcher);
  }

  /**
   * Watch erd-studio/**\/*.json for changes.
   * Fires when domain files are created, modified, or deleted externally.
   */
  private setupSemanticWatcher(): void {
    const pattern = new vscode.RelativePattern(
      this.workspaceRoot,
      `${this.semanticDir}/**/*.json`,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handleChange = (uri: vscode.Uri) => {
      // Per-file debounce key allows parallel updates to different files
      this.debounce(`semantic:${uri.toString()}`, () => {
        console.log(`[FileWatcherService] Semantic file changed: ${uri.fsPath}`);
        this.safeFireEvent(() => this._onSemanticFileChanged.fire({ uri }));
      });
    };

    const handleDelete = (uri: vscode.Uri) => {
      this.debounce(`semantic-del:${uri.toString()}`, () => {
        console.log(`[FileWatcherService] Semantic file deleted: ${uri.fsPath}`);
        this.safeFireEvent(() => this._onSemanticFileDeleted.fire({ uri }));
      });
    };

    // Track event subscriptions for disposal
    this.subscriptions.push(watcher.onDidChange(handleChange));
    this.subscriptions.push(watcher.onDidCreate(handleChange));
    this.subscriptions.push(watcher.onDidDelete(handleDelete));

    this.watchers.push(watcher);
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
   * Watch erd-studio/logical-models/*.yml for changes.
   * Fires when model definition files are created, modified, or deleted.
   * Used to refresh open domain editors that reference the changed model.
   */
  private setupLogicalModelWatcher(): void {
    const pattern = new vscode.RelativePattern(
      this.workspaceRoot,
      `${this.semanticDir}/logical-models/*.yml`,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handleChange = (uri: vscode.Uri) => {
      const modelName = uri.fsPath.replace(/^.*[/\\]/, '').replace(/\.yml$/, '');
      this.debounce(`logical-model:${modelName}`, () => {
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
   * Watch models/**\/*.{yml,yaml} for changes.
   * Fires when dbt schema files are created, modified, or deleted.
   * Used to refresh the physical stage which derives from .yml source files.
   */
  private setupDbtYmlWatcher(): void {
    const pattern = new vscode.RelativePattern(
      this.workspaceRoot,
      'models/**/*.{yml,yaml}',
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
    this._onLogicalModelChanged.dispose();
    this._onDbtYmlChanged.dispose();
    this._onProjectConfigChanged.dispose();
  }
}
