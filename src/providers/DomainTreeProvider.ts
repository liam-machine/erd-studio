/**
 * SubjectAreaTreeProvider — VS Code TreeDataProvider for the sidebar.
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

import type { SubjectAreaSummary, Layer } from '../types/semantic';
import { SubjectAreaService } from '../services/domainService';
import type { LayerService } from '../services/layerService';
import { createLogger, elapsedMs, log, plural } from '../services/logger';
import { layersFailure } from '../services/diagramCommandErrors';
import { showCommandFailure } from '../commands/commandFailure';
import type { DbmlFileIconResolver } from './dbmlFileKinds';

const treeLog = createLogger('Subject Areas');

/** MIME type for layer drag-drop within the tree. */
export const LAYER_DRAG_MIME_TYPE = 'application/vnd.code.tree.dbtsemantic.layer';

// ---------------------------------------------------------------------------
// Tree element types (discriminated union)
// ---------------------------------------------------------------------------

interface LayerNode {
  readonly type: 'layer';
  readonly layer: Layer;
}

interface SubjectAreaNode {
  readonly type: 'domain';
  readonly summary: SubjectAreaSummary;
  readonly modelCount: number;
  readonly designCount: number;
}

interface NewSubjectAreaNode {
  readonly type: 'newDomain';
  readonly layer: Layer;
}

/**
 * The open dbt project, shown as the first row when the workspace holds more
 * than one (#82). Clicking it runs **Select dbt Project…** — a row in the
 * tree is always visible, where the view-title icon only appears on hover.
 */
interface ProjectNode {
  readonly type: 'project';
  readonly name: string;
  readonly location: string;
}

export type TreeElement = ProjectNode | LayerNode | SubjectAreaNode | NewSubjectAreaNode;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Default semantic directory relative to project root. */
const DEFAULT_SEMANTIC_DIR = '.erd-studio';

/** Per-domain-file summary cached against the file's mtime + size. */
interface CachedSubjectAreaSummary {
  readonly signature: string;
  readonly modelCount: number;
}

