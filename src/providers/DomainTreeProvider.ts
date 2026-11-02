/**
 * SubjectAreaTreeProvider — VS Code TreeDataProvider for the sidebar.
 *
 * Displays the diagrams grouped by layer (bronze, silver, gold): each layer
 * row is drawn in its layers.json colour and says it is a layer, and each
 * diagram says how many of its tables it borrows from other layers (a
 * diagram belongs to one layer but can show any table). With
 * `erdStudio.sidebar.rowDetails` set to `full` (`rowDetails.ts`), each row
 * also says how many diagrams or tables it holds; compact, those counts are
 * in the hover only. A creatable layer row has an inline + (New Diagram in
 * that layer); a layer with no diagram yet ends with a labelled
 * "New Diagram…" row (full: every creatable layer does), and the tree ends
 * with "New Layer…" (the + menu is a shortcut to the same commands).
 *
 * Supports drag-and-drop to reorder layers. Stages are handled entirely
 * by the editor tabs — the tree is stage-agnostic.
 */

import * as vscode from 'vscode';

import * as fs from 'fs';
import * as path from 'path';

import type { SubjectAreaSummary, Layer } from '../types/semantic';
import { SubjectAreaService, subjectAreaTableNames } from '../services/domainService';
import type { LayerService } from '../services/layerService';
import { createLogger, elapsedMs, log, plural } from '../services/logger';
import { layersFailure } from '../services/diagramCommandErrors';
import { showCommandFailure } from '../commands/commandFailure';
import type { DbmlFileIconResolver } from './dbmlFileKinds';
import { layerSwatchIcon } from './layerSwatch';
import { otherLayerCounts, type TableHome } from '../services/tableHomes';
import { LAYER_DEFINITION } from '../services/layerWording';
import {
  DIAGRAMS_FILTER,
  isEmptyQuery,
  labelHighlights,
  matchTreeQuery,
  parseTreeQuery,
  withReasons,
  type FilterOutcome,
  type SearchSubject,
  type TreeMatch,
  type TreeQuery,
} from '../services/treeSearch';
import { FILTER_COMMANDS, noMatchItem } from './sidebarFilter';
import { DEFAULT_ROW_DETAILS, type RowDetails } from './rowDetails';

const treeLog = createLogger('Subject Areas');

/** MIME type for layer drag-drop within the tree. */
export const LAYER_DRAG_MIME_TYPE = 'application/vnd.code.tree.dbtsemantic.layer';

// ---------------------------------------------------------------------------
// Tree element types (discriminated union)
// ---------------------------------------------------------------------------

interface LayerNode {
  readonly type: 'layer';
  readonly layer: Layer;
  /** How many diagrams the layer holds (while filtered, how many match). */
  readonly diagramCount?: number;
  /** Listed while filtered: the filter's generation, part of the row's id so VS Code shows it expanded. */
  readonly filterGeneration?: number;
}

interface SubjectAreaNode {
  readonly type: 'domain';
  readonly summary: SubjectAreaSummary;
  readonly modelCount: number;
  /** The diagram's tables that live in other layers, per layer (layers.json order). */
  readonly otherLayers?: ReadonlyArray<{ layer: string; count: number }>;
  /** While filtered: what of the row matched (its name's highlights, and why when not its name). */
  readonly match?: TreeMatch;
}

/** The one row while a filter matches no diagram: clicking it clears the filter. */
interface NoMatchNode {
  readonly type: 'noMatch';
}

interface NewSubjectAreaNode {
  readonly type: 'newDomain';
  readonly layer: Layer;
  /** The layer has no diagram yet: the row says so. */
  readonly first: boolean;
}

