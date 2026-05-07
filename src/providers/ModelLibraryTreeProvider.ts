/**
 * ModelLibraryTreeProvider — VS Code TreeDataProvider for the Model Library sidebar.
 *
 * Shows all model YAML files in erd-studio/logical-models/ as a flat
 * alphabetical list. Orphaned models (not referenced by any domain) are
 * flagged with a warning icon and "(unused)" description. Referenced models
 * show their domain count and list domain names in the tooltip.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';

import type { LogicalModelService } from '../services/logicalModelService';
import type { DomainService } from '../services/domainService';
import type { RawDomainFile, SemanticModel } from '../types/semantic';
import { isDomainV5 } from '../types/semantic';

// ---------------------------------------------------------------------------
// Tree element type
// ---------------------------------------------------------------------------

export interface ModelLibraryNode {
  readonly type: 'model';
  readonly name: string;
  readonly filePath: string;
  readonly referencingDomains: string[];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class ModelLibraryTreeProvider implements vscode.TreeDataProvider<ModelLibraryNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ModelLibraryNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly logicalModelService: LogicalModelService,
    private readonly domainService: DomainService,
    private readonly projectPath: string,
    private readonly semanticDir: string,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ModelLibraryNode): vscode.TreeItem {
    const isOrphan = element.referencingDomains.length === 0;
    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);

    item.contextValue = 'logicalModel';
    item.iconPath = new vscode.ThemeIcon(isOrphan ? 'warning' : 'symbol-class');

    if (isOrphan) {
      item.description = '(unused)';
      item.tooltip = 'Not referenced by any domain';
    } else {
      const count = element.referencingDomains.length;
      item.description = `${count} ${count === 1 ? 'domain' : 'domains'}`;
      item.tooltip = new vscode.MarkdownString(
        `**Referenced by:**\n${element.referencingDomains.map(d => `- ${d}`).join('\n')}`,
      );
    }

    item.resourceUri = vscode.Uri.file(element.filePath);
    item.command = {
      command: 'vscode.open',
      title: 'Open Model',
      arguments: [item.resourceUri],
    };

    return item;
  }

  getChildren(element?: ModelLibraryNode): ModelLibraryNode[] | undefined {
    if (element) return undefined;

    if (!this.logicalModelService.dirExists()) return [];

    const usageMap = this.buildUsageMap();
    return this.logicalModelService
      .listModelNames()
      .sort((a, b) => a.localeCompare(b))
      .map((name): ModelLibraryNode => ({
        type: 'model',
        name,
        filePath: this.logicalModelService.modelPath(name),
        referencingDomains: usageMap.get(name) ?? [],
      }));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Scan all domain JSON files and build a map of model name → domain names.
   * Uses raw JSON.parse to avoid expensive YAML model resolution.
   */
  private buildUsageMap(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    const summaries = this.domainService.listDomains(this.projectPath, this.semanticDir);

    for (const summary of summaries) {
      try {
        const raw = JSON.parse(fs.readFileSync(summary.filePath, 'utf-8')) as RawDomainFile;
        const rawModels = raw.logical?.models ?? [];
        const modelNames = isDomainV5(raw)
          ? (rawModels as string[])
          : (rawModels as SemanticModel[]).map(m => m.name);

        for (const name of modelNames) {
          const existing = map.get(name);
          if (existing) {
            existing.push(summary.domain);
          } else {
            map.set(name, [summary.domain]);
          }
        }
      } catch {
        // Skip unreadable/invalid domain files
      }
    }

    return map;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
