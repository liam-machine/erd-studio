/**
 * DomainTreeProvider — VS Code TreeDataProvider for the sidebar.
 *
 * Displays semantic domains grouped by layer (bronze, silver, gold).
 * Each domain shows a badge with model count and design model count.
 * "New Domain..." items appear inside silver and gold layer folders
 * (bronze is raw/staging and not used for semantic domain design).
 */

import * as vscode from 'vscode';

import type { DomainSummary, Layer } from '../types/semantic';
import { VALID_LAYERS } from '../types/semantic';
import { DomainService } from '../services/domainService';

// ---------------------------------------------------------------------------
// Tree element types (discriminated union)
// ---------------------------------------------------------------------------

interface LayerNode {
  readonly type: 'layer';
  readonly layer: Layer;
}

interface DomainNode {
  readonly type: 'domain';
  readonly summary: DomainSummary;
  readonly modelCount: number;
  readonly designCount: number;
}

interface NewDomainNode {
  readonly type: 'newDomain';
  readonly layer: Layer;
}

export type TreeElement = LayerNode | DomainNode | NewDomainNode;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAYER_LABELS: Record<Layer, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
};

/** Layers that support creating new domains from the tree view. */
const CREATABLE_LAYERS: readonly Layer[] = ['silver', 'gold'];

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class DomainTreeProvider implements vscode.TreeDataProvider<TreeElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly domainService: DomainService,
    private readonly projectPath: string,
  ) {}

  /** Refresh the entire tree (or a specific element). */
  refresh(element?: TreeElement): void {
    this._onDidChangeTreeData.fire(element);
  }

  getTreeItem(element: TreeElement): vscode.TreeItem {
    switch (element.type) {
      case 'layer':
        return this.createLayerItem(element);
      case 'domain':
        return this.createDomainItem(element);
      case 'newDomain':
        return this.createNewDomainItem(element);
    }
  }

  getChildren(element?: TreeElement): TreeElement[] | undefined {
    if (!element) {
      return VALID_LAYERS.map((layer): LayerNode => ({ type: 'layer', layer }));
    }

    if (element.type === 'layer') {
      return this.getLayerChildren(element.layer);
    }

    return undefined;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getLayerChildren(layer: Layer): TreeElement[] {
    const summaries = this.domainService.listDomains(this.projectPath);
    const layerDomains = summaries.filter(s => s.layer === layer);

    const domainNodes: DomainNode[] = layerDomains.map(summary => {
      let modelCount = 0;
      let designCount = 0;
      try {
        const domain = this.domainService.getDomain(summary.filePath);
        modelCount = domain.models.length;
        designCount = domain.models.filter(m => m.source === 'design').length;
      } catch (err) {
        console.warn(`[DomainTreeProvider] Failed to load ${summary.filePath}:`, err);
      }
      return { type: 'domain' as const, summary, modelCount, designCount };
    });

    const children: TreeElement[] = [...domainNodes];

    if (CREATABLE_LAYERS.includes(layer)) {
      children.push({ type: 'newDomain', layer });
    }

    return children;
  }

  private createLayerItem(element: LayerNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      LAYER_LABELS[element.layer],
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.contextValue = 'layer';
    item.iconPath = new vscode.ThemeIcon('folder');
    return item;
  }

  private createDomainItem(element: DomainNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.summary.domain,
      vscode.TreeItemCollapsibleState.None,
    );

    const modelWord = element.modelCount === 1 ? 'model' : 'models';
    const designWord = element.designCount === 1 ? 'design' : 'designs';
    item.description = element.designCount > 0
      ? `${element.modelCount} ${modelWord}, ${element.designCount} ${designWord}`
      : `${element.modelCount} ${modelWord}`;

    item.contextValue = 'domain';
    item.iconPath = new vscode.ThemeIcon('json');
    item.tooltip = `${LAYER_LABELS[element.summary.layer]} / ${element.summary.domain}`;
    item.command = {
      command: 'dbtSemantic.openDomain',
      title: 'Open Domain',
      arguments: [element.summary.filePath],
    };

    return item;
  }

  private createNewDomainItem(element: NewDomainNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      'New Domain...',
      vscode.TreeItemCollapsibleState.None,
    );
    item.contextValue = 'newDomain';
    item.iconPath = new vscode.ThemeIcon('add');
    item.command = {
      command: 'dbtSemantic.createDomain',
      title: 'Create Domain',
      arguments: [element.layer],
    };
    return item;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
