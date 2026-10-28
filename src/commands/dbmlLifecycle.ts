/**
 * The DBML halves of the lifecycle commands (native DBML storage, §5.7):
 * New Diagram's diagram text, Rename Subject Area's writes, Organise Table
 * Library's moves and Give Duplicate Its Own Name's rename of one `.dbml`
 * copy. Each returns the {@link FileWrite}s for the command to apply as one
 * WorkspaceEdit (`applyFileWrites`); nothing here writes. Built only from
 * core's writers (`renderNewSubjectAreaDbml`, `editSubjectAreaDbml`,
 * `editTableDbml`) and the library planner, so no caller splices by hand.
 *
 * No `vscode`: tests drive these directly.
 */

import * as path from 'path';

import { dbmlName, layoutFilePathOf } from '@erd-studio/core';
import { sameName } from '../types/naming';
import { editRelationshipsDbml, editSubjectAreaDbml, editTableDbml, parseSubjectAreaDbml, parseTableDbml, renderNewSubjectAreaDbml } from '@erd-studio/core/dbml';

import type { FileWrite } from '../services/fileWrites';
import type { DbmlLibraryWritePlan } from '../services/dbmlLibraryWrites';
import { dbmlResolverOf, settleDbmlDiagramWrites, type DbmlDiagramResolver } from '../services/dbmlDiagramSettle';
import type { TableLibraryService } from '../services/logicalModelService';
import type { SemanticTable } from '../types/semantic';

/** A path relative to `root`, posix. */
function relPosix(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/');
}

/** New Diagram's `.dbml` text (§5.7): the Project with its Note and keys, no members yet. */
export function newDbmlSubjectAreaText(input: {
  semanticRoot: string;
  filePath: string;
  domain: string;
  description?: string;
  modelFolder?: string;
}): string {
  return renderNewSubjectAreaDbml({
    filePath: relPosix(input.semanticRoot, input.filePath),
    domain: input.domain,
    ...(input.description ? { description: input.description } : {}),
    ...(input.modelFolder ? { modelFolder: input.modelFolder } : {}),
    members: [],
    relationshipsFiles: [],
  });
}

/**
 * Rename Subject Area for a `.dbml` diagram (§5.7): create `<new>.dbml`, whose
 * text is `editSubjectAreaDbml(old, {after.domain = new})` (the Project name
 * spliced, nothing else), delete `<old>.dbml`, and move its `.dbdiagram` when
 * there is one. The `use` paths stay valid: the file stays in its folder.
 */
export function planDbmlSubjectAreaRename(input: {
  semanticRoot: string;
  oldPath: string;
  newPath: string;
  newSlug: string;
  text: string;
  layoutText: string | null;
  resolver: DbmlDiagramResolver;
}): FileWrite[] {
  const rel = relPosix(input.semanticRoot, input.oldPath);
  const before = parseSubjectAreaDbml(input.text, rel, input.layoutText).obj;
  const after = { ...structuredClone(before), domain: input.newSlug };
  const text = editSubjectAreaDbml(input.text, {
    filePath: rel,
    before,
    after,
    resolveTable: (name) => input.resolver.resolveTable(name),
    relationshipsFilesFor: (names) => input.resolver.relationshipsFilesFor(names),
    fileExists: (p) => input.resolver.fileExists(p),
  });
  const writes: FileWrite[] = [
    { kind: 'create', path: input.newPath, text },
    { kind: 'delete', path: input.oldPath },
  ];
  if (input.layoutText !== null) {
    writes.push({ kind: 'create', path: layoutFilePathOf(input.newPath), text: input.layoutText });
    writes.push({ kind: 'delete', path: layoutFilePathOf(input.oldPath) });
  }
  return writes;
}

