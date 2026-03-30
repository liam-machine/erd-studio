import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { DomainService } from './services/domainService';
import { LayerService } from './services/layerService';
import { CURRENT_SCHEMA_VERSION, type DomainSummary, type Layer, type Stage, type UnifiedDomain, type StageData } from './types/semantic';
import { ManifestService } from './services/manifestService';
import { TemplateService } from './services/templateService';
import { DomainTreeProvider, type TreeElement } from './providers/DomainTreeProvider';
import { SemanticEditorProvider } from './providers/SemanticEditorProvider';
import { SemanticFileDecorationProvider } from './providers/SemanticFileDecorationProvider';
import { LayerDecorationProvider } from './providers/LayerDecorationProvider';
import { FileWatcherService } from './watchers/FileWatcherService';
import { HarnessService, HARNESS_TARGETS, HARNESS_VERSION } from './services/harnessService';
import { SchemaTagService } from './services/schemaTagService';
import { LogicalModelService } from './services/logicalModelService';
import { MigrationService } from './services/migrationService';
import { YmlParserService } from './services/ymlParserService';

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
  const logicalModelService = new LogicalModelService(workspaceRoot, semanticDir);
  domainService.setLogicalModelService(logicalModelService);
  const manifestService = new ManifestService();
  const ymlParserService = new YmlParserService();
  const templateService = new TemplateService();
  const schemaTagService = new SchemaTagService(domainService, workspaceRoot, semanticDir);

  // Check for v4 → v5 migration (non-blocking)
  const migrationService = new MigrationService(workspaceRoot, layerService, logicalModelService);
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
      }
    });
  }
  const treeProvider = new DomainTreeProvider(domainService, layerService, workspaceRoot, semanticDir);
  const editorProvider = new SemanticEditorProvider(
    context,
    domainService,
    manifestService,
    ymlParserService,
    templateService,
    layerService,
    workspaceRoot,
    schemaTagService,
    logicalModelService,
  );
  const decorationProvider = new SemanticFileDecorationProvider(layerService, semanticDir);
  const layerDecorationProvider = new LayerDecorationProvider(layerService);

  // Set context key so view/title menus only show when semantic dir exists
  const fullSemanticDirPath = path.join(workspaceRoot, semanticDir);
  void vscode.commands.executeCommand('setContext', 'dbtSemantic.hasSemanticDir', fs.existsSync(fullSemanticDirPath));

  // -------------------------------------------------------------------------
  // File watchers
  // -------------------------------------------------------------------------
  const fileWatcherService = new FileWatcherService(workspaceRoot);

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

  // Semantic file changed externally → refresh tree view
  const semanticChangedSubscription = fileWatcherService.onSemanticFileChanged(() => {
    treeProvider.refresh();
  });

  // Semantic file deleted → refresh tree and clean up orphaned domain tags
  const semanticDeletedSubscription = fileWatcherService.onSemanticFileDeleted(async () => {
    treeProvider.refresh();
    const result = await schemaTagService.reconcileAll();
    if (result.removed > 0) {
      void vscode.window.showInformationMessage(
        `Domain file deleted — removed ${result.removed} orphaned tag(s) from YAML files.`,
      );
    }
  });

  // Logical model file changed → refresh domains referencing that model
  const logicalModelChangedSubscription = fileWatcherService.onLogicalModelChanged(
    async ({ modelName }) => {
      await editorProvider.refreshDomainsReferencingModel(modelName);
      treeProvider.refresh();
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
    logicalModelChangedSubscription,
    dbtYmlChangedSubscription,
    projectChangedSubscription,
    (() => {
      const treeView = vscode.window.createTreeView('dbtSemantic.domainTree', {
        treeDataProvider: treeProvider,
        dragAndDropController: treeProvider,
        canSelectMany: false,
      });
      return treeView;
    })(),
    vscode.window.registerCustomEditorProvider('dbtSemantic.domainEditor', editorProvider),
    vscode.window.registerFileDecorationProvider(decorationProvider),
    vscode.window.registerFileDecorationProvider(layerDecorationProvider),
    vscode.commands.registerCommand('dbtSemantic.openDomain', async (filePath: string, stage?: Stage) => {
      const fileUri = vscode.Uri.file(filePath);
      await vscode.commands.executeCommand(
        'vscode.openWith',
        fileUri,
        'dbtSemantic.domainEditor',
      );
      if (stage === 'physical') {
        editorProvider.switchStageForUri(fileUri, 'physical');
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

        // Step 6: Refresh tree and auto-open domain
        treeProvider.refresh();
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

        // Delete the unified domain file
        try {
          await vscode.workspace.fs.delete(fileUri);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to delete domain: ${msg}`);
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

        // Read and update domain name in the unified file
        let domainData: UnifiedDomain;
        try {
          domainData = domainService.getDomain(oldFilePath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to read domain file: ${msg}`);
          return;
        }
        domainData.domain = newSlug;

        // Close old editor tabs before applying the edit (file will be deleted)
        const oldTabs = findMatchingTabs(oldFileUri);
        if (oldTabs.length > 0) { await vscode.window.tabGroups.close(oldTabs, true); }

        const newFilePath = path.join(workspaceRoot, semanticDir, layer, `${newSlug}.json`);
        const newFileUri = vscode.Uri.file(newFilePath);

        const edit = new vscode.WorkspaceEdit();
        edit.createFile(newFileUri, { overwrite: false, ignoreIfExists: false });
        edit.insert(newFileUri, new vscode.Position(0, 0), JSON.stringify(domainData, null, 2) + '\n');
        edit.deleteFile(oldFileUri, { ignoreIfNotExists: false });

        const success = await vscode.workspace.applyEdit(edit);
        if (!success) {
          void vscode.window.showErrorMessage(`Failed to rename domain "${oldDomainName}" to "${newSlug}"`);
          return;
        }

        // Auto-open renamed domain
        await vscode.commands.executeCommand('vscode.openWith', newFileUri, 'dbtSemantic.domainEditor');
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
          ymlParserService.invalidate();
          await manifestService.loadManifest(workspaceRoot);
          await ymlParserService.loadYmlData(workspaceRoot);
          await editorProvider.refreshAllOpenDomains();
          void vscode.window.showInformationMessage('Manifest refreshed. Graphs updated with latest model data.');
        },
      );
    }),
    // Sync domain tags to dbt schema YAML files
    vscode.commands.registerCommand('dbtSemantic.syncDomainTags', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Syncing domain tags to dbt schema files...',
          cancellable: false,
        },
        async () => {
          const result = await schemaTagService.reconcileAll();
          const parts: string[] = [];
          if (result.added > 0) { parts.push(`${result.added} added`); }
          if (result.removed > 0) { parts.push(`${result.removed} removed`); }
          if (result.skipped > 0) { parts.push(`${result.skipped} skipped`); }
          const summary = parts.length > 0 ? parts.join(', ') : 'all tags up to date';
          if (result.errors.length > 0) {
            void vscode.window.showWarningMessage(
              `Domain tags synced (${summary}). ${result.errors.length} error(s) — see Output for details.`,
            );
            for (const err of result.errors) {
              console.error(`[SchemaTagService] ${err}`);
            }
          } else {
            void vscode.window.showInformationMessage(`Domain tags synced: ${summary}.`);
          }
        },
      );
    }),
    // Migrate v4 domains to v5 central model store
    vscode.commands.registerCommand('dbtSemantic.migrateToV5', async () => {
      if (!migrationService.needsMigration()) {
        void vscode.window.showInformationMessage('All domain files are already using the v5 central model store format.');
        return;
      }

      const v4Count = migrationService.findV4Domains().length;
      const confirm = await vscode.window.showWarningMessage(
        `Found ${v4Count} domain file(s) using the legacy inline model format. ` +
        'Migration will extract models to erd-studio/logical-models/ and convert domain files to use name references. ' +
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

          // Create layer directory
          const layerDir = path.join(workspaceRoot, semanticDir, layerId);
          if (!fs.existsSync(layerDir)) {
            fs.mkdirSync(layerDir, { recursive: true });
          }

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
          decorationProvider.refresh();
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
          decorationProvider.refresh();
          void vscode.window.showInformationMessage(`Layer configuration saved to ${semanticDir}/layers.json`);
        } else if (choice === 'Customize') {
          await layerService.saveConfig(detected);
          const uri = vscode.Uri.file(layerService.getConfigPath());
          await vscode.commands.executeCommand('vscode.open', uri);
        }
      },
    ),
    // -------------------------------------------------------------------------
    // AI Coding Harness Installation
    // -------------------------------------------------------------------------
    vscode.commands.registerCommand(
      'dbtSemantic.installCodingHarness',
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
            description = '$(check) installed (v' + HARNESS_VERSION + ')';
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

  // AI coding harness — auto-update stale files, prompt on fresh install
  {
    const harnessService = new HarnessService();
    const existing = harnessService.detectExisting(workspaceRoot);
    const installedCount = [...existing.values()].filter(Boolean).length;
    const staleTargets = harnessService.detectStale(workspaceRoot);

    if (staleTargets.length > 0) {
      // Force-update all stale harness files silently
      for (const target of staleTargets) {
        harnessService.install(workspaceRoot, target, true);
      }
      const names = staleTargets.map(t => t.label.replace(/\$\([^)]+\)\s*/g, '')).join(', ');
      void vscode.window.showInformationMessage(
        `ERD Studio: Updated ${staleTargets.length} AI coding harness file(s) to v${HARNESS_VERSION} (${names}).`,
      );
    } else if (installedCount === 0) {
      // No harnesses installed — prompt user to choose
      void vscode.commands.executeCommand('dbtSemantic.installCodingHarness');
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
          await layerService.saveConfig(detected);
          layerService.invalidateCache();
          treeProvider.refresh();
          layerDecorationProvider.refresh();
          decorationProvider.refresh();
          void vscode.window.showInformationMessage(`Layer configuration saved to ${semanticDir}/layers.json`);
        }
      });
    }
  }
}

export function deactivate(): void {
  // Cleanup will be added when services are implemented
}
