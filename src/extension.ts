import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { DomainService } from './services/domainService';
import { CURRENT_SCHEMA_VERSION, type Layer } from './types/semantic';
import { ManifestService } from './services/manifestService';
import { ReconciliationService } from './services/reconciliationService';
import { TemplateService } from './services/templateService';
import { DomainTreeProvider } from './providers/DomainTreeProvider';
import { SemanticEditorProvider } from './providers/SemanticEditorProvider';
import { SemanticFileDecorationProvider } from './providers/SemanticFileDecorationProvider';

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
  const treeProvider = new DomainTreeProvider(domainService, workspaceRoot);
  const editorProvider = new SemanticEditorProvider(
    context,
    domainService,
    manifestService,
    reconciliationService,
    templateService,
    workspaceRoot,
  );
  const decorationProvider = new SemanticFileDecorationProvider();

  context.subscriptions.push(
    treeProvider,
    decorationProvider,
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
          validateInput: (value: string) => {
            if (!value || !value.trim()) {
              return 'Domain name is required';
            }
            const slug = value.trim();
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
          },
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
    vscode.commands.registerCommand('dbtSemantic.deleteDomain', async () => {
      await vscode.window.showInformationMessage(
        'Delete Domain feature will be implemented in Phase 3 (F301)',
      );
    }),
    vscode.commands.registerCommand('dbtSemantic.refreshManifest', async () => {
      await vscode.window.showInformationMessage(
        'Refresh Manifest feature will be implemented in Phase 3 (F305)',
      );
    }),
  );
}

export function deactivate(): void {
  // Cleanup will be added when services are implemented
}
