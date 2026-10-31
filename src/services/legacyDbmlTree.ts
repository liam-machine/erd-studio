/**
 * The ERD Studio 1.9 pre-release's DBML tree (`tables/[f/]x.dbml`,
 * `tables/[f/]_relationships.dbml`, `<layer>/x.dbml` diagrams beside their
 * `.dbdiagram` layouts), which 2.0 does not read: whether a project holds
 * one ({@link detectLegacyDbmlTree}) and what to tell the user
 * ({@link legacyDbmlTreeMessage}). `doctor`, the activation toast, Convert
 * and the custom editor share it.
 *
 * Path-only and bounded: one listing of the semantic dir, one of each
 * top-level folder, and one of each folder of `tables/`. No file is read.
 * The verdict is memoised per semantic dir by the signatures of the
 * directories it listed, so a refresh of an unchanged project costs one
 * `stat` per listed directory (the {@link TableLibraryIndex} pattern).
 *
 * No `vscode`: the CLI bundles it.
 */

import * as fs from 'fs';
import * as path from 'path';

import { TABLES_DIR, isLibraryFolderName, legacyDbmlShapeOf } from '@erd-studio/core';
import { isRacyBuild, listDir } from './tableLibraryIndex';

/** The `doctor` next step for a 1.9 tree. */
export const LEGACY_DBML_TREE_NEXT_STEP = 'reconvert-dbml-project';

/** A 1.9 tree's files: every listed path of a 1.9 shape, semantic-relative posix, byte-sorted. */
export interface LegacyDbmlTree {
  files: string[];
}

/** Code-unit order (`<`). */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A directory's signature (inode and mtime), or `-` when it cannot be stat'ed. */
function dirSignature(dir: string): { sig: string; mtimeMs: number } {
  try {
    const stat = fs.statSync(dir);
    return { sig: `${stat.ino}:${stat.mtimeMs}`, mtimeMs: stat.mtimeMs };
  } catch {
    return { sig: '-', mtimeMs: 0 };
  }
}

interface Verdict {
  /** Every directory listed, with its signature taken just before the listing. */
  dirs: Array<{ dir: string; sig: string }>;
  /** A directory changed so close to the walk that its signature alone is not trusted. */
  racy: boolean;
  tree: LegacyDbmlTree | null;
}

const verdicts = new Map<string, Verdict>();

/** The walk, with the signature of each directory it listed. */
function walk(semanticRoot: string): Verdict {
  const startedAt = Date.now();
  const dirs: Array<{ dir: string; sig: string }> = [];
  let newest = 0;
  const list = (rel: string): ReturnType<typeof listDir> => {
    const dir = rel === '' ? semanticRoot : path.join(semanticRoot, ...rel.split('/'));
    const { sig, mtimeMs } = dirSignature(dir);
    dirs.push({ dir, sig });
    newest = Math.max(newest, mtimeMs);
    return listDir(dir);
  };

  const candidates: string[] = [];
  let verdict = false;
  const consider = (rel: string): void => {
    const shape = legacyDbmlShapeOf(rel);
    if (shape === undefined) return;
    candidates.push(rel);
    const segments = rel.split('/');
    if ((segments[0] === TABLES_DIR && rel.endsWith('.dbml')) || (segments.length === 2 && shape === 'layout')) verdict = true;
  };

  for (const top of list('') ?? []) {
    if (top.name.startsWith('.')) continue;
    if (top.file) {
      consider(top.name);
      continue;
    }
    if (!top.dir) continue;
    for (const entry of list(top.name) ?? []) {
      const rel = `${top.name}/${entry.name}`;
      if (entry.file) consider(rel);
      else if (top.name === TABLES_DIR && entry.dir && isLibraryFolderName(entry.name)) {
        for (const inner of list(rel) ?? []) if (inner.file) consider(`${rel}/${inner.name}`);
      }
    }
  }
  const tree = verdict ? { files: [...new Set(candidates)].sort(byteOrder) } : null;
  return { dirs, racy: isRacyBuild(newest, startedAt), tree };
}

/**
 * The 1.9 tree under `semanticRoot`, or null. A project is a 1.9 tree when
 * `tables/` holds a `.dbml` (at its top or one folder down), or a layer
 * folder holds a `.dbdiagram`; a lone `<d>/x.dbml` gives no verdict
 * (`doctor` warns about it on its own). `files` then lists every 1.9-shaped
 * file the walk saw (`legacyDbmlShapeOf`), for the message and Convert's
 * refusal. Memoised: see the module comment.
 */
export function detectLegacyDbmlTree(semanticRoot: string): LegacyDbmlTree | null {
  const held = verdicts.get(semanticRoot);
  if (held && !held.racy && held.dirs.every(({ dir, sig }) => dirSignature(dir).sig === sig)) {
    return held.tree;
  }
  const fresh = walk(semanticRoot);
  verdicts.set(semanticRoot, fresh);
  return fresh.tree;
}

/** Forget every memoised verdict (tests). */
export function clearLegacyDbmlTreeVerdicts(): void {
  verdicts.clear();
}

/** At most `limit` items, then `and N more`. */
function examples(files: readonly string[], limit: number): string {
  const shown = files.slice(0, limit);
  const rest = files.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/** What `doctor`, the toast and the custom editor say about a 1.9 tree (three example paths at most). */
export function legacyDbmlTreeMessage(tree: LegacyDbmlTree): string {
  return `This project's DBML files were written by an ERD Studio 1.9 pre-release, whose folder layout 2.0 does not read (${examples(tree.files, 3)}). `
    + 'Undo the conversion with git revert <the conversion commit>, or restore the YAML/JSON files from git and delete the 1.9 files '
    + '(the .dbml files under tables/, the <layer>/*.dbml diagrams and every .dbdiagram). '
    + 'Then run ERD Studio: Convert Project to DBML again. Edits made since the 1.9 conversion need to be made again.';
}

