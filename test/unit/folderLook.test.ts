/**
 * #347 acceptance: the one look at an open folder (`src/services/folderLook.ts`)
 * that the start screen's suggestion, Import…, the quick imports and
 * activation's dbt project search all read. Git's index first (one file read,
 * whatever the folder count), then one bounded walk for what git does not
 * know; nobody's deadline stops it, and no folder is listed twice.
 *
 * Each `describe` pins one acceptance criterion of the issue. Real temporary
 * folders (and, where a criterion is about what git itself writes, a real
 * repository: skipped where git is not installed) wherever the criterion is
 * about the disk; an in-memory disk wherever it is about how many listings
 * were made or when. The answers are checked against the walks this service
 * replaces, which are still in the code base: `listImportFiles` for import
 * files and `findDbtProjectsBelow` for dbt projects.
 *
 * Several tests here found a defect in the service's first version (noted
 * above each as "Was a bug"): they pin the fix.
 */

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  detectImportFindings,
  folderStartLook,
  vscodeDetectImportIo,
  vscodeFindImportDbmlFile,
  vscodeImportModelDeps,
  type ImportFindings,
} from '../../src/commands/importModel';
import { START_LOOK_TIMEOUT_MS, StartIntentTracker, type StartIntentDeps } from '../../src/commands/startIntent';
import {
  DBT_SEARCH_MAX_DEPTH,
  DBT_SEARCH_MAX_DIRS,
  DBT_SEARCH_SKIP_DIRS,
  HIDDEN_TOOL_DIRS,
  findDbtProjectsBelow,
  sortDbtCandidates,
} from '../../src/services/dbtProjectSearch';
import {
  FOLDER_LOOK_FRESH_MS,
  FOLDER_LOOK_MAX_FOLDERS,
  FOLDER_LOOK_MAX_MS,
  FolderLooks,
  type FolderLooksOptions,
} from '../../src/services/folderLook';
import { nodeReadDirEntries, nodeScanReader, type ScanEntry, type ScanReader } from '../../src/services/folderScan';
import type { GitIndexLocation, GitIndexReadOptions, GitIndexResult } from '../../src/services/gitIndex';
import {
  IGNORED_IMPORT_FOLDERS,
  IMPORT_WALK_MAX_DEPTH,
  listImportFiles,
  type DirEntries,
  type ImportListing,
} from '../../src/services/importSources';
import { findDbtProjectCandidates } from '../../src/services/projectDiscovery';
import type { StartIntent } from '../../src/types/startActions';

// ── Folders, files, cleaning up ─────────────────────────────────────────────

const SEMANTIC_DIR = '.erd-studio';
const CREATE_TABLE = 'CREATE TABLE customer (\n  id INT PRIMARY KEY,\n  name TEXT\n);\n';
const DBML = 'Table orders {\n  id int [pk]\n}\n';

/** Undone after each test, last made first: looks and trackers are disposed before their folder is removed. */
const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch { /* best effort */ }
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-look-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

function write(root: string, rel: string, text = ''): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function remove(root: string, rel: string): void {
  fs.rmSync(path.join(root, ...rel.split('/')), { recursive: true, force: true });
}

/** Every file under `root` (never inside `.git`), as `/`-joined paths under it. */
function allFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== '.git') out.push(...allFiles(root, child));
    } else {
      out.push(child);
    }
  }
  return out;
}

/** A path under `root` as every listing spells it: joined with `/`. */
const under = (root: string) => (rel: string): string => `${root}/${rel}`;

function looksOf(options: Partial<FolderLooksOptions> = {}): FolderLooks {
  const looks = new FolderLooks({ semanticDir: SEMANTIC_DIR, ...options });
  cleanups.push(() => looks.dispose());
  return looks;
}

function trackerOf(deps: StartIntentDeps): StartIntentTracker {
  const tracker = new StartIntentTracker(deps);
  cleanups.push(() => tracker.dispose());
  return tracker;
}

/** Lets everything already queued run: timers that are due, then `setImmediate`. */
async function turn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setImmediate(resolve));
}

/** Waits (polling) until `check` holds. */
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

const depthOf = (rel: string): number => (rel === '' ? 0 : rel.split('/').length);

/** `['a', 'b', 'c']` as `['a', 'a/b', 'a/b/c']`. */
const chainOf = (names: readonly string[]): string[] => names.map((_, i) => names.slice(0, i + 1).join('/'));

// ── The answers of the walks this service replaces ──────────────────────────

/** The old walk-only listing: the reference answer for import files. */
const oldListing = (root: string, semanticDir = SEMANTIC_DIR): Promise<ImportListing> =>
  listImportFiles(root, (folder) => nodeReadDirEntries(folder), { semanticDir });

/** The sources and the dbt flag of a look's findings, comparable. */
const plain = (findings: ImportFindings): { sources: string[]; dbtProject: boolean } => ({
  sources: [...findings.sources].sort(),
  dbtProject: findings.dbtProject === true,
});

/** The old look: `listImportFiles` over the folder, then the bounded reads. */
const oldFindings = async (root: string, semanticDir = SEMANTIC_DIR): Promise<{ sources: string[]; dbtProject: boolean }> =>
  plain(await detectImportFindings(vscodeDetectImportIo(root), semanticDir));

/** The same bounded reads over a listing the shared look gave. */
const findingsOver = async (root: string, listing: ImportListing, semanticDir = SEMANTIC_DIR): Promise<{ sources: string[]; dbtProject: boolean }> =>
  plain(await detectImportFindings(vscodeDetectImportIo(root, undefined, async () => listing), semanticDir));

const EMPTY_LISTING: ImportListing = { sql: [], dbml: [], semanticModel: [], dbtProject: false, truncated: false };

// ── Readers that count ──────────────────────────────────────────────────────

/** How long a listing takes: milliseconds, never, or until a promise settles. */
type Wait = number | 'never' | Promise<void> | undefined;

async function waitFor(wait: Wait): Promise<void> {
  if (wait === 'never') await new Promise<never>(() => undefined);
  else if (typeof wait === 'number') { if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait)); }
  else if (wait) await wait;
}

/** A path's part under `root` (`''` for the root itself), whatever separator follows the root. */
function relOf(root: string, fullPath: string): string {
  if (!fullPath.startsWith(root)) throw new Error(`Not under the root: ${fullPath}`);
  return fullPath.slice(root.length).replace(/^[\\/]+/, '');
}

/**
 * A reader that records every listing asked of it (by the folder's path under
 * the root), how many answered and the most in flight at once, over the real
 * disk or an in-memory one, optionally slowed.
 */
class CountingReader implements ScanReader {
  /** Every folder listed, as its path under the root, in the order asked. */
  readonly listed: string[] = [];
  answered = 0;
  inFlight = 0;
  maxInFlight = 0;

  constructor(
    private readonly root: string,
    private readonly inner: ScanReader = nodeScanReader,
    private readonly wait: (rel: string) => Wait = () => undefined,
  ) {}

  async readDir(folder: string): Promise<readonly ScanEntry[]> {
    const rel = relOf(this.root, folder);
    this.listed.push(rel);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await waitFor(this.wait(rel));
      const entries = await this.inner.readDir(folder);
      this.answered++;
      return entries;
    } finally {
      this.inFlight--;
    }
  }

  resolveLink(linkPath: string): Promise<{ isDirectory: boolean; realPath: string } | undefined> {
    return this.inner.resolveLink(linkPath);
  }

  realPath(folder: string): Promise<string> {
    return this.inner.realPath(folder);
  }
}

const FILE = 'file' as const;
interface Dir { [name: string]: TreeNode }
/** A folder made when it is listed, so a tree of millions of folders costs nothing until it is walked. */
type LazyDir = () => Dir;
type TreeNode = typeof FILE | Dir | LazyDir;

/** A root that is on no disk: nothing under it can be read, only listed. */
const MEMORY_ROOT = '/erd-look-in-memory';

/** An in-memory disk (no links). */
class MemoryDisk implements ScanReader {
  constructor(private readonly tree: Dir | LazyDir, private readonly root: string = MEMORY_ROOT) {}

  private dirAt(rel: string): Dir | undefined {
    let node: TreeNode | undefined = this.tree;
    for (const part of rel === '' ? [] : rel.split('/')) {
      if (typeof node === 'function') node = node();
      if (!node || node === FILE) return undefined;
      node = node[part];
    }
    if (typeof node === 'function') node = node();
    return node && node !== FILE ? node : undefined;
  }

  /** One folder as the old walk reads it: a name and whether it is a folder. */
  entries(folder: string): DirEntries {
    const dir = this.dirAt(relOf(this.root, folder));
    if (!dir) throw new Error(`ENOENT: ${folder}`);
    return Object.entries(dir).map(([name, node]) => [name, node !== FILE] as const);
  }

  /** Whether a file is at this path. */
  hasFile(filePath: string): boolean {
    const rel = relOf(this.root, filePath);
    const cut = rel.lastIndexOf('/');
    const dir = this.dirAt(cut < 0 ? '' : rel.slice(0, cut));
    return dir !== undefined && dir[rel.slice(cut + 1)] === FILE;
  }

  async readDir(folder: string): Promise<readonly ScanEntry[]> {
    return this.entries(folder).map(([name, isDirectory]): ScanEntry => ({ name, kind: isDirectory ? 'dir' : 'file' }));
  }

  async resolveLink(): Promise<undefined> {
    return undefined;
  }

  async realPath(folder: string): Promise<string> {
    return folder;
  }
}

/**
 * `fanOut` folders (`d0`, `d1`, …) in every folder, `depth` levels down, and no file a look is after,
 * but for `extra`: more entries for the folders it names (by their path under the root).
 */
function wide(fanOut: number, depth: number, extra: Readonly<Record<string, Dir>> = {}, rel = ''): LazyDir {
  return () => {
    const dir: Dir = { 'readme.txt': FILE, ...extra[rel] };
    if (depth > 0) {
      for (let i = 0; i < fanOut; i++) dir[`d${i}`] = wide(fanOut, depth - 1, extra, rel === '' ? `d${i}` : `${rel}/d${i}`);
    }
    return dir;
  };
}

/** No repository: the walk alone answers. And no file is on a disk that is only in memory. */
const noGit = { findGitIndex: async (): Promise<undefined> => undefined };
const noFiles = { fileExists: async (): Promise<boolean> => false };

