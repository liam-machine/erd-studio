/**
 * Finding a table across the project, from anywhere.
 *
 * - **Go to Table…** (`erdStudio.goToTable`, the palette and the Table
 *   Library's search icon; the canvas search's "Not on this diagram" hint
 *   opens it with the search filled in): every table of the project in one
 *   list. Each row names the table, then its schema, layer, warehouse name
 *   (`as orders`) and owner, then the diagrams that show it. The warehouse
 *   name and the owner come from table files already read: the list never
 *   waits for a read, and files not read yet are read after it shows, a
 *   slice at a time, filling them in. Accepting a row opens it in a diagram;
 *   its buttons open its file or show its relationships.
 * - **Add to Diagram…** (`erdStudio.addToDiagram`, the Table Library's
 *   right-click menu, several rows at once): the diagram to add the tables
 *   to, then the canvas's own Add Existing Tables edit (one edit, one undo).
 *
 * Where the library tells tables apart by their schema folders, two tables
 * of one name are two rows, each counted, read, opened and added by its own
 * file (`sidebarTables.ts`); otherwise a table is its name, as it always was.
 *
 * The lists are built by pure functions (`buildGoToTableItems`,
 * `diagramPickItems`); nothing here writes a file itself.
 */
import * as vscode from 'vscode';
import * as path from 'path';

import type { TableFileEntry } from '../services/logicalModelService';
import type { SubjectAreaSummary } from '../types/semantic';
import type { TableHome } from '../services/tableHomes';
import { normaliseName } from '../services/nameUtils';
import { pathKey } from '../services/pathKey';
import { tableUsageByName, type SidebarTable, type TableUsageKeys } from '../services/sidebarTables';
import {
  TABLE_LIBRARY_FILTER,
  isStructuredQuery,
  matchTreeQuery,
  parseTreeQuery,
  tableSearchSubject,
  type SearchSubject,
} from '../services/treeSearch';

export const GO_TO_TABLE_COMMAND = 'erdStudio.goToTable';
export const ADD_TO_DIAGRAM_COMMAND = 'erdStudio.addToDiagram';
/** The Table Library row's inline +: Add to Diagram…, to the diagram that is open (the pick only when none or several are). */
export const ADD_TO_OPEN_DIAGRAM_COMMAND = 'erdStudio.addToOpenDiagram';
export const REVEAL_IN_TABLE_LIBRARY_COMMAND = 'erdStudio.revealInTableLibrary';

/** Go to Table…'s title, and what its empty box says: it takes the sidebar's filter keys too. */
export const GO_TO_TABLE_TITLE = 'Go to Table';
export const GO_TO_TABLE_PLACEHOLDER = 'Type a table name, schema, layer, warehouse name or owner — or filter: layer:gold owner:finance col:customer_id is:unused';

/** How many diagram names a row's detail lists before "and N more". */
const DIAGRAMS_LISTED = 4;
/** How long one slice of the background read of unread table files may run. */
const READ_SLICE_MS = 40;

/** What a table file already read says about the table (never a read). */
export interface TableDetails {
  alias?: string;
  owner?: string;
  /** What the filter syntax (`type:`, `col:`, words in a description) searches. */
  description?: string;
  role?: string;
  schema?: string;
  columns?: readonly string[];
}

/** One row of Go to Table, before its buttons are attached. */
export interface GoToTableRow {
  label: string;
  description?: string;
  detail: string;
  /** The table's name, as the library lists it. */
  table: string;
  filePath: string;
}

/** Each table (lower-cased name) → the names of the diagrams that show it, in listing order. */
export function diagramUsage(
  summaries: readonly SubjectAreaSummary[],
  memberNames: (filePath: string) => string[] | null,
): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const summary of summaries) {
    let members: string[] | null = null;
    try {
      members = memberNames(summary.filePath);
    } catch {
      continue;
    }
    for (const name of new Set((members ?? []).map(normaliseName))) {
      const list = usage.get(name) ?? [];
      list.push(summary.domain);
      usage.set(name, list);
    }
  }
  return usage;
}

/** "on sales, finance", "on no diagram", "on a, b, c, d and 2 more". */
export function diagramsDetail(diagrams: readonly string[]): string {
  if (diagrams.length === 0) return 'on no diagram';
  const shown = diagrams.slice(0, DIAGRAMS_LISTED).join(', ');
  const more = diagrams.length - DIAGRAMS_LISTED;
  return `on ${shown}${more > 0 ? ` and ${more} more` : ''}`;
}

