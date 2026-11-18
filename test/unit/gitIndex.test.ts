/**
 * #347: the tracked paths of a git repository, read straight from its index
 * file (`src/services/gitIndex.ts`) instead of walking every folder.
 *
 * Most tests write an index with the small builder below, so every version
 * (2, 3, 4), id size (SHA-1, SHA-256), extension and odd entry is covered
 * without git. The last block checks the reader against what real git writes,
 * and is skipped where git is not installed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  findGitIndex,
  readGitIndex,
  GIT_INDEX_MAX_BYTES,
  type GitIndexLocation,
  type GitIndexMatch,
  type GitIndexReadOptions,
  type GitIndexResult,
} from '../../src/services/gitIndex';

// ── An index builder ───────────────────────────────────────────────────────

const SYMLINK = 0o120000;
const GITLINK = 0o160000;
const SPARSE_DIR = 0o040000;
/** The second flags word (version 3 and later). */
const SKIP_WORKTREE = 0x4000;
const INTENT_TO_ADD = 0x2000;

interface Entry {
  path: string;
  /** Default: a regular file, `0o100644`. */
  mode?: number;
  /** Merge stage, 0 to 3. */
  stage?: number;
  /** Sets the extended bit and writes this second flags word. */
  extended?: number;
  /** Written without its path, as a split index writes an entry that replaces a shared one. */
  stripped?: boolean;
  /** The name length the flags claim (default: the true one, capped at 0xFFF). */
  statedLength?: number;
}

interface Extension {
  signature: string;
  data: Buffer;
}

interface IndexSpec {
  version: number;
  entries: ReadonlyArray<Entry | string>;
  /** Object id size: 20 (SHA-1, the default) or 32 (SHA-256). */
  hashSize?: 20 | 32;
  extensions?: readonly Extension[];
  /** The entry count the header claims (default: the true one). */
  count?: number;
}

/** git's "offset" variable-width integer, as `encode_varint` writes it. */
function encodeVarint(value: number): number[] {
  const out = [value & 0x7f];
  let rest = Math.floor(value / 128);
  while (rest > 0) {
    rest--;
    out.unshift(0x80 | (rest & 0x7f));
    rest = Math.floor(rest / 128);
  }
  return out;
}

/** An index file's bytes. One preallocated buffer, so 200,000 entries build quickly. */
function buildIndex(spec: IndexSpec): Buffer {
  const hashSize = spec.hashSize ?? 20;
  const entries = spec.entries.map((entry) => (typeof entry === 'string' ? { path: entry } : entry));
  const names = entries.map((entry) => Buffer.from(entry.path, 'utf8'));
  let room = 12 + hashSize;
  for (const name of names) room += 40 + hashSize + 4 + 5 + name.length + 8;
  for (const extension of spec.extensions ?? []) room += 8 + extension.data.length;

  const out = Buffer.alloc(room);
  out.write('DIRC', 0, 'latin1');
  out.writeUInt32BE(spec.version, 4);
  out.writeUInt32BE(spec.count ?? entries.length, 8);
  let pos = 12;
  let previous: Buffer = Buffer.alloc(0);
  for (let i = 0; i < entries.length; i++) {
    const entry: Entry = entries[i];
    const name = names[i];
    const start = pos;
    out.writeUInt32BE(1_700_000_000 + i, pos); // ctime
    out.writeUInt32BE(1_700_000_000 + i, pos + 8); // mtime
    out.writeUInt32BE(16_777_220, pos + 16); // dev
    out.writeUInt32BE(1000 + i, pos + 20); // ino
    out.writeUInt32BE(entry.mode ?? 0o100644, pos + 24);
    out.writeUInt32BE(501, pos + 28); // uid
    out.writeUInt32BE(20, pos + 32); // gid
    out.writeUInt32BE(100 + (i % 9000), pos + 36); // size
    pos += 40;
    for (let b = 0; b < hashSize; b++) out[pos + b] = ((i + 1) * (b + 3) * 37 + b + 1) & 0xff;
    pos += hashSize;
    const length = entry.stripped ? 0 : name.length;
    const flags =
      ((entry.stage ?? 0) << 12) | (entry.extended !== undefined ? 0x4000 : 0) | (entry.statedLength ?? Math.min(length, 0xfff));
    out.writeUInt16BE(flags, pos);
    pos += 2;
    if (entry.extended !== undefined) {
      out.writeUInt16BE(entry.extended, pos);
      pos += 2;
    }
    if (spec.version === 4) {
      if (entry.stripped) {
        pos += 2; // drop 0 bytes, add nothing, NUL
      } else {
        let common = 0;
        while (common < previous.length && common < name.length && previous[common] === name[common]) common++;
        for (const byte of encodeVarint(previous.length - common)) out[pos++] = byte;
        pos += name.copy(out, pos, common);
        pos++; // NUL
        previous = name;
      }
    } else {
      if (!entry.stripped) pos += name.copy(out, pos);
      pos = start + ((pos - start + 8) & ~7); // 1 to 8 NULs
    }
  }
  for (const extension of spec.extensions ?? []) {
    out.write(extension.signature, pos, 'latin1');
    out.writeUInt32BE(extension.data.length, pos + 4);
    extension.data.copy(out, pos + 8);
    pos += 8 + extension.data.length;
  }
  crypto.createHash(hashSize === 20 ? 'sha1' : 'sha256').update(out.subarray(0, pos)).digest().copy(out, pos);
  return out.subarray(0, pos + hashSize);
}

/** A cache tree extension git would write: skipped by its size. */
const TREE: Extension = { signature: 'TREE', data: Buffer.from('\u000012 3\nmodels\u00004 0\n', 'latin1') };

/** The split index extension: the shared index's id, then its delete and replace bitmaps (not read). */
function linkExtension(sharedId: Buffer): Extension {
  return { signature: 'link', data: Buffer.concat([sharedId, Buffer.alloc(24, 1)]) };
}

/** The trailing checksum, which is what git names a shared index by. */
function idOf(index: Buffer, hashSize = 20): Buffer {
  return index.subarray(index.length - hashSize);
}

const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// ── Helpers ────────────────────────────────────────────────────────────────

const MATCH: GitIndexMatch = { suffixes: ['.sql', '.dbml'], names: ['database.json', 'dbt_project.yml'] };

let tmp: string;