/** An index stage handed in: the folder is a repository whose index lists `paths` (the folders are worked out). */
function indexOf(root: string, paths: readonly string[]): {
  findGitIndex: () => Promise<GitIndexLocation>;
  readGitIndex: () => Promise<GitIndexResult>;
} {
  const dirs = new Set<string>();
  for (const file of paths) {
    const parts = file.split('/').slice(0, -1);
    chainOf(parts).forEach((dir) => dirs.add(dir));
  }
  return {
    findGitIndex: async () => ({ workTree: root, gitDir: `${root}/.git`, indexPath: `${root}/.git/index` }),
    readGitIndex: async () => ({ ok: true, paths: [...paths], dirs, entries: paths.length, version: 2, split: false }),
  };
}

// ── Git: the real one, and an index written without it ──────────────────────

/** An empty git configuration, so nobody's own settings (index version, ignore file) change what the tests write. */
const gitHome = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-look-git-'));
fs.writeFileSync(path.join(gitHome, 'gitconfig'), '');
afterAll(() => fs.rmSync(gitHome, { recursive: true, force: true, maxRetries: 3 }));

/** The environment without any `GIT_*` of a caller (a hook's `GIT_INDEX_FILE` would point `git add` at another index). */
const GIT_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  return { ...env, GIT_CONFIG_GLOBAL: path.join(gitHome, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
})();

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** A real repository at `root` tracking `tracked` (default: every file; `-f`, so an ignore file changes nothing). */
function gitRepo(root: string, tracked?: readonly string[]): void {
  git(root, 'init', '-q');
  if (tracked === undefined) git(root, 'add', '-f', '-A');
  else if (tracked.length > 0) git(root, 'add', '-f', '--', ...tracked);
}

/**
 * A version 2 index file's bytes listing `paths` as regular files: the header
 * (`DIRC`, 2, the count), each entry (stat fields, a 20-byte id, the name
 * length, the path, NULs to a multiple of 8) in path order, and the SHA-1 of
 * it all. What `git add` writes, without git.
 */
function buildIndex(paths: readonly string[]): Buffer {
  const names = [...new Set(paths)].map((p) => Buffer.from(p, 'utf8')).sort(Buffer.compare);
  const header = Buffer.alloc(12);
  header.write('DIRC', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(names.length, 8);
  const chunks = [header];
  for (const name of names) {
    const entry = Buffer.alloc((62 + name.length + 8) & ~7);
    entry.writeUInt32BE(0o100644, 24);
    // The id of the empty blob.
    Buffer.from('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', 'hex').copy(entry, 40);
    entry.writeUInt16BE(Math.min(name.length, 0xfff), 60);
    name.copy(entry, 62);
    chunks.push(entry);
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, crypto.createHash('sha1').update(body).digest()]);
}

const indexPathOf = (root: string): string => path.join(root, '.git', 'index');

/** Makes `root` a repository (a `.git` folder holding only an index) tracking `tracked`, without git. */
function builtRepo(root: string, tracked: readonly string[]): void {
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(indexPathOf(root), buildIndex(tracked));
}

