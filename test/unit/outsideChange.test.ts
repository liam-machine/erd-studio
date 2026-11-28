/**
 * #329: where a change ERD Studio did not write came from. A diagram, table
 * or relationships file that changed outside ERD Studio's own writes is
 * Git when the repository's HEAD moved with it (a pull, checkout, merge or
 * commit), Editor when this window saved it (or renamed or deleted it), Disk
 * otherwise (a program writing the file: an assistant in a terminal, a
 * script), and NoGit when the workspace has no repository whose HEAD can be
 * read. Recorded as fixed presence keys, never a path, a name or a count.
 *
 * HEAD is read from the repository's own files, never by running git or
 * through the Git extension: when it last moved is the newest mtime of
 * `HEAD`, `logs/HEAD` and the loose ref HEAD names. Comparing what HEAD says
 * would miss a fast-forward pull (`.git/HEAD` still says `ref:
 * refs/heads/main`), and comparing with a commit read earlier would blame an
 * edit made hours after an unrelated pull on Git.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  HANDLED_HERE_WINDOW_MS,
  HEAD_MOVE_WINDOW_MS,
  LOOK_DELAY_MS,
  OUTSIDE_CHANGE_FEATURES,
  OUTSIDE_CREATE_FEATURES,
  OutsideChangeRecorder,
  classifyOutsideChange,
  lookAtHead,
  type HeadLook,
} from '../../src/services/outsideChange';
import {
  FEATURES,
  HEARTBEAT_SOFT_LIMIT,
  OUTSIDE_CHANGE_SOURCE_FEATURES,
  buildHeartbeat,
  emptyCounters,
  heartbeatBytes,
  provisionalBody,
  trimHeartbeat,
  type DailyCounters,
  type HeartbeatEnv,
} from '../../src/services/telemetryPayload';

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erd-outside-'))); });
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Set a file's mtime to `at` (ms since the epoch). */
function touch(file: string, at: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  fs.utimesSync(file, at / 1000, at / 1000);
}

/** A hand-made repository at `dir`: HEAD on `main`, every git file last changed at `at`. */
function fakeRepo(dir: string, at: number, head = 'ref: refs/heads/main\n'): string {
  const git = path.join(dir, '.git');
  fs.mkdirSync(git, { recursive: true });
  fs.writeFileSync(path.join(git, 'HEAD'), head);
  touch(path.join(git, 'HEAD'), at);
  touch(path.join(git, 'logs', 'HEAD'), at);
  touch(path.join(git, 'refs', 'heads', 'main'), at);
  return git;
}

const HOUR = 60 * 60_000;

