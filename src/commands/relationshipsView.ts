/**
 * The sidebar's "take me there" actions, for the Relationships view and the
 * Table Library.
 *
 * A row's click goes to the diagram: a Table Library table, and a
 * relationship grouped by table, follow `sidebarRowClick.ts`'s rule (the
 * diagram the user is looking at, else the only one, else a pick, else the
 * file); a relationship grouped by file, and a row with a problem, open the
 * file. A double-click opens the file. The row's hover button and its
 * right-click menu offer the other way.
 *
 * - **Open in Diagram…** (`erdStudio.openInDiagram`): the diagram that shows a
 *   relationship's two tables (or a table row's table, here or in the Table
 *   Library), picked when there are several (the picker's last item opens the
 *   relationship's file instead), with the line selected (`revealRelationship`).
 *   From the sidebar (`highlight`) the diagram in front of the user is used
 *   without asking, and the table or line is selected without a zoom or the
 *   detail panel (`gentle`); the canvas's own Show on Other Diagrams… and Go
 *   to Table… keep centring it with its panel open.
 * - **Open in File** (`erdStudio.openRelationshipSource`): a DBML Ref at its
 *   line in the relationships file, a YAML table's `relationships:` entry in
 *   the FK table's file, or the diagram that keeps it (YAML/JSON projects).
 * - **Open File** (`erdStudio.openTableFile`, {@link openTableFile}): a table's file.
 *
 * Where the library tells tables apart by their schema folders, a table is
 * the file it lives in (`sidebarTables.ts`): the diagrams that show it are
 * those whose `use` lines read that file, and each is told the table (and
 * the line's ends) by what that diagram calls it.
 *
 * Both only open files; nothing here writes.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import type { RelationshipEntry } from '../services/relationshipsOverview';
import type { RevealRelationshipMessage } from '../types/messages';
import type { SubjectAreaSummary } from '../types/semantic';
import type { RelationshipsNode } from '../providers/RelationshipsTreeProvider';
import type { TableLibraryTableNode } from '../providers/ModelLibraryTreeProvider';
import { normaliseName } from '../services/nameUtils';
import { tableUsageByName, type SidebarTable, type TableUsageKeys } from '../services/sidebarTables';
import { chooseDiagram } from './sidebarRowClick';

export interface RelationshipsViewDeps {
  /** The DBML Ref's file and line, when a relationships file holds it. */
  relationshipLocation(rel: RelationshipEntry['first']): { filePath: string; line: number } | undefined;
  /** The table file of a library table (null when it has none). */
  findTableFile(name: string): string | null;
  listSubjectAreas(): SubjectAreaSummary[];
  /** A diagram's member table names (null when it cannot be read). */
  memberNames(filePath: string): string[] | null;
  /** How tables and diagram members are matched (`tableUsageOf`). Optional: without it, by name through `memberNames`. */
  usage?(): TableUsageKeys;
  layerLabel(layer: string): string;
  /**
   * Select the line on the diagram at `filePath`, once it is open
   * (`SemanticEditorProvider.revealRelationship`): centred, or with
   * `target.gentle` brought into view at the zoom the user has.
   */
  revealRelationship(filePath: string, target: RevealRelationshipMessage['payload']): Promise<void>;
  /**
   * Select a table on the diagram at `filePath`, once it is open
   * (`SemanticEditorProvider.revealTable`): centred with its detail panel, or
   * `gentle`: brought into view at the zoom the user has, no panel. Optional.
   */
  revealTable?(filePath: string, modelName: string, options?: { gentle?: boolean }): Promise<void>;
  /**
   * The diagram the user is looking at: the active editor when it is a
   * diagram, else the diagram editor last active while it is still open and
   * on screen. Optional: without it a click never highlights in place.
   */
  lookingAtDiagram?(): string | undefined;
  /** Add to Diagram… for `tables` (`erdStudio.addToDiagram`), offered when no diagram shows them. Optional: without it the message only says so. */
  addToDiagram?(tables: ReadonlyArray<string | SidebarTable>): Promise<void>;
}