describe('the test index builder', () => {
  it.skipIf(!hasGit)('writes an index that git itself reads', () => {
    const root = tmpDir();
    const paths = ['z.sql', 'a/b/c.sql', 'a/b.sql', 'a.b/c.sql', 'Ünïcode/dbt_project.yml', 'db/schema.sql'];
    git(root, 'init', '-q');
    fs.writeFileSync(indexPathOf(root), buildIndex(paths));
    const listed = git(root, 'ls-files', '-z').split('\0').filter(Boolean);
    expect(listed).toEqual([...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  });
});

// ── 1. In a git repository the look answers from the index ──────────────────

describe('1. in a git repository the look answers from the index without a folder listing', () => {
  /** A repository tracking `db/schema.sql`, read with a reader whose listings never answer. */
  function repoThatNeverLists(): { root: string; reader: CountingReader; looks: FolderLooks } {
    const root = tmpDir();
    write(root, 'README.md', '# A repository\n');
    write(root, 'db/schema.sql', CREATE_TABLE);
    builtRepo(root, ['README.md', 'db/schema.sql']);
    const reader = new CountingReader(root, nodeScanReader, () => 'never');
    return { root, reader, looks: looksOf({ io: { reader } }) };
  }

  it('says what it found (early) while the look itself is still pending, and no listing has answered', async () => {
    const { root, reader, looks } = repoThatNeverLists();
    const early: ImportFindings[] = [];
    const counted: string[] = [];
    let settled = false;
    const look = folderStartLook(looks, root, SEMANTIC_DIR, { feature: (key) => { counted.push(key); } });
    void look(new AbortController().signal, (findings) => { early.push(findings); }).finally(() => { settled = true; });

    await until(() => early.length > 0);
    expect([...early[0].sources]).toEqual(['sqlDdl']);
    // The walk has started on the root, and that listing never answers.
    await until(() => reader.listed.length > 0);
    await turn();
    expect(settled).toBe(false);
    expect(reader.listed).toEqual(['']);
    expect(reader.answered).toBe(0);
    expect(counted).toEqual(['startLookFromIndex']);

    const run = looks.run(root);
    const stage = await run.index;
    expect(stage).toEqual({
      usable: true,
      listing: { ...EMPTY_LISTING, sql: [`${root}/db/schema.sql`] },
      dbtDirs: [],
    });
    // What is known now is the index's files: the walk has been nowhere.
    expect(run.listingSoFar().sql).toEqual([`${root}/db/schema.sql`]);
    expect(run.stats()).toEqual({ folders: 1, finished: false, capped: false });
  });

  it('gives the start screen its suggestion within the settle time: no deadline is waited for', async () => {
    const { root, reader, looks } = repoThatNeverLists();
    const published: StartIntent[] = [];
    const counted: string[] = [];
    const tracker = trackerOf({
      context: () => ({ hasProject: true, hasDbt: false }),
      look: folderStartLook(looks, root, SEMANTIC_DIR),
      publish: (intent) => { published.push(intent); },
      feature: (key) => { counted.push(key); },
      settleMs: 25,
    });
    const started = Date.now();
    const intent = await tracker.refresh();
    const took = Date.now() - started;

    expect(intent).toBe('importSqlDdl');
    expect(published).toEqual(['importSqlDdl']);
    // The first mark (1.5 s) never came into it: the index answered, then the settle time passed.
    expect(took).toBeLessThan(START_LOOK_TIMEOUT_MS);
    expect(counted).toEqual([]);
    expect(reader.answered).toBe(0);
  });

  it.skipIf(!hasGit)('reads the index git itself wrote', async () => {
    const root = tmpDir();
    write(root, 'db/schema.sql', CREATE_TABLE);
    write(root, 'notes/untracked.sql', CREATE_TABLE);
    gitRepo(root, ['db/schema.sql']);
    const reader = new CountingReader(root, nodeScanReader, () => 'never');
    const stage = await looksOf({ io: { reader } }).run(root).index;
    expect(stage).toEqual({ usable: true, listing: { ...EMPTY_LISTING, sql: [`${root}/db/schema.sql`] }, dbtDirs: [] });
    expect(reader.listed).toEqual([]);
  });
});

// ── 2. No usable index: the same answer as the walk alone ───────────────────

describe('2. an index the reader does not understand, or no repository, gives the same answer as the walk alone', () => {
  function fixture(root: string): void {
    write(root, 'schema.sql', CREATE_TABLE); // depth 0
    write(root, 'REPORT.SQL', 'SELECT 1;\n'); // an upper-case ending
    write(root, 'a/b/c/deep.sql', CREATE_TABLE); // depth 3
    write(root, 'design/model.dbml', DBML);
    write(root, 'pbi/Sales.SemanticModel/model.bim', '{}');
    write(root, 'tabular/with/database.json', '{}'); // a model: tables/ beside it
    write(root, 'tabular/with/tables/Sales.json', '{}');
    write(root, 'tabular/without/database.json', '{}'); // not a model
    write(root, 'node_modules/pkg/skipped.sql', CREATE_TABLE);
    write(root, 'target/run/skipped.sql', CREATE_TABLE);
    write(root, `${SEMANTIC_DIR}/x.dbml`, DBML); // ERD Studio's own folder
    write(root, '.devcontainer/initdb/a.sql', CREATE_TABLE); // hidden, not ignored
    write(root, 'analytics/dbt_project.yml', "name: 'analytics'\n");
  }

  const SQL = ['.devcontainer/initdb/a.sql', 'REPORT.SQL', 'a/b/c/deep.sql', 'schema.sql'];
  const DBML_FILES = ['design/model.dbml'];
  const MODELS = ['pbi/Sales.SemanticModel/model.bim', 'tabular/with/database.json'];

  /** The fixture tree three ways (and a fourth: an index of a version nobody reads). `makeRepo` tracks every file. */
  async function sameAnswerEveryWay(makeRepo: (root: string) => void): Promise<void> {
    const root = tmpDir();
    fixture(root);
    const reference = { listing: await oldListing(root), findings: await oldFindings(root) };
    // The reference itself is what the fixture was written to give.
    expect([...reference.listing.sql].sort()).toEqual(SQL.map(under(root)).sort());
    expect(reference.listing.dbml).toEqual(DBML_FILES.map(under(root)));
    expect([...reference.listing.semanticModel].sort()).toEqual(MODELS.map(under(root)).sort());
    expect(reference.listing.dbtProject).toBe(true);
    expect(reference.listing.truncated).toBe(false);
    expect(reference.findings).toEqual({ sources: ['dbml', 'semanticModel', 'sqlDdl'], dbtProject: true });

    const look = async () => {
      const looks = looksOf();
      const run = looks.run(root);
      const stage = await run.index;
      const listing = await run.listing();
      expect(listing).toEqual(reference.listing);
      expect(await findingsOver(root, listing)).toEqual(reference.findings);
      expect(run.stats()).toMatchObject({ finished: true, capped: false });
      return { stage, indexed: await looks.indexed([root]) };
    };

    // (a) No repository.
    const none = await look();
    expect(none.stage).toEqual({ usable: false, repository: false });
    expect(none.indexed).toBe(false);

    // (b) A repository tracking every file: the index alone already gives the walk's answer.
    makeRepo(root);
    write(root, '.git/extra.sql', CREATE_TABLE);
    const tracked = await look();
    expect(tracked.stage.usable).toBe(true);
    if (tracked.stage.usable) {
      expect(tracked.stage.listing).toEqual(reference.listing);
      expect(await findingsOver(root, tracked.stage.listing)).toEqual(reference.findings);
      expect(tracked.stage.dbtDirs).toEqual([path.join(root, 'analytics')]);
    }
    expect(tracked.indexed).toBe(true);

    // The same index, saying it is version 5.
    const index = fs.readFileSync(indexPathOf(root));
    const version5 = Buffer.from(index);
    version5.writeUInt32BE(5, 4);
    fs.writeFileSync(indexPathOf(root), version5);
    const unknownVersion = await look();
    expect(unknownVersion.stage).toEqual({ usable: false, repository: true });
    expect(unknownVersion.indexed).toBe(false);

    // (c) The index overwritten by garbage.
    fs.writeFileSync(indexPathOf(root), Buffer.from('this is not a git index, it only sits where one would\n'));
    const garbage = await look();
    expect(garbage.stage).toEqual({ usable: false, repository: true });
    expect(garbage.indexed).toBe(false);

    // And cut short in the middle of an entry.
    fs.writeFileSync(indexPathOf(root), index.subarray(0, 12 + 70));
    expect((await look()).stage).toEqual({ usable: false, repository: true });
  }

  it.skipIf(!hasGit)('with the index git itself writes', async () => {
    await sameAnswerEveryWay((root) => gitRepo(root));
  });

  it('with an index written without git', async () => {
    await sameAnswerEveryWay((root) => builtRepo(root, allFiles(root)));
  });

  it('a repository with nothing added yet (no index file) is no answer either: the walk alone finds the files', async () => {
    const root = tmpDir();
    write(root, 'schema.sql', CREATE_TABLE);
    fs.mkdirSync(path.join(root, '.git'));
    const looks = looksOf();
    const run = looks.run(root);
    // Never "nothing is tracked": a missing index and one that cannot be read look the same.
    expect(await run.index).toEqual({ usable: false, repository: true });
    expect(await looks.indexed([root])).toBe(false);
    expect(await run.listing()).toEqual(await oldListing(root));
    expect((await run.listing()).sql).toEqual([`${root}/schema.sql`]);
  });

  it.skipIf(!hasGit)('the same for what `git init` leaves, before anything is added', async () => {
    const root = tmpDir();
    write(root, 'schema.sql', CREATE_TABLE);
    git(root, 'init', '-q');
    expect(fs.existsSync(indexPathOf(root))).toBe(false);
    const run = looksOf().run(root);
    expect(await run.index).toEqual({ usable: false, repository: true });
    expect(await run.listing()).toEqual(await oldListing(root));
  });
});

// ── 3. A file not yet added to git ──────────────────────────────────────────

describe('3. a file not yet added to git is still found, and the suggestion appears after the deadline has passed', () => {
  it.skipIf(!hasGit)('the asks give up with a blank diagram; the look runs on, is never started again, and publishes the import when the walk gets there', async () => {
    const root = tmpDir();
    write(root, 'README.md', '# A repository\n');
    write(root, 'docs/notes.md', 'Nothing to import here.\n');
    write(root, 'scripts/tables.sql', CREATE_TABLE);
    gitRepo(root, ['README.md', 'docs/notes.md']);
    expect(git(root, 'ls-files', '-z').split('\0').filter(Boolean)).toEqual(['README.md', 'docs/notes.md']);

    // Every listing takes 80 ms: the root, then its folders, so the file is found after 160 ms.
    // The asks wait 20 ms to the first mark and 40 ms more: 60 ms in all.
    const reader = new CountingReader(root, nodeScanReader, () => 80);
    const looks = looksOf({ io: { reader } });
    const published: StartIntent[] = [];
    const counted: string[] = [];
    const lookCounted: string[] = [];
    let late = 0;
    const tracker = trackerOf({
      context: () => ({ hasProject: true, hasDbt: false }),
      look: folderStartLook(looks, root, SEMANTIC_DIR, { feature: (key) => { lookCounted.push(key); } }),
      publish: (intent) => { published.push(intent); },
      feature: (key) => { counted.push(key); },
      onLate: () => { late++; },
      timeoutMs: 20,
      settleMs: 5,
    });

    expect(await tracker.refresh()).toBe('blank');
    expect(published).toEqual(['blank']);
    expect(counted).toEqual(['startLookTimeout', 'startLookGaveUp']);
    expect(late).toBe(1);
    // The index had answered (nothing to import among the tracked files), and the walk was still going.
    expect(lookCounted).toEqual(['startLookFromIndex']);
    expect(looks.peek(root)?.stats().finished).toBe(false);

    // Nobody asks again: the look that ran on publishes what it found.
    await until(() => published.length > 1);
    expect(published).toEqual(['blank', 'importSqlDdl']);
    expect(counted).toEqual(['startLookTimeout', 'startLookGaveUp', 'startLookLateSuggestion', 'startLookFoundAfterDeadline']);
    await until(() => looks.peek(root)?.stats().finished === true);
    await turn();
    expect(published).toEqual(['blank', 'importSqlDdl']);

    // One look, from the top once: the root was listed once, and no folder twice.
    expect(reader.listed.filter((rel) => rel === '')).toHaveLength(1);
    expect([...reader.listed].sort()).toEqual(['', 'docs', 'scripts']);

    // A later ask is answered from what that look found, without another.
    expect(await tracker.refresh()).toBe('importSqlDdl');
    expect(tracker.sqlTableCount()).toBe(1);
    expect(reader.listed).toHaveLength(3);
  });

  it('the same without git on the machine: the tracked files come from an index written here', async () => {
    const root = tmpDir();
    write(root, 'README.md', '# A repository\n');
    write(root, 'scripts/tables.sql', CREATE_TABLE);
    builtRepo(root, ['README.md']);
    const reader = new CountingReader(root, nodeScanReader, () => 80);
    const looks = looksOf({ io: { reader } });
    const published: StartIntent[] = [];
    const counted: string[] = [];
    const tracker = trackerOf({
      context: () => ({ hasProject: true, hasDbt: false }),
      look: folderStartLook(looks, root, SEMANTIC_DIR),
      publish: (intent) => { published.push(intent); },
      feature: (key) => { counted.push(key); },
      timeoutMs: 20,
      settleMs: 5,
    });
    expect(await tracker.refresh()).toBe('blank');
    await until(() => published.length > 1);
    expect(published).toEqual(['blank', 'importSqlDdl']);
    expect(counted).toEqual(['startLookTimeout', 'startLookGaveUp', 'startLookLateSuggestion', 'startLookFoundAfterDeadline']);
    expect(reader.listed.filter((rel) => rel === '')).toHaveLength(1);
  });
});

// ── 4. One walk serves every caller ─────────────────────────────────────────

describe('4. one walk serves the look, the dbt search and Import…', () => {
  it('lists every folder exactly once in all, and the dbt search alone only as deep as it has always gone', async () => {
    const root = tmpDir();
    const deep = chainOf(['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8']);
    write(root, 'schema.sql', CREATE_TABLE);
    write(root, 'notes.dbml', DBML);
    write(root, 'proj/dbt_project.yml', "name: 'proj'\n");
    write(root, 'proj/models/a.sql', 'select 1 as id\n');
    write(root, `${deep[5]}/six.sql`, CREATE_TABLE);
    write(root, `${deep[7]}/eight.sql`, CREATE_TABLE);
    write(root, 'wide/w1/readme.txt');
    write(root, 'wide/w2/readme.txt');
    write(root, 'node_modules/pkg/x.sql', CREATE_TABLE);
    write(root, `${SEMANTIC_DIR}/own.dbml`, DBML);
    write(root, 'target/y.sql', CREATE_TABLE);
    // The ERD Studio folder is walked too (a dbt project may sit below a folder of that name); its files are never import files.
    const everyFolder = ['', SEMANTIC_DIR, 'proj', 'proj/models', ...deep, 'wide', 'wide/w1', 'wide/w2'].sort();

    const reader = new CountingReader(root);
    const looks = looksOf({ io: { reader, ...noGit } });

    // Activation's dbt project search: six folders deep, no deeper.
    expect(await looks.dbtProjectsBelow([root])).toEqual([path.join(root, 'proj')]);
    expect(Math.max(...reader.listed.map(depthOf))).toBe(DBT_SEARCH_MAX_DEPTH);
    expect([...reader.listed].sort()).toEqual(everyFolder.filter((rel) => depthOf(rel) <= DBT_SEARCH_MAX_DEPTH));

    // The start screen's look: the same walk carries on from there.
    const findings = await folderStartLook(looks, root, SEMANTIC_DIR)(new AbortController().signal, () => undefined);
    expect(plain(findings)).toEqual({ sources: ['dbml', 'sqlDdl'], dbtProject: true });
    // Three CREATE TABLEs, one of them eight folders down: the whole folder was gone over.
    expect(findings.sqlTables).toBe(3);

    // Import…'s picker and Import DBML…'s default file read the same look.
    expect([...await vscodeImportModelDeps(root, SEMANTIC_DIR, looks).detect()].sort()).toEqual(['dbml', 'sqlDdl']);
    expect(await vscodeFindImportDbmlFile(root, SEMANTIC_DIR, undefined, looks)).toBe(`${root}/notes.dbml`);
    // And the dbt search again.
    expect(await looks.dbtProjectsBelow([root])).toEqual([path.join(root, 'proj')]);

    expect(new Set(reader.listed).size).toBe(reader.listed.length);
    expect([...reader.listed].sort()).toEqual(everyFolder);
    expect(reader.maxInFlight).toBeLessThanOrEqual(2);
  });

  it('callers asking at the same time share the walk too', async () => {
    const tree: Dir = {
      'a.sql': FILE,
      proj: { 'dbt_project.yml': FILE },
      one: { two: { three: { four: { five: { six: { seven: { 'deep.sql': FILE } } } } } } },
    };
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk(tree), () => 1);
    const looks = looksOf({ io: { reader, ...noGit } });
    const [projects, listing, again] = await Promise.all([
      looks.dbtProjectsBelow([MEMORY_ROOT]),
      looks.run(MEMORY_ROOT).listing(),
      looks.run(MEMORY_ROOT).listing(),
    ]);
    expect(projects).toEqual([path.join(MEMORY_ROOT, 'proj')]);
    expect(listing.sql).toEqual([`${MEMORY_ROOT}/a.sql`, `${MEMORY_ROOT}/one/two/three/four/five/six/seven/deep.sql`]);
    expect(again).toEqual(listing);
    expect(new Set(reader.listed).size).toBe(reader.listed.length);
    expect(reader.listed).toHaveLength(9);
  });
});

// ── 5. The worst case has a known size ──────────────────────────────────────

describe('5. the walk is bounded by folders visited, and never more than two listings are in flight', () => {
  it('stops at maxFolders in a deep, wide tree with nothing to find, and says so', async () => {
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk(wide(4, 12)), () => 0);
    const looks = looksOf({ maxFolders: 300, io: { reader, ...noGit } });
    const run = looks.run(MEMORY_ROOT);
    expect(await run.listing()).toEqual({ ...EMPTY_LISTING, truncated: true });
    expect(run.stats()).toEqual({ folders: 300, finished: true, capped: true });
    expect(reader.listed).toHaveLength(300);
    expect(new Set(reader.listed).size).toBe(300);
    expect(reader.maxInFlight).toBe(2);
    // Breadth first: the shallowest folders are the ones kept.
    expect(Math.max(...reader.listed.map(depthOf))).toBe(4);
  });

  it('the default bound is 20,000 folders (and a minute of walking), and it is the one a look gets', async () => {
    expect(FOLDER_LOOK_MAX_FOLDERS).toBe(20_000);
    expect(FOLDER_LOOK_MAX_MS).toBe(60_000);
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk(wide(4, 12)));
    const looks = looksOf({ io: { reader, ...noGit } });
    const run = looks.run(MEMORY_ROOT);
    expect((await run.listing()).truncated).toBe(true);
    expect(run.stats()).toEqual({ folders: FOLDER_LOOK_MAX_FOLDERS, finished: true, capped: true });
    expect(reader.listed).toHaveLength(FOLDER_LOOK_MAX_FOLDERS);
    expect(reader.maxInFlight).toBeLessThanOrEqual(2);
  });

  it('the dbt project search never lists past the look\'s own bound', async () => {
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk(wide(4, 12)));
    const looks = looksOf({ maxFolders: 120, io: { reader, ...noGit } });
    expect(await looks.dbtProjectsBelow([MEMORY_ROOT])).toEqual([]);
    expect(reader.listed).toHaveLength(120);
    expect(looks.run(MEMORY_ROOT).stats()).toEqual({ folders: 120, finished: true, capped: true });
    expect(reader.maxInFlight).toBeLessThanOrEqual(2);
  });

  it('the dbt project search waits for its own 5,000 folders, the walk pauses there, and a look for import files carries on from the next folder', async () => {
    expect(DBT_SEARCH_MAX_DIRS).toBe(5000);
    // Six folders in every folder: 9,331 folders five levels down, 55,987 within the six the dbt search goes.
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk(wide(6, 12)));
    const overall = 9000;
    const looks = looksOf({ maxFolders: overall, io: { reader, ...noGit, ...noFiles } });
    const run = looks.run(MEMORY_ROOT);

    // Activation's wait: over after exactly 5,000 listings, with the walk paused, not over.
    expect(await looks.dbtProjectsBelow([MEMORY_ROOT])).toEqual([]);
    expect(reader.listed).toHaveLength(DBT_SEARCH_MAX_DIRS);
    expect(run.stats()).toEqual({ folders: DBT_SEARCH_MAX_DIRS, finished: false, capped: false });
    expect(Math.max(...reader.listed.map(depthOf))).toBeLessThanOrEqual(DBT_SEARCH_MAX_DEPTH);
    expect(run.listingSoFar().truncated).toBe(false);

    // Nobody asks: nothing more is listed, and asking the same again lists nothing either.
    await turn();
    await turn();
    expect(reader.listed).toHaveLength(DBT_SEARCH_MAX_DIRS);
    expect(reader.inFlight).toBe(0);
    expect(await looks.dbtProjectsBelow([MEMORY_ROOT])).toEqual([]);
    expect(reader.listed).toHaveLength(DBT_SEARCH_MAX_DIRS);
    expect(looks.run(MEMORY_ROOT)).toBe(run);

    // A look for import files asks for the rest: the same walk, from the next folder, to the look's own bound.
    expect(await run.listing()).toEqual({ ...EMPTY_LISTING, truncated: true });
    expect(run.stats()).toEqual({ folders: overall, finished: true, capped: true });
    expect(reader.listed).toHaveLength(overall);
    expect(new Set(reader.listed).size).toBe(overall);
    expect(reader.maxInFlight).toBeLessThanOrEqual(2);
    // Breadth first throughout: the 9,000 are the first 9,000 in walk order, none deeper than five folders.
    expect(Math.max(...reader.listed.map(depthOf))).toBe(5);
  });

  it('where its bound stops the dbt search, the folders found but not listed are asked for dbt_project.yml by name (as the old walk asked), once', async () => {
    const PROJECT: Dir = { 'dbt_project.yml': FILE };
    const disk = new MemoryDisk(wide(6, 12, {
      'd0/d1': PROJECT, // listed: two folders down
      'd5/d5/d5/d5/d5': PROJECT, // the last folder five down: found, not listed when the bound stops the walk
      'd0/d0/d0/d0/d0/d0': PROJECT, // six down, below a listed folder: found, not listed
      'd0/d0/d0/d0/d0/d0/d0': PROJECT, // seven down: deeper than the dbt search goes
    }));
    const reader = new CountingReader(MEMORY_ROOT, disk);
    const asked: string[] = [];
    const looks = looksOf({ io: { reader, ...noGit, fileExists: async (filePath) => { asked.push(filePath); return disk.hasFile(filePath); } } });

    const found = await looks.dbtProjectsBelow([MEMORY_ROOT]);
    expect(found.map((dir) => relOf(MEMORY_ROOT, dir).split(path.sep).join('/')).sort()).toEqual(['d0/d0/d0/d0/d0/d0', 'd0/d1', 'd5/d5/d5/d5/d5']);
    // Asked by name, never listed: the walk is where the bound left it.
    expect(reader.listed).toHaveLength(DBT_SEARCH_MAX_DIRS);
    expect(reader.listed).not.toContain('d5/d5/d5/d5/d5');
    expect(looks.run(MEMORY_ROOT).stats()).toEqual({ folders: DBT_SEARCH_MAX_DIRS, finished: false, capped: false });
    // Each folder once, none listed already, none deeper than six.
    expect(new Set(asked).size).toBe(asked.length);
    expect(asked.every((file) => file.endsWith('/dbt_project.yml'))).toBe(true);
    const listed = new Set(reader.listed);
    for (const file of asked) {
      const folder = relOf(MEMORY_ROOT, file).slice(0, -'/dbt_project.yml'.length);
      expect(listed.has(folder), folder).toBe(false);
      expect(depthOf(folder), folder).toBeLessThanOrEqual(DBT_SEARCH_MAX_DEPTH);
    }

    // Asked again with the walk where it was: the same answer, and nothing is asked twice.
    const before = asked.length;
    expect((await looks.dbtProjectsBelow([MEMORY_ROOT])).sort()).toEqual([...found].sort());
    expect(asked).toHaveLength(before);
    expect(reader.listed).toHaveLength(DBT_SEARCH_MAX_DIRS);
  });

  it('what is asked by name has a known size too, however many folders the listed ones hold', async () => {
    // 6,000 folders, twenty more in each: the dbt search lists the root and 4,999 of them, which hold 99,980.
    const tree: Dir = {};
    for (let i = 0; i < 6000; i++) {
      tree[`a${String(i).padStart(4, '0')}`] = () => Object.fromEntries(Array.from({ length: 20 }, (_, j) => [`b${j}`, {}]));
    }
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk(tree));
    let asked = 0;
    const looks = looksOf({ io: { reader, ...noGit, fileExists: async () => { asked++; return false; } } });
    expect(await looks.dbtProjectsBelow([MEMORY_ROOT])).toEqual([]);
    expect(reader.listed).toHaveLength(DBT_SEARCH_MAX_DIRS);
    // The folders kept are those the look's own bound could still list (with the walk's slack), not all it found.
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThanOrEqual(2 * FOLDER_LOOK_MAX_FOLDERS);
  });

  it('a tree smaller than the dbt search\'s bound is walked six folders deep by it, and no further', async () => {
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk(wide(2, 9)));
    const looks = looksOf({ io: { reader, ...noGit } });
    const run = looks.run(MEMORY_ROOT);
    await looks.dbtProjectsBelow([MEMORY_ROOT]);
    // 1 + 2 + 4 + … + 64 folders down to the sixth level.
    expect(reader.listed).toHaveLength(127);
    expect(run.stats()).toEqual({ folders: 127, finished: false, capped: false });
    await run.listing();
    expect(reader.listed).toHaveLength(1023);
    expect(new Set(reader.listed).size).toBe(1023);
    expect(run.stats()).toEqual({ folders: 1023, finished: true, capped: false });
  });

  it('a listing that never answers cannot hold the look past maxMs', async () => {
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk({ 'a.sql': FILE, stuck: { 'b.sql': FILE } }), (rel) => (rel === 'stuck' ? 'never' : undefined));
    const looks = looksOf({ maxMs: 40, io: { reader, ...noGit } });
    const run = looks.run(MEMORY_ROOT);
    const listing = await run.listing();
    expect(listing).toEqual({ ...EMPTY_LISTING, sql: [`${MEMORY_ROOT}/a.sql`], truncated: true });
    expect(run.stats()).toEqual({ folders: 2, finished: true, capped: true });
  });
});

