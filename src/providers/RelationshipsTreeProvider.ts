/**
 * RelationshipsTreeProvider — the sidebar's Relationships view.
 *
 * Every relationship in the project, grouped by table: under each table, the
 * tables it points at (→, it holds the foreign key) and the tables that point
 * at it (←), read from that table's side. Relationships that name a table or
 * column the library does not have are gathered first under "Needs attention".
 * Clicking a relationship opens where it is written: the Ref's line in a DBML
 * relationships file, the FK table's YAML file, or the diagram that holds it.
 *
 * Read-only, like every view here. The data is {@link buildRelationshipsOverview}
 * over the library's tables (and, for a YAML/JSON project, the relationships
 * still kept in diagram files); table files never read yet are read first, a
 * slice at a time, so a large library never blocks the extension host.
 */

import * as vscode from 'vscode';

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
import { createLogger, elapsedMs, plural } from '../services/logger';

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

export interface RelationshipsTableNode {
  readonly type: 'table';
  readonly group: TableRelationships;
}

export interface RelationshipNode {
  readonly type: 'relationship';
  readonly entry: RelationshipEntry;
  /** Read from the FK table (`from`, →), from the referenced table (`to`, ←), or listed as a problem. */
  readonly side: 'from' | 'to' | 'problem';
  /** The parent row's id, so the same relationship under two tables has two ids. */
  readonly parentId: string;
}

export type RelationshipsNode = RelationshipsAttentionNode | RelationshipsTableNode | RelationshipNode;