/** The library as it is now, for rendering a diagram against it. */
export function currentDbmlResolver(
  tableLibraryService: Pick<TableLibraryService, 'planDbmlLibraryOps'>,
  readText?: (filePath: string) => string | null,
): { plan: DbmlLibraryWritePlan; resolver: DbmlDiagramResolver } {
  const { plan } = tableLibraryService.planDbmlLibraryOps({}, readText);
  return { plan, resolver: dbmlResolverOf(plan) };
}

/**
 * Organise Table Library's DBML moves (§5.7): `planDbmlLibraryWrites({move})`
 * (the table file moves, its Refs move verbatim to the new folder's
 * relationships file, every relationships file's `use` line for it follows)
 * plus the settle re-render of every DBML diagram that uses a moved table.
 */
export function planDbmlTableMoves(input: {
  tableLibraryService: Pick<TableLibraryService, 'planDbmlLibraryOps' | 'getTablesDir'>;
  moves: ReadonlyArray<{ name: string; toFolder: string }>;
  /** Every DBML diagram, absolute paths. */
  diagrams: readonly string[];
  readText(filePath: string): string | null;
}): FileWrite[] {
  const { writes, plan } = input.tableLibraryService.planDbmlLibraryOps({ move: input.moves.map((m) => ({ ...m })) }, input.readText);
  const semanticRoot = path.dirname(input.tableLibraryService.getTablesDir());
  return [...writes, ...settleDbmlDiagramWrites({ semanticRoot, diagrams: input.diagrams, plan, readText: input.readText })];
}

/** Whether `text` has a `use` line whose path resolves (from `fileRel`) to `targetRel`, ignoring case; a cheap pre-filter. */
function hasUseLineTo(text: string, fileRel: string, targetRel: string): boolean {
  const target = targetRel.toLowerCase();
  for (const match of text.matchAll(/^[ \t]*use\b[^\n]*?\bfrom[ \t]+(['"])([^'"\n]*)\1/gm)) {
    let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), match[2]));
    if (!/\.dbml$/i.test(resolved)) resolved += '.dbml';
    if (resolved.toLowerCase() === target) return true;
  }
  return false;
}

/**
 * Give Duplicate Its Own Name for a `.dbml` copy (§5.7): the copy (not the
 * table the library uses) is renamed in place by `editTableDbml(copyText,
 * …, {rename: true})` with its alias set, the old copy deleted, and only the
 * DBML diagrams whose `use` line resolves to THAT copy's path are repointed
 * (members and layout keys). Refs naming the old spelling stay with the
 * remaining copy, which the library uses, so a relationships file whose
 * `use` line imports the copy is re-pointed at that table (the planner's own
 * relationships-file writer, `use` lines only): the deleted copy is never
 * left imported.
 */