/**
 * Every table the project uses, by name: label = its name, description =
 * "schema · Layer · as alias · owner" (each part only when known), detail =
 * the diagrams that show it. A duplicate file that is ignored is left out.
 * `keyOf` is what `homes` and `usage` are keyed by (default: the name,
 * without case; told apart by identity, `TableUsageKeys.keyOf`), so two
 * tables of one name in different schema folders are two rows.
 */
export function buildGoToTableItems(input: {
  entries: readonly TableFileEntry[];
  homes: ReadonlyMap<string, TableHome>;
  usage: ReadonlyMap<string, readonly string[]>;
  layerLabel: (layer: string) => string;
  details: (name: string, filePath: string) => TableDetails | undefined;
  keyOf?: (entry: TableFileEntry) => string;
}): GoToTableRow[] {
  const rows: GoToTableRow[] = [];
  const seen = new Set<string>();
  for (const entry of input.entries) {
    if (entry.shadowedBy) continue;
    const key = input.keyOf ? input.keyOf(entry) : normaliseName(entry.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const home = input.homes.get(key);
    const details = input.details(entry.name, entry.filePath);
    const alias = details?.alias && normaliseName(details.alias) !== normaliseName(entry.name) ? details.alias : undefined;
    const parts = [
      home ? home.schema : undefined,
      home ? input.layerLabel(home.layer) : entry.folder ? input.layerLabel(entry.folder) : undefined,
      alias ? `as ${alias}` : undefined,
      details?.owner,
    ].filter((p): p is string => !!p);
    rows.push({
      label: entry.name,
      ...(parts.length > 0 ? { description: parts.join(' · ') } : {}),
      detail: diagramsDetail(input.usage.get(key) ?? []),
      table: entry.name,
      filePath: entry.filePath,
    });
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Each listed table as the sidebar filter searches it (the Table Library's
 * rules, `tableSearchSubject`), by the row's file.
 */
export function goToTableSubjects(input: {
  entries: readonly TableFileEntry[];
  homes: ReadonlyMap<string, TableHome>;
  usage: ReadonlyMap<string, readonly string[]>;
  layerLabel: (layer: string) => string;
  details: (name: string, filePath: string) => TableDetails | undefined;
  keyOf?: (entry: TableFileEntry) => string;
}): Map<string, SearchSubject> {
  const subjects = new Map<string, SearchSubject>();
  for (const entry of input.entries) {
    if (entry.shadowedBy || subjects.has(entry.filePath)) continue;
    const key = input.keyOf ? input.keyOf(entry) : normaliseName(entry.name);
    const home = input.homes.get(key);
    const details = input.details(entry.name, entry.filePath);
    const layer = home?.layer ?? (entry.folder || undefined);
    const schema = home?.schema ?? details?.schema;
    subjects.set(entry.filePath, tableSearchSubject({
      name: entry.name,
      ...(details?.alias ? { alias: details.alias } : {}),
      ...(schema ? { schema } : {}),
      ...(layer ? { layer, layerLabel: input.layerLabel(layer) } : {}),
      ...(details?.owner ? { owner: details.owner } : {}),
      ...(details?.role ? { role: details.role } : {}),
      ...(details?.description ? { description: details.description } : {}),
      ...(details?.columns ? { columns: details.columns } : {}),
      diagrams: input.usage.get(key) ?? [],
    }));
  }
  return subjects;
}

export interface GoToTableDeps {
  listTableFiles(): TableFileEntry[];
  /** Each table's home, keyed as {@link usage} keys a table (by default: its name, without case). */
  tableHomes(): ReadonlyMap<string, TableHome>;
  listSubjectAreas(): SubjectAreaSummary[];
  memberNames(filePath: string): string[] | null;
  /**
   * How tables and diagram members are matched (`tableUsageOf`). Optional:
   * without it, by name through `memberNames`. Told apart by identity, every
   * call below that names a table is also given its file.
   */
  usage?(): TableUsageKeys;
  layerLabel(layer: string): string;
  /** A table's details from a file already read; undefined when the file has not been read yet. */
  peekDetails(name: string, filePath?: string): TableDetails | undefined;
  /** Read a table's file (the background fill). Optional: without it unread rows stay as they are. */
  readDetails?(name: string, filePath?: string): TableDetails | undefined;
  openInDiagram(name: string, filePath?: string): Promise<void>;
  openFile(filePath: string): Promise<void>;
  showRelationships(name: string, filePath?: string): Promise<void>;
  /** Tests pass their own; the default is `vscode.window.createQuickPick`. */
  createQuickPick?: () => vscode.QuickPick<GoToTableItem>;
}

export interface GoToTableItem extends vscode.QuickPickItem {
  table: string;
  filePath: string;
}

export const OPEN_IN_DIAGRAM_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('open-preview'), tooltip: 'Open in Diagram' };
export const OPEN_FILE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: 'Open File' };
export const SHOW_RELATIONSHIPS_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('references'), tooltip: 'Show Relationships' };

