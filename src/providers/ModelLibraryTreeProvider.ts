/**
 * TableLibraryTreeProvider — VS Code TreeDataProvider for the Model Library sidebar.
 *
 * Shows the table files of the library: `.dbml` tables in .erd-studio/tables/
 * (native DBML storage), or the YAML files of a project from before 2.0 in
 * .erd-studio/logical-models/ (or v6's tables/). A library with no
 * sub-folders is a flat alphabetical list, exactly as before layer folders
 * existed. Once any table lives in a folder (`{library}/{layer}/`), the
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

import type { TableLibraryService, TableFileEntry, TableFileError } from '../services/logicalModelService';
import type { SubjectAreaService } from '../services/domainService';
import { subjectAreaTableNames } from '../services/domainService';
import type { LayerConfig } from '../types/layer';

// ---------------------------------------------------------------------------
// Tree element type
// ---------------------------------------------------------------------------

export interface TableLibraryTableNode {
  readonly type: 'model';
  readonly name: string;
  readonly filePath: string;
  readonly referencingDomains: string[];
  /** Folder under logical-models/ (`''` at the top level). */
  readonly folder?: string;
  /** Path of the file that wins the lookup when this one is a duplicate. */
  readonly shadowedBy?: string;
  /** In v6's `tables/` library (#181): read, never changed here, so it offers no actions. */
  readonly library?: 'tables';
  /** What is wrong in the file, so the problem stays visible after its one warning (#164). */
  readonly fileError?: Pick<TableFileError, 'kind' | 'line' | 'mergeConflict' | 'readable' | 'key'>;
  /** How the file stores the table (native DBML storage); shown only while the project is `mixed`. */
  readonly storage?: 'yaml' | 'dbml';
  /** The project holds both YAML and DBML tables: each entry names its format. */
  readonly showStorage?: true;
}

/**
 * The command that opens a table file from the tree. A `.dbml` table opens
 * in the text editor (`vscode.openWith … 'default'`): the canvas's selector
 * also matches `tables/*.dbml`, which the canvas would only hand back (§5.9).
 */
function openTableCommand(uri: vscode.Uri, options?: Record<string, unknown>): vscode.Command {
  if (uri.fsPath.toLowerCase().endsWith('.dbml')) {
    return { command: 'vscode.openWith', title: 'Open Table', arguments: [uri, 'default', ...(options ? [options] : [])] };
  }
  return { command: 'vscode.open', title: 'Open Table', arguments: [uri, ...(options ? [options] : [])] };
}

export interface TableLibraryFolderNode {
  readonly type: 'folder';
  /** Folder name under logical-models/ (normally a layer id); `''` for the top of v6's `tables/`. */
  readonly folder: string;
  readonly filePath: string;
  readonly children: TableLibraryTableNode[];
  /** Set for a folder of v6's `tables/` library (#181), read but not written by this version. */
  readonly library?: 'tables';
}

export type TableLibraryNode = TableLibraryTableNode | TableLibraryFolderNode;

/** How long one slice of the background read of unread table files may run before yielding. */
const UNREAD_SLICE_MS = 50;

