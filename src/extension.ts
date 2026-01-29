import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { DomainService } from './services/domainService';
import { CURRENT_SCHEMA_VERSION, type DomainSummary, type Layer, type SemanticDomain } from './types/semantic';
import { ManifestService } from './services/manifestService';
import { ReconciliationService } from './services/reconciliationService';
import { TemplateService } from './services/templateService';
import { AutoReconciliationService } from './services/autoReconciliationService';
import { DomainTreeProvider, type TreeElement } from './providers/DomainTreeProvider';
import { SemanticEditorProvider } from './providers/SemanticEditorProvider';
import { SemanticFileDecorationProvider } from './providers/SemanticFileDecorationProvider';
import { FileWatcherService } from './watchers/FileWatcherService';

/**
 * Find the dbt project root by searching workspace folders for dbt_project.yml.
 * Returns the first workspace folder containing the file.
 */
function findDbtProjectRoot(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }

  for (const folder of workspaceFolders) {
    const projectPath = folder.uri.fsPath;
    const dbtProjectFile = path.join(projectPath, 'dbt_project.yml');

    if (fs.existsSync(dbtProjectFile)) {
      return projectPath;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Shared helper functions
// ---------------------------------------------------------------------------

/**
 * Find all open editor tabs for a given file URI.
 */
function findMatchingTabs(fileUri: vscode.Uri): vscode.Tab[] {
  const allTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
  return allTabs.filter(tab => {
    const input = tab.input;
    return input && typeof input === 'object' && 'uri' in input &&
      (input as { uri: vscode.Uri }).uri.toString() === fileUri.toString();
  });
}

/**
 * Handle unsaved changes in open editors for a domain file.
 * Returns true if the operation should proceed, false if cancelled.
 */
async function handleUnsavedChanges(
  fileUri: vscode.Uri,
  domainName: string,
  operation: 'deleting' | 'renaming',
): Promise<boolean> {
  const matchingTabs = findMatchingTabs(fileUri);
  const dirtyTab = matchingTabs.find(tab => tab.isDirty);

  if (!dirtyTab) {
    return true; // No unsaved changes, proceed
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

  // 'Discard' continues without saving
  return true;
}

/**
 * Validate a domain slug for create or rename operations.
 * Returns an error message if invalid, undefined if valid.
 */
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

  // Check if unchanged (only for rename)
  if (currentDomainName && slug === currentDomainName) {
    return 'Domain name unchanged';
  }

  // Validate slug format: lowercase, alphanumeric, hyphens, underscores
  if (!/^[a-z][a-z0-9_-]*$/.test(slug)) {
    return 'Domain name must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, and underscores';
  }

  if (slug.length > 64) {
    return 'Domain name must be 64 characters or less';
  }

  // Check for collision in the same layer
  const collision = existingDomains.find(
    d => d.domain === slug && d.layer === layer,
  );
  if (collision) {
    return `A domain named "${slug}" already exists in the ${layer} layer`;
  }

  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  console.log('dbt Semantic Designer is now active');

  const workspaceRoot = findDbtProjectRoot();
  if (!workspaceRoot) {
    void vscode.window.showWarningMessage(
      'dbt Semantic Designer: No dbt project found. ' +
        'Open a folder containing dbt_project.yml to activate.',
    );
    return;
  }

  console.log(`dbt Semantic Designer: Found dbt project at ${workspaceRoot}`);

  const domainService = new DomainService();
  const manifestService = new ManifestService();
  const reconciliationService = new ReconciliationService();
  const templateService = new TemplateService();
  const autoReconciliationService = new AutoReconciliationService();
  const treeProvider = new DomainTreeProvider(domainService, workspaceRoot);
  const editorProvider = new SemanticEditorProvider(
    context,
    domainService,
    manifestService,
    reconciliationService,
    templateService,
    autoReconciliationService,
    workspaceRoot,
  );
  const decorationProvider = new SemanticFileDecorationProvider();

  // -------------------------------------------------------------------------
  // File watchers for auto-refresh (F303)
  // -------------------------------------------------------------------------
  const fileWatcherService = new FileWatcherService(workspaceRoot);

  // Manifest changed (dbt compile ran) → auto-reconcile open domains (F304)
  const manifestChangedSubscription = fileWatcherService.onManifestChanged(
    async () => {
      // Step 1: Invalidate and reload manifest
      manifestService.invalidate();
      const manifest = await manifestService.loadManifest(workspaceRoot);

      // Step 2: Check autoReconcile setting
      const config = vscode.workspace.getConfiguration('dbtSemantic');
      const autoReconcile = config.get<boolean>('autoReconcile', true);

      if (!autoReconcile) {
        // Auto-reconciliation disabled - just notify
        void vscode.window.showInformationMessage(
          'dbt manifest updated. Auto-reconciliation is disabled.',
        );
        return;
      }

      // Step 3: Reconcile all open domain editors
      const allNewlyBuilt =
        await editorProvider.reconcileAllOpenDomains(manifest);

      // Step 4: Show notification
      if (allNewlyBuilt.length > 0) {
        const modelList = allNewlyBuilt.join(', ');
        void vscode.window.showInformationMessage(
          `${allNewlyBuilt.length} design model(s) have been built: ${modelList}`,
        );
      } else {
        void vscode.window.showInformationMessage(
          'dbt manifest updated. Graphs will refresh with latest model data.',
        );
      }
    },
  );

  // Semantic file changed externally → refresh tree view
  // (Open editors handle their own refresh via onDidChangeTextDocument)
  const semanticChangedSubscription = fileWatcherService.onSemanticFileChanged(() => {
    treeProvider.refresh();
  });

  // dbt_project.yml changed → suggest window reload
  const projectChangedSubscription = fileWatcherService.onProjectConfigChanged(() => {
    void vscode.window.showWarningMessage(
      'dbt_project.yml has changed. Some changes require a window reload to take effect.',
      'Reload Window',
    ).then(action => {
      if (action === 'Reload Window') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
  });

  context.subscriptions.push(
    treeProvider,
    decorationProvider,
    fileWatcherService,
    manifestChangedSubscription,
    semanticChangedSubscription,
    projectChangedSubscription,
    vscode.window.registerTreeDataProvider('dbtSemantic.domainTree', treeProvider),
    vscode.window.registerCustomEditorProvider('dbtSemantic.domainEditor', editorProvider),
    vscode.window.registerFileDecorationProvider(decorationProvider),
    vscode.commands.registerCommand('dbtSemantic.openDomain', (filePath: string) => {
      vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(filePath),
        'dbtSemantic.domainEditor',
      );
    }),
    vscode.commands.registerCommand(
      'dbtSemantic.createDomain',
      async (layerArg?: Layer) => {
        // Step 1: Determine layer (skip QuickPick if passed from tree view)
        let layer: Layer | undefined = layerArg;
        if (!layer) {
          const layerItems: Array<{ label: string; value: Layer }> = [
            { label: 'Silver', value: 'silver' },
            { label: 'Gold', value: 'gold' },
          ];
          const layerChoice = await vscode.window.showQuickPick(layerItems, {
            placeHolder: 'Select layer for the new semantic domain',
            ignoreFocusOut: true,
          });
          if (!layerChoice) {
            return; // User cancelled
          }
          layer = layerChoice.value;
        }

        // Step 2: Get domain name (slug) with validation
        const existingDomains = domainService.listDomains(workspaceRoot);
        const domainSlug = await vscode.window.showInputBox({
          prompt: 'Enter domain name (slug format)',
          placeHolder: 'e.g. customer-360, sales-analytics, work-lots',
          ignoreFocusOut: true,
          validateInput: (value: string) =>
            validateDomainSlug(value, layer, existingDomains),
        });
        if (!domainSlug) {
          return; // User cancelled
        }
        const slug = domainSlug.trim();

        // Step 3: Get description (optional)
        const description = await vscode.window.showInputBox({
          prompt: 'Enter domain description (optional)',
          placeHolder: 'e.g. Customer 360 view with orders and interactions',
          ignoreFocusOut: true,
        });
        if (description === undefined) {
          return; // User cancelled (empty string is valid)
        }

        // Step 4: Create directory and file
        const layerDir = path.join(workspaceRoot, 'models', 'semantic', layer);
        const filePath = path.join(layerDir, `${slug}.json`);

        // Create directory if needed
        try {
          if (!fs.existsSync(layerDir)) {
            fs.mkdirSync(layerDir, { recursive: true });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(
            `Failed to create directory: ${msg}`,
          );
          return;
        }

        // Create domain JSON with initial schema
        const domainData = {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          domain: slug,
          layer,
          description: description.trim(),
          models: [],
          relationships: [],
          viewConfig: {},
        };

        // Write file atomically (flag 'wx' fails if file exists, preventing race conditions)
        try {
          fs.writeFileSync(
            filePath,
            JSON.stringify(domainData, null, 2) + '\n',
            { encoding: 'utf-8', flag: 'wx' },
          );
        } catch (err) {
          // Handle file-already-exists case (EEXIST error)
          if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
            void vscode.window.showErrorMessage(
              `Domain "${slug}" already exists in ${layer} layer`,
            );
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(
            `Failed to create domain file: ${msg}`,
          );
          return;
        }

        // Step 5: Refresh tree view
        treeProvider.refresh();

        // Step 6: Auto-open in custom editor
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(filePath),
          'dbtSemantic.domainEditor',
        );
      },
    ),
    vscode.commands.registerCommand(
      'dbtSemantic.deleteDomain',
      async (element?: TreeElement) => {
        // Validate we have a domain node (from context menu)
        if (!element || element.type !== 'domain') {
          void vscode.window.showErrorMessage(
            'Delete Domain: No domain selected. Right-click a domain in the tree view.',
          );
          return;
        }

        const domainName = element.summary.domain;
        const filePath = element.summary.filePath;
        const fileUri = vscode.Uri.file(filePath);

        // Step 1: Check for open editors with unsaved changes
        const shouldProceed = await handleUnsavedChanges(fileUri, domainName, 'deleting');
        if (!shouldProceed) {
          return;
        }

        // Step 2: Show confirmation dialog
        const confirm = await vscode.window.showWarningMessage(
          `Are you sure you want to delete domain "${domainName}"?`,
          { modal: true },
          'Delete',
        );
        if (confirm !== 'Delete') {
          return;
        }

        // Step 3: Close any open editors for this file
        const matchingTabs = findMatchingTabs(fileUri);
        if (matchingTabs.length > 0) {
          await vscode.window.tabGroups.close(matchingTabs, /* preserveFocus */ true);
        }

        // Step 4: Delete the file
        try {
          await vscode.workspace.fs.delete(fileUri);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to delete domain: ${msg}`);
          return;
        }

        // Step 5: Refresh the tree view
        treeProvider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      'dbtSemantic.renameDomain',
      async (element?: TreeElement) => {
        // Validate we have a domain node (from context menu)
        if (!element || element.type !== 'domain') {
          void vscode.window.showErrorMessage(
            'Rename Domain: No domain selected. Right-click a domain in the tree view.',
          );
          return;
        }

        const oldDomainName = element.summary.domain;
        const oldFilePath = element.summary.filePath;
        const oldFileUri = vscode.Uri.file(oldFilePath);
        const layer = element.summary.layer;

        // Step 1: Check for open editors with unsaved changes
        const shouldProceed = await handleUnsavedChanges(oldFileUri, oldDomainName, 'renaming');
        if (!shouldProceed) {
          return;
        }

        // Step 2: Get new domain name with validation
        const existingDomains = domainService.listDomains(workspaceRoot);
        const newDomainSlug = await vscode.window.showInputBox({
          prompt: 'Enter new domain name',
          value: oldDomainName,
          ignoreFocusOut: true,
          validateInput: (value: string) =>
            validateDomainSlug(value, layer, existingDomains, oldDomainName),
        });

        if (!newDomainSlug) {
          return; // User cancelled
        }
        const newSlug = newDomainSlug.trim();

        // Defensive check for unchanged name
        if (newSlug === oldDomainName) {
          return;
        }

        // Step 3: Read current domain JSON
        let domainData: SemanticDomain;
        try {
          domainData = domainService.getDomain(oldFilePath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(
            `Failed to read domain file: ${msg}`,
          );
          return;
        }

        // Update domain field
        domainData.domain = newSlug;

        // Step 4: Create new file path
        const layerDir = path.dirname(oldFilePath);
        const newFilePath = path.join(layerDir, `${newSlug}.json`);
        const newFileUri = vscode.Uri.file(newFilePath);

        // Step 5: Perform atomic rename with WorkspaceEdit
        const edit = new vscode.WorkspaceEdit();

        // Create new file with updated content
        edit.createFile(newFileUri, {
          overwrite: false,
          ignoreIfExists: false,
        });
        edit.insert(
          newFileUri,
          new vscode.Position(0, 0),
          JSON.stringify(domainData, null, 2) + '\n',
        );

        // Delete old file
        edit.deleteFile(oldFileUri, {
          ignoreIfNotExists: false,
        });

        // Apply edit
        const success = await vscode.workspace.applyEdit(edit);
        if (!success) {
          void vscode.window.showErrorMessage(
            `Failed to rename domain "${oldDomainName}" to "${newSlug}"`,
          );
          return;
        }

        // Step 6: Close old editor tabs
        const matchingTabs = findMatchingTabs(oldFileUri);
        if (matchingTabs.length > 0) {
          await vscode.window.tabGroups.close(matchingTabs, /* preserveFocus */ true);
        }

        // Step 7: Auto-open renamed domain in custom editor
        // (Tree view refresh handled by file watcher)
        await vscode.commands.executeCommand(
          'vscode.openWith',
          newFileUri,
          'dbtSemantic.domainEditor',
        );
      },
    ),
    vscode.commands.registerCommand('dbtSemantic.refreshManifest', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Refreshing dbt manifest...',
          cancellable: false,
        },
        async () => {
          // Step 1: Invalidate and reload manifest
          manifestService.invalidate();
          const manifest = await manifestService.loadManifest(workspaceRoot);

          // Step 2: Check autoReconcile setting
          const config = vscode.workspace.getConfiguration('dbtSemantic');
          const autoReconcile = config.get<boolean>('autoReconcile', true);

          if (!autoReconcile) {
            // Auto-reconciliation disabled - just refresh editors without transitioning
            await editorProvider.refreshAllOpenDomains();
            void vscode.window.showInformationMessage(
              'Manifest refreshed. Auto-reconciliation is disabled.',
            );
            return;
          }

          // Step 3: Reconcile all open domain editors
          const allNewlyBuilt =
            await editorProvider.reconcileAllOpenDomains(manifest);

          // Step 4: Show notification
          if (allNewlyBuilt.length > 0) {
            const modelList = allNewlyBuilt.join(', ');
            void vscode.window.showInformationMessage(
              `Manifest refreshed. ${allNewlyBuilt.length} design model(s) have been built: ${modelList}`,
            );
          } else {
            void vscode.window.showInformationMessage(
              'Manifest refreshed. Graphs updated with latest model data.',
            );
          }
        },
      );
    }),
  );
}

export function deactivate(): void {
  // Cleanup will be added when services are implemented
}
