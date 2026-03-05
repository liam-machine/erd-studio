/**
 * DomainTreeProvider — VS Code TreeDataProvider for the sidebar.
 *
 * Displays semantic domains grouped by layer (bronze, silver, gold).
 * Each domain shows a badge with model count.
 * "New Domain..." items appear inside creatable layers (not in physical stage).
 *
 * Supports drag-and-drop to reorder layers and stage filtering via
 * a title-bar button that opens a QuickPick.
 */

import * as vscode from 'vscode';

import * as fs from 'fs';
import * as path from 'path';

import type { DomainSummary, Layer, Stage } from '../types/semantic';
import { DomainService } from '../services/domainService';
import type { LayerService } from '../services/layerService';

/** MIME type for layer drag-drop within the tree. */
const LAYER_DRAG_MIME_TYPE = 'application/vnd.code.tree.dbtsemantic.layer';

/** Workspace state key for persisting the selected stage across sessions. */
const STAGE_STATE_KEY = 'dbtSemantic.treeStage';

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
  /**
   * The stage to open this domain in. For physical stage in the tree,
   * we open the logical file and then switch to physical in the editor.
   */
  readonly openAsStage: Stage;
}

interface NewDomainNode {
  readonly type: 'newDomain';
  readonly layer: Layer;
}

interface StageHeaderNode {
  readonly type: 'stageHeader';
}

export type TreeElement = LayerNode | DomainNode | NewDomainNode | StageHeaderNode;

// ---------------------------------------------------------------------------
// Stage labels for UI
// ---------------------------------------------------------------------------

const STAGE_LABELS: Record<Stage, string> = {
  conceptual: 'Conceptual',
  logical: 'Logical',
  physical: 'Physical',
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Default semantic directory relative to project root. */
const DEFAULT_SEMANTIC_DIR = 'erd-studio';

export class DomainTreeProvider
  implements vscode.TreeDataProvider<TreeElement>, vscode.TreeDragAndDropController<TreeElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly semanticDir: string;
  private currentStage: Stage;
  private treeView: vscode.TreeView<TreeElement> | undefined;

  // TreeDragAndDropController properties
  readonly dropMimeTypes = [LAYER_DRAG_MIME_TYPE];
  readonly dragMimeTypes = [LAYER_DRAG_MIME_TYPE];

  constructor(
    private readonly domainService: DomainService,
    private readonly layerService: LayerService,
    private readonly projectPath: string,
    private readonly context: vscode.ExtensionContext,
    semanticDir?: string,
  ) {
    this.semanticDir = semanticDir ?? DEFAULT_SEMANTIC_DIR;
    this.currentStage = this.context.workspaceState.get<Stage>(STAGE_STATE_KEY) ?? 'logical';
  }

  /**
   * Set the tree view reference so we can update its description.
   * Must be called after createTreeView().
   */
  setTreeView(treeView: vscode.TreeView<TreeElement>): void {
    this.treeView = treeView;
    this.updateTreeViewDescription();
  }

  /** Get the currently active stage. */
  getStage(): Stage {
    return this.currentStage;
  }

  /** Switch the active stage and refresh the tree. */
  async setStage(stage: Stage): Promise<void> {
    this.currentStage = stage;
    await this.context.workspaceState.update(STAGE_STATE_KEY, stage);
    this.updateTreeViewDescription();
    this.refresh();
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
    // Only allow dragging single layer nodes
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
    // Get the dragged layer ID
    const transferItem = dataTransfer.get(LAYER_DRAG_MIME_TYPE);
    if (!transferItem) return;

    const draggedLayerId = transferItem.value as string;

    // Target must be a layer node (or undefined for root)
    if (!target || target.type !== 'layer') return;

    const targetLayerId = target.layer;

    // Don't do anything if dropping on itself
    if (draggedLayerId === targetLayerId) return;

    // Get current layer order
    const layers = this.layerService.getAllLayers();
    const layerIds = layers.map(l => l.id);

    // Find positions
    const draggedIndex = layerIds.indexOf(draggedLayerId);
    const targetIndex = layerIds.indexOf(targetLayerId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    // Remove from old position and insert at new position
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
      case 'stageHeader':
        return this.createStageHeaderItem();
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
      // Check if semantic directory exists - if not, return empty array
      // to trigger VS Code's viewsWelcome content (F408)
      const fullSemanticDir = path.join(this.projectPath, this.semanticDir);
      if (!fs.existsSync(fullSemanticDir)) {
        return [];
      }
      // Stage header + layers
      const layers = this.layerService.getAllLayers();
      const layerNodes: TreeElement[] = layers.map((layerConfig): LayerNode => ({ type: 'layer', layer: layerConfig.id }));
      return [{ type: 'stageHeader' } as StageHeaderNode, ...layerNodes];
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

    // For physical stage, show logical domain list (physical mirrors logical)
    const filterStage: Stage = this.currentStage === 'physical' ? 'logical' : this.currentStage;
    const layerDomains = summaries.filter(s => s.layer === layer && s.stage === filterStage);

    const domainNodes: DomainNode[] = layerDomains.map(summary => {
      let modelCount = 0;
      try {
        const domain = this.domainService.getDomain(summary.filePath);
        modelCount = domain.models.length;
      } catch (err) {
        console.warn(`[DomainTreeProvider] Failed to load ${summary.filePath}:`, err);
      }
      return {
        type: 'domain' as const,
        summary,
        modelCount,
        designCount: 0,
        openAsStage: this.currentStage,
      };
    });

    const children: TreeElement[] = [...domainNodes];

    // "New Domain..." only appears in editable stages (not physical)
    if (this.currentStage !== 'physical' && this.layerService.isCreatable(layer)) {
      children.push({ type: 'newDomain', layer });
    }

    return children;
  }

  private createStageHeaderItem(): vscode.TreeItem {
    const stageLabel = STAGE_LABELS[this.currentStage];
    const item = new vscode.TreeItem(stageLabel, vscode.TreeItemCollapsibleState.None);
    item.description = 'click to switch';
    item.iconPath = new vscode.ThemeIcon('list-tree');
    item.contextValue = 'stageHeader';
    item.command = {
      command: 'dbtSemantic.switchTreeStage',
      title: 'Switch Stage',
    };
    return item;
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
    item.resourceUri = vscode.Uri.parse(`dbt-semantic-layer:/${element.layer}`);

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
      command: 'dbtSemantic.openDomain',
      title: 'Open Domain',
      arguments: [element.summary.filePath, element.openAsStage],
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

  private updateTreeViewDescription(): void {
    // message/description not reliably visible in single-view containers;
    // stage is shown via the stageHeader tree item instead.
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
