/**
 * `erd-studio changes --base <git-ref>` — how the ERD Studio model changed
 * between a git ref and the working tree, for a pull-request comment:
 * tables added, removed, renamed, moved and changed (columns, types, keys,
 * alias, role, grain), relationships added, removed and with a new
 * cardinality, diagrams added, removed and with tables added or removed,
 * and each DBML relationships file's Refs added and removed.
 *
 * Read-only like every subcommand. The base version is read from git
 * objects (`git ls-tree` lists the semantic dir at the ref, `git cat-file
 * --batch` prints those blobs — the bytes `git show <ref>:<path>` prints);
 * nothing is checked out, stashed or written, and no temporary copy is
 * made. The working tree is read from disk with `listSemanticFiles`, the
 * walk `doctor` uses. Both sides go through `readModelSnapshot` and are
 * compared by the pure `diffModelSnapshots`.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { redactPaths } from '../types/feedback';
import { hasDbtProjectFile } from '../services/projectDiscovery';
import { tablesDirIsLayer } from '../services/logicalModelService';
import { listSemanticFiles } from '../services/semanticFiles';
import { CliEnvError, makeEnvelope, requireProjectRoot, type Envelope } from './context';
import { diffModelSnapshots, hasModelChanges, type ModelChanges } from './modelChanges';
import { readModelSnapshot, type ModelSnapshot } from './modelSnapshot';

/** The deepest file read, in path segments under the semantic dir (as `listSemanticFiles`). */
const MAX_DEPTH = 5;

/** Largest output read from one git command. */
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

export interface ChangesOptions {
  project?: string;
  semanticDir: string;
  /** `--base`: a branch, tag or commit. */
  base: string;
  cwd?: string;
}

/** The `--json` shape. Paths are project-relative with forward slashes. */
export interface ChangesResult extends Envelope, ModelChanges {
  base: { ref: string; commit: string };
  /** What the base is compared with: always the files on disk. */
  head: 'working-tree';
  /** Anything changed at all. */
  changed: boolean;
  summary: {
    tablesAdded: number;
    tablesRemoved: number;
    tablesRenamed: number;
    tablesMoved: number;
    tablesChanged: number;
    relationshipsAdded: number;
    relationshipsRemoved: number;
    relationshipsChanged: number;
    diagramsAdded: number;
    diagramsRemoved: number;
    diagramsChanged: number;
    relationshipsFilesChanged: number;
  };
  /** Files that could not be read on either side: their tables, Refs or members are left out of the comparison. */
  problems: Array<{ side: 'base' | 'head'; file: string; message: string }>;
}

/** Run git in `root` and return its stdout. A failure is a `CliEnvError`. */
function git(root: string, args: string[], opts: { input?: Buffer; code: string; message: (stderr: string) => string }): Buffer {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      input: opts.input,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    if (e.code === 'ENOENT') {
      throw new CliEnvError('git-missing', 'git was not found on PATH: changes reads the base version with git.');
    }
    throw new CliEnvError(opts.code, opts.message(e.stderr ? e.stderr.toString('utf8').trim() : ''));
  }
}

/** Whether a path under the semantic dir is one `listSemanticFiles` would list: no dot or `node_modules` segment, at most five deep. */
function listable(rel: string): boolean {
  const segments = rel.split('/');
  return segments.length <= MAX_DEPTH && segments.every((s) => s !== '' && !s.startsWith('.') && s !== 'node_modules');
}

/**
 * The semantic dir at `commit`: each file (relative to the semantic dir)
 * and its blob, from `git ls-tree`. Symbolic links and submodules are left
 * out, as the walk of the working tree leaves out linked folders.
 */
function listAtCommit(root: string, semanticDir: string, commit: string): Map<string, string> {
  const out = git(root, ['ls-tree', '-r', '-z', commit, '--', `${semanticDir}/`], {
    code: 'git-failed',
    message: (stderr) => `git ls-tree failed: ${stderr || 'no output'}`,
  }).toString('utf8');
  const prefix = `${semanticDir}/`;
  const files = new Map<string, string>();
  for (const entry of out.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    const [mode, type, object] = entry.slice(0, tab).split(' ');
    const file = entry.slice(tab + 1);
    if (type !== 'blob' || mode === '120000' || !file.startsWith(prefix)) continue;
    const rel = file.slice(prefix.length);
    if (listable(rel)) files.set(rel, object);
  }
  return files;
}

/** Every blob's text in one `git cat-file --batch` run. */
function readBlobs(root: string, objects: readonly string[]): Map<string, string> {
  const texts = new Map<string, string>();
  const unique = [...new Set(objects)];
  if (unique.length === 0) return texts;
  const out = git(root, ['cat-file', '--batch'], {
    input: Buffer.from(unique.join('\n') + '\n', 'utf8'),
    code: 'git-failed',
    message: (stderr) => `git cat-file failed: ${stderr || 'no output'}`,
  });
  let at = 0;
  while (at < out.length) {
    const eol = out.indexOf(0x0a, at);
    if (eol === -1) break;
    const header = out.subarray(at, eol).toString('utf8').split(' ');
    at = eol + 1;
    if (header.length < 3 || header[1] === 'missing') continue;
    const size = Number(header[2]);
    if (!Number.isFinite(size)) break;
    texts.set(header[0], out.subarray(at, at + size).toString('utf8'));
    at += size + 1;
  }
  return texts;
}

