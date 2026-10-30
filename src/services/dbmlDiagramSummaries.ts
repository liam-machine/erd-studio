/**
 * DBML diagram summaries for the settle rule (ERD Studio 2.0): what each
 * diagram of the layer-first tree imports (members, relationships files,
 * other `use *` lines), read with a lex and parse alone, and the rule that
 * says whether an edit must rewrite it ({@link needsSettle}). An edit reads
 * every other diagram's summary; only the ones that need settling are read
 * in full.
 *
 * {@link diagramSummaryForFile} keeps one memo entry per diagram, keyed by
 * the open document's text or, for a closed file, its disk signature (mtime
 * and size), so an unchanged closed diagram is not even read again. No text
 * of a closed file is retained.
 *
 * No `vscode`: the CLI bundles the settle.
 */

import * as fs from 'fs';

import { diagramPathOf } from '@erd-studio/core';
import { diagramSummaryDbml } from '@erd-studio/core/dbml';

/** A diagram's imports, from {@link diagramSummaryOf}. */
export interface DiagramSummary {
  /** The diagram's path, semantic-relative posix. */
  rel: string;
  /** Its layer folder. */
  layer: string;
  /** Its `use` members, by file stem, in file order. */
  members: string[];
  /** Each member's `use` path, resolved (semantic-relative), in the same order. */
  memberPaths: string[];
  /** The relationships files it imports, resolved, in file order. */
  relationshipsUses: string[];
  /** Its other `use *` lines, resolved, in file order: kept by every writer, never members. */
  otherUses: string[];
  /** Its `erd_unlinked_tables` members (D26). */
  unlinked: string[];
}

/** A diagram's summary from its text (core's `diagramSummaryDbml`); null on a syntax error or a path that is not a diagram's. */
export function diagramSummaryOf(rel: string, text: string): DiagramSummary | null {
  const where = diagramPathOf(rel);
  if (where === undefined) return null;
  const summary = diagramSummaryDbml(text, rel);
  if (summary === null) return null;
  return {
    rel,
    layer: where.layer,
    members: summary.members,
    memberPaths: summary.memberUses.map((u) => u.resolved),
    relationshipsUses: summary.relationshipsUses,
    otherUses: summary.otherUses,
    unlinked: summary.unlinked,
  };
}

/** The memo: one entry per diagram path. */
const memo = new Map<string, { key: string; summary: DiagramSummary | null }>();

/** A closed file's signature (`mtime:size`), or null when it cannot be stat'ed. */
function diskSignature(absPath: string): string | null {
  try {
    const stat = fs.statSync(absPath);
    return stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : null;
  } catch {
    return null;
  }
}

/**
 * The summary of the diagram `rel` (semantic-relative), whose file is
 * `absPath`: from `openText` when the diagram is open in an editor, else
 * from disk. `'unreadable'` when a closed file cannot be stat'ed or read;
 * null on a syntax error. Memoised per `rel` (see the module comment).
 */
export function diagramSummaryForFile(rel: string, absPath: string, openText?: string): DiagramSummary | null | 'unreadable' {
  let key: string;
  if (openText !== undefined) {
    key = `text\u0000${openText}`;
  } else {
    const signature = diskSignature(absPath);
    if (signature === null) {
      memo.delete(rel);
      return 'unreadable';
    }
    key = `disk\u0000${signature}`;
  }
  const held = memo.get(rel);
  if (held && held.key === key) return held.summary;
  let text: string;
  if (openText !== undefined) {
    text = openText;
  } else {
    try {
      text = fs.readFileSync(absPath, 'utf-8');
    } catch {
      memo.delete(rel);
      return 'unreadable';
    }
  }
  const summary = diagramSummaryOf(rel, text);
  memo.set(rel, { key, summary });
  return summary;
}

/** Forget every memoised summary (tests; a project closed). */
export function clearDiagramSummaries(): void {
  memo.clear();
}

/** How many diagrams the memo holds (tests). */
export function diagramSummaryMemoSize(): number {
  return memo.size;
}

/** What an edit changes, as the settle rule reads it (every name lower-case). */
export interface SettleSignals {
  /** Tables whose path changes: old and new names of a renamed or moved table, and deleted ones. */
  pathChanged: ReadonlySet<string>;
  /** Tables the edit creates. */
  createdTables: ReadonlySet<string>;
  /** Tables whose schema changes. */
  requalified: ReadonlySet<string>;
  /** Table pairs (`pairKey`) whose holding relationships files change. */
  changedPairs: ReadonlySet<string>;
  /** The relationships files a diagram showing `members` imports after the edit, given its imports now. */
  importsFor(members: readonly string[], current: readonly string[]): string[];
}

/**
 * Whether an edit must rewrite a diagram it is not editing (§2.6 step 2):
 * (a) a member or unlinked table is renamed, moved, deleted, created or
 * re-qualified; or (b) a table pair whose holding files change has both
 * ends among its `use` members, and the relationships files it should
 * import differ, as a set, from the ones it imports.
 */
export function needsSettle(summary: DiagramSummary, signals: SettleSignals): boolean {
  const names = [...summary.members, ...summary.unlinked].map((n) => n.toLowerCase());
  const touched = (n: string): boolean => signals.pathChanged.has(n) || signals.createdTables.has(n) || signals.requalified.has(n);
  if (names.some(touched)) return true;
  if (signals.changedPairs.size === 0 || summary.members.length === 0) return false;
  const members = new Set(summary.members.map((n) => n.toLowerCase()));
  let pairAmongMembers = false;
  for (const key of signals.changedPairs) {
    const [a, b] = key.split('\u0000');
    if (members.has(a) && members.has(b ?? a)) {
      pairAmongMembers = true;
      break;
    }
  }
  if (!pairAmongMembers) return false;
  const wanted = new Set(signals.importsFor(summary.members, summary.relationshipsUses));
  const current = new Set(summary.relationshipsUses);
  return wanted.size !== current.size || [...wanted].some((f) => !current.has(f));
}