/** The tree's last row, under the layers. */
interface NewLayerNode {
  readonly type: 'newLayer';
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

export type TreeElement = ProjectNode | LayerNode | SubjectAreaNode | NewSubjectAreaNode | NewLayerNode | NoMatchNode;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Default semantic directory relative to project root. */
const DEFAULT_SEMANTIC_DIR = '.erd-studio';

/** Per-domain-file summary cached against the file's mtime + size. */
interface CachedSubjectAreaSummary {
  readonly signature: string;
  readonly modelCount: number;
  /** The diagram's member table names (null when the file lists none it can read, or they were not asked for). */
  readonly members: readonly string[] | null;
  /** Whether {@link members} was read: names are read only when some table has a layer (or the view is filtered). */
  readonly membersRead: boolean;
  /** The diagram's description, read with its members (a JSON `description`, a DBML Project `Note`). */
  readonly description?: string;
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
  private summariesByLayer: {
    byLayer: Map<string, SubjectAreaSummary[]>;
    unread: Set<string>;
    /** Each table's home, worked out once for the layers of this listing (on the first that has a diagram). */
    homes?: ReadonlyMap<string, TableHome>;
  } | undefined;

  /** The project row, or undefined while the workspace has one dbt project. */
  private projectRow: ProjectNode | undefined;

  /**
   * `erdStudio.diagramsLoading`: true until a root listing finds no rows.
   * A listing with rows leaves it set: VS Code applies a context key the
   * moment it arrives but draws the rows a little later, so clearing it on
   * every first listing flashed "No diagrams yet" over a full project.
   */
  private loading = true;

  /** The sidebar filter (session only), or undefined while every diagram shows. */
  private filterQuery: TreeQuery | undefined;
  /** Counts filter changes: part of a filtered layer row's id, so VS Code shows it expanded. */
  private filterGeneration = 0;
  /** While filtered: each layer's matching diagrams, from the root listing that found them. */
  private filteredLayers: Map<string, TreeElement[]> | undefined;
  private readonly _onDidFilter = new vscode.EventEmitter<FilterOutcome | undefined>();
  /** After each root listing: what the filter found (undefined while not filtered), for the view's message. */
  readonly onDidFilter = this._onDidFilter.event;
  /** How much each row says beside its name (`erdStudio.sidebar.rowDetails`). */
  private rowDetails: RowDetails = DEFAULT_ROW_DETAILS;
  /** How many diagrams the last root listing found (in the configured layers); undefined before one. */
  private diagramTotal: number | undefined;

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
    /** Each DBML table's layer and schema, by lower-cased name (`tableHomesOf`). Optional: without it no diagram names other layers. */
    private readonly tableHomes?: () => ReadonlyMap<string, TableHome>,
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
    this.filteredLayers = undefined;
    this._onDidChangeTreeData.fire(element);
  }

  /**
   * Show only the diagrams `text` matches (`treeSearch` syntax: a name, a
   * layer, a description, a table the diagram shows), under their layers;
   * `''` shows every row again. Lists again.
   */
  setFilter(text: string): void {
    const query = parseTreeQuery(text, DIAGRAMS_FILTER);
    const next = isEmptyQuery(query) ? undefined : query;
    if (next?.text === this.filterQuery?.text) return;
    this.filterQuery = next;
    this.filterGeneration++;
    this.refresh();
  }

  /** The filter as typed (`''` when none). */
  getFilter(): string {
    return this.filterQuery?.text ?? '';
  }

  isFiltered(): boolean {
    return this.filterQuery !== undefined;
  }

  /** Compact rows (only what is unusual) or full ones (every count); lists again when it changes. */
  setRowDetails(mode: RowDetails): void {
    if (mode === this.rowDetails) return;
    this.rowDetails = mode;
    this.refresh();
  }

  getRowDetails(): RowDetails {
    return this.rowDetails;
  }

  /** The view's total beside its title (`5 diagrams`); undefined when none, or before the first listing. */
  headerTotal(): string | undefined {
    return this.diagramTotal ? plural(this.diagramTotal, 'diagram') : undefined;
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
   * Table count (and, when table homes are known, the member names) for a
   * domain file, served from the cache while the file on disk is unchanged.
   * Falls back to an uncached parse when the file cannot be stat'ed (e.g.
   * virtual paths in tests).
   */
  private getDiagramSummary(filePath: string, wantMembers: boolean): { modelCount: number; members: readonly string[] | null; description?: string } {
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
      if (cached && cached.signature === signature && (cached.membersRead || !wantMembers)) {
        return cached;
      }
    }

