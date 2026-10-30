/**
 * One file write an edit plans (native DBML storage, §4.1): replace a file's
 * text, create a new file, or delete one. Pure: no `vscode`, no file access,
 * so the CLI and the planners can name it. The editor applies these through
 * one WorkspaceEdit (`applyFileWrites`); non-editor paths through the fs
 * twin (`writeFilesWithRollback`).
 */
export type FileWrite =
  | { kind: 'replace'; path: string; text: string }
  | { kind: 'create'; path: string; text: string }
  | { kind: 'delete'; path: string };

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

/** What a write's file is, for ordering: relationships files, then tables (and diagrams), then anything else. */
function createRank(p: string): number {
  const name = pathKey(p).split('/').pop()?.toLowerCase() ?? '';
  if (name === '_relationships.dbml') return 0;
  if (name.endsWith('.dbml') || name.endsWith('.yml')) return 1;
  return 2;
}

/**
 * The order a set of writes is applied in (D23, §5.3 step 6): every create
 * first (relationships files before table files before anything else, so a
 * half-applied edit never leaves a table without its relationships file),
 * then every replace, then every delete. Stable within each group.
 */
export function orderFileWrites(writes: readonly FileWrite[]): FileWrite[] {
  const creates = writes
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.kind === 'create')
    .sort((a, b) => createRank(a.w.path) - createRank(b.w.path) || a.i - b.i)
    .map(({ w }) => w);
  return [
    ...creates,
    ...writes.filter((w) => w.kind === 'replace'),
    ...writes.filter((w) => w.kind === 'delete'),
  ];
}
