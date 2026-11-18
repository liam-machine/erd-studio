/**
 * The one walk of the open folder (`src/services/folderScan.ts`, #347):
 * breadth first and depth by depth, only as deep as somebody has asked,
 * bounded by folders listed (the walk's bound, and each caller's own), never
 * more than two listings in flight, the same result whichever listing answers
 * first, each real folder once.
 *
 * Almost every test walks an in-memory disk (`FakeDisk`) that records each
 * listing, so "how many folders were listed, and in what order" is asserted
 * rather than assumed. The last block reads a real temporary folder.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FolderScan,
  nodeReadDirEntries,
  nodeScanReader,
  type FolderScanOptions,
  type ScanEntry,
  type ScanReader,
  type ScanSnapshot,
} from '../../src/services/folderScan';

// ── The in-memory disk ──────────────────────────────────────────────────────

const FILE = 'file' as const;
/** A folder the disk refuses to list. */
const LOCKED = 'locked' as const;

/** A symbolic link to a path under the root (`''` is the root itself). A path that names nothing dangles. */
class Link {
  constructor(readonly to: string) {}
}
const link = (to: string): Link => new Link(to);

interface Dir { [name: string]: TreeNode }
/** A folder made when it is listed, so a tree of 300,000 folders costs nothing until it is walked. */
type LazyDir = () => Dir;
type TreeNode = typeof FILE | typeof LOCKED | Link | Dir | LazyDir;

const ROOT = '/r';

/** How long a read takes: milliseconds, never, or until a promise settles (a rejection refuses the read). */
type Wait = number | 'never' | Promise<void> | undefined;

interface FakeDiskOptions {
  /** How long a folder's listing takes, by its path under the root. */
  delay?: (rel: string) => Wait;
  /** How long a link's answer takes, by its path under the root. */
  linkDelay?: (rel: string) => Wait;
}

async function waitFor(wait: Wait): Promise<void> {
  if (wait === 'never') await new Promise<never>(() => undefined);
  else if (typeof wait === 'number') { if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait)); }
  else if (wait) await wait;
}

class FakeDisk implements ScanReader {
  /** Every folder listed, as its path under the root, in the order asked. */
  readonly listed: string[] = [];
  /** Every link asked about, as its path under the root, in the order asked. */
  readonly resolved: string[] = [];
  inFlight = 0;
  maxInFlight = 0;

  constructor(
    private readonly tree: Dir | LazyDir,
    private readonly options: FakeDiskOptions = {},
    private readonly root: string = ROOT,
  ) {}

  private rel(fullPath: string): string {
    if (fullPath === this.root) return '';
    if (!fullPath.startsWith(`${this.root}/`)) throw new Error(`Not under the root: ${fullPath}`);
    return fullPath.slice(this.root.length + 1);
  }

  /** The node at a path, following links on the way (and at the end, unless `keepLink`). */
  private nodeAt(rel: string, keepLink = false, hops = 0): TreeNode | undefined {
    if (hops > 20) return undefined;
    let node: TreeNode | undefined = this.tree;
    const parts = rel === '' ? [] : rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      if (node instanceof Link) node = this.nodeAt(node.to, false, hops + 1);
      if (typeof node === 'function') node = node();
      if (!node || typeof node !== 'object' || node instanceof Link) return undefined;
      node = node[parts[i]];
    }
    if (node instanceof Link && !keepLink) node = this.nodeAt(node.to, false, hops + 1);
    return typeof node === 'function' ? node() : node;
  }

  async readDir(folder: string): Promise<readonly ScanEntry[]> {
    const rel = this.rel(folder);
    this.listed.push(rel);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await waitFor(this.options.delay?.(rel));
      const dir = this.nodeAt(rel);
      if (!dir || typeof dir !== 'object' || dir instanceof Link) throw new Error(`EACCES: ${folder}`);
      return Object.entries(dir).map(([name, node]): ScanEntry => ({
        name,
        kind: node instanceof Link ? 'link' : node === FILE ? 'file' : 'dir',
      }));
    } finally {
      this.inFlight--;
    }
  }

  async resolveLink(linkPath: string): Promise<{ isDirectory: boolean; realPath: string } | undefined> {
    const rel = this.rel(linkPath);
    this.resolved.push(rel);
    await waitFor(this.options.linkDelay?.(rel));
    const self = this.nodeAt(rel, true);
    if (!(self instanceof Link)) throw new Error(`Not a link: ${linkPath}`);
    const target = this.nodeAt(self.to);
    if (target === undefined) return undefined;
    if (target === FILE) return { isDirectory: false, realPath: linkPath };
    // The same spelling the walk gives an ordinary folder: `path.join` from the root's real path.
    return { isDirectory: true, realPath: path.join(this.root, ...(self.to === '' ? [] : self.to.split('/'))) };
  }

  async realPath(folder: string): Promise<string> {
    return path.join(folder);
  }
}

function scanOf(reader: ScanReader, options: Partial<FolderScanOptions> = {}, root: string = ROOT): FolderScan {
  return new FolderScan(root, reader, {
    ignoredFolders: new Set(['node_modules', '.git']),
    include: (name) => name.endsWith('.sql'),
    maxFolders: 1000,
    maxDepth: 16,
    maxFiles: 100,
    ...options,
  });
}

/** Lets everything already queued run: timers that are due, then the walk's own `setImmediate`. */
async function turn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setImmediate(resolve));
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const depthOf = (rel: string): number => (rel === '' ? 0 : rel.split('/').length);

/** Every folder of a tree (links not followed), as paths under the root. */
function foldersOf(tree: Dir, rel = ''): string[] {
  const out = [rel];
  for (const [name, node] of Object.entries(tree)) {
    if (typeof node === 'object' && !(node instanceof Link)) out.push(...foldersOf(node, rel === '' ? name : `${rel}/${name}`));
  }
  return out;
}

/** A chain `levels` folders deep: every level holds a file, a `side` folder and the next level (`down`). */
function chain(levels: number): Dir {
  const dir: Dir = { 'here.sql': FILE, side: { 'side.sql': FILE } };
  if (levels > 0) dir.down = chain(levels - 1);
  return dir;
}

/** `fanOut` folders in every folder, `depth` levels down, and no file the walk is looking for. */
function wide(fanOut: number, depth: number): LazyDir {
  return () => {
    const dir: Dir = { 'readme.txt': FILE };
    if (depth > 0) for (let i = 0; i < fanOut; i++) dir[`d${i}`] = wide(fanOut, depth - 1);
    return dir;
  };
}

/** Three levels of three folders, a `.sql` file in each folder and a `dbt_project.yml` in some. */
function bushy(): Dir {
  const level = (depth: number, label: string): Dir => {
    const dir: Dir = { [`${label}.sql`]: FILE };
    if (label.length % 2 === 0) dir['dbt_project.yml'] = FILE;
    if (depth > 0) for (const name of ['c', 'a', 'b']) dir[name] = level(depth - 1, `${label}${name}`);
    return dir;
  };
  return level(3, 'm');
}

const hash = (text: string): number => [...text].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 997, 7);

// ── Tests ───────────────────────────────────────────────────────────────────