    let modelCount = 0;
    let raw: string | undefined;
    try {
      // Counted from the diagram file alone: resolving every table (a full
      // getSubjectArea) only to count them made each refresh as slow as
      // opening every diagram. With the member names wanted too, the file
      // is read once for both.
      if (wantMembers) {
        raw = fs.readFileSync(filePath, 'utf-8');
        modelCount = this.subjectAreaService.countSubjectAreaTablesInText(raw, filePath);
      } else {
        modelCount = this.subjectAreaService.countSubjectAreaTables(filePath);
      }
    } catch (err) {
      log.warn(`[DomainTreeProvider] Failed to load ${filePath}:`, err);
      // Do not cache failures — the file may be mid-write
      this.summaryCache.delete(key);
      return { modelCount: 0, members: null };
    }

    // The member names say which layers the tables come from (read only when some table has a layer);
    // a diagram whose names cannot be read still shows its count.
    let members: string[] | null = null;
    let description: string | undefined;
    if (raw !== undefined) {
      try {
        members = subjectAreaTableNames(raw, filePath);
      } catch {
        members = null;
      }
      description = diagramDescriptionOf(raw, filePath) || undefined;
    }

    if (signature !== null) {
      this.summaryCache.set(key, { signature, modelCount, members, membersRead: wantMembers, ...(description ? { description } : {}) });
    }
    return { modelCount, members, ...(description ? { description } : {}) };
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
        return this.filteredLayerItem(element, this.createLayerItem(element));
      case 'domain':
        return this.matchedDiagramItem(element, this.createSubjectAreaItem(element));
      case 'newDomain':
        return this.createNewSubjectAreaItem(element);
      case 'newLayer':
        return this.createNewLayerItem();
      case 'noMatch':
        return noMatchItem('diagrams', FILTER_COMMANDS.diagrams.clear);
    }
  }

  /** A layer row listed while filtered: a new id (so VS Code shows it expanded) and its matched label highlighted. */
  private filteredLayerItem(element: LayerNode, item: vscode.TreeItem): vscode.TreeItem {
    if (element.filterGeneration === undefined) return item;
    item.id = `${item.id}#filter${element.filterGeneration}`;
    item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    const label = typeof item.label === 'string' ? item.label : item.label?.label ?? '';
    const highlights = labelHighlights(this.filterQuery, label, ['layer']);
    if (highlights.length > 0) item.label = { label, highlights };
    return item;
  }

  /** A diagram row that matched the filter: its name highlighted, and why it matched when its name did not (`· has dim_customer`). */
  private matchedDiagramItem(element: SubjectAreaNode, item: vscode.TreeItem): vscode.TreeItem {
    if (!element.match) return item;
    if (element.match.highlights.length > 0) item.label = { label: element.summary.domain, highlights: [...element.match.highlights] };
    item.description = withReasons(typeof item.description === 'string' ? item.description : undefined, element.match.reasons);
    return item;
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
      if (this.filterQuery) {
        if (!this.filteredLayers) this.filteredRoot(this.filterQuery);
        return this.filteredLayers?.get(element.layer) ?? [];
      }
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
      this.diagramTotal = 0;
      if (!this.filterQuery) this._onDidFilter.fire(undefined);
      return [];
    }
    if (this.filterQuery) return this.filteredRoot(this.filterQuery);
    const start = Date.now();
    const layers = this.layerService.getAllLayers();
    const byLayer = this.listByLayer();
    const layerNodes = layers.map((layerConfig): LayerNode => ({
      type: 'layer', layer: layerConfig.id, diagramCount: byLayer.get(layerConfig.id)?.length ?? 0,
    }));
    this.summariesByLayer = { byLayer, unread: new Set(layers.map((l) => l.id)) };
    this.diagramTotal = layerNodes.reduce((sum, n) => sum + (n.diagramCount ?? 0), 0);
    treeLog.debug(`Listed ${plural(layers.length, 'layer')} in ${elapsedMs(start)} ms`);
    // Not filtered: the view's title shows the total (`SidebarFilter`).
    this._onDidFilter.fire(undefined);
    // Only alongside real content: an empty tree must stay empty so the
    // welcome view (which has its own Select dbt Project button) shows.
    if (layerNodes.length === 0) return this.projectRow ? [this.projectRow] : [];
    return [...(this.projectRow ? [this.projectRow] : []), ...layerNodes, { type: 'newLayer' }];
  }

  /**
   * The root while filtered: each layer with a diagram `query` matches (in
   * layers.json order), with its matching diagrams kept for its children;
   * no project, New Diagram… or New Layer… rows. Every diagram's members and
   * description are read (once per file version, through the summary cache).
   */
  private filteredRoot(query: TreeQuery): TreeElement[] {
    const start = Date.now();
    const layers = this.layerService.getAllLayers();
    const byLayer = this.listByLayer();
    const homes = this.tableHomes?.();
    const order = layers.map((l) => l.id);
    const generation = this.filterGeneration;
    const filtered = new Map<string, TreeElement[]>();
    const rows: TreeElement[] = [];
    let shown = 0;
    let total = 0;
    for (const { id: layer } of layers) {
      const summaries = [...(byLayer.get(layer) ?? [])].sort((a, b) => a.domain.localeCompare(b.domain));
      total += summaries.length;
      const kept: SubjectAreaNode[] = [];
      for (const summary of summaries) {
        const { modelCount, members, description } = this.getDiagramSummary(summary.filePath, true);
        const match = matchTreeQuery(query, this.diagramSubject(summary, members, description, homes));
        if (!match) continue;
        const otherLayers = homes && homes.size > 0 && members ? otherLayerCounts(members, layer, homes, order) : [];
        kept.push({ type: 'domain', summary, modelCount, ...(otherLayers.length > 0 ? { otherLayers } : {}), match });
      }
      if (kept.length === 0) continue;
      shown += kept.length;
      filtered.set(layer, kept);
      rows.push({ type: 'layer', layer, diagramCount: kept.length, filterGeneration: generation });
    }
    this.filteredLayers = filtered;
    this.diagramTotal = total;
    treeLog.debug(`Filtered ${plural(total, 'diagram')} to ${shown} in ${elapsedMs(start)} ms`);
    this._onDidFilter.fire({ query, shown, total });
    // Nothing matches: one row that clears the filter (an empty view would show "No diagrams yet").
    return rows.length > 0 || layers.length === 0 ? rows : [{ type: 'noMatch' }];
  }

  /** A diagram as the filter searches it: its name, layer, description and the tables it shows (and their schemas). */
  private diagramSubject(
    summary: SubjectAreaSummary,
    members: readonly string[] | null,
    description: string | undefined,
    homes: ReadonlyMap<string, TableHome> | undefined,
  ): SearchSubject {
    const schemas = homes && members
      ? [...new Set(members.map((m) => homes.get(m.toLowerCase())?.schema).filter((s): s is string => !!s))]
      : [];
    return {
      name: summary.domain,
      nameKeys: ['diagram'],
      facets: [
        { key: 'layer', values: [summary.layer, this.layerService.getLabel(summary.layer)] },
        { values: [description], reason: () => 'in description' },
        { key: 'table', values: members ?? [], reason: (v) => `has ${v}` },
        { key: 'schema', text: false, values: schemas, reason: (v) => `has schema ${v}` },
      ],
    };
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
    const fromMemo = memo?.unread.delete(layer) === true;
    const byLayer = fromMemo ? memo!.byLayer : this.listByLayer();
    // By name, so a layer reads the same on every machine (the disk lists in any order).
    const layerDomains = [...(byLayer.get(layer) ?? [])].sort((a, b) => a.domain.localeCompare(b.domain));
    // Worked out once per listing, and only for a layer that has a diagram.
    let homes: ReadonlyMap<string, TableHome> | undefined;
    if (this.tableHomes && layerDomains.length > 0) {
      homes = fromMemo ? (memo!.homes ??= this.tableHomes()) : this.tableHomes();
    }
    // A YAML project's tables have no layer: no diagram names another one, so no names are read.
    const wantMembers = homes !== undefined && homes.size > 0;
    const order = this.layerService.getAllLayers().map((l) => l.id);

    const domainNodes: SubjectAreaNode[] = layerDomains.map((summary) => {
      const { modelCount, members } = this.getDiagramSummary(summary.filePath, wantMembers);
      const otherLayers = homes && members ? otherLayerCounts(members, layer, homes, order) : [];
      return {
        type: 'domain' as const,
        summary,
        modelCount,
        ...(otherLayers.length > 0 ? { otherLayers } : {}),
      };
    });

    const children: TreeElement[] = [...domainNodes];

    // Compact: only where it is the call to action (a layer with no diagram); elsewhere the layer row's inline + does it.
    if (this.layerService.isCreatable(layer) && (this.rowDetails === 'full' || domainNodes.length === 0)) {
      children.push({ type: 'newDomain', layer, first: domainNodes.length === 0 });
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
    item.id = `erdStudio.diagrams.layer:${element.layer}`;
    // `layerCreatable` offers New Diagram on the row (inline + and right-click).
    item.contextValue = this.layerService.isCreatable(element.layer) ? 'layerCreatable' : 'layer';
    // The layer's own colour, on its icon: the label keeps the theme's text colour, so it reads in every theme.
    item.iconPath = layerSwatchIcon(layerConfig?.color);
    const count = element.diagramCount;
    // Compact: what the row is; how many it holds is in the hover.
    item.description = count === undefined || this.rowDetails === 'compact'
      ? 'Layer'
      : `Layer · ${count === 0 ? 'no diagrams' : plural(count, 'diagram')}`;
    item.tooltip = layerTooltip(layerConfig?.label ?? element.layer, element.layer, this.semanticDir, count,
      this.layerService.isCreatable(element.layer));
    return item;
  }

  private createSubjectAreaItem(element: SubjectAreaNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.summary.domain,
      vscode.TreeItemCollapsibleState.None,
    );

    // Compact: no table count (it is in the hover), only the exceptions below.
    const parts: string[] = [];
    if (this.rowDetails === 'full') parts.push(plural(element.modelCount, 'table'));
    // The same name in both formats in one layer (native DBML storage): say which is which.
    if (element.summary.conflict) {
      const format = element.summary.storage === 'dbml' ? '(DBML)' : '(JSON)';
      if (parts.length > 0) parts[0] += ` ${format}`;
      else parts.push(format);
    }

    item.contextValue = 'domain';
    item.iconPath = element.summary.storage === 'dbml' && this.dbmlIcon
      ? this.dbmlIcon('diagram')
      : new vscode.ThemeIcon('json');
    // Tables borrowed from other layers: a diagram belongs to one layer but can show any table.
    const others = element.otherLayers ?? [];
    if (others.length > 0) {
      parts.push(others.map((o) => `${o.count} from ${this.layerService.getLabel(o.layer)}`).join(', '));
    }
    if (parts.length > 0) item.description = parts.join(' · ');
    item.tooltip = diagramTooltip(element, this.layerService.getLabel(element.summary.layer), this.diagramPath(element.summary.filePath),
      others.map((o) => ({ label: this.layerService.getLabel(o.layer), count: o.count })));
    item.command = {
      command: 'erdStudio.openDomain',
      title: 'Open Diagram',
      arguments: [element.summary.filePath],
    };

    return item;
  }

  /** A diagram file's path from the project folder, `/`-separated (its name alone when it is outside the project). */
  private diagramPath(filePath: string): string {
    const rel = path.relative(this.projectPath, filePath);
    return (rel.startsWith('..') || path.isAbsolute(rel) ? path.basename(filePath) : rel).split(path.sep).join('/');
  }

  private createNewSubjectAreaItem(element: NewSubjectAreaNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      'New Diagram…',
      vscode.TreeItemCollapsibleState.None,
    );
    if (element.first) item.description = 'none in this layer yet';
    item.tooltip = `Start a diagram in ${this.layerService.getLabel(element.layer)}`;
    item.contextValue = 'newDomain';
    item.iconPath = new vscode.ThemeIcon('add');
    item.command = {
      command: 'erdStudio.createDomain',
      title: 'New Diagram…',
      arguments: [element.layer],
    };
    return item;
  }

  private createNewLayerItem(): vscode.TreeItem {
    const item = new vscode.TreeItem('New Layer…', vscode.TreeItemCollapsibleState.None);
    item.id = 'erdStudio.newLayer';
    item.tooltip = `Add a layer. ${LAYER_DEFINITION}`;
    item.contextValue = 'newLayer';
    item.iconPath = new vscode.ThemeIcon('new-folder');
    item.command = { command: 'erdStudio.addLayer', title: 'New Layer…' };
    return item;
  }

  dispose(): void {
    this.summaryCache.clear();
    this._onDidChangeTreeData.dispose();
    this._onDidFilter.dispose();
  }
}

