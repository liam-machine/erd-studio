/**
 * RelationshipsTreeProvider — the sidebar's Relationships view.
 *
 * Every relationship in the project, grouped by layer and then by table, the
 * same layers the Diagrams view and the Table Library show: under each table,
 * the tables it points at (→, it holds the foreign key) and the tables that
 * point at it (←), read from that table's side. A relationship to a table in
 * another layer says so ("in Raw Vault"), and its tooltip names the
 * relationships file that stores it. A project with no layered (DBML) tables
 * lists its tables without the layer level, as before. Relationships that
 * name a table or column the library does not have are gathered first under
 * "Needs attention".
 * Clicking a relationship opens where it is written: the Ref's line in a DBML
 * relationships file, the FK table's YAML file, or the diagram that holds it.
 *
 * **Group by Relationships File** (a view-title toggle, remembered per
 * workspace) lists them as they are stored instead: each layer's
 * relationships files, each with its Refs (`fct_order → dim_customer`) in file
 * order. A relationship no relationships file holds (a YAML table's own, or
 * one a diagram keeps) is listed under its foreign-key table's layer.
 *
 * The view's rows are drawn in its own colour family, purple (the DBML
 * Relationships file icon's): each table's row has the relationships glyph,
 * each relationship a purple arrow (a problem keeps its warning). Layer rows
 * keep their layer swatch, as in every view. With
 * `erdStudio.sidebar.rowDetails` set to `full` (`rowDetails.ts`) a layer row
 * also counts its tables and relationships and a file row says it is a
 * relationships file; compact, a layer row says `Layer` and a table or file
 * row only its count (`2 · 1 problem`), the rest in the hover.
 *
 * Where the library tells tables apart by their schema folders, each table
 * is named by its library reference: its name, or `<schema>.<name>` where
 * another schema folder has a table of that name. Two such tables are then
 * two rows (each row's id is its table's identity), each with its own
 * relationships, layer and schema, and two relationships that differ only by
 * schema are two rows.
 *
 * Read-only, like every view here. The data is {@link buildRelationshipsOverview}
 * over the library's tables (and, for a YAML/JSON project, the relationships
 * still kept in diagram files); table files never read yet are read first, a
 * slice at a time, so a large library never blocks the extension host.
 */

import * as vscode from 'vscode';
import * as path from 'path';

import { classifySemanticFile } from '@erd-studio/core';

import type { TableLibraryService } from '../services/logicalModelService';
import type { SubjectAreaService } from '../services/domainService';
import { readSubjectAreaRelationships } from '../commands/moveRelationshipsToLibrary';
import {
  buildRelationshipsOverview,
  cardinalityFrom,
  columnList,
  describeProblem,
  type RelationshipEntry,
  type RelationshipsOverview,
  type TableRelationships,
} from '../services/relationshipsOverview';
import type { DbmlFileIconResolver } from './dbmlFileKinds';
import { layerSwatchIcon } from './layerSwatch';
import { createLogger, elapsedMs, plural } from '../services/logger';
import type { TableHome } from '../services/tableHomes';
import type { SemanticTable } from '../types/semantic';
import { tableIdKey } from '../types/tableId';
import type { LayerConfig } from '../types/layer';
import {
  RELATIONSHIPS_FILTER,
  isEmptyQuery,
  labelHighlights,
  matchTreeQuery,
  parseTreeQuery,
  withReasons,
  type FilterFlag,
  type FilterKey,
  type FilterOutcome,
  type SearchSubject,
  type TreeQuery,
} from '../services/treeSearch';
import { FILTER_COMMANDS, noMatchItem } from './sidebarFilter';
import { DEFAULT_ROW_DETAILS, type RowDetails } from './rowDetails';

const treeLog = createLogger('Relationships');

/** How long one slice of reading unread table files may run before yielding. */
const READ_SLICE_MS = 50;

// ---------------------------------------------------------------------------
// Tree element types
// ---------------------------------------------------------------------------

export interface RelationshipsAttentionNode {
  readonly type: 'attention';
  readonly entries: readonly RelationshipEntry[];
}

/** A layer's tables that have relationships (or, with no `layer`, the tables in no layer). */
export interface RelationshipsLayerNode {
  readonly type: 'layer';
  /** Absent for "Other tables": tables with no layer of their own. */
  readonly layer?: string;
  readonly groups: readonly TableRelationships[];
  /** Relationships with at least one end in the layer (grouped by file: those stored in the layer). */
  readonly relationshipCount: number;
  /**
   * Grouped by relationships file: the layer's files, then the relationships
   * no file holds whose foreign-key table is in the layer. Absent when
   * grouped by table.
   */
  readonly files?: readonly RelationshipsFileNode[];
  readonly unfiled?: readonly RelationshipEntry[];
}

/** One relationships file (`<layer>/relationships/<name>.dbml`) and the relationships it holds, in file order. */
export interface RelationshipsFileNode {
  readonly type: 'file';
  readonly filePath: string;
  readonly layer: string;
  readonly entries: readonly RelationshipEntry[];
}

/** How the view groups the relationships: under each of their tables, or by the file that stores them. */
export type RelationshipsGrouping = 'table' | 'file';