function withButtons(row: GoToTableRow): GoToTableItem {
  return { ...row, buttons: [OPEN_IN_DIAGRAM_BUTTON, OPEN_FILE_BUTTON, SHOW_RELATIONSHIPS_BUTTON] };
}

/**
 * Go to Table…: the list, with `query` typed in (the canvas search's hint).
 * Resolves once the list has closed and the chosen action has finished.
 */
export async function goToTableCommand(deps: GoToTableDeps, query?: string): Promise<void> {
  const entries = deps.listTableFiles();
  const usageKeys = deps.usage?.() ?? tableUsageByName(deps.memberNames);
  // Told apart by identity, a table is named by its file too (two schema folders may share its name).
  const byFile = usageKeys.byIdentity;
  const unread = new Map<string, SidebarTable>();
  const details = new Map<string, TableDetails | undefined>();
  const detailKey = (name: string, filePath: string): string => (byFile ? filePath : name);
  const detailsOf = (name: string, filePath: string): TableDetails | undefined => {
    const key = detailKey(name, filePath);
    if (details.has(key)) return details.get(key);
    const known = byFile ? deps.peekDetails(name, filePath) : deps.peekDetails(name);
    if (known === undefined) unread.set(key, { name, filePath });
    return known;
  };
  // The rows, and each row's table as the filter syntax searches it.
  let subjects = new Map<string, SearchSubject>();
  const build = (): GoToTableItem[] => {
    const input = {
      entries,
      homes: deps.tableHomes(),
      usage: diagramUsage(deps.listSubjectAreas(), (p) => usageKeys.membersOf(p)),
      layerLabel: deps.layerLabel,
      details: detailsOf,
      ...(byFile ? { keyOf: (entry: TableFileEntry) => usageKeys.keyOf({ name: entry.name, filePath: entry.filePath }) } : {}),
    };
    subjects = goToTableSubjects(input);
    return buildGoToTableItems(input).map(withButtons);
  };
  let items = build();
  if (items.length === 0) {
    void vscode.window.showInformationMessage('ERD Studio: This project has no tables yet. Open a diagram and use + Add → New Table to make one.');
    return;
  }

  const quickPick = (deps.createQuickPick ?? (() => vscode.window.createQuickPick<GoToTableItem>()))();
  quickPick.title = GO_TO_TABLE_TITLE;
  quickPick.placeholder = GO_TO_TABLE_PLACEHOLDER;
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.items = items;
  if (query) quickPick.value = query;

  // One plain word is the QuickPick's own (fuzzy) matching; anything more —
  // a key (`layer:gold`), a phrase, `-word`, several words — is matched here
  // with the sidebar's rules, and the rows it keeps always show.
  let structured = false;
  const applyQuery = (value: string): void => {
    const parsed = parseTreeQuery(value, TABLE_LIBRARY_FILTER);
    quickPick.title = parsed.warnings.length > 0 ? `${GO_TO_TABLE_TITLE} · ${parsed.warnings.join(' · ')}` : GO_TO_TABLE_TITLE;
    if (!isStructuredQuery(parsed)) {
      if (structured) quickPick.items = items;
      structured = false;
      return;
    }
    structured = true;
    quickPick.items = items
      .filter((item) => {
        const subject = subjects.get(item.filePath);
        return subject !== undefined && matchTreeQuery(parsed, subject) !== undefined;
      })
      .map((item) => ({ ...item, alwaysShow: true }));
  };
  if (query) applyQuery(query);

  let action: Promise<void> | undefined;
  let closed = false;
  let fill: ReturnType<typeof setTimeout> | undefined;
  const run = (fn: () => Promise<void>): void => {
    action = fn().catch((err: unknown) => {
      void vscode.window.showErrorMessage(`Go to Table: ${err instanceof Error ? err.message : String(err)}`);
    });
    quickPick.hide();
  };

  // The rows whose files were not read yet: read a slice at a time once the
  // list shows, and list again when one of them has something to add.
  const readUnread = (): void => {
    fill = undefined;
    if (closed || !deps.readDetails || unread.size === 0) return;
    const started = Date.now();
    let found = false;
    for (const [key, table] of Array.from(unread)) {
      if (Date.now() - started > READ_SLICE_MS) break;
      unread.delete(key);
      const read = byFile ? deps.readDetails(table.name, table.filePath) : deps.readDetails(table.name);
      details.set(key, read);
      // A filter (`col:`, `type:`…) can match a table once its file is read.
      if (read?.alias || read?.owner || (structured && read)) found = true;
    }
    if (found && !closed) {
      const active = quickPick.activeItems[0]?.filePath;
      items = build();
      if (structured) applyQuery(quickPick.value);
      else quickPick.items = items;
      const again = active ? quickPick.items.find((i) => i.filePath === active) : undefined;
      if (again) quickPick.activeItems = [again];
    }
    if (unread.size > 0) fill = setTimeout(readUnread, 0);
  };

  const openInDiagram = (item: GoToTableItem): Promise<void> =>
    (byFile ? deps.openInDiagram(item.table, item.filePath) : deps.openInDiagram(item.table));
  await new Promise<void>((resolve) => {
    quickPick.onDidChangeValue(applyQuery);
    quickPick.onDidAccept(() => {
      const picked = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
      if (picked) run(() => openInDiagram(picked));
    });
    quickPick.onDidTriggerItemButton((event) => {
      const item = event.item;
      if (event.button === OPEN_FILE_BUTTON) run(() => deps.openFile(item.filePath));
      else if (event.button === SHOW_RELATIONSHIPS_BUTTON) run(() => (byFile ? deps.showRelationships(item.table, item.filePath) : deps.showRelationships(item.table)));
      else run(() => openInDiagram(item));
    });
    quickPick.onDidHide(() => {
      closed = true;
      if (fill !== undefined) clearTimeout(fill);
      void Promise.resolve(action).then(() => {
        quickPick.dispose();
        resolve();
      });
    });
    quickPick.show();
    if (unread.size > 0 && deps.readDetails) fill = setTimeout(readUnread, 0);
  });
}