/** A layer row's tooltip: what a layer is, where its folder is, how many diagrams it holds, and how to start one. */
function layerTooltip(label: string, id: string, semanticDir: string, diagrams: number | undefined, creatable: boolean): vscode.MarkdownString {
  const lines = [
    `**${label}** — a layer`,
    '',
    'A stage of your warehouse. Each table belongs to one layer and one schema; a diagram belongs to one layer and can show tables from any layer.',
    '',
    `Folder: \`${semanticDir}/${id}/\``,
  ];
  if (diagrams !== undefined) lines.push('', diagrams === 0 ? 'No diagrams yet.' : plural(diagrams, 'diagram'));
  // The row's inline + (its title is the command's, which cannot name the layer).
  if (creatable) lines.push('', `**+** on this row starts a new diagram in ${label}.`);
  return new vscode.MarkdownString(lines.join('\n'));
}

/** A diagram row's tooltip: its layer, its file and where its tables come from. */
function diagramTooltip(
  element: SubjectAreaNode,
  layerLabel: string,
  file: string,
  others: ReadonlyArray<{ label: string; count: number }>,
): vscode.MarkdownString {
  const own = element.modelCount - others.reduce((sum, o) => sum + o.count, 0);
  const lines = [
    `**${element.summary.domain}** — a diagram in the ${layerLabel} layer`,
    '',
    `File: \`${file}\``,
    '',
    others.length === 0
      ? plural(element.modelCount, 'table')
      : `${plural(element.modelCount, 'table')}: ${[`${own} from ${layerLabel}`, ...others.map((o) => `${o.count} from ${o.label}`)].join(', ')}`,
  ];
  return new vscode.MarkdownString(lines.join('\n'));
}

/**
 * A diagram's description, from its file's text, for the sidebar filter: a
 * JSON diagram's `description`, or a DBML diagram's Project `Note` (found by
 * pattern, not parsed: the tree never compiles a diagram to list it). `''`
 * when there is none or it cannot be read.
 */
export function diagramDescriptionOf(text: string, filePath: string): string {
  if (/\.dbml$/i.test(filePath)) {
    const project = /^[ \t]*Project\b[^{\n]*\{/m.exec(text);
    if (!project) return '';
    const rest = text.slice(project.index + project[0].length);
    const end = rest.search(/^\}/m);
    const body = end === -1 ? rest : rest.slice(0, end);
    const note = /^[ \t]*Note\s*(?::\s*|\{\s*)('''[\s\S]*?'''|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/m.exec(body);
    if (!note) return '';
    const literal = note[1];
    return (literal.startsWith("'''") ? literal.slice(3, -3) : literal.slice(1, -1)).trim();
  }
  try {
    const raw = JSON.parse(text.replace(/^\uFEFF/, '')) as { description?: unknown } | null;
    return typeof raw?.description === 'string' ? raw.description.trim() : '';
  } catch {
    return '';
  }
}
