/**
 * The one settle rule for diagram imports (ERD Studio 2.0, §2.6): after a
 * library plan, every DBML diagram whose `use` lines the plan invalidates is
 * re-rendered with no change of its own, in the same write as the plan.
 *
 * A diagram is settled when a member is renamed, moved, deleted, created or
 * re-qualified, or when a table pair among its members changes the files
 * that hold its Refs and the relationships files it should import differ
 * from the ones it imports ({@link needsSettle}). Each diagram is first read
 * as a syntax-only summary (memoised by disk signature or open text); only
 * the ones that need settling are read in full. An edit that changes no
 * path, creates no table, re-qualifies nothing and moves no Ref pair
 * settles nothing and reads nothing (step 0).
 *
 * A diagram that cannot be settled (it does not read, or the writer turns
 * it down) refuses the whole edit when the plan changes the path of one of
 * its members, since it would keep a `use` line to a file that is gone; it
 * is left as it is otherwise (a missing import only hides a Ref from other
 * tools, and doctor reports it). A conflicted `erd_layout` never refuses
 * here: it is kept byte for byte (§1.6).
 *
 * The editor (`SemanticEditorProvider`), the batch writes outside it
 * (`TableLibraryService.applyDbmlBatch`, the lifecycle commands) and Convert
 * all settle through {@link settleDbmlDiagramWrites}. No `vscode`: the CLI
 * bundles it.
 */

import * as path from 'path';

import { DbmlEditRefused, parseSubjectAreaDbml } from '@erd-studio/core/dbml';
import type { DbmlDiagramTable } from '@erd-studio/core/dbml';

import { editSubjectAreaDbml } from './dbmlWriters';
import { diagramSummaryForFile, needsSettle } from './dbmlDiagramSummaries';
import type { DiagramSummary, SettleSignals } from './dbmlDiagramSummaries';
import type { FileWrite } from './fileWrites';
import type { DbmlLibraryWritePlan } from './dbmlLibraryWrites';
import { log } from './logger';

/**
 * The library as an edit leaves it, for rendering a DBML diagram: tables
 * resolved after the edit's table writes, the relationships files a diagram
 * imports for its members, and which files exist. Paths are posix, relative
 * to `semanticRoot`.
 */
export interface SubjectAreaResolver {
  /** The semantic dir, absolute. */
  semanticRoot: string;
  resolveTable(name: string): DbmlDiagramTable | undefined;
  /** The relationships files a diagram showing `names` imports after the edit; `current` is what it imports now. */
  relationshipsImportsFor(names: readonly string[], current: readonly string[]): string[];
  fileExists(relPath: string): boolean;
  /** Tables whose file moved, was renamed or was deleted in this edit, and tables it created (lower-case). */
  pathChanged?: ReadonlySet<string>;
  /** Recompute the relationships `use` lines even when membership did not change (every non-layout edit, the settle). */
  refreshRelationshipsUses?: boolean;
  /** Leave a conflicted `erd_layout` as it is (§1.6): set when rendering a diagram that is not the one being edited. */
  keepLayoutIfConflicted?: boolean;
}

/** The posix path of `filePath` relative to `semanticRoot`. */
function relativeTo(semanticRoot: string, filePath: string): string {
  return path.relative(semanticRoot, filePath).split(path.sep).join('/');
}

/** Old and new lower-case names of every table whose path the plan changes (renamed, moved, deleted). */
function pathChangedNames(plan: DbmlLibraryWritePlan): Set<string> {
  const out = new Set<string>();
  for (const [oldName, newPath] of plan.pathChanged) {
    out.add(oldName.toLowerCase());
    if (newPath !== null) out.add(path.posix.basename(newPath).replace(/\.dbml$/i, '').toLowerCase());
  }
  return out;
}

/** A plan's resolver: tables, imports and file existence after it, and every table whose path changed or that it created. */
export function dbmlResolverOf(plan: DbmlLibraryWritePlan, semanticRoot: string): SubjectAreaResolver {
  const pathChanged = pathChangedNames(plan);
  // A table new in this plan gains its file: a diagram listing it in erd_unlinked_tables gives it a use line (D26).
  for (const name of plan.createdTables) pathChanged.add(name.toLowerCase());
  for (const name of plan.requalified) pathChanged.add(name);
  return {
    semanticRoot,
    resolveTable: (name) => plan.resolveTable(name),
    relationshipsImportsFor: (names, current) => plan.relationshipsImportsFor(names, current),
    fileExists: (relPath) => plan.fileExists(relPath),
    ...(pathChanged.size > 0 ? { pathChanged } : {}),
  };
}