export function planDbmlDuplicateRename(input: {
  tableLibraryService: Pick<TableLibraryService, 'planDbmlLibraryOps' | 'getTablesDir' | 'listRelationshipsFiles'>;
  copy: { filePath: string; name: string };
  newName: string;
  alias: string | undefined;
  /** Every DBML diagram, absolute paths. */
  diagrams: readonly string[];
  readText(filePath: string): string | null;
}): { writes: FileWrite[]; repointed: string[]; newPath: string } {
  const semanticRoot = path.dirname(input.tableLibraryService.getTablesDir());
  const copyRel = relPosix(semanticRoot, input.copy.filePath);
  const copyText = input.readText(input.copy.filePath);
  if (copyText === null) throw new Error(`${copyRel} could not be read.`);
  const stem = path.basename(input.copy.filePath).replace(/\.dbml$/i, '');
  const reading = parseTableDbml(copyText, stem);
  if (!reading.ok) throw new Error(`${copyRel} could not be read as a table file. Fix or rename it by hand.`);
  const newPath = path.join(path.dirname(input.copy.filePath), `${input.newName}.dbml`);
  const newRel = relPosix(semanticRoot, newPath);
  const desired: SemanticTable = { ...reading.table, name: input.newName, ...(input.alias ? { alias: input.alias } : {}) };
  const newText = editTableDbml(copyText, desired, { rename: true, file: copyRel, fileStem: stem });

  const { plan } = input.tableLibraryService.planDbmlLibraryOps({}, input.readText);
  const declared = reading.declaredReference;
  const dot = declared.lastIndexOf('.');
  const reference = dot > 0 && !declared.endsWith('"') ? `${declared.slice(0, dot)}.${dbmlName(input.newName)}` : dbmlName(input.newName);
  // The copy's folder's relationships file, when it has one (the copy owns no Refs: readers ignore it).
  const copyFolderRels = [`${path.posix.dirname(newRel)}/_relationships.dbml`].filter((p) => plan.fileExists(p));
  const base = dbmlResolverOf(plan);
  const resolver: DbmlDiagramResolver = {
    resolveTable: (name) => (sameName(name, input.newName)
      ? { name: input.newName, reference, path: newRel, storage: 'dbml' }
      : base.resolveTable(name)),
    relationshipsFilesFor: (names) => [...new Set(names.flatMap((n) => (sameName(n, input.newName) ? copyFolderRels : base.relationshipsFilesFor([n]))))],
    fileExists: (p) => (p.toLowerCase() === newRel.toLowerCase() ? true : p.toLowerCase() === copyRel.toLowerCase() ? false : base.fileExists(p)),
    pathChanged: new Set([input.copy.name.toLowerCase(), input.newName.toLowerCase()]),
  };

  // The diagrams whose use line names the copy's own file, by the path it resolves to.
  const repointed: string[] = [];
  for (const diagram of input.diagrams) {
    const text = input.readText(diagram);
    if (text === null) continue;
    try {
      const uses = parseSubjectAreaDbml(text, relPosix(semanticRoot, diagram), null).uses ?? [];
      if (uses.some((u) => u.resolved.toLowerCase() === copyRel.toLowerCase())) repointed.push(diagram);
    } catch {
      // A diagram that does not read is left as it is.
    }
  }
  const settled = settleDbmlDiagramWrites({
    semanticRoot,
    diagrams: repointed,
    plan,
    readText: input.readText,
    resolver,
    mutatedOnly: true,
    mutate: (_filePath, obj) => repointMember(obj, input.copy.name, input.newName),
  });
  // Relationships files importing the copy: their `use` line for the name follows the table the library uses.
  const relationshipsWrites: FileWrite[] = [];
  for (const filePath of input.tableLibraryService.listRelationshipsFiles()) {
    const text = input.readText(filePath);
    const fileRel = relPosix(semanticRoot, filePath);
    if (text === null || !hasUseLineTo(text, fileRel, copyRel)) continue;
    const edited = editRelationshipsDbml(text, {
      filePath: fileRel,
      owners: new Map(),
      pathChanged: new Set([input.copy.name.toLowerCase()]),
      resolve: (name) => plan.resolveTable(name),
    });
    if (edited !== text) {
      relationshipsWrites.push({ kind: 'replace', path: filePath, text: edited });
      repointed.push(filePath);
    }
  }
  return {
    writes: [{ kind: 'create', path: newPath, text: newText }, ...relationshipsWrites, { kind: 'delete', path: input.copy.filePath }, ...settled],
    repointed,
    newPath,
  };
}

/** Rename `from` to `to` in a diagram object's members and position keys; true when anything changed. */
function repointMember(obj: Record<string, unknown>, from: string, to: string): boolean {
  const logical = (obj.logical ?? {}) as { models?: unknown };
  let changed = false;
  if (Array.isArray(logical.models)) {
    logical.models = (logical.models as unknown[]).map((m) => {
      if (typeof m === 'string' && sameName(m, from)) { changed = true; return to; }
      return m;
    });
  }
  const view = (obj.viewConfig ?? {}) as { positions?: Record<string, unknown> };
  if (view.positions) {
    for (const key of Object.keys(view.positions)) {
      if (!sameName(key, from)) continue;
      view.positions[to] = view.positions[key];
      delete view.positions[key];
      changed = true;
    }
  }
  return changed;
}