// ── 6. dbt projects: the old synchronous walk's answer ──────────────────────

describe('6. dbt projects: the same answer as the old synchronous walk', () => {
  const PROJECT = "name: 'p'\n";

  it('finds projects one, three and six folders down, never seven; not in a skipped folder; hidden folders too; a linked folder once', async () => {
    const root = tmpDir();
    const outside = tmpDir();
    write(root, 'dbt_project.yml', PROJECT); // the folder itself is never one of the projects below it
    write(root, 'p1/dbt_project.yml', PROJECT);
    write(root, 'a/b/p3/dbt_project.yml', PROJECT);
    write(root, 'a/b/c/d/e/p6/dbt_project.yml', PROJECT);
    write(root, 'a/b/c/d/e/f/p7/dbt_project.yml', PROJECT);
    write(root, 'node_modules/pkg/dbt_project.yml', PROJECT);
    write(root, 'target/compiled/dbt_project.yml', PROJECT);
    write(root, '.venv/lib/dbt_project.yml', PROJECT);
    write(root, 'visible/pv/dbt_project.yml', PROJECT);
    write(root, '.hidden/ph/dbt_project.yml', PROJECT);
    write(outside, 'shared/dbt_project.yml', PROJECT);
    let linked = true;
    try {
      // Two links to one folder outside the tree: the project is one project.
      fs.symlinkSync(path.join(outside, 'shared'), path.join(root, 'link_a'), 'dir');
      fs.symlinkSync(path.join(outside, 'shared'), path.join(root, 'link_b'), 'dir');
    } catch {
      linked = false;
    }

    const looks = looksOf({ io: noGit });
    const found = sortDbtCandidates(await looks.dbtProjectsBelow([root]), [root]);
    const old = sortDbtCandidates(findDbtProjectsBelow([root]), [root]);
    expect(found).toEqual(old);
    // Shallowest first, visible before hidden, then by name.
    expect(found).toEqual([
      ...(linked ? ['link_a'] : []),
      'p1',
      'visible/pv',
      '.hidden/ph',
      'a/b/p3',
      'a/b/c/d/e/p6',
    ].map((rel) => path.resolve(root, rel)));
    // What activation makes of it is what it made of the old walk's.
    expect(findDbtProjectCandidates([root], { below: await looks.dbtProjectsBelow([root]) })).toEqual(findDbtProjectCandidates([root]));
  });

  it('skips every folder name the old walk skipped (and one more: Power BI\'s cache)', () => {
    for (const name of [...DBT_SEARCH_SKIP_DIRS, ...HIDDEN_TOOL_DIRS]) expect(IGNORED_IMPORT_FOLDERS.has(name), name).toBe(true);
    const oldSkips = new Set([...DBT_SEARCH_SKIP_DIRS, ...HIDDEN_TOOL_DIRS]);
    expect([...IGNORED_IMPORT_FOLDERS].filter((name) => !oldSkips.has(name))).toEqual(['.pbi']);
  });

  // Was a bug, found here and fixed (folderLook.ts, the walk's `skipFolder` and `walked()`): the shared walk never enters a
  // top-level folder named `erd-studio` (the ERD Studio folder's name before 0.6.44), which is right for
  // import files and wrong for the dbt project search: the old walk went in. Open the folder above a clone
  // of this repository and its dbt projects are no longer found.
  it('a project inside a top-level folder named erd-studio is still found, as the old walk found it', async () => {
    const root = tmpDir();
    write(root, 'erd-studio/test/fixtures/dbt-project/dbt_project.yml', PROJECT);
    write(root, 'plain/dbt_project.yml', PROJECT);
    const found = sortDbtCandidates(await looksOf({ io: noGit }).dbtProjectsBelow([root]), [root]);
    expect(found).toEqual(sortDbtCandidates(findDbtProjectsBelow([root]), [root]));
  });

  // Was a bug, found here and fixed (the same skip): nor the folder the `erdStudio.semanticDir` setting names.
  it('a project inside the folder semanticDir names is still found, as the old walk found it', async () => {
    const root = tmpDir();
    write(root, 'design/warehouse/dbt_project.yml', PROJECT);
    write(root, 'plain/dbt_project.yml', PROJECT);
    const found = sortDbtCandidates(await looksOf({ semanticDir: 'design', io: noGit }).dbtProjectsBelow([root]), [root]);
    expect(found).toEqual(sortDbtCandidates(findDbtProjectsBelow([root]), [root]));
  });

  it('the control for the two above: the same trees without the skipped folder give the old walk\'s answer', async () => {
    const root = tmpDir();
    write(root, 'erd-studios/test/fixtures/dbt-project/dbt_project.yml', PROJECT);
    write(root, 'designs/warehouse/dbt_project.yml', PROJECT);
    write(root, 'plain/dbt_project.yml', PROJECT);
    const found = sortDbtCandidates(await looksOf({ semanticDir: 'design', io: noGit }).dbtProjectsBelow([root]), [root]);
    expect(found).toEqual(sortDbtCandidates(findDbtProjectsBelow([root]), [root]));
    expect(found).toHaveLength(3);
  });

  it.skipIf(!hasGit)('in a repository: a tracked project nine folders down is found (the index has no depth limit), and one not yet added by the walk', async () => {
    const root = tmpDir();
    const nine = 't1/t2/t3/t4/t5/t6/t7/t8/deep';
    write(root, `${nine}/dbt_project.yml`, PROJECT);
    write(root, 'node_modules/pkg/dbt_project.yml', PROJECT);
    write(root, 'u1/fresh/dbt_project.yml', PROJECT);
    write(root, 'u1/u2/u3/u4/u5/u6/too_deep/dbt_project.yml', PROJECT);
    gitRepo(root, [`${nine}/dbt_project.yml`, 'node_modules/pkg/dbt_project.yml']);

    const looks = looksOf();
    expect(await looks.indexed([root])).toBe(true);
    const found = sortDbtCandidates(await looks.dbtProjectsBelow([root]), [root]);
    expect(found).toEqual([path.resolve(root, 'u1/fresh'), path.resolve(root, nine)]);
    // The old walk never saw the tracked one: it stopped six folders down.
    expect(findDbtProjectsBelow([root])).toEqual([path.join(root, 'u1', 'fresh')]);
  });

  it('the same from an index written without git', async () => {
    const root = tmpDir();
    const nine = 't1/t2/t3/t4/t5/t6/t7/t8/deep';
    write(root, `${nine}/dbt_project.yml`, PROJECT);
    write(root, 'u1/fresh/dbt_project.yml', PROJECT);
    builtRepo(root, [`${nine}/dbt_project.yml`]);
    const found = sortDbtCandidates(await looksOf().dbtProjectsBelow([root]), [root]);
    expect(found).toEqual([path.resolve(root, 'u1/fresh'), path.resolve(root, nine)]);
  });
});

