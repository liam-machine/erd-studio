/**
 * #332: whether models are shared, as fixed presence keys.
 *
 * - `sharedModelFirstOpened` (the arrival): the first time ERD Studio runs in
 *   a workspace on this machine, the project already has a model. Not tied to
 *   the machine's first run (`firstRunHasDiagrams` is), and never fired for a
 *   workspace where an older ERD Studio already left state (an upgrading
 *   author).
 * - `modelInGit` / `modelNotInGit` / `modelRepoHasRemote`: whether the model
 *   folder is in a repository and whether that has a remote. The Git
 *   extension answers first; the repository's files on disk answer for the
 *   repositories it has not opened. No answer sends nothing, never "not in
 *   Git", and nothing about a remote but whether one exists leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  MODEL_REPO_DAY_KEY,
  SHARED_MODEL_DECIDED_KEY,
  detectModelRepo,
  isSharedModelArrival,
  modelRepoCheckDue,
  modelRepoFeatures,
  modelRepoOnDisk,
  type GitApiAnswer,
} from '../../src/services/modelShareTelemetry';
import { askGitExtension } from '../../src/services/gitExtensionApi';
import {
  FEATURES,
  HEARTBEAT_SOFT_LIMIT,
  MODEL_SHARE_FEATURES,
  buildHeartbeat,
  emptyCounters,
  heartbeatBytes,
  provisionalBody,
  recordFeatureOnce,
  trimHeartbeat,
  type DailyCounters,
  type HeartbeatEnv,
} from '../../src/services/telemetryPayload';

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erd-share-'))); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A project folder with a model folder inside; returns the model folder. */
function project(name = 'proj'): string {
  const dir = path.join(root, name, '.erd-studio');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const noGit = async (): Promise<GitApiAnswer> => undefined;
const DAY = '2026-11-16';
const ENV: HeartbeatEnv = {
  installId: '3b241101-e2bb-4255-8caf-4136c566a962', extVersion: '2.0.7', vscodeVersion: '1.104.2', platform: 'darwin', firstSeenDay: '2026-09-01',
};

describe('the arrival (sharedModelFirstOpened)', () => {
  it('is the first ERD Studio activation in a workspace that already has a model', () => {
    expect(isSharedModelArrival({ ranHereBefore: false, hasModel: true, alreadyDecided: false })).toBe(true);
  });

  it('is not a workspace where ERD Studio already left state (an author upgrading from an older version)', () => {
    expect(isSharedModelArrival({ ranHereBefore: true, hasModel: true, alreadyDecided: false })).toBe(false);
  });

  it('is not a workspace with no model yet, nor one already decided', () => {
    expect(isSharedModelArrival({ ranHereBefore: false, hasModel: false, alreadyDecided: false })).toBe(false);
    expect(isSharedModelArrival({ ranHereBefore: false, hasModel: true, alreadyDecided: true })).toBe(false);
  });

  it('is not the folder Open an Example Project… just wrote and opened', () => {
    expect(isSharedModelArrival({ ranHereBefore: false, hasModel: true, alreadyDecided: false, openedAsExample: true })).toBe(false);
  });

  it('keeps its state under the erdStudio prefix', () => {
    expect(SHARED_MODEL_DECIDED_KEY.startsWith('erdStudio.')).toBe(true);
    expect(MODEL_REPO_DAY_KEY.startsWith('erdStudio.')).toBe(true);
  });
});

describe('the model repository keys', () => {
  it('maps each answer to fixed keys, and no answer to none', () => {
    expect(modelRepoFeatures({ inRepo: true, hasRemote: true })).toEqual(['modelInGit', 'modelRepoHasRemote']);
    expect(modelRepoFeatures({ inRepo: true, hasRemote: false })).toEqual(['modelInGit']);
    expect(modelRepoFeatures({ inRepo: true, hasRemote: undefined })).toEqual(['modelInGit']);
    expect(modelRepoFeatures({ inRepo: false, hasRemote: undefined })).toEqual(['modelNotInGit']);
    expect(modelRepoFeatures(undefined)).toEqual([]);
  });

  it('are telemetry features, appended after #329 in order, and no commit-author key exists', () => {
    const at = FEATURES.indexOf('modelChangedExternalDisk');
    expect(FEATURES.slice(at + 1, at + 5)).toEqual(['sharedModelFirstOpened', 'modelInGit', 'modelNotInGit', 'modelRepoHasRemote']);
    expect(FEATURES.filter((f) => f.startsWith('modelAuthors'))).toEqual([]);
  });

  it('is due once per UTC day, only with telemetry on and a model folder to look at', () => {
    const today = '2026-11-16';
    expect(modelRepoCheckDue({ enabled: true, folderExists: true, lastDay: undefined, today })).toBe(true);
    expect(modelRepoCheckDue({ enabled: true, folderExists: true, lastDay: '2026-11-15', today })).toBe(true);
    expect(modelRepoCheckDue({ enabled: true, folderExists: true, lastDay: today, today })).toBe(false);
    expect(modelRepoCheckDue({ enabled: false, folderExists: true, lastDay: undefined, today })).toBe(false);
    expect(modelRepoCheckDue({ enabled: true, folderExists: false, lastDay: undefined, today })).toBe(false);
  });
});

describe('the files on disk', () => {
  it('a model folder in a repository with a remote (git init + git remote add)', () => {
    const model = project();
    execFileSync('git', ['init', '-q'], { cwd: path.dirname(model) });
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/team/secret-repo.git'], { cwd: path.dirname(model) });
    expect(modelRepoOnDisk(model)).toEqual({ inRepo: true, hasRemote: true });
  });

  it('a repository with no remote, and a folder in none', () => {
    const inRepo = project('a');
    execFileSync('git', ['init', '-q'], { cwd: path.dirname(inRepo) });
    expect(modelRepoOnDisk(inRepo)).toEqual({ inRepo: true, hasRemote: false });
    expect(modelRepoOnDisk(project('b'))).toEqual({ inRepo: false, hasRemote: undefined });
  });

  it('a repository in a parent folder (the dbt project is a sub-folder of its repo)', () => {
    const model = project(path.join('repo', 'analytics', 'dbt'));
    fs.mkdirSync(path.join(root, 'repo', '.git'));
    fs.writeFileSync(path.join(root, 'repo', '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = x\n');
    expect(modelRepoOnDisk(model)).toEqual({ inRepo: true, hasRemote: true });
  });

  it('a linked worktree: the .git file is followed to commondir, where the config is', () => {
    const common = path.join(root, 'main', '.git');
    const wtGit = path.join(common, 'worktrees', 'feature');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(common, 'config'), '[remote "upstream"]\n\turl = x\n');
    fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
    const model = project('feature');
    fs.writeFileSync(path.join(root, 'feature', '.git'), `gitdir: ${wtGit}\n`);
    expect(modelRepoOnDisk(model)).toEqual({ inRepo: true, hasRemote: true });
  });

  it('a .git that cannot be followed is a repository whose remote is unknown (modelInGit only)', () => {
    const model = project();
    fs.writeFileSync(path.join(root, 'proj', '.git'), 'not a gitdir line\n');
    expect(modelRepoOnDisk(model)).toEqual({ inRepo: true, hasRemote: undefined });
    expect(modelRepoFeatures(modelRepoOnDisk(model))).toEqual(['modelInGit']);
  });
});

describe('detectModelRepo: the Git extension first, the files on disk for what it has not opened', () => {
  it('a repository the extension has open with a remote settles it without reading the disk', async () => {
    const onDisk = vi.fn();
    expect(await detectModelRepo('/m', { askGit: async () => ({ repo: true, hasRemote: true }), onDisk }))
      .toEqual({ inRepo: true, hasRemote: true });
    expect(onDisk).not.toHaveBeenCalled();
  });

  it('a repository the extension has open with no remote listed: the config on disk may still name one', async () => {
    const ask = async (): Promise<GitApiAnswer> => ({ repo: true, hasRemote: false });
    expect(await detectModelRepo('/m', { askGit: ask, onDisk: () => ({ inRepo: true, hasRemote: false }) })).toEqual({ inRepo: true, hasRemote: false });
    expect(await detectModelRepo('/m', { askGit: ask, onDisk: () => ({ inRepo: true, hasRemote: true }) })).toEqual({ inRepo: true, hasRemote: true });
    expect(await detectModelRepo('/m', { askGit: ask, onDisk: () => { throw new Error('EACCES'); } })).toEqual({ inRepo: true, hasRemote: false });
  });

  it('no repository open in the extension (a parent-folder repo it was never allowed to open) is not "not in Git"', async () => {
    const model = project(path.join('repo', 'dbt'));
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'repo') });
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/x.git'], { cwd: path.join(root, 'repo') });
    const features = modelRepoFeatures(await detectModelRepo(model, { askGit: async () => ({ repo: false }) }));
    expect(features).toEqual(['modelInGit', 'modelRepoHasRemote']);
  });

  it('Git turned off, missing or throwing: the disk answers; a folder in no repository is modelNotInGit', async () => {
    const model = project();
    expect(modelRepoFeatures(await detectModelRepo(model, { askGit: noGit }))).toEqual(['modelNotInGit']);
    const throwing = async (): Promise<GitApiAnswer> => { throw new Error('git not found'); };
    expect(modelRepoFeatures(await detectModelRepo(model, { askGit: throwing }))).toEqual(['modelNotInGit']);
  });

  it('an extension that never answers is waited for only waitMs', async () => {
    const model = project();
    execFileSync('git', ['init', '-q'], { cwd: path.dirname(model) });
    const never = (): Promise<GitApiAnswer> => new Promise(() => {});
    const started = Date.now();
    expect(modelRepoFeatures(await detectModelRepo(model, { askGit: never, waitMs: 50 }))).toEqual(['modelInGit']);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('neither can answer: nothing is sent (never modelNotInGit)', async () => {
    const unreadable = () => { throw new Error('EPERM'); };
    expect(modelRepoFeatures(await detectModelRepo('/m', { askGit: noGit, onDisk: unreadable }))).toEqual([]);
  });

  it('no remote URL, path or name reaches the heartbeat', async () => {
    const model = project('acme-private-model');
    execFileSync('git', ['init', '-q'], { cwd: path.dirname(model) });
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/acme/secret-repo.git'], { cwd: path.dirname(model) });
    let counters = emptyCounters(DAY);
    for (const key of modelRepoFeatures(await detectModelRepo(model, { askGit: noGit }))) counters = recordFeatureOnce(counters, key);
    counters = recordFeatureOnce(counters, 'sharedModelFirstOpened');
    const body = JSON.stringify(buildHeartbeat(counters, ENV));
    expect(body).toContain('"modelInGit"');
    expect(body).toContain('"modelRepoHasRemote"');
    expect(body).toContain('"sharedModelFirstOpened"');
    for (const leak of ['example.invalid', 'secret-repo', 'acme', 'origin', root]) expect(body, leak).not.toContain(leak);
  });
});