describe('FolderScan — what a walk finds', () => {
  it('finds matching files depth by depth, never enters an ignored or skipped folder, and stops at maxDepth', async () => {
    const disk = new FakeDisk({
      'b.sql': FILE,
      'a.sql': FILE,
      'notes.txt': FILE,
      node_modules: { 'dep.sql': FILE },
      '.git': { 'x.sql': FILE },
      '.erd-studio': { 'own.sql': FILE },
      src: { 'c.sql': FILE, deep: { 'd.sql': FILE, deeper: { 'e.sql': FILE, deepest: { 'f.sql': FILE } } } },
      docs: { 'z.sql': FILE, '.erd-studio': { 'kept.sql': FILE } },
    });
    const scan = scanOf(disk, { maxDepth: 3, skipFolder: (rel) => rel === '.erd-studio' });
    expect(scan.snapshot()).toEqual({ files: [], marked: [], folders: 0, depthDone: -1, done: false, capped: false, truncated: false });

    await scan.finish();

    // The shallowest first; `docs/.erd-studio` is not the root's `.erd-studio`, so it is entered.
    expect(scan.snapshot()).toEqual({
      files: ['a.sql', 'b.sql', 'docs/z.sql', 'src/c.sql', 'docs/.erd-studio/kept.sql', 'src/deep/d.sql', 'src/deep/deeper/e.sql'],
      marked: [],
      folders: 6,
      depthDone: 3,
      done: true,
      capped: false,
      truncated: false,
    });
    expect(disk.listed).toEqual(['', 'docs', 'src', 'docs/.erd-studio', 'src/deep', 'src/deep/deeper']);
  });

  it('builds each folder path from the root as given, joined with `/`', async () => {
    const asked: string[] = [];
    const reader: ScanReader = {
      readDir: async (folder) => {
        asked.push(folder);
        return depthOf(folder.replace(/^.*repo[\\/]?/, '')) < 2 ? [{ name: 'a', kind: 'dir' }, { name: 'x.sql', kind: 'file' }] : [];
      },
      resolveLink: async () => undefined,
      realPath: async (folder) => folder,
    };
    const windows = scanOf(reader, {}, 'C:\\repo');
    await windows.finish();
    expect(asked).toEqual(['C:\\repo', 'C:\\repo/a', 'C:\\repo/a/a']);
    expect(windows.snapshot().files).toEqual(['x.sql', 'a/x.sql']);

    asked.length = 0;
    await scanOf(reader, {}, '/home/me/repo/').finish();
    expect(asked).toEqual(['/home/me/repo/', '/home/me/repo/a', '/home/me/repo/a/a']);
  });

  it('lists only the root at maxDepth 0, and nothing at maxFolders 0', async () => {
    const disk = new FakeDisk(chain(3));
    const shallow = scanOf(disk, { maxDepth: 0 });
    await shallow.finish();
    expect(disk.listed).toEqual(['']);
    expect(shallow.snapshot()).toMatchObject({ files: ['here.sql'], depthDone: 0, done: true, capped: false });

    const none = new FakeDisk(chain(3));
    const empty = scanOf(none, { maxFolders: 0 });
    await empty.finish();
    expect(none.listed).toEqual([]);
    expect(empty.snapshot()).toMatchObject({ files: [], folders: 0, depthDone: -1, done: true, capped: true });
  });
});

describe('FolderScan — only as deep as somebody asked', () => {
  it('lists nothing before the first reach', async () => {
    const disk = new FakeDisk(chain(4));
    const scan = scanOf(disk);
    await turn();
    expect(disk.listed).toEqual([]);
    expect(scan.snapshot()).toMatchObject({ folders: 0, depthDone: -1, done: false });
  });

  it('reach(2) on a deep tree lists depths 0 to 2 and waits; finish() lists the rest, each folder once', async () => {
    const tree = chain(20);
    const disk = new FakeDisk(tree);
    const scan = scanOf(disk, { maxDepth: 30 });

    await scan.reach(2);
    expect(disk.listed).toEqual(['', 'down', 'side', 'down/down', 'down/side']);
    expect(scan.snapshot()).toMatchObject({ folders: 5, depthDone: 2, done: false, capped: false });
    expect(scan.snapshot().files).toEqual(['here.sql', 'down/here.sql', 'side/side.sql', 'down/down/here.sql', 'down/side/side.sql']);

    // Nothing more happens until somebody asks.
    await turn();
    await turn();
    expect(disk.listed).toHaveLength(5);

    await scan.finish();
    const all = foldersOf(tree);
    expect(disk.listed).toHaveLength(all.length);
    expect(new Set(disk.listed).size).toBe(disk.listed.length);
    expect([...disk.listed].sort()).toEqual([...all].sort());
    // Depth by depth: a folder is never listed before a shallower one.
    expect(disk.listed.map(depthOf)).toEqual([...disk.listed.map(depthOf)].sort((a, b) => a - b));
    expect(scan.snapshot()).toMatchObject({ folders: all.length, depthDone: 30, done: true, capped: false });
  });

  it('reach(6) on a tree 20 levels deep lists every folder of depths 0 to 6 and none below', async () => {
    const tree = chain(20);
    const disk = new FakeDisk(tree);
    const scan = scanOf(disk, { maxDepth: 30 });
    await scan.reach(6);
    expect([...disk.listed].sort()).toEqual(foldersOf(tree).filter((rel) => depthOf(rel) <= 6).sort());
    expect(scan.snapshot()).toMatchObject({ depthDone: 6, done: false });
  });

  it('resolves overlapping and repeated calls, each as soon as its depth is done', async () => {
    const disk = new FakeDisk(chain(8));
    const scan = scanOf(disk);
    const resolved: Array<{ asked: number; depthDone: number }> = [];
    const ask = (depth: number): Promise<void> => scan.reach(depth).then(() => { resolved.push({ asked: depth, depthDone: scan.snapshot().depthDone }); });

    await Promise.all([ask(3), ask(1), ask(3), ask(0), ask(2)]);

    expect(resolved.map((r) => r.asked)).toEqual([0, 1, 2, 3, 3]);
    for (const r of resolved) expect(r.depthDone).toBeGreaterThanOrEqual(r.asked);
    // Only what the deepest call asked for was listed.
    expect(Math.max(...disk.listed.map(depthOf))).toBe(3);
    expect(scan.snapshot()).toMatchObject({ depthDone: 3, done: false });

    // A depth already done answers at once and lists nothing.
    const before = disk.listed.length;
    await scan.reach(1);
    await scan.reach(3);
    expect(disk.listed).toHaveLength(before);
  });

  it('ends when the tree is shallower than the depth asked for, and answers at once afterwards', async () => {
    const disk = new FakeDisk({ a: { 'x.sql': FILE }, 'y.sql': FILE });
    const scan = scanOf(disk);
    await scan.reach(6);
    // Nothing is left, so every depth the walk may go to is done.
    expect(scan.snapshot()).toMatchObject({ files: ['y.sql', 'a/x.sql'], folders: 2, depthDone: 16, done: true, capped: false });

    await scan.reach(12);
    await scan.finish();
    await scan.reach(99);
    expect(disk.listed).toEqual(['', 'a']);
  });

  it('treats a depth past maxDepth as maxDepth', async () => {
    const disk = new FakeDisk(chain(6));
    const scan = scanOf(disk, { maxDepth: 2 });
    await scan.reach(99);
    expect(Math.max(...disk.listed.map(depthOf))).toBe(2);
    expect(scan.snapshot()).toMatchObject({ depthDone: 2, done: true, capped: false });
  });
});