/** What the settle rule reads of a plan ({@link needsSettle}). */
export function settleSignalsOf(plan: DbmlLibraryWritePlan): SettleSignals {
  return {
    pathChanged: pathChangedNames(plan),
    createdTables: new Set(plan.createdTables.map((n) => n.toLowerCase())),
    requalified: plan.requalified,
    changedPairs: plan.changedPairs,
    importsFor: (members, current) => plan.relationshipsImportsFor(members, current),
  };
}

/** §2.6 step 0: the plan changes no path, creates no table, re-qualifies nothing and moves no Ref pair. */
export function settlesNothing(plan: DbmlLibraryWritePlan): boolean {
  return plan.pathChanged.size === 0 && plan.createdTables.length === 0 && plan.requalified.size === 0 && plan.changedPairs.size === 0;
}

/**
 * `text` (the DBML diagram `rel`) re-rendered from `before` to `after`
 * against `resolver`: core's `editSubjectAreaDbml`, then the formatter. The
 * one render the codec and the settle share.
 */
export function renderDbmlDiagram(
  text: string,
  rel: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  resolver: SubjectAreaResolver,
): string {
  return editSubjectAreaDbml(text, {
    filePath: rel,
    before,
    after,
    resolveTable: (name) => resolver.resolveTable(name),
    relationshipsImportsFor: (names, current) => resolver.relationshipsImportsFor(names, current),
    fileExists: (relPath) => resolver.fileExists(relPath),
    ...(resolver.pathChanged ? { pathChanged: resolver.pathChanged } : {}),
    ...(resolver.refreshRelationshipsUses ? { refreshRelationshipsUses: true } : {}),
    ...(resolver.keepLayoutIfConflicted ? { keepLayoutIfConflicted: true } : {}),
  });
}

/** `s` with every character a regular expression gives a meaning escaped. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The `use` path (semantic-relative) of a member of the diagram `rel` whose
 * path the edit changes (renamed, moved, deleted or re-qualified), or
 * undefined when it changes none. From the summary's members when there is
 * one; from the text otherwise (a syntax error): any quoted path ending
 * `/<old stem>.dbml` of such a table, compared without case.
 */
export function changedMemberPath(
  rel: string,
  text: string | null,
  summary: DiagramSummary | null,
  changed: { pathChanged?: ReadonlySet<string>; requalified?: ReadonlySet<string> },
): string | undefined {
  const touched = (name: string): boolean => changed.pathChanged?.has(name.toLowerCase()) === true || changed.requalified?.has(name.toLowerCase()) === true;
  if (summary) {
    const at = summary.members.findIndex(touched);
    return at < 0 ? undefined : summary.memberPaths[at];
  }
  if (text === null) return undefined;
  for (const name of new Set([...(changed.pathChanged ?? []), ...(changed.requalified ?? [])])) {
    const match = new RegExp(`'([^'\\r\\n]*/${escapeRegExp(name)}\\.dbml)'`, 'i').exec(text);
    if (match) return path.posix.normalize(path.posix.join(path.posix.dirname(rel), match[1]));
  }
  return undefined;
}

/** The refusal for a diagram an edit cannot settle while it changes the path of `oldPath`'s table. */
export function unsettledDiagramRefusal(rel: string, problem: string, oldPath: string): DbmlEditRefused {
  return new DbmlEditRefused(rel, `${rel} does not read (${problem}); fix it first, or it would keep a use line to ${oldPath}.`);
}

/**
 * What went wrong, as a refusal quotes it: the error's message without the
 * file it names (the refusal names it already), whether the message leads
 * with `<rel>: ` or is the reader's "Invalid DBML in subject area file
 * <file> at …". `filePath` is the path the reader was given when it was not
 * `rel` (the editor parses by absolute path), so both spell the same text.
 */
export function problemOf(err: unknown, rel: string, filePath?: string): string {
  let message = err instanceof Error ? err.message : String(err);
  if (filePath !== undefined && filePath !== rel) message = message.split(filePath).join(rel);
  if (message.startsWith(`${rel}: `)) message = message.slice(rel.length + 2);
  message = message.split(` in subject area file ${rel}`).join('');
  return message.replace(/[.\s]+$/, '');
}