/** The button a "No diagram shows …" message offers. */
export const ADD_TO_DIAGRAM = 'Add to Diagram…';

/** What the canvas needs to find a relationship's line: its tables and every column pair. */
export function revealTarget(entry: RelationshipEntry): RevealRelationshipMessage['payload'] {
  return {
    fromModel: entry.fromModel,
    toModel: entry.toModel,
    pairs: entry.fromColumns.map((fromColumn, i) => ({ fromColumn, toColumn: entry.toColumns[i] ?? '' })),
  };
}

/**
 * The 1-based line of `entry`'s item in a YAML table file's `relationships:`
 * list: the first line after `relationships:` that names the other table,
 * else the `relationships:` line itself, else undefined.
 */
export function relationshipLineInYaml(text: string, otherTable: string): number | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*relationships\s*:/.test(l));
  if (start === -1) return undefined;
  const indent = /^\s*/.exec(lines[start])![0].length;
  const name = otherTable.toLowerCase();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // Left the list: a key at the same or a shallower indent.
    if (/\S/.test(line) && !/^\s*-/.test(line) && /^\s*/.exec(line)![0].length <= indent && !/^\s*#/.test(line)) break;
    const value = /:\s*['"]?([^'"#\s]+)/.exec(line)?.[1];
    if (value !== undefined && value.toLowerCase() === name) return i + 1;
  }
  return start + 1;
}

async function openAt(filePath: string, line?: number): Promise<void> {
  const at = new vscode.Position(line !== undefined && line >= 1 ? line - 1 : 0, 0);
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), { selection: new vscode.Range(at, at), preview: true });
}

/**
 * Open a Table Library table's file (its row's Open File, and its
 * double-click). `pinned`: a double-click keeps the tab, as the Explorer's does.
 */
export async function openTableFile(node: unknown, options: { pinned?: boolean } = {}): Promise<void> {
  const filePath = typeof node === 'object' && node !== null && (node as { type?: unknown }).type === 'model'
    ? (node as { filePath?: unknown }).filePath
    : undefined;
  if (typeof filePath !== 'string' || filePath === '') {
    void vscode.window.showErrorMessage('Open File: No table selected. Right-click a table in the Table Library.');
    return;
  }
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), ...(options.pinned ? [{ preview: false }] : []));
}

/** The status-bar line when a row's click opens the file because no diagram shows it (relationships say the same). */
export function noDiagramYetMessage(subject: string, what: 'relationship' | 'table'): string {
  return what === 'relationship'
    ? `ERD Studio: No diagram shows ${subject} yet, so this is where the relationship is written.`
    : `ERD Studio: No diagram shows ${subject} yet, so this is the table's file.`;
}

/** Open where a relationship row's relationship is written. */
export async function openRelationshipSource(node: RelationshipsNode | undefined, deps: RelationshipsViewDeps): Promise<void> {
  if (!node || node.type !== 'relationship') return;
  const { entry } = node;
  if (entry.source.kind === 'diagram') {
    await vscode.commands.executeCommand('erdStudio.openDomain', entry.source.filePath);
    return;
  }
  const ref = deps.relationshipLocation(entry.first);
  if (ref) {
    await openAt(ref.filePath, ref.line);
    return;
  }
  // A YAML table keeps its relationships in its own file.
  const owner = entry.source.table;
  const file = deps.findTableFile(owner);
  if (!file) {
    void vscode.window.showWarningMessage(`ERD Studio: The table "${owner}" has no file in the table library, so this relationship can't be opened.`);
    return;
  }
  let line: number | undefined;
  try {
    const other = normaliseName(entry.fromModel) === normaliseName(owner) ? entry.toModel : entry.fromModel;
    line = relationshipLineInYaml(fs.readFileSync(file, 'utf-8'), other);
  } catch {
    // Opened at the top.
  }
  await openAt(file, line);
}