/** The model at `commit`. */
function snapshotAtCommit(root: string, semanticDir: string, commit: string): ModelSnapshot {
  const listing = listAtCommit(root, semanticDir, commit);
  const wanted = [...listing].filter(([rel]) => rel.endsWith('.dbml') || rel.endsWith('.yml') || rel.endsWith('.json'));
  const blobs = readBlobs(root, wanted.map(([, object]) => object));
  return readModelSnapshot([...listing.keys()], (rel) => {
    const object = listing.get(rel);
    return object === undefined ? null : blobs.get(object) ?? null;
  });
}

/** The model in the working tree. */
function snapshotOnDisk(root: string, semanticDir: string): ModelSnapshot {
  const semanticRoot = path.join(root, semanticDir);
  const files = listSemanticFiles(semanticRoot, { tablesDirIsLayer: tablesDirIsLayer(semanticRoot) }).map((f) => f.rel);
  return readModelSnapshot(files, (rel) => {
    try {
      return fs.readFileSync(path.join(semanticRoot, ...rel.split('/')), 'utf8');
    } catch {
      return null;
    }
  });
}

/** `changes` with every path made project-relative (`<semanticDir>/<rel>`). */
function withProjectPaths(changes: ModelChanges, semanticDir: string): ModelChanges {
  const p = (rel: string): string => (rel === '' ? '' : `${semanticDir}/${rel}`);
  const at = <T extends { file: string }>(x: T): T => ({ ...x, file: p(x.file) });
  return {
    tables: {
      added: changes.tables.added.map(at),
      removed: changes.tables.removed.map(at),
      renamed: changes.tables.renamed.map(at),
      moved: changes.tables.moved.map((m) => ({ ...m, from: at(m.from), to: at(m.to) })),
      changed: changes.tables.changed.map(at),
    },
    relationships: {
      added: changes.relationships.added.map(at),
      removed: changes.relationships.removed.map(at),
      changed: changes.relationships.changed.map(at),
    },
    diagrams: {
      added: changes.diagrams.added.map(at),
      removed: changes.diagrams.removed.map(at),
      changed: changes.diagrams.changed.map((d) => ({ ...at(d), ...(d.movedFrom ? { movedFrom: p(d.movedFrom) } : {}) })),
    },
    relationshipsFiles: changes.relationshipsFiles.map(at),
  };
}

/**
 * Compare the model at `opts.base` with the working tree. A folder outside
 * git, an unknown ref or a missing git is a `CliEnvError` (exit 3).
 */
export function runChanges(opts: ChangesOptions): ChangesResult {
  const root = requireProjectRoot(opts.project, opts.cwd, opts.semanticDir);
  git(root, ['rev-parse', '--is-inside-work-tree'], {
    code: 'not-a-git-repo',
    message: () => 'The project folder is not in a git repository: changes compares a git ref with the working tree.',
  });
  const commit = git(root, ['rev-parse', '--verify', '--quiet', `${opts.base}^{commit}`], {
    code: 'unknown-ref',
    message: () => `git knows no commit called "${opts.base}". Pass a branch, tag or commit, e.g. --base origin/main.`,
  }).toString('utf8').trim();

  const base = snapshotAtCommit(root, opts.semanticDir, commit);
  const head = snapshotOnDisk(root, opts.semanticDir);
  const changes = withProjectPaths(diffModelSnapshots(base, head), opts.semanticDir);
  const problems = [
    ...base.problems.map((pr) => ({ side: 'base' as const, file: `${opts.semanticDir}/${pr.file}`, message: redactPaths(pr.message) })),
    ...head.problems.map((pr) => ({ side: 'head' as const, file: `${opts.semanticDir}/${pr.file}`, message: redactPaths(pr.message) })),
  ];
  return {
    ...makeEnvelope(root, opts.semanticDir, hasDbtProjectFile(root)),
    base: { ref: opts.base, commit },
    head: 'working-tree',
    changed: hasModelChanges(changes),
    summary: {
      tablesAdded: changes.tables.added.length,
      tablesRemoved: changes.tables.removed.length,
      tablesRenamed: changes.tables.renamed.length,
      tablesMoved: changes.tables.moved.length,
      tablesChanged: changes.tables.changed.length,
      relationshipsAdded: changes.relationships.added.length,
      relationshipsRemoved: changes.relationships.removed.length,
      relationshipsChanged: changes.relationships.changed.length,
      diagramsAdded: changes.diagrams.added.length,
      diagramsRemoved: changes.diagrams.removed.length,
      diagramsChanged: changes.diagrams.changed.length,
      relationshipsFilesChanged: changes.relationshipsFiles.length,
    },
    ...changes,
    problems,
  };
}
