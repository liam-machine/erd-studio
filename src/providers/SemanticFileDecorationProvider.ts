import * as vscode from 'vscode';

/**
 * Provides file decorations (badge + color) for semantic domain JSON files
 * in the Explorer tree view.
 */
export class SemanticFileDecorationProvider implements vscode.FileDecorationProvider {
  private static readonly SEMANTIC_PATH_PATTERN = /[/\\]models[/\\]semantic[/\\]/;

  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    // Only decorate .json files in models/semantic/
    if (!uri.fsPath.endsWith('.json')) {
      return undefined;
    }

    if (!SemanticFileDecorationProvider.SEMANTIC_PATH_PATTERN.test(uri.fsPath)) {
      return undefined;
    }

    return {
      badge: 'S',
      tooltip: 'Semantic Domain (opens in visual editor)',
      color: new vscode.ThemeColor('charts.blue'),
    };
  }

  dispose(): void {
    this._onDidChangeFileDecorations.dispose();
  }
}