// ── 7. Stale index entries ──────────────────────────────────────────────────

describe('7. stale index entries never produce a wrong suggestion', () => {
  /** A repository whose index still lists files that are gone from disk. */
  function staleRepo(): string {
    const root = tmpDir();
    const tracked = ['README.md', 'pbi/Sales.SemanticModel/model.bim', 'tabular/database.json', 'tabular/tables/t.json', 'warehouse/dbt_project.yml', 'db/schema.sql'];
    for (const file of tracked) write(root, file, file.endsWith('.sql') ? CREATE_TABLE : '{}');
    if (hasGit) gitRepo(root, tracked);
    else builtRepo(root, tracked);
    // Deleted, and not yet `git rm`ed: the index still names them.
    for (const file of tracked.slice(1)) remove(root, file);
    return root;
  }

  it('the index stage counts no semantic model and no dbt_project.yml that is gone from disk', async () => {
    const root = staleRepo();
    const stage = await looksOf().run(root).index;
    expect(stage.usable).toBe(true);
    if (!stage.usable) return;
    expect(stage.listing.semanticModel).toEqual([]);
    expect(stage.listing.dbtProject).toBe(false);
    expect(stage.listing.truncated).toBe(false);
    // A .sql file counts only once its start has been read, and this one cannot be.
    expect(stage.listing.sql).toEqual([`${root}/db/schema.sql`]);
    expect(await findingsOver(root, stage.listing)).toEqual({ sources: [], dbtProject: false });
  });

  it('nor does the look built on it: nothing early, nothing in the end, and the start screen suggests a blank diagram', async () => {
    const root = staleRepo();
    const looks = looksOf();
    const early: ImportFindings[] = [];
    const findings = await folderStartLook(looks, root, SEMANTIC_DIR)(new AbortController().signal, (found) => { early.push(found); });
    expect(early).toEqual([]);
    expect(plain(findings)).toEqual({ sources: [], dbtProject: false });
    // The walk has been everywhere: it is the truth, and the index's files are gone from the listing.
    expect(await looks.run(root).listing()).toEqual(EMPTY_LISTING);
    expect(await looks.run(root).listing()).toEqual(await oldListing(root));

    const published: StartIntent[] = [];
    const tracker = trackerOf({
      context: () => ({ hasProject: true, hasDbt: false }),
      look: folderStartLook(looksOf(), root, SEMANTIC_DIR),
      publish: (intent) => { published.push(intent); },
    });
    expect(await tracker.refresh()).toBe('blank');
    expect(published).toEqual(['blank']);
  });

  it('a tracked dbt project that is gone from disk is not a project activation opens', async () => {
    const root = staleRepo();
    const below = await looksOf().dbtProjectsBelow([root]);
    expect(findDbtProjectCandidates([root], { below })).toEqual([]);
    expect(findDbtProjectCandidates([root], { below })).toEqual(findDbtProjectCandidates([root]));
  });

  // Was a bug, found here and fixed (folderLook.ts `readIndex`: `dbtFile ??= rel`, then one `fileExists`): only the first tracked
  // dbt_project.yml is looked for on disk, so one that is gone hides every later one that is there, until the
  // walk gets to it (never, when the walk is cut short).
  it('a tracked dbt_project.yml that is still there counts although an earlier tracked one is gone', async () => {
    const root = tmpDir();
    write(root, 'b_live/dbt_project.yml', "name: 'live'\n");
    builtRepo(root, ['a_gone/dbt_project.yml', 'b_live/dbt_project.yml']);
    const reader = new CountingReader(root, nodeScanReader, () => 'never');
    const stage = await looksOf({ io: { reader } }).run(root).index;
    expect(stage.usable).toBe(true);
    if (stage.usable) expect(stage.listing.dbtProject).toBe(true);
  });

  it('while the walk has not been there the index stands in; once it has, the walk is the truth', async () => {
    const tree: Dir = { 'top.sql': FILE, 'untracked.sql': FILE, slow: { 'late.sql': FILE }, tracked: { deep: { 'schema.sql': FILE } } };
    const gate = deferred();
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk(tree), (rel) => (rel === 'slow' ? gate.promise : undefined));
    const index = indexOf(MEMORY_ROOT, ['top.sql', 'gone/old.sql', 'slow/late.sql', 'tracked/deep/schema.sql']);
    const looks = looksOf({ io: { reader, ...index } });
    const run = looks.run(MEMORY_ROOT);
    let progressed = 0;
    const stop = run.onProgress(() => { progressed++; });

    // Before any listing: the index's files.
    await run.index;
    expect(progressed).toBe(1);
    expect(run.listingSoFar().sql).toEqual(['gone/old.sql', 'slow/late.sql', 'top.sql', 'tracked/deep/schema.sql'].map(under(MEMORY_ROOT)));

    // Mid-walk: the root's own files are in, `slow` has not answered. Each file once, whoever named it.
    const whole = run.listing();
    await until(() => reader.listed.includes('slow') && run.listingSoFar().sql.length === 5 && progressed > 1);
    const soFar = run.listingSoFar();
    expect(soFar.sql).toEqual(['gone/old.sql', 'slow/late.sql', 'top.sql', 'tracked/deep/schema.sql', 'untracked.sql'].map(under(MEMORY_ROOT)));
    expect(soFar.truncated).toBe(false);
    expect(run.stats().finished).toBe(false);

    // The walk over: what is gone from disk is gone from the listing.
    gate.resolve();
    const listing = await whole;
    expect(listing.sql).toEqual(['slow/late.sql', 'top.sql', 'tracked/deep/schema.sql', 'untracked.sql'].map(under(MEMORY_ROOT)));
    expect(run.listingSoFar()).toEqual(listing);

    // A listener that was removed hears nothing more.
    stop();
    const heard = progressed;
    await turn();
    expect(progressed).toBe(heard);
  });

  it('a walk cut short keeps the index\'s files for the folders it never reached, and lists folders holding tracked files first', async () => {
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk(wide(4, 12)));
    const tracked = 'd3/d0/d0/d0/schema.sql';
    const looks = looksOf({ maxFolders: 3, io: { reader, ...indexOf(MEMORY_ROOT, [tracked]) } });
    const run = looks.run(MEMORY_ROOT);
    expect(await run.listing()).toEqual({ ...EMPTY_LISTING, sql: [`${MEMORY_ROOT}/${tracked}`], truncated: true });
    expect(run.stats()).toEqual({ folders: 3, finished: true, capped: true });
    // `d3` holds a tracked file: it goes before `d0`, which holds none.
    expect(reader.listed).toEqual(['', 'd3', 'd0']);
  });
});

