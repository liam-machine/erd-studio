/**
 * DomainTreeProvider — VS Code TreeDataProvider for the sidebar.
 *
 * Displays semantic domains grouped by layer (bronze, silver, gold).
 * Each domain shows a badge with model count (from the logical stage).
 * "New Domain..." items appear inside creatable layers.
 *
 * Supports drag-and-drop to reorder layers. Stages are handled entirely
 * by the editor tabs — the tree is stage-agnostic.
 */

import * as vscode from 'vscode';

import * as fs from 'fs';
import * as path from 'path';

import type { DomainSummary, Layer } from '../types/semantic';
import { DomainService } from '../services/domainService';
import type { LayerService } from '../services/layerService';

/** MIME type for layer drag-drop within the tree. */
const LAYER_DRAG_MIME_TYPE = 'application/vnd.code.tree.dbtsemantic.layer';

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
// Provider
// ---------------------------------------------------------------------------

/** Default semantic directory relative to project root. */
const DEFAULT_SEMANTIC_DIR = '.erd-studio';

export class DomainTreeProvider
  implements vscode.TreeDataProvider<TreeElement>, vscode.TreeDragAndDropController<TreeElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly semanticDir: string;

  // TreeDragAndDropController properties
  readonly dropMimeTypes = [LAYER_DRAG_MIME_TYPE];
  readonly dragMimeTypes = [LAYER_DRAG_MIME_TYPE];

  constructor(
    private readonly domainService: DomainService,
    private readonly layerService: LayerService,
    private readonly projectPath: string,
    semanticDir?: string,
  ) {
    this.semanticDir = semanticDir ?? DEFAULT_SEMANTIC_DIR;
  }

  // -------------------------------------------------------------------------
  // TreeDragAndDropController implementation
  // -------------------------------------------------------------------------

  /**
   * Handle drag start — only allow dragging layer nodes.
   */
  handleDrag(
    source: readonly TreeElement[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void | Thenable<void> {
    if (source.length !== 1 || source[0].type !== 'layer') {
      return;
    }

    const layerNode = source[0];
    dataTransfer.set(LAYER_DRAG_MIME_TYPE, new vscode.DataTransferItem(layerNode.layer));
  }

  /**
   * Handle drop — reorder layers when dropping on another layer.
   */
  async handleDrop(
    target: TreeElement | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const transferItem = dataTransfer.get(LAYER_DRAG_MIME_TYPE);
    if (!transferItem) return;

    const draggedLayerId = transferItem.value as string;

    if (!target || target.type !== 'layer') return;

    const targetLayerId = target.layer;

    if (draggedLayerId === targetLayerId) return;

    const layers = this.layerService.getAllLayers();
    const layerIds = layers.map(l => l.id);

    const draggedIndex = layerIds.indexOf(draggedLayerId);
    const targetIndex = layerIds.indexOf(targetLayerId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    layerIds.splice(draggedIndex, 1);
    layerIds.splice(targetIndex, 0, draggedLayerId);

    try {
      await this.layerService.reorderLayers(layerIds);
      this.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[DomainTreeProvider] Failed to reorder layers: ${message}`);
    }
  }

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
      const fullSemanticDir = path.join(this.projectPath, this.semanticDir);
      if (!fs.existsSync(fullSemanticDir)) {
        return [];
      }
      const layers = this.layerService.getAllLayers();
      return layers.map((layerConfig): LayerNode => ({ type: 'layer', layer: layerConfig.id }));
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
    const summaries = this.domainService.listDomains(this.projectPath, this.semanticDir);
    const layerDomains = summaries.filter(s => s.layer === layer);

    const domainNodes: DomainNode[] = layerDomains.map(summary => {
      let modelCount = 0;
      try {
        const domain = this.domainService.getDomain(summary.filePath);
        modelCount = domain.logical.models.length;
      } catch (err) {
        console.warn(`[DomainTreeProvider] Failed to load ${summary.filePath}:`, err);
      }
      return {
        type: 'domain' as const,
        summary,
        modelCount,
        designCount: 0,
      };
    });

    const children: TreeElement[] = [...domainNodes];

    if (this.layerService.isCreatable(layer)) {
      children.push({ type: 'newDomain', layer });
    }

    return children;
  }

  private createLayerItem(element: LayerNode): vscode.TreeItem {
    const layerConfig = this.layerService.getLayer(element.layer);
    const item = new vscode.TreeItem(
      layerConfig?.label ?? element.layer,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.contextValue = 'layer';
    item.iconPath = new vscode.ThemeIcon('folder');

    // Assign a resource URI so FileDecorationProvider can apply colors
    item.resourceUri = vscode.Uri.parse(`erd-studio-layer:/${element.layer}`);

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
    item.tooltip = `${this.layerService.getLabel(element.summary.layer)} / ${element.summary.domain}`;
    item.command = {
      command: 'erdStudio.openDomain',
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
      command: 'erdStudio.createDomain',
      title: 'Create Domain',
      arguments: [element.layer],
    };
    return item;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