describe('FolderScan — bounded', () => {
  it('lists exactly maxFolders folders of a huge tree with nothing to find, two at a time at most', async () => {
    // Fan-out 8, six levels down: 299,593 folders, none holding a matching file.
    const disk = new FakeDisk(wide(8, 6));
    const scan = scanOf(disk, { maxFolders: 500 });

    await scan.finish();

    expect(disk.listed).toHaveLength(500);
    expect(new Set(disk.listed).size).toBe(500);
    expect(scan.snapshot()).toEqual({ files: [], marked: [], folders: 500, depthDone: 2, done: true, capped: true, truncated: false });
    expect(disk.maxInFlight).toBe(2);
    expect(disk.inFlight).toBe(0);
    // The shallowest 500: all of depths 0 to 2 (73 folders), then the first of depth 3.
    expect(disk.listed.filter((rel) => depthOf(rel) <= 2)).toHaveLength(73);
    expect(Math.max(...disk.listed.map(depthOf))).toBe(3);

    // Over is over: asking again lists nothing more.
    await scan.finish();
    expect(disk.listed).toHaveLength(500);
  });

  it('is not capped when the last folder allowed is the last folder there is', async () => {
    const tree = chain(3);
    const disk = new FakeDisk(tree);
    const scan = scanOf(disk, { maxFolders: foldersOf(tree).length });
    await scan.finish();
    expect(scan.snapshot()).toMatchObject({ folders: foldersOf(tree).length, done: true, capped: false });
  });

  it('is not capped by folders the caller has not asked for yet', async () => {
    const disk = new FakeDisk(chain(5));
    // Depths 0 and 1 are three folders: the limit is met exactly when reach(1) is done.
    const scan = scanOf(disk, { maxFolders: 3 });
    await scan.reach(1);
    expect(scan.snapshot()).toMatchObject({ folders: 3, depthDone: 1, done: false, capped: false });
    await scan.reach(2);
    expect(scan.snapshot()).toMatchObject({ folders: 3, depthDone: 1, done: true, capped: true });
  });

  it('visits the first folders in order however many a depth holds, and keeps the first files of a huge folder', async () => {
    // One folder of 6,000 folders and 6,000 matching files: far more than either limit will take.
    const names = Array.from({ length: 6000 }, (_, i) => `n${i}`);
    const tree: Dir = {};
    for (const name of [...names].reverse()) {
      tree[name] = { 'inner.sql': FILE };
      tree[`${name}.sql`] = FILE;
    }
    const evenFirst = (rel: string): number => Number(rel.slice(1)) % 2;
    const expected = [...names].sort((a, b) => evenFirst(a) - evenFirst(b) || (a < b ? -1 : 1));

    const disk = new FakeDisk(tree);
    const scan = scanOf(disk, { maxFolders: 41, maxFiles: 25, rank: evenFirst });
    await scan.finish();

    expect(disk.listed).toEqual(['', ...expected.slice(0, 40)]);
    expect(scan.snapshot()).toMatchObject({
      files: [...names].map((name) => `${name}.sql`).sort().slice(0, 25),
      folders: 41,
      depthDone: 0,
      done: true,
      capped: true,
      truncated: true,
    });

    // With room for all of them, all of them are listed.
    const roomy = new FakeDisk(tree);
    const whole = scanOf(roomy, { maxFolders: 6001, maxFiles: 20_000, rank: evenFirst });
    await whole.finish();
    expect(roomy.listed).toEqual(['', ...expected]);
    expect(whole.snapshot()).toMatchObject({ folders: 6001, done: true, capped: false, truncated: false });
    expect(whole.snapshot().files).toHaveLength(12_000);
  });

  it('honours `concurrency`', async () => {
    const one = new FakeDisk(wide(4, 3));
    await scanOf(one, { concurrency: 1 }).finish();
    expect(one.maxInFlight).toBe(1);

    const four = new FakeDisk(wide(4, 3));
    await scanOf(four, { concurrency: 4 }).finish();
    expect(four.maxInFlight).toBe(4);
    expect([...four.listed].sort()).toEqual([...one.listed].sort());
  });
});

describe('FolderScan — the same on every run', () => {
  const mark = (name: string): boolean => name === 'dbt_project.yml';

  async function run(delay: FakeDiskOptions['delay'], options: Partial<FolderScanOptions> = {}): Promise<{ disk: FakeDisk; scan: FolderScan }> {
    const disk = new FakeDisk(bushy(), { delay });
    const scan = scanOf(disk, { mark, ...options });
    await scan.finish();
    return { disk, scan };
  }

  it('gives the same files, marks and listing order whichever listing answers first', async () => {
    const instant = await run(undefined);
    const oneWay = await run((rel) => hash(rel) % 4);
    const otherWay = await run((rel) => 3 - (hash(rel) % 4));

    expect(instant.scan.snapshot().files).toHaveLength(40);
    expect(instant.scan.snapshot().marked.length).toBeGreaterThan(5);
    for (const other of [oneWay, otherWay]) {
      expect(other.scan.snapshot()).toEqual(instant.scan.snapshot());
      expect(other.disk.listed).toEqual(instant.disk.listed);
    }
    // Within a depth: code-unit order of the paths, not the order the disk gave them (`c`, `a`, `b`).
    expect(instant.disk.listed.slice(0, 7)).toEqual(['', 'a', 'b', 'c', 'a/a', 'a/b', 'a/c']);
    expect(instant.scan.snapshot().files.slice(0, 5)).toEqual(['m.sql', 'a/ma.sql', 'b/mb.sql', 'c/mc.sql', 'a/a/maa.sql']);
  });

  it('visits the same folders when maxFolders cuts a depth short', async () => {
    // 1 + 3 + 9 = 13 folders above the last depth; 17 stops four folders into its 27.
    const instant = await run(undefined, { maxFolders: 17 });
    const oneWay = await run((rel) => hash(rel) % 4, { maxFolders: 17 });
    const otherWay = await run((rel) => 3 - (hash(rel) % 4), { maxFolders: 17 });

    expect(instant.disk.listed).toHaveLength(17);
    expect(instant.disk.listed.slice(13)).toEqual(['a/a/a', 'a/a/b', 'a/a/c', 'a/b/a']);
    expect(instant.scan.snapshot()).toMatchObject({ folders: 17, depthDone: 2, done: true, capped: true });
    for (const other of [oneWay, otherWay]) {
      expect(other.disk.listed).toEqual(instant.disk.listed);
      expect(other.scan.snapshot()).toEqual(instant.scan.snapshot());
    }
  });

  it('shows a listing that answered early in a snapshot, and still files it in its folder\'s place', async () => {
    const slow = deferred();
    const disk = new FakeDisk(
      { a: { '1.sql': FILE }, b: { '2.sql': FILE }, c: { '3.sql': FILE } },
      { delay: (rel) => (rel === 'a' ? slow.promise : undefined) },
    );
    const scan = scanOf(disk);
    const finished = scan.finish();
    await turn();

    // `a` has not answered; `b` and `c` have.
    expect(scan.snapshot()).toMatchObject({ files: ['b/2.sql', 'c/3.sql'], folders: 4, depthDone: 0, done: false });

    slow.resolve();
    await finished;
    expect(scan.snapshot()).toMatchObject({ files: ['a/1.sql', 'b/2.sql', 'c/3.sql'], depthDone: 16, done: true });
  });
});

describe('FolderScan — rank and compare', () => {
  const tree: Dir = {
    '.hidden': { 'h.sql': FILE },
    visible: { 'v.sql': FILE },
    zeta: { 'z.sql': FILE },
    alpha: { 'a.sql': FILE },
  };
  const hiddenLast = (rel: string): number => (rel.split('/').pop()!.startsWith('.') ? 1 : 0);

  it('lists lower ranks first within a depth, then by name', async () => {
    const plain = new FakeDisk(tree);
    await scanOf(plain).finish();
    expect(plain.listed).toEqual(['', '.hidden', 'alpha', 'visible', 'zeta']);

    const ranked = new FakeDisk(tree);
    const scan = scanOf(ranked, { rank: hiddenLast });
    await scan.finish();
    expect(ranked.listed).toEqual(['', 'alpha', 'visible', 'zeta', '.hidden']);
    expect(scan.snapshot().files).toEqual(['alpha/a.sql', 'visible/v.sql', 'zeta/z.sql', '.hidden/h.sql']);
  });

  it('visits the ranked-first folders when maxFolders is tight', async () => {
    const disk = new FakeDisk(tree);
    const scan = scanOf(disk, { rank: hiddenLast, maxFolders: 3 });
    await scan.finish();
    expect(disk.listed).toEqual(['', 'alpha', 'visible']);
    expect(scan.snapshot()).toMatchObject({ files: ['alpha/a.sql', 'visible/v.sql'], capped: true });

    const reversed = new FakeDisk(tree);
    await scanOf(reversed, { rank: (rel) => -hiddenLast(rel), maxFolders: 3 }).finish();
    expect(reversed.listed).toEqual(['', '.hidden', 'alpha']);
  });

  it('orders folders and files with `compare`, and settles what it calls equal by code-unit order', async () => {
    const backwards = new FakeDisk({ ...tree, '1.sql': FILE, '2.sql': FILE });
    const scan = scanOf(backwards, { compare: (a, b) => (a < b ? 1 : a > b ? -1 : 0) });
    await scan.finish();
    expect(backwards.listed).toEqual(['', 'zeta', 'visible', 'alpha', '.hidden']);
    expect(scan.snapshot().files.slice(0, 2)).toEqual(['2.sql', '1.sql']);

    // A compare that cannot tell `B` from `b` (or anything from anything) still gives one order.
    const tied = new FakeDisk({ b: {}, B: {}, a: {}, 'y.sql': FILE, 'Y.sql': FILE });
    const same = scanOf(tied, { compare: () => 0 });
    await same.finish();
    expect(tied.listed).toEqual(['', 'B', 'a', 'b']);
    expect(same.snapshot().files).toEqual(['Y.sql', 'y.sql']);
  });
});

