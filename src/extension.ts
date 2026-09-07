import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { DomainService, renameDomainInRaw } from './services/domainService';
import { LayerService } from './services/layerService';
import { CURRENT_SCHEMA_VERSION, type DomainSummary, type Layer, type Stage, type UnifiedDomain, type StageData } from './types/semantic';
import { ManifestService } from './services/manifestService';
import { TemplateService } from './services/templateService';
import { DomainTreeProvider, type TreeElement } from './providers/DomainTreeProvider';
import { SemanticEditorProvider } from './providers/SemanticEditorProvider';
import { SemanticFileDecorationProvider } from './providers/SemanticFileDecorationProvider';
import { LayerDecorationProvider } from './providers/LayerDecorationProvider';
import { FileWatcherService } from './watchers/FileWatcherService';
import { HarnessService, HARNESS_TARGETS, HARNESS_VERSION, extractHarnessVersion } from './services/harnessService';
import { SelectorsService } from './services/selectorsService';
import { LegacyTagCleanupService } from './services/legacyTagCleanupService';
import { LogicalModelService } from './services/logicalModelService';
import { ownWrites } from './services/ownWriteTracker';
import { MigrationService, migrateLegacySemanticDir } from './services/migrationService';
import { YmlParserService } from './services/ymlParserService';
import { getErdStudioSetting } from './services/configService';
import { ModelLibraryTreeProvider, type ModelLibraryNode } from './providers/ModelLibraryTreeProvider';
import { DOMAIN_EDITOR_VIEW_TYPE, hasOpenDomainCanvas, saveAllAndReload } from './services/recoveryService';
import { submitBugReport } from './services/feedbackService';

/**
 * globalState key for the last extension version this host activated under.
 * If activation sees a different version stored here, the previous extension
 * host was torn down by an update — any open domain canvas is now orphaned
 * and the only reliable recovery is a window reload.
 */
const LAST_ACTIVATED_VERSION_KEY = 'lastActivatedVersion';

/**
 * workspaceState key set once the harness install QuickPick has been offered
 * for a workspace with no harness files, so it is not shown on every activation.
 */
const HARNESS_INSTALL_PROMPTED_KEY = 'erdStudio.harnessInstallPrompted';

/** Directories never descended into when searching for a nested dbt project. */
const DBT_SEARCH_SKIP_DIRS = new Set(['node_modules', 'dbt_packages', '.git', 'target', '.venv', 'venv']);

/** Maximum directory depth (below a workspace folder) searched for dbt_project.yml. */
const DBT_SEARCH_MAX_DEPTH = 3;

function hasDbtProjectFile(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'dbt_project.yml')).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the dbt project root from a list of workspace folder paths and the
 * `erdStudio.projectPath` setting. Pure (no vscode access) so it is unit-testable.
 *
 * Resolution order:
 *   1. `projectPath` setting — absolute, or relative to each workspace folder —
 *      when it contains dbt_project.yml.
 *   2. A workspace folder whose root contains dbt_project.yml.
 *   3. A depth-limited breadth-first search below each workspace folder
 *      (skipping node_modules, dbt_packages, .git, target, .venv), returning
 *      the shallowest match. Matches the recursive `workspaceContains`
 *      activation event so activation never lands on "no project found"
 *      for a monorepo with dbt in a subfolder.
 */
export function resolveDbtProjectRoot(
  folderPaths: readonly string[],
  projectPathSetting: string,
): string | undefined {
  const configured = projectPathSetting.trim();
  if (configured) {
    if (path.isAbsolute(configured)) {
      if (hasDbtProjectFile(configured)) { return configured; }
    } else {
      for (const folder of folderPaths) {
        const candidate = path.resolve(folder, configured);
        if (hasDbtProjectFile(candidate)) { return candidate; }
      }
    }
    console.warn(`ERD Studio: erdStudio.projectPath "${configured}" does not contain dbt_project.yml — falling back to auto-detection.`);
  }

  for (const folder of folderPaths) {
    if (hasDbtProjectFile(folder)) { return folder; }
  }

  // Breadth-first so the shallowest match wins.
  let frontier = [...folderPaths];
  for (let depth = 1; depth <= DBT_SEARCH_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of frontier) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!entry.isDirectory() || DBT_SEARCH_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        const child = path.join(dir, entry.name);
        if (hasDbtProjectFile(child)) { return child; }
        next.push(child);
      }
    }
    frontier = next;
  }

  return undefined;
}

/**
 * Find the dbt project root: honours `erdStudio.projectPath`, then workspace
 * folder roots, then a shallow recursive search. See `resolveDbtProjectRoot`.
 */
function findDbtProjectRoot(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }
  return resolveDbtProjectRoot(
    workspaceFolders.map(f => f.uri.fsPath),
    getErdStudioSetting('projectPath', ''),
  );
}

const NO_PROJECT_MESSAGE =
  'ERD Studio: No dbt project found. Open a folder containing dbt_project.yml, ' +
  'or set erdStudio.projectPath to the dbt project folder.';

/**
 * Register every contributed command (and its legacy dbtSemantic.* alias)
 * with a handler that explains why ERD Studio is inactive, plus a stub
 * custom editor for domain files. Used when no dbt project could be found so
 * the palette, sidebar welcome buttons and domain JSON files show a helpful
 * message instead of "command not found" / a blank editor error.
 */