// ── 8. A sub-folder of a repository ─────────────────────────────────────────

describe('8. a sub-folder of a repository', () => {
  function monorepo(makeRepo: (repo: string, tracked: readonly string[]) => void): { repo: string; opened: string } {
    const repo = tmpDir();
    const tracked = [
      'top.sql',
      'services/app/db/schema.sql',
      'services/app/model.bim',
      'services/app/warehouse/dbt_project.yml',
      'services/app2/x.sql',
      'services/app2/dbt_project.yml',
      'services/x.sql',
    ];
    for (const file of tracked) write(repo, file, file.endsWith('.sql') ? CREATE_TABLE : '{}');
    write(repo, 'services/app/untracked/new.sql', CREATE_TABLE);
    makeRepo(repo, tracked);
    return { repo, opened: `${repo}/services/app` };
  }

  async function onlyTheOpenedFolder(makeRepo: (repo: string, tracked: readonly string[]) => void): Promise<void> {
    const { opened } = monorepo(makeRepo);
    const looks = looksOf();
    const run = looks.run(opened);
    const stage = await run.index;
    expect(stage).toEqual({
      usable: true,
      listing: {
        sql: [`${opened}/db/schema.sql`],
        dbml: [],
        semanticModel: [`${opened}/model.bim`],
        dbtProject: true,
        truncated: false,
      },
      dbtDirs: [path.join(opened, 'warehouse')],
    });

    const listing = await run.listing();
    expect(listing).toEqual(await oldListing(opened));
    expect(listing.sql).toEqual([`${opened}/db/schema.sql`, `${opened}/untracked/new.sql`]);
    for (const file of [...listing.sql, ...listing.dbml, ...listing.semanticModel]) {
      expect(file.startsWith(`${opened}/`), file).toBe(true);
      expect(path.isAbsolute(file), file).toBe(true);
    }
    expect(await looks.dbtProjectsBelow([opened])).toEqual([path.join(opened, 'warehouse')]);
  }

  it.skipIf(!hasGit)('lists only the files under the opened folder, as absolute paths under it (git\'s own index)', async () => {
    await onlyTheOpenedFolder((repo, tracked) => gitRepo(repo, tracked));
  });

  it('lists only the files under the opened folder, as absolute paths under it (an index written without git)', async () => {
    await onlyTheOpenedFolder(builtRepo);
  });

  it('a folder that only shares the start of its name with a tracked folder is not vouched for by the index, and lists none of that folder\'s files', async () => {
    const { repo } = monorepo(builtRepo);
    const opened = `${repo}/services/ap`;
    write(repo, 'services/ap/readme.txt');
    write(repo, 'services/ap/own.sql', CREATE_TABLE);
    const looks = looksOf();
    const run = looks.run(opened);
    // The index names nothing below it (new and not added yet, or spelled another way than git has it): the walk decides.
    expect(await run.index).toEqual({ usable: false, repository: true });
    expect(await looks.indexed([opened])).toBe(false);
    expect(run.listingSoFar()).toEqual(EMPTY_LISTING);
    const listing = await run.listing();
    expect(listing).toEqual({ ...EMPTY_LISTING, sql: [`${opened}/own.sql`] });
    expect(listing).toEqual(await oldListing(opened));
    expect(await looks.dbtProjectsBelow([opened])).toEqual([]);
  });

  /** A sub-folder with tracked files directly in it and no folder below: `services/app/readme.md`, and `schema.sql` when `withScript`. */
  function flatSubFolder(withScript: boolean): { opened: string } {
    const repo = tmpDir();
    const tracked = ['top.sql', 'services/app/readme.md', ...(withScript ? ['services/app/schema.sql'] : [])];
    for (const file of tracked) write(repo, file, file.endsWith('.sql') ? CREATE_TABLE : '# notes\n');
    builtRepo(repo, tracked);
    return { opened: `${repo}/services/app` };
  }

  it('a sub-folder whose tracked files sit directly in it: usable as soon as one of them is a file the look is after', async () => {
    const { opened } = flatSubFolder(true);
    const looks = looksOf();
    const run = looks.run(opened);
    expect(await run.index).toEqual({ usable: true, listing: { ...EMPTY_LISTING, sql: [`${opened}/schema.sql`] }, dbtDirs: [] });
    expect(await looks.indexed([opened])).toBe(true);
    expect(await run.listing()).toEqual(await oldListing(opened));
  });

  it('a sub-folder whose only tracked files are none the look is after, directly in it: the index does not vouch for it (the walk decides)', async () => {
    const { opened } = flatSubFolder(false);
    write(opened, 'untracked.sql', CREATE_TABLE);
    const looks = looksOf();
    const run = looks.run(opened);
    // The index hands back only the kept paths and the folders below the opened one: here neither, as for a folder git has never seen.
    expect(await run.index).toEqual({ usable: false, repository: true });
    expect(await looks.indexed([opened])).toBe(false);
    const listing = await run.listing();
    expect(listing).toEqual({ ...EMPTY_LISTING, sql: [`${opened}/untracked.sql`] });
    expect(listing).toEqual(await oldListing(opened));
  });

  it('with a tracked folder below it the same sub-folder is vouched for, although no tracked file is one the look is after', async () => {
    const repo = tmpDir();
    const tracked = ['services/app/readme.md', 'services/app/docs/notes.md'];
    for (const file of tracked) write(repo, file, '# notes\n');
    builtRepo(repo, tracked);
    const opened = `${repo}/services/app`;
    expect(await looksOf().run(opened).index).toEqual({ usable: true, listing: EMPTY_LISTING, dbtDirs: [] });
  });
});

// ── 9. Sharing and freshness ────────────────────────────────────────────────

describe('9. a look is shared while it is in use or fresh, and made again once it is old', () => {
  it('returns the same look while a caller waits on it and within the max age, and a new one after', async () => {
    let clock = 1_000_000;
    const gate = deferred();
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk({ 'a.sql': FILE, slow: { 'b.sql': FILE } }), (rel) => (rel === 'slow' ? gate.promise : undefined));
    const looks = looksOf({ maxMs: 100 * FOLDER_LOOK_FRESH_MS, io: { reader, ...noGit, now: () => clock } });

    const run = looks.run(MEMORY_ROOT);
    expect(looks.run(MEMORY_ROOT)).toBe(run);
    expect(looks.peek(MEMORY_ROOT)).toBe(run);
    // The same folder, spelled with a trailing slash.
    expect(looks.run(`${MEMORY_ROOT}/`)).toBe(run);

    // A caller waits on its walk: it is the look in use, however long that takes.
    const waiting = run.listing();
    await until(() => reader.listed.includes('slow'));
    clock += 10 * FOLDER_LOOK_FRESH_MS;
    expect(looks.run(MEMORY_ROOT)).toBe(run);
    expect(looks.run(MEMORY_ROOT, 1)).toBe(run);

    gate.resolve();
    const listing = await waiting;
    expect(listing.sql).toEqual([`${MEMORY_ROOT}/a.sql`, `${MEMORY_ROOT}/slow/b.sql`]);

    // Answered, and nobody waits any more: its age counts from when it began, long ago by now.
    const fresh = looks.run(MEMORY_ROOT);
    expect(fresh).not.toBe(run);
    expect(looks.peek(MEMORY_ROOT)).toBe(fresh);
    // A look is good for the max age from its start…
    clock += FOLDER_LOOK_FRESH_MS - 1;
    expect(looks.run(MEMORY_ROOT)).toBe(fresh);
    // …and a caller that wants one only seconds old gets a new one sooner.
    const soon = looks.run(MEMORY_ROOT, 5000);
    expect(soon).not.toBe(fresh);
    expect(looks.peek(MEMORY_ROOT)).toBe(soon);

    clock += FOLDER_LOOK_FRESH_MS + 1;
    const next = looks.run(MEMORY_ROOT);
    expect(next).not.toBe(soon);
    // The old one is left as it is for whoever still holds it.
    expect(await run.listing()).toEqual(listing);
    const before = reader.listed.length;
    expect(await next.listing()).toEqual(listing);
    // A new look lists the folder again: it may have changed.
    expect(reader.listed.length).toBe(before + 2);
  });

  it('each folder has its own look', async () => {
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk({ one: { 'a.sql': FILE }, two: { 'b.sql': FILE } }));
    const looks = looksOf({ io: { reader, ...noGit } });
    const one = looks.run(`${MEMORY_ROOT}/one`);
    const two = looks.run(`${MEMORY_ROOT}/two`);
    expect(one).not.toBe(two);
    expect((await one.listing()).sql).toEqual([`${MEMORY_ROOT}/one/a.sql`]);
    expect((await two.listing()).sql).toEqual([`${MEMORY_ROOT}/two/b.sql`]);
  });

  // Was a bug, found by this test and fixed (folderLook.ts `walkTo`: `idleSince` is set on every call, also one that waited for nothing):
  // reading a finished look makes it young again, so a look read at least once a minute is never made again,
  // and a quick import (max age 5 s) run just after Import…'s picker read the look takes a listing of any age.
  it('a finished look ages from when its walk finished, not from when it was last read', async () => {
    let clock = 1_000_000;
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk({ 'a.sql': FILE, sub: { 'b.sql': FILE } }));
    const looks = looksOf({ io: { reader, ...noGit, now: () => clock } });
    const run = looks.run(MEMORY_ROOT);
    await run.listing();
    const listings = reader.listed.length;

    // 50 s later Import… reads the same look: nothing is listed, so nothing is any newer.
    clock += FOLDER_LOOK_FRESH_MS - 10_000;
    expect(looks.run(MEMORY_ROOT)).toBe(run);
    await looks.run(MEMORY_ROOT).listing();
    expect(reader.listed).toHaveLength(listings);

    // 70 s after the folder was listed: older than the max age, whoever read it meanwhile.
    clock += 20_000;
    expect(looks.run(MEMORY_ROOT)).not.toBe(run);
  });

  it('dispose stops the listing, and whoever waits is answered (truncated)', async () => {
    const tree: Dir = { 'a.sql': FILE, stuck: { 'b.sql': FILE, below: { 'c.sql': FILE } }, other: { more: { 'd.sql': FILE } } };
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk(tree), (rel) => (rel === 'stuck' ? 'never' : undefined));
    const looks = looksOf({ io: { reader, ...noGit } });
    const run = looks.run(MEMORY_ROOT);
    const listing = run.listing();
    const projects = run.dbtProjects();
    await until(() => reader.listed.includes('stuck'));
    const listed = reader.listed.length;

    looks.dispose();
    expect((await listing).truncated).toBe(true);
    expect(await projects).toEqual([]);
    expect(run.stats().finished).toBe(true);
    expect(run.usable(FOLDER_LOOK_FRESH_MS)).toBe(false);
    await turn();
    expect(reader.listed).toHaveLength(listed);

    // A look asked for after that lists nothing either.
    expect(looks.peek(MEMORY_ROOT)).toBeUndefined();
    expect((await looks.run(MEMORY_ROOT).listing()).truncated).toBe(true);
    expect(await looks.dbtProjectsBelow([MEMORY_ROOT])).toEqual([]);
    expect(reader.listed).toHaveLength(listed);
  });
});