describe('FolderScan — symbolic links', () => {
  it('follows a link to a folder once, collects a link to a file, ignores a dangling link, and never asks about plain entries', async () => {
    const disk = new FakeDisk({
      'plain.sql': FILE,
      'shortcut.sql': link('real/r.sql'),
      'gone.sql': link('nowhere'),
      real: { 'r.sql': FILE, inner: { 'i.sql': FILE } },
      // Sorts before `real`, yet `real` keeps its own path: a folder reached directly is never dropped for a link to it.
      alias: link('real'),
      node_modules: { pkg: { 'p.sql': FILE } },
      // The only two ways into `pkg` are links: the first by name is walked, the second is not.
      vendor: link('node_modules/pkg'),
      vendor2: link('node_modules/pkg'),
    });
    const scan = scanOf(disk);
    await scan.finish();

    expect(scan.snapshot()).toMatchObject({
      files: ['plain.sql', 'shortcut.sql', 'real/r.sql', 'vendor/p.sql', 'real/inner/i.sql'],
      folders: 4,
      done: true,
      capped: false,
    });
    expect(disk.listed).toEqual(['', 'real', 'vendor', 'real/inner']);
    expect([...disk.resolved].sort()).toEqual(['alias', 'gone.sql', 'shortcut.sql', 'vendor', 'vendor2']);
  });

  it('ends a link that loops back on the root, on its parent or on itself', async () => {
    const disk = new FakeDisk({
      a: { 'a.sql': FILE, loop: link(''), self: link('a'), b: { up: link('a'), 'b.sql': FILE } },
      spin: link('spin'),
    });
    const scan = scanOf(disk);
    await scan.finish();
    expect(disk.listed).toEqual(['', 'a', 'a/b']);
    expect(scan.snapshot()).toMatchObject({ files: ['a/a.sql', 'a/b/b.sql'], folders: 3, done: true, capped: false });
  });

  it('walks a folder through the shallowest way in, and not again where it is reached directly', async () => {
    const disk = new FakeDisk({
      jump: link('real/inner'),
      real: { 'r.sql': FILE, inner: { 'i.sql': FILE } },
    });
    const scan = scanOf(disk);
    await scan.finish();
    expect(disk.listed).toEqual(['', 'jump', 'real']);
    expect(scan.snapshot().files).toEqual(['jump/i.sql', 'real/r.sql']);
  });

  it('ignores, marks and skips a linked folder by the usual rules', async () => {
    const disk = new FakeDisk({
      store: { 'Sales.SemanticModel': { 'model.sql': FILE }, design: { 'd.sql': FILE }, deps: { 'x.sql': FILE } },
      'Sales.SemanticModel': link('store/Sales.SemanticModel'),
      '.erd-studio': link('store/design'),
      node_modules: link('store/deps'),
    });
    const scan = scanOf(disk, {
      ignoredFolders: new Set(['node_modules', 'store']),
      skipFolder: (rel) => rel === '.erd-studio',
      mark: (_name, isDirectory) => isDirectory,
    });
    await scan.finish();
    expect(disk.listed).toEqual(['', 'Sales.SemanticModel']);
    // The ignored name is not marked; the skipped folder is marked and not entered.
    expect(scan.snapshot()).toMatchObject({ files: ['Sales.SemanticModel/model.sql'], marked: ['.erd-studio', 'Sales.SemanticModel'] });
  });

  it('treats a link that cannot be read as dangling, and a root with no real path as the root given', async () => {
    const disk = new FakeDisk({ a: { 'a.sql': FILE }, odd: link('a'), 'x.sql': FILE });
    const reader: ScanReader = {
      readDir: (folder) => disk.readDir(folder),
      resolveLink: () => Promise.reject(new Error('EIO')),
      realPath: () => Promise.reject(new Error('ENOENT')),
    };
    const scan = scanOf(reader);
    await scan.finish();
    expect(disk.listed).toEqual(['', 'a']);
    expect(scan.snapshot()).toMatchObject({ files: ['x.sql', 'a/a.sql'], done: true, capped: false });
  });
});

describe('FolderScan — marks and the file limit', () => {
  const tree: Dir = {
    '1.sql': FILE,
    'dbt_project.yml': FILE,
    'Model.SemanticModel': { 'definition.pbism': FILE, '2.sql': FILE },
    node_modules: { 'Dep.SemanticModel': { 'x.sql': FILE }, 'dbt_project.yml': FILE },
    '.erd-studio': { 'dbt_project.yml': FILE },
    warehouse: {
      '3.sql': FILE,
      '4.sql': FILE,
      nested: { 'dbt_project.yml': FILE, '5.sql': FILE, 'Deep.SemanticModel': { '6.sql': FILE } },
    },
  };
  const mark = (name: string, isDirectory: boolean): boolean =>
    isDirectory ? name.endsWith('.SemanticModel') || name === '.erd-studio' : name === 'dbt_project.yml';

  it('marks files and folders; a marked folder is still entered, skipped or ignored by the usual rules', async () => {
    const disk = new FakeDisk(tree);
    const scan = scanOf(disk, { mark, skipFolder: (rel) => rel === '.erd-studio' });
    await scan.finish();
    expect(scan.snapshot()).toMatchObject({
      marked: ['.erd-studio', 'Model.SemanticModel', 'dbt_project.yml', 'warehouse/nested/Deep.SemanticModel', 'warehouse/nested/dbt_project.yml'],
      files: ['1.sql', 'Model.SemanticModel/2.sql', 'warehouse/3.sql', 'warehouse/4.sql', 'warehouse/nested/5.sql', 'warehouse/nested/Deep.SemanticModel/6.sql'],
      truncated: false,
    });
    // Skipped: marked, not entered. Ignored: neither.
    expect(disk.listed).not.toContain('.erd-studio');
    expect(disk.listed).not.toContain('node_modules');
  });

  it('keeps the shallowest maxFiles files, says there were more, and goes on marking', async () => {
    const disk = new FakeDisk(tree);
    const scan = scanOf(disk, { mark, maxFiles: 2 });
    await scan.finish();
    const found = scan.snapshot();
    expect(found.files).toEqual(['1.sql', 'Model.SemanticModel/2.sql']);
    expect(found.truncated).toBe(true);
    expect(found.capped).toBe(false);
    // Found two depths below the folder where the limit was met.
    expect(found.marked).toContain('warehouse/nested/dbt_project.yml');
    expect(found.marked).toContain('warehouse/nested/Deep.SemanticModel');
    expect(disk.listed).toContain('warehouse/nested/Deep.SemanticModel');
  });

  it('is not truncated at exactly maxFiles, and keeps nothing at maxFiles 0', async () => {
    const exact = scanOf(new FakeDisk(tree), { maxFiles: 6 });
    await exact.finish();
    expect(exact.snapshot()).toMatchObject({ truncated: false });
    expect(exact.snapshot().files).toHaveLength(6);

    const none = scanOf(new FakeDisk(tree), { maxFiles: 0, mark });
    await none.finish();
    expect(none.snapshot()).toMatchObject({ files: [], truncated: true });
    expect(none.snapshot().marked).toContain('dbt_project.yml');
  });
});

describe('FolderScan — nothing stops it', () => {
  it('skips a folder that cannot be listed, and counts it', async () => {
    const disk = new FakeDisk({ locked: LOCKED, open: { 'o.sql': FILE }, 'x.sql': FILE });
    const scan = scanOf(disk);
    await scan.finish();
    expect(disk.listed).toEqual(['', 'locked', 'open']);
    expect(scan.snapshot()).toMatchObject({ files: ['x.sql', 'open/o.sql'], folders: 3, done: true, capped: false });
  });

  it('ends at once when the root itself cannot be listed', async () => {
    const reader: ScanReader = {
      readDir: () => { throw new Error('not even a promise'); },
      resolveLink: async () => undefined,
      realPath: async (folder) => folder,
    };
    const scan = scanOf(reader);
    await scan.finish();
    expect(scan.snapshot()).toEqual({ files: [], marked: [], folders: 1, depthDone: 16, done: true, capped: false, truncated: false });
  });

  it('carries on when include, mark, skipFolder, rank or compare throws', async () => {
    const disk = new FakeDisk({
      'bad.sql': FILE,
      'good.sql': FILE,
      'dbt_project.yml': FILE,
      a: { 'a.sql': FILE },
      b: { 'b.sql': FILE },
    });
    const boom = (): never => { throw new Error('boom'); };
    const scan = scanOf(disk, {
      include: (name) => (name === 'bad.sql' ? boom() : name.endsWith('.sql')),
      mark: (name) => (name === 'dbt_project.yml' ? true : boom()),
      skipFolder: boom,
      rank: boom,
      compare: boom,
    });
    await scan.finish();
    expect(disk.listed).toEqual(['', 'a', 'b']);
    expect(scan.snapshot()).toMatchObject({ files: ['good.sql', 'a/a.sql', 'b/b.sql'], marked: ['dbt_project.yml'], done: true, capped: false });
  });
});