/** Why `text` (the diagram `rel`) does not read: the full reader's message, or a plain one when it reads after all. */
function syntaxProblemOf(text: string, rel: string): string {
  try {
    parseSubjectAreaDbml(text, rel);
    return 'it has a DBML syntax error';
  } catch (err) {
    return problemOf(err, rel);
  }
}

/** What {@link settleDbmlDiagramWrites} reads. */
export interface SettleInput {
  /** The semantic dir, absolute. */
  semanticRoot: string;
  /** Every DBML diagram to consider (absolute paths); the caller leaves out the ones it writes itself. */
  diagrams: readonly string[];
  plan: DbmlLibraryWritePlan;
  /** A file's text (absolute path), byte-order mark stripped; null when there is none. */
  readText(filePath: string): string | null;
  /**
   * An open document's text (the editor), else undefined: a diagram's
   * summary is then keyed by that text rather than by its file on disk.
   */
  openText?(filePath: string): string | undefined;
  /**
   * A change to make to a diagram's v5 object before it is rendered (Give
   * Duplicate Its Own Name repoints only the diagrams whose `use` line
   * resolves to one copy); true when it changed something. Every diagram is
   * read in full when this is given.
   */
  mutate?(filePath: string, obj: Record<string, unknown>): boolean;
  /** The resolver to render with (default: the plan's). */
  resolver?: SubjectAreaResolver;
  /** Settle only the diagrams `mutate` changes. */
  mutatedOnly?: boolean;
}

/**
 * The replace writes of the settle (absolute paths), §2.6 steps 0–3. Throws
 * `DbmlEditRefused` for a diagram it cannot settle while the plan changes
 * the path of one of its members; leaves any other diagram it cannot
 * settle as it is, with a log line.
 */
export function settleDbmlDiagramWrites(input: SettleInput): FileWrite[] {
  const { plan } = input;
  if (!input.mutate && settlesNothing(plan)) return [];
  const signals = settleSignalsOf(plan);
  // The tables whose path changes, which make an unsettled diagram refuse: the plan's, and a
  // caller's resolver's own (Give Duplicate renames the copy outside the plan); never a created one.
  const refusing = { ...signals, pathChanged: new Set([...signals.pathChanged, ...[...input.resolver?.pathChanged ?? []].filter((n) => !signals.createdTables.has(n))]) };
  const resolver: SubjectAreaResolver = {
    ...(input.resolver ?? dbmlResolverOf(plan, input.semanticRoot)),
    refreshRelationshipsUses: true,
    keepLayoutIfConflicted: true,
  };
  const out: FileWrite[] = [];
  for (const filePath of input.diagrams) {
    const rel = relativeTo(input.semanticRoot, filePath);
    const summary = diagramSummaryForFile(rel, filePath, input.openText?.(filePath));
    if (summary === 'unreadable') continue;
    if (summary === null) {
      // A syntax error: settled by nothing, refused only when it names a table whose path changes.
      const text = input.readText(filePath);
      const oldPath = changedMemberPath(rel, text, null, refusing);
      if (text !== null && oldPath !== undefined) throw unsettledDiagramRefusal(rel, syntaxProblemOf(text, rel), oldPath);
      log.warn(`[ERD Studio] ${rel} left as it is: it does not read`);
      continue;
    }
    if (!input.mutate && !needsSettle(summary, signals)) continue;
    const original = input.readText(filePath);
    if (original === null) continue;
    const oldPath = changedMemberPath(rel, original, summary, refusing);
    try {
      const obj = parseSubjectAreaDbml(original, rel).obj;
      const before = structuredClone(obj);
      const mutated = input.mutate?.(filePath, obj) ?? false;
      if (!mutated && (input.mutatedOnly || !needsSettle(summary, signals))) continue;
      const text = renderDbmlDiagram(original, rel, before, obj, resolver);
      if (text !== original) out.push({ kind: 'replace', path: filePath, text });
    } catch (err) {
      if (oldPath !== undefined) throw unsettledDiagramRefusal(rel, problemOf(err, rel), oldPath);
      // Only its imports would change: a missing import hides a Ref from other tools, and doctor reports it.
      log.warn(`[ERD Studio] ${rel} left as it is: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
