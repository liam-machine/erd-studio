/**
 * #357: what a look can now say about its search for dbt projects
 * (`FolderLookRun.dbtSearchStats`), and the longer look a user asks for
 * (`FolderLooks.longer`). Real temporary folders; a reader that holds one
 * listing where the test is about time.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { FOLDER_LOOK_LONGER_FACTOR, FOLDER_LOOK_MAX_MS, FolderLooks, type FolderLooksOptions } from '../../src/services/folderLook';
import { nodeScanReader, type ScanReader } from '../../src/services/folderScan';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { cleanup(); } catch { /* best effort */ }
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-look357-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

function write(root: string, rel: string, text = ''): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const noGit = { findGitIndex: async (): Promise<undefined> => undefined };

function looksOf(options: Partial<FolderLooksOptions> = {}): FolderLooks {
  const looks = new FolderLooks({ semanticDir: '.erd-studio', ...options, io: { ...noGit, ...options.io } });
  cleanups.push(() => looks.dispose());
  return looks;
}

/** The real disk, except that listing a folder named `stuck` waits until `release()`. */
function holdingReader(): { reader: ScanReader; release(): void; held: Promise<void> } {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const held = new Promise<void>((r) => { reached = r; });
  const reader: ScanReader = {
    ...nodeScanReader,
    async readDir(folder) {
      if (path.basename(folder) === 'stuck') { reached(); await gate; }
      return nodeScanReader.readDir(folder);
    },
  };
  return { reader, release, held };
}

/** Ten folders side by side and a dbt project in the last one. */
function wideFolder(): string {
  const root = tmpDir();
  for (let i = 0; i < 9; i++) write(root, `f${i}/readme.txt`, 'x');
  write(root, 'z-last/dbt_project.yml', "name: 'p'\n");
  return root;
}

describe('#357 how far a look\'s search for dbt projects has got', () => {
  it('a look that listed every folder is complete: nothing stopped it', async () => {
    const root = wideFolder();
    const run = looksOf().run(root);
    expect(await run.dbtProjects()).toEqual([path.join(root, 'z-last')]);
    const stats = run.dbtSearchStats();
    expect(stats).toMatchObject({ folders: 11, complete: true, stopped: undefined, maxMs: FOLDER_LOOK_MAX_MS, maxFolders: 5000 });
    expect(stats.msLeft).toBeGreaterThan(0);
  });

  it('a look that ran out of folders is not complete, says folders, and missed the project', async () => {
    const root = wideFolder();
    const run = looksOf({ maxFolders: 4 }).run(root);
    expect(await run.dbtProjects()).toEqual([]);
    expect(run.dbtSearchStats()).toMatchObject({ folders: 4, complete: false, stopped: 'folders', maxFolders: 4 });
  });

  it('a look that ran out of time says time, with none left', async () => {
    const root = tmpDir();
    write(root, 'stuck/deeper/dbt_project.yml', "name: 'p'\n");
    const { reader } = holdingReader();
    const run = looksOf({ maxMs: 40, io: { reader } }).run(root);
    expect(await run.dbtProjects()).toEqual([]);
    expect(run.dbtSearchStats()).toMatchObject({ complete: false, stopped: 'time', msLeft: 0, maxMs: 40 });
  });

  it('a look its time limit ended says time even when the clock reads a moment short of the limit', async () => {
    // A timer can fire a millisecond before the clock agrees it is due. The
    // reason is the limit that ended the walk, not what the clock reads after.
    const root = tmpDir();
    write(root, 'stuck/deeper/dbt_project.yml', "name: 'p'\n");
    const { reader } = holdingReader();
    let clock = 1_000_000;
    const run = looksOf({ maxMs: 40, io: { reader, now: () => clock } }).run(root);
    expect(await run.dbtProjects()).toEqual([]);
    clock += 39;
    expect(run.dbtSearchStats()).toMatchObject({ complete: false, stopped: 'time', msLeft: 0, maxMs: 40 });
  });

  it('while activation waits, nothing has stopped yet and the time left counts down by the look\'s clock', async () => {
    const root = tmpDir();
    write(root, 'stuck/dbt_project.yml', "name: 'p'\n");
    const { reader, release, held } = holdingReader();
    let clock = 1_000_000;
    const run = looksOf({ io: { reader, now: () => clock } }).run(root);
    const found = run.dbtProjects();
    await held;
    const early = run.dbtSearchStats();
    expect(early).toMatchObject({ complete: false, stopped: undefined, maxMs: FOLDER_LOOK_MAX_MS });
    clock += 12_000;
    const later = run.dbtSearchStats();
    expect(early.msLeft! - later.msLeft!).toBe(12_000);
    expect(later.msLeft).toBeLessThanOrEqual(FOLDER_LOOK_MAX_MS - 12_000);
    release();
    expect(await found).toEqual([path.join(root, 'stuck')]);
    expect(run.dbtSearchStats()).toMatchObject({ complete: true, stopped: undefined });
  });
});

describe('#357 a longer look', () => {
  it('gets 5 times the time and the folders, and finds the project the first one missed', async () => {
    const root = wideFolder();
    const looks = looksOf({ maxFolders: 4 });
    const first = looks.run(root);
    expect(await first.dbtProjects()).toEqual([]);
    const longer = looks.longer(root, FOLDER_LOOK_LONGER_FACTOR);
    expect(longer).not.toBe(first);
    expect(longer.dbtSearchStats().maxMs).toBe(FOLDER_LOOK_MAX_MS * FOLDER_LOOK_LONGER_FACTOR);
    expect(await longer.dbtProjects({ everyFolder: true })).toEqual([path.join(root, 'z-last')]);
    // Asked to list every folder: its bound is the look's own, five times the first look's.
    expect(longer.dbtSearchStats().maxFolders).toBe(4 * FOLDER_LOOK_LONGER_FACTOR);
    expect(longer.dbtSearchStats()).toMatchObject({ folders: 11, complete: true, stopped: undefined });
    // It took the folder's place: whoever asks next shares it. The first look is left as it was.
    expect(looks.peek(root)).toBe(longer);
    expect(first.dbtSearchStats()).toMatchObject({ folders: 4, complete: false });
  });

  it('cancelled (Stop Looking): whoever waits is let go, and it is not complete', async () => {
    const root = tmpDir();
    write(root, 'stuck/dbt_project.yml', "name: 'p'\n");
    const { reader, held } = holdingReader();
    const longer = looksOf({ io: { reader } }).longer(root, FOLDER_LOOK_LONGER_FACTOR);
    const found = longer.dbtProjects({ everyFolder: true });
    await held;
    longer.cancel();
    expect(await found).toEqual([]);
    expect(longer.dbtSearchStats()).toMatchObject({ complete: false, stopped: 'folders' });
  });

  it('a factor that is not a number above 1 changes nothing; a disposed window starts no walk', async () => {
    const root = wideFolder();
    const looks = looksOf({ maxFolders: 4 });
    expect(looks.longer(root, Number.NaN).dbtSearchStats().maxMs).toBe(FOLDER_LOOK_MAX_MS);
    looks.dispose();
    const after = looks.longer(root, FOLDER_LOOK_LONGER_FACTOR);
    expect(await after.dbtProjects({ everyFolder: true })).toEqual([]);
    expect(after.dbtSearchStats().complete).toBe(false);
  });
});