// ---------------------------------------------------------------------------
// Add to Diagram…
// ---------------------------------------------------------------------------

export interface DiagramPickItem extends vscode.QuickPickItem {
  summary: SubjectAreaSummary;
  /** The picked tables this diagram shows already (each once). */
  alreadyShown?: string[];
}

/**
 * The diagrams `tables` can be added to: every diagram but those that show
 * all of them already, each with its layer and table count ("Gold · 6
 * tables"), and a note naming the picked tables it already shows. `usage`
 * says which table a diagram's member is (default: by name, through
 * `memberNames`).
 */
export function diagramPickItems(
  summaries: readonly SubjectAreaSummary[],
  memberNames: (filePath: string) => string[] | null,
  layerLabel: (layer: string) => string,
  tables: ReadonlyArray<string | SidebarTable>,
  usage: TableUsageKeys = tableUsageByName(memberNames),
): DiagramPickItem[] {
  const wanted = [...new Map(tables.map((t) => [usage.keyOf(t), typeof t === 'string' ? t : t.name])).entries()];
  // A JSON diagram names tables by name alone, and a name two schema folders share reads the library's
  // first table of it: it cannot show any other table of that name (owner decision F), so it is not offered.
  const notByName = usage.byIdentity && tables.some((t) => typeof t !== 'string' && usage.keyOf(t.name) !== usage.keyOf(t));
  const items: DiagramPickItem[] = [];
  for (const summary of summaries) {
    if (notByName && summary.storage !== 'dbml' && !summary.filePath.toLowerCase().endsWith('.dbml')) continue;
    // By name, the diagram's member names as listed (a count of them); by identity, the tables they read.
    let members: string[] | null = null;
    try {
      members = usage.byIdentity ? usage.membersOf(summary.filePath) : memberNames(summary.filePath);
    } catch {
      members = null;
    }
    const have = new Set(usage.byIdentity ? members ?? [] : (members ?? []).map(normaliseName));
    const already = wanted.filter(([key]) => have.has(key)).map(([, name]) => name);
    if (wanted.length > 0 && already.length === wanted.length) continue;
    const count = members ? ` · ${members.length} ${members.length === 1 ? 'table' : 'tables'}` : '';
    items.push({
      label: summary.domain,
      description: `${layerLabel(summary.layer)}${count}`,
      ...(already.length > 0 ? { detail: `Already shows ${already.join(', ')}`, alreadyShown: already } : {}),
      summary,
    });
  }
  return items;
}