export interface RelationshipsTableNode {
  readonly type: 'table';
  readonly group: TableRelationships;
}

export interface RelationshipNode {
  readonly type: 'relationship';
  readonly entry: RelationshipEntry;
  /**
   * Read from the FK table (`from`, →), from the referenced table (`to`, ←),
   * listed as a problem, or listed in its file with both tables (`stored`,
   * `fct_order → dim_customer`).
   */
  readonly side: 'from' | 'to' | 'problem' | 'stored';
  /** The parent row's id, so the same relationship under two tables has two ids. */
  readonly parentId: string;
  /** Grouped by file: the layer whose row (or file) it is listed under. */
  readonly listedIn?: string;
}

/** The one row while a filter matches no relationship: clicking it clears the filter. */
export interface RelationshipsNoMatchNode {
  readonly type: 'noMatch';
}

export type RelationshipsNode =
  | RelationshipsAttentionNode
  | RelationshipsLayerNode
  | RelationshipsFileNode
  | RelationshipsTableNode
  | RelationshipNode
  | RelationshipsNoMatchNode;

const ATTENTION_ID = 'erdStudio.relationships.attention';
/** A table row's id: by its name, or (told apart by identity) its identity key, which holds a `/` no name can. */
const tableId = (key: string): string => `erdStudio.relationships.table:${key.toLowerCase()}`;
const fileId = (filePath: string): string => `erdStudio.relationships.file:${filePath.toLowerCase()}`;
const layerId = (layer: string | undefined): string => `erdStudio.relationships.layer:${layer ?? ''}`;

function entryId(entry: RelationshipEntry): string {
  const where = entry.source.kind === 'diagram' ? entry.source.filePath : 'library';
  return `${where}|${entry.fromModel}.${entry.fromColumns.join(',')}|${entry.toModel}.${entry.toColumns.join(',')}`.toLowerCase();
}

/** A cardinality as a modeller writes it on a line: `N:1`, `1:N`, `1:1`, `N:N`. */
const SHORT_CARDINALITY: Record<string, string> = { 'many-to-one': 'N:1', 'one-to-many': '1:N', 'one-to-one': '1:1', 'many-to-many': 'N:N' };

/**
 * The columns a row joins, read from its table's side: once when both ends
 * share the name (the common `customer_sk` → `customer_sk`), else `a → b`
 * (`b ← a` for an incoming row).
 */
function joinText(mine: readonly string[], theirs: readonly string[], arrow: '→' | '←'): string {
  const same = mine.length === theirs.length && mine.every((c, i) => c.toLowerCase() === theirs[i].toLowerCase());
  return same ? columnList(mine) : `${columnList(mine)} ${arrow} ${columnList(theirs)}`;
}

/** A relationship's or a table's count with its problems, as a group row shows it: `2`, `2 · 1 problem`. */
function countText(count: number, problems: number): string {
  return `${count}${problems > 0 ? ` · ${plural(problems, 'problem')}` : ''}`;
}