function registerFallbackCommands(context: vscode.ExtensionContext): void {
  const showNoProject = async (): Promise<void> => {
    const choice = await vscode.window.showWarningMessage(NO_PROJECT_MESSAGE, 'Open Settings');
    if (choice === 'Open Settings') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'erdStudio.projectPath');
    }
  };

  const contributed = (context.extension.packageJSON as {
    contributes?: { commands?: Array<{ command: string }> };
  }).contributes?.commands ?? [];

  for (const { command } of contributed) {
    if (!command.startsWith('erdStudio.')) { continue; }
    context.subscriptions.push(
      vscode.commands.registerCommand(command, showNoProject),
      vscode.commands.registerCommand(command.replace(/^erdStudio\./, 'dbtSemantic.'), showNoProject),
    );
  }

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(DOMAIN_EDITOR_VIEW_TYPE, {
      resolveCustomTextEditor(_document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
        panel.webview.options = { enableScripts: false };
        panel.webview.html =
          '<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:1.5em">' +
          '<h2>ERD Studio is inactive</h2>' +
          `<p>${NO_PROJECT_MESSAGE}</p>` +
          '<p>Reload the window after fixing the project location.</p>' +
          '</body></html>';
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Shared helper functions
// ---------------------------------------------------------------------------

function findMatchingTabs(fileUri: vscode.Uri): vscode.Tab[] {
  const allTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
  return allTabs.filter(tab => {
    const input = tab.input;
    return input && typeof input === 'object' && 'uri' in input &&
      (input as { uri: vscode.Uri }).uri.toString() === fileUri.toString();
  });
}

async function handleUnsavedChanges(
  fileUri: vscode.Uri,
  domainName: string,
  operation: 'deleting' | 'renaming',
): Promise<boolean> {
  const matchingTabs = findMatchingTabs(fileUri);
  const dirtyTab = matchingTabs.find(tab => tab.isDirty);

  if (!dirtyTab) {
    return true;
  }

  const saveChoice = await vscode.window.showWarningMessage(
    `Domain "${domainName}" has unsaved changes. Save before ${operation}?`,
    { modal: true },
    'Save',
    'Discard',
    'Cancel',
  );

  if (saveChoice === 'Cancel' || saveChoice === undefined) {
    return false;
  }

  if (saveChoice === 'Save') {
    const doc = vscode.workspace.textDocuments.find(
      d => d.uri.toString() === fileUri.toString(),
    );
    if (doc) {
      const saved = await doc.save();
      if (!saved) {
        const opName = operation === 'deleting' ? 'Deletion' : 'Rename';
        void vscode.window.showErrorMessage(
          `Failed to save "${domainName}". ${opName} cancelled.`,
        );
        return false;
      }
    }
  }

  return true;
}

function validateDomainSlug(
  value: string,
  layer: Layer,
  existingDomains: DomainSummary[],
  currentDomainName?: string,
): string | undefined {
  if (!value || !value.trim()) {
    return 'Domain name is required';
  }

  const slug = value.trim();

  if (currentDomainName && slug === currentDomainName) {
    return 'Domain name unchanged';
  }

  if (!/^[a-z][a-z0-9_-]*$/.test(slug)) {
    return 'Domain name must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, and underscores';
  }

  if (slug.length > 64) {
    return 'Domain name must be 64 characters or less';
  }

  const collision = existingDomains.find(
    d => d.domain === slug && d.layer === layer,
  );
  if (collision) {
    return `A domain named "${slug}" already exists in the ${layer} layer`;
  }

  return undefined;
}

/** Shared color options for layer creation and editing. */
const LAYER_COLOR_OPTIONS = [
  { label: '⚪ Silver', value: '#a0a0a0' },
  { label: '🟡 Gold', value: '#d4a800' },
  { label: '🔵 Blue', value: '#3b82f6' },
  { label: '🟢 Green', value: '#22c55e' },
  { label: '🟣 Purple', value: '#a855f7' },
  { label: '🟠 Orange', value: '#f97316' },
  { label: '🩵 Cyan', value: '#06b6d4' },
  { label: '🔴 Red', value: '#ef4444' },
  { label: '$(edit) Custom hex color...', value: 'custom' },
];

/**
 * "Report a Bug" without an active canvas: gather a title and a one-line
 * description via input boxes, then open the prefilled GitHub issue form.
 */
async function reportBugWithoutCanvas(
  context: vscode.ExtensionContext,
  prefill?: { title?: string; description?: string },
): Promise<void> {
  const title = await vscode.window.showInputBox({
    title: 'ERD Studio — Report a Bug (1/2)',
    prompt: 'One-line summary of the problem',
    value: prefill?.title ?? '',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Please enter a short title'),
  });
  if (title === undefined) return;
  const description = await vscode.window.showInputBox({
    title: 'ERD Studio — Report a Bug (2/2)',
    prompt: 'What happened? You can add more detail on GitHub before submitting.',
    value: prefill?.description ?? '',
    ignoreFocusOut: true,
  });
  if (description === undefined) return;
  await submitBugReport(context, { title, description, includeDiagnostics: true });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('ERD Studio is now active');

  // Auto-recover from extension updates that orphaned an open domain canvas.
  // VS Code 1.88+ restarts the extension host without a window reload when
  // an extension version changes — the new host has no message handler bound
  // for the existing webview, leaving a blank canvas. Detect by comparing
  // the version we last activated under to the current one. The globalState
  // update is awaited *before* the reload to prevent a reload loop if the
  // host crashes mid-recovery.
  const currentVersion = context.extension.packageJSON.version as string;
  const previousVersion = context.globalState.get<string>(LAST_ACTIVATED_VERSION_KEY);
  await context.globalState.update(LAST_ACTIVATED_VERSION_KEY, currentVersion);
  if (previousVersion && previousVersion !== currentVersion && hasOpenDomainCanvas()) {
    // If the user cancels the reload (unsaved files), keep activating so
    // commands and the custom editor are still registered for this host.
    if (await saveAllAndReload(`ERD Studio updated to v${currentVersion}`)) {
      return;
    }
  }

  // "Report a Bug" is registered before any early return so it is always
  // reachable from the command palette, even when no dbt project is open.
  // When a canvas is active the report is routed through its webview so it
  // can include a screenshot and domain context.
  let editorProviderForFeedback: SemanticEditorProvider | undefined;
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'erdStudio.reportBug',
      async (prefill?: { title?: string; description?: string }) => {
        if (editorProviderForFeedback?.requestBugReportDialog(prefill)) return;
        await reportBugWithoutCanvas(context, prefill);
      },
    ),
  );

  const workspaceRoot = findDbtProjectRoot();
  if (!workspaceRoot) {
    // Register stub commands / editor so palette entries and the sidebar
    // welcome buttons explain the problem instead of "command not found".
    registerFallbackCommands(context);
    void vscode.window.showWarningMessage(NO_PROJECT_MESSAGE, 'Open Settings').then(choice => {
      if (choice === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'erdStudio.projectPath');
      }
    });
    return;
  }

  console.log(`ERD Studio: Found dbt project at ${workspaceRoot}`);

  const semanticDir = getErdStudioSetting('semanticDir', '.erd-studio');

  // v0.6.44 moved the default data directory from erd-studio/ to .erd-studio/.
  // Rename legacy folders in place before any service reads from disk so
  // existing projects keep working without intervention.
  try {
    if (migrateLegacySemanticDir(workspaceRoot, semanticDir)) {
      void vscode.window.showInformationMessage(
        'ERD Studio: your erd-studio/ folder was renamed to .erd-studio/ (the new default location). ' +
          'Commit the rename so collaborators stay in sync.',
      );
    }
  } catch (err) {
    // Never let a filesystem oddity (permissions, dangling symlink, …) in a
    // legacy folder abort activation — the rest of the extension still works.
    console.error('[ERD Studio] Legacy erd-studio/ migration failed:', err);
  }

  const layerService = new LayerService(workspaceRoot, semanticDir);
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(workspaceRoot, semanticDir);
  domainService.setLogicalModelService(logicalModelService);
  const manifestService = new ManifestService();
  const ymlParserService = new YmlParserService();
  const templateService = new TemplateService();
  // Status bar item shown while selectors.yml is out of sync (skipped writes).
  // Hidden as soon as a regenerate succeeds.
  let selectorsOutOfSyncStatus: vscode.StatusBarItem | undefined;

  const selectorsService = new SelectorsService(
    domainService,
    workspaceRoot,
    semanticDir,
    {
      isFileDirtyInEditor: (filePath) =>
        vscode.workspace.textDocuments.some(
          doc => doc.uri.fsPath === filePath && doc.isDirty,
        ),
      onSkipped: (info) => {
        const message = info.reason === 'unsaved-edits'
          ? 'selectors.yml has unsaved edits in your editor — ERD Studio won\'t overwrite to avoid losing your work. ' +
            'Save (or revert) the file, then click "Resync now" to update selectors.yml.'
          : `selectors.yml has a YAML syntax error and can't be safely regenerated: ${info.detail} ` +
            'Fix the syntax error in selectors.yml, save the file, then click "Resync now" to update.';

        void vscode.window
          .showWarningMessage(message, 'Show file', 'Resync now')
          .then((choice) => {
            if (choice === 'Show file') {
              void vscode.window.showTextDocument(vscode.Uri.file(info.filePath));
            } else if (choice === 'Resync now') {
              void vscode.commands.executeCommand('erdStudio.syncDomainTags');
            }
          });

        if (!selectorsOutOfSyncStatus) {
          selectorsOutOfSyncStatus = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            0,
          );
          selectorsOutOfSyncStatus.command = 'erdStudio.syncDomainTags';
          selectorsOutOfSyncStatus.backgroundColor = new vscode.ThemeColor(
            'statusBarItem.warningBackground',
          );
          context.subscriptions.push(selectorsOutOfSyncStatus);
        }
        selectorsOutOfSyncStatus.text = '$(warning) selectors.yml out of sync';
        selectorsOutOfSyncStatus.tooltip = info.reason === 'unsaved-edits'
          ? 'selectors.yml has unsaved edits — save the file, then click to resync.'
          : `selectors.yml is malformed (${info.detail.split('\n')[0]}) — fix the YAML, then click to resync.`;
        selectorsOutOfSyncStatus.show();
      },
      onWritten: () => {
        selectorsOutOfSyncStatus?.hide();
      },
    },
  );
  const legacyTagCleanupService = new LegacyTagCleanupService(workspaceRoot);

  // Ensure selectors.yml exists and is up to date at activation time so a
  // fresh `git clone` with pre-existing domain files gets a valid selector
  // set before the user makes any edits. Debounced so activation isn't
  // blocked on disk I/O.
  selectorsService.scheduleRegenerate();

  // Check for v4 → v5 migration (non-blocking)
  const migrationService = new MigrationService(workspaceRoot, layerService, logicalModelService, semanticDir);
  if (migrationService.needsMigration()) {
    void vscode.window.showInformationMessage(
      'ERD Studio has a new model storage format that enables cross-domain model sharing. Migrate domain files now?',
      'Migrate Now',
      'Later',
    ).then((choice) => {
      if (choice === 'Migrate Now') {
        const result = migrationService.migrate();
        const details: string[] = [];
        if (result.domainsConverted > 0) details.push(`${result.domainsConverted} domain(s) converted`);
        if (result.modelsCreated > 0) details.push(`${result.modelsCreated} model file(s) created in logical-models/`);
        if (result.mergeConflicts.length > 0) details.push(`${result.mergeConflicts.length} merge conflict(s) resolved (richest version kept)`);
        vscode.window.showInformationMessage(`Migration complete: ${details.join(', ')}.`);
        selectorsService.scheduleRegenerate();
      }
    });
  }
  const treeProvider = new DomainTreeProvider(domainService, layerService, workspaceRoot, semanticDir);
  const modelLibraryProvider = new ModelLibraryTreeProvider(logicalModelService, domainService, workspaceRoot, semanticDir);
  const editorProvider = new SemanticEditorProvider(
    context,
    domainService,
    manifestService,
    ymlParserService,
    templateService,
    layerService,
    workspaceRoot,
    selectorsService,
    logicalModelService,
  );
  editorProviderForFeedback = editorProvider;
  const decorationProvider = new SemanticFileDecorationProvider(layerService, semanticDir);
  const layerDecorationProvider = new LayerDecorationProvider(layerService);

  // Set context keys so view/title menus only show when semantic dir exists.
  // Re-evaluated whenever the semantic dir changes on disk (watcher events) or
  // the extension itself creates it (createDomain, addLayer, setup), so the
  // "+ Add Layer" / "Install Harness" buttons appear without a window reload.
  const fullSemanticDirPath = path.join(workspaceRoot, semanticDir);
  const refreshContextKeys = (): void => {
    void vscode.commands.executeCommand('setContext', 'erdStudio.hasSemanticDir', fs.existsSync(fullSemanticDirPath));
    void vscode.commands.executeCommand('setContext', 'erdStudio.hasLogicalModelsDir', logicalModelService.dirExists());
  };
  refreshContextKeys();

  // Surface a broken layers.json once per distinct error. LayerService falls
  // back to default layers in memory but refuses to overwrite the file, so the
  // user must know why their custom layers vanished.
  let lastLayerLoadErrorShown: string | null = null;
  const warnIfLayerConfigBroken = (): void => {
    const loadError = layerService.getLoadError();
    if (!loadError || loadError === lastLayerLoadErrorShown) {
      if (!loadError) { lastLayerLoadErrorShown = null; }
      return;
    }
    lastLayerLoadErrorShown = loadError;
    void vscode.window.showWarningMessage(
      `ERD Studio: ${semanticDir}/layers.json could not be loaded (${loadError}). ` +
      'Default layers are shown until the file is fixed; layer changes are disabled to avoid overwriting it.',
      'Open layers.json',
    ).then(choice => {
      if (choice === 'Open layers.json') {
        void vscode.window.showTextDocument(vscode.Uri.file(layerService.getConfigPath()));
      }
    });
  };
  warnIfLayerConfigBroken();

  // -------------------------------------------------------------------------
  // File watchers
  // -------------------------------------------------------------------------
  const fileWatcherService = new FileWatcherService(workspaceRoot, semanticDir);

  // Manifest changed → refresh open editors
  let manifestRetryTimeout: ReturnType<typeof setTimeout> | undefined;
  let manifestChangeGen = 0;
  const manifestChangedSubscription = fileWatcherService.onManifestChanged(
    async () => {
      const gen = ++manifestChangeGen;
      manifestService.invalidate();
      await editorProvider.refreshAllOpenDomains();

      // Superseded by a newer file-change event during the await
      if (gen !== manifestChangeGen) { return; }

      if (manifestService.isStale) {
        // Manifest likely mid-write by dbt — deduplicate and retry once after 2s
        clearTimeout(manifestRetryTimeout);
        manifestRetryTimeout = setTimeout(async () => {
          const retryGen = manifestChangeGen;
          try {
            manifestService.invalidate();
            await editorProvider.refreshAllOpenDomains();
            // Superseded by a newer event during retry
            if (retryGen !== manifestChangeGen) { return; }
            if (!manifestService.isStale) {
              void vscode.window.showInformationMessage(
                'dbt manifest updated. Graphs refreshed with latest model data.',
              );
            } else {
              void vscode.window.showWarningMessage(
                'dbt manifest still updating — graph may show stale data. Run dbt compile to refresh.',
              );
            }
          } catch (err) {
            console.error('[ERD Studio] Manifest retry failed:', err);
          }
        }, 2000);
      } else {
        void vscode.window.showInformationMessage(
          'dbt manifest updated. Graphs refreshed with latest model data.',
        );
      }
    },
  );

  // Semantic file changed externally → refresh tree view + model library
  const semanticChangedSubscription = fileWatcherService.onSemanticFileChanged(({ uri }) => {
    treeProvider.invalidateDomain(uri.fsPath);
    treeProvider.refresh();
    modelLibraryProvider.refresh();
    // A pulled/created .erd-studio/ must reveal the view/title buttons without a reload
    refreshContextKeys();
  });

  // Domain file(s) deleted → refresh tree + model library, prompt for tag cleanup.
  // The watcher coalesces a delete storm (branch switch) into one event and
  // filters out layers.json / templates / logical-models / .sync-plan.json, so
  // one toast covers the whole burst and only real domain files trigger it.
  // NOTE: reconcileAll() is NOT called automatically here because git operations
  // (pull, checkout, merge, rebase) trigger file-delete events on Windows (delete-
  // then-rename) and macOS (atomic rename via FSEvents), causing mass YAML
  // modifications. Instead, offer to run the manual sync command.
  const semanticDeletedSubscription = fileWatcherService.onSemanticFileDeleted(({ uris }) => {
    for (const uri of uris) {
      treeProvider.invalidateDomain(uri.fsPath);
    }
    treeProvider.refresh();
    modelLibraryProvider.refresh();
    refreshContextKeys();
    const subject = uris.length === 1
      ? 'Domain file deleted.'
      : `${uris.length} domain files deleted.`;
    void vscode.window.showInformationMessage(
      `${subject} Regenerate dbt selectors.yml to drop the removed domain${uris.length === 1 ? '' : 's'} from the selector set.`,
      'Regenerate Now',
    ).then(choice => {
      if (choice === 'Regenerate Now') {
        void vscode.commands.executeCommand('erdStudio.syncDomainTags');
      }
    });
  });

  // layers.json changed externally (git pull, manual edit, delete) → drop the
  // cached layer list so the tree, decorations and domain listing pick up the
  // new layers; warn if the file is now unreadable.
  const layerConfigChangedSubscription = fileWatcherService.onLayerConfigChanged(() => {
    layerService.invalidateCache();
    treeProvider.invalidateDomain();
    treeProvider.refresh();
    modelLibraryProvider.refresh();
    layerDecorationProvider.refresh();
    decorationProvider.refresh();
    refreshContextKeys();
    warnIfLayerConfigBroken();
  });

  // Logical model file changed → refresh domains referencing that model + model library
  const logicalModelChangedSubscription = fileWatcherService.onLogicalModelChanged(
    async ({ modelName }) => {
      logicalModelService.invalidateCache(modelName);
      await editorProvider.refreshDomainsReferencingModel(modelName);
      treeProvider.refresh();
      modelLibraryProvider.refresh();
      // Re-evaluate context key so the Model Library view appears if logical-models/ was just created
      refreshContextKeys();
    },
  );

  // dbt schema .yml changed → refresh physical stage
  const dbtYmlChangedSubscription = fileWatcherService.onDbtYmlChanged(
    async () => {
      ymlParserService.invalidate();
      await editorProvider.refreshAllOpenDomains();
    },
  );

  // dbt_project.yml path config changed → suggest window reload
  const projectChangedSubscription = fileWatcherService.onProjectConfigChanged(() => {
    void vscode.window.showWarningMessage(
      'dbt_project.yml path configuration changed (target-path / model-paths). A window reload is needed to pick up the new paths.',
      'Reload Window',
    ).then(action => {
      if (action === 'Reload Window') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
  });

  context.subscriptions.push(
    { dispose() { clearTimeout(manifestRetryTimeout); } },
    treeProvider,
    decorationProvider,
    layerDecorationProvider,
    fileWatcherService,
    manifestChangedSubscription,
    semanticChangedSubscription,
    semanticDeletedSubscription,
    layerConfigChangedSubscription,
    logicalModelChangedSubscription,
    dbtYmlChangedSubscription,
    projectChangedSubscription,
    (() => {
      const treeView = vscode.window.createTreeView('erdStudio.domainTree', {
        treeDataProvider: treeProvider,
        dragAndDropController: treeProvider,
        canSelectMany: false,
      });
      return treeView;
    })(),
    vscode.window.registerCustomEditorProvider(DOMAIN_EDITOR_VIEW_TYPE, editorProvider),
    vscode.window.registerFileDecorationProvider(decorationProvider),
    vscode.window.registerFileDecorationProvider(layerDecorationProvider),
    modelLibraryProvider,
    (() => {
      return vscode.window.createTreeView('erdStudio.modelLibrary', {
        treeDataProvider: modelLibraryProvider,
        canSelectMany: false,
      });
    })(),
    vscode.commands.registerCommand('erdStudio.deleteLogicalModel', async (node: ModelLibraryNode | undefined) => {
      if (!node || node.type !== 'model') {
        void vscode.window.showErrorMessage('Delete Model: No model selected. Right-click a model in the Model Library.');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete model "${node.name}"? This removes the YAML file — domain references are not cleaned up.`,
        { modal: true },
        'Delete',
      );
      if (confirm === 'Delete') {
        logicalModelService.deleteModel(node.name);
        modelLibraryProvider.refresh();
      }
    }),
    vscode.commands.registerCommand('erdStudio.revealLogicalModel', (node: ModelLibraryNode | undefined) => {
      if (!node || node.type !== 'model') {
        void vscode.window.showErrorMessage('Reveal in Explorer: No model selected. Right-click a model in the Model Library.');
        return;
      }
      void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(node.filePath));
    }),
    vscode.commands.registerCommand('erdStudio.openDomain', async (filePath: string, stage?: Stage) => {
      const fileUri = vscode.Uri.file(filePath);
      await vscode.commands.executeCommand(
        'vscode.openWith',
        fileUri,
        DOMAIN_EDITOR_VIEW_TYPE,
      );
      if (stage === 'physical') {
        editorProvider.switchStageForUri(fileUri, 'physical');
      }
    }),
    vscode.commands.registerCommand(
      'erdStudio.createDomain',
      async (layerArg?: Layer) => {
        // Step 1: Determine layer
        let layer: Layer | undefined = layerArg;
        if (!layer) {
          const creatableLayers = layerService.getCreatableLayers();
          if (creatableLayers.length === 0) {
            void vscode.window.showErrorMessage('No layers configured for domain creation. Add layers first.');
            return;
          }
          const layerItems = creatableLayers.map(l => ({ label: l.label, value: l.id }));
          const layerChoice = await vscode.window.showQuickPick(layerItems, {
            placeHolder: 'Select layer for the new semantic domain',
            ignoreFocusOut: true,
          });
          if (!layerChoice) { return; }
          layer = layerChoice.value;
        }

        // Step 2: Get domain name
        const existingDomains = domainService.listDomains(workspaceRoot, semanticDir);
        const domainSlug = await vscode.window.showInputBox({
          prompt: 'Enter domain name (slug format)',
          placeHolder: 'e.g. customer-360, sales-analytics, orders',
          ignoreFocusOut: true,
          validateInput: (value: string) =>
            validateDomainSlug(value, layer, existingDomains),
        });
        if (!domainSlug) { return; }
        const slug = domainSlug.trim();

        // Step 3: Get description
        const description = await vscode.window.showInputBox({
          prompt: 'Enter domain description (optional)',
          placeHolder: 'e.g. Customer 360 view with orders and interactions',
          ignoreFocusOut: true,
        });
        if (description === undefined) { return; }

        // Step 4: Get model folder filter (try yml source files first, fall back to manifest)
        let modelFolder: string | undefined;
        try {
          await ymlParserService.loadYmlData(workspaceRoot);
          let availableFolders = ymlParserService.getModelFolders(workspaceRoot);
          if (availableFolders.length === 0) {
            await manifestService.loadManifest(workspaceRoot);
            availableFolders = manifestService.getModelFolders();
          }
          if (availableFolders.length > 0) {
            const folderItems: Array<{ label: string; value: string | undefined }> = [
              { label: '$(folder) Any folder (no filter)', value: undefined },
              ...availableFolders.map((folder) => ({ label: `$(folder) ${folder}`, value: folder })),
            ];
            const folderChoice = await vscode.window.showQuickPick(folderItems, {
              placeHolder: 'Filter models by folder (optional)',
              ignoreFocusOut: true,
            });
            if (folderChoice === undefined) { return; }
            modelFolder = folderChoice.value;
          }
        } catch {
          console.warn('[createDomain] Failed to load manifest for folder detection, skipping folder picker');
        }

        // Step 5: Create unified v3 domain file
        const layerDir = path.join(workspaceRoot, semanticDir, layer);
        const filePath = path.join(layerDir, `${slug}.json`);

        try {
          if (!fs.existsSync(layerDir)) {
            fs.mkdirSync(layerDir, { recursive: true });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to create directory: ${msg}`);
          return;
        }

        const emptyStage: StageData = { models: [], relationships: [] };
        const domainData: UnifiedDomain = {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          domain: slug,
          layer,
          description: description.trim(),
          ...(modelFolder ? { modelFolder } : {}),
          logical: { ...emptyStage },
          viewConfig: {},
        };

        try {
          fs.writeFileSync(filePath, JSON.stringify(domainData, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
        } catch (err) {
          if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
            void vscode.window.showErrorMessage(`Domain "${slug}" already exists in the ${layer} layer`);
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to create domain file: ${msg}`);
          return;
        }

        // Step 6: Refresh tree, regenerate selectors.yml, and auto-open domain.
        // The semantic dir may have just been created — reveal the title buttons.
        refreshContextKeys();
        treeProvider.refresh();
        selectorsService.scheduleRegenerate();
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(filePath),
          DOMAIN_EDITOR_VIEW_TYPE,
        );
      },
    ),
    vscode.commands.registerCommand(
      'erdStudio.deleteDomain',
      async (element?: TreeElement) => {
        if (!element || element.type !== 'domain') {
          void vscode.window.showErrorMessage('Delete Domain: No domain selected. Right-click a domain in the tree view.');
          return;
        }

        const domainName = element.summary.domain;
        const filePath = element.summary.filePath;
        const fileUri = vscode.Uri.file(filePath);

        const shouldProceed = await handleUnsavedChanges(fileUri, domainName, 'deleting');
        if (!shouldProceed) { return; }

        const confirm = await vscode.window.showWarningMessage(
          `Are you sure you want to delete domain "${domainName}"?`,
          { modal: true },
          'Delete',
        );
        if (confirm !== 'Delete') { return; }

        // Close any open editors
        const matchingTabs = findMatchingTabs(fileUri);
        if (matchingTabs.length > 0) {
          await vscode.window.tabGroups.close(matchingTabs, true);
        }

        // Delete the unified domain file. Record it as an own delete so the
        // watcher does not show the "Domain file deleted" toast — selectors
        // regeneration is already scheduled below.
        try {
          await vscode.workspace.fs.delete(fileUri);
          ownWrites.recordDelete(filePath);
          treeProvider.invalidateDomain(filePath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to delete domain: ${msg}`);
        }

        treeProvider.refresh();
        selectorsService.scheduleRegenerate();
      },
    ),
    vscode.commands.registerCommand(
      'erdStudio.renameDomain',
      async (element?: TreeElement) => {
        if (!element || element.type !== 'domain') {
          void vscode.window.showErrorMessage('Rename Domain: No domain selected. Right-click a domain in the tree view.');
          return;
        }

        const oldDomainName = element.summary.domain;
        const oldFilePath = element.summary.filePath;
        const oldFileUri = vscode.Uri.file(oldFilePath);
        const layer = element.summary.layer;

        const shouldProceed = await handleUnsavedChanges(oldFileUri, oldDomainName, 'renaming');
        if (!shouldProceed) { return; }

        const existingDomains = domainService.listDomains(workspaceRoot, semanticDir);
        const newDomainSlug = await vscode.window.showInputBox({
          prompt: 'Enter new domain name',
          value: oldDomainName,
          ignoreFocusOut: true,
          validateInput: (value: string) =>
            validateDomainSlug(value, layer, existingDomains, oldDomainName),
        });
        if (!newDomainSlug) { return; }
        const newSlug = newDomainSlug.trim();
        if (newSlug === oldDomainName) { return; }

        // Read and update domain name in the unified file.
        // Validate via DomainService, but rewrite the RAW document so v5 model
        // name references and unknown keys are preserved — re-serialising the
        // resolved UnifiedDomain would inline model bodies into a v5 file.
        let renamedContent: string;
        try {
          domainService.getDomain(oldFilePath);
          renamedContent = renameDomainInRaw(fs.readFileSync(oldFilePath, 'utf-8'), newSlug);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to read domain file: ${msg}`);
          return;
        }

        // Close old editor tabs before applying the edit (file will be deleted)
        const oldTabs = findMatchingTabs(oldFileUri);
        if (oldTabs.length > 0) { await vscode.window.tabGroups.close(oldTabs, true); }

        const newFilePath = path.join(workspaceRoot, semanticDir, layer, `${newSlug}.json`);
        const newFileUri = vscode.Uri.file(newFilePath);

        const edit = new vscode.WorkspaceEdit();
        edit.createFile(newFileUri, { overwrite: false, ignoreIfExists: false });
        edit.insert(newFileUri, new vscode.Position(0, 0), renamedContent);
        edit.deleteFile(oldFileUri, { ignoreIfNotExists: false });

        const success = await vscode.workspace.applyEdit(edit);
        if (!success) {
          void vscode.window.showErrorMessage(`Failed to rename domain "${oldDomainName}" to "${newSlug}"`);
          return;
        }

        // Auto-open renamed domain
        selectorsService.scheduleRegenerate();
        await vscode.commands.executeCommand('vscode.openWith', newFileUri, DOMAIN_EDITOR_VIEW_TYPE);
      },
    ),
    vscode.commands.registerCommand('erdStudio.refreshManifest', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Refreshing dbt manifest...',
          cancellable: false,
        },
        async () => {
          manifestService.invalidate();
          ymlParserService.invalidate();
          await manifestService.loadManifest(workspaceRoot);
          await ymlParserService.loadYmlData(workspaceRoot);
          await editorProvider.refreshAllOpenDomains();
          void vscode.window.showInformationMessage('Manifest refreshed. Graphs updated with latest model data.');
        },
      );
    }),
    // Regenerate the root selectors.yml from current domain files.
    // Run a domain refresh in dbt with: dbt build --selector domain_{layer}_{domain}
    vscode.commands.registerCommand('erdStudio.syncDomainTags', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Regenerating dbt selectors.yml...',
          cancellable: false,
        },
        async () => {
          try {
            const result = selectorsService.regenerate();
            if (result.status === 'written') {
              const relPath = path.relative(workspaceRoot, result.filePath);
              void vscode.window.showInformationMessage(
                `Wrote ${result.selectorsWritten} selector(s) covering ${result.modelsReferenced} model reference(s) to ${relPath}.`,
              );
            } else if (result.status === 'noop') {
              void vscode.window.showInformationMessage(
                'No domains with models found — selectors.yml was not created.',
              );
            }
            // For 'skipped': the onSkipped hook has already shown the
            // out-of-sync notification + status bar. No success toast.
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`Failed to regenerate selectors.yml: ${msg}`);
          }
        },
      );
    }),
    // One-shot cleanup: strip legacy `domain:*` tags from every model YAML
    // left behind by the old SchemaTagService. Safe to run repeatedly.
    vscode.commands.registerCommand('erdStudio.stripLegacyDomainTags', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'This will scan every .yml file in your workspace and remove any `domain:*` tag from `config.tags` or top-level `tags` on each dbt model. ' +
          'Review and commit the changes as a single PR. Continue?',
        { modal: true },
        'Strip Tags',
      );
      if (confirm !== 'Strip Tags') { return; }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Stripping legacy domain tags...',
          cancellable: false,
        },
        async () => {
          const result = legacyTagCleanupService.stripAll();

          if (result.errors.length > 0) {
            for (const err of result.errors) {
              console.warn(`[LegacyTagCleanup] ${err}`);
            }
          }

          if (result.tagsRemoved === 0) {
            void vscode.window.showInformationMessage(
              `No legacy domain tags found. Scanned ${result.filesScanned} YAML file(s).`,
            );
            return;
          }

          const choice = await vscode.window.showInformationMessage(
            `Removed ${result.tagsRemoved} tag(s) from ${result.filesModified} file(s). Scanned ${result.filesScanned}. Review the diff before committing.` +
              (result.errors.length > 0 ? ` (${result.errors.length} file(s) skipped — see Output.)` : ''),
            'Show Modified Files',
          );
          if (choice === 'Show Modified Files') {
            const items = result.modifiedPaths.map((p) => ({
              label: path.relative(workspaceRoot, p),
              description: '',
              fullPath: p,
            }));
            const picked = await vscode.window.showQuickPick(items, {
              placeHolder: 'Open a modified file to review',
            });
            if (picked) {
              await vscode.window.showTextDocument(vscode.Uri.file(picked.fullPath), { preview: true });
            }
          }
        },
      );
    }),
    // Migrate v4 domains to v5 central model store
    vscode.commands.registerCommand('erdStudio.migrateToV5', async () => {
      if (!migrationService.needsMigration()) {
        void vscode.window.showInformationMessage('All domain files are already using the v5 central model store format.');
        return;
      }

      const v4Count = migrationService.findV4Domains().length;
      const confirm = await vscode.window.showWarningMessage(
        `Found ${v4Count} domain file(s) using the legacy inline model format. ` +
        'Migration will extract models to .erd-studio/logical-models/ and convert domain files to use name references. ' +
        'This cannot be undone automatically.',
        'Migrate Now',
        'Cancel',
      );

      if (confirm !== 'Migrate Now') return;

      const result = migrationService.migrate();
      const details: string[] = [];
      if (result.domainsConverted > 0) details.push(`${result.domainsConverted} domain(s) converted`);
      if (result.modelsCreated > 0) details.push(`${result.modelsCreated} model file(s) created in logical-models/`);
      if (result.mergeConflicts.length > 0) details.push(`${result.mergeConflicts.length} merge conflict(s) resolved`);
      void vscode.window.showInformationMessage(`Migration complete: ${details.join(', ')}.`);

      treeProvider.refresh();
      await editorProvider.refreshAllOpenDomains();
      selectorsService.scheduleRegenerate();
    }),
    // F408: Set up semantic directory for new projects
    vscode.commands.registerCommand(
      'erdStudio.setupSemanticDirectory',
      async () => {
        const fullSemanticDir = path.join(workspaceRoot, semanticDir);
        const defaultLayers = layerService.getAllLayers();

        try {
          if (!fs.existsSync(fullSemanticDir)) {
            fs.mkdirSync(fullSemanticDir, { recursive: true });
          }

          // Create layer directories
          for (const layer of defaultLayers) {
            const layerDir = path.join(fullSemanticDir, layer.id);
            if (!fs.existsSync(layerDir)) {
              fs.mkdirSync(layerDir, { recursive: true });
            }
          }

          // Create logical-models directory
          const logicalModelsDir = path.join(fullSemanticDir, 'logical-models');
          if (!fs.existsSync(logicalModelsDir)) {
            fs.mkdirSync(logicalModelsDir, { recursive: true });
          }

          await layerService.saveConfig(defaultLayers);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to create semantic directory structure: ${msg}`);
          return;
        }

        // Update context keys so view/title menus appear
        refreshContextKeys();
        treeProvider.refresh();
        await new Promise(resolve => setTimeout(resolve, 100));
        void vscode.window.showInformationMessage('ERD Studio directory created! Now create your first domain.');
        await vscode.commands.executeCommand('erdStudio.createDomain');
      },
    ),
    // -------------------------------------------------------------------------
    // Layer Management Commands (unchanged)
    // -------------------------------------------------------------------------
    vscode.commands.registerCommand(
      'erdStudio.addLayer',
      async () => {
        // Step 1: Layer ID
        const id = await vscode.window.showInputBox({
          prompt: 'Layer name (lowercase, e.g., platinum)',
          placeHolder: 'e.g., platinum, staging, raw',
          ignoreFocusOut: true,
          validateInput: (value: string) => {
            if (!value || !value.trim()) { return 'Layer name is required'; }
            if (!/^[a-z][a-z0-9_-]*$/.test(value.trim())) { return 'Must start with lowercase letter, contain only lowercase letters, numbers, hyphens, underscores'; }
            if (layerService.hasLayer(value.trim())) { return `Layer "${value.trim()}" already exists`; }
            return undefined;
          },
        });
        if (!id) return;
        const layerId = id.trim();

        // Step 2: Color
        const colorPick = await vscode.window.showQuickPick(LAYER_COLOR_OPTIONS, {
          placeHolder: `Select color for "${layerId}" layer`,
          ignoreFocusOut: true,
        });
        if (!colorPick) return;

        let color = colorPick.value;
        if (color === 'custom') {
          const customColor = await vscode.window.showInputBox({
            prompt: 'Enter hex color (e.g., #ff5733)',
            placeHolder: '#ff5733',
            ignoreFocusOut: true,
            validateInput: (value: string) => {
              if (!/^#[0-9a-fA-F]{6}$/.test(value)) { return 'Invalid hex color format (e.g., #ff5733)'; }
              return undefined;
            },
          });
          if (!customColor) return;
          color = customColor;
        }

        // Auto-generate label and abbreviation from ID
        const label = layerId.charAt(0).toUpperCase() + layerId.slice(1);
        const abbreviation = layerId.slice(0, 3).toUpperCase();

        try {
          await layerService.addLayer({
            id: layerId,
            label,
            abbreviation,
            color,
            creatable: true,
          });

          // Create layer directory
          const layerDir = path.join(workspaceRoot, semanticDir, layerId);
          if (!fs.existsSync(layerDir)) {
            fs.mkdirSync(layerDir, { recursive: true });
          }

          refreshContextKeys();
          treeProvider.refresh();
          layerDecorationProvider.refresh();
          decorationProvider.refresh();
          void vscode.window.showInformationMessage(`Layer "${label}" added. Use Edit Layer to customize display name or abbreviation.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to add layer: ${msg}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'erdStudio.editLayer',
      async (element?: TreeElement) => {
        let layerId: string | undefined;
        if (element && element.type === 'layer') {
          layerId = element.layer;
        } else {
          const layers = layerService.getAllLayers();
          const layerPick = await vscode.window.showQuickPick(
            layers.map(l => ({ label: l.label, value: l.id })),
            { placeHolder: 'Select layer to edit' },
          );
          if (!layerPick) return;
          layerId = layerPick.value;
        }

        const layer = layerService.getLayer(layerId);
        if (!layer) {
          void vscode.window.showErrorMessage(`Layer "${layerId}" not found`);
          return;
        }

        const editOptions = [
          { label: '$(edit) Rename Layer', value: 'rename' },
          { label: '$(symbol-color) Change Color', value: 'color' },
          { label: '$(tag) Change Abbreviation', value: 'abbreviation' },
        ];
        const editChoice = await vscode.window.showQuickPick(editOptions, {
          placeHolder: `Edit layer: ${layer.label}`,
        });
        if (!editChoice) return;

        try {
          switch (editChoice.value) {
            case 'rename': {
              const newLabel = await vscode.window.showInputBox({ prompt: 'New layer display name', value: layer.label, ignoreFocusOut: true });
              if (newLabel === undefined || newLabel.trim() === layer.label) return;
              await layerService.updateLayer(layerId, { label: newLabel.trim() });
              break;
            }
            case 'color': {
              const colorPick = await vscode.window.showQuickPick(LAYER_COLOR_OPTIONS, { placeHolder: 'Select new color' });
              if (!colorPick) return;
              let color = colorPick.value;
              if (color === 'custom') {
                const customColor = await vscode.window.showInputBox({
                  prompt: 'Enter hex color (e.g., #ff5733)', value: layer.color, ignoreFocusOut: true,
                  validateInput: (value: string) => { if (!/^#[0-9a-fA-F]{6}$/.test(value)) { return 'Invalid hex color format'; } return undefined; },
                });
                if (!customColor) return;
                color = customColor;
              }
              await layerService.updateLayerColor(layerId, color);
              break;
            }
            case 'abbreviation': {
              const newAbbrev = await vscode.window.showInputBox({
                prompt: 'New abbreviation (3-4 characters)', value: layer.abbreviation, ignoreFocusOut: true,
                validateInput: (value: string) => {
                  if (!value || value.trim().length === 0) { return 'Abbreviation is required'; }
                  if (value.trim().length > 4) { return 'Abbreviation should be 3-4 characters'; }
                  return undefined;
                },
              });
              if (newAbbrev === undefined) return;
              await layerService.updateLayer(layerId, { abbreviation: newAbbrev.trim().toUpperCase() });
              break;
            }
          }

          treeProvider.refresh();
          layerDecorationProvider.refresh();
          decorationProvider.refresh();
          void vscode.window.showInformationMessage(`Layer "${layer.label}" updated.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to update layer: ${msg}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'erdStudio.removeLayer',
      async (element?: TreeElement) => {
        let layerId: string | undefined;
        if (element && element.type === 'layer') {
          layerId = element.layer;
        } else {
          const layers = layerService.getAllLayers();
          const layerPick = await vscode.window.showQuickPick(
            layers.map(l => ({ label: l.label, value: l.id })),
            { placeHolder: 'Select layer to remove' },
          );
          if (!layerPick) return;
          layerId = layerPick.value;
        }

        const layer = layerService.getLayer(layerId);
        if (!layer) {
          void vscode.window.showErrorMessage(`Layer "${layerId}" not found`);
          return;
        }

        const domains = domainService.listDomains(workspaceRoot, semanticDir);
        const layerDomains = domains.filter(d => d.layer === layerId);
        if (layerDomains.length > 0) {
          void vscode.window.showErrorMessage(
            `Cannot remove layer "${layer.label}" — it contains ${layerDomains.length} domain(s). Delete or move domains first.`,
          );
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Remove layer "${layer.label}"? This will delete the directories.`,
          { modal: true },
          'Remove',
        );
        if (confirm !== 'Remove') return;

        try {
          await layerService.removeLayer(layerId);

          // Remove layer directory
          const layerDir = path.join(workspaceRoot, semanticDir, layerId);
          if (fs.existsSync(layerDir)) {
            await vscode.workspace.fs.delete(vscode.Uri.file(layerDir), { recursive: true });
          }

          treeProvider.refresh();
          layerDecorationProvider.refresh();
          decorationProvider.refresh();
          void vscode.window.showInformationMessage(`Layer "${layer.label}" removed.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to remove layer: ${msg}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'erdStudio.initializeLayerConfig',
      async () => {
        // saveConfig refuses to overwrite an unreadable layers.json (H18) —
        // surface that as a message rather than an unhandled command failure.
        try {
          const detected = layerService.detectLayersFromFilesystem();
          if (detected.length === 0) {
            const defaultLayers = layerService.getAllLayers();
            await layerService.saveConfig(defaultLayers);
            refreshContextKeys();
            void vscode.window.showInformationMessage('Layer configuration saved with default layers (Silver, Gold).');
            return;
          }

          const layerNames = detected.map(l => l.label).join(', ');
          const choice = await vscode.window.showInformationMessage(
            `Detected layers: ${layerNames}. Save this configuration?`,
            'Save', 'Customize', 'Cancel',
          );

          if (choice === 'Save') {
            await layerService.saveConfig(detected);
            layerService.invalidateCache();
            refreshContextKeys();
            treeProvider.refresh();
            layerDecorationProvider.refresh();
            decorationProvider.refresh();
            void vscode.window.showInformationMessage(`Layer configuration saved to ${semanticDir}/layers.json`);
          } else if (choice === 'Customize') {
            await layerService.saveConfig(detected);
            refreshContextKeys();
            const uri = vscode.Uri.file(layerService.getConfigPath());
            await vscode.commands.executeCommand('vscode.open', uri);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to save layer configuration: ${msg}`);
        }
      },
    ),
    // -------------------------------------------------------------------------
    // AI Coding Harness Installation
    // -------------------------------------------------------------------------
    vscode.commands.registerCommand(
      'erdStudio.installCodingHarness',
      async () => {
        const harnessService = new HarnessService();
        const existing = harnessService.detectExisting(workspaceRoot);
        const staleTargets = harnessService.detectStale(workspaceRoot);
        const staleIds = new Set(staleTargets.map(t => t.id));

        // Build QuickPick items with existing/outdated status
        const items = HARNESS_TARGETS.map(target => {
          const exists = existing.get(target.id);
          const isStale = staleIds.has(target.id);
          let description = target.description;
          if (exists && isStale) {
            description = '$(warning) outdated — update available';
          } else if (exists) {
            // A file without our version marker was not written by ERD Studio.
            let managed = false;
            try {
              managed = extractHarnessVersion(
                fs.readFileSync(path.join(workspaceRoot, target.relativePath), 'utf-8'),
              ) !== null;
            } catch {
              // unreadable — treat as unmanaged
            }
            description = managed
              ? '$(check) installed (v' + HARNESS_VERSION + ')'
              : target.id === 'codex'
                ? '$(info) existing AGENTS.md — ERD Studio section will be appended'
                : '$(warning) existing file not managed by ERD Studio — will be replaced';
          }
          return {
            label: target.label,
            description,
            picked: isStale, // Pre-select outdated targets
            target,
            exists,
          };
        });

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select AI coding harnesses to install ERD Studio schema into',
          canPickMany: true,
          ignoreFocusOut: true,
        });

        if (!selected || selected.length === 0) { return; }

        // Always overwrite — harness files are managed by the extension
        const results = selected.map(s =>
          harnessService.install(workspaceRoot, s.target, true),
        );

        const succeeded = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);

        if (failed.length > 0) {
          const errors = failed.map(r => `${r.target.id}: ${r.error}`).join('; ');
          void vscode.window.showErrorMessage(
            `Harness install: ${succeeded.length} installed, ${failed.length} failed. Errors: ${errors}`,
          );
        } else {
          void vscode.window.showInformationMessage(
            `AI coding harness: ${succeeded.length} installed.`,
          );
        }
      },
    ),
  );

  // AI coding harness — prompt to update stale files; offer install once per
  // workspace when none are present. Never overwrite anything silently:
  // harness files (AGENTS.md in particular) can hold user content.
  {
    const harnessService = new HarnessService();
    const existing = harnessService.detectExisting(workspaceRoot);
    const installedCount = [...existing.values()].filter(Boolean).length;
    const staleTargets = harnessService.detectStale(workspaceRoot);

    if (staleTargets.length > 0) {
      const names = staleTargets.map(t => t.label.replace(/\$\([^)]+\)\s*/g, '')).join(', ');
      void vscode.window.showWarningMessage(
        `ERD Studio: ${staleTargets.length} AI coding harness file(s) outdated (${names}). Update to v${HARNESS_VERSION}?`,
        'Update All',
        'Choose…',
        'Dismiss',
      ).then(choice => {
        if (choice === 'Update All') {
          const results = staleTargets.map(target => harnessService.install(workspaceRoot, target, true));
          const failed = results.filter(r => !r.success);
          if (failed.length > 0) {
            const errors = failed.map(r => `${r.target.id}: ${r.error}`).join('; ');
            void vscode.window.showErrorMessage(
              `ERD Studio: ${failed.length} harness file(s) could not be updated. Errors: ${errors}`,
            );
          } else {
            void vscode.window.showInformationMessage(
              `ERD Studio: Updated ${results.length} AI coding harness file(s) to v${HARNESS_VERSION} (${names}).`,
            );
          }
        } else if (choice === 'Choose…') {
          // QuickPick pre-selects the outdated targets
          void vscode.commands.executeCommand('erdStudio.installCodingHarness');
        }
      });
    } else if (installedCount === 0 && !context.workspaceState.get<boolean>(HARNESS_INSTALL_PROMPTED_KEY)) {
      // No harnesses installed — offer the QuickPick once per workspace, not
      // on every window open. The command stays available in the palette.
      void context.workspaceState.update(HARNESS_INSTALL_PROMPTED_KEY, true);
      void vscode.commands.executeCommand('erdStudio.installCodingHarness');
    }
  }

  // First-run check
  const fullSemanticDir = path.join(workspaceRoot, semanticDir);
  if (fs.existsSync(fullSemanticDir) && !layerService.configFileExists()) {
    const detected = layerService.detectLayersFromFilesystem();
    if (detected.length > 0) {
      const layerNames = detected.map(l => l.label).join(', ');
      void vscode.window.showInformationMessage(
        `Detected layers: ${layerNames}. Would you like to save layer configuration for customization?`,
        'Save Config', 'Later',
      ).then(async (choice) => {
        if (choice === 'Save Config') {
          try {
            await layerService.saveConfig(detected);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`Failed to save layer configuration: ${msg}`);
            return;
          }
          layerService.invalidateCache();
          refreshContextKeys();
          treeProvider.refresh();
          layerDecorationProvider.refresh();
          decorationProvider.refresh();
          void vscode.window.showInformationMessage(`Layer configuration saved to ${semanticDir}/layers.json`);
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Legacy command aliases
  // ---------------------------------------------------------------------------
  // The extension was originally published with dbtSemantic.* command IDs.
  // Keep them callable (registered in code only, so they stay out of the
  // command palette) so existing user keybindings keep working after the
  // erdStudio.* rename.
  const LEGACY_ALIASED_COMMANDS = [
    'createDomain',
    'setupSemanticDirectory',
    'openDomain',
    'deleteDomain',
    'refreshManifest',
    'renameDomain',
    'addLayer',
    'editLayer',
    'removeLayer',
    'initializeLayerConfig',
    'installCodingHarness',
    'syncDomainTags',
    'stripLegacyDomainTags',
    'migrateToV5',
    'deleteLogicalModel',
    'revealLogicalModel',
  ];
  for (const name of LEGACY_ALIASED_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`dbtSemantic.${name}`, (...args: unknown[]) =>
        vscode.commands.executeCommand(`erdStudio.${name}`, ...args),
      ),
    );
  }
}

export function deactivate(): void {
  // Cleanup will be added when services are implemented
}