/** The table names a Table Library right-click names: the selection when it holds the clicked row, else that row. */
export function tablesFromTreeArgs(arg: unknown, selection: unknown): string[] {
  const names = tableRowsFromTreeArgs(arg, selection).map((t) => t.name);
  return Array.isArray(arg) ? names : [...new Set(names)];
}

/**
 * The tables a Table Library right-click names, each with its file: the
 * selection when it holds the clicked row, else that row; each file once.
 * Two rows of one name (two schema folders) are two tables.
 */
export function tableRowsFromTreeArgs(arg: unknown, selection: unknown): SidebarTable[] {
  const tableOf = (item: unknown): SidebarTable | undefined => {
    if (typeof item === 'string') return { name: item };
    if (!item || typeof item !== 'object') return undefined;
    const node = item as { type?: unknown; name?: unknown; filePath?: unknown; shadowedBy?: unknown };
    if (node.type !== 'model' || typeof node.name !== 'string' || node.shadowedBy) return undefined;
    return { name: node.name, ...(typeof node.filePath === 'string' ? { filePath: node.filePath } : {}) };
  };
  if (Array.isArray(arg)) return arg.map(tableOf).filter((t): t is SidebarTable => !!t);
  const selected = Array.isArray(selection) ? selection : [];
  const rows = (selected.includes(arg) ? selected : [arg]).map(tableOf).filter((t): t is SidebarTable => !!t);
  const seen = new Set<string>();
  return rows.filter((t) => {
    const key = t.filePath !== undefined ? pathKey(t.filePath) : `name:${t.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface AddToDiagramDeps {
  listSubjectAreas(): SubjectAreaSummary[];
  memberNames(filePath: string): string[] | null;
  /** How tables and diagram members are matched (`tableUsageOf`). Optional: without it, by name through `memberNames`. */
  usage?(): TableUsageKeys;
  layerLabel(layer: string): string;
  /**
   * Open the diagram, add the tables in one edit and select the first
   * (`SemanticEditorProvider.addTablesToDiagram`). `files`, index for index
   * with `tables`, is given only where tables are told apart by identity.
   */
  addTables(filePath: string, tables: readonly string[], files?: readonly string[]): Promise<void>;
  /** The file of the diagram in the active editor tab, if that tab is a diagram: it is offered first. */
  activeDiagramPath?(): string | undefined;
  /**
   * The files of the diagrams on screen: each editor group's active tab that
   * is a diagram (`openDiagramPaths`). With no diagram in the active tab and
   * exactly one of these, the tables are added there without asking.
   */
  openDiagramPaths?(): string[];
}

/**
 * The diagram Add to Diagram… adds to without asking: the one in the active
 * tab, else the only diagram on screen. Undefined when there is none, or
 * several are on screen and none is active (the pick decides), or it is not
 * one of `summaries` (a diagram outside the project's layers).
 */
export function diagramToAddTo(
  summaries: readonly SubjectAreaSummary[],
  activePath: string | undefined,
  openPaths: readonly string[],
): SubjectAreaSummary | undefined {
  const find = (p: string): SubjectAreaSummary | undefined => summaries.find((s) => pathKey(s.filePath) === pathKey(p));
  if (activePath !== undefined) {
    const active = find(activePath);
    if (active) return active;
  }
  const onScreen = [...new Map(openPaths.map((p) => [pathKey(p), p])).values()];
  return onScreen.length === 1 ? find(onScreen[0]) : undefined;
}

/** What the status bar says after Add to Diagram… added without asking. */
export function addedToDiagramStatus(subject: string, diagram: string): string {
  return `$(check) ERD Studio: Added ${subject} to ${diagram}`;
}

/** How long that status bar message stays. */
export const ADDED_TO_DIAGRAM_STATUS_MS = 6000;

/** What the pick says beside the diagram in the active tab. */
export const OPEN_DIAGRAM_NOTE = 'open now';

/**
 * `items` with the diagram of the active tab first, marked
 * {@link OPEN_DIAGRAM_NOTE} (so Enter adds to the diagram in front of the
 * user); unchanged when no diagram is active or it is not among them (it
 * shows the tables already). Paths are compared as the file system does.
 */
export function withOpenDiagramFirst(items: readonly DiagramPickItem[], activePath: string | undefined): DiagramPickItem[] {
  const index = activePath === undefined ? -1 : items.findIndex((item) => pathKey(item.summary.filePath) === pathKey(activePath));
  if (index < 0) return [...items];
  const open = items[index];
  return [
    { ...open, description: open.description ? `${open.description} · ${OPEN_DIAGRAM_NOTE}` : OPEN_DIAGRAM_NOTE },
    ...items.slice(0, index),
    ...items.slice(index + 1),
  ];
}

/**
 * Add to Diagram… (and the row's inline +, Add to Open Diagram): with a
 * diagram open — in the active tab, or the only one on screen — the tables
 * go straight to it, and the status bar says where (tables it shows already
 * are selected and named on its canvas). Otherwise, which diagram (the one in
 * the active tab first), then the add. The route that needs no drag: it
 * works from the Table Library's right-click menu and inline + on one table
 * or a selection. Where the library tells tables apart by identity, each
 * table is its file: a diagram that shows another schema folder's table of
 * the name does not show this one, and the add is by file.
 */
export async function addToDiagramCommand(deps: AddToDiagramDeps, given: ReadonlyArray<string | SidebarTable>): Promise<void> {
  const usage = deps.usage?.() ?? tableUsageByName(deps.memberNames);
  const picked = given.map((t) => usage.tableOf(t));
  const tables = picked.map((t) => t.name);
  if (tables.length === 0) {
    void vscode.window.showErrorMessage('Add to Diagram: No table selected. Right-click a table in the Table Library.');
    return;
  }
  const subject = tables.length === 1 ? `"${tables[0]}"` : `${tables.length} tables`;
  const summaries = deps.listSubjectAreas();
  if (summaries.length === 0) {
    void vscode.window.showInformationMessage('ERD Studio: This project has no diagram yet. Make one with New Diagram…, then add the tables to it.');
    return;
  }
  const files = picked.map((t) => t.filePath);
  const add = (filePath: string): Promise<void> =>
    usage.byIdentity && files.every((f): f is string => f !== undefined) ? deps.addTables(filePath, tables, files) : deps.addTables(filePath, tables);
  const activePath = deps.activeDiagramPath?.();
  const open = diagramToAddTo(summaries, activePath, deps.openDiagramPaths?.() ?? []);
  if (open) {
    // Added without asking. Not offered means it shows them all already, or cannot show them (a JSON diagram and a
    // name two schema folders share): its canvas says which, so the status bar names only what is added.
    const offered = diagramPickItems([open], deps.memberNames, deps.layerLabel, picked, usage)[0];
    await add(open.filePath);
    if (offered) {
      const already = new Set(offered.alreadyShown ?? []);
      const fresh = [...new Set(tables)].filter((t) => !already.has(t));
      const what = fresh.length === 1 ? `"${fresh[0]}"` : `${fresh.length} tables`;
      vscode.window.setStatusBarMessage(addedToDiagramStatus(what, open.domain), ADDED_TO_DIAGRAM_STATUS_MS);
    }
    return;
  }
  const items = withOpenDiagramFirst(diagramPickItems(summaries, deps.memberNames, deps.layerLabel, picked, usage), activePath);
  if (items.length === 0) {
    void vscode.window.showInformationMessage(`ERD Studio: Every diagram already shows ${subject}.`);
    return;
  }
  const pick = await vscode.window.showQuickPick(items, {
    title: `Add ${subject} to a Diagram`,
    placeHolder: `Add ${subject} to which diagram?`,
    matchOnDescription: true,
  });
  if (!pick) return;
  await add(pick.summary.filePath);
}

/** A path from the project folder, with forward slashes (`.erd-studio/gold/tables/sales/fct_order.dbml`). */
export function projectRelativePath(workspaceRoot: string, filePath: string): string {
  const rel = path.relative(workspaceRoot, filePath);
  return (rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : filePath).split(path.sep).join('/');
}