/** Layer ids that have their own contributed colour (`erdStudio.layer.{id}`). */
const LAYER_COLOR_IDS = new Set(['bronze', 'silver', 'gold', 'platinum']);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class TableLibraryTreeProvider implements vscode.TreeDataProvider<TableLibraryNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TableLibraryNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /**
   * Each diagram's member names (`subjectAreaTableNames`), by path, checked
   * against the file's mtime + size: a refresh after one diagram changed
   * reads that diagram only, not every diagram of the project.
   */
  private readonly membersCache = new Map<string, { signature: string; names: string[] | null }>();
  /** True until the first root getChildren has produced its items, and while a full rebuild runs (`erdStudio.tablesLoading`). */
  private loading = true;
  /** The background read of table files the last render had not read yet (see {@link checkUnreadFiles}). */
  private unreadCheck: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly tableLibraryService: TableLibraryService,
    private readonly subjectAreaService: SubjectAreaService,
    private readonly projectPath: string,
    private readonly semanticDir: string,
    /** Configured layers, for ordering and labelling folders. Optional. */
    private readonly getLayers: () => LayerConfig[] = () => [],
    /** Told when the tree starts or stops loading (the extension sets `erdStudio.tablesLoading`). Optional. */
    private readonly onLoadingChange?: (loading: boolean) => void,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Whether the tree has not produced its items yet, or is listing the library from scratch. */
  isLoading(): boolean {
    return this.loading;
  }

  private setLoading(loading: boolean): void {
    if (this.loading === loading) return;
    this.loading = loading;
    this.onLoadingChange?.(loading);
  }

  getTreeItem(element: TableLibraryNode): vscode.TreeItem {
    if (element.type === 'folder') {
      return this.folderItem(element);
    }

    // A `tables/` copy of a name `logical-models/` also has (#181): reported, with no fix to offer.
    // A duplicate within `tables/` itself (#182) is an ordinary one, below.
    if (element.shadowedBy && element.library && this.isInV5Library(element.shadowedBy)) {
      const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
      item.contextValue = 'logicalModelReadOnly';
      item.iconPath = new vscode.ThemeIcon('error');
      item.description = '(also in logical-models — ignored)';
      item.tooltip = `"${element.name}" has a file in both the old and the new table folder. Diagrams use:\n${element.shadowedBy}\n\n` +
        'This copy in tables/ is ignored. Keep one of the two files.';
      item.resourceUri = vscode.Uri.file(element.filePath);
      item.command = openTableCommand(item.resourceUri);
      return item;
    }

    if (element.shadowedBy) {
      const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
      // Not `logicalModel`: Delete Model acts by name and would remove the
      // file that IS in use, not this one.
      item.contextValue = 'logicalModelDuplicate';
      item.iconPath = new vscode.ThemeIcon('error');
      item.description = '(duplicate — ignored)';
      item.tooltip = `Another file already defines "${element.name}" and is the one diagrams use:\n${element.shadowedBy}\n\n` +
        'Table names are unique across all folders, as dbt model names are. Use "Give Duplicate Table Its Own Name" ' +
        `to make this copy "${element.folder ? `${element.folder}_` : ''}${element.name}" with the warehouse name (alias) "${element.name}".`;
      item.resourceUri = vscode.Uri.file(element.filePath);
      item.command = openTableCommand(item.resourceUri);
      return item;
    }

    const isOrphan = element.referencingDomains.length === 0;
    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);

    item.contextValue = 'logicalModel';
    item.iconPath = new vscode.ThemeIcon(isOrphan ? 'warning' : 'symbol-class');

    if (element.fileError) {
      return this.fileErrorItem(item, element, element.fileError);
    }

    if (isOrphan) {
      item.description = '(unused)';
      item.tooltip = 'Not used in any diagram';
    } else {
      const count = element.referencingDomains.length;
      item.description = `${count} ${count === 1 ? 'diagram' : 'diagrams'}`;
      item.tooltip = new vscode.MarkdownString(
        `**Referenced by:**\n${element.referencingDomains.map(d => `- ${d}`).join('\n')}`,
      );
    }

    if (element.showStorage && element.storage) {
      item.description = `${item.description ?? ''} · ${element.storage === 'dbml' ? 'DBML' : 'YAML'}`.replace(/^ · /, '');
    }

    item.resourceUri = vscode.Uri.file(element.filePath);
    item.command = openTableCommand(item.resourceUri);

    return item;
  }

  getChildren(element?: TableLibraryNode): TableLibraryNode[] | undefined {
    if (element) {
      return element.type === 'folder' ? element.children : undefined;
    }
    // A library listed from scratch (no index yet, or one a bulk change
    // dropped) is a full rebuild: `erdStudio.tablesLoading` holds until the
    // items are produced, so the empty-state text never shows meanwhile.
    if (typeof this.tableLibraryService.indexIsCold === 'function' && this.tableLibraryService.indexIsCold()) this.setLoading(true);
    try {
      return this.rootChildren();
    } finally {
      this.setLoading(false);
    }
  }

  private rootChildren(): TableLibraryNode[] {
    if (!this.tableLibraryService.dirExists()) return [];

    const usageMap = this.buildUsageMap();
    // Each entry names its format only while the project holds both (§5.5).
    const showStorage = typeof this.tableLibraryService.projectStorage === 'function' && this.tableLibraryService.projectStorage() === 'mixed';
    // A file read before (in its current version) answers from the service's
    // cache; one never read is read after the tree shows (checkUnreadFiles),
    // so a large library appears at once instead of after parsing every file.
    const peek = typeof this.tableLibraryService.peekTableFileError === 'function';
    const unread: string[] = [];
    const toNode = (entry: TableFileEntry): TableLibraryTableNode => {
      let error = entry.shadowedBy ? null : peek ? this.tableLibraryService.peekTableFileError(entry.name) : this.tableLibraryService.getTableFileError(entry.name);
      if (error === undefined) {
        unread.push(entry.name);
        error = null;
      }
      return {
        type: 'model',
        name: entry.name,
        filePath: entry.filePath,
        referencingDomains: entry.shadowedBy ? [] : usageMap.get(entry.name) ?? [],
        folder: entry.folder,
        ...(entry.storage ? { storage: entry.storage } : {}),
        ...(showStorage ? { showStorage: true as const } : {}),
        ...(entry.library ? { library: entry.library } : {}),
        ...(entry.shadowedBy ? { shadowedBy: entry.shadowedBy } : {}),
        ...(error ? {
          fileError: {
            kind: error.kind,
            ...(error.line !== undefined ? { line: error.line } : {}),
            ...(error.mergeConflict ? { mergeConflict: true as const } : {}),
            ...(error.readable ? { readable: true as const } : {}),
            ...(error.key ? { key: error.key } : {}),
          },
        } : {}),
      };
    };
    const byName = (a: TableLibraryTableNode, b: TableLibraryTableNode): number => a.name.localeCompare(b.name);

    const entries = this.tableLibraryService.listTableFiles();
    // With `tables/` the only library (every DBML project, and YAML in the
    // new naming) its top level is the list itself, not a "tables/" folder.
    const onlyTables = entries.length > 0 && entries.every(e => e.library);
    const topLevel = entries.filter(e => e.folder === '' && (!e.library || onlyTables)).map(toNode).sort(byName);

    // Folders of logical-models/, then of v6's tables/ (#181) — its top level
    // included — so the two libraries never merge into one folder.
    const grouped = new Map<string, TableLibraryTableNode[]>();
    for (const entry of entries) {
      if (entry.folder === '' && (!entry.library || onlyTables)) continue;
      const key = `${entry.library ?? ''}\0${entry.folder}`;
      const list = grouped.get(key) ?? [];
      list.push(toNode(entry));
      grouped.set(key, list);
    }
    this.checkUnreadFiles(unread);
    // No folders in use: the flat list users had before layer folders.
    if (grouped.size === 0) return topLevel;

    const layerOrder = new Map(this.getLayers().map((l, i) => [l.id, i]));
    const rank = (folder: string): number => (folder === '' ? -1 : layerOrder.get(folder) ?? Number.MAX_SAFE_INTEGER);
    const keys = [...grouped.keys()].map((key) => {
      const [library, folder] = key.split('\0');
      return { key, library: library === 'tables' ? 'tables' as const : undefined, folder };
    }).sort((a, b) => {
      if (!!a.library !== !!b.library) return a.library ? 1 : -1;
      const ia = rank(a.folder);
      const ib = rank(b.folder);
      return ia !== ib ? ia - ib : a.folder.localeCompare(b.folder);
    });
    const modelsDir = this.tableLibraryService.getTablesDir();
    const folderNodes: TableLibraryFolderNode[] = keys.map(({ key, library, folder }) => ({
      type: 'folder',
      folder,
      filePath: library ? path.join(path.dirname(modelsDir), library, folder) : path.join(modelsDir, folder),
      children: grouped.get(key)!.sort(byName),
      ...(library && !onlyTables ? { library } : {}),
    }));
    return [...folderNodes, ...topLevel];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Whether `filePath` is in `logical-models/` (the v5 library). */
  private isInV5Library(filePath: string): boolean {
    const rel = path.relative(path.resolve(this.tableLibraryService.getTablesDir()), path.resolve(filePath));
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /** A model whose file needs fixing: marked, explained, and opened at the line. */
  private fileErrorItem(
    item: vscode.TreeItem,
    element: TableLibraryTableNode,
    error: NonNullable<TableLibraryTableNode['fileError']>,
  ): vscode.TreeItem {
    const at = error.line !== undefined ? ` — line ${error.line}` : '';
    if (error.readable) {
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
      item.description = `(${error.key ? `"${error.key}"` : 'a key'} written twice${at})`;
      item.tooltip = `${error.key ? `"${error.key}"` : 'A key'} is written twice in the same block. ` +
        'The diagram uses the last one, but ERD Studio can\'t change this table until the other copy is removed.';
    } else {
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
      item.description = error.mergeConflict ? `(merge conflict${at})` : error.kind === 'read' ? '(can\'t be read)' : `(${error.kind.startsWith('dbml') ? 'DBML' : 'YAML'} error${at})`;
      item.tooltip = 'This file can\'t be read, so the table is missing from every diagram. Open it to fix it.';
    }
    item.resourceUri = vscode.Uri.file(element.filePath);
    const at0 = new vscode.Position(error.line !== undefined && error.line >= 1 ? error.line - 1 : 0, 0);
    item.command = openTableCommand(item.resourceUri, { selection: new vscode.Range(at0, at0), preview: false });
    return item;
  }

  private folderItem(element: TableLibraryFolderNode): vscode.TreeItem {
    const layer = this.getLayers().find(l => l.id === element.folder);
    const label = element.library && element.folder === '' ? `${element.library}/` : layer?.label ?? element.folder;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `erdStudio.modelLibrary.folder:${element.library ? `${element.library}/` : ''}${element.folder}`;
    item.contextValue = 'logicalModelFolder';
    const colorId = LAYER_COLOR_IDS.has(element.folder) ? element.folder : layer ? 'custom' : undefined;
    item.iconPath = colorId
      ? new vscode.ThemeIcon('folder', new vscode.ThemeColor(`erdStudio.layer.${colorId}`))
      : new vscode.ThemeIcon('folder');
    const count = element.children.length;
    item.description = `${count} ${count === 1 ? 'table' : 'tables'}`;
    // The folder as it is on disk (tables/… or logical-models/…), never a guess.
    const where = `${path.relative(path.dirname(this.tableLibraryService.getTablesDir()), element.filePath).split(path.sep).join('/')}/`;
    if (element.library && element.folder) item.description += ` · ${element.library}/`;
    item.tooltip = layer ? `${where} — tables created in ${layer.label} diagrams` : where;
    return item;
  }

  /**
   * Read, in the background and a slice at a time (the extension host stays
   * responsive), the table files the last render had not read, and render
   * again only when one of them turns out to need fixing. Any earlier check
   * still running is replaced.
   */
  private checkUnreadFiles(names: readonly string[]): void {
    if (this.unreadCheck !== undefined) clearTimeout(this.unreadCheck);
    this.unreadCheck = undefined;
    if (names.length === 0) return;
    const queue = [...names];
    let broken = false;
    const step = (): void => {
      this.unreadCheck = undefined;
      const started = Date.now();
      while (queue.length > 0 && Date.now() - started < UNREAD_SLICE_MS) {
        if (this.tableLibraryService.getTableFileError(queue.shift()!)) broken = true;
      }
      if (queue.length > 0) {
        this.unreadCheck = setTimeout(step, 0);
      } else if (broken) {
        this.refresh();
      }
    };
    this.unreadCheck = setTimeout(step, 0);
  }

  /**
   * Scan all diagram files and build a map of model name → domain names.
   * Reads raw membership (`subjectAreaTableNames`) to avoid expensive model resolution.
   */
  private buildUsageMap(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    const summaries = this.subjectAreaService.listSubjectAreas(this.projectPath, this.semanticDir);
    const listed = new Set<string>();

    for (const summary of summaries) {
      listed.add(summary.filePath);
      try {
        // Format-agnostic: honours v4 inline objects, v5 name strings,
        // (for usage counting only) hybrid/legacy documents awaiting
        // migration, and a DBML diagram's `use` lines.
        const modelNames = this.memberNames(summary.filePath);
        if (!modelNames) continue;

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
    for (const filePath of this.membersCache.keys()) {
      if (!listed.has(filePath)) this.membersCache.delete(filePath);
    }

    return map;
  }

  /** A diagram's member names, through {@link membersCache}; read afresh (uncached) when the file cannot be stat'ed. Throws when it cannot be read. */
  private memberNames(filePath: string): string[] | null {
    let signature: string | null = null;
    try {
      const stat = fs.statSync(filePath);
      signature = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      // No stat (a virtual path in tests): read without caching.
    }
    const cached = signature === null ? undefined : this.membersCache.get(filePath);
    if (cached && cached.signature === signature) return cached.names;
    const names = subjectAreaTableNames(fs.readFileSync(filePath, 'utf-8'), filePath);
    if (signature !== null) this.membersCache.set(filePath, { signature, names });
    return names;
  }

  dispose(): void {
    if (this.unreadCheck !== undefined) clearTimeout(this.unreadCheck);
    this.membersCache.clear();
    this._onDidChangeTreeData.dispose();
  }
}
