import * as vscode from 'vscode';

export function activate(_context: vscode.ExtensionContext): void {
  console.log('dbt Semantic Designer is now active');
}

export function deactivate(): void {
  // Cleanup will be added when services are implemented
}