describe('lookAtHead: when the repository HEAD last moved, read from its files', () => {
  it('finds no repository in a folder with no .git above it', () => {
    expect(lookAtHead(path.join(root, 'project'))).toEqual({ repo: false });
  });

  it('takes the newest of HEAD, logs/HEAD and the loose ref HEAD names', () => {
    const t = Date.now() - HOUR;
    const git = fakeRepo(root, t);
    touch(path.join(git, 'refs', 'heads', 'main'), t + 5_000);
    expect(lookAtHead(root)).toEqual({ repo: true, movedAt: t + 5_000 });
    touch(path.join(git, 'logs', 'HEAD'), t + 9_000);
    expect(lookAtHead(root)).toEqual({ repo: true, movedAt: t + 9_000 });
  });

  it('walks up from a project below the repository root', () => {
    const t = Date.now() - HOUR;
    fakeRepo(root, t);
    const nested = path.join(root, 'analytics', 'dbt', '.erd-studio');
    fs.mkdirSync(nested, { recursive: true });
    expect(lookAtHead(nested)).toEqual({ repo: true, movedAt: t });
  });

  it('a HEAD that cannot be read, or says nothing git writes, is no readable repository', () => {
    const t = Date.now() - HOUR;
    const git = fakeRepo(root, t, 'garbage\n');
    expect(lookAtHead(root)).toEqual({ repo: false });
    fs.rmSync(path.join(git, 'HEAD'));
    expect(lookAtHead(root)).toEqual({ repo: false });
    // A ref outside refs/ is never followed.
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: ../../etc/passwd\n');
    expect(lookAtHead(root)).toEqual({ repo: false });
  });

  it('a detached HEAD (a commit id) is readable', () => {
    const t = Date.now() - HOUR;
    fakeRepo(root, t, `${'a'.repeat(40)}\n`);
    expect(lookAtHead(root)).toEqual({ repo: true, movedAt: t });
  });

  it('packed refs only: falls back to HEAD and logs/HEAD (packed-refs is rewritten by gc, not by a move)', () => {
    const t = Date.now() - HOUR;
    const git = fakeRepo(root, t);
    fs.rmSync(path.join(git, 'refs', 'heads', 'main'));
    touch(path.join(git, 'packed-refs'), Date.now());
    expect(lookAtHead(root)).toEqual({ repo: true, movedAt: t });
  });

  it('a worktree: .git is a file naming its own git folder, whose commondir holds the refs', () => {
    const t = Date.now() - HOUR;
    const main = path.join(root, 'main');
    const git = fakeRepo(main, t);
    const wtGit = path.join(git, 'worktrees', 'feature');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/feature\n');
    fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
    touch(path.join(wtGit, 'HEAD'), t);
    touch(path.join(git, 'refs', 'heads', 'feature'), t + 7_000);
    // The main checkout's own HEAD moving says nothing about the worktree.
    touch(path.join(git, 'HEAD'), t + 60_000);
    const wt = path.join(root, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
    expect(lookAtHead(wt)).toEqual({ repo: true, movedAt: t + 7_000 });
    // A relative gitdir resolves against the folder holding the .git file.
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.relative(wt, wtGit)}\n`);
    expect(lookAtHead(wt)).toEqual({ repo: true, movedAt: t + 7_000 });
  });

  it('a .git file that names nothing readable is no readable repository (never a repository whose HEAD stood still)', () => {
    fs.writeFileSync(path.join(root, '.git'), 'not a gitdir line\n');
    expect(lookAtHead(root)).toEqual({ repo: false });
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${path.join(root, 'missing')}\n`);
    expect(lookAtHead(root)).toEqual({ repo: false });
  });

  it('a reftable repository: its tables.list moves with every ref update', () => {
    const t = Date.now() - HOUR;
    const git = fakeRepo(root, t, 'ref: refs/heads/.invalid\n');
    fs.rmSync(path.join(git, 'logs'), { recursive: true });
    touch(path.join(git, 'reftable', 'tables.list'), t + 3_000);
    expect(lookAtHead(root)).toEqual({ repo: true, movedAt: t + 3_000 });
  });
});

