/**
 * ModelLibraryTreeProvider — VS Code TreeDataProvider for the Model Library sidebar.
 *
 * Shows the model YAML files in .erd-studio/logical-models/. A library with
 * no sub-folders is a flat alphabetical list, exactly as before layer folders
 * existed. Once any model lives in a folder (logical-models/{layer}/), the
 * folders are shown first — in layers.json order, labelled with the layer's
 * label — and the models still at the top level follow them, the same shape
 * the file explorer shows.
 *
 * Orphaned models (not referenced by any domain) are flagged with a warning
 * icon and "(unused)" description. Referenced models show their domain count
 * and list domain names in the tooltip. A file whose name is already taken by
 * a file earlier in the lookup order is shown as a duplicate that is ignored.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import type { LogicalModelService, ModelFileEntry } from '../services/logicalModelService';
import type { DomainService } from '../services/domainService';
import type { LayerConfig } from '../types/layer';
import { getRawDomainModelNames } from '../types/semantic';

// ---------------------------------------------------------------------------
// Tree element type
// ---------------------------------------------------------------------------

export interface ModelLibraryModelNode {
  readonly type: 'model';
  readonly name: string;
  readonly filePath: string;
  readonly referencingDomains: string[];
  /** Folder under logical-models/ (`''` at the top level). */
  readonly folder?: string;
  /** Path of the file that wins the lookup when this one is a duplicate. */
  readonly shadowedBy?: string;
}

export interface ModelLibraryFolderNode {
  readonly type: 'folder';
  /** Folder name under logical-models/ (normally a layer id). */
  readonly folder: string;
  readonly filePath: string;
  readonly children: ModelLibraryModelNode[];
}

export type ModelLibraryNode = ModelLibraryModelNode | ModelLibraryFolderNode;

/** Layer ids that have their own contributed colour (`erdStudio.layer.{id}`). */
const LAYER_COLOR_IDS = new Set(['bronze', 'silver', 'gold', 'platinum']);

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
    /** Configured layers, for ordering and labelling folders. Optional. */
    private readonly getLayers: () => LayerConfig[] = () => [],
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ModelLibraryNode): vscode.TreeItem {
    if (element.type === 'folder') {
      return this.folderItem(element);
    }

    if (element.shadowedBy) {
      const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
      // Not `logicalModel`: Delete Model acts by name and would remove the
      // file that IS in use, not this one.
      item.contextValue = 'logicalModelDuplicate';
      item.iconPath = new vscode.ThemeIcon('error');
      item.description = '(duplicate — ignored)';
      item.tooltip = `Another file already defines "${element.name}" and is the one domains use:\n${element.shadowedBy}\n\n` +
        'Model names are unique across all folders, as in dbt. Use "Give Duplicate Model Its Own Name" ' +
        `to make this copy "${element.folder ? `${element.folder}_` : ''}${element.name}" with the table name (alias) "${element.name}".`;
      item.resourceUri = vscode.Uri.file(element.filePath);
      item.command = { command: 'vscode.open', title: 'Open Model', arguments: [item.resourceUri] };
      return item;
    }

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
    if (element) {
      return element.type === 'folder' ? element.children : undefined;
    }

    if (!this.logicalModelService.dirExists()) return [];

    const usageMap = this.buildUsageMap();
    const toNode = (entry: ModelFileEntry): ModelLibraryModelNode => ({
      type: 'model',
      name: entry.name,
      filePath: entry.filePath,
      referencingDomains: entry.shadowedBy ? [] : usageMap.get(entry.name) ?? [],
      folder: entry.folder,
      ...(entry.shadowedBy ? { shadowedBy: entry.shadowedBy } : {}),
    });
    const byName = (a: ModelLibraryModelNode, b: ModelLibraryModelNode): number => a.name.localeCompare(b.name);

    const entries = this.logicalModelService.listModelFiles();
    const topLevel = entries.filter(e => e.folder === '').map(toNode).sort(byName);

    const grouped = new Map<string, ModelLibraryModelNode[]>();
    for (const entry of entries) {
      if (entry.folder === '') continue;
      const list = grouped.get(entry.folder) ?? [];
      list.push(toNode(entry));
      grouped.set(entry.folder, list);
    }
    // No folders in use: the flat list users had before layer folders.
    if (grouped.size === 0) return topLevel;

    const layerOrder = new Map(this.getLayers().map((l, i) => [l.id, i]));
    const folders = [...grouped.keys()].sort((a, b) => {
      const ia = layerOrder.get(a) ?? Number.MAX_SAFE_INTEGER;
      const ib = layerOrder.get(b) ?? Number.MAX_SAFE_INTEGER;
      return ia !== ib ? ia - ib : a.localeCompare(b);
    });
    const modelsDir = this.logicalModelService.getModelsDir();
    const folderNodes: ModelLibraryFolderNode[] = folders.map(folder => ({
      type: 'folder',
      folder,
      filePath: path.join(modelsDir, folder),
      children: grouped.get(folder)!.sort(byName),
    }));
    return [...folderNodes, ...topLevel];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private folderItem(element: ModelLibraryFolderNode): vscode.TreeItem {
    const layer = this.getLayers().find(l => l.id === element.folder);
    const item = new vscode.TreeItem(layer?.label ?? element.folder, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `erdStudio.modelLibrary.folder:${element.folder}`;
    item.contextValue = 'logicalModelFolder';
    const colorId = LAYER_COLOR_IDS.has(element.folder) ? element.folder : layer ? 'custom' : undefined;
    item.iconPath = colorId
      ? new vscode.ThemeIcon('folder', new vscode.ThemeColor(`erdStudio.layer.${colorId}`))
      : new vscode.ThemeIcon('folder');
    const count = element.children.length;
    item.description = `${count} ${count === 1 ? 'model' : 'models'}`;
    item.tooltip = layer
      ? `logical-models/${element.folder}/ — models created in ${layer.label} domains`
      : `logical-models/${element.folder}/`;
    return item;
  }

  /**
   * Scan all domain JSON files and build a map of model name → domain names.
   * Uses raw JSON.parse to avoid expensive YAML model resolution.
   */
  private buildUsageMap(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    const summaries = this.domainService.listDomains(this.projectPath, this.semanticDir);

    for (const summary of summaries) {
      try {
        const raw = JSON.parse(fs.readFileSync(summary.filePath, 'utf-8')) as unknown;
        // Format-agnostic: honours v4 inline objects, v5 name strings, and
        // (for usage counting only) hybrid/legacy documents awaiting migration.
        const modelNames = getRawDomainModelNames(raw);

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
