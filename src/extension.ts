import * as vscode from 'vscode';

import { DomainService } from './services/domainService';
import { DomainTreeProvider } from './providers/DomainTreeProvider';

export function activate(context: vscode.ExtensionContext): void {
  console.log('dbt Semantic Designer is now active');

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return;
  }

  const domainService = new DomainService();
  const treeProvider = new DomainTreeProvider(domainService, workspaceRoot);

  context.subscriptions.push(
    treeProvider,
    vscode.window.registerTreeDataProvider('dbtSemantic.domainTree', treeProvider),
    vscode.commands.registerCommand('dbtSemantic.openDomain', (filePath: string) => {
      vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
    }),
  );
}

export function deactivate(): void {
  // Cleanup will be added when services are implemented
}
