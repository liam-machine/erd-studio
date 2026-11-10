/**
 * The DBML halves of the lifecycle commands in the layer-first tree (ERD
 * Studio 2.0, §2.8): New Diagram's diagram text, Rename Subject Area's
 * writes, Move Diagram to Layer's move, the table moves Organise Table
 * Library and Move Table share, and Give Duplicate Its Own Name's rename of
 * one `.dbml` copy. Each returns
 * the {@link FileWrite}s for the command to apply as one WorkspaceEdit
 * (`applyFileWrites`); nothing here writes. Built only from core's writers
 * (through `dbmlWriters`), the library planner and the one settle
 * (`settleDbmlDiagramWrites`), so no caller splices a diagram by hand.
 *
 * No `vscode`: tests drive these directly.
 */

import * as path from 'path';

import { DIAGRAMS_DIR, RELATIONSHIPS_DIR, TABLES_DIR, classifySemanticFile, dbmlName, dbmlTreePathOf, diagramFilePath, isDbmlLayerName } from '@erd-studio/core';
import type { DbmlRelationshipsReading } from '@erd-studio/core';
import { DbmlEditRefused, diagramSummaryDbml, outlineDbmlFile, parseSubjectAreaDbml, parseTableDbml, readRelationshipsDbml, usePathBetween } from '@erd-studio/core/dbml';
import type { DbmlResolvedTable } from '@erd-studio/core/dbml';
import { TABLE_NAME_PATTERN, sameName } from '../types/naming';
import { editRelationshipsDbml, editSubjectAreaDbml, editTableDbml, renderNewSubjectAreaDbml } from '../services/dbmlWriters';
import { useDeclarationLines } from '../services/dbmlImportParse';

import type { FileWrite } from '../services/fileWrites';
import { dbmlResolverOf, settleDbmlDiagramWrites, type SubjectAreaResolver } from '../services/dbmlDiagramSettle';
import { buildRelationshipsIndex, refEntriesOf, relationshipsImportsFor } from '../services/dbmlRelationshipsIndex';
import type { TableLibraryService } from '../services/logicalModelService';
import { isSchemaFolderName, ownedRelationshipsOf } from '../services/dbmlLibraryWrites';
import { renameTableInRelationships, renameTableInSubjectArea } from '../services/libraryRelationships';
import type { SemanticTable } from '../types/semantic';

/** A path relative to `root`, posix. */
function relPosix(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/');
}

/** `p` resolved against the folder of `fromRel` (posix, semantic-relative), with `.dbml` added when it has no extension. */
function resolveUse(fromRel: string, p: string): string {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), p));
  return /\.[^/.]+$/.test(resolved) ? resolved : `${resolved}.dbml`;
}

/** The offset just past the blanks and comments (line breaks included) at `i` in `text`. */
function skipBlanks(text: string, i: number): number {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith('//', i)) {
      const eol = text.indexOf('\n', i);
      i = eol < 0 ? text.length : eol;
    } else if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 2;
    } else {
      return i;
    }
  }
}

/**
 * The quoted path of the `use` declaration whose keyword is at `at`: `use *`
 * or `use { … }` (its braces may span lines), then `from '<path>'`, which may
 * sit on a later line. Its offsets in `text`, or undefined when it has none.
 */
function usePathSpan(text: string, at: number): { start: number; end: number; path: string } | undefined {
  let i = skipBlanks(text, at + 'use'.length);
  if (text[i] === '*') {
    i++;
  } else if (text[i] === '{') {
    // To the matching `}`, past comments and quoted names.
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (text.startsWith('//', i) || text.startsWith('/*', i)) { i = skipBlanks(text, i); continue; }
      if (c === '"' || c === "'" || c === '`') {
        let j = i + 1;
        while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
        i = j + 1;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { i++; break; }
      i++;
    }
    if (depth !== 0) return undefined;
  } else {
    return undefined;
  }
  i = skipBlanks(text, i);
  if (!/^from(?![\w$])/.test(text.slice(i, i + 5))) return undefined;
  i = skipBlanks(text, i + 'from'.length);
  const quote = text[i];
  if (quote !== "'" && quote !== '"') return undefined;
  const close = text.indexOf(quote, i + 1);
  if (close < 0 || /[\r\n]/.test(text.slice(i + 1, close))) return undefined;
  return { start: i + 1, end: close, path: text.slice(i + 1, close) };
}

/**
 * Each `use` declaration in `text`, from the start of its first line to the
 * end of the line its path ends on (without the line break), so a declaration
 * written over several lines is one span; `path` is undefined when it has
 * none to read.
 */
function useLineSpans(text: string): Array<{ start: number; end: number; path?: { start: number; end: number; path: string } }> {
  const lines = useDeclarationLines(text);
  if (lines.length === 0) return [];
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return lines.map((n) => {
    const start = starts[n - 1];
    const keyword = start + (/^[ \t\r\uFEFF]*/.exec(text.slice(start))?.[0].length ?? 0);
    const span = usePathSpan(text, keyword);
    let end = text.indexOf('\n', span ? span.end : start);
    if (end < 0) end = text.length;
    if (end > start && text[end - 1] === '\r') end--;
    return { start, end, ...(span ? { path: span } : {}) };
  });
}

