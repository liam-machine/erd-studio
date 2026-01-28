import * as vscode from 'vscode';

import { DomainService } from './services/domainService';
import { ManifestService } from './services/manifestService';
import { ReconciliationService } from './services/reconciliationService';
import { DomainTreeProvider } from './providers/DomainTreeProvider';
import { SemanticEditorProvider } from './providers/SemanticEditorProvider';
import { SemanticFileDecorationProvider } from './providers/SemanticFileDecorationProvider';

export function activate(context: vscode.ExtensionContext): void {
  console.log('dbt Semantic Designer is now active');

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return;
  }

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
  );
}

export function deactivate(): void {
  // Cleanup will be added when services are implemented
}