describe('the size guard', () => {
  it('an oversized day keeps all four: they are among the newest keys, which the trim would take first', () => {
    const all = Object.fromEntries(FEATURES.map((f) => [f, 1]));
    const s: DailyCounters = { ...emptyCounters(DAY), features: all };
    const body = provisionalBody(buildHeartbeat(s, ENV));
    expect(heartbeatBytes(body)).toBeGreaterThan(HEARTBEAT_SOFT_LIMIT);
    const trimmed = trimHeartbeat(body);
    expect(heartbeatBytes(trimmed)).toBeLessThanOrEqual(HEARTBEAT_SOFT_LIMIT);
    expect([...MODEL_SHARE_FEATURES]).toEqual(['sharedModelFirstOpened', 'modelInGit', 'modelNotInGit', 'modelRepoHasRemote']);
    for (const key of MODEL_SHARE_FEATURES) expect(trimmed.features[key], key).toBe(1);
  });
});

describe('askGitExtension (the built-in Git extension, typed by the members used)', () => {
  function gitExtension(api: unknown, opts: { isActive?: boolean; enabled?: boolean } = {}) {
    const activate = vi.fn(async () => ({}));
    vi.spyOn(vscode.extensions, 'getExtension').mockImplementation(((id: string) => (id === 'vscode.git'
      ? { id, isActive: opts.isActive ?? true, packageJSON: {}, activate, exports: { enabled: opts.enabled ?? true, getAPI: () => api } }
      : undefined)) as never);
    return { activate };
  }

  function api(state: 'uninitialized' | 'initialized', repo: unknown) {
    const listeners: Array<(s: string) => void> = [];
    return {
      state,
      onDidChangeState: (l: (s: string) => void) => { listeners.push(l); return { dispose: () => { listeners.splice(listeners.indexOf(l), 1); } }; },
      getRepository: vi.fn(() => repo),
      fire: (s: string) => { for (const l of [...listeners]) l(s); },
      listeners,
    };
  }

  it('a repository with a remote: only whether one exists (never its URL)', async () => {
    gitExtension(api('initialized', { state: { remotes: [{ name: 'origin', fetchUrl: 'https://example.invalid/secret.git' }] } }));
    expect(await askGitExtension('/w/.erd-studio', 100)).toEqual({ repo: true, hasRemote: true });
  });

  it('a repository with none, and no repository open', async () => {
    gitExtension(api('initialized', { state: { remotes: [] } }));
    expect(await askGitExtension('/w/.erd-studio', 100)).toEqual({ repo: true, hasRemote: false });
    vi.restoreAllMocks();
    gitExtension(api('initialized', null));
    expect(await askGitExtension('/w/.erd-studio', 100)).toEqual({ repo: false });
  });

  it('waits for the extension to finish its start-up, then asks', async () => {
    const a = api('uninitialized', { state: { remotes: [1] } });
    gitExtension(a);
    const answer = askGitExtension('/w/.erd-studio', 1_000);
    setTimeout(() => a.fire('initialized'), 20);
    expect(await answer).toEqual({ repo: true, hasRemote: true });
    expect(a.listeners).toHaveLength(0);
  });

  it('a start-up that never finishes is no answer, and the listener is let go', async () => {
    const a = api('uninitialized', { state: { remotes: [1] } });
    gitExtension(a);
    expect(await askGitExtension('/w/.erd-studio', 30)).toBeUndefined();
    expect(a.getRepository).not.toHaveBeenCalled();
    expect(a.listeners).toHaveLength(0);
  });

  it('missing, not running (never activated by ERD Studio), or turned off: no answer', async () => {
    vi.spyOn(vscode.extensions, 'getExtension').mockReturnValue(undefined as never);
    expect(await askGitExtension('/w', 30)).toBeUndefined();
    vi.restoreAllMocks();
    const { activate } = gitExtension(api('initialized', null), { isActive: false });
    expect(await askGitExtension('/w', 30)).toBeUndefined();
    expect(activate).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    gitExtension(api('initialized', null), { enabled: false });
    expect(await askGitExtension('/w', 30)).toBeUndefined();
  });

  it('an API that throws is no answer', async () => {
    vi.spyOn(vscode.extensions, 'getExtension').mockImplementation((() => ({
      isActive: true, exports: { getAPI: () => { throw new Error('No API'); } },
    })) as never);
    expect(await askGitExtension('/w', 30)).toBeUndefined();
  });
});