// ── 10. The index stage has a time limit ────────────────────────────────────

describe('10. the index stage has a time limit', () => {
  const location: GitIndexLocation = { workTree: MEMORY_ROOT, gitDir: `${MEMORY_ROOT}/.git`, indexPath: `${MEMORY_ROOT}/.git/index` };

  it('an index read that never answers is given up on, and the walk answers alone', async () => {
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk({ 'schema.sql': FILE, proj: { 'dbt_project.yml': FILE } }));
    let asked: GitIndexReadOptions | undefined;
    const looks = looksOf({
      indexMs: 30,
      io: {
        reader,
        findGitIndex: async () => location,
        readGitIndex: (_location, options) => {
          asked = options;
          return new Promise<GitIndexResult>(() => undefined);
        },
      },
    });
    const run = looks.run(MEMORY_ROOT);
    const started = Date.now();
    expect(await run.index).toEqual({ usable: false, repository: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    // The read is told to stop.
    expect(asked?.cancelled?.()).toBe(true);
    expect(asked?.prefix).toBe('');

    expect(await run.listing()).toEqual({ ...EMPTY_LISTING, sql: [`${MEMORY_ROOT}/schema.sql`], dbtProject: true });
    expect(await run.dbtProjects()).toEqual([path.join(MEMORY_ROOT, 'proj')]);
    expect(await looks.indexed([MEMORY_ROOT])).toBe(false);
  });

  it('an index that answers after the limit is not used', async () => {
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk({ 'schema.sql': FILE }));
    const late = deferred();
    const looks = looksOf({
      indexMs: 20,
      io: {
        reader,
        findGitIndex: async () => location,
        readGitIndex: async () => {
          await late.promise;
          return { ok: true, paths: ['ghost.sql'], dirs: new Set<string>(), entries: 1, version: 2, split: false };
        },
      },
    });
    const run = looks.run(MEMORY_ROOT);
    expect(await run.index).toEqual({ usable: false, repository: true });
    late.resolve();
    await turn();
    expect(run.listingSoFar().sql).toEqual([]);
    expect((await run.listing()).sql).toEqual([`${MEMORY_ROOT}/schema.sql`]);
  });

  // Was a bug, found here and fixed (folderLook.ts `listing()` and `dbtProjects()` await `this.index` before `walkTo`, whose own
  // `headStart` is then always over): the walk does not start 250 ms after a slow index read began but when
  // that read ends, up to FOLDER_LOOK_INDEX_MS (3 s) later.
  it('the walk starts after its short head start, not when the index read gives up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const reader = new CountingReader(MEMORY_ROOT, new MemoryDisk({ 'schema.sql': FILE, proj: { 'dbt_project.yml': FILE } }));
    const looks = looksOf({
      indexMs: 60_000,
      io: { reader, findGitIndex: async () => location, readGitIndex: () => new Promise<GitIndexResult>(() => undefined) },
    });
    const run = looks.run(MEMORY_ROOT);
    void run.listing();
    void run.dbtProjects();
    // Four times the 250 ms the walk's start waits for the index.
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(reader.listed).toEqual(['', 'proj']);
    expect(run.stats().finished).toBe(true);
  });
});

// ── Where the service seemed most likely to be wrong ────────────────────────

describe('the ERD Studio folder, wherever the setting puts it', () => {
  const files = [
    'docs/erd/own.dbml',
    'docs/erd/sub/deeper.sql',
    'docs/other/kept.sql',
    'docs/erdx/kept2.sql', // shares only the start of the name
    'erd/kept3.dbml', // only docs/erd is ERD Studio's
    'erd-studio/legacy.sql', // the folder's name before 0.6.44
    'sub/erd-studio/kept4.sql', // not at the top: an ordinary folder
    `sub/${SEMANTIC_DIR}/kept5.dbml`,
  ];
  const KEPT_SQL = ['docs/erdx/kept2.sql', 'docs/other/kept.sql', 'sub/erd-studio/kept4.sql'];
  const KEPT_DBML = ['erd/kept3.dbml', `sub/${SEMANTIC_DIR}/kept5.dbml`];

  for (const semanticDir of ['docs/erd', 'docs/erd/', 'docs\\erd', 'DOCS/ERD']) {
    it(`a nested semanticDir (${JSON.stringify(semanticDir)}) is skipped by the index stage and the walk alike, and nothing else is`, async () => {
      const root = tmpDir();
      for (const file of files) write(root, file, file.endsWith('.sql') ? CREATE_TABLE : DBML);
      builtRepo(root, files);
      const run = looksOf({ semanticDir }).run(root);
      const stage = await run.index;
      const listing = await run.listing();
      expect([...listing.sql].sort()).toEqual(KEPT_SQL.map(under(root)));
      expect([...listing.dbml].sort()).toEqual(KEPT_DBML.map(under(root)));
      expect(listing).toEqual(await oldListing(root, semanticDir));
      expect(stage.usable).toBe(true);
      if (stage.usable) expect(stage.listing).toEqual(listing);
    });
  }
});

describe('what counts as a semantic model, from the index and from the walk', () => {
  it('a database.json is a model beside a tables folder, however that folder\'s name is capitalised', async () => {
    const root = tmpDir();
    const files = ['one/database.json', 'one/Tables/a.json', 'two/DATABASE.JSON', 'two/TABLES/b.json', 'three/database.json', 'three/tables.json', 'four/database.json', 'four/sub/tables/c.json'];
    for (const file of files) write(root, file, '{}');
    builtRepo(root, files);
    const run = looksOf().run(root);
    const stage = await run.index;
    const listing = await run.listing();
    expect(listing.semanticModel).toEqual([`${root}/one/database.json`, `${root}/two/DATABASE.JSON`]);
    expect(listing).toEqual(await oldListing(root));
    expect(stage.usable).toBe(true);
    if (stage.usable) expect(stage.listing).toEqual(listing);
  });
});

describe('what the index stage checks on disk', () => {
  // Was a bug, found here and fixed (folderLook.ts `readIndex`: `modelChecks++` before the `tables/` test): every tracked
  // `database.json` uses up one of the 20 checks on disk, whether or not a `tables/` folder is tracked
  // beside it, so a repository with twenty of them (a common name for a configuration file) loses the
  // semantic model listed after them.
  it('database.json files that are no model do not use up the checks a real model needs', async () => {
    const root = tmpDir();
    const configs = Array.from({ length: 21 }, (_, i) => `apps/svc${String(i).padStart(2, '0')}/config/database.json`);
    const files = [...configs, 'powerbi/Sales.SemanticModel/model.bim'];
    for (const file of files) write(root, file, '{}');
    builtRepo(root, files);
    const reader = new CountingReader(root, nodeScanReader, () => 'never');
    const stage = await looksOf({ io: { reader } }).run(root).index;
    expect(stage.usable && stage.listing.semanticModel).toEqual([`${root}/powerbi/Sales.SemanticModel/model.bim`]);
  });

  it('the control: with fewer of them the model is listed', async () => {
    const root = tmpDir();
    const configs = Array.from({ length: 5 }, (_, i) => `apps/svc${i}/config/database.json`);
    const files = [...configs, 'powerbi/Sales.SemanticModel/model.bim'];
    for (const file of files) write(root, file, '{}');
    builtRepo(root, files);
    const reader = new CountingReader(root, nodeScanReader, () => 'never');
    const stage = await looksOf({ io: { reader } }).run(root).index;
    expect(stage.usable && stage.listing.semanticModel).toEqual([`${root}/powerbi/Sales.SemanticModel/model.bim`]);
  });
});

