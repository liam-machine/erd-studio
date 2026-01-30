import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { DomainService } from './services/domainService';
import { LayerService } from './services/layerService';
import { CURRENT_SCHEMA_VERSION, type DomainSummary, type Layer, type SemanticDomain } from './types/semantic';
import { ManifestService } from './services/manifestService';
import { ReconciliationService } from './services/reconciliationService';
import { TemplateService } from './services/templateService';
import { AutoReconciliationService } from './services/autoReconciliationService';
import { DomainTreeProvider, type TreeElement } from './providers/DomainTreeProvider';
import { SemanticEditorProvider } from './providers/SemanticEditorProvider';
import { SemanticFileDecorationProvider } from './providers/SemanticFileDecorationProvider';
import { LayerDecorationProvider } from './providers/LayerDecorationProvider';
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

  // Read configuration for semantic directory path
  const config = vscode.workspace.getConfiguration('dbtSemantic');
  const semanticDir = config.get<string>('semanticDir', 'models/semantic');

  // LayerService must be instantiated first as other services depend on it
  const layerService = new LayerService(workspaceRoot, semanticDir);
  const domainService = new DomainService(layerService);
  const manifestService = new ManifestService();
  const reconciliationService = new ReconciliationService();
  const templateService = new TemplateService();
  const autoReconciliationService = new AutoReconciliationService();
  const treeProvider = new DomainTreeProvider(domainService, layerService, workspaceRoot, semanticDir);
  const editorProvider = new SemanticEditorProvider(
    context,
    domainService,
    manifestService,
    reconciliationService,
    templateService,
    autoReconciliationService,
    layerService,
    workspaceRoot,
  );
  const decorationProvider = new SemanticFileDecorationProvider();
  const layerDecorationProvider = new LayerDecorationProvider(layerService);

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
    layerDecorationProvider,
    fileWatcherService,
    manifestChangedSubscription,
    semanticChangedSubscription,
    projectChangedSubscription,
    vscode.window.createTreeView('dbtSemantic.domainTree', {
      treeDataProvider: treeProvider,
      dragAndDropController: treeProvider,
      canSelectMany: false,
    }),
    vscode.window.registerCustomEditorProvider('dbtSemantic.domainEditor', editorProvider),
    vscode.window.registerFileDecorationProvider(decorationProvider),
    vscode.window.registerFileDecorationProvider(layerDecorationProvider),
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
          // Get creatable layers from LayerService
          const creatableLayers = layerService.getCreatableLayers();
          if (creatableLayers.length === 0) {
            void vscode.window.showErrorMessage(
              'No layers configured for domain creation. Add layers first.',
            );
            return;
          }
          const layerItems = creatableLayers.map(l => ({
            label: l.label,
            value: l.id,
          }));
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

        // Step 4: Get model folder filter (optional)
        // Load manifest to detect available folders
        let modelFolder: string | undefined;
        try {
          await manifestService.loadManifest(workspaceRoot);
          const availableFolders = manifestService.getModelFolders();

          if (availableFolders.length > 0) {
            const folderItems: Array<{ label: string; value: string | undefined }> = [
              { label: '$(folder) Any folder (no filter)', value: undefined },
              ...availableFolders.map((folder) => ({
                label: `$(folder) ${folder}`,
                value: folder,
              })),
            ];

            const folderChoice = await vscode.window.showQuickPick(folderItems, {
              placeHolder: 'Filter models by folder (optional)',
              ignoreFocusOut: true,
            });

            if (folderChoice === undefined) {
              return; // User cancelled
            }
            modelFolder = folderChoice.value;
          }
        } catch {
          // If manifest loading fails, skip folder picker (graceful degradation)
          console.warn('[createDomain] Failed to load manifest for folder detection, skipping folder picker');
        }

        // Step 5: Create directory and file (using configured semanticDir)
        const layerDir = path.join(workspaceRoot, semanticDir, layer);
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
        const domainData: Record<string, unknown> = {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          domain: slug,
          layer,
          description: description.trim(),
          ...(modelFolder ? { modelFolder } : {}),
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

        // Step 6: Refresh tree view
        treeProvider.refresh();

        // Step 7: Auto-open in custom editor
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
    // F408: Set up semantic directory for new projects (welcome experience)
    vscode.commands.registerCommand(
      'dbtSemantic.setupSemanticDirectory',
      async () => {
        // Step 1: Create directory structure using default layers from LayerService
        const fullSemanticDir = path.join(workspaceRoot, semanticDir);
        const defaultLayers = layerService.getAllLayers();

        try {
          // Create semantic directory if needed
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

          // Save default layers.json configuration
          await layerService.saveConfig(defaultLayers);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(
            `Failed to create semantic directory structure: ${msg}`,
          );
          return;
        }

        // Step 2: Refresh tree view (welcome disappears, layer folders appear)
        treeProvider.refresh();

        // Step 3: Give VS Code time to re-render the tree before showing the dialog
        await new Promise(resolve => setTimeout(resolve, 100));

        // Step 4: Show success message
        void vscode.window.showInformationMessage(
          'Semantic domains directory created! Now create your first domain.',
        );

        // Step 5: Trigger the existing createDomain command
        // (layer picker will appear, user selects silver or gold)
        await vscode.commands.executeCommand('dbtSemantic.createDomain');
      },
    ),
    // -------------------------------------------------------------------------
    // Layer Management Commands
    // -------------------------------------------------------------------------
    vscode.commands.registerCommand(
      'dbtSemantic.addLayer',
      async () => {
        // Step 1: Get layer ID
        const id = await vscode.window.showInputBox({
          prompt: 'Layer ID (lowercase, e.g., platinum)',
          placeHolder: 'e.g., platinum, staging, raw',
          ignoreFocusOut: true,
          validateInput: (value: string) => {
            if (!value || !value.trim()) {
              return 'Layer ID is required';
            }
            if (!/^[a-z][a-z0-9_-]*$/.test(value.trim())) {
              return 'Must start with lowercase letter, contain only lowercase letters, numbers, hyphens, underscores';
            }
            if (layerService.hasLayer(value.trim())) {
              return `Layer "${value.trim()}" already exists`;
            }
            return undefined;
          },
        });
        if (!id) return;
        const layerId = id.trim();

        // Step 2: Get label
        const label = await vscode.window.showInputBox({
          prompt: 'Layer display name',
          value: layerId.charAt(0).toUpperCase() + layerId.slice(1),
          ignoreFocusOut: true,
        });
        if (label === undefined) return;

        // Step 3: Get abbreviation
        const abbreviation = await vscode.window.showInputBox({
          prompt: 'Abbreviation for badges (3 characters)',
          value: layerId.slice(0, 3).toUpperCase(),
          ignoreFocusOut: true,
          validateInput: (value: string) => {
            if (!value || value.trim().length === 0) {
              return 'Abbreviation is required';
            }
            if (value.trim().length > 4) {
              return 'Abbreviation should be 3-4 characters';
            }
            return undefined;
          },
        });
        if (abbreviation === undefined) return;

        // Step 4: Color picker
        const colorOptions = [
          { label: '$(circle-filled) Blue', value: '#3b82f6' },
          { label: '$(circle-filled) Green', value: '#22c55e' },
          { label: '$(circle-filled) Purple', value: '#a855f7' },
          { label: '$(circle-filled) Orange', value: '#f97316' },
          { label: '$(circle-filled) Cyan', value: '#06b6d4' },
          { label: '$(circle-filled) Pink', value: '#ec4899' },
          { label: '$(edit) Custom hex color...', value: 'custom' },
        ];
        const colorPick = await vscode.window.showQuickPick(colorOptions, {
          placeHolder: 'Select layer color',
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
              if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
                return 'Invalid hex color format (e.g., #ff5733)';
              }
              return undefined;
            },
          });
          if (!customColor) return;
          color = customColor;
        }

        // Step 5: Creatable checkbox
        const creatablePick = await vscode.window.showQuickPick([
          { label: 'Yes - allow creating domains in this layer', value: true },
          { label: 'No - read-only layer (e.g., raw/staging)', value: false },
        ], {
          placeHolder: 'Allow creating domains in this layer?',
          ignoreFocusOut: true,
        });
        if (!creatablePick) return;
        const creatable = creatablePick.value;

        // Step 6: Add layer
        try {
          await layerService.addLayer({
            id: layerId,
            label: label.trim() || layerId.charAt(0).toUpperCase() + layerId.slice(1),
            abbreviation: abbreviation.trim().toUpperCase(),
            color,
            creatable,
          });

          // Create directory
          const layerDir = path.join(workspaceRoot, semanticDir, layerId);
          if (!fs.existsSync(layerDir)) {
            fs.mkdirSync(layerDir, { recursive: true });
          }

          // Refresh tree and decorations
          treeProvider.refresh();
          layerDecorationProvider.refresh();

          void vscode.window.showInformationMessage(
            `Layer "${label.trim() || layerId}" added successfully.`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to add layer: ${msg}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'dbtSemantic.editLayer',
      async (element?: TreeElement) => {
        // Get layer ID from context menu or prompt
        let layerId: string | undefined;
        if (element && element.type === 'layer') {
          layerId = element.layer;
        } else {
          // Show picker
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

        // Show edit options
        const editOptions = [
          { label: '$(edit) Rename Layer', value: 'rename' },
          { label: '$(symbol-color) Change Color', value: 'color' },
          { label: '$(tag) Change Abbreviation', value: 'abbreviation' },
          { label: layer.creatable ? '$(lock) Make Non-Creatable' : '$(unlock) Make Creatable', value: 'creatable' },
        ];
        const editChoice = await vscode.window.showQuickPick(editOptions, {
          placeHolder: `Edit layer: ${layer.label}`,
        });
        if (!editChoice) return;

        try {
          switch (editChoice.value) {
            case 'rename': {
              const newLabel = await vscode.window.showInputBox({
                prompt: 'New layer display name',
                value: layer.label,
                ignoreFocusOut: true,
              });
              if (newLabel === undefined || newLabel.trim() === layer.label) return;
              await layerService.updateLayer(layerId, { label: newLabel.trim() });
              break;
            }
            case 'color': {
              const colorOptions = [
                { label: '$(circle-filled) Blue', value: '#3b82f6' },
                { label: '$(circle-filled) Green', value: '#22c55e' },
                { label: '$(circle-filled) Purple', value: '#a855f7' },
                { label: '$(circle-filled) Orange', value: '#f97316' },
                { label: '$(circle-filled) Cyan', value: '#06b6d4' },
                { label: '$(circle-filled) Pink', value: '#ec4899' },
                { label: '$(edit) Custom hex color...', value: 'custom' },
              ];
              const colorPick = await vscode.window.showQuickPick(colorOptions, {
                placeHolder: 'Select new color',
              });
              if (!colorPick) return;

              let color = colorPick.value;
              if (color === 'custom') {
                const customColor = await vscode.window.showInputBox({
                  prompt: 'Enter hex color (e.g., #ff5733)',
                  value: layer.color,
                  ignoreFocusOut: true,
                  validateInput: (value: string) => {
                    if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
                      return 'Invalid hex color format';
                    }
                    return undefined;
                  },
                });
                if (!customColor) return;
                color = customColor;
              }
              await layerService.updateLayerColor(layerId, color);
              break;
            }
            case 'abbreviation': {
              const newAbbrev = await vscode.window.showInputBox({
                prompt: 'New abbreviation (3-4 characters)',
                value: layer.abbreviation,
                ignoreFocusOut: true,
                validateInput: (value: string) => {
                  if (!value || value.trim().length === 0) {
                    return 'Abbreviation is required';
                  }
                  if (value.trim().length > 4) {
                    return 'Abbreviation should be 3-4 characters';
                  }
                  return undefined;
                },
              });
              if (newAbbrev === undefined) return;
              await layerService.updateLayer(layerId, { abbreviation: newAbbrev.trim().toUpperCase() });
              break;
            }
            case 'creatable': {
              await layerService.updateLayer(layerId, { creatable: !layer.creatable });
              break;
            }
          }

          treeProvider.refresh();
          layerDecorationProvider.refresh();
          void vscode.window.showInformationMessage(`Layer "${layer.label}" updated.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to update layer: ${msg}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'dbtSemantic.removeLayer',
      async (element?: TreeElement) => {
        // Get layer ID from context menu or prompt
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

        // Check for existing domains
        const domains = domainService.listDomains(workspaceRoot, semanticDir);
        const layerDomains = domains.filter(d => d.layer === layerId);

        if (layerDomains.length > 0) {
          void vscode.window.showErrorMessage(
            `Cannot remove layer "${layer.label}" — it contains ${layerDomains.length} domain(s). ` +
            `Delete or move domains first.`,
          );
          return;
        }

        // Confirm deletion
        const confirm = await vscode.window.showWarningMessage(
          `Remove layer "${layer.label}"? This will delete the directory.`,
          { modal: true },
          'Remove',
        );
        if (confirm !== 'Remove') return;

        try {
          // Update config first (safer ordering - if this fails, nothing is lost)
          await layerService.removeLayer(layerId);

          // Then remove directory (if config update succeeded)
          const layerDir = path.join(workspaceRoot, semanticDir, layerId);
          if (fs.existsSync(layerDir)) {
            await vscode.workspace.fs.delete(
              vscode.Uri.file(layerDir),
              { recursive: true },
            );
          }

          // Refresh tree and decorations
          treeProvider.refresh();
          layerDecorationProvider.refresh();

          void vscode.window.showInformationMessage(
            `Layer "${layer.label}" removed.`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to remove layer: ${msg}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'dbtSemantic.initializeLayerConfig',
      async () => {
        // Auto-detect layers from filesystem
        const detected = layerService.detectLayersFromFilesystem();

        if (detected.length === 0) {
          // No existing layers, just save defaults
          const defaultLayers = layerService.getAllLayers();
          await layerService.saveConfig(defaultLayers);
          void vscode.window.showInformationMessage(
            'Layer configuration saved with default layers (Silver, Gold).',
          );
          return;
        }

        // Show detected layers and ask to save
        const layerNames = detected.map(l => l.label).join(', ');
        const choice = await vscode.window.showInformationMessage(
          `Detected layers: ${layerNames}. Save this configuration?`,
          'Save',
          'Customize',
          'Cancel',
        );

        if (choice === 'Save') {
          await layerService.saveConfig(detected);
          layerService.invalidateCache();
          treeProvider.refresh();
          layerDecorationProvider.refresh();
          void vscode.window.showInformationMessage(
            `Layer configuration saved to ${semanticDir}/layers.json`,
          );
        } else if (choice === 'Customize') {
          // Save first, then open for editing
          await layerService.saveConfig(detected);
          const uri = vscode.Uri.file(layerService.getConfigPath());
          await vscode.commands.executeCommand('vscode.open', uri);
        }
      },
    ),
  );

  // -------------------------------------------------------------------------
  // First-run check: prompt to initialize layers.json for existing projects
  // -------------------------------------------------------------------------
  const fullSemanticDir = path.join(workspaceRoot, semanticDir);
  if (fs.existsSync(fullSemanticDir) && !layerService.configFileExists()) {
    const detected = layerService.detectLayersFromFilesystem();
    if (detected.length > 0) {
      const layerNames = detected.map(l => l.label).join(', ');
      void vscode.window.showInformationMessage(
        `Detected layers: ${layerNames}. Would you like to save layer configuration for customization?`,
        'Save Config',
        'Later',
      ).then(async (choice) => {
        if (choice === 'Save Config') {
          await vscode.commands.executeCommand('dbtSemantic.initializeLayerConfig');
        }
      });
    }
  }
}

export function deactivate(): void {
  // Cleanup will be added when services are implemented
}
