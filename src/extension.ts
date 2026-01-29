import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { DomainService } from './services/domainService';
import { ManifestService } from './services/manifestService';
import { ReconciliationService } from './services/reconciliationService';
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
  const treeProvider = new DomainTreeProvider(domainService, workspaceRoot);
  const editorProvider = new SemanticEditorProvider(
    context,
    domainService,
    manifestService,
    reconciliationService,
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
    vscode.commands.registerCommand('dbtSemantic.createDomain', async () => {
      await vscode.window.showInformationMessage(
        'Create Domain feature will be implemented in Phase 3 (F300)',
      );
    }),
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