describe('FolderScan — maxMs', () => {
  /** A chain of single folders: one listing per depth, each taking 10 ms by the injected clock. */
  const single = (levels: number): Dir => (levels > 0 ? { 'f.sql': FILE, d: single(levels - 1) } : { 'f.sql': FILE });

  it('stops listing once the time is spent, and says so', async () => {
    let clock = 5000;
    const disk = new FakeDisk(single(10), { delay: () => { clock += 10; return undefined; } });
    const scan = scanOf(disk, { maxMs: 35, now: () => clock });
    await scan.finish();
    // 0, 10, 20 and 30 ms in: listed. 40 ms in: over.
    expect(disk.listed).toEqual(['', 'd', 'd/d', 'd/d/d']);
    expect(scan.snapshot()).toMatchObject({ files: ['f.sql', 'd/f.sql', 'd/d/f.sql', 'd/d/d/f.sql'], folders: 4, depthDone: 3, done: true, capped: true });
  });

  it('is not capped when the walk ends inside the time', async () => {
    let clock = 0;
    const disk = new FakeDisk(single(2), { delay: () => { clock += 10; return undefined; } });
    const scan = scanOf(disk, { maxMs: 35, now: () => clock });
    await scan.finish();
    expect(scan.snapshot()).toMatchObject({ folders: 3, done: true, capped: false });
  });

  it('does not count the wait between one ask and a deeper one', async () => {
    let clock = 0;
    const disk = new FakeDisk(single(10), { delay: () => { clock += 10; return undefined; } });
    const scan = scanOf(disk, { maxMs: 35, now: () => clock });
    await scan.reach(0);
    clock += 60_000;
    await scan.finish();
    expect(disk.listed).toEqual(['', 'd', 'd/d', 'd/d/d']);
    expect(scan.snapshot()).toMatchObject({ folders: 4, done: true, capped: true });
  });

  it('cannot be hung by a listing that never answers', async () => {
    const disk = new FakeDisk(
      { answers: { 'a.sql': FILE }, hangs: { 'h.sql': FILE }, zlast: { 'z.sql': FILE } },
      { delay: (rel) => (rel === 'hangs' ? 'never' : undefined) },
    );
    const scan = scanOf(disk, { maxMs: 40 });
    const started = Date.now();
    await scan.finish();
    expect(Date.now() - started).toBeLessThan(5000);
    // What answered is kept, on both sides of the listing that did not.
    expect(scan.snapshot()).toMatchObject({ files: ['answers/a.sql', 'zlast/z.sql'], folders: 4, depthDone: 0, done: true, capped: true });
  });

  it('cannot be hung by a link that never answers', async () => {
    const disk = new FakeDisk(
      { 'x.sql': FILE, stuck: link('a'), a: { 'a.sql': FILE } },
      { linkDelay: () => 'never' },
    );
    const scan = scanOf(disk, { maxMs: 30 });
    await scan.finish();
    expect(scan.snapshot()).toMatchObject({ files: [], folders: 1, depthDone: -1, done: true, capped: true });
  });

  it('asks for every folder it counts, even by a clock that moves each time it is read', async () => {
    let clock = 0;
    const disk = new FakeDisk(single(30));
    const scan = scanOf(disk, { maxMs: 20, now: () => clock++, maxDepth: 40 });
    await scan.finish();
    expect(scan.snapshot()).toMatchObject({ done: true, capped: true });
    expect(scan.snapshot().folders).toBe(disk.listed.length);
    expect(disk.listed.length).toBeGreaterThan(2);
    expect(disk.listed.length).toBeLessThan(21);
  });

  it('lists nothing when there is no time at all', async () => {
    const disk = new FakeDisk(single(3));
    const scan = scanOf(disk, { maxMs: 0 });
    await scan.finish();
    expect(disk.listed).toEqual([]);
    expect(scan.snapshot()).toMatchObject({ folders: 0, done: true, capped: true });
  });
});

describe('FolderScan — cancel and onProgress', () => {
  it('cancel lets every waiting reach go and starts no more listings', async () => {
    const gate = deferred();
    const disk = new FakeDisk(chain(6), { delay: (rel) => (depthOf(rel) === 1 ? gate.promise : undefined) });
    const scan = scanOf(disk);
    const waiting = [scan.reach(1), scan.reach(4), scan.finish()];
    await turn();
    expect(disk.listed).toEqual(['', 'down', 'side']);

    scan.cancel();
    await Promise.all(waiting);
    expect(scan.snapshot()).toMatchObject({ files: ['here.sql'], folders: 3, depthDone: 0, done: true, capped: false });

    // The listings in flight answer into nothing, and no other starts.
    gate.resolve();
    await turn();
    await scan.finish();
    await scan.reach(3);
    expect(disk.listed).toEqual(['', 'down', 'side']);
    expect(scan.snapshot()).toMatchObject({ files: ['here.sql'], folders: 3, depthDone: 0, done: true, capped: false });
  });

  it('a listing refused after the walk was cancelled is nobody\'s unhandled rejection', async () => {
    const gate = deferred();
    const disk = new FakeDisk(chain(2), { delay: (rel) => (rel === 'down' ? gate.promise : undefined) });
    const scan = scanOf(disk);
    const waiting = scan.finish();
    await turn();
    scan.cancel();
    await waiting;
    gate.reject(new Error('EIO, late'));
    await turn();
    expect(scan.snapshot()).toMatchObject({ done: true, capped: false });
  });

  it('cancel before the first reach means nothing is ever listed', async () => {
    const disk = new FakeDisk(chain(3));
    const scan = scanOf(disk);
    scan.cancel();
    await scan.finish();
    await turn();
    expect(disk.listed).toEqual([]);
    expect(scan.snapshot()).toEqual({ files: [], marked: [], folders: 0, depthDone: -1, done: true, capped: false, truncated: false });
  });

  it('tells listeners after finds and once at the end; a removed listener hears nothing', async () => {
    const disk = new FakeDisk(chain(5), { delay: () => 2 });
    const scan = scanOf(disk);
    const heard: Array<{ files: number; done: boolean }> = [];
    scan.onProgress(() => { const s = scan.snapshot(); heard.push({ files: s.files.length, done: s.done }); });
    let removedHeard = 0;
    const remove = scan.onProgress(() => { removedHeard++; });
    remove();
    let throwerHeard = 0;
    scan.onProgress(() => { throwerHeard++; throw new Error('a listener\'s own problem'); });

    await scan.finish();
    await turn();

    expect(heard.length).toBeGreaterThanOrEqual(3);
    expect(heard.length).toBeLessThanOrEqual(disk.listed.length + 1);
    expect(heard[0]).toEqual({ files: 1, done: false });
    // Never fewer files than before, and the last word is the end.
    expect(heard.map((h) => h.files)).toEqual([...heard.map((h) => h.files)].sort((a, b) => a - b));
    expect(heard.filter((h) => h.done)).toEqual([{ files: 12, done: true }]);
    expect(heard[heard.length - 1].done).toBe(true);
    expect(removedHeard).toBe(0);
    expect(throwerHeard).toBe(heard.length);
  });

  it('tells listeners once for everything found in one turn of the event loop', async () => {
    // No delay: the whole walk answers before the event loop turns.
    const disk = new FakeDisk(bushy());
    const scan = scanOf(disk);
    const heard: boolean[] = [];
    scan.onProgress(() => heard.push(scan.snapshot().done));
    await scan.finish();
    expect(heard).toEqual([]);
    await turn();
    expect(heard).toEqual([true]);
  });

  it('tells listeners when the walk is cancelled, and when it ends having found nothing', async () => {
    const cancelled = scanOf(new FakeDisk(chain(2), { delay: () => 'never' }));
    let heard = 0;
    cancelled.onProgress(() => { heard++; });
    void cancelled.finish();
    await turn();
    expect(heard).toBe(0);
    cancelled.cancel();
    await turn();
    expect(heard).toBe(1);

    const empty = scanOf(new FakeDisk({ 'readme.txt': FILE }));
    let emptyHeard = 0;
    empty.onProgress(() => { emptyHeard++; });
    await empty.finish();
    await turn();
    expect(emptyHeard).toBe(1);
  });
});