/** The diagrams whose members include every one of `tables` (matched as `deps.usage` says; by default by name). */
export function diagramsShowing(
  tables: ReadonlyArray<string | SidebarTable>,
  deps: Pick<RelationshipsViewDeps, 'listSubjectAreas' | 'memberNames' | 'usage'>,
): SubjectAreaSummary[] {
  const usage = deps.usage?.() ?? tableUsageByName(deps.memberNames);
  const wanted = [...new Set(tables.map((t) => usage.keyOf(t)))];
  return deps.listSubjectAreas().filter((summary) => {
    let members: string[] | null = null;
    try {
      members = usage.membersOf(summary.filePath);
    } catch {
      return false;
    }
    if (!members) return false;
    const have = new Set(members);
    return wanted.every((t) => have.has(t));
  });
}

/** How {@link openInDiagram} goes about it. */
export interface OpenInDiagramOptions {
  /**
   * With no diagram to show it on, open where it is written (a relationship)
   * or the table's file (a table): a row's click.
   */
  fallBackToFile?: boolean;
  /** Leave this diagram out (the canvas's Show on Other Diagrams…, the row's Show on Another Diagram…). */
  excludeDiagram?: string;
  /**
   * From the sidebar: the diagram the user is looking at
   * (`deps.lookingAtDiagram`) is used without asking when it shows it, and
   * the table or line is selected gently (no zoom, no detail panel), on the
   * diagram already open or on the one opened.
   */
  highlight?: boolean;
  /** Cancelled by a double-click on the row: the pick closes and nothing more opens. */
  token?: vscode.CancellationToken;
}

/**
 * Open a diagram showing a relationship (both its tables), with its line
 * selected, or a table row's table. A relationship that a diagram file keeps
 * (YAML/JSON) is shown on that diagram. Several diagrams: the user picks
 * one (`sidebarRowClick.ts`'s rule c), unless `highlight` and the diagram in
 * front of the user is one of them (rule a: selected there, nothing opened).
 * With no diagram to show it on, a row's click (`fallBackToFile`) opens the
 * file instead; otherwise the message says so and offers Add to Diagram….
 * `excludeDiagram` leaves one diagram out.
 */