/** New Diagram's `.dbml` text: the Project with its Note and keys, no members yet. */
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
 * Rename Subject Area for a `.dbml` diagram (§2.8): create
 * `<layer>/diagrams/<new>.dbml`, whose text is the old one with only the
 * Project name spliced, and delete the old file. It stays in its folder, so
 * every `use` path is still right: no resolver and no library snapshot are
 * needed. Its positions go with it (they are the Project's `erd_layout`).
 */
export function planDbmlSubjectAreaRename(input: {
  semanticRoot: string;
  oldPath: string;
  newPath: string;
  newSlug: string;
  text: string;
}): FileWrite[] {
  const rel = relPosix(input.semanticRoot, input.oldPath);
  const before = parseSubjectAreaDbml(input.text, rel).obj;
  const after = { ...structuredClone(before), domain: input.newSlug };
  // Text only: no member is resolved (each `use` line keeps its bytes), and
  // the relationships imports are left as they are.
  const text = editSubjectAreaDbml(input.text, {
    filePath: rel,
    before,
    after,
    resolveTable: () => undefined,
    relationshipsImportsFor: (_names, current) => [...current],
    fileExists: () => true,
  });
  return [
    { kind: 'create', path: input.newPath, text },
    { kind: 'delete', path: input.oldPath },
  ];
}

/**
 * `text` (a diagram or relationships file that was at `oldRel` and is at
 * `newRel`) with every `use` line's path re-derived from `newRel` to the
 * file the line imports (`usePathBetween`), its specifier kept: the file it
 * resolved to from `oldRel`, or where `moved` (old path, lower-case → new
 * path) says that file went. A line whose path cannot be found refuses when
 * the file itself moved, and is left as it is otherwise. With `exists`
 * (whether a semantic-relative path holds a file), a line whose file is not
 * found from `oldRel` but is from `newRel` is already right (an undone move,
 * a file put back) and is left as it is. Paths are posix and relative to the
 * semantic dir.
 */
export function repointUseLines(input: {
  oldRel: string;
  newRel: string;
  text: string;
  moved?: ReadonlyMap<string, string>;
  exists?: (rel: string) => boolean;
}): string {
  let text = input.text;
  for (const { path: span } of useLineSpans(input.text).reverse()) {
    if (!span) {
      if (input.oldRel === input.newRel) continue;
      throw new DbmlEditRefused(input.oldRel, `${input.oldRel} has a use declaration whose path cannot be found, so it cannot be moved; fix it first.`);
    }
    const resolved = resolveUse(input.oldRel, span.path);
    const target = input.moved?.get(resolved.toLowerCase()) ?? resolved;
    if (input.exists && !input.exists(target) && input.exists(resolveUse(input.newRel, span.path))) continue;
    const repointed = usePathBetween(input.newRel, target);
    if (repointed === span.path) continue;
    text = text.slice(0, span.start) + repointed + text.slice(span.end);
  }
  return text;
}

/**
 * A diagram's move to another layer (§2.8; Move Diagram to Layer, and a
 * diagram moved in the Explorer): create `newRel` with every `use` line
 * re-derived from it ({@link repointUseLines}, `moved` naming files that
 * moved with it, `exists` leaving lines already right), and delete `oldRel`. The Project name is unchanged. Pure:
 * both paths are posix and relative to the semantic dir, and so are the
 * writes' paths.
 */
export function planDbmlDiagramMove(input: {
  oldRel: string;
  newRel: string;
  text: string;
  moved?: ReadonlyMap<string, string>;
  exists?: (rel: string) => boolean;
}): FileWrite[] {
  // Refuses a file that is not a diagram, or does not parse, before anything is planned.
  if (diagramSummaryDbml(input.text, input.oldRel) === null) {
    throw new DbmlEditRefused(input.oldRel, `${input.oldRel} does not read as a DBML diagram, so its use lines cannot be moved; fix it first.`);
  }
  // A diagram that reads gives every use declaration a path.
  const text = repointUseLines(input);
  return [
    { kind: 'create', path: input.newRel, text },
    { kind: 'delete', path: input.oldRel },
  ];
}

/**
 * Move Diagram to Layer (§2.8): {@link planDbmlDiagramMove} for the diagram
 * at `filePath` (`<layer>/diagrams/<name>.dbml`, absolute) to `toLayer`'s
 * `diagrams/` folder, its name kept. The writes and `newPath` are absolute.
 */
export function planDbmlDiagramLayerMove(input: { semanticRoot: string; filePath: string; toLayer: string; text: string }): { writes: FileWrite[]; newPath: string } {
  const oldRel = relPosix(input.semanticRoot, input.filePath);
  const newRel = diagramFilePath(input.toLayer, path.basename(input.filePath).replace(/\.dbml$/i, ''));
  const writes = planDbmlDiagramMove({ oldRel, newRel, text: input.text })
    .map((w) => ({ ...w, path: path.join(input.semanticRoot, ...w.path.split('/')) }) as FileWrite);
  return { writes, newPath: path.join(input.semanticRoot, ...newRel.split('/')) };
}

/**
 * The files a table move changes besides the moving tables' own (a move
 * writes no other table file): the diagrams and relationships files whose
 * `use` lines (or Ref ends) follow, for the question Move Table asks.
 */
export function dbmlMoveTouches(input: { semanticRoot: string; writes: readonly FileWrite[] }): { diagrams: string[]; relationships: string[] } {
  const diagrams: string[] = [];
  const relationships: string[] = [];
  for (const w of input.writes) {
    const kind = classifySemanticFile(relPosix(input.semanticRoot, w.path), { tablesDirIsLayer: false }).kind;
    if (kind === 'diagram') diagrams.push(w.path);
    else if (kind === 'relationships') relationships.push(w.path);
  }
  return { diagrams, relationships };
}

/**
 * Organise Table Library's DBML moves (§2.8): each table goes to
 * `toLayer` (its schema kept as that layer lists it, unless `toSchema`
 * names another) through `planDbmlLibraryWrites({ move })`, which never
 * moves a Ref: every relationships file that names it re-spells its `use`
 * line (and its ends, when its qualifier changes), and the settle re-renders
 * every DBML diagram that lists it. `requalified` names the tables whose
 * qualifier changed, for the summary.
 */
export function planDbmlTableMoves(input: {
  tableLibraryService: Pick<TableLibraryService, 'planDbmlLibraryOps' | 'getTablesDir'>;
  moves: ReadonlyArray<{ name: string; toLayer: string; toSchema?: string }>;
  /** Every DBML diagram, absolute paths. */
  diagrams: readonly string[];
  readText(filePath: string): string | null;
}): { writes: FileWrite[]; requalified: string[] } {
  const { writes, plan } = input.tableLibraryService.planDbmlLibraryOps({
    move: input.moves.map((m) => ({ name: m.name, toLayer: m.toLayer, ...(m.toSchema !== undefined ? { toSchema: m.toSchema } : {}) })),
  }, input.readText);
  const semanticRoot = path.dirname(input.tableLibraryService.getTablesDir());
  return {
    writes: [...writes, ...settleDbmlDiagramWrites({ semanticRoot, diagrams: input.diagrams, plan, readText: input.readText })],
    requalified: input.moves.filter((m) => plan.requalified.has(m.name.toLowerCase())).map((m) => m.name),
  };
}

/** `s` with every character a regular expression gives a meaning escaped. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `text` (a relationships file) with every Ref end (live and pending) whose
 * table part is spelled exactly `from` re-spelled `to`. Only the Ref's
 * ends are touched, never its name or settings.
 */
function respellEnds(text: string, reading: DbmlRelationshipsReading, from: string, to: string): string {
  // The table part is everything before the end's last segment (`.<col>`, `."<col>"` or `.(<cols>)`):
  // `sales` in `sales.orders.id` is a schema, not the table `sales`.
  const end = new RegExp(`(^|[\\s:<>\\-~(])${escapeRegExp(from)}(?=\\s*\\.\\s*(?:\\(|"(?:[^"\\\\\\r\\n]|\\\\.)*"(?!\\s*\\.)|[^\\s."'(),<>~:\\-\\[\\]{}]+(?![^\\s."'(),<>~:\\-\\[\\]{}]|\\s*\\.)))`, 'g');
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const ref of [...reading.refs, ...(reading.pending ?? [])]) {
    const own = text.slice(ref.start, ref.fullEnd);
    // The ends follow the Ref keyword, its optional name and the `:` or `{`.
    const head = /\bRef\b[ \t]*(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[^\s:{]+)?[ \t]*[:{]/i.exec(own);
    if (!head) continue;
    const bodyAt = head.index + head[0].length;
    const body = own.slice(bodyAt);
    const respelled = body.replace(end, (_m, lead: string) => `${lead}${to}`);
    if (respelled !== body) edits.push({ start: ref.start + bodyAt, end: ref.fullEnd, text: respelled });
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** `text` with every `use` line whose path resolves (from `fileRel`) to `targetRel`, ignoring case, cut. */
function cutUseLinesTo(text: string, fileRel: string, targetRel: string): string {
  const target = targetRel.toLowerCase();
  let out = text;
  for (const line of useLineSpans(text).reverse()) {
    if (!line.path || resolveUse(fileRel, line.path.path).toLowerCase() !== target) continue;
    const next = out.indexOf('\n', line.end);
    out = out.slice(0, line.start) + out.slice(next < 0 ? out.length : next + 1);
  }
  return out;
}

/** Whether `text` has a `use` line whose path resolves (from `fileRel`) to `targetRel`, ignoring case. */
function hasUseLineTo(text: string, fileRel: string, targetRel: string): boolean {
  const target = targetRel.toLowerCase();
  return useLineSpans(text).some((line) => line.path !== undefined && resolveUse(fileRel, line.path.path).toLowerCase() === target);
}

/**
 * Give Duplicate Its Own Name for a `.dbml` copy (§2.8): the copy (not the
 * table the library uses) is renamed in place by `editTableDbml(…, {rename:
 * true})` with its alias set, and the old copy deleted.
 *
 * - Relationships files: every Ref end whose table part is spelled exactly
 *   as the copy declares itself (`S.n`) is re-spelled to the new name; ends
 *   naming the other copy keep their bytes. When both copies are declared
 *   the same way (the same schema and name in two layers) nothing tells the
 *   ends apart, and they stay with the table the library uses, as before. A
 *   `use` line importing the copy follows: to the renamed file when a Ref
 *   still names it, to the library's table when one names that.
 * - Diagrams: every DBML diagram whose `use` line resolves to the copy's
 *   path is repointed (its member, position key and sticky notes' linked
 *   table), through the one settle; one that names the copy's path and does
 *   not read refuses the rename, naming it. A conflicted `erd_layout` is
 *   kept as it is, never refused.
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
  const schemaFolder = dbmlTreePathOf(copyRel)?.schema;
  const reading = parseTableDbml(copyText, stem, schemaFolder !== undefined ? { schemaFolder } : {});
  if (!reading.ok) throw new Error(`${copyRel} could not be read as a table file. Fix or rename it by hand.`);
  const newPath = path.join(path.dirname(input.copy.filePath), `${input.newName}.dbml`);
  const newRel = relPosix(semanticRoot, newPath);
  const desired: SemanticTable = { ...reading.table, name: input.newName, ...(input.alias ? { alias: input.alias } : {}) };
  const newText = editTableDbml(copyText, desired, { rename: true, file: copyRel, fileStem: stem, ...(schemaFolder !== undefined ? { schemaFolder } : {}) });

  const { plan } = input.tableLibraryService.planDbmlLibraryOps({}, input.readText);
  const declared = reading.declaredReference;
  const dot = declared.lastIndexOf('.');
  const reference = dot > 0 && !declared.endsWith('"') ? `${declared.slice(0, dot)}.${dbmlName(input.newName)}` : dbmlName(input.newName);
  // Ends spelled as the copy declares itself are the copy's, unless the table the library uses is spelled the same.
  const winner = plan.resolveTable(input.copy.name);
  const distinct = winner === undefined || winner.reference !== declared;
  const columns = new Map((reading.table.columns ?? []).map((c) => [c.name.toLowerCase(), c.name]));
  const renamed: DbmlResolvedTable = {
    name: input.newName,
    reference,
    path: newRel,
    storage: 'dbml',
    columns: (column) => columns.get(column.toLowerCase()),
    primaryKey: (reading.table.columns ?? []).filter((c) => c.isPrimaryKey).map((c) => c.name),
  };
  const resolve = (name: string): DbmlResolvedTable | undefined => (sameName(name, input.newName) ? renamed : plan.resolveTable(name));
  const lowerNames = new Set([input.copy.name.toLowerCase(), input.newName.toLowerCase()]);

  // Relationships files: ends naming the copy re-spelled, and its use line re-resolved by the writer.
  const repointed: string[] = [];
  const relationshipsWrites: FileWrite[] = [];
  // The files whose Refs name the copy (an end re-spelled): the renamed table's Refs, after the rename.
  const copyRefFiles = new Set<string>();
  // Their Refs as the rename leaves them, for the import rule (§2.6): the plan's index cannot tell the copy's from the winner's.
  const respelledRefs: ReturnType<typeof refEntriesOf> = [];
  for (const filePath of input.tableLibraryService.listRelationshipsFiles()) {
    const text = input.readText(filePath);
    if (text === null) continue;
    const fileRel = relPosix(semanticRoot, filePath);
    const importsCopy = hasUseLineTo(text, fileRel, copyRel);
    const relReading = readRelationshipsDbml(text);
    if (!relReading.readable) {
      if (importsCopy || (distinct && new RegExp(`(^|[^\\w."])${escapeRegExp(declared)}\\s*\\.`, 'm').test(text))) {
        const problem = relReading.problems[0];
        throw new DbmlEditRefused(fileRel, `${fileRel} does not read${problem ? ` (line ${problem.line}: ${problem.message.replace(/[.\s]+$/, '')})` : ''}; fix it first: it may name ${input.copy.name}, which this edit renames.`);
      }
      continue;
    }
    const respelled = distinct ? respellEnds(text, relReading, declared, reference) : text;
    if (respelled !== text) {
      copyRefFiles.add(fileRel.toLowerCase());
      // Only the pair each Ref joins counts here, so no table lookup is needed.
      respelledRefs.push(...refEntriesOf(fileRel, readRelationshipsDbml(respelled), () => undefined));
    }
    if (respelled === text && !importsCopy) continue;
    // The copy's own use line goes; the writer adds the line each table a Ref names needs.
    const spliced = cutUseLinesTo(respelled, fileRel, copyRel);
    const edited = editRelationshipsDbml(spliced, {
      filePath: fileRel,
      owners: new Map(),
      pathChanged: lowerNames,
      resolve,
    });
    if (edited !== text) {
      relationshipsWrites.push({ kind: 'replace', path: filePath, text: edited });
      repointed.push(filePath);
    }
  }

  // Diagrams: every one whose use line names the copy's own file (by the path it resolves to), even one that
  // does not read: the settle refuses that one rather than leave a use line to a deleted file.
  // And every one importing a file whose Refs the copy's re-spelled ends changed: under the shared name the
  // index counted the copy's Refs for the winner, so a diagram drawing the winner and a partner of the copy
  // may import a file only the copy's Refs justified. It is re-rendered with no change of its own.
  const candidates: string[] = [];
  const importsCopyRefs = new Set<string>();
  for (const diagram of input.diagrams) {
    const text = input.readText(diagram);
    if (text === null) continue;
    const rel = relPosix(semanticRoot, diagram);
    const summary = diagramSummaryDbml(text, rel);
    if (summary === null) {
      if (hasUseLineTo(text, rel, copyRel)) candidates.push(diagram);
    } else if (summary.memberUses.some((u) => u.resolved.toLowerCase() === copyRel.toLowerCase())) {
      candidates.push(diagram);
    } else if (summary.relationshipsUses.some((f) => copyRefFiles.has(f.toLowerCase()))) {
      candidates.push(diagram);
      importsCopyRefs.add(diagram);
    }
  }
  const base = dbmlResolverOf(plan, semanticRoot);
  const fileExists = (p: string): boolean => (p.toLowerCase() === newRel.toLowerCase() ? true : p.toLowerCase() === copyRel.toLowerCase() ? false : base.fileExists(p));
  const afterIndex = buildRelationshipsIndex({
    files: plan.index.files,
    refs: [...plan.index.refs.filter((r) => !copyRefFiles.has(r.file.toLowerCase())), ...respelledRefs],
    unreadable: plan.index.unreadable,
  });
  const resolver: SubjectAreaResolver = {
    semanticRoot,
    resolveTable: (name) => (sameName(name, input.newName)
      ? { name: input.newName, reference, path: newRel, storage: 'dbml' }
      : base.resolveTable(name)),
    // The plan's index still knows the copy's Refs by its old name, and cannot tell them from the winner's:
    // the rule runs on an index with the re-spelled files' Refs as the rename leaves them.
    relationshipsImportsFor: (names, current, unlinked) => relationshipsImportsFor({ members: names, unlinked }, afterIndex, { current, exists: fileExists }),
    fileExists,
    pathChanged: lowerNames,
  };
  const settled = settleDbmlDiagramWrites({
    semanticRoot,
    diagrams: candidates,
    plan,
    readText: input.readText,
    resolver,
    mutatedOnly: true,
    // A diagram only re-importing lists the winner, never the copy: its members stay as they are.
    mutate: (filePath, obj) => importsCopyRefs.has(filePath) || repointMember(obj, input.copy.name, input.newName),
  });
  // Repointed: the diagrams that name the copy (one only re-importing is written, never announced as repointed).
  repointed.unshift(...settled.filter((w) => !importsCopyRefs.has(w.path)).map((w) => w.path));
  return {
    writes: [{ kind: 'create', path: newPath, text: newText }, ...relationshipsWrites, { kind: 'delete', path: input.copy.filePath }, ...settled],
    repointed,
    newPath,
  };
}

/** Rename `from` to `to` in a diagram object's members, position keys and sticky notes' linked table; true when anything changed. */
function repointMember(obj: Record<string, unknown>, from: string, to: string): boolean {
  const logical = (obj.logical ?? {}) as { models?: unknown };
  let changed = false;
  if (Array.isArray(logical.models)) {
    logical.models = (logical.models as unknown[]).map((m) => {
      if (typeof m === 'string' && sameName(m, from)) { changed = true; return to; }
      return m;
    });
  }
  const view = (obj.viewConfig ?? {}) as { positions?: Record<string, unknown>; annotations?: unknown };
  if (view.positions) {
    for (const key of Object.keys(view.positions)) {
      if (!sameName(key, from)) continue;
      view.positions[to] = view.positions[key];
      delete view.positions[key];
      changed = true;
    }
  }
  if (Array.isArray(view.annotations)) {
    for (const note of view.annotations as Array<{ linkedModel?: unknown }>) {
      if (typeof note?.linkedModel === 'string' && sameName(note.linkedModel, from)) {
        note.linkedModel = to;
        changed = true;
      }
    }
  }
  return changed;
}


// ---------------------------------------------------------------------------
// Moves and renames made in the Explorer
// ---------------------------------------------------------------------------

/** One `.dbml` file moved or renamed outside ERD Studio (the Explorer): it is already at `to`. Absolute paths. */
export interface MovedDbmlFile {
  from: string;
  to: string;
}

/** What a DBML file is in the layer-first tree. */
export type DbmlFileKind = 'table' | 'relationships' | 'diagram';

/**
 * What following the Explorer's moves takes ({@link planDbmlExplorerMoves}):
 *
 * - `none`: nothing points at the moved files and nothing in them changes
 *   (an undone move, or a file put back where the files that point at it
 *   say it is, included).
 * - `badName`: a file landed where ERD Studio would read it but for one
 *   name: its layer folder's (`what: 'layer'`), its schema folder's
 *   (`'schema'`; Move Table's rule, `isSchemaFolderName`) or its extension
 *   (`'extension'`: `.dbml` in lower case). `name` is that name, `folder`
 *   the folder (semantic-relative, posix); nothing is planned.
 * - `misplaced`: a file landed where ERD Studio does not read a file of its
 *   kind (`expected` is where it does; `more`, the other moved files that
 *   did too; `count`, how many DBML files moved in all); nothing is planned,
 *   for any of them.
 * - `badRename`: a table file renamed to a name the table cannot take
 *   (`invalid`, not a table name; `taken`, another table's, any case;
 *   `caseOnly`, the same name in other case; `renameAndMove`, renamed and
 *   moved in one step); nothing is planned.
 * - `update`: the replaces that make every reference follow (absolute
 *   paths), the table renames among them, and how many other files change.
 */
export type DbmlExplorerMovesPlan =
  | { kind: 'none' }
  | { kind: 'badName'; move: MovedDbmlFile; what: 'layer' | 'schema' | 'extension'; name: string; folder: string }
  | { kind: 'misplaced'; move: MovedDbmlFile; fileKind: DbmlFileKind; expected: string; more: MovedDbmlFile[]; count: number }
  | { kind: 'badRename'; move: MovedDbmlFile; from: string; to: string; reason: 'invalid' | 'taken' | 'caseOnly' | 'renameAndMove'; taken?: string }
  | { kind: 'update'; writes: FileWrite[]; moved: MovedDbmlFile[]; tableRenames: Array<{ from: string; to: string }>; others: string[] };

/** A diagram's name: the rule New Diagram and Rename Subject Area hold a name to. */
function isDiagramSlug(name: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(name) && name.length <= 64;
}

/** Where ERD Studio reads a file of `kind`, for a message. */
export function dbmlHomeOf(kind: DbmlFileKind): string {
  return kind === 'table' ? '<layer>/tables/<schema>/' : kind === 'relationships' ? '<layer>/relationships/' : '<layer>/diagrams/';
}

/**
 * What a `.dbml` file's text says it is: a table file declares one Table
 * (`table`, its declared name), a diagram has a Project, a relationships
 * file Refs (a diagram's pending Ref lines sit beside its Project). Else, or
 * when the text does not parse, `pathKind`.
 */
function dbmlKindOfText(text: string | null, pathKind: DbmlFileKind | undefined): { kind?: DbmlFileKind; table?: string } {
  if (text === null) return { kind: pathKind };
  const outline = outlineDbmlFile(text, 'file.dbml');
  if (!outline.parses) return { kind: pathKind };
  const tables = outline.tables ?? [];
  if (tables.length === 1) return { kind: 'table', table: tables[0] };
  if (/^[ \t﻿]*Project\b/m.test(text)) return { kind: 'diagram' };
  if (/^[ \t﻿]*Ref\b/m.test(text)) return { kind: 'relationships' };
  return { kind: pathKind };
}

/**
 * The one name that keeps ERD Studio from reading a `.dbml` file at `rel`
 * (posix, semantic-relative) shaped as a tree path: a layer folder that is
 * not a layer name, a schema folder Move Table refuses, or an extension not
 * spelled `.dbml` (or none: `fct_order.dbml` renamed to `fct_order`).
 * Undefined when there is none, or `rel` has no tree shape.
 */
function badNameAt(rel: string): { what: 'layer' | 'schema' | 'extension'; name: string; folder: string } | undefined {
  const segments = rel.split('/');
  const file = segments[segments.length - 1];
  const shaped = (segments.length === 3 && (segments[1] === DIAGRAMS_DIR || segments[1] === RELATIONSHIPS_DIR))
    || (segments.length === 4 && segments[1] === TABLES_DIR);
  if (!shaped) return undefined;
  if (!isDbmlLayerName(segments[0])) return { what: 'layer', name: segments[0], folder: segments[0] };
  if (segments.length === 4 && !isSchemaFolderName(segments[2])) return { what: 'schema', name: segments[2], folder: segments.slice(0, 3).join('/') };
  if (!file.endsWith('.dbml')) return { what: 'extension', name: file, folder: segments.slice(0, -1).join('/') };
  return undefined;
}

/** A moved file as the planner sees it. */
interface ConsideredMove {
  /** The user's move. */
  user: MovedDbmlFile;
  /** The move to follow: from where the files that point at it say it is (absolute), to where it is. */
  move: MovedDbmlFile;
  kind: DbmlFileKind;
  /** Its place before: `move.from` in the tree, as a file of `kind`. */
  old: { kind: DbmlFileKind; layer: string; schema?: string; name: string };
  /** Its place now in the tree, if it has one. */
  now: ReturnType<typeof dbmlTreePathOf>;
  toRel: string | undefined;
  text: string | null;
}

/**
 * The writes that make every reference follow `.dbml` files the user moved
 * or renamed in the Explorer (§2.8; spec M2). The files are already at their
 * new paths; each is planned as if it were moving from its old one, through
 * the planners the commands use, given a read view in which the moved files
 * are still where they were (`TableLibraryService.planDbmlLibraryOps`'s
 * `moved`), and every planned create (new place) / delete (old place) of a
 * moved file becomes an in-place edit of the file at its new path:
 *
 * - a table file to another `<layer>/tables/<schema>/` folder: Move Table's
 *   plan (`planDbmlLibraryOps({ move })` + the settle): its declaration
 *   re-qualified to the folder's spelling, every `use` line and Ref end
 *   following;
 * - a table file renamed: the table is renamed (its name is its file's
 *   stem), as the canvas renames one: `planDbmlLibraryOps({ save: [{ model,
 *   fromName }] })` with the relationships it owns, and the settle with each
 *   diagram's member, position and sticky notes following
 *   (`renameTableInSubjectArea`);
 * - a relationships file or diagram: its own `use` lines re-derived from its
 *   new place (`planDbmlDiagramMove` / {@link repointUseLines}), and every
 *   other file's `use` line that named its old path; a renamed diagram's
 *   Project name follows when the new name is a diagram name.
 *
 * A file is what its text says (a Table, a Project, Refs), not what its old
 * path was, and its old place is where the files that point at it say it
 * is: after a move or rename ERD Studio did not follow (a file dropped in
 * the wrong folder, a refused rename), moving or renaming it again by hand
 * follows from there, and putting it back plans nothing. So does an undone
 * move: a table already declared as its folder says, with nothing pointing
 * at its old path, and `use` lines already right from the new place, are
 * left as they are.
 *
 * A file that does not read refuses (`DbmlEditRefused`, naming it) before
 * anything is planned. No `vscode`: tests drive it directly.
 */
export function planDbmlExplorerMoves(input: {
  semanticRoot: string;
  tableLibraryService: Pick<TableLibraryService, 'planDbmlLibraryOps' | 'dbmlSnapshot' | 'getTablesDir' | 'listDbmlDiagrams' | 'listRelationshipsFiles' | 'listTableFiles'>;
  moves: readonly MovedDbmlFile[];
  /** A file's text (an open document's, else the disk's), byte-order mark stripped; null when there is none. */
  readText(filePath: string): string | null;
}): DbmlExplorerMovesPlan {
  const { semanticRoot, tableLibraryService: library } = input;
  const rel = (p: string): string => relPosix(semanticRoot, p);
  const abs = (r: string): string => path.resolve(semanticRoot, ...r.split('/'));
  const inside = (p: string): boolean => {
    const r = path.relative(semanticRoot, p);
    return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
  };
  const known = new Map<string, boolean>();
  const exists = (r: string): boolean => {
    if (!known.has(r)) known.set(r, input.readText(abs(r)) !== null);
    return known.get(r)!;
  };

  // Where every use line of every diagram and relationships file points. A moved file's line is
  // read from where it was, unless only its new place finds the file (it was already right there).
  const movedFrom = new Map(input.moves.map((m) => [path.resolve(m.to), rel(m.from)]));
  let targets: string[] | undefined;
  const useTargets = (): string[] => {
    targets ??= [...new Set([...library.listDbmlDiagrams(), ...library.listRelationshipsFiles()].map((p) => path.resolve(p)))].flatMap((filePath) => {
      const text = input.readText(filePath);
      if (text === null) return [];
      const was = movedFrom.get(filePath);
      return useLineSpans(text).flatMap(({ path: span }) => {
        if (!span) return [];
        const target = resolveUse(was ?? rel(filePath), span.path);
        if (was === undefined || exists(target)) return [target];
        const here = resolveUse(rel(filePath), span.path);
        return [exists(here) ? here : target];
      });
    });
    return targets;
  };
  /** The paths, holding no file, that use lines name for a `kind` file called `name` (any case); never `toRel`. */
  const stale = (kind: DbmlFileKind, name: string, toRel: string | undefined): string[] => {
    const found = new Map<string, string>();
    for (const t of useTargets()) {
      const tree = dbmlTreePathOf(t);
      if (tree?.kind !== kind || !sameName(tree.name, name) || t === toRel || exists(t)) continue;
      found.set(t.toLowerCase(), t);
    }
    return [...found.values()];
  };

  // Only a DBML file of the tree can have files pointing at it.
  const considered = input.moves.flatMap((m): ConsideredMove[] => {
    // A file renamed without its .dbml, then given it back, is followed too: from where the files
    // that point at it say it was, and only then (any other file given the extension is new).
    const fromDbml = /\.dbml$/i.test(m.from);
    if (!inside(m.from) || (!fromDbml && !/\.dbml$/i.test(m.to))) return [];
    const fromRel = rel(m.from);
    const toRel = inside(m.to) ? rel(m.to) : undefined;
    const fromTree = dbmlTreePathOf(fromRel);
    const now = toRel !== undefined ? dbmlTreePathOf(toRel) : undefined;
    const text = input.readText(m.to);
    const { kind, table } = dbmlKindOfText(text, fromTree?.kind ?? now?.kind);
    if (!kind) return [];
    // Where the files that point at it say it is: where it was, unless that was not its place.
    let originRel = fromRel;
    let pointedAt = fromDbml;
    if (kind === 'table' && table !== undefined && !(fromTree?.kind === 'table' && sameName(fromTree.name, table))) {
      const found = stale('table', table, toRel);
      if (found.length === 1) [originRel, pointedAt] = [found[0], true];
      else if (found.length === 0 && now?.kind === 'table') originRel = `${path.posix.dirname(toRel!)}/${table}.dbml`;
    } else if (kind === 'relationships' && fromTree?.kind !== 'relationships') {
      const found = stale('relationships', path.posix.basename(fromRel).replace(/\.dbml$/i, ''), toRel);
      if (found.length === 1) [originRel, pointedAt] = [found[0], true];
    }
    if (!pointedAt) return [];
    const origin = dbmlTreePathOf(originRel);
    // Not a file ERD Studio read where it was: nothing points at it. (A diagram or relationships
    // file read from the other's folder resolves its use lines alike: same depth.)
    if (!origin || (origin.kind !== kind && (kind === 'table' || origin.kind === 'table'))) return [];
    return [{ user: m, move: { from: abs(originRel), to: m.to }, kind, old: { ...origin, kind }, now, toRel, text }];
  });
  if (considered.length === 0) return { kind: 'none' };
  for (const c of considered) {
    const bad = c.toRel !== undefined ? badNameAt(c.toRel) : undefined;
    if (bad) return { kind: 'badName', move: c.user, ...bad };
  }
  const misplaced = considered.filter((c) => c.now?.kind !== c.kind);
  if (misplaced.length > 0) {
    const [first, ...rest] = misplaced;
    return { kind: 'misplaced', move: first.user, fileKind: first.kind, expected: dbmlHomeOf(first.kind), more: rest.map((c) => c.user), count: considered.length };
  }

  // Already where the files that point at it say it is (a move undone, a file put back): nothing to follow.
  const isHome = (c: ConsideredMove): boolean => {
    const originRel = rel(c.move.from);
    if (originRel === c.toRel) return true;
    // A diagram's or relationships file's own lines, and the lines naming it, are checked line by line below.
    if (c.kind !== 'table' || !c.now || c.text === null) return false;
    if (useTargets().some((t) => t !== c.toRel && t.toLowerCase() === originRel.toLowerCase())) return false;
    const reading = parseTableDbml(c.text, c.now.name, { schemaFolder: c.now.schema });
    return reading.ok && reading.declaredName === c.now.name && !reading.problems.some((p) => p.code === 'schemaFolderMismatch');
  };
  const active = considered.filter((c) => !isHome(c));
  if (active.length === 0) return { kind: 'none' };

  // Tables: a move to another schema folder, or a rename (the stem is the table's name).
  const tableMoves: Array<{ name: string; toLayer: string; toSchema: string }> = [];
  const tableRenames: Array<{ move: MovedDbmlFile; from: string; to: string; schema: string }> = [];
  for (const { user, move, old, now } of active) {
    if (old.kind !== 'table' || !now) continue;
    const sameFolder = old.layer === now.layer && old.schema === now.schema;
    if (old.name === now.name) {
      if (!sameFolder) tableMoves.push({ name: old.name, toLayer: now.layer, toSchema: now.schema! });
      continue;
    }
    const bad = (reason: 'invalid' | 'taken' | 'caseOnly' | 'renameAndMove', taken?: string): DbmlExplorerMovesPlan =>
      ({ kind: 'badRename', move: user, from: old.name, to: now.name, reason, ...(taken !== undefined ? { taken } : {}) });
    if (sameName(old.name, now.name)) return bad('caseOnly');
    if (!sameFolder) return bad('renameAndMove');
    if (!TABLE_NAME_PATTERN.test(now.name)) return bad('invalid');
    const taken = library.listTableFiles().find((e) => sameName(e.name, now.name) && path.resolve(e.filePath) !== path.resolve(move.to));
    if (taken) return bad('taken', taken.name);
    tableRenames.push({ move, from: old.name, to: now.name, schema: old.schema! });
  }

  // The read view: every moved file still at its old path (diagrams included, for the settle).
  const nowAt = new Map(active.map(({ move }) => [path.resolve(move.from), move.to]));
  const wasAt = new Map(active.map(({ move }) => [path.resolve(move.to), move.from]));
  const readBefore = (filePath: string): string | null => {
    const r = path.resolve(filePath);
    return nowAt.has(r) ? input.readText(nowAt.get(r)!) : wasAt.has(r) ? null : input.readText(filePath);
  };
  const libraryMoves = active.filter(({ old }) => old.kind !== 'diagram').map(({ move }) => move);

  let planned: FileWrite[] = [];
  if (tableMoves.length > 0 || tableRenames.length > 0) {
    // A renamed table keeps every relationship it owns (a save's list is its complete list).
    const snapshot = tableRenames.length > 0 ? library.dbmlSnapshot(input.readText, libraryMoves) : undefined;
    const saves = tableRenames.map((r) => {
      const text = readBefore(r.move.from);
      const reading = text === null ? null : parseTableDbml(text, r.from, { schemaFolder: r.schema });
      if (!reading?.ok) {
        throw new DbmlEditRefused(rel(r.move.to), `${rel(r.move.to)} does not read as the table ${r.from}${reading && !reading.ok ? ` (${reading.error.message})` : ''}; fix it first, then rename it.`);
      }
      const model: SemanticTable = { ...structuredClone(reading.table), name: r.to, relationships: ownedRelationshipsOf(snapshot!, r.from) };
      // Its own self-references follow, as on the canvas.
      renameTableInRelationships([model], r.from, r.to);
      return { model, fromName: r.from };
    });
    const { writes, plan } = library.planDbmlLibraryOps(
      { move: tableMoves, save: saves, delete: tableRenames.map((r) => r.from) },
      input.readText,
      libraryMoves,
    );
    const diagrams = library.listDbmlDiagrams().map((d) => wasAt.get(path.resolve(d)) ?? d);
    const settled = settleDbmlDiagramWrites({
      semanticRoot,
      diagrams,
      plan,
      readText: readBefore,
      // A moved diagram's summary is read from its text (its old path holds no file).
      openText: (filePath) => (nowAt.has(path.resolve(filePath)) ? readBefore(filePath) ?? undefined : undefined),
      ...(tableRenames.length > 0
        ? { mutate: (_filePath: string, obj: Record<string, unknown>) => tableRenames.reduce((changed, r) => renameTableInSubjectArea(obj, r.from, r.to, 'dbml') || changed, false) }
        : {}),
    });
    planned = [...writes, ...settled];
  }

  // Each planned write onto the file where it is now: a moved file's create (its new place) and its
  // edits at its old path are its new text; the delete of its old path is the move already made.
  const texts = new Map<string, string>();
  const extra: FileWrite[] = [];
  for (const w of planned) {
    const r = path.resolve(w.path);
    if (w.kind === 'delete') {
      if (!nowAt.has(r)) extra.push(w);
      continue;
    }
    const landed = active.find(({ move }) => rel(move.to).toLowerCase() === rel(w.path).toLowerCase());
    if (w.kind === 'create' && landed) texts.set(path.resolve(landed.move.to), w.text);
    else if (w.kind === 'create') extra.push(w);
    else texts.set(path.resolve(nowAt.get(r) ?? w.path), w.text);
  }

  // Every use line naming a moved file follows it; a moved diagram or relationships file re-derives its own.
  const movedRel = new Map(active.map(({ move }) => [rel(move.from).toLowerCase(), rel(move.to)]));
  const candidates = new Set([...texts.keys(), ...library.listDbmlDiagrams(), ...library.listRelationshipsFiles()].map((p) => path.resolve(p)));
  const writes: FileWrite[] = [];
  for (const filePath of [...candidates].sort()) {
    const current = input.readText(filePath);
    let text = texts.get(filePath) ?? current;
    if (text === null) continue;
    const own = active.find(({ move }) => path.resolve(move.to) === filePath);
    if (own?.old.kind !== 'table') {
      const oldRel = own ? rel(own.move.from) : rel(filePath);
      const newRel = rel(filePath);
      if (own?.old.kind === 'diagram') {
        text = (planDbmlDiagramMove({ oldRel, newRel, text, moved: movedRel, exists })[0] as { text: string }).text;
        // A renamed diagram's Project name follows, when the new name is one.
        if (own.now && own.old.name !== own.now.name && isDiagramSlug(own.now.name)) {
          try {
            text = (planDbmlSubjectAreaRename({ semanticRoot, oldPath: filePath, newPath: filePath, newSlug: own.now.name, text })[0] as { text: string }).text;
          } catch { /* a Project the writer cannot splice keeps its name */ }
        }
      } else if (own || useLineSpans(text).some((l) => l.path && movedRel.has(resolveUse(oldRel, l.path.path).toLowerCase()))) {
        text = repointUseLines({ oldRel, newRel, text, moved: movedRel, exists });
      }
    }
    if (text !== current) writes.push({ kind: 'replace', path: filePath, text });
  }
  writes.push(...extra);
  if (writes.length === 0) return { kind: 'none' };
  const movedTo = new Set(active.map(({ move }) => path.resolve(move.to)));
  return {
    kind: 'update',
    writes,
    moved: active.map(({ user }) => user),
    tableRenames: tableRenames.map((r) => ({ from: r.from, to: r.to })),
    others: writes.filter((w) => !movedTo.has(path.resolve(w.path))).map((w) => w.path),
  };
}