describe('FolderScan — a caller\'s own bound on folders', () => {
  const mark = (name: string): boolean => name === 'dbt_project.yml';

  it('lists exactly that many folders for a caller alone, then pauses: not done, not capped', async () => {
    // 299,593 folders; the walk as a whole may list 2,000 of them.
    const disk = new FakeDisk(wide(8, 6));
    const scan = scanOf(disk, { maxFolders: 2000 });

    await scan.reach(6, 500);

    expect(disk.listed).toHaveLength(500);
    expect(scan.snapshot()).toEqual({ files: [], marked: [], folders: 500, depthDone: 2, done: false, capped: false, truncated: false });
    expect(disk.maxInFlight).toBe(2);
    expect(disk.inFlight).toBe(0);

    // Paused, not over: nothing more is listed for nobody.
    await turn();
    await turn();
    expect(disk.listed).toHaveLength(500);

    // Asking for more carries on from folder 501 (depths 0 to 3 are 585 folders, so depth 3 is now done).
    const first500 = [...disk.listed];
    await scan.reach(6, 600);
    expect(disk.listed).toHaveLength(600);
    expect(disk.listed.slice(0, 500)).toEqual(first500);
    expect(scan.snapshot()).toMatchObject({ folders: 600, depthDone: 3, done: false, capped: false });

    await scan.finish();
    expect(disk.listed).toHaveLength(2000);
    expect(new Set(disk.listed).size).toBe(2000);
    expect(scan.snapshot()).toMatchObject({ folders: 2000, done: true, capped: true });
    expect(disk.maxInFlight).toBe(2);

    // The same folders, in the same order, as a walk nobody paused.
    const plain = new FakeDisk(wide(8, 6));
    await scanOf(plain, { maxFolders: 2000 }).finish();
    expect(disk.listed).toEqual(plain.listed);
  });

  it('holds the first folders in walk order when it pauses, and finds the same in the end as a walk nobody bounded', async () => {
    const plainDisk = new FakeDisk(bushy());
    const plain = scanOf(plainDisk, { mark });
    await plain.finish();

    const disk = new FakeDisk(bushy());
    const scan = scanOf(disk, { mark });
    await scan.reach(6, 17);

    // 1 + 3 + 9 folders above the last depth, then four of its 27: one file each, a mark in seven.
    expect(disk.listed).toEqual(plainDisk.listed.slice(0, 17));
    expect(scan.snapshot()).toEqual({
      files: plain.snapshot().files.slice(0, 17),
      marked: plain.snapshot().marked.slice(0, 7),
      folders: 17,
      depthDone: 2,
      done: false,
      capped: false,
      truncated: false,
    });

    await scan.finish();
    expect(disk.listed).toEqual(plainDisk.listed);
    expect(new Set(disk.listed).size).toBe(40);
    expect(scan.snapshot()).toEqual(plain.snapshot());
    expect(scan.snapshot()).toMatchObject({ folders: 40, done: true, capped: false });
  });

  it('gives the same files, marks and folders whichever listing answers first', async () => {
    const run = async (delay: FakeDiskOptions['delay']): Promise<{ disk: FakeDisk; found: ScanSnapshot }> => {
      const disk = new FakeDisk(bushy(), { delay });
      const scan = scanOf(disk, { mark });
      await scan.reach(6, 17);
      return { disk, found: scan.snapshot() };
    };
    const instant = await run(undefined);
    const oneWay = await run((rel) => hash(rel) % 4);
    const otherWay = await run((rel) => 3 - (hash(rel) % 4));

    expect(instant.found).toMatchObject({ folders: 17, depthDone: 2, done: false, capped: false });
    expect(instant.found.files).toHaveLength(17);
    expect(instant.found.marked).toHaveLength(7);
    for (const other of [oneWay, otherWay]) {
      expect(other.found).toEqual(instant.found);
      expect(other.disk.listed).toEqual(instant.disk.listed);
      expect(other.disk.maxInFlight).toBe(2);
    }
  });

  it('stops in the middle of a depth, or exactly at the end of one', async () => {
    // Depths hold 1, 3, 9 and 27 folders.
    const middle = new FakeDisk(bushy());
    const mid = scanOf(middle);
    await mid.reach(6, 8);
    expect(middle.listed).toEqual(['', 'a', 'b', 'c', 'a/a', 'a/b', 'a/c', 'b/a']);
    expect(mid.snapshot()).toMatchObject({ folders: 8, depthDone: 1, done: false, capped: false });
    expect(mid.snapshot().files).toHaveLength(8);

    // Exactly the end of depth 2: the depth is done, and the next is not started for nobody.
    const edge = new FakeDisk(bushy());
    const end = scanOf(edge);
    await end.reach(6, 13);
    expect(edge.listed).toHaveLength(13);
    expect(Math.max(...edge.listed.map(depthOf))).toBe(2);
    expect(end.snapshot()).toMatchObject({ folders: 13, depthDone: 2, done: false, capped: false });
    await turn();
    expect(edge.listed).toHaveLength(13);
    await end.reach(6, 14);
    expect(edge.listed).toHaveLength(14);
    expect(edge.listed[13]).toBe('a/a/a');

    // Only the root.
    const top = new FakeDisk(bushy());
    const one = scanOf(top);
    await one.reach(6, 1);
    expect(top.listed).toEqual(['']);
    expect(one.snapshot()).toMatchObject({ files: ['m.sql'], folders: 1, depthDone: 0, done: false, capped: false });

    // Every folder there is: with nothing left to list, the walk is over.
    const whole = new FakeDisk(bushy());
    const all = scanOf(whole);
    await all.reach(6, 40);
    expect(all.snapshot()).toMatchObject({ folders: 40, depthDone: 16, done: true, capped: false });
  });

  it('answers at once when that many folders are already listed', async () => {
    const disk = new FakeDisk(bushy());
    const scan = scanOf(disk);
    // Nothing to wait for: the walk is not even started.
    await scan.reach(6, 0);
    await turn();
    expect(disk.listed).toEqual([]);
    expect(scan.snapshot()).toMatchObject({ folders: 0, depthDone: -1, done: false, capped: false });

    await scan.reach(6, 8);
    let answered = false;
    void scan.reach(6, 5).then(() => { answered = true; });
    await Promise.resolve();
    expect(answered).toBe(true);
    await scan.reach(6, 8);
    await turn();
    expect(disk.listed).toHaveLength(8);
    expect(scan.snapshot()).toMatchObject({ folders: 8, done: false });
  });

  it('answers when its depth is done if the bound is never met', async () => {
    const disk = new FakeDisk(bushy());
    const scan = scanOf(disk);
    await scan.reach(1, 1000);
    expect(disk.listed).toEqual(['', 'a', 'b', 'c']);
    expect(scan.snapshot()).toMatchObject({ folders: 4, depthDone: 1, done: false, capped: false });

    // Deeper than the tree goes: the walk being over is the answer.
    await scan.reach(6, 1000);
    expect(disk.listed).toHaveLength(40);
    expect(scan.snapshot()).toMatchObject({ folders: 40, depthDone: 16, done: true, capped: false });
  });

  it('is still stopped by the walk\'s own bound, which is what `capped` means', async () => {
    const disk = new FakeDisk(bushy());
    const scan = scanOf(disk, { maxFolders: 10 });
    await scan.reach(6, 25);
    expect(disk.listed).toHaveLength(10);
    expect(scan.snapshot()).toMatchObject({ folders: 10, depthDone: 1, done: true, capped: true });
  });

  it('lets a bounded caller go as soon as its folders are in, while the walk runs on for another', async () => {
    for (const boundedFirst of [true, false]) {
      const disk = new FakeDisk(bushy(), { delay: () => 1 });
      const scan = scanOf(disk);
      const order: string[] = [];
      let atBound: ScanSnapshot | undefined;
      const bounded = (): Promise<void> => scan.reach(6, 10).then(() => { order.push('bounded'); atBound = scan.snapshot(); });
      const whole = (): Promise<void> => scan.finish().then(() => { order.push('finish'); });
      await Promise.all(boundedFirst ? [bounded(), whole()] : [whole(), bounded()]);

      expect(order).toEqual(['bounded', 'finish']);
      expect(atBound).toMatchObject({ done: false, capped: false });
      // Its ten folders are in; the walk had not waited for it, nor it for the walk.
      expect(atBound!.folders).toBeGreaterThanOrEqual(10);
      expect(atBound!.folders).toBeLessThan(40);
      expect(atBound!.files.length).toBeGreaterThanOrEqual(10);
      expect(disk.listed).toHaveLength(40);
      expect(new Set(disk.listed).size).toBe(40);
      expect(disk.maxInFlight).toBe(2);
      expect(scan.snapshot()).toMatchObject({ folders: 40, done: true, capped: false });
    }
  });

  it('serves several bounded callers, each at its own number', async () => {
    const disk = new FakeDisk(bushy());
    const scan = scanOf(disk);
    const seen: number[] = [];
    const ask = (bound: number): Promise<void> => scan.reach(6, bound).then(() => { seen.push(bound); });
    await Promise.all([ask(20), ask(5), ask(12)]);
    expect(seen).toEqual([5, 12, 20]);
    // The largest bound is where the walk pauses.
    expect(disk.listed).toHaveLength(20);
    expect(scan.snapshot()).toMatchObject({ folders: 20, done: false, capped: false });
  });

  it('does not count a pause in the middle of a depth as walking', async () => {
    // Every listing takes 10 ms by the injected clock.
    let clock = 0;
    const disk = new FakeDisk(bushy(), { delay: () => { clock += 10; return undefined; } });
    const scan = scanOf(disk, { maxMs: 1000, now: () => clock });
    await scan.reach(6, 7);
    expect(scan.snapshot()).toMatchObject({ folders: 7, depthDone: 1, done: false, capped: false });

    // Paused for a minute, sixty times the whole allowance: the walk carries on and finishes.
    clock += 60_000;
    await scan.finish();
    expect(disk.listed).toHaveLength(40);
    expect(scan.snapshot()).toMatchObject({ folders: 40, done: true, capped: false });
  });

  it('still counts the walking on both sides of a pause', async () => {
    let clock = 0;
    const disk = new FakeDisk(bushy(), { delay: () => { clock += 10; return undefined; } });
    // 150 ms of walking is fifteen listings: seven before the pause, eight after.
    const scan = scanOf(disk, { maxMs: 150, now: () => clock });
    await scan.reach(6, 7);
    clock += 60_000;
    await scan.finish();
    expect(disk.listed).toHaveLength(15);
    expect(scan.snapshot()).toMatchObject({ folders: 15, done: true, capped: true });
  });

  it('cancel while paused in the middle of a depth lets everybody go', async () => {
    const disk = new FakeDisk(bushy());
    const scan = scanOf(disk);
    await scan.reach(6, 8);
    scan.cancel();
    expect(scan.snapshot()).toMatchObject({ folders: 8, depthDone: 1, done: true, capped: false });
    await scan.finish();
    await scan.reach(6, 30);
    await turn();
    expect(disk.listed).toHaveLength(8);

    // One worker paused, the other's listing (the eighth folder) still out: its caller is let go too.
    const gate = deferred();
    const held = new FakeDisk(bushy(), { delay: (rel) => (rel === 'b/a' ? gate.promise : undefined) });
    const holding = scanOf(held);
    let answered = false;
    const waiting = holding.reach(6, 8).then(() => { answered = true; });
    await turn();
    expect(held.listed).toHaveLength(8);
    expect(answered).toBe(false);
    expect(holding.snapshot()).toMatchObject({ folders: 8, done: false });

    holding.cancel();
    await waiting;
    expect(holding.snapshot()).toMatchObject({ folders: 8, depthDone: 1, done: true, capped: false });
    expect(holding.snapshot().files).toHaveLength(7);

    gate.resolve();
    await turn();
    expect(held.listed).toHaveLength(8);
    expect(holding.snapshot().files).toHaveLength(7);
  });
});