export async function openInDiagram(
  node: RelationshipsNode | TableLibraryTableNode | (Pick<TableLibraryTableNode, 'type' | 'name'> & { readonly filePath?: string }) | undefined,
  deps: RelationshipsViewDeps,
  options: OpenInDiagramOptions = {},
): Promise<void> {
  if (!node || node.type === 'attention') return;
  const token = options.token;
  const cancelled = (): boolean => token?.isCancellationRequested === true;
  const gentle = options.highlight === true;
  const usage = deps.usage?.() ?? tableUsageByName(deps.memberNames);
  const relationship = node.type === 'relationship' ? node : undefined;
  const entry = relationship?.entry;
  // A table row's table, with its file when the row knows it (a Table Library row, or the canvas's table).
  const table: SidebarTable | undefined = node.type === 'model'
    ? { name: node.name, ...(node.filePath !== undefined ? { filePath: node.filePath } : {}) }
    : node.type === 'table' ? { name: node.group.table } : undefined;
  // What the diagram opened calls each table: told apart by identity, its member's reference there.
  const onDiagram = (filePath: string, t: SidebarTable | string): string => usage.refOn(filePath, t) ?? (typeof t === 'string' ? t : t.name);
  // Select it on the diagram at `filePath` (held by the editor until that canvas has its diagram).
  const reveal = async (filePath: string): Promise<void> => {
    if (entry) {
      const target = revealTarget(entry);
      // A diagram's own relationship already names its members as that diagram does.
      const named = usage.byIdentity && entry.source.kind !== 'diagram'
        ? { ...target, fromModel: onDiagram(filePath, entry.fromModel), toModel: onDiagram(filePath, entry.toModel) }
        : target;
      await deps.revealRelationship(filePath, gentle ? { ...named, gentle: true } : named);
    } else if (table) {
      const name = onDiagram(filePath, table);
      await (gentle ? deps.revealTable?.(filePath, name, { gentle: true }) : deps.revealTable?.(filePath, name));
    }
  };
  const open = async (filePath: string): Promise<void> => {
    if (cancelled()) return;
    await vscode.commands.executeCommand('erdStudio.openDomain', filePath);
    // A double-click came meanwhile: its file opens next, so nothing is selected under it.
    if (cancelled()) return;
    await reveal(filePath);
  };
  const lookingAt = gentle ? deps.lookingAtDiagram?.() : undefined;
  if (entry?.source.kind === 'diagram') {
    const choice = chooseDiagram([entry.source.filePath], lookingAt);
    if (choice.kind === 'here') await reveal(choice.filePath);
    else await open(entry.source.filePath);
    return;
  }
  const tables = entry ? [entry.fromModel, entry.toModel] : [table?.name ?? ''];
  const shown: Array<string | SidebarTable> = entry ? tables : [table ?? ''];
  const subject = tables.length === 1 || normaliseName(tables[0]) === normaliseName(tables[1])
    ? `"${tables[0]}"`
    : `both "${tables[0]}" and "${tables[1]}"`;
  const excluded = options.excludeDiagram;
  const found = diagramsShowing(shown, { ...deps, usage: () => usage })
    .filter((s) => excluded === undefined || path.resolve(s.filePath) !== path.resolve(excluded));
  const other = excluded !== undefined ? ' other' : '';
  const choice = chooseDiagram(found.map((s) => s.filePath), lookingAt);
  if (choice.kind === 'none') {
    if (options.fallBackToFile && (relationship || node.type === 'model')) {
      if (relationship) {
        vscode.window.setStatusBarMessage(noDiagramYetMessage(subject, 'relationship'), 8000);
        await openRelationshipSource(relationship, deps);
      } else {
        vscode.window.setStatusBarMessage(noDiagramYetMessage(subject, 'table'), 8000);
        await openTableFile(node);
      }
      return;
    }
    const them = [...new Set(tables.map(normaliseName))].length === 1 ? 'it' : 'them';
    const message = `ERD Studio: No${other} diagram shows ${subject} yet.`;
    if (!deps.addToDiagram) {
      void vscode.window.showInformationMessage(`${message} To add ${them}, open a diagram and use + Add → Add Existing Tables.`);
      return;
    }
    const answer = await vscode.window.showInformationMessage(`${message} Add ${them} to one?`, ADD_TO_DIAGRAM);
    if (answer === ADD_TO_DIAGRAM) await deps.addToDiagram(usage.byIdentity ? shown : tables);
    return;
  }
  if (choice.kind === 'here') {
    // In front of the user already: selected there, the view left where it is unless it is out of sight.
    await reveal(choice.filePath);
    return;
  }
  if (choice.kind === 'open') {
    await open(choice.filePath);
    return;
  }
  // Several, none in front: ask, never guess. A relationship is saved once,
  // whichever diagram shows it: the last item opens that file instead.
  const at = entry && entry.source.kind === 'library' ? deps.relationshipLocation(entry.first) : undefined;
  const fileItem = relationship && at
    ? [{ label: '$(go-to-file) Open in File', description: `${at.filePath.split(/[\\/]/).slice(-3).join('/')}, line ${at.line}`, summary: undefined }]
    : [];
  if (cancelled()) return;
  const picked = await vscode.window.showQuickPick(
    [...found.map((s) => ({ label: s.domain, description: deps.layerLabel(s.layer), summary: s as SubjectAreaSummary | undefined })), ...fileItem],
    { placeHolder: `${found.length}${other} diagrams show ${subject}. Open which?` },
    ...(token ? [token] : []),
  );
  if (!picked || cancelled()) return;
  if (!picked.summary) {
    await openRelationshipSource(relationship, deps);
    return;
  }
  await open(picked.summary.filePath);
}
