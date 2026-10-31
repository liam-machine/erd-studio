/**
 * The Relationships view's two actions.
 *
 * - **Open in Diagram…** (`erdStudio.openInDiagram`, a relationship row's
 *   click): the diagram that shows a relationship's two tables (or a table
 *   row's table, here or in the Table Library), picked when there are several, with the line selected and
 *   centred (`revealRelationship`). A relationship no diagram shows yet opens
 *   where it is written instead.
 * - **Open in File** (`erdStudio.openRelationshipSource`): a DBML Ref at its
 *   line in the relationships file, a YAML table's `relationships:` entry in
 *   the FK table's file, or the diagram that keeps it (YAML/JSON projects).
 *
 * Both only open files; nothing here writes.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';

import type { RelationshipEntry } from '../services/relationshipsOverview';
import type { RevealRelationshipMessage } from '../types/messages';
import type { SubjectAreaSummary } from '../types/semantic';
import type { RelationshipsNode } from '../providers/RelationshipsTreeProvider';
import type { TableLibraryTableNode } from '../providers/ModelLibraryTreeProvider';
import { normaliseName } from '../services/nameUtils';

export interface RelationshipsViewDeps {
  /** The DBML Ref's file and line, when a relationships file holds it. */
  relationshipLocation(rel: RelationshipEntry['first']): { filePath: string; line: number } | undefined;
  /** The table file of a library table (null when it has none). */
  findTableFile(name: string): string | null;
  listSubjectAreas(): SubjectAreaSummary[];
  /** A diagram's member table names (null when it cannot be read). */
  memberNames(filePath: string): string[] | null;
  layerLabel(layer: string): string;
  /** Select and centre the line on the diagram at `filePath`, once it is open (`SemanticEditorProvider.revealRelationship`). */
  revealRelationship(filePath: string, target: RevealRelationshipMessage['payload']): Promise<void>;
}

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

/** The diagrams whose members include every one of `tables`. */
export function diagramsShowing(tables: readonly string[], deps: Pick<RelationshipsViewDeps, 'listSubjectAreas' | 'memberNames'>): SubjectAreaSummary[] {
  const wanted = [...new Set(tables.map(normaliseName))];
  return deps.listSubjectAreas().filter((summary) => {
    let members: string[] | null = null;
    try {
      members = deps.memberNames(summary.filePath);
    } catch {
      return false;
    }
    if (!members) return false;
    const have = new Set(members.map(normaliseName));
    return wanted.every((t) => have.has(t));
  });
}

/**
 * Open a diagram showing a relationship (both its tables), with its line
 * selected and centred, or a table row's table. A relationship that a
 * diagram file keeps (YAML/JSON) is shown on that diagram. With no diagram to
 * show it on, a relationship opens where it is written (`fallBackToFile`, a
 * row's click) or says so (the menu item, which the user picked by name).
 */
export async function openInDiagram(
  node: RelationshipsNode | TableLibraryTableNode | undefined,
  deps: RelationshipsViewDeps,
  options: { fallBackToFile?: boolean } = {},
): Promise<void> {
  if (!node || node.type === 'attention') return;
  const relationship = node.type === 'relationship' ? node : undefined;
  const entry = relationship?.entry;
  const open = async (filePath: string): Promise<void> => {
    await vscode.commands.executeCommand('erdStudio.openDomain', filePath);
    if (entry) await deps.revealRelationship(filePath, revealTarget(entry));
  };
  if (entry?.source.kind === 'diagram') {
    await open(entry.source.filePath);
    return;
  }
  const tables = entry ? [entry.fromModel, entry.toModel] : [node.type === 'model' ? node.name : node.type === 'table' ? node.group.table : ''];
  const subject = tables.length === 1 || normaliseName(tables[0]) === normaliseName(tables[1])
    ? `"${tables[0]}"`
    : `both "${tables[0]}" and "${tables[1]}"`;
  const found = diagramsShowing(tables, deps);
  if (found.length === 0) {
    if (relationship && options.fallBackToFile) {
      vscode.window.setStatusBarMessage(`ERD Studio: No diagram shows ${subject} yet, so this is where the relationship is written.`, 8000);
      await openRelationshipSource(relationship, deps);
      return;
    }
    void vscode.window.showInformationMessage(`ERD Studio: No diagram shows ${subject} yet. To add ${tables.length === 1 ? 'it' : 'them'}, open a diagram and use + Add → Add Existing Table.`);
    return;
  }
  let pick = found[0];
  if (found.length > 1) {
    const choice = await vscode.window.showQuickPick(
      found.map((s) => ({ label: s.domain, description: deps.layerLabel(s.layer), summary: s })),
      { placeHolder: `${found.length} diagrams show ${subject}. Open which?` },
    );
    if (!choice) return;
    pick = choice.summary;
  }
  await open(pick.filePath);
}