/** "many-to-one" → "Many to one". */
function cardinalityWords(c: string): string {
  const words = c.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class RelationshipsTreeProvider implements vscode.TreeDataProvider<RelationshipsNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RelationshipsNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** The last root listing's overview, which every child listing reads. */
  private overview: RelationshipsOverview | undefined;
  /** What the last root listing shows: {@link overview}, or while filtered the part of it that matches. */
  private listed: RelationshipsOverview | undefined;
  /** The sidebar filter (session only), or undefined while every relationship shows. */
  private filterQuery: TreeQuery | undefined;
  /** Counts filter changes: part of a filtered container's id, so VS Code shows it expanded. */
  private filterGeneration = 0;
  private readonly _onDidFilter = new vscode.EventEmitter<FilterOutcome | undefined>();
  /** After each root listing: what the filter found (undefined while not filtered), for the view's message. */
  readonly onDidFilter = this._onDidFilter.event;
  /** How much each row says beside its name (`erdStudio.sidebar.rowDetails`). */
  private rowDetails: RowDetails = DEFAULT_ROW_DETAILS;

  constructor(
    private readonly tableLibraryService: TableLibraryService,
    private readonly subjectAreaService: SubjectAreaService,
    private readonly projectPath: string,
    private readonly semanticDir: string,
    /** The DBML Table icon for tables stored as DBML (`dbmlFileIcon`). Optional. */
    private readonly dbmlIcon?: DbmlFileIconResolver,
    /** Each DBML table's layer and schema (`tableHomesOf`). Optional: without it the tables are listed without layers. */
    private readonly tableHomes?: () => ReadonlyMap<string, TableHome>,
    /** The configured layers, for their order, labels and colours. Optional. */
    private readonly getLayers: () => LayerConfig[] = () => [],
    /** Where a DBML Ref is written (`TableLibraryService.relationshipLocation`), for the tooltip. Optional. */
    private readonly relationshipLocation?: (rel: RelationshipEntry['first']) => { filePath: string; line: number } | undefined,
  ) {}

  /**
   * The homes the last root listing read (empty when the project has no
   * layered tables), by lower-cased table name; told apart by identity, by
   * lower-cased library reference, each with the table's own name.
   */
  private homes: ReadonlyMap<string, TableHome & { readonly name?: string }> = new Map();
  /** Told apart by identity: each table's identity key, by lower-cased library reference (the last root listing's). */
  private identityKeys: ReadonlyMap<string, string> = new Map();

  /** Under each table (the default), or by the relationships file that stores them. */
  private grouping: RelationshipsGrouping = 'table';
  /** Told apart by identity: the homes {@link loadOverview} read, by lower-cased library reference. */
  private libraryHomes: ReadonlyMap<string, TableHome & { readonly name: string }> | undefined;

  /** A table row's id key: its identity where tables are told apart by it, else its name. */
  private tableKey(table: string): string {
    return this.identityKeys.get(table.toLowerCase()) ?? table;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** How the view groups the relationships; lists again when it changes. */
  setGrouping(grouping: RelationshipsGrouping): void {
    if (this.grouping === grouping) return;
    this.grouping = grouping;
    this.refresh();
  }

  getGrouping(): RelationshipsGrouping {
    return this.grouping;
  }

  /**
   * Show only the relationships `text` matches (`treeSearch` syntax: either
   * end's table, a column, a layer, the file that stores it, `is:problem`…),
   * in either grouping, under the rows they sit in; `''` shows every one
   * again. Lists again.
   */
  setFilter(text: string): void {
    const query = parseTreeQuery(text, RELATIONSHIPS_FILTER);
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

  /** The view's total beside its title (`11 relationships`); undefined when none, or before the first listing. */
  headerTotal(): string | undefined {
    const total = this.overview?.entries.length ?? 0;
    // The grouping is named in the header, so it is clear how the rows are arranged.
    return total > 0 ? `${plural(total, 'relationship')} · by ${this.grouping === 'file' ? 'file' : 'table'}` : undefined;
  }

  /** Whether the library tells tables apart by their schema folders (a library double without the flag does not). */
  private schemaScoped(): boolean {
    return (this.tableLibraryService as { schemaScopedNames?: boolean }).schemaScopedNames === true;
  }

  /**
   * Told apart by identity: every library table named by its library
   * reference (its relationships already name their other ends so), with the
   * homes and identity keys the rows look up by that reference.
   */
  private tablesByLibraryRef(): { tables: SemanticTable[]; homes: Map<string, TableHome & { name: string }>; keys: Map<string, string> } {
    const service = this.tableLibraryService;
    const tables: SemanticTable[] = [];
    const homes = new Map<string, TableHome & { name: string }>();
    const keys = new Map<string, string>();
    for (const entry of service.listTableFiles()) {
      if (entry.shadowedBy || entry.id === undefined) continue;
      const ref = service.libraryRef(entry.id) ?? entry.name;
      keys.set(ref.toLowerCase(), tableIdKey(entry.id));
      if (entry.layer !== undefined) homes.set(ref.toLowerCase(), { layer: entry.layer, schema: entry.folder, name: entry.name });
      const model = service.getTable(entry.id);
      if (model) tables.push(ref === model.name ? model : { ...model, name: ref });
    }
    return { tables, homes, keys };
  }

  /** The overview the view shows, computed afresh (reading unread table files first). */
  async loadOverview(): Promise<RelationshipsOverview> {
    await this.readUnreadTables();
    const start = Date.now();
    const service = this.tableLibraryService;
    const byRef = service.dirExists() && this.schemaScoped()
      ? (typeof service.withIndexSnapshot === 'function' ? service.withIndexSnapshot(() => this.tablesByLibraryRef()) : this.tablesByLibraryRef())
      : undefined;
    this.identityKeys = byRef?.keys ?? new Map();
    this.libraryHomes = byRef?.homes;
    const tables = byRef ? byRef.tables : service.dirExists()
      ? (typeof service.withIndexSnapshot === 'function' ? service.withIndexSnapshot(() => service.listTables()) : service.listTables())
      : [];
    // A DBML diagram holds no relationships (they live in relationships/), so this reads JSON diagrams only.
    const diagrams = readSubjectAreaRelationships(this.subjectAreaService, this.projectPath, this.semanticDir);
    const overview = buildRelationshipsOverview(tables, diagrams);
    treeLog.debug(`Listed ${plural(overview.entries.length, 'relationship')} across ${plural(overview.tables.length, 'table')} in ${elapsedMs(start)} ms`);
    return overview;
  }

  async getChildren(element?: RelationshipsNode): Promise<RelationshipsNode[]> {
    if (!element) {
      const full = await this.loadOverview();
      this.overview = full;
      this.homes = this.libraryHomes ?? this.tableHomes?.() ?? new Map();
      const query = this.filterQuery;
      // Filtered: the matching relationships, under the rows they sit in.
      const overview = query ? this.filterOverview(full, query) : full;
      this.listed = overview;
      const rows: RelationshipsNode[] = [];
      if (overview.problems.length > 0) rows.push({ type: 'attention', entries: overview.problems });
      if (this.grouping === 'file') {
        rows.push(...this.fileRows(overview));
      } else if (this.homes.size === 0) {
        for (const group of overview.tables) rows.push({ type: 'table', group });
      } else {
        rows.push(...this.layerRows(overview));
      }
      this._onDidFilter.fire(query ? { query, shown: overview.entries.length, total: full.entries.length } : undefined);
      // Nothing matches: one row that clears the filter (an empty view would show "No relationships yet").
      if (query && rows.length === 0 && full.entries.length > 0) return [{ type: 'noMatch' }];
      return rows;
    }
    if (element.type === 'layer') {
      if (element.files || element.unfiled) {
        const parentId = layerId(element.layer);
        return [
          ...(element.files ?? []),
          ...(element.unfiled ?? []).map((entry): RelationshipNode => ({
            type: 'relationship', entry, side: 'stored', parentId, ...(element.layer !== undefined ? { listedIn: element.layer } : {}),
          })),
        ];
      }
      return element.groups.map((group): RelationshipsNode => ({ type: 'table', group }));
    }
    if (element.type === 'file') {
      const parentId = fileId(element.filePath);
      return element.entries.map((entry): RelationshipNode => ({ type: 'relationship', entry, side: 'stored', parentId, listedIn: element.layer }));
    }
    if (element.type === 'attention') {
      return element.entries.map((entry) => ({ type: 'relationship', entry, side: 'problem', parentId: ATTENTION_ID }));
    }
    if (element.type === 'table') {
      const parentId = tableId(this.tableKey(element.group.table));
      return [
        ...element.group.outgoing.map((entry): RelationshipNode => ({ type: 'relationship', entry, side: 'from', parentId })),
        ...element.group.incoming.map((entry): RelationshipNode => ({ type: 'relationship', entry, side: 'to', parentId })),
      ];
    }
    return [];
  }

  /**
   * The row a table row sits under, for `TreeView.reveal` (Go to Table →
   * Show Relationships): its layer's row when the tables are grouped by
   * layer, else none (a top-level row). Grouped by file there are no table
   * rows, so nothing is revealed. Other rows are not revealed and have none.
   */
  getParent(element: RelationshipsNode): RelationshipsNode | undefined {
    const listed = this.listed ?? this.overview;
    if (element.type !== 'table' || this.grouping !== 'table' || this.homes.size === 0 || !listed) return undefined;
    const name = element.group.table.toLowerCase();
    // The layer row as the last listing showed it (filtered, its matching tables only).
    return this.layerRows(listed).find((row) => row.groups.some((g) => g.table.toLowerCase() === name));
  }

  /**
   * The part of `overview` that `query` matches: its entries, each table's
   * own matching relationships (a table with none is left out), and the
   * matching problems.
   */
  private filterOverview(overview: RelationshipsOverview, query: TreeQuery): RelationshipsOverview {
    const keep = new Set(overview.entries.filter((entry) => matchTreeQuery(query, this.entrySubject(entry, ''))));
    const kept = (entries: readonly RelationshipEntry[]): RelationshipEntry[] => entries.filter((e) => keep.has(e));
    return {
      entries: kept(overview.entries),
      tables: overview.tables
        .map((group): TableRelationships => ({ table: group.table, outgoing: kept(group.outgoing), incoming: kept(group.incoming) }))
        .filter((group) => group.outgoing.length + group.incoming.length > 0),
      problems: kept(overview.problems),
    };
  }

  /**
   * A relationship as the filter searches it, under the label `name` its row
   * shows: either end's table, its columns, both ends' layers and schemas,
   * the file that stores it (a relationships file, the FK table's own file,
   * or the diagram that keeps it) and its role; `is:problem`,
   * `is:cross-layer`, `is:composite`.
   */
  private entrySubject(entry: RelationshipEntry, name: string): SearchSubject {
    const fromHome = this.homes.get(entry.fromModel.toLowerCase());
    const toHome = this.homes.get(entry.toModel.toLowerCase());
    const at = entry.source.kind === 'library' ? this.relationshipLocation?.(entry.first) : undefined;
    const file = at
      ? path.basename(at.filePath, path.extname(at.filePath))
      : entry.source.kind === 'diagram' ? entry.source.label : entry.source.table;
    const flags: FilterFlag[] = [];
    if (entry.problems.length > 0) flags.push('problem');
    if (fromHome && toHome && fromHome.layer !== toHome.layer) flags.push('cross-layer');
    if (entry.fromColumns.length > 1) flags.push('composite');
    const layers = [fromHome?.layer, toHome?.layer].filter((l): l is string => l !== undefined);
    return {
      name,
      nameKeys: ['table'],
      facets: [
        { key: 'table', values: [entry.fromModel, entry.toModel] },
        { key: 'col', values: [...entry.fromColumns, ...entry.toColumns] },
        { key: 'layer', values: [...layers, ...layers.map((l) => this.layerLabel(l))] },
        { key: 'schema', values: [fromHome?.schema, toHome?.schema] },
        // Grouped by file, the row's parent names the file already.
        { key: 'file', values: [file], ...(this.grouping === 'table' ? { reason: (v: string) => `in ${v}` } : {}) },
        { values: [entry.role] },
      ],
      flags,
    };
  }

  /** A container row listed while filtered: a new id (so VS Code shows it expanded) and its matched label highlighted. */
  private filtered(item: vscode.TreeItem, nameKeys: readonly FilterKey[]): vscode.TreeItem {
    if (!this.filterQuery) return item;
    item.id = `${item.id}#filter${this.filterGeneration}`;
    item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    const label = typeof item.label === 'string' ? item.label : item.label?.label ?? '';
    const highlights = labelHighlights(this.filterQuery, label, nameKeys);
    if (highlights.length > 0) item.label = { label, highlights };
    return item;
  }

  /**
   * The row of the table named `name` (ignoring case), grouped by table, from
   * a fresh listing; undefined when it has no relationships (or the view is
   * grouped by file, which has no table rows).
   */
  async findTableNode(name: string): Promise<RelationshipsTableNode | undefined> {
    const wanted = name.trim().toLowerCase();
    const rows = await this.getChildren();
    if (this.grouping !== 'table') return undefined;
    const direct = rows.find((r): r is RelationshipsTableNode => r.type === 'table' && r.group.table.toLowerCase() === wanted);
    if (direct) return direct;
    for (const row of rows) {
      if (row.type !== 'layer') continue;
      const group = row.groups.find((g) => g.table.toLowerCase() === wanted);
      if (group) return { type: 'table', group };
    }
    return undefined;
  }

  /** The tables grouped by their layer, in layers.json order; tables in no layer last, under "Other tables". */
  private layerRows(overview: RelationshipsOverview): RelationshipsLayerNode[] {
    const order = this.getLayers().map((l) => l.id);
    const byLayer = new Map<string, TableRelationships[]>();
    const homeless: TableRelationships[] = [];
    for (const group of overview.tables) {
      const layer = this.homes.get(group.table.toLowerCase())?.layer;
      if (layer === undefined) homeless.push(group);
      else byLayer.set(layer, [...(byLayer.get(layer) ?? []), group]);
    }
    const rank = (id: string): number => {
      const i = order.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const count = (groups: readonly TableRelationships[]): number =>
      new Set(groups.flatMap((g) => [...g.outgoing, ...g.incoming])).size;
    const rows: RelationshipsLayerNode[] = [...byLayer.entries()]
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([layer, groups]) => ({ type: 'layer', layer, groups, relationshipCount: count(groups) }));
    if (homeless.length > 0) rows.push({ type: 'layer', groups: homeless, relationshipCount: count(homeless) });
    return rows;
  }

  /**
   * Grouped by relationships file: each layer (layers.json order) with its
   * relationships files (by name) and their Refs in file order, then the
   * relationships no file holds, under their foreign-key table's layer
   * ("Other tables" when it has none). A relationship with a problem is
   * listed (and counted) in its file too, as a table row lists it, so a
   * file's count matches the Explorer's; it is also under "Needs attention".
   */
  private fileRows(overview: RelationshipsOverview): RelationshipsLayerNode[] {
    const semanticRoot = path.join(this.projectPath, this.semanticDir);
    const files = new Map<string, { filePath: string; layer: string; entries: Array<{ entry: RelationshipEntry; line: number }> }>();
    const unfiled = new Map<string, RelationshipEntry[]>();
    const NO_LAYER = '\0';
    for (const entry of overview.entries) {
      const at = entry.source.kind === 'library' ? this.relationshipLocation?.(entry.first) : undefined;
      const layer = at ? this.layerOfRelationshipsFile(semanticRoot, at.filePath) : undefined;
      if (at && layer !== undefined) {
        const key = path.resolve(at.filePath);
        const file = files.get(key) ?? { filePath: at.filePath, layer, entries: [] };
        file.entries.push({ entry, line: at.line });
        files.set(key, file);
        continue;
      }
      const home = this.homes.get(entry.fromModel.toLowerCase())?.layer ?? NO_LAYER;
      unfiled.set(home, [...(unfiled.get(home) ?? []), entry]);
    }
    const order = this.getLayers().map((l) => l.id);
    const rank = (id: string): number => {
      if (id === NO_LAYER) return Number.MAX_SAFE_INTEGER;
      const i = order.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER - 1 : i;
    };
    const layers = new Set<string>([...[...files.values()].map((f) => f.layer), ...unfiled.keys()]);
    const stem = (p: string): string => path.basename(p, path.extname(p));
    return [...layers]
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .map((layer): RelationshipsLayerNode => {
        const own = [...files.values()]
          .filter((f) => f.layer === layer)
          .sort((a, b) => stem(a.filePath).localeCompare(stem(b.filePath)))
          .map((f): RelationshipsFileNode => ({
            type: 'file',
            filePath: f.filePath,
            layer: f.layer,
            entries: [...f.entries].sort((a, b) => a.line - b.line).map((e) => e.entry),
          }));
        const loose = unfiled.get(layer) ?? [];
        return {
          type: 'layer',
          ...(layer === NO_LAYER ? {} : { layer }),
          groups: [],
          relationshipCount: own.reduce((sum, f) => sum + f.entries.length, 0) + loose.length,
          files: own,
          unfiled: loose,
        };
      });
  }

  /** The layer of a relationships file (`<layer>/relationships/<name>.dbml`), by its path alone. */
  private layerOfRelationshipsFile(semanticRoot: string, filePath: string): string | undefined {
    const rel = path.relative(semanticRoot, filePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const kind = classifySemanticFile(rel.split(path.sep).join('/'), { tablesDirIsLayer: false });
    return kind.kind === 'relationships' ? kind.layer : undefined;
  }

  private layerLabel(id: string): string {
    return this.getLayers().find((l) => l.id === id)?.label ?? id;
  }

  getTreeItem(element: RelationshipsNode): vscode.TreeItem {
    switch (element.type) {
      case 'layer':
        return this.filtered(this.layerItem(element), ['layer']);
      case 'file':
        return this.filtered(this.fileItem(element), ['file']);
      case 'attention':
        return this.filtered(this.attentionItem(element), []);
      case 'table':
        return this.filtered(this.tableItem(element), ['table']);
      case 'relationship':
        return this.relationshipItem(element);
      case 'noMatch':
        return noMatchItem('relationships', FILTER_COMMANDS.relationships.clear);
    }
  }

  private attentionItem(element: RelationshipsAttentionNode): vscode.TreeItem {
    const item = new vscode.TreeItem('Needs attention', vscode.TreeItemCollapsibleState.Expanded);
    item.id = ATTENTION_ID;
    const count = plural(element.entries.length, 'relationship');
    item.description = this.rowDetails === 'compact' ? String(element.entries.length) : count;
    item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    item.tooltip = `Relationships that name a table or column the table library does not have. Open one to fix it.\n\n${count}`;
    item.contextValue = 'relationshipsAttention';
    return item;
  }

  private layerItem(element: RelationshipsLayerNode): vscode.TreeItem {
    if (element.files || element.unfiled) return this.fileLayerItem(element);
    const tables = plural(element.groups.length, 'table');
    const relationships = plural(element.relationshipCount, 'relationship');
    // Compact: what the row is (its counts are in the hover).
    const full = this.rowDetails === 'full';
    if (element.layer === undefined) {
      const item = new vscode.TreeItem('Other tables', vscode.TreeItemCollapsibleState.Expanded);
      item.id = layerId(undefined);
      if (full) item.description = `${tables} · ${relationships}`;
      item.iconPath = new vscode.ThemeIcon('question');
      item.tooltip = 'Tables in no layer: a table the relationships name that the table library does not have, or a table stored as YAML.' +
        `\n\n${tables} · ${relationships}`;
      item.contextValue = 'relationshipsLayer';
      return item;
    }
    const config = this.getLayers().find((l) => l.id === element.layer);
    const label = config?.label ?? element.layer;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = layerId(element.layer);
    item.description = full ? `Layer · ${tables} · ${relationships}` : 'Layer';
    item.iconPath = layerSwatchIcon(config?.color);
    item.tooltip = new vscode.MarkdownString([
      `**${label}** — a layer`,
      '',
      `The ${label} tables that have relationships, and every relationship that has an end in one of them. ` +
        'A relationship is stored once, with its foreign-key table, so one that joins two layers is listed under both.',
      '',
      `${tables} · ${relationships}`,
    ].join('\n'));
    item.contextValue = 'relationshipsLayer';
    return item;
  }

  /** A layer row while grouped by relationships file: its files and what it stores. */
  private fileLayerItem(element: RelationshipsLayerNode): vscode.TreeItem {
    const files = element.files?.length ?? 0;
    const relationships = plural(element.relationshipCount, 'relationship');
    const counts = files > 0 ? `${plural(files, 'file')} · ${relationships}` : relationships;
    const id = `${layerId(element.layer)}/files`;
    // Compact: what the row is (its counts are in the hover).
    const full = this.rowDetails === 'full';
    if (element.layer === undefined) {
      const item = new vscode.TreeItem('Other tables', vscode.TreeItemCollapsibleState.Expanded);
      item.id = id;
      if (full) item.description = relationships;
      item.iconPath = new vscode.ThemeIcon('question');
      item.tooltip = `Relationships of tables in no layer: kept with a table stored as YAML, or in a diagram file.\n\n${relationships}`;
      item.contextValue = 'relationshipsLayer';
      return item;
    }
    const config = this.getLayers().find((l) => l.id === element.layer);
    const label = config?.label ?? element.layer;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = id;
    item.description = full ? `Layer · ${counts}` : 'Layer';
    item.iconPath = layerSwatchIcon(config?.color);
    item.tooltip = new vscode.MarkdownString([
      `**${label}** — a layer`,
      '',
      `The relationships files of the ${label} layer, each with the relationships it stores. ` +
        'Each relationship is stored once, with its foreign-key table.',
      ...((element.unfiled?.length ?? 0) > 0
        ? ['', `${plural(element.unfiled!.length, 'relationship')} of its tables ${element.unfiled!.length === 1 ? 'is' : 'are'} kept with the table, not in a relationships file.`]
        : []),
      '',
      counts,
    ].join('\n'));
    item.contextValue = 'relationshipsLayer';
    return item;
  }

  /** A relationships file's row: its name, the word "Relationships file" and how many it holds. */
  private fileItem(element: RelationshipsFileNode): vscode.TreeItem {
    const name = path.basename(element.filePath, path.extname(element.filePath));
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Expanded);
    item.id = fileId(element.filePath);
    const problems = element.entries.filter((e) => e.problems.length > 0).length;
    const problemText = problems > 0 ? ` · ${plural(problems, 'problem')}` : '';
    // Compact: the count alone (its icon and hover say it is a relationships file).
    item.description = this.rowDetails === 'compact'
      ? countText(element.entries.length, problems)
      : `Relationships file · ${element.entries.length}${problemText}`;
    const md = new vscode.MarkdownString([
      `**${name}** — a relationships file of the ${this.layerLabel(element.layer)} layer`,
      '',
      `File: \`${this.shownPath(element.filePath)}\``,
      '',
      `${plural(element.entries.length, 'relationship')}${problemText}`,
    ].join('\n'));
    item.tooltip = md;
    item.iconPath = this.dbmlIcon ? this.dbmlIcon('relationships') : new vscode.ThemeIcon('references');
    item.contextValue = 'relationshipsFile';
    return item;
  }

  private tableItem(element: RelationshipsTableNode): vscode.TreeItem {
    const { group } = element;
    const item = new vscode.TreeItem(group.table, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = tableId(this.tableKey(group.table));
    const count = group.outgoing.length + group.incoming.length;
    const problems = [...group.outgoing, ...group.incoming].filter((e) => e.problems.length > 0).length;
    const counted = plural(count, 'relationship') + (problems > 0 ? ` · ${plural(problems, 'problem')}` : '');
    // Compact: the number alone (`2 · 1 problem`); the row's icon says what it counts.
    item.description = this.rowDetails === 'compact' ? countText(count, problems) : counted;
    const home = this.homes.get(group.table.toLowerCase());
    item.tooltip = [
      home ? `${home.schema}.${home.name ?? group.table} — ${this.layerLabel(home.layer)} layer` : undefined,
      counted,
      [
        group.outgoing.length > 0 ? `Points at ${plural(new Set(group.outgoing.map((e) => e.toModel.toLowerCase())).size, 'table')}` : undefined,
        group.incoming.length > 0 ? `Pointed at by ${plural(new Set(group.incoming.map((e) => e.fromModel.toLowerCase())).size, 'table')}` : undefined,
      ].filter(Boolean).join(' · '),
    ].filter(Boolean).join('\n');
    // The relationships glyph in purple, the view's own colour, so the row never reads as a Table Library table.
    item.iconPath = this.dbmlIcon
      ? this.dbmlIcon('relationships')
      : new vscode.ThemeIcon('references');
    item.contextValue = 'relationshipsTable';
    return item;
  }

  private relationshipItem(element: RelationshipNode): vscode.TreeItem {
    const { entry, side } = element;
    const problem = entry.problems[0];
    const role = entry.role ? ` · ${entry.role}` : '';
    let item: vscode.TreeItem;
    if (side === 'problem') {
      item = new vscode.TreeItem(`${entry.fromModel} → ${entry.toModel}`, vscode.TreeItemCollapsibleState.None);
      item.description = problem
        ? problem.kind === 'missingTable' ? `no table ${problem.table}` : `no column ${problem.table}.${problem.column}`
        : '';
    } else if (side === 'stored') {
      item = new vscode.TreeItem(`${entry.fromModel} → ${entry.toModel}`, vscode.TreeItemCollapsibleState.None);
      item.description = `${this.storedLayerText(element, entry)}${joinText(entry.fromColumns, entry.toColumns, '→')} · ${SHORT_CARDINALITY[cardinalityFrom(entry, 'from')]}${role}`;
    } else if (side === 'from') {
      item = new vscode.TreeItem(entry.toModel, vscode.TreeItemCollapsibleState.None);
      item.description = `${this.otherLayerText(entry.fromModel, entry.toModel)}${joinText(entry.fromColumns, entry.toColumns, '→')} · ${SHORT_CARDINALITY[cardinalityFrom(entry, 'from')]}${role}`;
    } else {
      item = new vscode.TreeItem(entry.fromModel, vscode.TreeItemCollapsibleState.None);
      item.description = `${this.otherLayerText(entry.toModel, entry.fromModel)}${joinText(entry.toColumns, entry.fromColumns, '←')} · ${SHORT_CARDINALITY[cardinalityFrom(entry, 'to')]}${role}`;
    }
    item.id = `${element.parentId}/${side}/${entryId(entry)}`;
    // Filtered: the matched part of the label highlighted, and why it matched when the row does not show it.
    const match = this.filterQuery ? matchTreeQuery(this.filterQuery, this.entrySubject(entry, typeof item.label === 'string' ? item.label : '')) : undefined;
    if (match) {
      if (match.highlights.length > 0 && typeof item.label === 'string') item.label = { label: item.label, highlights: [...match.highlights] };
      item.description = withReasons(typeof item.description === 'string' ? item.description : undefined, match.reasons);
    }
    item.iconPath = problem
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : new vscode.ThemeIcon(side === 'to' ? 'arrow-left' : side === 'stored' ? 'arrow-both' : 'arrow-right');
    item.tooltip = this.relationshipTooltip(entry);
    item.accessibilityInformation = {
      label: `${entry.fromModel} ${columnList(entry.fromColumns)} to ${entry.toModel} ${columnList(entry.toColumns)}, ${entry.cardinality.replace(/-/g, ' ')}${problem ? `, ${describeProblem(problem)}` : ''}`,
    };
    item.contextValue = 'relationship';
    // A click follows the grouping: grouped by file, it opens the file at the Ref's line;
    // grouped by table, the line on a diagram. A problem is fixed in the file either way.
    item.command = side === 'problem' || this.grouping === 'file'
      ? { command: 'erdStudio.openRelationshipSource', title: 'Open in File', arguments: [element] }
      : { command: 'erdStudio.openInDiagram', title: 'Open in Diagram', arguments: [element, { fallBackToFile: true }] };
    return item;
  }

  /**
   * `in Raw Vault · ` when `other` lives in a different layer from `mine`,
   * else nothing: first in the row's description, so a narrow sidebar still shows it.
   */
  private otherLayerText(mine: string, other: string): string {
    const a = this.homes.get(mine.toLowerCase())?.layer;
    const b = this.homes.get(other.toLowerCase())?.layer;
    return a !== undefined && b !== undefined && a !== b ? `in ${this.layerLabel(b)} · ` : '';
  }

  /**
   * For a row in its file (or its layer): `in Raw Vault · ` when an end of
   * the relationship lives in a layer other than the one it is listed under.
   */
  private storedLayerText(element: RelationshipNode, entry: RelationshipEntry): string {
    const { listedIn } = element;
    const others = [...new Set([entry.fromModel, entry.toModel]
      .map((t) => this.homes.get(t.toLowerCase())?.layer)
      .filter((l): l is string => l !== undefined && l !== listedIn))];
    return others.length > 0 ? `in ${others.map((l) => this.layerLabel(l)).join(', ')} · ` : '';
  }

  private relationshipTooltip(entry: RelationshipEntry): vscode.MarkdownString {
    const from = `${entry.fromModel}.${columnList(entry.fromColumns)}`;
    const to = `${entry.toModel}.${columnList(entry.toColumns)}`;
    const lines = [`**${from} → ${to}**`, '', `${cardinalityWords(entry.cardinality)} (${SHORT_CARDINALITY[entry.cardinality]})`];
    if (entry.role) lines.push('', `Role: ${entry.role}`);
    const fromHome = this.homes.get(entry.fromModel.toLowerCase());
    const toHome = this.homes.get(entry.toModel.toLowerCase());
    if (fromHome && toHome && fromHome.layer !== toHome.layer) {
      lines.push('', `Joins two layers: ${entry.fromModel} is in ${this.layerLabel(fromHome.layer)}, ${entry.toModel} in ${this.layerLabel(toHome.layer)}.`);
    }
    const at = entry.source.kind === 'library' ? this.relationshipLocation?.(entry.first) : undefined;
    lines.push('', entry.source.kind === 'diagram'
      ? `Kept in the diagram ${entry.source.label}`
      : at
        ? `Stored in \`${this.shownPath(at.filePath)}\` (line ${at.line}), with its foreign-key table ${entry.source.table}`
        : `Kept with the table ${entry.source.table}`);
    for (const problem of entry.problems) lines.push('', `$(warning) ${describeProblem(problem)}`);
    lines.push('', this.grouping === 'file' || entry.problems.length > 0
      ? 'Click to open it in its file; **Open in Diagram** is on the row and its right-click menu.'
      : 'Click to show it on a diagram; **Open in File** is on the row and its right-click menu.');
    const md = new vscode.MarkdownString(lines.join('\n'));
    md.supportThemeIcons = true;
    return md;
  }

  /**
   * Read the table files no render has read yet, a slice at a time, so the
   * first listing of a large library leaves the extension host responsive
   * (the view shows its progress bar meanwhile).
   */
  private async readUnreadTables(): Promise<void> {
    const service = this.tableLibraryService;
    if (typeof service.peekTableFileError !== 'function' || !service.dirExists()) return;
    // Told apart by identity, each table's own file (never its namesake's in another schema folder).
    const scoped = this.schemaScoped();
    const queue = service.listTableFiles()
      .filter((e) => !e.shadowedBy)
      .map((e) => (scoped && e.id !== undefined ? e.id : e.name))
      .filter((table) => service.peekTableFileError(table) === undefined);
    while (queue.length > 0) {
      const started = Date.now();
      while (queue.length > 0 && Date.now() - started < READ_SLICE_MS) service.getTableFileError(queue.shift()!);
      if (queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /** A file's path from the project folder, `/`-separated. */
  private shownPath(filePath: string): string {
    const rel = path.relative(this.projectPath, filePath);
    return (rel.startsWith('..') || path.isAbsolute(rel) ? path.basename(filePath) : rel).split(path.sep).join('/');
  }

  /** The overview of the last listing (undefined before the view first lists). */
  lastOverview(): RelationshipsOverview | undefined {
    return this.overview;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this._onDidFilter.dispose();
  }
}
