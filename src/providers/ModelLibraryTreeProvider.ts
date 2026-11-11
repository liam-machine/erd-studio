/**
 * TableLibraryTreeProvider — VS Code TreeDataProvider for the Model Library sidebar.
 *
 * Shows the table files of the library: `.dbml` tables in the layer folders
 * (`.erd-studio/<layer>/tables/<schema>/`, native DBML storage), or the YAML
 * files of a project from before 2.0 in .erd-studio/logical-models/ (or v6's
 * tables/). A YAML library with no sub-folders is a flat alphabetical list,
 * exactly as before layer folders existed. Once any table lives in a folder
 * (`{library}/{layer}/`), the folders are shown first — in layers.json order,
 * labelled with the layer's label — and the models still at the top level
 * follow them, the same shape the file explorer shows. DBML tables are
 * grouped as their files are: layer, then schema, then table
 * (`<layer>/tables/<schema>/<name>.dbml`). Each layer row is drawn in its
 * layers.json colour and says "Layer"; each schema row says "Schema". A layer
 * whose only schema has the layer's own name (`gold/tables/gold/`) lists its
 * tables directly and names the schema on its row.
 *
 * Each table says, once its file has been read, its warehouse name when it
 * differs from its name (`as orders`), and "on no diagram" when no diagram
 * shows it (with no warning: a staging table often is not drawn). With
 * `erdStudio.sidebar.rowDetails` set to `full` (`rowDetails.ts`) it also says
 * which diagrams use it ("on 2 diagrams") and its owner (its `owner` meta
 * entry: `owner:` in YAML and DBML, or an older `meta_owner`), and layer and schema rows their counts;
 * compact, those are in the hover only. When the repository has a
 * CODEOWNERS file, the tooltip names who reviews a change to the table's
 * file. A file whose name is already taken by a file earlier in the lookup
 * order is shown as a duplicate that is ignored. A library of more than
 * {@link COLLAPSE_LAYERS_OVER} tables starts with its layer rows collapsed.
 */

import * as vscode from 'vscode';
import * as path from 'path';

import type { TableLibraryService, TableFileEntry, TableFileError, TableSearchFacts, TableSummary } from '../services/logicalModelService';
import type { SubjectAreaService } from '../services/domainService';
import { DiagramMembers } from '../services/diagramMembers';
import { tableUsageOf, type TableUsageKeys } from '../services/sidebarTables';
import { tableIdOfEntry } from '../services/tableLibraryIndex';
import type { TableId } from '../types/tableId';
import type { CodeOwnersReader } from '../services/codeOwners';
import { duplicateNamePrefix, suggestDuplicateName } from '../services/duplicateModelResolver';
import { tableFileErrorTip } from '../commands/openModelFile';
import type { LayerConfig } from '../types/layer';
import type { DbmlFileIconResolver } from './dbmlFileKinds';
import { layerSwatchIcon } from './layerSwatch';
import { createLogger, elapsedMs, plural } from '../services/logger';
import { FILTER_COMMANDS, noMatchItem } from './sidebarFilter';
import { DEFAULT_ROW_DETAILS, type RowDetails } from './rowDetails';
import {
  TABLE_LIBRARY_FILTER,
  isEmptyQuery,
  labelHighlights,
  matchTreeQuery,
  parseTreeQuery,
  queryUses,
  tableSearchSubject,
  withReasons,
  type FilterOutcome,
  type SearchSubject,
  type TreeMatch,
  type TreeQuery,
} from '../services/treeSearch';

const treeLog = createLogger('Table Library');

/** The Table Library's view id (its filter shows reading progress there). */
export const TABLE_LIBRARY_VIEW_ID = 'erdStudio.modelLibrary';

// ---------------------------------------------------------------------------
// Tree element type
// ---------------------------------------------------------------------------

export interface TableLibraryTableNode {
  readonly type: 'model';
  readonly name: string;
  readonly filePath: string;
  readonly referencingDomains: string[];
  /** Each referencing diagram with its layer (`sales (Gold)`), for the tooltip. */
  readonly referencingLabels?: string[];
  /** The warehouse name (`alias`), once the file has been read. */
  readonly alias?: string;
  /** Who owns the table (its `owner` meta entry), once the file has been read. */
  readonly owner?: string;
  /** Folder under logical-models/ (`''` at the top level); a DBML table's schema folder. */
  readonly folder?: string;
  /** A DBML table's layer folder. */
  readonly layer?: string;
  /** Path of the file that wins the lookup when this one is a duplicate. */
  readonly shadowedBy?: string;
  /** In v6's `tables/` library (#181): read, never changed here, so it offers no actions. */
  readonly library?: 'tables';
  /**
   * What is wrong in the file, so the problem stays visible after its one
   * warning (#164). `message` is the reader's own sentence (it may quote the
   * file): shown in the row's tooltip, never sent anywhere.
   */
  readonly fileError?: Pick<TableFileError, 'kind' | 'line' | 'mergeConflict' | 'readable' | 'key' | 'code'> & { readonly message?: string };
  /** How the file stores the table (native DBML storage); shown only while the project is `mixed`. */
  readonly storage?: 'yaml' | 'dbml';
  /** The project holds both YAML and DBML tables: each entry names its format. */
  readonly showStorage?: true;
  /** While filtered: what of the row matched (its label's highlights, and why when not its name). */
  readonly match?: TreeMatch;
  /**
   * The table's identity (its schema folder and name), set only where the
   * library tells tables apart by it: the row's reads, counts and commands
   * then name this table, never another schema folder's table of its name.
   */
  readonly id?: TableId;
}

/**
 * The command that opens a table file from the tree: `vscode.open`, for a
 * `.dbml` table too (the canvas's selector, `<layer>/diagrams/<name>.dbml`, never
 * matches `<layer>/tables/<schema>/`).
 */
function openTableCommand(uri: vscode.Uri, options?: Record<string, unknown>): vscode.Command {
  return { command: 'vscode.open', title: 'Open Table', arguments: [uri, ...(options ? [options] : [])] };
}