const ATTENTION_ID = 'erdStudio.relationships.attention';
const tableId = (name: string): string => `erdStudio.relationships.table:${name.toLowerCase()}`;

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

  constructor(
    private readonly tableLibraryService: TableLibraryService,
    private readonly subjectAreaService: SubjectAreaService,
    private readonly projectPath: string,
    private readonly semanticDir: string,
    /** The DBML Table icon for tables stored as DBML (`dbmlFileIcon`). Optional. */
    private readonly dbmlIcon?: DbmlFileIconResolver,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** The overview the view shows, computed afresh (reading unread table files first). */
  async loadOverview(): Promise<RelationshipsOverview> {
    await this.readUnreadTables();
    const start = Date.now();
    const service = this.tableLibraryService;
    const tables = service.dirExists()
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
      const overview = await this.loadOverview();
      this.overview = overview;
      const rows: RelationshipsNode[] = [];
      if (overview.problems.length > 0) rows.push({ type: 'attention', entries: overview.problems });
      for (const group of overview.tables) rows.push({ type: 'table', group });
      return rows;
    }
    if (element.type === 'attention') {
      return element.entries.map((entry) => ({ type: 'relationship', entry, side: 'problem', parentId: ATTENTION_ID }));
    }
    if (element.type === 'table') {
      const parentId = tableId(element.group.table);
      return [
        ...element.group.outgoing.map((entry): RelationshipNode => ({ type: 'relationship', entry, side: 'from', parentId })),
        ...element.group.incoming.map((entry): RelationshipNode => ({ type: 'relationship', entry, side: 'to', parentId })),
      ];
    }
    return [];
  }

  getTreeItem(element: RelationshipsNode): vscode.TreeItem {
    switch (element.type) {
      case 'attention':
        return this.attentionItem(element);
      case 'table':
        return this.tableItem(element);
      case 'relationship':
        return this.relationshipItem(element);
    }
  }

  private attentionItem(element: RelationshipsAttentionNode): vscode.TreeItem {
    const item = new vscode.TreeItem('Needs attention', vscode.TreeItemCollapsibleState.Expanded);
    item.id = ATTENTION_ID;
    item.description = plural(element.entries.length, 'relationship');
    item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    item.tooltip = 'Relationships that name a table or column the table library does not have. Open one to fix it.';
    item.contextValue = 'relationshipsAttention';
    return item;
  }

  private tableItem(element: RelationshipsTableNode): vscode.TreeItem {
    const { group } = element;
    const item = new vscode.TreeItem(group.table, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = tableId(group.table);
    const count = group.outgoing.length + group.incoming.length;
    const problems = [...group.outgoing, ...group.incoming].filter((e) => e.problems.length > 0).length;
    item.description = plural(count, 'relationship') + (problems > 0 ? ` · ${plural(problems, 'problem')}` : '');
    item.tooltip = [
      group.outgoing.length > 0 ? `Points at ${plural(new Set(group.outgoing.map((e) => e.toModel.toLowerCase())).size, 'table')}` : undefined,
      group.incoming.length > 0 ? `Pointed at by ${plural(new Set(group.incoming.map((e) => e.fromModel.toLowerCase())).size, 'table')}` : undefined,
    ].filter(Boolean).join(' · ');
    const dbml = this.dbmlIcon && typeof this.tableLibraryService.tableStorage === 'function'
      && this.tableLibraryService.tableStorage(group.table) === 'dbml';
    item.iconPath = dbml ? this.dbmlIcon!('table') : new vscode.ThemeIcon('symbol-class');
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
    } else if (side === 'from') {
      item = new vscode.TreeItem(entry.toModel, vscode.TreeItemCollapsibleState.None);
      item.description = `${joinText(entry.fromColumns, entry.toColumns, '→')} · ${SHORT_CARDINALITY[cardinalityFrom(entry, 'from')]}${role}`;
    } else {
      item = new vscode.TreeItem(entry.fromModel, vscode.TreeItemCollapsibleState.None);
      item.description = `${joinText(entry.toColumns, entry.fromColumns, '←')} · ${SHORT_CARDINALITY[cardinalityFrom(entry, 'to')]}${role}`;
    }
    item.id = `${element.parentId}/${side}/${entryId(entry)}`;
    item.iconPath = problem
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : new vscode.ThemeIcon(side === 'to' ? 'arrow-left' : 'arrow-right');
    item.tooltip = this.relationshipTooltip(entry);
    item.accessibilityInformation = {
      label: `${entry.fromModel} ${columnList(entry.fromColumns)} to ${entry.toModel} ${columnList(entry.toColumns)}, ${entry.cardinality.replace(/-/g, ' ')}${problem ? `, ${describeProblem(problem)}` : ''}`,
    };
    item.contextValue = 'relationship';
    // A problem is fixed in the file; any other row shows the line on a diagram.
    item.command = side === 'problem'
      ? { command: 'erdStudio.openRelationshipSource', title: 'Open in File', arguments: [element] }
      : { command: 'erdStudio.openInDiagram', title: 'Open in Diagram', arguments: [element, { fallBackToFile: true }] };
    return item;
  }

  private relationshipTooltip(entry: RelationshipEntry): vscode.MarkdownString {
    const from = `${entry.fromModel}.${columnList(entry.fromColumns)}`;
    const to = `${entry.toModel}.${columnList(entry.toColumns)}`;
    const lines = [`**${from} → ${to}**`, '', `${cardinalityWords(entry.cardinality)} (${SHORT_CARDINALITY[entry.cardinality]})`];
    if (entry.role) lines.push('', `Role: ${entry.role}`);
    lines.push('', entry.source.kind === 'diagram'
      ? `Kept in the diagram ${entry.source.label}`
      : `Kept with the table ${entry.source.table}`);
    for (const problem of entry.problems) lines.push('', `$(warning) ${describeProblem(problem)}`);
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
    const queue = service.listTableFiles()
      .filter((e) => !e.shadowedBy && service.peekTableFileError(e.name) === undefined)
      .map((e) => e.name);
    while (queue.length > 0) {
      const started = Date.now();
      while (queue.length > 0 && Date.now() - started < READ_SLICE_MS) service.getTableFileError(queue.shift()!);
      if (queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /** The overview of the last listing (undefined before the view first lists). */
  lastOverview(): RelationshipsOverview | undefined {
    return this.overview;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