beforeEach(() => {
  // The real path: on macOS the temp folder is behind a symbolic link, and git writes real paths.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-index-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

/** Writes `index` as `<tmp>/.git/index`, with any other files of the git folder. */
function plant(index: Buffer, others: Record<string, Buffer> = {}): Pick<GitIndexLocation, 'gitDir' | 'indexPath'> {
  const gitDir = path.join(tmp, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'index'), index);
  for (const [name, bytes] of Object.entries(others)) fs.writeFileSync(path.join(gitDir, name), bytes);
  return { gitDir, indexPath: path.join(gitDir, 'index') };
}

function read(index: Buffer, options: Partial<GitIndexReadOptions> = {}): Promise<GitIndexResult> {
  return readGitIndex(plant(index), { match: MATCH, ...options });
}

/** A split index: `own` in the index, `shared` in the shared index it links to. */
function plantSplit(
  version: number,
  shared: ReadonlyArray<Entry | string>,
  own: ReadonlyArray<Entry | string>,
  hashSize: 20 | 32 = 20,
): Pick<GitIndexLocation, 'gitDir' | 'indexPath'> {
  const sharedIndex = buildIndex({ version, entries: shared, hashSize });
  const id = idOf(sharedIndex, hashSize);
  const index = buildIndex({ version, entries: own, hashSize, extensions: [TREE, linkExtension(id)] });
  return plant(index, { [`sharedindex.${id.toString('hex')}`]: sharedIndex });
}

function okOf(result: GitIndexResult): Extract<GitIndexResult, { ok: true }> {
  if (!result.ok) throw new Error(`readGitIndex failed: ${result.reason}`);
  return result;
}

const reasonOf = (result: GitIndexResult) => (result.ok ? 'ok' : result.reason);

// ── findGitIndex ───────────────────────────────────────────────────────────

describe('findGitIndex', () => {
  it('finds the repository a nested folder is in', async () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'models', 'marts'), { recursive: true });
    const expected = { workTree: repo, gitDir: path.join(repo, '.git'), indexPath: path.join(repo, '.git', 'index') };

    expect(await findGitIndex(repo)).toEqual(expected);
    expect(await findGitIndex(path.join(repo, 'models', 'marts'))).toEqual(expected);
    // The start need not exist, and the index need not either (readGitIndex says `missing`).
    expect(await findGitIndex(path.join(repo, 'models', 'not', 'there'))).toEqual(expected);
  });

  it('stops at the nearest repository', async () => {
    const outer = path.join(tmp, 'outer');
    const inner = path.join(outer, 'vendor', 'inner');
    fs.mkdirSync(path.join(outer, '.git'), { recursive: true });
    fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
    fs.mkdirSync(path.join(inner, 'src'), { recursive: true });

    expect((await findGitIndex(path.join(inner, 'src')))?.workTree).toBe(inner);
    expect((await findGitIndex(path.join(outer, 'vendor')))?.workTree).toBe(outer);
  });

  it('follows a relative gitdir: line (a submodule)', async () => {
    const main = path.join(tmp, 'main');
    const sub = path.join(main, 'libs', 'sub');
    fs.mkdirSync(path.join(main, '.git', 'modules', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(sub, 'models'), { recursive: true });
    fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../../.git/modules/sub\n');

    const gitDir = path.join(main, '.git', 'modules', 'sub');
    expect(await findGitIndex(path.join(sub, 'models'))).toEqual({
      workTree: sub,
      gitDir,
      indexPath: path.join(gitDir, 'index'),
    });
  });

  it('follows an absolute gitdir: line (a linked worktree), CRLF or not', async () => {
    const gitDir = path.join(tmp, 'main', '.git', 'worktrees', 'feature');
    fs.mkdirSync(gitDir, { recursive: true });
    for (const ending of ['\n', '\r\n', '']) {
      const tree = path.join(tmp, `feature-${ending.length}`);
      fs.mkdirSync(path.join(tree, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tree, '.git'), `gitdir: ${gitDir}${ending}`);
      expect(await findGitIndex(path.join(tree, 'src'))).toEqual({
        workTree: tree,
        gitDir,
        indexPath: path.join(gitDir, 'index'),
      });
    }
  });

  it('gives up on a .git file it cannot follow, rather than using the repository above', async () => {
    const outer = path.join(tmp, 'outer');
    fs.mkdirSync(path.join(outer, '.git'), { recursive: true });
    const cases: Record<string, string | Buffer> = {
      words: 'this is not a git file\n',
      empty: '',
      'no-path': 'gitdir:   \n',
      binary: Buffer.from([0, 1, 2, 3, 0xff, 0xfe]),
      // The line is cut by the 4 KiB read: half a path is not a path.
      'cut-off': `gitdir: ${'d/'.repeat(4000)}end\n`,
    };
    for (const [name, content] of Object.entries(cases)) {
      const dir = path.join(outer, name);
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git'), content);
      expect(await findGitIndex(path.join(dir, 'src')), name).toBeUndefined();
    }
    expect((await findGitIndex(path.join(outer, 'plain')))?.workTree).toBe(outer);
  });

  it('answers undefined where there is no repository', async () => {
    fs.mkdirSync(path.join(tmp, 'plain', 'deep'), { recursive: true });
    // Whatever is above the temp folder on this machine (nothing, normally) is all that can be found.
    const above = await findGitIndex(path.dirname(tmp));
    expect(await findGitIndex(path.join(tmp, 'plain', 'deep'))).toEqual(above);
    expect(above?.workTree.startsWith(tmp) ?? false).toBe(false);
  });
});

// ── readGitIndex: built indexes ────────────────────────────────────────────

/** Sorted the way git sorts an index: by bytes. */
const TRACKED = [
  'README.md',
  'Reports/Sales.SemanticModel/definition/Database.JSON',
  'dbt_project.yml',
  'docs/sql.txt',
  'models/Schema.DBML',
  'models/marts/fct_order.SQL',
  'models/marts/fct_order.sql.bak',
  'models/staging/stg_orders.sql',
  'notdbt_project.yml',
  'notes/database.json.md',
  'sql',
  'src/mydatabase.json',
  'src/sub/dbt_project.yml',
  'ünïcode/größe.sql',
].sort(byBytes);

const KEPT = [
  'Reports/Sales.SemanticModel/definition/Database.JSON',
  'dbt_project.yml',
  'models/Schema.DBML',
  'models/marts/fct_order.SQL',
  'models/staging/stg_orders.sql',
  'src/sub/dbt_project.yml',
  'ünïcode/größe.sql',
];