export interface TableLibraryFolderNode {
  readonly type: 'folder';
  /**
   * Folder name under logical-models/ (normally a layer id); `''` for the top
   * of v6's `tables/`; a DBML schema folder (`<layer>/tables/<schema>/`).
   */
  readonly folder: string;
  /** A DBML schema folder's layer (`<layer>/tables/<schema>/`). */
  readonly layer?: string;
  readonly filePath: string;
  readonly children: TableLibraryTableNode[];
  /** Set for a folder of v6's `tables/` library (#181), read but not written by this version. */
  readonly library?: 'tables';
  /** Listed while filtered: the filter's generation, part of the row's id so VS Code shows it expanded. */
  readonly filterGeneration?: number;
}

/**
 * A DBML layer (`<layer>/tables/`): its schema folders, or — when its only
 * schema has the layer's own name — that schema's tables directly.
 */
export interface TableLibraryLayerNode {
  readonly type: 'layer';
  readonly layer: string;
  /** `<layer>/tables/`. */
  readonly filePath: string;
  readonly children: Array<TableLibraryFolderNode | TableLibraryTableNode>;
  readonly tableCount: number;
  /** The layer's schema folders, by name. */
  readonly schemas: readonly string[];
  /** Set when the layer's tables are listed without a schema level: the schema they are all in. */
  readonly soleSchema?: string;
  /** Listed while filtered: the filter's generation, part of the row's id so VS Code shows it expanded. */
  readonly filterGeneration?: number;
}

/**
 * The one row while a filter matches no table: clicking it clears the
 * filter. It holds no rows (`children` is empty, so code walking a
 * selection's rows needs no case for it).
 */
export interface TableLibraryNoMatchNode {
  readonly type: 'noMatch';
  readonly children: readonly never[];
}

export type TableLibraryNode = TableLibraryTableNode | TableLibraryFolderNode | TableLibraryLayerNode | TableLibraryNoMatchNode;

/** The row shown while the filter matches no table. */
const NO_MATCH_ROW: TableLibraryNoMatchNode = { type: 'noMatch', children: [] };

/** The tables among `nodes` and the rows under them, not counting a duplicate that is ignored. */
function tablesIn(nodes: readonly TableLibraryNode[]): number {
  return nodes.reduce((sum, n) => sum + (n.type === 'model' ? (n.shadowedBy ? 0 : 1) : tablesIn(n.children)), 0);
}

/** How long one slice of the background read of unread table files may run before yielding. */
const UNREAD_SLICE_MS = 50;

/** A path for a tooltip, from the semantic folder (`.erd-studio/gold/tables/sales`). */
function shownPath(semanticRoot: string, filePath: string): string {
  return path.join(path.basename(semanticRoot), path.relative(semanticRoot, filePath)).split(path.sep).join('/');
}

/**
 * A table's owner, as its meta says it (`owner:` in YAML and DBML, or an
 * older `meta_owner` / `meta_json` entry): a short text, else nothing. Shown in the sidebar only, never sent anywhere.
 */
export function tableOwnerOf(table: { readonly meta?: Readonly<Record<string, unknown>> } | null | undefined): string | undefined {
  const owner = table?.meta?.owner;
  if (typeof owner !== 'string') return undefined;
  const text = owner.trim();
  return text === '' || text.length > 80 || /[\r\n]/.test(text) ? undefined : text;
}