describe('classifyOutsideChange: the rule', () => {
  const eventAt = 1_000_000_000_000;
  const still: HeadLook = { repo: true, movedAt: eventAt - 5 * 60_000 };

  it('no readable repository → noGit, whatever else is known', () => {
    expect(classifyOutsideChange({ head: { repo: false }, eventAt })).toBe('noGit');
    expect(classifyOutsideChange({ head: { repo: false }, eventAt, handledHereAt: eventAt - 1_000 })).toBe('noGit');
  });

  it('HEAD moved shortly before the change, or after it (git writes the files, then the ref) → git', () => {
    expect(classifyOutsideChange({ head: { repo: true, movedAt: eventAt - 2_000 }, eventAt })).toBe('git');
    expect(classifyOutsideChange({ head: { repo: true, movedAt: eventAt + 1_500 }, eventAt })).toBe('git');
    expect(classifyOutsideChange({ head: { repo: true, movedAt: eventAt - HEAD_MOVE_WINDOW_MS }, eventAt })).toBe('git');
  });

  it('HEAD last moved minutes before the change → a local change, never git (an old pull is not this edit)', () => {
    expect(classifyOutsideChange({ head: still, eventAt })).toBe('disk');
    expect(classifyOutsideChange({ head: { repo: true, movedAt: eventAt - HEAD_MOVE_WINDOW_MS - 1 }, eventAt })).toBe('disk');
  });

  it('this window saved, renamed or deleted the same file just before → editor', () => {
    expect(classifyOutsideChange({ head: still, eventAt, handledHereAt: eventAt - 1_000 })).toBe('editor');
    expect(classifyOutsideChange({ head: still, eventAt, handledHereAt: eventAt - HANDLED_HERE_WINDOW_MS - 1 })).toBe('disk');
    // A save of the file is stronger evidence than a HEAD that moved next to it (save, then commit).
    expect(classifyOutsideChange({ head: { repo: true, movedAt: eventAt + 1_000 }, eventAt, handledHereAt: eventAt - 500 })).toBe('editor');
  });

  it('maps each verdict to a fixed key; a new diagram is Git, Local or NoGit only', () => {
    expect(OUTSIDE_CREATE_FEATURES).toEqual({
      git: 'domainCreatedExternalGit',
      noGit: 'domainCreatedExternalNoGit',
      editor: 'domainCreatedExternalLocal',
      disk: 'domainCreatedExternalLocal',
    });
    expect(OUTSIDE_CHANGE_FEATURES).toEqual({
      git: 'modelChangedExternalGit',
      noGit: 'modelChangedExternalNoGit',
      editor: 'modelChangedExternalEditor',
      disk: 'modelChangedExternalDisk',
    });
  });

  it('the seven keys are appended to FEATURES after #331\'s, and only #332\'s, #333\'s, #347\'s and #364\'s follow them', () => {
    expect(FEATURES.slice(FEATURES.indexOf('diagramTables500Plus') + 1)).toEqual([
      'domainCreatedExternalGit', 'domainCreatedExternalLocal', 'domainCreatedExternalNoGit',
      'modelChangedExternalGit', 'modelChangedExternalNoGit', 'modelChangedExternalEditor', 'modelChangedExternalDisk',
      'sharedModelFirstOpened', 'modelInGit', 'modelNotInGit', 'modelRepoHasRemote',
      'canvasLoadUnder1s', 'canvasLoad1to5s', 'canvasLoad5to20s', 'canvasLoadCold',
      'canvasPaintUnder1s', 'canvasPaint1to5s', 'canvasPaintOver5s',
      // #347: the one shared look at the folder.
      'startLookFromIndex', 'startLookIndexFallback',
      'startLookFoldersUnder200', 'startLookFolders200to2000', 'startLookFoldersOver2000',
      'startLookFoundAfterDeadline', 'dbtSearchFromIndex',
      // #364: what a panel that never said ready met.
      'noReadyHostHeld', 'noReadyClosed30to60s', 'noReadyClosedOver60s',
    ]);
    // The total stays where it was, and is still a 1.x key.
    expect(FEATURES.indexOf('domainCreatedExternal')).toBeLessThan(FEATURES.indexOf('heartbeatProvisional'));
    // The maps use exactly these keys.
    expect(new Set([...Object.values(OUTSIDE_CREATE_FEATURES), ...Object.values(OUTSIDE_CHANGE_FEATURES)]))
      .toEqual(new Set(OUTSIDE_CHANGE_SOURCE_FEATURES));
  });

  it('a day over the size guard keeps them: they are the newest keys, and the trim would take them first', () => {
    const DAY = '2026-11-16';
    const all = Object.fromEntries(FEATURES.map((f) => [f, 1]));
    const s: DailyCounters = { ...emptyCounters(DAY), features: all };
    const env: HeartbeatEnv = {
      installId: '3b241101-e2bb-4255-8caf-4136c566a962', extVersion: '2.0.7', vscodeVersion: '1.104.2', platform: 'darwin', firstSeenDay: '2026-09-01',
    };
    const body = provisionalBody(buildHeartbeat(s, env));
    expect(heartbeatBytes(body)).toBeGreaterThan(HEARTBEAT_SOFT_LIMIT);
    const trimmed = trimHeartbeat(body);
    expect(heartbeatBytes(trimmed)).toBeLessThanOrEqual(HEARTBEAT_SOFT_LIMIT);
    for (const key of OUTSIDE_CHANGE_SOURCE_FEATURES) expect(trimmed.features[key], key).toBe(1);
  });
});