export class SubjectAreaTreeProvider
  implements vscode.TreeDataProvider<TreeElement>, vscode.TreeDragAndDropController<TreeElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly semanticDir: string;

  /**
   * Table-count cache keyed by file path. The count comes from the diagram
   * file alone (`countSubjectAreaTables`: no table is resolved), and is
   * validated by mtime + size so an edit is never served stale;
   * invalidateSubjectArea() drops entries eagerly when the file watcher
   * reports a change.
   */
  private readonly summaryCache = new Map<string, CachedSubjectAreaSummary>();

  /**
   * The subject areas by layer, listed once per render: the root's
   * getChildren lists them, and the first getChildren of each layer that
   * follows reads this instead of listing every layer folder again (a later
   * one, such as expanding a collapsed layer, lists afresh). Dropped on refresh().
   */
  private summariesByLayer: { byLayer: Map<string, SubjectAreaSummary[]>; unread: Set<string> } | undefined;

  /** The project row, or undefined while the workspace has one dbt project. */
  private projectRow: ProjectNode | undefined;

  /**
   * `erdStudio.diagramsLoading`: true until a root listing finds no rows.
   * A listing with rows leaves it set: VS Code applies a context key the
   * moment it arrives but draws the rows a little later, so clearing it on
   * every first listing flashed "No diagrams yet" over a full project.
   */
  private loading = true;

  // TreeDragAndDropController properties
  readonly dropMimeTypes = [LAYER_DRAG_MIME_TYPE];
  readonly dragMimeTypes = [LAYER_DRAG_MIME_TYPE];

  constructor(
    private readonly subjectAreaService: SubjectAreaService,
    private readonly layerService: LayerService,
    private readonly projectPath: string,
    semanticDir?: string,
    /** Told whether the empty-state text may show: false once a root listing finds no rows, true again once one finds rows (the extension sets `erdStudio.diagramsLoading`). Optional. */
    private readonly onLoadingChange?: (loading: boolean) => void,
    /** The DBML Diagram icon for `.dbml` rows (`dbmlFileIcon`). Optional: without it every diagram row keeps the `json` codicon. */
    private readonly dbmlIcon?: DbmlFileIconResolver,
  ) {
    this.semanticDir = semanticDir ?? DEFAULT_SEMANTIC_DIR;
  }

  /** Whether the empty-state text is held back: no root listing has found the tree empty (since it last had rows). */
  isLoading(): boolean {
    return this.loading;
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
      log.error(`[DomainTreeProvider] Failed to reorder layers: ${message}`);
      // Reorder is refused when layers.json is unreadable (H18) — tell the user, in words (#229)
      showCommandFailure(layersFailure('Reorder Layers', err, {
        workspaceRoot: this.projectPath, layersPath: this.layerService.getConfigPath(),
        doing: 'while saving layers.json', outcome: 'The layers weren\'t reordered.',
      }), err);
    }
  }

  /** Refresh the entire tree (or a specific element). */
  refresh(element?: TreeElement): void {
    this.summariesByLayer = undefined;
    this._onDidChangeTreeData.fire(element);
  }

  /**
   * Drop the cached summary for one domain file (or all files when called
   * without arguments). Called from the file watcher handlers; the mtime
   * check in getLayerChildren is the safety net when an event is missed.
   */
  invalidateSubjectArea(filePath?: string): void {
    if (filePath === undefined) {
      this.summaryCache.clear();
    } else {
      this.summaryCache.delete(path.normalize(filePath));
    }
  }

  /**
   * Model count for a domain file, served from the cache while the file on
   * disk is unchanged. Falls back to an uncached parse when the file cannot
   * be stat'ed (e.g. virtual paths in tests).
   */
  private getTableCount(filePath: string): number {
    let signature: string | null = null;
    try {
      const stat = fs.statSync(filePath);
      signature = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      // Unreadable stat — parse without caching
    }

    const key = path.normalize(filePath);
    if (signature !== null) {
      const cached = this.summaryCache.get(key);
      if (cached && cached.signature === signature) {
        return cached.modelCount;
      }
    }

    let modelCount = 0;
    try {
      // Counted from the diagram file alone: resolving every table (a full
      // getSubjectArea) only to count them made each refresh as slow as
      // opening every diagram.
      modelCount = this.subjectAreaService.countSubjectAreaTables(filePath);
    } catch (err) {
      log.warn(`[DomainTreeProvider] Failed to load ${filePath}:`, err);
      // Do not cache failures — the file may be mid-write
      this.summaryCache.delete(key);
      return 0;
    }

    if (signature !== null) {
      this.summaryCache.set(key, { signature, modelCount });
    }
    return modelCount;
  }

  /**
   * Show (or, with `undefined`, hide) the switchable project row at the top
   * of the tree. Called at activation and when workspace folders change.
   */
  setProjectRow(project: { name: string; location: string } | undefined): void {
    this.projectRow = project ? { type: 'project', ...project } : undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeElement): vscode.TreeItem {
    switch (element.type) {
      case 'project':
        return this.createProjectItem(element);
      case 'layer':
        return this.createLayerItem(element);
      case 'domain':
        return this.createSubjectAreaItem(element);
      case 'newDomain':
        return this.createNewSubjectAreaItem(element);
    }
  }

  getChildren(element?: TreeElement): TreeElement[] | undefined {
    if (!element) {
      // `erdStudio.diagramsLoading` is cleared only by a listing with no
      // rows, so the "No diagrams yet" welcome never flashes over a project
      // that has diagrams while the window opens.
      let rows = 0;
      try {
        const children = this.rootChildren();
        rows = children.length;
        return children;
      } finally {
        const loading = rows > 0;
        if (this.loading !== loading) {
          this.loading = loading;
          this.onLoadingChange?.(loading);
        }
      }
    }

    if (element.type === 'layer') {
      return this.getLayerChildren(element.layer);
    }

    return undefined;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private rootChildren(): TreeElement[] {
    const fullSemanticDir = path.join(this.projectPath, this.semanticDir);
    if (!fs.existsSync(fullSemanticDir)) {
      return [];
    }
    const start = Date.now();
    const layers = this.layerService.getAllLayers();
    const layerNodes = layers.map((layerConfig): LayerNode => ({ type: 'layer', layer: layerConfig.id }));
    this.summariesByLayer = { byLayer: this.listByLayer(), unread: new Set(layers.map((l) => l.id)) };
    treeLog.debug(`Listed ${plural(layers.length, 'layer')} in ${elapsedMs(start)} ms`);
    // Only alongside real content: an empty tree must stay empty so the
    // welcome view (which has its own Select dbt Project button) shows.
    return this.projectRow ? [this.projectRow, ...layerNodes] : layerNodes;
  }

  /** Every subject area, grouped by layer (one listing of the project). */
  private listByLayer(): Map<string, SubjectAreaSummary[]> {
    const byLayer = new Map<string, SubjectAreaSummary[]>();
    for (const summary of this.subjectAreaService.listSubjectAreas(this.projectPath, this.semanticDir)) {
      const list = byLayer.get(summary.layer);
      if (list) list.push(summary);
      else byLayer.set(summary.layer, [summary]);
    }
    return byLayer;
  }

  private getLayerChildren(layer: Layer): TreeElement[] {
    // A layer asked for on its own (no root call just before it) lists afresh.
    const start = Date.now();
    const memo = this.summariesByLayer;
    const byLayer = memo?.unread.delete(layer) ? memo.byLayer : this.listByLayer();
    const layerDomains = byLayer.get(layer) ?? [];

    const domainNodes: SubjectAreaNode[] = layerDomains.map(summary => ({
      type: 'domain' as const,
      summary,
      modelCount: this.getTableCount(summary.filePath),
      designCount: 0,
    }));

    const children: TreeElement[] = [...domainNodes];

    if (this.layerService.isCreatable(layer)) {
      children.push({ type: 'newDomain', layer });
    }

    treeLog.debug(`Layer ${layer} listed ${plural(domainNodes.length, 'diagram')} in ${elapsedMs(start)} ms`);
    return children;
  }

  private createProjectItem(element: ProjectNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
    item.description = 'dbt project · Switch…';
    item.tooltip = `Open dbt project: ${element.name} (${element.location}).\nClick to open a different dbt project in this workspace.`;
    item.contextValue = 'dbtProject';
    item.iconPath = new vscode.ThemeIcon('folder-library');
    item.command = { command: 'erdStudio.selectDbtProject', title: 'Select dbt Project…' };
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
    item.resourceUri = vscode.Uri.parse(`erd-studio-layer:/${element.layer}`);

    return item;
  }

  private createSubjectAreaItem(element: SubjectAreaNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.summary.domain,
      vscode.TreeItemCollapsibleState.None,
    );

    const modelWord = element.modelCount === 1 ? 'table' : 'tables';
    const designWord = element.designCount === 1 ? 'design' : 'designs';
    item.description = element.designCount > 0
      ? `${element.modelCount} ${modelWord}, ${element.designCount} ${designWord}`
      : `${element.modelCount} ${modelWord}`;
    // The same name in both formats in one layer (native DBML storage): say which is which.
    if (element.summary.conflict) {
      item.description += element.summary.storage === 'dbml' ? ' (DBML)' : ' (JSON)';
    }

    item.contextValue = 'domain';
    item.iconPath = element.summary.storage === 'dbml' && this.dbmlIcon
      ? this.dbmlIcon('diagram')
      : new vscode.ThemeIcon('json');
    item.tooltip = `${this.layerService.getLabel(element.summary.layer)} / ${element.summary.domain}`;
    item.command = {
      command: 'erdStudio.openDomain',
      title: 'Open Subject Area',
      arguments: [element.summary.filePath],
    };

    return item;
  }

  private createNewSubjectAreaItem(element: NewSubjectAreaNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      'New Subject Area...',
      vscode.TreeItemCollapsibleState.None,
    );
    item.contextValue = 'newDomain';
    item.iconPath = new vscode.ThemeIcon('add');
    item.command = {
      command: 'erdStudio.createDomain',
      title: 'New Subject Area',
      arguments: [element.layer],
    };
    return item;
  }

  dispose(): void {
    this.summaryCache.clear();
    this._onDidChangeTreeData.dispose();
  }
}