describe('the start screen\'s look after activation\'s dbt search has walked the top of the folder', () => {
  /** A folder outside git: a script at the top, and a chain of folders whose seventh never answers. */
  function searched(): { root: string; reader: CountingReader; looks: FolderLooks } {
    const root = tmpDir();
    write(root, 'schema.sql', CREATE_TABLE);
    write(root, 'l1/l2/l3/l4/l5/l6/l7/l8/readme.txt');
    const reader = new CountingReader(root, nodeScanReader, (rel) => (depthOf(rel) > DBT_SEARCH_MAX_DEPTH ? 'never' : undefined));
    return { root, reader, looks: looksOf({ io: { reader, ...noGit } }) };
  }

  it('the control: the dbt search lists the top of the folder, and what it met is known to the look', async () => {
    const { root, reader, looks } = searched();
    expect(await looks.dbtProjectsBelow([root])).toEqual([]);
    expect(reader.listed).toHaveLength(DBT_SEARCH_MAX_DEPTH + 1);
    expect(looks.run(root).listingSoFar().sql).toEqual([`${root}/schema.sql`]);
  });

  // Outside a repository the look once read what had been found so far only when the walk reported
  // something new: what the dbt project search had already listed (it runs first in every window without
  // dbt) waited for the walk's next find, or its end.
  it('says at once what the dbt search already met, without waiting for the rest of the walk', async () => {
    const { root, reader, looks } = searched();
    await looks.dbtProjectsBelow([root]);
    const early: ImportFindings[] = [];
    let settled = false;
    void folderStartLook(looks, root, SEMANTIC_DIR)(new AbortController().signal, (findings) => { early.push(findings); }).finally(() => { settled = true; });
    await until(() => early.length > 0);
    expect([...early[0].sources]).toEqual(['sqlDdl']);
    // The walk is stuck seven folders down, and the look with it.
    expect(settled).toBe(false);
    expect(reader.inFlight).toBe(1);
  });

  // Was a bug, found here and fixed (importModel.ts `folderStartLook`: `seen = -1`, so the look's first pass runs over an empty
  // listing, counts as fruitless and doubles the wait to 500 ms): outside a repository, or in one tracking
  // nothing to import, the first file the walk finds is read no sooner than half a second after the look
  // began, however early the walk found it.
  it('the first file the walk finds is read at once, not after a pause earned by a pass over nothing', async () => {
    const root = tmpDir();
    write(root, 'schema.sql', CREATE_TABLE);
    write(root, 'deep/readme.txt');
    // The root answers after 60 ms; the folder below it never does, so only what was found so far can answer.
    const reader = new CountingReader(root, nodeScanReader, (rel) => (rel === '' ? 60 : 'never'));
    const looks = looksOf({ io: { reader, ...noGit } });
    const early: ImportFindings[] = [];
    void folderStartLook(looks, root, SEMANTIC_DIR)(new AbortController().signal, (findings) => { early.push(findings); });
    await until(() => early.length > 0, 350);
  });

  it('the control for the one above: the same look does say what it found, in the end', async () => {
    const root = tmpDir();
    write(root, 'schema.sql', CREATE_TABLE);
    write(root, 'deep/readme.txt');
    const reader = new CountingReader(root, nodeScanReader, (rel) => (rel === '' ? 60 : 'never'));
    const looks = looksOf({ io: { reader, ...noGit } });
    const early: ImportFindings[] = [];
    void folderStartLook(looks, root, SEMANTIC_DIR)(new AbortController().signal, (findings) => { early.push(findings); });
    await until(() => early.length > 0);
    expect([...early[0].sources]).toEqual(['sqlDdl']);
    expect(reader.listed).toEqual(['', 'deep']);
  });

  it('in a repository it does say so at once (the same folder, with an index)', async () => {
    const { root, reader } = searched();
    builtRepo(root, ['l1/l2/l3/l4/l5/l6/l7/l8/readme.txt']);
    const looks = looksOf({ io: { reader } });
    await looks.dbtProjectsBelow([root]);
    const early: ImportFindings[] = [];
    void folderStartLook(looks, root, SEMANTIC_DIR)(new AbortController().signal, (findings) => { early.push(findings); });
    await until(() => early.length > 0);
    expect([...early[0].sources]).toEqual(['sqlDdl']);
  });
});

describe('how deep both stages go', () => {
  it('a file sixteen folders down is listed by the index stage and the walk, one seventeen down by neither (the old walk\'s depth)', async () => {
    const root = tmpDir();
    const sixteen = chainOf(Array.from({ length: IMPORT_WALK_MAX_DEPTH }, (_, i) => `d${i + 1}`)).pop() as string;
    const files = [`${sixteen}/at16.sql`, `${sixteen}/d17/at17.sql`];
    for (const file of files) write(root, file, CREATE_TABLE);
    builtRepo(root, files);
    const run = looksOf().run(root);
    const stage = await run.index;
    const listing = await run.listing();
    expect(listing.sql).toEqual([`${root}/${sixteen}/at16.sql`]);
    expect(listing).toEqual(await oldListing(root));
    expect(stage.usable).toBe(true);
    if (stage.usable) expect(stage.listing).toEqual(listing);
  });
});

describe('how the root is spelled', () => {
  it('a trailing slash changes nothing: the same look, the same paths, the index still read', async () => {
    const root = tmpDir();
    write(root, 'db/schema.sql', CREATE_TABLE);
    write(root, 'new.sql', CREATE_TABLE);
    write(root, 'proj/dbt_project.yml', "name: 'p'\n");
    builtRepo(root, ['db/schema.sql', 'proj/dbt_project.yml']);
    const looks = looksOf();
    const run = looks.run(`${root}/`);
    expect(looks.run(root)).toBe(run);
    const stage = await run.index;
    expect(stage).toEqual({
      usable: true,
      listing: { ...EMPTY_LISTING, sql: [`${root}/db/schema.sql`], dbtProject: true },
      dbtDirs: [path.join(root, 'proj')],
    });
    const listing = await run.listing();
    expect(listing.sql).toEqual([`${root}/db/schema.sql`, `${root}/new.sql`]);
    expect(listing).toEqual(await oldListing(`${root}/`));
    expect(await looks.dbtProjectsBelow([`${root}/`])).toEqual([path.join(root, 'proj')]);
  });

  it('a Windows-style root lists as the old walk listed it, with or without its last backslash', async () => {
    const tree: Dir = {
      'schema.sql': FILE,
      [SEMANTIC_DIR]: { 'own.dbml': FILE },
      db: { 'tables.SQL': FILE, tabular: { 'database.json': FILE, tables: {} } },
      node_modules: { 'x.sql': FILE },
    };
    for (const root of ['C:\\repo', 'C:\\repo\\']) {
      const disk = new MemoryDisk(tree, root);
      const reader = new CountingReader(root, disk);
      const listing = await looksOf({ io: { reader, ...noGit } }).run(root).listing();
      const sep = root.endsWith('\\') ? '' : '/';
      expect(listing).toEqual({
        sql: [`${root}${sep}db/tables.SQL`, `${root}${sep}schema.sql`],
        dbml: [],
        semanticModel: [`${root}${sep}db/tabular/database.json`],
        dbtProject: false,
        truncated: false,
      });
      expect(listing).toEqual(await listImportFiles(root, async (folder) => disk.entries(folder), { semanticDir: SEMANTIC_DIR }));
      // The ERD Studio folder is listed (for dbt projects below it), but its own.dbml is no import file.
      expect([...reader.listed].sort()).toEqual(['', SEMANTIC_DIR, 'db', 'db/tabular', 'db/tabular/tables']);
    }
  });
});

describe('an index that is there but cannot be read', () => {
  /** Whether taking a file's permissions away stops this process reading it (not on Windows, not as root). */
  const canDeny = (() => {
    if (process.platform === 'win32') return false;
    const probe = path.join(gitHome, 'probe');
    try {
      fs.writeFileSync(probe, 'x');
      fs.chmodSync(probe, 0o000);
    } catch {
      return false;
    }
    try {
      fs.readFileSync(probe);
      return false;
    } catch {
      return true;
    }
  })();

  /** A repository tracking a dbt project nine folders down: deeper than any walk for dbt projects goes. */
  function deepProjectRepo(): { root: string; project: string } {
    const root = tmpDir();
    const nine = 't1/t2/t3/t4/t5/t6/t7/t8/deep';
    write(root, `${nine}/dbt_project.yml`, "name: 'deep'\n");
    builtRepo(root, [`${nine}/dbt_project.yml`]);
    return { root, project: path.join(root, ...nine.split('/')) };
  }

  it('the control: while the index can be read, the look answers for git and knows the project', async () => {
    const { root, project } = deepProjectRepo();
    const looks = looksOf();
    expect(await looks.indexed([root])).toBe(true);
    expect(await looks.dbtProjectsBelow([root])).toEqual([project]);
  });

  // An index that exists and cannot be read (a permission, another program holding it) once counted as
  // "nothing is tracked": activation then skipped the host's search for dbt_project.yml, believing every
  // tracked project was known, and the project deeper than the walk goes was not found.
  it.skipIf(!canDeny)('is not "nothing is tracked": the index stage is unusable, so nobody takes it that every tracked project is known', async () => {
    const { root } = deepProjectRepo();
    fs.chmodSync(indexPathOf(root), 0o000);
    const looks = looksOf();
    expect(await looks.run(root).index).toEqual({ usable: false, repository: true });
    expect(await looks.indexed([root])).toBe(false);
    // The walk alone: six folders deep, so the project nine down is the host search's to find.
    expect(await looks.dbtProjectsBelow([root])).toEqual([]);
  });
});

describe('a linked worktree', () => {
  it.skipIf(!hasGit)('is read from its own index (its .git is a file), not the main checkout\'s', async () => {
    const main = tmpDir();
    const parent = tmpDir();
    const worktree = path.join(parent, 'wt');
    write(main, 'db/schema.sql', CREATE_TABLE);
    gitRepo(main);
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', worktree);
    expect(fs.statSync(path.join(worktree, '.git')).isFile()).toBe(true);
    // Added in the worktree only, and one file not added anywhere.
    write(worktree, 'db/orders.sql', CREATE_TABLE);
    git(worktree, 'add', '-f', 'db/orders.sql');
    write(worktree, 'db/untracked.sql', CREATE_TABLE);

    const reader = new CountingReader(worktree, nodeScanReader, () => 'never');
    const stage = await looksOf({ io: { reader } }).run(worktree).index;
    expect(stage).toEqual({
      usable: true,
      listing: { ...EMPTY_LISTING, sql: [`${worktree}/db/orders.sql`, `${worktree}/db/schema.sql`] },
      dbtDirs: [],
    });
    const mainStage = await looksOf({ io: { reader: new CountingReader(main, nodeScanReader, () => 'never') } }).run(main).index;
    expect(mainStage.usable && mainStage.listing.sql).toEqual([`${main}/db/schema.sql`]);

    const listing = await looksOf().run(worktree).listing();
    expect(listing).toEqual(await oldListing(worktree));
    expect(listing.sql).toHaveLength(3);
  });
});