describe('OutsideChangeRecorder: one look per burst, presence keys only', () => {
  function recorder(opts: { head?: HeadLook; enabled?: boolean; restoredAt?: number; look?: () => HeadLook } = {}) {
    const recorded: string[] = [];
    const look = vi.fn(opts.look ?? (() => opts.head ?? { repo: true, movedAt: Date.now() - HOUR }));
    const r = new OutsideChangeRecorder({
      repoFrom: root,
      enabled: () => opts.enabled ?? true,
      record: (f) => recorded.push(f),
      restoredAt: () => opts.restoredAt,
      look,
    });
    return { r, recorded, look };
  }

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });

  it('waits before looking (git updates the ref after it writes the files), then records the key once', async () => {
    const { r, recorded, look } = recorder();
    r.note('change', path.join(root, 'a.yml'));
    await vi.advanceTimersByTimeAsync(LOOK_DELAY_MS - 1);
    expect(look).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(recorded).toEqual(['modelChangedExternalDisk']);
  });

  it('a burst of 1,000 changes reads HEAD once and records each key once', async () => {
    const { r, recorded, look } = recorder();
    for (let i = 0; i < 1000; i++) r.note('change', path.join(root, `t${i}.yml`));
    r.note('create', path.join(root, 'new.json'));
    await vi.advanceTimersByTimeAsync(LOOK_DELAY_MS);
    expect(look).toHaveBeenCalledTimes(1);
    expect(recorded.sort()).toEqual(['domainCreatedExternalLocal', 'modelChangedExternalDisk']);
  });

  it('a file saved in this window is Editor; another file in the same burst is still Disk', async () => {
    const { r, recorded } = recorder();
    r.noteHandledHere(path.join(root, 'saved.yml'));
    await vi.advanceTimersByTimeAsync(300);
    r.note('change', path.join(root, 'saved.yml'));
    await vi.advanceTimersByTimeAsync(LOOK_DELAY_MS);
    expect(recorded).toEqual(['modelChangedExternalEditor']);
    r.note('change', path.join(root, 'other.yml'));
    await vi.advanceTimersByTimeAsync(LOOK_DELAY_MS);
    expect(recorded).toEqual(['modelChangedExternalEditor', 'modelChangedExternalDisk']);
  });

  it('a folder renamed in this window (a layer, in the Explorer) makes the files under it Editor', async () => {
    const { r, recorded } = recorder();
    r.noteHandledHere(path.join(root, 'gold'));
    r.note('change', path.join(root, 'gold', 'tables', 'sales', 'orders.dbml'));
    r.note('change', path.join(root, 'golden', 'x.dbml'));
    await vi.advanceTimersByTimeAsync(LOOK_DELAY_MS);
    expect(recorded.sort()).toEqual(['modelChangedExternalDisk', 'modelChangedExternalEditor']);
  });

  it('HEAD moving during the wait makes the burst Git', async () => {
    let movedAt = Date.now() - HOUR;
    const { r, recorded } = recorder({ look: () => ({ repo: true, movedAt }) });
    r.note('create', path.join(root, 'team.json'));
    r.note('change', path.join(root, 'dim_customer.yml'));
    await vi.advanceTimersByTimeAsync(1_000);
    movedAt = Date.now();
    await vi.advanceTimersByTimeAsync(LOOK_DELAY_MS);
    expect(recorded.sort()).toEqual(['domainCreatedExternalGit', 'modelChangedExternalGit']);
  });

  it('records nothing and reads nothing while telemetry is off', async () => {
    const { r, recorded, look } = recorder({ enabled: false });
    r.noteHandledHere(path.join(root, 'a.yml'));
    r.note('change', path.join(root, 'a.yml'));
    await vi.advanceTimersByTimeAsync(LOOK_DELAY_MS * 2);
    expect(look).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('ERD Studio restoring its own files (an undo of a canvas or of Convert) records nothing', async () => {
    const { r, recorded } = recorder({ restoredAt: Date.now() + 500 });
    r.note('change', path.join(root, 'restored.yml'));
    r.note('create', path.join(root, 'restored.json'));
    await vi.advanceTimersByTimeAsync(LOOK_DELAY_MS);
    expect(recorded).toEqual([]);
    r.noteRestored();
    r.note('change', path.join(root, 'restored.yml'));
    await vi.advanceTimersByTimeAsync(LOOK_DELAY_MS);
    expect(recorded).toEqual([]);
  });

  it('a long restore (Edit > Undo of Convert of a large project) skips its first files too, not only those near its last', async () => {
    const { r, recorded } = recorder();
    // Each batch the watcher reports brings back a converted file (noteRestored) and drops a .dbml;
    // batches arrive under the look's wait apart, so the burst is classified in one flush.
    for (let i = 0; i < 6; i++) {
      r.noteRestored();
      r.note('change', path.join(root, `restored_${i}.yml`));
      r.note('change', path.join(root, `converted_${i}.dbml`));
      await vi.advanceTimersByTimeAsync(LOOK_DELAY_MS - 500);
    }
    await vi.advanceTimersByTimeAsync(LOOK_DELAY_MS);
    expect(recorded).toEqual([]);
  });

  it('a look that throws never escapes, and counts as no readable repository', async () => {
    const { r, recorded } = recorder({ look: () => { throw new Error('EACCES'); } });
    expect(() => r.note('change', path.join(root, 'a.yml'))).not.toThrow();
    await vi.advanceTimersByTimeAsync(LOOK_DELAY_MS);
    expect(recorded).toEqual(['modelChangedExternalNoGit']);
  });

  it('a steady stream of changes is still looked at within the longest wait', async () => {
    const { r, look } = recorder();
    for (let i = 0; i < 40; i++) {
      r.note('change', path.join(root, `t${i}.yml`));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(look.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('dispose drops what is waiting', async () => {
    const { r, recorded, look } = recorder();
    r.note('change', path.join(root, 'a.yml'));
    r.dispose();
    await vi.advanceTimersByTimeAsync(LOOK_DELAY_MS);
    expect(look).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });
});

describe('it only reads files', () => {
  it('never runs git, never asks the Git extension, never imports vscode, and adds no extension dependency', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const source = fs.readFileSync(path.join(repoRoot, 'src/services/outsideChange.ts'), 'utf8');
    expect(source).not.toMatch(/child_process|execFile|spawn\(|from 'vscode'|require\('vscode'\)|vscode\.git/);
    expect(source).not.toMatch(/\b(writeFile|appendFile|mkdir|rm|unlink|rename)Sync\b/);
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { extensionDependencies?: string[] };
    expect(pkg.extensionDependencies ?? []).not.toContain('vscode.git');
  });
});

/** Real git, where installed: the mtimes git itself writes are what the rule reads. */
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe.runIf(hasGit)('with real git', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', HOME: root },
  }).toString();
  /** Age every file under .git by an hour, as if the last git command ran long ago. */
  const ageGitFiles = (dir: string) => {
    const old = Date.now() - HOUR;
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else fs.utimesSync(p, old / 1000, old / 1000);
      }
    };
    walk(path.join(dir, '.git'));
  };
  const verdict = (dir: string, eventAt = Date.now()) => classifyOutsideChange({ head: lookAtHead(dir), eventAt });

  let repo: string;
  beforeEach(() => {
    repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, '.erd-studio', 'tables'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, '.erd-studio', 'tables', 'dim_customer.yml'), 'name: dim_customer\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'checkout', '-q', '-b', 'team');
    fs.writeFileSync(path.join(repo, '.erd-studio', 'tables', 'dim_customer.yml'), 'name: dim_customer\ncolumns: []\n');
    git(repo, 'commit', '-q', '-am', 'team edit');
    git(repo, 'checkout', '-q', 'main');
    ageGitFiles(repo);
  });

  it('a fast-forward merge (what a pull does) is Git, though .git/HEAD still says main', () => {
    const headBefore = fs.readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8');
    git(repo, 'merge', '-q', '--ff-only', 'team');
    expect(fs.readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8')).toBe(headBefore);
    expect(verdict(path.join(repo, '.erd-studio'))).toBe('git');
  });

  it('a branch switch is Git', () => {
    git(repo, 'checkout', '-q', 'team');
    expect(verdict(path.join(repo, '.erd-studio'))).toBe('git');
  });

  it('a file written with no git command (an assistant, a script) is Disk, however long ago HEAD last moved', () => {
    fs.appendFileSync(path.join(repo, '.erd-studio', 'tables', 'dim_customer.yml'), 'description: x\n');
    expect(verdict(path.join(repo, '.erd-studio'))).toBe('disk');
  });

  it('git restore changes a file without moving HEAD: Local (Disk), as the README says', () => {
    fs.appendFileSync(path.join(repo, '.erd-studio', 'tables', 'dim_customer.yml'), 'description: x\n');
    ageGitFiles(repo);
    git(repo, 'restore', '.erd-studio/tables/dim_customer.yml');
    expect(verdict(path.join(repo, '.erd-studio'))).toBe('disk');
  });

  it('git stash pop changes files without moving HEAD: Local (Disk), as the README says', () => {
    fs.appendFileSync(path.join(repo, '.erd-studio', 'tables', 'dim_customer.yml'), 'description: x\n');
    git(repo, 'stash', '-q');
    ageGitFiles(repo);
    git(repo, 'stash', 'pop', '-q');
    expect(verdict(path.join(repo, '.erd-studio'))).toBe('disk');
  });

  it('git stash (the push) resets the files through HEAD and writes its reflog: Git, as the README says', () => {
    fs.appendFileSync(path.join(repo, '.erd-studio', 'tables', 'dim_customer.yml'), 'description: x\n');
    ageGitFiles(repo);
    git(repo, 'stash', '-q');
    expect(verdict(path.join(repo, '.erd-studio'))).toBe('git');
  });

  it('an assistant that commits its own edit moves HEAD: Git, as the README says', () => {
    fs.appendFileSync(path.join(repo, '.erd-studio', 'tables', 'dim_customer.yml'), 'description: x\n');
    const eventAt = Date.now();
    git(repo, 'commit', '-q', '-am', 'assistant edit');
    expect(verdict(path.join(repo, '.erd-studio'), eventAt)).toBe('git');
  });

  it('a linked worktree reads its own HEAD', () => {
    const wt = path.join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, 'team');
    ageGitFiles(repo);
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);
    expect(verdict(wt)).toBe('disk');
    git(wt, 'commit', '-q', '--allow-empty', '-m', 'wt');
    expect(verdict(wt)).toBe('git');
  });
});
