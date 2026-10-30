/**
 * The DBML halves of the lifecycle commands in the layer-first tree (ERD
 * Studio 2.0, §2.8): New Diagram's diagram text, Rename Subject Area's
 * writes, a diagram's move to another layer, Organise Table Library's moves
 * and Give Duplicate Its Own Name's rename of one `.dbml` copy. Each returns
 * the {@link FileWrite}s for the command to apply as one WorkspaceEdit
 * (`applyFileWrites`); nothing here writes. Built only from core's writers
 * (through `dbmlWriters`), the library planner and the one settle
 * (`settleDbmlDiagramWrites`), so no caller splices a diagram by hand.
 *
 * No `vscode`: tests drive these directly.
 */

import * as path from 'path';

import { dbmlName, dbmlTreePathOf } from '@erd-studio/core';
import type { DbmlRelationshipsReading } from '@erd-studio/core';
import { DbmlEditRefused, diagramSummaryDbml, parseSubjectAreaDbml, parseTableDbml, readRelationshipsDbml, usePathBetween } from '@erd-studio/core/dbml';
import type { DbmlResolvedTable } from '@erd-studio/core/dbml';
import { sameName } from '../types/naming';
import { editRelationshipsDbml, editSubjectAreaDbml, editTableDbml, renderNewSubjectAreaDbml } from '../services/dbmlWriters';
import { useDeclarationLines } from '../services/dbmlImportParse';

import type { FileWrite } from '../services/fileWrites';
import { dbmlResolverOf, settleDbmlDiagramWrites, type SubjectAreaResolver } from '../services/dbmlDiagramSettle';
import type { TableLibraryService } from '../services/logicalModelService';
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
 * A diagram's move to another layer (§2.8; no command uses it yet): create
 * `newRel` with every `use` line's path re-derived from it to the file the
 * line imports now (`usePathBetween`), its specifier kept, and delete
 * `oldRel`. The Project name is unchanged. Pure: both paths are posix and
 * relative to the semantic dir, and so are the writes' paths.
 */
export function planDbmlDiagramMove(input: { oldRel: string; newRel: string; text: string }): FileWrite[] {
  // Refuses a file that is not a diagram, or does not parse, before anything is planned.
  if (diagramSummaryDbml(input.text, input.oldRel) === null) {
    throw new DbmlEditRefused(input.oldRel, `${input.oldRel} does not read as a DBML diagram, so its use lines cannot be moved; fix it first.`);
  }
  let text = input.text;
  for (const { path: span } of useLineSpans(input.text).reverse()) {
    // A diagram that reads gives every use declaration a path.
    if (!span) throw new DbmlEditRefused(input.oldRel, `${input.oldRel} has a use declaration whose path cannot be found, so it cannot be moved; fix it first.`);
    const moved = usePathBetween(input.newRel, resolveUse(input.oldRel, span.path));
    if (moved === span.path) continue;
    text = text.slice(0, span.start) + moved + text.slice(span.end);
  }
  return [
    { kind: 'create', path: input.newRel, text },
    { kind: 'delete', path: input.oldRel },
  ];
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
    if (respelled !== text) copyRefFiles.add(fileRel.toLowerCase());
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
  const candidates = input.diagrams.filter((diagram) => {
    const text = input.readText(diagram);
    if (text === null) return false;
    const rel = relPosix(semanticRoot, diagram);
    const summary = diagramSummaryDbml(text, rel);
    if (summary === null) return hasUseLineTo(text, rel, copyRel);
    return summary.memberUses.some((u) => u.resolved.toLowerCase() === copyRel.toLowerCase());
  });
  const base = dbmlResolverOf(plan, semanticRoot);
  const resolver: SubjectAreaResolver = {
    semanticRoot,
    resolveTable: (name) => (sameName(name, input.newName)
      ? { name: input.newName, reference, path: newRel, storage: 'dbml' }
      : base.resolveTable(name)),
    // The plan's index still knows the copy's Refs by its old name, and cannot tell them from the winner's:
    // with the renamed table, a file is imported when the other members alone want it, or when it holds the
    // copy's Refs and wants it under the old name.
    relationshipsImportsFor: (names, current, unlinked) => {
      if (!names.some((n) => sameName(n, input.newName))) return base.relationshipsImportsFor(names, current, unlinked);
      const others = base.relationshipsImportsFor(names.filter((n) => !sameName(n, input.newName)), current, unlinked);
      const asCopy = base.relationshipsImportsFor(names.map((n) => (sameName(n, input.newName) ? input.copy.name : n)), current, unlinked)
        .filter((f) => copyRefFiles.has(f.toLowerCase()));
      return [...new Set([...others, ...asCopy])].sort();
    },
    fileExists: (p) => (p.toLowerCase() === newRel.toLowerCase() ? true : p.toLowerCase() === copyRel.toLowerCase() ? false : base.fileExists(p)),
    pathChanged: lowerNames,
  };
  const settled = settleDbmlDiagramWrites({
    semanticRoot,
    diagrams: candidates,
    plan,
    readText: input.readText,
    resolver,
    mutatedOnly: true,
    mutate: (_filePath, obj) => repointMember(obj, input.copy.name, input.newName),
  });
  repointed.unshift(...settled.map((w) => w.path));
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