describe('FolderScan — pending: found but not yet listed', () => {
  /** The folders directly inside the folders given. */
  const childrenOf = (all: readonly string[], parents: readonly string[]): string[] => {
    const inside = new Set(parents);
    return all.filter((rel) => rel !== '' && inside.has(rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''));
  };

  it('is empty before the walk starts, after it finishes and after it is cancelled', async () => {
    const disk = new FakeDisk(bushy());
    const scan = scanOf(disk);
    expect(scan.pending()).toEqual([]);
    await scan.reach(6, 8);
    expect(scan.pending().length).toBeGreaterThan(0);
    await scan.finish();
    expect(scan.snapshot().done).toBe(true);
    expect(scan.pending()).toEqual([]);

    const cancelled = scanOf(new FakeDisk(bushy()));
    await cancelled.reach(6, 8);
    expect(cancelled.pending().length).toBeGreaterThan(0);
    cancelled.cancel();
    expect(cancelled.pending()).toEqual([]);

    const capped = scanOf(new FakeDisk(bushy()), { maxFolders: 10 });
    await capped.finish();
    expect(capped.snapshot()).toMatchObject({ done: true, capped: true });
    expect(capped.pending()).toEqual([]);
  });

  it('paused in the middle of a depth: the rest of that depth in listing order, then what the listed folders hold', async () => {
    const tree = bushy();
    const all = foldersOf(tree);
    const run = async (delay: FakeDiskOptions['delay']): Promise<{ disk: FakeDisk; scan: FolderScan; pending: string[] }> => {
      const disk = new FakeDisk(tree, { delay });
      const scan = scanOf(disk);
      await scan.reach(6, 8);
      return { disk, scan, pending: scan.pending() };
    };
    const instant = await run(undefined);

    // Depth 2 is being listed: four of its nine folders are, five are not; the four hold three folders each.
    expect(instant.disk.listed).toEqual(['', 'a', 'b', 'c', 'a/a', 'a/b', 'a/c', 'b/a']);
    expect(instant.pending).toEqual([
      'b/b', 'b/c', 'c/a', 'c/b', 'c/c',
      'a/a/a', 'a/a/b', 'a/a/c', 'a/b/a', 'a/b/b', 'a/b/c', 'a/c/a', 'a/c/b', 'a/c/c', 'b/a/a', 'b/a/b', 'b/a/c',
    ]);

    // Listed and pending never overlap, and together are every folder down to the depth
    // being listed plus every folder inside a listed one.
    const listed = new Set(instant.disk.listed);
    expect(instant.pending.filter((rel) => listed.has(rel))).toEqual([]);
    expect(new Set(instant.pending).size).toBe(instant.pending.length);
    const covered = new Set([...all.filter((rel) => depthOf(rel) <= 2), ...childrenOf(all, instant.disk.listed)]);
    expect([...instant.pending, ...instant.disk.listed].sort()).toEqual([...covered].sort());

    // The same, in the same order, whichever listing answers first.
    for (const delay of [(rel: string) => hash(rel) % 4, (rel: string) => 3 - (hash(rel) % 4)]) {
      const other = await run(delay);
      expect(other.pending).toEqual(instant.pending);
      expect(other.disk.listed).toEqual(instant.disk.listed);
    }

    // A later finish() lists every pending folder exactly once, the rest of the depth first.
    const before = instant.disk.listed.length;
    await instant.scan.finish();
    const after = instant.disk.listed.slice(before);
    expect(after.slice(0, 5)).toEqual(instant.pending.slice(0, 5));
    for (const rel of instant.pending) expect(after.filter((later) => later === rel)).toHaveLength(1);
    expect(new Set(instant.disk.listed).size).toBe(instant.disk.listed.length);
    expect(instant.scan.pending()).toEqual([]);
  });

  it('covers a wide tree: every folder found by the folders listed, none of them listed', async () => {
    // Depths hold 1, 8, 64, 512, … folders: 500 stops 427 folders into depth 3.
    const disk = new FakeDisk(wide(8, 6));
    const scan = scanOf(disk, { maxFolders: 20_000 });
    await scan.reach(6, 500);

    const pending = scan.pending();
    const listed = new Set(disk.listed);
    // The 85 folders of depth 3 not yet listed, then the eight folders in each of the 427 that are.
    expect(pending).toHaveLength(85 + 427 * 8);
    expect(new Set(pending).size).toBe(pending.length);
    expect(pending.filter((rel) => listed.has(rel))).toEqual([]);
    expect(pending.slice(0, 85).every((rel) => depthOf(rel) === 3)).toBe(true);
    expect(pending.slice(85).every((rel) => depthOf(rel) === 4 && listed.has(rel.slice(0, rel.lastIndexOf('/'))))).toBe(true);
    // Every folder of depths 0 to 3 is one or the other.
    expect(disk.listed.length + 85).toBe(1 + 8 + 64 + 512);

    const other = new FakeDisk(wide(8, 6), { delay: (rel) => (hash(rel) % 5 === 0 ? 1 : 0) });
    const again = scanOf(other, { maxFolders: 20_000 });
    await again.reach(6, 500);
    expect(again.pending()).toEqual(pending);
  });

  it('paused between depths: the whole of the next depth, in listing order', async () => {
    const tree = bushy();
    const disk = new FakeDisk(tree);
    const scan = scanOf(disk);
    await scan.reach(2);
    expect(scan.snapshot()).toMatchObject({ folders: 13, depthDone: 2, done: false });
    expect(scan.pending()).toEqual(foldersOf(tree).filter((rel) => depthOf(rel) === 3).sort());
    expect(scan.pending()).toHaveLength(27);

    // The same when a caller's own bound falls exactly on the end of the depth.
    const edge = scanOf(new FakeDisk(tree));
    await edge.reach(6, 13);
    expect(edge.pending()).toEqual(scan.pending());

    // Ranked folders come in the order they will be listed.
    const ranked = new FakeDisk({ '.hidden': {}, visible: {}, alpha: {} });
    const byRank = scanOf(ranked, { rank: (rel) => (rel.startsWith('.') ? 1 : 0) });
    await byRank.reach(0);
    expect(byRank.pending()).toEqual(['alpha', 'visible', '.hidden']);
    await byRank.finish();
    expect(ranked.listed).toEqual(['', 'alpha', 'visible', '.hidden']);
  });

  it('never holds an ignored or skipped folder, or one below maxDepth', async () => {
    const disk = new FakeDisk({
      node_modules: { dep: {} },
      '.erd-studio': { gold: {} },
      keep: { deep: { deeper: { deepest: {} } } },
    });
    const scan = scanOf(disk, { maxDepth: 2, skipFolder: (rel) => rel === '.erd-studio' });
    await scan.reach(0);
    expect(scan.pending()).toEqual(['keep']);
    await scan.reach(1);
    expect(scan.pending()).toEqual(['keep/deep']);
    // `keep/deep/deeper` is below maxDepth: never queued, so nothing is left and the walk is over.
    await scan.reach(2);
    expect(scan.snapshot()).toMatchObject({ folders: 3, done: true, capped: false });
    expect(scan.pending()).toEqual([]);
  });

  it('holds a link to a folder once, and not when the folder is already listed or queued', async () => {
    const disk = new FakeDisk({
      a: {
        real: { 'x.sql': FILE },
        // Points at a folder queued in its own right.
        alias: link('a/real'),
        // The only two ways into `pkg`: the first in listing order stands for both.
        out: link('node_modules/pkg'),
        out2: link('node_modules/pkg'),
        // Points at a folder already listed.
        back: link(''),
        gone: link('nowhere'),
      },
      b: {},
      c: {},
      node_modules: { pkg: { 'p.sql': FILE } },
    });
    const scan = scanOf(disk);
    await scan.reach(6, 2);
    expect(disk.listed).toEqual(['', 'a']);
    expect(scan.pending()).toEqual(['b', 'c', 'a/out', 'a/real']);

    // Exactly what the walk then goes on to list.
    await scan.finish();
    expect(disk.listed).toEqual(['', 'a', 'b', 'c', 'a/out', 'a/real']);
  });

  it('does not hold a folder whose listing is in flight, nor yet what it will find', async () => {
    const gate = deferred();
    const disk = new FakeDisk(bushy(), { delay: (rel) => (rel === 'b' ? gate.promise : undefined) });
    const scan = scanOf(disk);
    const reached = scan.reach(1);
    await turn();
    // `a` and `c` have answered, but `a` alone is read: `c` waits its turn behind `b`.
    expect(disk.listed).toEqual(['', 'a', 'b', 'c']);
    expect(scan.pending()).toEqual(['a/a', 'a/b', 'a/c']);

    gate.resolve();
    await reached;
    expect(scan.pending()).toEqual(['a/a', 'a/b', 'a/c', 'b/a', 'b/b', 'b/c', 'c/a', 'c/b', 'c/c']);
  });
});