describe('readGitIndex', () => {
  describe('each index version', () => {
    it('reads a version 2 index', async () => {
      const result = okOf(await read(buildIndex({ version: 2, entries: TRACKED, extensions: [TREE] })));
      expect(result).toEqual({ ok: true, paths: KEPT, entries: TRACKED.length, version: 2, split: false });
    });

    it('reads a version 3 index, with extended flags on some entries', async () => {
      const entries = TRACKED.map((entry, i): Entry =>
        i % 3 === 0 ? { path: entry, extended: i % 2 === 0 ? INTENT_TO_ADD : SKIP_WORKTREE } : { path: entry },
      );
      expect(entries.filter((entry) => entry.extended !== undefined && KEPT.includes(entry.path)).length).toBeGreaterThan(0);
      const result = okOf(await read(buildIndex({ version: 3, entries, extensions: [TREE] })));
      expect(result).toEqual({ ok: true, paths: KEPT, entries: TRACKED.length, version: 3, split: false });
    });

    it('reads a version 4 index, whose paths build on the path before', async () => {
      const entries = TRACKED.map((entry, i): Entry => (i % 4 === 1 ? { path: entry, extended: SKIP_WORKTREE } : { path: entry }));
      const index = buildIndex({ version: 4, entries, extensions: [TREE] });
      // Prefix compression: the shared starts of the paths are not in the file.
      expect(index.includes(Buffer.from('models/marts/fct_order.sql.bak'))).toBe(false);
      const result = okOf(await read(index));
      expect(result).toEqual({ ok: true, paths: KEPT, entries: TRACKED.length, version: 4, split: false });
    });

    it.each([2, 3, 4])('version %i: paths of 0xFFF bytes and more, and no entries at all', async (version) => {
      // 0xFFF in the flags means "this long or longer": the path ends at its NUL.
      const long = `deep/${'d'.repeat(5000)}/model.sql`;
      const exact = `e/${'e'.repeat(0xfff - 6)}.sql`;
      expect(Buffer.byteLength(exact)).toBe(0xfff);
      const justUnder = `f/${'f'.repeat(0xffe - 6)}.sql`;
      const entries = ['a.sql', long, exact, justUnder, 'g/after.sql', 'z.txt'];
      expect(okOf(await read(buildIndex({ version, entries }))).paths).toEqual(entries.slice(0, 5));

      const empty = okOf(await read(buildIndex({ version, entries: [], extensions: [TREE] })));
      expect(empty).toEqual({ ok: true, paths: [], entries: 0, version, split: false });
    });

    it('version 4: a drop count of more than one byte', async () => {
      // 300 bytes dropped from the end of the first path: a two-byte variable-width integer.
      const entries = [`a/${'x'.repeat(300)}.sql`, 'a/y.sql', `b/${'y'.repeat(20000)}.sql`, 'c.sql'];
      expect(encodeVarint(301).length).toBe(2);
      expect(encodeVarint(20005).length).toBe(3);
      expect(okOf(await read(buildIndex({ version: 4, entries }))).paths).toEqual(entries);
    });

    it('matches suffixes and names whatever their case, and only whole file names', async () => {
      const index = buildIndex({ version: 2, entries: TRACKED });
      const location = plant(index);
      const only = async (match: GitIndexMatch) => okOf(await readGitIndex(location, { match })).paths;

      expect(await only({ suffixes: ['.SQL'] })).toEqual([
        'models/marts/fct_order.SQL',
        'models/staging/stg_orders.sql',
        'ünïcode/größe.sql',
      ]);
      expect(await only({ names: ['DBT_PROJECT.YML'] })).toEqual(['dbt_project.yml', 'src/sub/dbt_project.yml']);
      // A whole path that is the name, and a name deeper down.
      expect(await only({ names: ['sql', 'Database.json'] })).toEqual([
        'Reports/Sales.SemanticModel/definition/Database.JSON',
        'sql',
      ]);
      // Non-ASCII letters are compared as they are: only ASCII case is folded.
      expect(await only({ suffixes: ['größe.sql'] })).toEqual(['ünïcode/größe.sql']);
      expect(await only({ suffixes: ['GRÖSSE.SQL', 'GRÖßE.SQL'] })).toEqual([]);
      // Nothing asked for, nothing kept; an empty string or a name with a slash matches nothing.
      expect(await only({})).toEqual([]);
      expect(await only({ suffixes: [''], names: ['', 'sub/dbt_project.yml'] })).toEqual([]);
      // A suffix longer than the path it is tested on.
      expect(await only({ suffixes: ['a-very-long-suffix-that-no-path-here-is-as-long-as/README.md'] })).toEqual([]);
    });
  });

  describe('a split index', () => {
    it.each([2, 3, 4])('version %i: returns the shared paths and its own, skipping stripped entries', async (version) => {
      const shared = ['a/one.sql', 'a/two.txt', 'b/three.dbml', 'b/four.sql'];
      // Two entries replace shared ones (git strips their paths), then two are new.
      const own: Entry[] = [
        { path: 'a/one.sql', stripped: true },
        { path: 'b/four.sql', stripped: true },
        { path: 'c/five.sql' },
        { path: 'c/six.md' },
      ];
      const result = okOf(await readGitIndex(plantSplit(version, shared, own), { match: MATCH, collectDirs: true }));
      expect([...result.paths].sort()).toEqual(['a/one.sql', 'b/four.sql', 'b/three.dbml', 'c/five.sql']);
      expect(result.dirs).toEqual(new Set(['a', 'b', 'c']));
      expect(result).toMatchObject({ entries: 8, version, split: true });
    });

    it('returns a path that is in both files once', async () => {
      const location = plantSplit(2, ['a.sql', 'b.sql'], ['b.sql', 'c.sql']);
      expect(okOf(await readGitIndex(location, { match: MATCH })).paths.sort()).toEqual(['a.sql', 'b.sql', 'c.sql']);
    });

    it('reads the shared index with the same id size (SHA-256)', async () => {
      const location = plantSplit(4, ['a.sql', 'b.txt'], [{ path: 'a.sql', stripped: true }, 'c.sql'], 32);
      const result = okOf(await readGitIndex(location, { match: MATCH }));
      expect(result.paths.sort()).toEqual(['a.sql', 'c.sql']);
      expect(result).toMatchObject({ entries: 4, split: true });
    });

    it('has no shared index when the link id is all zeros', async () => {
      const index = buildIndex({ version: 2, entries: ['a.sql'], extensions: [linkExtension(Buffer.alloc(20))] });
      expect(okOf(await read(index))).toEqual({ ok: true, paths: ['a.sql'], entries: 1, version: 2, split: false });
    });

    it('fails with sharedIndex when the shared index is missing, unreadable or unusable', async () => {
      const shared = buildIndex({ version: 2, entries: ['a.sql', 'b.sql'] });
      const id = idOf(shared);
      const index = buildIndex({ version: 2, entries: ['c.sql'], extensions: [linkExtension(id)] });
      const name = `sharedindex.${id.toString('hex')}`;
      const withShared = (bytes?: Buffer) => readGitIndex(plant(index, bytes ? { [name]: bytes } : {}), { match: MATCH });

      expect(reasonOf(await withShared())).toBe('sharedIndex');
      expect(reasonOf(await withShared(Buffer.from('not an index at all')))).toBe('sharedIndex');
      expect(reasonOf(await withShared(shared.subarray(0, shared.length - 30)))).toBe('sharedIndex');
      expect(reasonOf(await withShared(buildIndex({ version: 5, entries: ['a.sql'] })))).toBe('sharedIndex');
      // A shared index has every path: an empty one there is damage.
      expect(reasonOf(await withShared(buildIndex({ version: 2, entries: [{ path: 'a.sql', stripped: true }] })))).toBe('sharedIndex');
      // Its ids are the index's size, never re-guessed.
      expect(reasonOf(await withShared(buildIndex({ version: 2, entries: ['a.sql'], hashSize: 32 })))).toBe('sharedIndex');
      // The size limit is for each file.
      plant(index, { [name]: shared });
      expect(reasonOf(await readGitIndex(plant(index), { match: MATCH, maxBytes: shared.length - 1 }))).toBe('sharedIndex');
      expect(reasonOf(await readGitIndex(plant(index), { match: MATCH, maxBytes: shared.length }))).toBe('ok');
      // A folder where the file should be.
      fs.rmSync(path.join(tmp, '.git', name));
      fs.mkdirSync(path.join(tmp, '.git', name));
      expect(reasonOf(await readGitIndex(plant(index), { match: MATCH }))).toBe('sharedIndex');
    });

    it('treats a stripped entry outside a split index as damage', async () => {
      const entries: Entry[] = [{ path: 'a.sql', stripped: true }, { path: 'b.sql' }];
      for (const version of [2, 3, 4]) {
        expect(reasonOf(await read(buildIndex({ version, entries, extensions: [TREE] })))).toBe('corrupt');
      }
    });
  });

  describe('a subfolder of the repository', () => {
    const entries = [
      'SUB/upper.sql',
      'other/sub/x.sql',
      'sub.sql',
      'sub/a.sql',
      'sub/deep/b.SQL',
      'sub/deep/deeper/c.dbml',
      'sub/deep/notes.txt',
      'sub/dbt_project.yml',
      'sub2/d.sql',
      'subway/e.sql',
      'top.sql',
    ].sort(byBytes);

    it.each([2, 4])('version %i: keeps only paths under the prefix, relative to it', async (version) => {
      const location = plant(buildIndex({ version, entries }));
      const under = async (options: Partial<GitIndexReadOptions>) =>
        okOf(await readGitIndex(location, { match: MATCH, ...options })).paths;

      expect(await under({ prefix: 'sub' })).toEqual(['a.sql', 'dbt_project.yml', 'deep/b.SQL', 'deep/deeper/c.dbml']);
      expect(await under({ prefix: 'sub/deep' })).toEqual(['b.SQL', 'deeper/c.dbml']);
      expect(await under({ prefix: 'sub/deep/deeper' })).toEqual(['c.dbml']);
      expect(await under({ prefix: 'sub2' })).toEqual(['d.sql']);
      expect(await under({ prefix: 'nowhere' })).toEqual([]);
      // A path that is the prefix and nothing more is not under it.
      expect(await under({ prefix: 'top.sql' })).toEqual([]);
      // '' and absent: everything, as it is.
      expect(await under({ prefix: '' })).toEqual(await under({}));
      expect(await under({})).toHaveLength(entries.length - 1);
      // Slashes around the prefix do not matter.
      expect(await under({ prefix: '/sub/deep/' })).toEqual(['b.SQL', 'deeper/c.dbml']);
    });

    it.each([2, 4])('version %i: compares the prefix by case only when asked not to', async (version) => {
      const location = plant(buildIndex({ version, entries }));
      const under = async (options: Partial<GitIndexReadOptions>) =>
        okOf(await readGitIndex(location, { match: MATCH, ...options })).paths;

      expect(await under({ prefix: 'SUB' })).toEqual(['upper.sql']);
      expect(await under({ prefix: 'SUB', prefixIgnoreCase: false })).toEqual(['upper.sql']);
      expect(await under({ prefix: 'Sub', prefixIgnoreCase: false })).toEqual([]);
      const both = ['upper.sql', 'a.sql', 'dbt_project.yml', 'deep/b.SQL', 'deep/deeper/c.dbml'];
      expect(await under({ prefix: 'SUB', prefixIgnoreCase: true })).toEqual(both);
      expect(await under({ prefix: 'sub', prefixIgnoreCase: true })).toEqual(both);
      expect(await under({ prefix: 'sUb/DEEP', prefixIgnoreCase: true })).toEqual(['b.SQL', 'deeper/c.dbml']);
    });

    it('returns the folders under the prefix, relative to it', async () => {
      const location = plant(buildIndex({ version: 4, entries }));
      const result = okOf(await readGitIndex(location, { match: MATCH, prefix: 'sub', collectDirs: true }));
      expect(result.dirs).toEqual(new Set(['deep', 'deep/deeper']));
      const deep = okOf(await readGitIndex(location, { match: MATCH, prefix: 'sub/deep/deeper', collectDirs: true }));
      expect(deep.dirs).toEqual(new Set());
    });
  });

  describe('which entries count', () => {
    const entries: Entry[] = [
      { path: 'a/b/c/x.sql' },
      { path: 'a/b/y.txt' },
      { path: 'a/link.sql', mode: SYMLINK },
      { path: 'a/z.sql', mode: 0o100755 },
      { path: 'conflict/both.sql', stage: 1 },
      { path: 'conflict/both.sql', stage: 2 },
      { path: 'conflict/both.sql', stage: 3 },
      { path: 'm/n/o/p/q.txt' },
      { path: 'sparse/', mode: SPARSE_DIR },
      { path: 'sparse-too/inner.sql/', mode: SPARSE_DIR },
      { path: 'top.sql' },
      { path: 'vendor/lib.sql', mode: GITLINK },
      { path: 'vendor/more/module.dbml', mode: GITLINK },
    ];

    it.each([2, 3, 4])('version %i: skips gitlinks and sparse folders, and returns a conflicted path once', async (version) => {
      const result = okOf(await read(buildIndex({ version, entries, extensions: [TREE] }), { collectDirs: true }));
      expect(result.paths).toEqual(['a/b/c/x.sql', 'a/link.sql', 'a/z.sql', 'conflict/both.sql', 'top.sql']);
      expect(result.entries).toBe(entries.length);
      // Each folder holding a tracked file and its ancestors; never '' and never a gitlink's or a sparse folder's.
      expect(result.dirs).toEqual(new Set(['a', 'a/b', 'a/b/c', 'conflict', 'm', 'm/n', 'm/n/o', 'm/n/o/p']));
    });

    it('returns no dirs unless asked', async () => {
      expect(okOf(await read(buildIndex({ version: 2, entries }))).dirs).toBeUndefined();
      expect(okOf(await read(buildIndex({ version: 2, entries }), { collectDirs: false })).dirs).toBeUndefined();
      expect(okOf(await read(buildIndex({ version: 2, entries: ['top.sql'] }), { collectDirs: true })).dirs).toEqual(new Set());
    });

    it('collects folders whatever the match keeps, and whatever order the folders come in', async () => {
      // Not sorted: a folder left and come back to is still only added once, and nothing is missed.
      const unsorted = ['x/y/1.txt', 'x/2.txt', 'x/y/3.txt', 'p/q/r/4.txt', 'x/y/5.txt', `long/${'n'.repeat(700)}/6.txt`];
      for (const version of [2, 4]) {
        const result = okOf(await read(buildIndex({ version, entries: unsorted }), { match: {}, collectDirs: true }));
        expect(result.paths).toEqual([]);
        expect(result.dirs).toEqual(new Set(['x', 'x/y', 'p', 'p/q', 'p/q/r', 'long', `long/${'n'.repeat(700)}`]));
      }
    });
  });

  describe('SHA-256 repositories', () => {
    it.each([2, 3, 4])('version %i: reads 32-byte object ids, told apart by what adds up', async (version) => {
      const entries = TRACKED.map((entry, i): Entry =>
        version >= 3 && i % 5 === 0 ? { path: entry, extended: SKIP_WORKTREE } : { path: entry },
      );
      const index = buildIndex({ version, entries, hashSize: 32, extensions: [TREE] });
      const result = okOf(await read(index, { collectDirs: true }));
      expect(result.paths).toEqual(KEPT);
      expect(result).toMatchObject({ entries: TRACKED.length, version, split: false });
      expect(result.dirs?.has('Reports/Sales.SemanticModel/definition')).toBe(true);

      const empty = buildIndex({ version, entries: [], hashSize: 32 });
      expect(okOf(await read(empty))).toEqual({ ok: true, paths: [], entries: 0, version, split: false });
    });
  });

  describe('failures', () => {
    const good = () => buildIndex({ version: 2, entries: TRACKED, extensions: [TREE] });

    it('missing: no index file, or something that is not a file', async () => {
      const gitDir = path.join(tmp, '.git');
      expect(await readGitIndex({ gitDir, indexPath: path.join(gitDir, 'index') }, { match: MATCH })).toEqual({
        ok: false,
        reason: 'missing',
      });
      fs.mkdirSync(path.join(gitDir, 'index'), { recursive: true });
      expect(reasonOf(await readGitIndex({ gitDir, indexPath: path.join(gitDir, 'index') }, { match: MATCH }))).toBe('missing');
    });

    it('notIndex: does not start with DIRC', async () => {
      const bad = good();
      bad.write('DIRX', 0, 'latin1');
      expect(await read(bad)).toEqual({ ok: false, reason: 'notIndex' });
      expect(reasonOf(await read(Buffer.alloc(0)))).toBe('notIndex');
      expect(reasonOf(await read(Buffer.from('DI')))).toBe('notIndex');
      expect(reasonOf(await read(Buffer.from('ref: refs/heads/main\n')))).toBe('notIndex');
    });

    it('version: anything but 2, 3 or 4', async () => {
      for (const version of [0, 1, 5, 0x02000000]) {
        expect(reasonOf(await read(buildIndex({ version, entries: TRACKED })))).toBe('version');
      }
    });

    it.each([2, 3, 4])('corrupt: a version %i file cut short', async (version) => {
      const index = buildIndex({ version, entries: TRACKED, extensions: [TREE] });
      for (const length of [8, 12, 31, 32, 100, Math.floor(index.length / 2), index.length - 21, index.length - 1]) {
        expect(reasonOf(await read(index.subarray(0, length))), `cut to ${length}`).toBe('corrupt');
      }
      // And one with bytes after its checksum.
      expect(reasonOf(await read(Buffer.concat([index, Buffer.from([0])])))).toBe('corrupt');
    });

    it.each([2, 3, 4])('corrupt: a version %i name length that is not the path\'s', async (version) => {
      for (const statedLength of [0, 4, 6, 0xfff]) {
        const entries: Array<Entry | string> = ['a.sql', { path: 'b.sql', statedLength }, 'c.sql'];
        expect(reasonOf(await read(buildIndex({ version, entries }))), `stated ${statedLength}`).toBe('corrupt');
      }
    });

    it('corrupt: an entry count that is not the number of entries', async () => {
      for (const version of [2, 4]) {
        expect(reasonOf(await read(buildIndex({ version, entries: TRACKED, count: TRACKED.length + 1 })))).toBe('corrupt');
        expect(reasonOf(await read(buildIndex({ version, entries: TRACKED, count: TRACKED.length - 1 })))).toBe('corrupt');
        expect(reasonOf(await read(buildIndex({ version, entries: TRACKED, count: 0xffffffff })))).toBe('corrupt');
      }
    });

    it('corrupt: extensions that do not end where the checksum starts', async () => {
      const index = good();
      const body = index.subarray(0, index.length - 20);
      const checksum = index.subarray(index.length - 20);
      // Stray bytes between the last extension and the checksum.
      expect(reasonOf(await read(Buffer.concat([body, Buffer.from([1, 2, 3]), checksum])))).toBe('corrupt');
      // An extension that claims more bytes than are left.
      const overlong = Buffer.concat([Buffer.from('REUC'), Buffer.from([0, 0, 0x10, 0]), Buffer.alloc(16)]);
      expect(reasonOf(await read(Buffer.concat([body, overlong, checksum])))).toBe('corrupt');
      // A link extension too short to hold an id.
      const shortLink = buildIndex({ version: 2, entries: ['a.sql'], extensions: [{ signature: 'link', data: Buffer.alloc(8, 7) }] });
      expect(reasonOf(await read(shortLink))).toBe('corrupt');
      // Whole extensions do add up.
      const more = Buffer.concat([Buffer.from('UNTR'), Buffer.from([0, 0, 0, 5]), Buffer.from('hello')]);
      expect(reasonOf(await read(Buffer.concat([body, more, checksum])))).toBe('ok');
    });

    it('corrupt: flags no version of git writes', async () => {
      // The extended bit in a version 2 index.
      const entries: Entry[] = [{ path: 'a.sql', extended: SKIP_WORKTREE }];
      expect(reasonOf(await read(buildIndex({ version: 2, entries })))).toBe('corrupt');
      // Extended flags git does not define.
      for (const version of [3, 4]) {
        expect(reasonOf(await read(buildIndex({ version, entries: [{ path: 'a.sql', extended: 0x8000 }] })))).toBe('corrupt');
        expect(reasonOf(await read(buildIndex({ version, entries: [{ path: 'a.sql', extended: 0x0001 }] })))).toBe('corrupt');
        expect(reasonOf(await read(buildIndex({ version, entries: [{ path: 'a.sql', extended: 0x6000 }] })))).toBe('ok');
      }
    });

    it('corrupt: a version 4 entry that drops more than the path before it has', async () => {
      const index = buildIndex({ version: 4, entries: ['a.sql', 'b.sql'] });
      // The second entry's drop count: 5 ("a.sql" goes). 6 is one too many.
      const at = index.indexOf(Buffer.from('\u0005b.sql\u0000', 'latin1'));
      expect(at).toBeGreaterThan(0);
      index[at] = 6;
      expect(reasonOf(await read(index))).toBe('corrupt');
      // A drop count that never ends.
      index[at] = 0xff;
      index.fill(0xff, at, at + 6);
      expect(reasonOf(await read(index))).toBe('corrupt');
    });

    it('corrupt: padding that is not NUL bytes', async () => {
      // "a.sql" ends with its NUL and 4 more of padding in a 72-byte entry: dirty one of those.
      const index = buildIndex({ version: 2, entries: ['a.sql', 'b.sql'] });
      const at = index.indexOf(Buffer.from('a.sql\u0000', 'latin1'));
      index[at + 6] = 0x41;
      expect(reasonOf(await read(index))).toBe('corrupt');
    });

    it('tooLarge: over maxBytes, without reading the file', async () => {
      const index = good();
      expect(await read(index, { maxBytes: index.length - 1 })).toEqual({ ok: false, reason: 'tooLarge' });
      expect(reasonOf(await read(index, { maxBytes: index.length }))).toBe('ok');
      // Not even a file that is not an index is looked at.
      expect(reasonOf(await read(Buffer.alloc(4096, 0x58), { maxBytes: 100 }))).toBe('tooLarge');
      expect(GIT_INDEX_MAX_BYTES).toBe(32 * 1024 * 1024);
    });

    it('cancelled: before the read, and in the middle of it', async () => {
      expect(await read(good(), { cancelled: () => true })).toEqual({ ok: false, reason: 'cancelled' });
      // Even where there is no index: cancelled is asked first.
      const nowhere = { gitDir: path.join(tmp, 'none'), indexPath: path.join(tmp, 'none', 'index') };
      expect(reasonOf(await readGitIndex(nowhere, { match: MATCH, cancelled: () => true }))).toBe('cancelled');

      // A clock that jumps a slice at every look: the read pauses after each batch of entries.
      const many = Array.from({ length: 5000 }, (_, i) => `models/m${String(i).padStart(5, '0')}.sql`);
      for (const version of [2, 4]) {
        const location = plant(buildIndex({ version, entries: many }));
        let clock = 0;
        let asked = 0;
        const result = await readGitIndex(location, {
          match: MATCH,
          now: () => (clock += 100),
          cancelled: () => ++asked > 4,
        });
        expect(result).toEqual({ ok: false, reason: 'cancelled' });
        expect(asked).toBe(5);
      }
    });

    it('never throws, whatever it is handed', async () => {
      const index = good();
      const location = plant(index);
      const boom = () => {
        throw new Error('boom');
      };
      expect(reasonOf(await readGitIndex(location, { match: MATCH, now: boom }))).toBe('corrupt');
      expect(reasonOf(await readGitIndex(location, { match: MATCH, cancelled: boom }))).toBe('corrupt');
      expect(reasonOf(await readGitIndex({ gitDir: '', indexPath: '' }, { match: MATCH }))).toBe('missing');
      expect(reasonOf(await readGitIndex({ gitDir: tmp, indexPath: 'bad\u0000path' }, { match: MATCH }))).toBe('missing');
      // Nothing to find from a path no file system takes, and nothing thrown.
      expect((await findGitIndex(path.join(tmp, 'bad\u0000path', 'deeper')))?.workTree).toBe(tmp);
      // Random bytes after a good header.
      for (let seed = 1; seed <= 20; seed++) {
        const noise = Buffer.alloc(600);
        let state = seed * 2654435761;
        for (let i = 0; i < noise.length; i++) {
          state = (state * 1103515245 + 12345) >>> 0;
          noise[i] = state >>> 16;
        }
        for (const version of [2, 3, 4]) {
          const header = Buffer.alloc(12);
          header.write('DIRC', 0, 'latin1');
          header.writeUInt32BE(version, 4);
          header.writeUInt32BE(3, 8);
          expect(reasonOf(await read(Buffer.concat([header, noise])))).toBe('corrupt');
        }
      }
    });
  });

  describe('the event loop', () => {
    /** 200,000 sorted paths in 2,000 folders, a `.sql` file planted every 500 and a `dbt_project.yml` every 40,000. */
    function manyEntries(): { entries: string[]; planted: string[] } {
      const entries: string[] = [];
      const planted: string[] = [];
      for (let i = 0; i < 200_000; i++) {
        const folder = `src/area${String(Math.floor(i / 10_000)).padStart(2, '0')}/module${String(Math.floor(i / 100)).padStart(4, '0')}`;
        const file = String(i).padStart(6, '0');
        let entry = `${folder}/component_${file}.ts`;
        if (i % 40_000 === 99) entry = `${folder}/dbt_project.yml`;
        else if (i % 500 === 250) entry = `${folder}/component_${file}.SQL`;
        if (!entry.endsWith('.ts')) planted.push(entry);
        entries.push(entry);
      }
      return { entries, planted };
    }

    /** Counts the turns of the event loop: `setImmediate` runs once a turn. */
    function countTurns(): { turns: () => number; stop: () => void } {
      let turns = 0;
      let counting = true;
      const turn = () => {
        turns++;
        if (counting) setImmediate(turn);
      };
      setImmediate(turn);
      return { turns: () => turns, stop: () => (counting = false) };
    }

    it.each([2, 4])('version %i: reads 200,000 entries without holding the event loop', async (version) => {
      const { entries, planted } = manyEntries();
      const location = plant(buildIndex({ version, entries, extensions: [TREE] }));
      expect(planted).toHaveLength(405);

      // On the real clock, with the default slice. A 1 ms timer: the longest
      // wait between two of its ticks is how long the read held the loop.
      let longest = 0;
      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
      }, 1);
      let result: GitIndexResult;
      try {
        result = await readGitIndex(location, { match: MATCH, collectDirs: true });
      } finally {
        clearInterval(timer);
      }
      // The stretch after the last tick counts too, so a read that held the loop throughout cannot pass.
      longest = Math.max(longest, performance.now() - last);

      const done = okOf(result);
      expect(done.paths).toEqual(planted);
      expect(done).toMatchObject({ entries: 200_000, version, split: false });
      // 2,000 module folders, their 20 area folders, and `src`.
      expect(done.dirs?.size).toBe(2000 + 20 + 1);
      // A loose bound on the real clock (a busy CI runner pauses for its own reasons); the slice itself is pinned on a stepped clock below.
      expect(longest).toBeLessThan(250);

      // How often it pauses. The whole read takes a slice or two on a fast
      // machine, so the pauses are counted on a clock that moves 1 ms at every
      // look instead: 391 batches of 512 entries, a pause after every 8th.
      let clock = 0;
      const turnsWhenAsked: number[] = [];
      const loop = countTurns();
      const stepped = await readGitIndex(location, {
        match: MATCH,
        now: () => clock++,
        cancelled: () => {
          turnsWhenAsked.push(loop.turns());
          return false;
        },
      });
      loop.stop();
      expect(okOf(stepped).paths).toEqual(planted);
      // Asked before the read, once the file is in, and after each pause.
      const pauses = turnsWhenAsked.length - 2;
      expect(pauses).toBeGreaterThan(3);
      expect(pauses).toBe(48);
      // Each pause was a whole turn of the event loop: timers and messages got in.
      for (let i = 1; i < turnsWhenAsked.length; i++) {
        expect(turnsWhenAsked[i]).toBeGreaterThan(turnsWhenAsked[i - 1]);
      }
    });

    it('pauses once per used-up slice, and looks at the clock every 512 entries', async () => {
      const entries = Array.from({ length: 512 * 40 }, (_, i) => `models/m${String(i).padStart(6, '0')}.sql`);
      const location = plant(buildIndex({ version: 2, entries }));
      // A clock that moves 1 ms at each look: an 8 ms slice is 8 batches of 512 entries.
      let clock = 0;
      let looks = 0;
      let asked = 0;
      const result = await readGitIndex(location, {
        match: MATCH,
        now: () => {
          looks++;
          return clock++;
        },
        cancelled: () => {
          asked++;
          return false;
        },
      });
      expect(okOf(result).paths).toHaveLength(entries.length);
      // 40 batches, a look after each but the last: a pause at the 8th, 16th, 24th and 32nd.
      expect(asked - 2).toBe(4);
      // Two looks to start, the 39 between batches, and one as each pause ends.
      expect(looks).toBe(2 + 39 + 4);

      // A slice of 0 pauses after every batch; a huge one never pauses.
      asked = 0;
      await readGitIndex(location, { match: MATCH, sliceMs: 0, cancelled: () => (asked++, false) });
      expect(asked).toBe(2 + 39);
      asked = 0;
      await readGitIndex(location, { match: MATCH, sliceMs: 1e9, cancelled: () => (asked++, false) });
      expect(asked).toBe(2);
    });

    it('still resolves under a test\'s fake timers', async () => {
      // The activation tests run under vi.useFakeTimers(), which replaces the
      // global setImmediate: a read that waited on that one would never end.
      const plain = plant(buildIndex({ version: 2, entries: TRACKED, extensions: [TREE] }));
      const many = Array.from({ length: 3000 }, (_, i) => `models/m${String(i).padStart(5, '0')}.sql`);
      vi.useFakeTimers();
      try {
        // The global is the fake clock's now: this callback waits for a clock nobody moves.
        let globalRan = false;
        setImmediate(() => {
          globalRan = true;
        });

        expect(okOf(await readGitIndex(plain, { match: MATCH })).paths).toEqual(KEPT);
        const split = plantSplit(4, ['a/one.sql', 'a/two.txt'], [{ path: 'a/one.sql', stripped: true }, 'b/three.sql']);
        expect(okOf(await readGitIndex(split, { match: MATCH })).paths.sort()).toEqual(['a/one.sql', 'b/three.sql']);
        // With a pause after every batch, too.
        const paused = await readGitIndex(plant(buildIndex({ version: 4, entries: many })), { match: MATCH, sliceMs: 0 });
        expect(okOf(paused).paths).toHaveLength(many.length);
        expect(await findGitIndex(path.join(tmp, 'models'))).toMatchObject({ workTree: tmp });

        expect(globalRan).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// ── readGitIndex: what real git writes ─────────────────────────────────────

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)('readGitIndex against real git', () => {
  /** Tracked from the start. No two names differ only by case: macOS and Windows would fold them. */
  const FILES = [
    'README.md',
    'dbt_project.yml',
    'design/notes.txt',
    'design/shop.dbml',
    'models/größe.sql',
    'models/marts/core/fct_orders.sql',
    'models/marts/core/schema.yml',
    'models/staging/stg_customers.sql',
    'models/staging/stg_orders.SQL',
    'reports/Sales.SemanticModel/definition/database.json',
    'reports/Sales.SemanticModel/definition/model.bim',
    'scripts/sql.txt',
    'sub/project/dbt_project.yml',
    'sub/project/notdbt_project.yml',
  ];

  let repo: string;
  let env: NodeJS.ProcessEnv;

  /** git, with nothing of this machine's configuration and nothing of a calling git's environment. */
  function git(cwd: string, ...args: string[]): string {
    const base = ['-c', 'user.name=ERD Studio Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
    return execFileSync('git', [...base, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  function writeFile(root: string, file: string, text = `-- ${file}\n`): void {
    const target = path.join(root, ...file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }

  /** `git ls-files`: every tracked path, once. */
  function lsFiles(cwd: string, ...args: string[]): string[] {
    return [...new Set(git(cwd, 'ls-files', '-z', ...args).split('\0').filter((entry) => entry !== ''))];
  }

  const lower = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

  function keptBy(match: GitIndexMatch, file: string): boolean {
    const name = lower(file);
    const base = name.slice(name.lastIndexOf('/') + 1);
    return (match.suffixes ?? []).some((suffix) => name.endsWith(lower(suffix))) || (match.names ?? []).some((n) => base === lower(n));
  }

  function dirsOf(files: readonly string[]): Set<string> {
    const dirs = new Set<string>();
    for (const file of files) {
      const parts = file.split('/').slice(0, -1);
      for (let depth = 1; depth <= parts.length; depth++) dirs.add(parts.slice(0, depth).join('/'));
    }
    return dirs;
  }

  /** The entry count in an index file's header. */
  const headerCount = (file: string) => fs.readFileSync(file).readUInt32BE(8);

  /** Reads the index of `root` and checks it against `git ls-files` there. */
  async function expectSameAsGit(root: string, tracked = lsFiles(root)): Promise<Extract<GitIndexResult, { ok: true }>> {
    const location = await findGitIndex(root);
    if (!location) throw new Error('no repository found');
    const result = okOf(await readGitIndex(location, { match: MATCH, collectDirs: true }));
    expect([...result.paths].sort()).toEqual(tracked.filter((file) => keptBy(MATCH, file)).sort());
    expect(result.dirs).toEqual(dirsOf(tracked));
    // Every tracked path, with a match that keeps them all.
    const all = okOf(await readGitIndex(location, { match: { suffixes: [...new Set(tracked.map((file) => file.slice(-1)))] } }));
    expect([...all.paths].sort()).toEqual([...tracked].sort());
    return result;
  }

  beforeEach(() => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'gitconfig'), '');
    env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith('GIT_')) env[key] = value;
    }
    Object.assign(env, {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'xdg'),
      GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    });
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    for (const file of FILES) writeFile(repo, file);
    git(repo, 'add', '-A');
  });

  it('reads the index git writes by default', async () => {
    expect(await findGitIndex(path.join(repo, 'models', 'marts'))).toEqual({
      workTree: repo,
      gitDir: path.join(repo, '.git'),
      indexPath: path.join(repo, '.git', 'index'),
    });
    const tracked = lsFiles(repo);
    expect([...tracked].sort()).toEqual([...FILES].sort());
    const result = await expectSameAsGit(repo, tracked);
    expect(result).toMatchObject({ entries: FILES.length, version: 2, split: false });
    // The order is git's.
    expect(result.paths).toEqual(tracked.filter((file) => keptBy(MATCH, file)));

    // A subfolder: relative paths, as `git ls-files` prints them from there.
    const location = (await findGitIndex(repo))!;
    const under = okOf(await readGitIndex(location, { match: MATCH, prefix: 'models/marts', collectDirs: true }));
    const inMarts = lsFiles(path.join(repo, 'models', 'marts'));
    expect(under.paths).toEqual(inMarts.filter((file) => keptBy(MATCH, file)));
    expect(under.dirs).toEqual(dirsOf(inMarts));

    // After a commit (git adds a cache tree extension) and a removal.
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'rm', '-q', '--cached', 'design/shop.dbml');
    expect((await expectSameAsGit(repo)).entries).toBe(FILES.length - 1);
  });

  it('reads an empty repository as missing, and an emptied index as no paths', async () => {
    const fresh = path.join(tmp, 'fresh');
    fs.mkdirSync(fresh);
    git(fresh, 'init', '-q');
    const location = (await findGitIndex(fresh))!;
    expect(await readGitIndex(location, { match: MATCH })).toEqual({ ok: false, reason: 'missing' });

    git(repo, 'rm', '-q', '-r', '--cached', '.');
    expect(await expectSameAsGit(repo)).toMatchObject({ paths: [], entries: 0 });
  });

  it('reads a version 4 index', async () => {
    git(repo, 'update-index', '--index-version', '4');
    expect(await expectSameAsGit(repo)).toMatchObject({ entries: FILES.length, version: 4, split: false });
    writeFile(repo, 'models/marts/core/dim_customers.sql');
    writeFile(repo, 'a/first.sql');
    writeFile(repo, 'zz/last/dbt_project.yml');
    git(repo, 'add', '-A');
    expect(await expectSameAsGit(repo)).toMatchObject({ entries: FILES.length + 3, version: 4 });
  });

  it.each([2, 4])('reads a split index (version %i): its own entries and the shared index\'s', async (version) => {
    // 100: never fold the split index back into a new shared one, however much of it changes.
    const split = ['-c', 'splitIndex.maxPercentChange=100'];
    git(repo, 'update-index', '--index-version', String(version));
    git(repo, ...split, 'update-index', '--split-index');
    const index = path.join(repo, '.git', 'index');
    const shared = () => fs.readdirSync(path.join(repo, '.git')).filter((name) => name.startsWith('sharedindex.'));
    const sharedCount = () => headerCount(path.join(repo, '.git', shared()[0]));
    expect(shared()).toHaveLength(1);
    expect(sharedCount()).toBe(FILES.length);
    // git starts a split index with a stand-in for every shared entry: no path, only the fresher stat data.
    expect(headerCount(index)).toBeLessThanOrEqual(FILES.length);
    expect(fs.readFileSync(index).includes('dbt_project.yml')).toBe(false);
    expect(await expectSameAsGit(repo)).toMatchObject({ entries: headerCount(index) + sharedCount(), version, split: true });

    // One more file: now both files hold entries.
    writeFile(repo, 'models/marts/core/dim_customers.sql');
    git(repo, ...split, 'add', '-A');
    expect(shared()).toHaveLength(1);
    expect(headerCount(index)).toBeGreaterThanOrEqual(1);
    expect(sharedCount()).toBe(FILES.length);
    const added = await expectSameAsGit(repo);
    expect(added).toMatchObject({ entries: headerCount(index) + sharedCount(), version, split: true });
    expect(added.paths).toContain('models/marts/core/dim_customers.sql');

    // A changed file replaces its shared entry, and git writes the replacement
    // without its path: the two changed here and the two new ones, at least
    // (git may refresh other entries the same way).
    writeFile(repo, 'models/staging/stg_customers.sql', 'select 1 as changed\n');
    writeFile(repo, 'dbt_project.yml', 'name: changed\n');
    writeFile(repo, 'zz/last.sql');
    git(repo, ...split, 'add', '-A');
    expect(shared()).toHaveLength(1);
    expect(headerCount(index)).toBeGreaterThanOrEqual(4);
    if (version === 2) {
      // Version 2 writes whole paths, so a path not in the file was stripped.
      const own = fs.readFileSync(index);
      expect(own.includes('zz/last.sql')).toBe(true);
      expect(own.includes('models/staging/stg_customers.sql')).toBe(false);
    }
    const changed = await expectSameAsGit(repo);
    expect(changed).toMatchObject({ entries: headerCount(index) + sharedCount(), version, split: true });
    expect(changed.paths).toContain('zz/last.sql');

    // A removed file is only marked in the shared index: still listed, which the caller's existence check drops.
    git(repo, ...split, 'rm', '-q', '--cached', 'design/shop.dbml');
    const location = (await findGitIndex(repo))!;
    const after = okOf(await readGitIndex(location, { match: MATCH }));
    const tracked = lsFiles(repo).filter((file) => keptBy(MATCH, file));
    expect(tracked).not.toContain('design/shop.dbml');
    expect([...after.paths].sort()).toEqual([...tracked, 'design/shop.dbml'].sort());

    // Without its shared index the split index is not usable.
    fs.rmSync(path.join(repo, '.git', shared()[0]));
    expect(await readGitIndex(location, { match: MATCH })).toEqual({ ok: false, reason: 'sharedIndex' });
  });

  it('reads the version 3 index an intent-to-add file makes', async () => {
    writeFile(repo, 'models/staging/stg_payments.sql');
    writeFile(repo, 'later/dbt_project.yml');
    git(repo, 'add', '-N', 'models/staging/stg_payments.sql', 'later/dbt_project.yml');
    const result = await expectSameAsGit(repo);
    expect(result).toMatchObject({ entries: FILES.length + 2, version: 3, split: false });
    expect(result.paths).toContain('models/staging/stg_payments.sql');
    expect(result.paths).toContain('later/dbt_project.yml');
  });

  it('reads a linked worktree\'s own index, found from a folder inside it', async () => {
    git(repo, 'commit', '-q', '-m', 'first');
    const tree = path.join(tmp, 'tree');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', tree);
    expect(fs.statSync(path.join(tree, '.git')).isFile()).toBe(true);

    const location = await findGitIndex(path.join(tree, 'models', 'staging'));
    if (!location) throw new Error('no repository found');
    expect(location.workTree).toBe(tree);
    expect(fs.realpathSync(location.gitDir)).toBe(fs.realpathSync(path.join(repo, '.git', 'worktrees', 'tree')));
    expect(location.indexPath).toBe(path.join(location.gitDir, 'index'));

    // Tracked in the worktree only: its index is not the main one.
    writeFile(tree, 'models/staging/stg_refunds.sql');
    git(tree, 'add', '-A');
    const inTree = await expectSameAsGit(tree);
    expect(inTree.paths).toContain('models/staging/stg_refunds.sql');
    expect(inTree.entries).toBe(FILES.length + 1);
    const inMain = await expectSameAsGit(repo);
    expect(inMain.paths).not.toContain('models/staging/stg_refunds.sql');

    // A split index there keeps its shared index in the worktree's own git folder.
    git(tree, '-c', 'splitIndex.maxPercentChange=100', 'update-index', '--split-index');
    writeFile(tree, 'models/staging/stg_returns.sql');
    git(tree, '-c', 'splitIndex.maxPercentChange=100', 'add', '-A');
    const sharedIn = fs.readdirSync(location.gitDir).filter((name) => name.startsWith('sharedindex.'));
    expect(sharedIn).toHaveLength(1);
    const split = await expectSameAsGit(tree);
    expect(split.split).toBe(true);
    expect(split.entries).toBe(headerCount(location.indexPath) + headerCount(path.join(location.gitDir, sharedIn[0])));
    expect(split.paths).toContain('models/staging/stg_returns.sql');
  });

  it('reads a version 4 index written in blocks, and an index with no checksum', async () => {
    // index.threads makes git write an offset table (IEOT). Each of its blocks
    // starts its paths afresh: the first entry drops the whole path before it.
    git(repo, '-c', 'index.threads=4', 'update-index', '--index-version', '4');
    const index = path.join(repo, '.git', 'index');
    expect(fs.readFileSync(index).includes('IEOT')).toBe(true);
    expect(await expectSameAsGit(repo)).toMatchObject({ entries: FILES.length, version: 4, split: false });

    // index.skipHash (what feature.manyFiles turns on) leaves the checksum as zeros.
    writeFile(repo, 'models/staging/stg_payments.sql');
    git(repo, '-c', 'index.threads=4', '-c', 'index.skipHash=true', 'add', '-A');
    expect(await expectSameAsGit(repo)).toMatchObject({ entries: FILES.length + 1, version: 4 });
  });

  it('reads a SHA-256 repository, whose object ids are 32 bytes', async (context) => {
    const sha = path.join(tmp, 'sha256');
    fs.mkdirSync(sha);
    try {
      git(sha, 'init', '-q', '--object-format=sha256');
    } catch {
      context.skip(); // a git from before SHA-256 repositories (2.29)
    }
    for (const file of FILES) writeFile(sha, file);
    git(sha, 'add', '-A');
    expect(await expectSameAsGit(sha)).toMatchObject({ entries: FILES.length, version: 2, split: false });

    git(sha, 'update-index', '--index-version', '4');
    git(sha, '-c', 'splitIndex.maxPercentChange=100', 'update-index', '--split-index');
    writeFile(sha, 'models/staging/stg_payments.sql');
    git(sha, '-c', 'splitIndex.maxPercentChange=100', 'add', '-A');
    const split = await expectSameAsGit(sha);
    expect(split).toMatchObject({ version: 4, split: true });
    expect(split.paths).toContain('models/staging/stg_payments.sql');
  });

  it('skips the folders a sparse index stands in for', async (context) => {
    git(repo, 'commit', '-q', '-m', 'first');
    try {
      git(repo, 'sparse-checkout', 'init', '--cone', '--sparse-index');
      git(repo, 'sparse-checkout', 'set', 'models/staging');
    } catch {
      context.skip(); // a git from before the sparse index
    }
    // `sdir`: the index holds folder entries in place of the files not checked out.
    if (!fs.readFileSync(path.join(repo, '.git', 'index')).includes('sdir')) context.skip();

    // What is checked out: models/staging, and the files directly in the folders above it.
    const present = FILES.filter((file) => ['', 'models', 'models/staging'].includes(file.split('/').slice(0, -1).join('/')));
    expect(present.length).toBeGreaterThan(3);
    expect(present.length).toBeLessThan(FILES.length);
    const location = (await findGitIndex(repo))!;
    const result = okOf(await readGitIndex(location, { match: MATCH, collectDirs: true }));
    expect([...result.paths].sort()).toEqual(present.filter((file) => keptBy(MATCH, file)).sort());
    expect(result.dirs).toEqual(new Set(['models', 'models/staging']));
    // Each file kept, plus one entry for each folder left out.
    expect(result.entries).toBeGreaterThan(present.length);
    expect(result.entries).toBeLessThan(FILES.length);
    for (const file of result.paths) expect(fs.existsSync(path.join(repo, file))).toBe(true);
  });

  it('returns a conflicted path once', async () => {
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'checkout', '-q', '-b', 'theirs');
    writeFile(repo, 'models/staging/stg_orders.SQL', 'select 1 as theirs\n');
    git(repo, 'commit', '-q', '-am', 'theirs');
    git(repo, 'checkout', '-q', '-');
    writeFile(repo, 'models/staging/stg_orders.SQL', 'select 1 as ours\n');
    git(repo, 'commit', '-q', '-am', 'ours');
    expect(() => git(repo, 'merge', '-q', 'theirs')).toThrow();
    // Three stages of the one path.
    expect(git(repo, 'ls-files', '-u', '-z').split('\0').filter(Boolean)).toHaveLength(3);

    const result = await expectSameAsGit(repo);
    expect(result.entries).toBe(FILES.length + 2);
    expect(result.paths.filter((file) => file === 'models/staging/stg_orders.SQL')).toHaveLength(1);
  });
});