/** Text for a Markdown tooltip, with Markdown's own characters taken literally. */
function markdownText(text: string): string {
  return text.replace(/[\\`*_[\]<>|]/g, '\\$&');
}

/** A table on no diagram: its tooltip names the action that puts it on one. */
export const NO_DIAGRAM_TOOLTIP = 'On no diagram yet. **Add to Diagram…** puts it on one.';

/**
 * A library with more tables than this starts with its layer (and top-level
 * folder) rows collapsed, so a large library opens as a short list of layers;
 * VS Code then remembers each row's state by its id.
 */
export const COLLAPSE_LAYERS_OVER = 30;

/** The longest reader's message a broken file's tooltip quotes; a longer one is cut. */
const FILE_ERROR_REASON_MAX = 400;

/** Layer ids that have their own contributed colour (`erdStudio.layer.{id}`). */
const LAYER_COLOR_IDS = new Set(['bronze', 'silver', 'gold', 'platinum']);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class TableLibraryTreeProvider implements vscode.TreeDataProvider<TableLibraryNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TableLibraryNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Each diagram's member names, cached by file version (see {@link DiagramMembers}). */
  private readonly members: DiagramMembers;
  /**
   * `erdStudio.tablesLoading`: true until a root listing finds no rows (and
   * while a full rebuild runs). A listing with rows leaves it set: VS Code
   * applies a context key the moment it arrives but draws the rows a little
   * later, so clearing it on every listing flashed "No tables yet" over a
   * full library while the window opened.
   */
  private loading = true;
  /** The last root listing, which {@link getParent} searches. */
  private lastRoot: TableLibraryNode[] | undefined;
  /** The background read of table files the last render had not read yet (see {@link checkUnreadFiles}). */
  private unreadCheck: ReturnType<typeof setTimeout> | undefined;
  /** The sidebar filter (session only), or undefined while every table shows. */
  private filterQuery: TreeQuery | undefined;
  /** Counts filter changes: part of a filtered row's id, so VS Code shows every ancestor expanded. */
  private filterGeneration = 0;
  /** The read of unread table files a `col:` filter asked for, while it runs. */
  private filterRead: Promise<void> | undefined;
  private readonly _onDidFilter = new vscode.EventEmitter<FilterOutcome | undefined>();
  /** After each root listing: what the filter found (undefined while not filtered), for the view's message. */
  readonly onDidFilter = this._onDidFilter.event;
  /** How much each row says beside its name (`erdStudio.sidebar.rowDetails`). */
  private rowDetails: RowDetails = DEFAULT_ROW_DETAILS;
  /** The library's tables in the last root listing (an ignored duplicate not counted); undefined before one. */
  private tableTotal: number | undefined;

  constructor(
    private readonly tableLibraryService: TableLibraryService,
    private readonly subjectAreaService: SubjectAreaService,
    private readonly projectPath: string,
    private readonly semanticDir: string,
    /** Configured layers, for ordering and labelling folders. Optional. */
    private readonly getLayers: () => LayerConfig[] = () => [],
    /** Told when the tree starts or stops loading (the extension sets `erdStudio.tablesLoading`). Optional. */
    private readonly onLoadingChange?: (loading: boolean) => void,
    /** The DBML Table icon for healthy `.dbml` rows (`dbmlFileIcon`). Optional: without it they keep the `symbol-class` codicon. */
    private readonly dbmlIcon?: DbmlFileIconResolver,
    /** The repository's CODEOWNERS, for "Reviewed by …" in a table's tooltip. Optional. */
    private readonly codeOwners?: Pick<CodeOwnersReader, 'ownersOf'>,
    /** The diagrams' member names, shared with the Explorer's tooltips. Optional: the tree keeps its own. */
    diagramMembers?: DiagramMembers,
  ) {
    this.members = diagramMembers ?? new DiagramMembers();
  }

  /** Whether the open folder is a dbt project: only then do tooltips mention dbt. */
  private hasDbtProject = true;

  /** Set once at activation from `dbt_project.yml` (the `erdStudio.hasDbtProject` context key's source). */
  setHasDbtProject(hasDbtProject: boolean): void {
    this.hasDbtProject = hasDbtProject;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Show only the tables `text` matches (`treeSearch` syntax), with the
   * layers and schemas they sit in; `''` shows every table again. Lists again.
   */
  setFilter(text: string): void {
    const query = parseTreeQuery(text, TABLE_LIBRARY_FILTER);
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

  /** Compact rows (only what is unusual) or full ones (every count and owner); lists again when it changes. */
  setRowDetails(mode: RowDetails): void {
    if (mode === this.rowDetails) return;
    this.rowDetails = mode;
    this.refresh();
  }

  getRowDetails(): RowDetails {
    return this.rowDetails;
  }

  /** The view's total beside its title (`17 tables`); undefined when none, or before the first listing. */
  headerTotal(): string | undefined {
    return this.tableTotal ? plural(this.tableTotal, 'table') : undefined;
  }

  /** Settles once the table files a `col:` filter asked for have been read (at once when none are being read). */
  whenFilterRead(): Promise<void> {
    return this.filterRead ?? Promise.resolve();
  }

  /** Whether the empty-state text is held back: no root listing has found the library empty (since it last had rows), or it is listed from scratch. */
  isLoading(): boolean {
    return this.loading;
  }

  private setLoading(loading: boolean): void {
    if (this.loading === loading) return;
    this.loading = loading;
    this.onLoadingChange?.(loading);
  }

  getTreeItem(element: TableLibraryNode): vscode.TreeItem {
    const item = this.treeItem(element);
    if (element.type === 'model') {
      // Filtered: the matched part of the name is highlighted, and the row says why when its name did not match.
      if (element.match) {
        if (element.match.highlights.length > 0) item.label = { label: element.name, highlights: [...element.match.highlights] };
        item.description = withReasons(typeof item.description === 'string' ? item.description : undefined, element.match.reasons);
      }
    } else if (element.type !== 'noMatch' && element.filterGeneration !== undefined) {
      // A new id each time the filter changes: VS Code honours Expanded only for an id it has not seen.
      item.id = `${item.id}#filter${element.filterGeneration}`;
      item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      const label = typeof item.label === 'string' ? item.label : item.label?.label ?? '';
      const highlights = labelHighlights(this.filterQuery, label, element.type === 'layer' ? ['layer'] : ['schema', 'layer']);
      if (highlights.length > 0) item.label = { label, highlights };
    }
    return item;
  }

  private treeItem(element: TableLibraryNode): vscode.TreeItem {
    if (element.type === 'noMatch') {
      return noMatchItem('tables', FILTER_COMMANDS.tableLibrary.clear);
    }
    if (element.type === 'layer') {
      return this.layerItem(element);
    }
    if (element.type === 'folder') {
      return this.folderItem(element);
    }

    // A `tables/` copy of a name `logical-models/` also has (#181), or a DBML
    // copy of a YAML table: reported, with no fix to offer. A duplicate within
    // one library (#182, `tables/` itself; DBML beside DBML) is an ordinary one, below.
    // (`TableLibraryService.isCrossLibraryDuplicate`'s rule, on the node.)
    const dbml = element.layer !== undefined;
    if (element.shadowedBy && (dbml ? !/\.dbml$/i.test(element.shadowedBy) : element.library && this.isInV5Library(element.shadowedBy))) {
      const winnerLibrary = this.isInV5Library(element.shadowedBy) ? 'logical-models' : 'tables';
      const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
      item.contextValue = 'logicalModelReadOnly';
      item.iconPath = new vscode.ThemeIcon('error');
      item.description = `(also in ${dbml ? winnerLibrary : 'logical-models'} — ignored)`;
      item.tooltip = `"${element.name}" has a file in both the old and the new table folder. Diagrams use:\n${element.shadowedBy}\n\n` +
        (dbml ? 'This DBML copy is ignored. Keep one of the two files.' : 'This copy in tables/ is ignored. Keep one of the two files.');
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
        `Table names are unique across all folders${this.hasDbtProject ? ', as dbt model names are' : ''}. Use "Give Duplicate Table Its Own Name" ` +
        `to make this copy "${this.duplicateSuggestion(element)}" with the warehouse name (alias) "${element.name}".`;
      item.accessibilityInformation = { label: `${element.name}, duplicate, ignored` };
      item.resourceUri = vscode.Uri.file(element.filePath);
      item.command = openTableCommand(item.resourceUri);
      return item;
    }

    const isOrphan = element.referencingDomains.length === 0;
    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);

    item.contextValue = 'logicalModel';
    // A table on no diagram is not a problem (a staging table often is not
    // drawn), so it keeps its table icon, YAML or DBML: only a file error or
    // a duplicate gets a warning.
    item.iconPath = dbml && this.dbmlIcon ? this.dbmlIcon('table') : new vscode.ThemeIcon('symbol-class');

    if (element.fileError) {
      return this.fileErrorItem(item, element, element.fileError);
    }

    const alias = element.alias && element.alias.toLowerCase() !== element.name.toLowerCase() ? element.alias : undefined;
    const count = element.referencingDomains.length;
    const full = this.rowDetails === 'full';
    // Compact: only what is unusual or identifying (an alias that differs, no diagram, the format in a
    // mixed project); the owner (unless the filter matched it: then it is why the row is shown) and
    // "on N diagrams" are in the hover.
    const parts: string[] = [];
    if (alias) parts.push(`as ${alias}`);
    if (element.owner && (full || labelHighlights(this.filterQuery, element.owner, ['owner']).length > 0)) parts.push(element.owner);
    if (isOrphan) {
      parts.push('on no diagram');
      // A screen reader announces this label: name the table first.
      item.accessibilityInformation = { label: `${element.name}, not used in any diagram` };
    } else if (full) {
      parts.push(`on ${count} ${count === 1 ? 'diagram' : 'diagrams'}`);
    }
    if (element.showStorage && element.storage) parts.push(element.storage === 'dbml' ? 'DBML' : 'YAML');
    if (parts.length > 0) item.description = parts.join(' · ');
    item.tooltip = dbml ? this.dbmlTableTooltip(element, alias) : this.yamlTableTooltip(element);

    item.resourceUri = vscode.Uri.file(element.filePath);
    item.command = openTableCommand(item.resourceUri);

    return item;
  }

  getChildren(element?: TableLibraryNode): TableLibraryNode[] | undefined {
    if (element) {
      return element.type === 'folder' || element.type === 'layer' ? element.children : undefined;
    }
    // A library listed from scratch (no index yet, or one a bulk change
    // dropped) is a full rebuild: `erdStudio.tablesLoading` holds until the
    // items are produced, so the empty-state text never shows meanwhile.
    const cold = typeof this.tableLibraryService.indexIsCold === 'function' && this.tableLibraryService.indexIsCold();
    if (cold) this.setLoading(true);
    const start = Date.now();
    let rows = 0;
    try {
      // One check of the library index for the whole render, not one per row.
      const full = this.withIndexSnapshot(() => this.rootChildren());
      // Filtered: the matching tables, under the layers and schemas they sit in.
      const query = this.filterQuery;
      const filtered = query ? this.withIndexSnapshot(() => this.filterRows(full, query)) : undefined;
      // Nothing matches: one row that clears the filter (an empty view would show its welcome text).
      const children = filtered ? (filtered.rows.length > 0 || full.length === 0 ? filtered.rows : [NO_MATCH_ROW]) : full;
      this.lastRoot = children;
      // The library's own rows, not the filter's: "No tables yet" shows only for an empty library.
      rows = full.length;
      this.tableTotal = tablesIn(full);
      treeLog.debug(`Listed ${plural(children.length, 'row')} in ${elapsedMs(start)} ms${cold ? ' (library read from scratch)' : ''}${query ? ' (filtered)' : ''}`);
      this._onDidFilter.fire(query && filtered
        ? { query, shown: filtered.shown, total: filtered.total, ...(this.filterRead ? { reading: true } : {}) }
        : undefined);
      return children;
    } finally {
      // Only an empty listing lets the "No tables yet" text show.
      this.setLoading(rows > 0);
    }
  }

  /**
   * The rows `query` keeps: each matching table (with what matched), under
   * its layer and schema rows (with the counts of what is shown), and none
   * of the containers left empty. Counts the library's tables (a duplicate
   * that is ignored is shown when it matches, but not counted).
   */
  private filterRows(rows: readonly TableLibraryNode[], query: TreeQuery): { rows: TableLibraryNode[]; shown: number; total: number } {
    const generation = this.filterGeneration;
    let shown = 0;
    let total = 0;
    const visit = (nodes: readonly TableLibraryNode[]): TableLibraryNode[] => nodes.flatMap((node): TableLibraryNode[] => {
      if (node.type === 'model') {
        if (!node.shadowedBy) total++;
        const match = matchTreeQuery(query, this.tableSubject(node));
        if (!match) return [];
        if (!node.shadowedBy) shown++;
        return [{ ...node, match }];
      }
      if (node.type === 'noMatch') return [];
      const children = visit(node.children);
      if (children.length === 0) return [];
      if (node.type === 'folder') return [{ ...node, children: children as TableLibraryTableNode[], filterGeneration: generation }];
      const schemas = node.soleSchema !== undefined
        ? node.schemas
        : children.flatMap((c) => (c.type === 'folder' ? [c.folder] : []));
      return [{ ...node, children: children as Array<TableLibraryFolderNode | TableLibraryTableNode>, tableCount: tablesIn(children), schemas, filterGeneration: generation }];
    });
    const kept = visit(rows);
    return { rows: kept, shown, total };
  }

  /** A table row as the filter searches it: see `TABLE_LIBRARY_FILTER` and docs/glossary.md. */
  private tableSubject(node: TableLibraryTableNode): SearchSubject {
    const facts = node.shadowedBy || node.fileError ? undefined : this.peekFacts(node.id ?? node.name);
    // A DBML table's layer is its folder's; a YAML table's folder is (by convention) a layer id.
    const layerId = node.layer ?? (node.folder ? node.folder : undefined);
    const layerLabel = layerId !== undefined ? this.getLayers().find((l) => l.id === layerId)?.label : undefined;
    return tableSearchSubject({
      name: node.name,
      ...(node.alias ? { alias: node.alias } : {}),
      ...(node.layer !== undefined ? { schema: node.folder } : facts?.schema ? { schema: facts.schema } : {}),
      ...(layerId !== undefined ? { layer: layerId } : {}),
      ...(layerLabel ? { layerLabel } : {}),
      ...(node.owner ? { owner: node.owner } : {}),
      ...(facts?.role ? { role: facts.role } : {}),
      ...(facts?.description ? { description: facts.description } : {}),
      ...(facts ? { columns: facts.columns } : {}),
      diagrams: node.referencingDomains,
      ...(node.shadowedBy ? { ignored: true } : {}),
    });
  }

  /** What the filter searches in a table already read (no read); undefined while unread. */
  private peekFacts(name: TableId | string): TableSearchFacts | undefined {
    return typeof this.tableLibraryService.peekTableSearchFacts === 'function' ? this.tableLibraryService.peekTableSearchFacts(name) : undefined;
  }

  /**
   * The row a row sits under, for `TreeView.reveal` (Reveal in Table
   * Library): a table's schema folder or layer, a schema folder's layer;
   * undefined at the top level. Matched by path against the last listing
   * (listed afresh when there is none), so a node from any listing works.
   */
  getParent(element: TableLibraryNode): TableLibraryNode | undefined {
    if (element.type === 'layer' || element.type === 'noMatch') return undefined;
    const roots = this.lastRoot ?? this.getChildren() ?? [];
    const same = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);
    const holds = (container: TableLibraryFolderNode | TableLibraryLayerNode): boolean =>
      container.children.some((child) => child.type === element.type && same(child.filePath, element.filePath));
    for (const row of roots) {
      if (row.type === 'model' || row.type === 'noMatch') continue;
      if (holds(row)) return row;
      if (row.type === 'layer') {
        for (const child of row.children) {
          if (child.type === 'folder' && holds(child)) return child;
        }
      }
    }
    return undefined;
  }

  /**
   * The row of the table named `name` (ignoring case) in a fresh listing,
   * never a duplicate that is ignored; undefined when the library has no such table.
   * Given the table's file (`filePath`), the row of that file: two schema
   * folders may each hold a table of the name.
   */
  findTableNode(name: string, filePath?: string): TableLibraryTableNode | undefined {
    const wanted = name.trim().toLowerCase();
    const atPath = filePath !== undefined ? path.resolve(filePath) : undefined;
    const search = (nodes: readonly TableLibraryNode[]): TableLibraryTableNode | undefined => {
      for (const node of nodes) {
        if (node.type === 'model') {
          if (node.shadowedBy) continue;
          if (atPath !== undefined ? path.resolve(node.filePath) === atPath : node.name.toLowerCase() === wanted) return node;
        } else {
          const found = search(node.children);
          if (found) return found;
        }
      }
      return undefined;
    };
    return search(this.getChildren() ?? []);
  }

  private rootChildren(): TableLibraryNode[] {
    if (!this.tableLibraryService.dirExists()) return [];

    // Which diagrams show each table: by its name, or (told apart by identity) by its file.
    const usage = this.usageKeys();
    const usageMap = this.buildUsageMap(usage);
    // Each entry names its format only while the project holds both (§5.5).
    const showStorage = typeof this.tableLibraryService.projectStorage === 'function' && this.tableLibraryService.projectStorage() === 'mixed';
    // A file read before (in its current version) answers from the service's
    // cache; one never read is read after the tree shows (checkUnreadFiles),
    // so a large library appears at once instead of after parsing every file.
    const peek = typeof this.tableLibraryService.peekTableFileError === 'function';
    const unread: Array<{ name: TableId | string; dbml: boolean }> = [];
    const toNode = (entry: TableFileEntry): TableLibraryTableNode => {
      // Told apart by identity, each row reads its own file, never its namesake's in another schema folder.
      const id = usage.byIdentity && !entry.shadowedBy ? tableIdOfEntry(entry) : undefined;
      const table = id ?? entry.name;
      let error = entry.shadowedBy ? null : peek ? this.tableLibraryService.peekTableFileError(table) : this.tableLibraryService.getTableFileError(table);
      if (error === undefined) {
        unread.push({ name: table, dbml: entry.layer !== undefined });
        error = null;
      }
      // The warehouse name (DBML) and owner (either format), from the cached
      // reading of a file already read: never a read, a copy or a
      // relationships attach here, so a large library shows at once.
      const summary = !entry.shadowedBy && !error ? this.peekSummary(table) : undefined;
      const alias = entry.layer !== undefined ? summary?.alias : undefined;
      const owner = tableOwnerOf(summary);
      const used = entry.shadowedBy ? undefined : usageMap.get(usage.byIdentity ? usage.keyOf({ name: entry.name, filePath: entry.filePath }) : entry.name);
      return {
        type: 'model',
        name: entry.name,
        filePath: entry.filePath,
        referencingDomains: used?.map((u) => u.domain) ?? [],
        ...(used && used.length > 0 ? { referencingLabels: used.map((u) => `${u.domain} (${u.layerLabel})`) } : {}),
        ...(alias ? { alias } : {}),
        ...(owner ? { owner } : {}),
        folder: entry.folder,
        ...(entry.layer !== undefined ? { layer: entry.layer } : {}),
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
            ...(error.code ? { code: error.code } : {}),
            ...(error.message ? { message: error.message } : {}),
          },
        } : {}),
        ...(id ? { id } : {}),
      };
    };
    const byName = (a: TableLibraryTableNode, b: TableLibraryTableNode): number => a.name.localeCompare(b.name);

    const entries = this.tableLibraryService.listTableFiles();
    // With `tables/` the only library (every DBML project, and YAML in the
    // new naming) its top level is the list itself, not a "tables/" folder.
    const onlyTables = entries.length > 0 && entries.every(e => e.library);
    const topLevel = entries.filter(e => e.folder === '' && (!e.library || onlyTables)).map(toNode).sort(byName);

    // Folders of logical-models/, then of v6's tables/ (#181) — its top level
    // included — so the two libraries never merge into one folder; then the
    // DBML tree's schema folders, one level: `<layer>/tables/<schema>/`.
    const grouped = new Map<string, TableLibraryTableNode[]>();
    for (const entry of entries) {
      if (entry.folder === '' && (!entry.library || onlyTables)) continue;
      const key = entry.layer !== undefined ? `dbml\0${entry.layer}\0${entry.folder}` : `${entry.library ?? ''}\0${entry.folder}`;
      const list = grouped.get(key) ?? [];
      list.push(toNode(entry));
      grouped.set(key, list);
    }
    this.checkUnreadFiles(unread);
    // No folders in use: the flat list users had before layer folders.
    if (grouped.size === 0) return topLevel;

    const layerOrder = new Map(this.getLayers().map((l, i) => [l.id, i]));
    const rank = (folder: string): number => (folder === '' ? -1 : layerOrder.get(folder) ?? Number.MAX_SAFE_INTEGER);
    // YAML folders first (logical-models/, then tables/), then the DBML layers in layers.json order, each layer's schemas by name.
    const group = (k: { library?: string; layer?: string }): number => (k.layer !== undefined ? 2 : k.library ? 1 : 0);
    const keys = [...grouped.keys()].map((key) => {
      const parts = key.split('\0');
      if (parts[0] === 'dbml' && parts.length === 3) return { key, library: undefined, layer: parts[1], folder: parts[2] };
      const [library, folder] = parts;
      return { key, library: library === 'tables' ? 'tables' as const : undefined, layer: undefined, folder };
    }).sort((a, b) => {
      if (group(a) !== group(b)) return group(a) - group(b);
      if (a.layer !== undefined && b.layer !== undefined && a.layer !== b.layer) {
        const la = rank(a.layer);
        const lb = rank(b.layer);
        return la !== lb ? la - lb : a.layer.localeCompare(b.layer);
      }
      const ia = a.layer !== undefined ? 0 : rank(a.folder);
      const ib = b.layer !== undefined ? 0 : rank(b.folder);
      return ia !== ib ? ia - ib : a.folder.localeCompare(b.folder);
    });
    const modelsDir = this.tableLibraryService.getTablesDir();
    const semanticRoot = path.dirname(modelsDir);
    const folderNodes: TableLibraryFolderNode[] = keys.map(({ key, library, layer, folder }) => ({
      type: 'folder',
      folder,
      filePath: layer !== undefined
        ? path.join(semanticRoot, layer, 'tables', folder)
        : library ? path.join(semanticRoot, library, folder) : path.join(modelsDir, folder),
      children: grouped.get(key)!.sort(byName),
      ...(layer !== undefined ? { layer } : {}),
      ...(library && !onlyTables ? { library } : {}),
    }));
    // DBML schema folders sit under their layer's row, as their files sit in its folder.
    const rows: Array<TableLibraryFolderNode | TableLibraryLayerNode> = [];
    for (const node of folderNodes) {
      const last = rows[rows.length - 1];
      if (node.layer === undefined) {
        rows.push(node);
      } else if (last?.type === 'layer' && last.layer === node.layer) {
        (last.children as TableLibraryFolderNode[]).push(node);
      } else {
        rows.push({ type: 'layer', layer: node.layer, filePath: path.join(semanticRoot, node.layer, 'tables'), children: [node], tableCount: 0, schemas: [] });
      }
    }
    const shaped = rows.map((row): TableLibraryNode => {
      if (row.type !== 'layer') return row;
      const schemas = row.children as TableLibraryFolderNode[];
      const tableCount = schemas.reduce((sum, f) => sum + f.children.length, 0);
      const names = schemas.map((f) => f.folder);
      // `gold/tables/gold/` alone: the tables sit under the layer, whose row names the schema.
      const sole = schemas.length === 1 && schemas[0].folder.toLowerCase() === row.layer.toLowerCase() ? schemas[0] : undefined;
      return sole
        ? { ...row, children: sole.children, tableCount, schemas: names, soleSchema: sole.folder }
        : { ...row, tableCount, schemas: names };
    });
    return [...shaped, ...topLevel];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Run `fn` against one validated library index (when the service offers one). */
  /** A read table's alias and meta from the service's cache (no read); undefined while unread. */
  private peekSummary(name: TableId | string): TableSummary | undefined {
    return typeof this.tableLibraryService.peekTableSummary === 'function' ? this.tableLibraryService.peekTableSummary(name) : undefined;
  }

  private withIndexSnapshot<T>(fn: () => T): T {
    return typeof this.tableLibraryService.withIndexSnapshot === 'function' ? this.tableLibraryService.withIndexSnapshot(fn) : fn();
  }

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
      // Why, in the reader's own words (the description stays short): plain text, since it may quote the file.
      const why = this.fileErrorReason(element, error);
      item.tooltip = [
        'This file can\'t be read, so the table is missing from every diagram. Open it to fix it.',
        ...(why ? ['', `${why}${error.line !== undefined ? ` (line ${error.line})` : ''}`] : []),
        ...(error.kind !== 'read' || error.mergeConflict ? ['', tableFileErrorTip(error.kind, error.mergeConflict, error.code)] : []),
      ].join('\n');
    }
    item.accessibilityInformation = { label: `${element.name}, ${String(item.description).replace(/^\(|\)$/g, '')}` };
    item.resourceUri = vscode.Uri.file(element.filePath);
    const at0 = new vscode.Position(error.line !== undefined && error.line >= 1 ? error.line - 1 : 0, 0);
    item.command = openTableCommand(item.resourceUri, { selection: new vscode.Range(at0, at0), preview: false });
    return item;
  }

  /**
   * The reader's message for a file that does not read, for the tooltip: one
   * line, the file named as the tree shows it (never its absolute path), cut
   * to a readable length. Undefined when the reader gave none.
   */
  private fileErrorReason(element: TableLibraryTableNode, error: NonNullable<TableLibraryTableNode['fileError']>): string | undefined {
    const raw = error.message?.trim();
    if (!raw) return undefined;
    const semanticRoot = path.dirname(this.tableLibraryService.getTablesDir());
    const shown = shownPath(semanticRoot, element.filePath);
    const oneLine = raw.split(element.filePath).join(shown).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ');
    return oneLine.length > FILE_ERROR_REASON_MAX ? `${oneLine.slice(0, FILE_ERROR_REASON_MAX - 1)}…` : oneLine;
  }

  /**
   * The name Give Duplicate Table Its Own Name offers for this copy, from
   * the same rule the command uses (`duplicateNamePrefix`): its layer (a DBML
   * table), or its schema when the file diagrams use is in the same layer,
   * else its folder.
   */
  private duplicateSuggestion(element: TableLibraryTableNode): string {
    const entries = this.tableLibraryService.listTableFiles();
    const winner = element.shadowedBy !== undefined
      ? entries.find((e) => path.resolve(e.filePath) === path.resolve(element.shadowedBy as string))
      : undefined;
    const taken = new Set(entries.map((e) => e.name));
    return suggestDuplicateName(element.name, duplicateNamePrefix(element, winner), taken) || element.name;
  }

  /** A DBML layer's row: its colour, the word "Layer", and what it holds. */
  private layerItem(element: TableLibraryLayerNode): vscode.TreeItem {
    const layer = this.getLayers().find(l => l.id === element.layer);
    const label = layer?.label ?? element.layer;
    const item = new vscode.TreeItem(label, this.groupRowState());
    item.id = `erdStudio.modelLibrary.layer:${element.layer}`;
    item.contextValue = 'tableLibraryLayer';
    item.iconPath = layerSwatchIcon(layer?.color);
    const tables = plural(element.tableCount, 'table');
    const schemas = plural(element.schemas.length, 'schema');
    // Compact: what the row is (the counts are in the hover). A sole schema has the layer's own
    // name, so the full row needs only the table count; the tooltip names it.
    item.description = this.rowDetails === 'compact'
      ? 'Layer'
      : element.soleSchema !== undefined ? `Layer · ${tables}` : `Layer · ${schemas} · ${tables}`;
    const semanticRoot = path.dirname(this.tableLibraryService.getTablesDir());
    item.tooltip = new vscode.MarkdownString([
      `**${label}** — a layer`,
      '',
      'A stage of your warehouse. Each table belongs to one layer and one schema, and its file sits in that schema\'s folder.',
      '',
      `Folder: \`${shownPath(semanticRoot, element.filePath)}/\``,
      '',
      element.soleSchema !== undefined
        ? `Every table is in the schema \`${element.soleSchema}\`, the layer's own name, so they are listed here directly.`
        : `Schemas: ${element.schemas.map((s) => `\`${s}\``).join(', ')}`,
      '',
      element.soleSchema !== undefined ? tables : `${tables} in ${schemas}`,
    ].join('\n'));
    return item;
  }

  /**
   * A layer row's (or top-level folder row's) first state: collapsed in a
   * library of more than {@link COLLAPSE_LAYERS_OVER} tables, else expanded.
   * VS Code keeps the user's own choice for an id it has seen.
   */
  private groupRowState(): vscode.TreeItemCollapsibleState {
    return (this.tableTotal ?? 0) > COLLAPSE_LAYERS_OVER
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.Expanded;
  }

  /** A DBML table's tooltip: its qualified name, where it lives, and the diagrams that show it. */
  private dbmlTableTooltip(element: TableLibraryTableNode, alias: string | undefined): vscode.MarkdownString {
    const layer = element.layer !== undefined ? this.getLayers().find(l => l.id === element.layer) : undefined;
    const semanticRoot = path.dirname(this.tableLibraryService.getTablesDir());
    const shown = element.referencingLabels ?? element.referencingDomains;
    return new vscode.MarkdownString([
      `**${element.folder ? `${element.folder}.` : ''}${element.name}**${alias ? ` — the warehouse table \`${alias}\`` : ''}`,
      '',
      `Layer **${layer?.label ?? element.layer}** · schema **${element.folder}**`,
      '',
      `File: \`${shownPath(semanticRoot, element.filePath)}\``,
      ...this.ownerLines(element),
      '',
      shown.length === 0
        ? NO_DIAGRAM_TOOLTIP
        : `On ${shown.length === 1 ? 'the diagram' : 'the diagrams'}:\n${shown.map((d) => `- ${d}`).join('\n')}`,
    ].join('\n'));
  }

  /** A YAML table's tooltip: the diagrams that show it, and who owns it. */
  private yamlTableTooltip(element: TableLibraryTableNode): vscode.MarkdownString {
    return new vscode.MarkdownString([
      element.referencingDomains.length === 0
        ? NO_DIAGRAM_TOOLTIP
        : `**Referenced by:**\n${element.referencingDomains.map(d => `- ${d}`).join('\n')}`,
      ...this.ownerLines(element),
    ].join('\n'));
  }

  /**
   * The table's owner (its meta) and who reviews a change to its file
   * (CODEOWNERS), each a line of its own after a blank one; none when unknown.
   */
  private ownerLines(element: TableLibraryTableNode): string[] {
    const lines: string[] = [];
    if (element.owner) lines.push('', `Owner: ${markdownText(element.owner)}`);
    const reviewers = this.codeOwners?.ownersOf(element.filePath) ?? [];
    if (reviewers.length > 0) lines.push('', `Reviewed by ${reviewers.map(markdownText).join(', ')}`);
    return lines;
  }

  private folderItem(element: TableLibraryFolderNode): vscode.TreeItem {
    if (element.layer !== undefined) return this.schemaFolderItem(element, element.layer);
    const layer = this.getLayers().find(l => l.id === element.folder);
    const label = element.library && element.folder === '' ? `${element.library}/` : layer?.label ?? element.folder;
    const item = new vscode.TreeItem(label, this.groupRowState());
    item.id = `erdStudio.modelLibrary.folder:${element.library ? `${element.library}/` : ''}${element.folder}`;
    item.contextValue = 'logicalModelFolder';
    const colorId = LAYER_COLOR_IDS.has(element.folder) ? element.folder : layer ? 'custom' : undefined;
    item.iconPath = colorId
      ? new vscode.ThemeIcon('folder', new vscode.ThemeColor(`erdStudio.layer.${colorId}`))
      : new vscode.ThemeIcon('folder');
    const count = element.children.length;
    // Compact: no count (it is in the hover); a folder of v6's tables/ beside logical-models/ still says so.
    const parts: string[] = [];
    if (this.rowDetails === 'full') parts.push(plural(count, 'table'));
    if (element.library && element.folder) parts.push(`${element.library}/`);
    if (parts.length > 0) item.description = parts.join(' · ');
    // The folder as it is on disk (tables/… or logical-models/…), never a guess.
    const where = `${path.relative(path.dirname(this.tableLibraryService.getTablesDir()), element.filePath).split(path.sep).join('/')}/`;
    item.tooltip = `${layer ? `${where} — tables created in ${layer.label} diagrams` : where}\n${plural(count, 'table')}`;
    return item;
  }

  /**
   * A DBML schema folder (`<layer>/tables/<schema>/`), under its layer's row:
   * the schema's name as the warehouse spells it, and the word "Schema".
   */
  private schemaFolderItem(element: TableLibraryFolderNode, layerId: string): vscode.TreeItem {
    const layer = this.getLayers().find(l => l.id === layerId);
    const layerName = layer?.label ?? layerId;
    const item = new vscode.TreeItem(element.folder, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `erdStudio.modelLibrary.folder:${layerId}/tables/${element.folder}`;
    // Its own value (not a YAML folder's `logicalModelFolder`): New Table… is offered on it.
    item.contextValue = 'tableLibrarySchema';
    item.iconPath = new vscode.ThemeIcon('symbol-namespace');
    const count = element.children.length;
    // Compact: what the row is (the count is in the hover).
    item.description = this.rowDetails === 'compact' ? 'Schema' : `Schema · ${plural(count, 'table')}`;
    const semanticRoot = path.dirname(this.tableLibraryService.getTablesDir());
    item.tooltip = new vscode.MarkdownString([
      `**${element.folder}** — a schema in the ${layerName} layer`,
      '',
      `Where the tables live in the warehouse: each is declared \`Table ${element.folder}.<name>\`.`,
      '',
      `Folder: \`${shownPath(semanticRoot, element.filePath)}/\``,
      '',
      plural(count, 'table'),
    ].join('\n'));
    return item;
  }

  /**
   * Read, in the background and a slice at a time (the extension host stays
   * responsive), the table files the last render had not read, and render
   * again only when one of them turns out to need fixing or has a warehouse
   * name (`alias`) or an owner to show. Any earlier check still running is replaced.
   */
  private checkUnreadFiles(names: ReadonlyArray<{ name: TableId | string; dbml: boolean }>): void {
    if (this.unreadCheck !== undefined) clearTimeout(this.unreadCheck);
    this.unreadCheck = undefined;
    if (names.length === 0) return;
    // A `col:` filter needs every table's columns: read them now, with the view's progress bar.
    if (queryUses(this.filterQuery, 'col')) {
      this.readForFilter(names.map((n) => n.name));
      return;
    }
    const queue = [...names];
    let broken = false;
    const step = (): void => {
      this.unreadCheck = undefined;
      const started = Date.now();
      this.withIndexSnapshot(() => {
        while (queue.length > 0 && Date.now() - started < UNREAD_SLICE_MS) {
          const { name, dbml } = queue.shift()!;
          if (this.tableLibraryService.getTableFileError(name)) broken = true;
          else {
            // Only what a row shows: a YAML table's alias is never shown.
            const summary = this.peekSummary(name);
            if (tableOwnerOf(summary) || (dbml && summary?.alias)) broken = true;
          }
        }
      });
      if (queue.length > 0) {
        this.unreadCheck = setTimeout(step, 0);
      } else if (broken || this.filterQuery) {
        // Filtered, a table just read may match now (its owner, description or role).
        this.refresh();
      }
    };
    this.unreadCheck = setTimeout(step, 0);
  }

  /**
   * Read `names`' files for a `col:` filter, a slice at a time after this
   * listing (the extension host stays responsive), with the view's progress
   * bar; then list again. Reads through the library's caches, never writes.
   * One read at a time: the one under way lists again when it is done.
   */
  private readForFilter(names: ReadonlyArray<TableId | string>): void {
    if (this.filterRead) return;
    const queue = [...names];
    const read = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      while (queue.length > 0) {
        const started = Date.now();
        this.withIndexSnapshot(() => {
          while (queue.length > 0 && Date.now() - started < UNREAD_SLICE_MS) this.tableLibraryService.getTableFileError(queue.shift()!);
        });
        if (queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    const done: Promise<void> = Promise.resolve(vscode.window.withProgress({ location: { viewId: TABLE_LIBRARY_VIEW_ID } }, read))
      .catch((err: unknown) => treeLog.warn(`Reading table files for the filter failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        if (this.filterRead === done) this.filterRead = undefined;
        this.refresh();
      });
    this.filterRead = done;
  }

  /**
   * How tables and diagram members are matched: by name, or, where the
   * library tells tables apart by their schema folders, by the file each
   * member's `use` line reads (`sidebarTables.ts`).
   */
  private usageKeys(): TableUsageKeys {
    return tableUsageOf(this.tableLibraryService, this.members);
  }

  /**
   * Scan all diagram files and build a map of model name → domain names
   * (told apart by identity: each table's key, `usage.keyOf`, → domain names).
   * Reads raw membership (`subjectAreaTableNames`) to avoid expensive model resolution.
   */
  private buildUsageMap(usage: TableUsageKeys): Map<string, Array<{ domain: string; layerLabel: string }>> {
    const map = new Map<string, Array<{ domain: string; layerLabel: string }>>();
    const layers = this.getLayers();
    const summaries = this.subjectAreaService.listSubjectAreas(this.projectPath, this.semanticDir);
    const listed = new Set<string>();

    for (const summary of summaries) {
      listed.add(summary.filePath);
      try {
        // Format-agnostic: honours v4 inline objects, v5 name strings,
        // (for usage counting only) hybrid/legacy documents awaiting
        // migration, and a DBML diagram's `use` lines.
        // By identity, each member is the table its `use` line reads (a diagram counted once per table).
        const modelNames = usage.byIdentity ? usage.membersOf(summary.filePath) : this.members.of(summary.filePath);
        if (!modelNames) continue;

        const use = { domain: summary.domain, layerLabel: layers.find((l) => l.id === summary.layer)?.label ?? summary.layer };
        for (const name of modelNames) {
          const existing = map.get(name);
          if (existing) {
            existing.push(use);
          } else {
            map.set(name, [use]);
          }
        }
      } catch {
        // Skip unreadable/invalid domain files
      }
    }
    this.members.keepOnly(listed);

    return map;
  }

  dispose(): void {
    if (this.unreadCheck !== undefined) clearTimeout(this.unreadCheck);
    this._onDidChangeTreeData.dispose();
    this._onDidFilter.dispose();
  }
}