describe('nodeScanReader and nodeReadDirEntries — the real disk', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** A real folder with files, folders and (where the OS allows) links. Returns whether the links were made. */
  function makeTree(): { root: string; links: boolean } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-folder-scan-'));
    dir = root;
    fs.writeFileSync(path.join(root, 'a.sql'), 'select 1');
    fs.writeFileSync(path.join(root, 'notes.txt'), '');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'b.sql'), '');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'dep.sql'), '');
    let links = true;
    try {
      fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'link-to-sub'), 'dir');
      fs.symlinkSync(path.join(root, 'a.sql'), path.join(root, 'link-to-a.sql'), 'file');
      fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'dangling'), 'file');
      fs.symlinkSync(root, path.join(root, 'sub', 'loop'), 'dir');
    } catch {
      // Windows without the privilege to make links: the plain entries are still checked.
      links = false;
      for (const name of ['link-to-sub', 'link-to-a.sql', 'dangling', path.join('sub', 'loop')]) {
        fs.rmSync(path.join(root, name), { force: true });
      }
    }
    return { root, links };
  }

  it('reads one folder: files, folders and links, each as what it is', async () => {
    const { root, links } = makeTree();
    const entries = [...await nodeScanReader.readDir(root)].sort((a, b) => (a.name < b.name ? -1 : 1));
    expect(entries.filter((e) => e.kind !== 'link')).toEqual([
      { name: 'a.sql', kind: 'file' },
      { name: 'node_modules', kind: 'dir' },
      { name: 'notes.txt', kind: 'file' },
      { name: 'sub', kind: 'dir' },
    ]);
    await expect(nodeScanReader.readDir(path.join(root, 'nope'))).rejects.toThrow();
    expect(await nodeScanReader.realPath(root)).toBe(fs.realpathSync.native(root));
    if (!links) return;

    expect(entries.filter((e) => e.kind === 'link').map((e) => e.name)).toEqual(['dangling', 'link-to-a.sql', 'link-to-sub']);
    expect(await nodeScanReader.resolveLink(path.join(root, 'link-to-sub')))
      .toEqual({ isDirectory: true, realPath: fs.realpathSync.native(path.join(root, 'sub')) });
    expect(await nodeScanReader.resolveLink(path.join(root, 'link-to-a.sql')))
      .toEqual({ isDirectory: false, realPath: path.join(root, 'link-to-a.sql') });
    expect(await nodeScanReader.resolveLink(path.join(root, 'dangling'))).toBeUndefined();
  });

  it('nodeReadDirEntries counts a link to a folder as a folder and leaves a dangling link out', async () => {
    const { root, links } = makeTree();
    const entries = (await nodeReadDirEntries(root)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    expect(entries).toEqual([
      ['a.sql', false],
      ...(links ? [['link-to-a.sql', false], ['link-to-sub', true]] : []),
      ['node_modules', true],
      ['notes.txt', false],
      ['sub', true],
    ]);
    await expect(nodeReadDirEntries(path.join(root, 'nope'))).rejects.toThrow();
  });

  it('walks the real folder: each real folder once, a loop ended, an ignored folder never entered', async () => {
    const { root, links } = makeTree();
    const scan = new FolderScan(root, nodeScanReader, {
      ignoredFolders: new Set(['node_modules']),
      include: (name) => name.endsWith('.sql'),
      mark: (name, isDirectory) => isDirectory && name === 'sub',
      maxFolders: 100,
      maxDepth: 16,
      maxFiles: 100,
    });
    await scan.finish();
    expect(scan.snapshot()).toEqual({
      files: links ? ['a.sql', 'link-to-a.sql', 'sub/b.sql'] : ['a.sql', 'sub/b.sql'],
      marked: ['sub'],
      // The root and `sub`: `link-to-sub` is `sub` again, and `sub/loop` is the root again.
      folders: 2,
      depthDone: 16,
      done: true,
      capped: false,
      truncated: false,
    });
  });
});
