import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { DomainService } from './services/domainService';
import { LayerService } from './services/layerService';
import { CURRENT_SCHEMA_VERSION, type DomainSummary, type Layer, type SemanticDomain, type Stage } from './types/semantic';
import { ManifestService } from './services/manifestService';
import { TemplateService } from './services/templateService';
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

/** Valid editable stages for domain creation. */
const EDITABLE_STAGES: Stage[] = ['conceptual', 'logical'];

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

export function activate(context: vscode.ExtensionContext): void {
  console.log('ERD Studio is now active');

  const workspaceRoot = findDbtProjectRoot();
  if (!workspaceRoot) {
    void vscode.window.showWarningMessage(
      'ERD Studio: No dbt project found. ' +
        'Open a folder containing dbt_project.yml to activate.',
    );
    return;
  }

  console.log(`ERD Studio: Found dbt project at ${workspaceRoot}`);

  const config = vscode.workspace.getConfiguration('dbtSemantic');
  const semanticDir = config.get<string>('semanticDir', 'erd-studio');

  const layerService = new LayerService(workspaceRoot, semanticDir);
  const domainService = new DomainService(layerService);
  const manifestService = new ManifestService();
  const templateService = new TemplateService();
  const treeProvider = new DomainTreeProvider(domainService, layerService, workspaceRoot, context, semanticDir);
  const editorProvider = new SemanticEditorProvider(
    context,
    domainService,
    manifestService,
    templateService,
    layerService,
    workspaceRoot,
  );
  const decorationProvider = new SemanticFileDecorationProvider();
  const layerDecorationProvider = new LayerDecorationProvider(layerService);

  // Set context key so view/title menus only show when semantic dir exists
  const fullSemanticDirPath = path.join(workspaceRoot, semanticDir);
  void vscode.commands.executeCommand('setContext', 'dbtSemantic.hasSemanticDir', fs.existsSync(fullSemanticDirPath));

  // -------------------------------------------------------------------------
  // File watchers
  // -------------------------------------------------------------------------
  const fileWatcherService = new FileWatcherService(workspaceRoot);

  // Manifest changed → refresh open editors
  const manifestChangedSubscription = fileWatcherService.onManifestChanged(
    async () => {
      manifestService.invalidate();
      await editorProvider.refreshAllOpenDomains();
      void vscode.window.showInformationMessage(
        'dbt manifest updated. Graphs refreshed with latest model data.',
      );
    },
  );

  // Semantic file changed externally → refresh tree view
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
    (() => {
      const treeView = vscode.window.createTreeView('dbtSemantic.domainTree', {
        treeDataProvider: treeProvider,
        dragAndDropController: treeProvider,
        canSelectMany: false,
      });
      treeProvider.setTreeView(treeView);
      return treeView;
    })(),
    vscode.window.registerCustomEditorProvider('dbtSemantic.domainEditor', editorProvider),
    vscode.window.registerFileDecorationProvider(decorationProvider),
    vscode.window.registerFileDecorationProvider(layerDecorationProvider),
    vscode.commands.registerCommand('dbtSemantic.openDomain', async (filePath: string, stage?: Stage) => {
      // For physical stage, open the logical file then switch to physical in the editor
      let openPath = filePath;
      if (stage === 'physical') {
        openPath = filePath.replace(/[\\/]conceptual[\\/]/, path.sep + 'logical' + path.sep);
      }
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(openPath),
        'dbtSemantic.domainEditor',
      );
      if (stage === 'physical') {
        editorProvider.switchStageForUri(vscode.Uri.file(openPath), 'physical');
      }
    }),
    vscode.commands.registerCommand(
      'dbtSemantic.createDomain',
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
          placeHolder: 'e.g. customer-360, sales-analytics, work-lots',
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

        // Step 4: Get model folder filter
        let modelFolder: string | undefined;
        try {
          await manifestService.loadManifest(workspaceRoot);
          const availableFolders = manifestService.getModelFolders();
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

        // Step 5: Create files in both conceptual/ and logical/ directories
        for (const stage of EDITABLE_STAGES) {
          const stageLayerDir = path.join(workspaceRoot, semanticDir, stage, layer);
          const filePath = path.join(stageLayerDir, `${slug}.json`);

          try {
            if (!fs.existsSync(stageLayerDir)) {
              fs.mkdirSync(stageLayerDir, { recursive: true });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`Failed to create directory: ${msg}`);
            return;
          }

          const domainData: Record<string, unknown> = {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            domain: slug,
            layer,
            stage,
            description: description.trim(),
            ...(modelFolder ? { modelFolder } : {}),
            models: [],
            relationships: [],
            viewConfig: {},
          };

          try {
            fs.writeFileSync(filePath, JSON.stringify(domainData, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
          } catch (err) {
            if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
              void vscode.window.showErrorMessage(`Domain "${slug}" already exists in ${layer} layer (${stage} stage)`);
              return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`Failed to create domain file: ${msg}`);
            return;
          }
        }

        // Step 6: Refresh tree and auto-open logical domain
        treeProvider.refresh();
        const logicalFilePath = path.join(workspaceRoot, semanticDir, 'logical', layer, `${slug}.json`);
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(logicalFilePath),
          'dbtSemantic.domainEditor',
        );
      },
    ),
    vscode.commands.registerCommand(
      'dbtSemantic.deleteDomain',
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
          `Are you sure you want to delete domain "${domainName}"? This will delete both conceptual and logical files.`,
          { modal: true },
          'Delete',
        );
        if (confirm !== 'Delete') { return; }

        // Close any open editors
        const matchingTabs = findMatchingTabs(fileUri);
        if (matchingTabs.length > 0) {
          await vscode.window.tabGroups.close(matchingTabs, true);
        }

        // Delete files in both conceptual and logical directories
        const layer = element.summary.layer;
        for (const stage of EDITABLE_STAGES) {
          const stageFilePath = path.join(workspaceRoot, semanticDir, stage, layer, `${domainName}.json`);
          const stageFileUri = vscode.Uri.file(stageFilePath);
          try {
            if (fs.existsSync(stageFilePath)) {
              // Close any tabs for this stage file too
              const stageTabs = findMatchingTabs(stageFileUri);
              if (stageTabs.length > 0) {
                await vscode.window.tabGroups.close(stageTabs, true);
              }
              await vscode.workspace.fs.delete(stageFileUri);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`Failed to delete domain (${stage}): ${msg}`);
          }
        }

        treeProvider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      'dbtSemantic.renameDomain',
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

        // Rename in both stage directories
        const edit = new vscode.WorkspaceEdit();
        for (const stage of EDITABLE_STAGES) {
          const oldStageFilePath = path.join(workspaceRoot, semanticDir, stage, layer, `${oldDomainName}.json`);
          const newStageFilePath = path.join(workspaceRoot, semanticDir, stage, layer, `${newSlug}.json`);

          if (!fs.existsSync(oldStageFilePath)) { continue; }

          const oldStageUri = vscode.Uri.file(oldStageFilePath);
          const newStageUri = vscode.Uri.file(newStageFilePath);

          // Read and update domain field
          let domainData: SemanticDomain;
          try {
            domainData = domainService.getDomain(oldStageFilePath);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`Failed to read domain file (${stage}): ${msg}`);
            return;
          }
          domainData.domain = newSlug;

          edit.createFile(newStageUri, { overwrite: false, ignoreIfExists: false });
          edit.insert(newStageUri, new vscode.Position(0, 0), JSON.stringify(domainData, null, 2) + '\n');
          edit.deleteFile(oldStageUri, { ignoreIfNotExists: false });
        }

        const success = await vscode.workspace.applyEdit(edit);
        if (!success) {
          void vscode.window.showErrorMessage(`Failed to rename domain "${oldDomainName}" to "${newSlug}"`);
          return;
        }

        // Close old editor tabs
        for (const stage of EDITABLE_STAGES) {
          const oldStageUri = vscode.Uri.file(path.join(workspaceRoot, semanticDir, stage, layer, `${oldDomainName}.json`));
          const tabs = findMatchingTabs(oldStageUri);
          if (tabs.length > 0) { await vscode.window.tabGroups.close(tabs, true); }
        }

        // Auto-open renamed domain (logical)
        const newLogicalUri = vscode.Uri.file(path.join(workspaceRoot, semanticDir, 'logical', layer, `${newSlug}.json`));
        await vscode.commands.executeCommand('vscode.openWith', newLogicalUri, 'dbtSemantic.domainEditor');
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
          manifestService.invalidate();
          await manifestService.loadManifest(workspaceRoot);
          await editorProvider.refreshAllOpenDomains();
          void vscode.window.showInformationMessage('Manifest refreshed. Graphs updated with latest model data.');
        },
      );
    }),
    // F408: Set up semantic directory for new projects
    vscode.commands.registerCommand(
      'dbtSemantic.setupSemanticDirectory',
      async () => {
        const fullSemanticDir = path.join(workspaceRoot, semanticDir);
        const defaultLayers = layerService.getAllLayers();

        try {
          if (!fs.existsSync(fullSemanticDir)) {
            fs.mkdirSync(fullSemanticDir, { recursive: true });
          }

          // Create stage/layer directories
          for (const stage of EDITABLE_STAGES) {
            for (const layer of defaultLayers) {
              const layerDir = path.join(fullSemanticDir, stage, layer.id);
              if (!fs.existsSync(layerDir)) {
                fs.mkdirSync(layerDir, { recursive: true });
              }
            }
          }

          await layerService.saveConfig(defaultLayers);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to create semantic directory structure: ${msg}`);
          return;
        }

        // Update context key so view/title menus appear
        void vscode.commands.executeCommand('setContext', 'dbtSemantic.hasSemanticDir', true);
        treeProvider.refresh();
        await new Promise(resolve => setTimeout(resolve, 100));
        void vscode.window.showInformationMessage('ERD Studio directory created! Now create your first domain.');
        await vscode.commands.executeCommand('dbtSemantic.createDomain');
      },
    ),
    // -------------------------------------------------------------------------
    // Layer Management Commands (unchanged)
    // -------------------------------------------------------------------------
    vscode.commands.registerCommand(
      'dbtSemantic.addLayer',
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

          // Create directories for both editable stages
          for (const stage of EDITABLE_STAGES) {
            const layerDir = path.join(workspaceRoot, semanticDir, stage, layerId);
            if (!fs.existsSync(layerDir)) {
              fs.mkdirSync(layerDir, { recursive: true });
            }
          }

          treeProvider.refresh();
          layerDecorationProvider.refresh();
          void vscode.window.showInformationMessage(`Layer "${label}" added. Use Edit Layer to customize display name or abbreviation.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to add layer: ${msg}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'dbtSemantic.editLayer',
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

          // Remove directories for both stages
          for (const stage of EDITABLE_STAGES) {
            const layerDir = path.join(workspaceRoot, semanticDir, stage, layerId);
            if (fs.existsSync(layerDir)) {
              await vscode.workspace.fs.delete(vscode.Uri.file(layerDir), { recursive: true });
            }
          }

          treeProvider.refresh();
          layerDecorationProvider.refresh();
          void vscode.window.showInformationMessage(`Layer "${layer.label}" removed.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to remove layer: ${msg}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'dbtSemantic.initializeLayerConfig',
      async () => {
        const detected = layerService.detectLayersFromFilesystem();
        if (detected.length === 0) {
          const defaultLayers = layerService.getAllLayers();
          await layerService.saveConfig(defaultLayers);
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
          treeProvider.refresh();
          layerDecorationProvider.refresh();
          void vscode.window.showInformationMessage(`Layer configuration saved to ${semanticDir}/layers.json`);
        } else if (choice === 'Customize') {
          await layerService.saveConfig(detected);
          const uri = vscode.Uri.file(layerService.getConfigPath());
          await vscode.commands.executeCommand('vscode.open', uri);
        }
      },
    ),
    vscode.commands.registerCommand(
      'dbtSemantic.switchTreeStage',
      async () => {
        const stages: Array<{ label: string; value: Stage; description?: string }> = [
          { label: '$(lightbulb) Conceptual', value: 'conceptual', description: 'High-level entity design' },
          { label: '$(list-tree) Logical', value: 'logical', description: 'Detailed data model design' },
          { label: '$(database) Physical', value: 'physical', description: 'Built models from dbt manifest' },
        ];
        const current = treeProvider.getStage();
        const pick = await vscode.window.showQuickPick(
          stages.map(s => ({
            ...s,
            description: s.value === current ? `${s.description} (current)` : s.description,
          })),
          { placeHolder: 'Select stage to view in sidebar' },
        );
        if (pick) {
          await treeProvider.setStage(pick.value);
        }
      },
    ),
  );

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
          await layerService.saveConfig(detected);
          layerService.invalidateCache();
          treeProvider.refresh();
          layerDecorationProvider.refresh();
          void vscode.window.showInformationMessage(`Layer configuration saved to ${semanticDir}/layers.json`);
        }
      });
    }
  }
}

export function deactivate(): void {
  // Cleanup will be added when services are implemented
}
