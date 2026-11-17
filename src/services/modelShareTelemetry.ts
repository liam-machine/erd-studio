/**
 * Usage telemetry (#332): whether models are shared. Two answers, as fixed
 * presence flags only (never a name, an email, a path, a URL or a count):
 *
 * - **Arrival** (`sharedModelFirstOpened`): the first time ERD Studio runs in
 *   a workspace on this machine, the project already has a model (diagrams or
 *   tables). Nothing this machine did in ERD Studio made it, so it came with
 *   the folder: a teammate's clone, most of the time. Decided once per
 *   workspace and remembered in `workspaceState`. A workspace where an older
 *   ERD Studio already left state is never an arrival, so upgrading authors
 *   are not counted the week this ships.
 * - **Shareable** (`modelInGit` / `modelNotInGit`, and `modelRepoHasRemote`):
 *   whether the model folder sits in a Git repository and whether that
 *   repository has a remote, once per workspace per UTC day, off the
 *   activation path. The Git extension answers first (only when it is already
 *   running: ERD Studio never activates it); the repository's own files on
 *   disk answer for the repositories it has not opened (a parent folder
 *   waiting on `git.openRepositoryInParentFolders`, automatic detection off,
 *   Git turned off). No answer sends nothing, never "not in Git".
 *
 * Nothing here reads commit authors or a remote's URL: only whether a
 * `[remote "…"]` section exists. Pure apart from reading those few files: no
 * `vscode`, nothing written.
 */

import * as fs from 'fs';
import * as path from 'path';
import { findGitDirs } from './outsideChange';
import type { TelemetryFeature } from './telemetryPayload';

/** workspaceState: this workspace's arrival has been decided (true once ERD Studio has run here). */
export const SHARED_MODEL_DECIDED_KEY = 'erdStudio.telemetry.sharedModelDecided';
/** workspaceState: the UTC day this workspace's model repository was last looked at. */
export const MODEL_REPO_DAY_KEY = 'erdStudio.telemetry.modelRepoDay';
/** Long enough that the look never competes with opening the first diagram (after the physical tooling scan). */
export const MODEL_REPO_DELAY_MS = 20_000;
/** The longest the Git extension is waited for before the files on disk answer alone. */
export const GIT_API_WAIT_MS = 5_000;

/**
 * Whether this activation is an arrival: the project has a model, ERD
 * Studio had never run in this workspace before (no `workspaceState` from an
 * earlier activation, including an older version's), the workspace's answer
 * has not been given already, and the folder is not the one Open an Example
 * Project… just wrote and opened (`openedAsExample`: ERD Studio made that
 * model itself, in a folder new to this machine).
 */
export function isSharedModelArrival(input: { ranHereBefore: boolean; hasModel: boolean; alreadyDecided: boolean; openedAsExample?: boolean }): boolean {
  return input.hasModel && !input.ranHereBefore && !input.alreadyDecided && input.openedAsExample !== true;
}

/** Whether the model folder is in a repository and whether it has a remote (`undefined`: could not be read). */
export interface ModelRepo {
  inRepo: boolean;
  hasRemote: boolean | undefined;
}

/**
 * The Git extension's answer for a folder: a repository it has open (and
 * whether it lists a remote), none open, or no answer (not running, turned
 * off, not ready in time).
 */
export type GitApiAnswer = { repo: true; hasRemote: boolean } | { repo: false } | undefined;

/** The fixed keys for an answer; none for no answer. */
export function modelRepoFeatures(repo: ModelRepo | undefined): TelemetryFeature[] {
  if (!repo) return [];
  if (!repo.inRepo) return ['modelNotInGit'];
  return repo.hasRemote === true ? ['modelInGit', 'modelRepoHasRemote'] : ['modelInGit'];
}

/**
 * Whether a repository's config names a remote: a `[remote "…"]` section
 * (in any case: git reads section names case-insensitively). Only the
 * section's presence is read, never its URL. `undefined` when the config
 * cannot be read.
 */
export function configHasRemote(commonDir: string): boolean | undefined {
  let text: string;
  try { text = fs.readFileSync(path.join(commonDir, 'config'), 'utf8'); } catch { return undefined; }
  return /^\s*\[remote\s+"/im.test(text);
}

/**
 * What the files on disk say about `dir`: the `.git` above it, walking up as
 * git does (`findGitDirs`, shared with #329's outside-change look; a linked
 * worktree's or submodule's `.git` file is followed to the folder holding
 * its config). A `.git` that cannot be followed is still a repository whose
 * remote is unknown.
 */
export function modelRepoOnDisk(dir: string): ModelRepo {
  const found = findGitDirs(dir);
  if (found === 'none') return { inRepo: false, hasRemote: undefined };
  if (found === 'unreadable') return { inRepo: true, hasRemote: undefined };
  return { inRepo: true, hasRemote: configHasRemote(found.commonDir) };
}

/** `promise`'s value, or `undefined` once `ms` pass first (the timer never holds the process open). */
function withinMs<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Whether the model folder `dir` is in a repository, and whether that has a
 * remote. The Git extension is asked first, for at most `waitMs`; a
 * repository it has open with a remote settles it. Otherwise the files on
 * disk decide (they also find the repositories the extension has not
 * opened), and a remote either one sees counts. `undefined` when neither can
 * answer. Never throws.
 */
export async function detectModelRepo(
  dir: string,
  deps: { askGit: (dir: string) => Promise<GitApiAnswer>; onDisk?: (dir: string) => ModelRepo; waitMs?: number },
): Promise<ModelRepo | undefined> {
  let api: GitApiAnswer;
  try {
    api = await withinMs(deps.askGit(dir), deps.waitMs ?? GIT_API_WAIT_MS);
  } catch {
    api = undefined;
  }
  if (api?.repo && api.hasRemote) return { inRepo: true, hasRemote: true };
  let disk: ModelRepo | undefined;
  try {
    disk = (deps.onDisk ?? modelRepoOnDisk)(dir);
  } catch {
    disk = undefined;
  }
  if (api?.repo) return { inRepo: true, hasRemote: disk?.hasRemote === true };
  return disk;
}

/** Whether today's look is due: telemetry on, a model folder to look at, and not looked at yet today (UTC). */
export function modelRepoCheckDue(input: { enabled: boolean; folderExists: boolean; lastDay: string | undefined; today: string }): boolean {
  return input.enabled && input.folderExists && input.lastDay !== input.today;
}
