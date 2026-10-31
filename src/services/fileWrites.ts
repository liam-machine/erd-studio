/**
 * One file write an edit plans (native DBML storage, §4.1): replace a file's
 * text, create a new file, or delete one. Pure: no `vscode`, no file access,
 * so the CLI and the planners can name it. The editor applies these through
 * one WorkspaceEdit (`applyFileWrites`); non-editor paths through the fs
 * twin (`writeFilesWithRollback`).
 */

import { classifySemanticFile } from '@erd-studio/core';

export type FileWrite =
  | { kind: 'replace'; path: string; text: string }
  | { kind: 'create'; path: string; text: string }
  | { kind: 'delete'; path: string };

/** A file a planned write would change is open with unsaved edits; nothing was written. Absolute paths. */
export class UnsavedFilesRefused extends Error {
  constructor(readonly filePaths: readonly string[]) {
    super(`${filePaths.length} file(s) have unsaved changes.`);
    this.name = 'UnsavedFilesRefused';
  }
}

/** A write planned twice for one path that cannot be merged (a planner bug, never a user's mistake). */
export class FileWriteConflict extends Error {
  constructor(readonly path: string) {
    super(`ERD Studio planned two different writes to ${path}; nothing was changed.`);
    this.name = 'FileWriteConflict';
  }
}

/** A path compared as the file system would (separators unified; case kept: two spellings are two files on Linux). */
function pathKey(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * `writes` with each path written once (§4.6 step 7). The same write twice
 * is kept once; a replace and a create of one path with the same text is
 * one write; anything else on one path (two texts, a write and a delete) is
 * a {@link FileWriteConflict}. Order is kept (first occurrence).
 */
export function mergeFileWrites(writes: readonly FileWrite[]): FileWrite[] {
  const out: FileWrite[] = [];
  const byPath = new Map<string, FileWrite>();
  for (const write of writes) {
    const key = pathKey(write.path);
    const held = byPath.get(key);
    if (!held) {
      byPath.set(key, write);
      out.push(write);
      continue;
    }
    if (held.kind === 'delete' && write.kind === 'delete') continue;
    if (held.kind !== 'delete' && write.kind !== 'delete' && held.text === write.text && held.kind === write.kind) continue;
    throw new FileWriteConflict(write.path);
  }
  return out;
}

/**
 * What a create's file is, for ordering (§2.8 Create order): tables 0,
 * relationships files 1, diagrams 2, the README 3, anything else 4, by
 * `classifySemanticFile` of the path relative to `semanticRoot` (so a
 * schema folder named `relationships` still ranks as a table). Without a
 * semantic dir, or for a path outside it, a `.yml` or `.dbml` is 0 and
 * anything else 4.
 */
function createRank(p: string, semanticRoot: string | undefined): number {
  const file = pathKey(p);
  if (semanticRoot !== undefined) {
    const root = pathKey(semanticRoot).replace(/\/+$/, '');
    if (file.startsWith(`${root}/`)) {
      switch (classifySemanticFile(file.slice(root.length + 1), { tablesDirIsLayer: false }).kind) {
        case 'table': return 0;
        case 'relationships': return 1;
        case 'diagram': return 2;
        case 'readme': return 3;
        default: return 4;
      }
    }
  }
  const name = file.split('/').pop()?.toLowerCase() ?? '';
  return name.endsWith('.dbml') || name.endsWith('.yml') ? 0 : 4;
}

/**
 * The order a set of writes is applied in (D23, §2.8): every create first
 * (tables, then relationships files, which `use` tables, then diagrams,
 * which `use` both, then the README, then anything else, so a half-applied
 * edit never leaves a `use` line pointing at a file not yet written), then
 * every replace, then every delete. Stable within each group and rank.
 * `semanticRoot` (absolute, as the writes' paths are) lets the rank read
 * each path as the tree classifies it.
 */
export function orderFileWrites(writes: readonly FileWrite[], semanticRoot?: string): FileWrite[] {
  const creates = writes
    .map((w, i) => ({ w, i, rank: w.kind === 'create' ? createRank(w.path, semanticRoot) : 0 }))
    .filter(({ w }) => w.kind === 'create')
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ w }) => w);
  return [
    ...creates,
    ...writes.filter((w) => w.kind === 'replace'),
    ...writes.filter((w) => w.kind === 'delete'),
  ];
}
