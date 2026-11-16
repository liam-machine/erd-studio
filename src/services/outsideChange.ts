/**
 * Usage telemetry (#329): where a change to the model that ERD Studio did not
 * write came from. The watcher has already dropped ERD Studio's own writes;
 * what is left is an AI assistant, a hand edit, a script or git, and the
 * existing `domainCreatedExternal` total cannot tell them apart.
 *
 * - **git**: the repository's HEAD moved with the change (a pull, checkout,
 *   merge, rebase or reset; also a commit, so an assistant that commits its
 *   own work counts here).
 * - **editor**: this window saved, renamed or deleted the file just before
 *   (a hand edit, or an assistant working inside the editor).
 * - **disk**: neither: the bytes changed on disk with no save here (an
 *   assistant or a script in a terminal, another program, another window;
 *   also `git stash pop` or `git restore`, which change files and leave
 *   HEAD where it was).
 * - **noGit**: the workspace has no repository, or its HEAD could not be
 *   read, so git cannot be told from a local change.
 *
 * HEAD is read from the repository's own files: never by running git (on a
 * Mac without the command-line tools that opens an install dialog) and never
 * through the Git extension (activating it costs, it may be turned off, and
 * its state can update after the watcher's debounce). When HEAD last moved is
 * the newest mtime of `HEAD`, `logs/HEAD` and the loose ref HEAD names, so a
 * fast-forward pull counts though `.git/HEAD` still says `ref:
 * refs/heads/main`, and a pull hours before an edit never makes that edit Git.
 * git writes the files first and moves the ref last, so the look waits a
 * moment ({@link LOOK_DELAY_MS}) and HEAD may have moved after the change.
 *
 * Pure apart from reading those few files: no `vscode`, nothing written, and
 * only fixed keys leave it (never a path, a name or a count).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TelemetryFeature } from './telemetryPayload';

/** Where a change ERD Studio did not write came from (see the module comment). */
export type OutsideChangeSource = 'git' | 'noGit' | 'editor' | 'disk';

/** A diagram file that appeared, or an existing table, relationships or diagram file that changed (or went). */
export type OutsideChangeKind = 'create' | 'change';

/** HEAD that moved this long before a change, or any time after it, moved with it. */
export const HEAD_MOVE_WINDOW_MS = 30_000;
/** A file this window saved, renamed or deleted this long before the change is the editor's. */
export const HANDLED_HERE_WINDOW_MS = 10_000;
/** A change this close to ERD Studio restoring its own files (an undo) is not counted at all. */
export const OWN_RESTORE_WINDOW_MS = 10_000;
/** How long after the last change of a burst HEAD is looked at: git moves the ref after it writes the files. */
export const LOOK_DELAY_MS = 3_000;
/** A steady stream of changes is still looked at this long after its first. */
export const MAX_LOOK_WAIT_MS = 30_000;

/** A diagram file that appeared: the editor and the disk are both Local (`domainCreatedExternal` stays the total). */
export const OUTSIDE_CREATE_FEATURES: Readonly<Record<OutsideChangeSource, TelemetryFeature>> = {
  git: 'domainCreatedExternalGit',
  noGit: 'domainCreatedExternalNoGit',
  editor: 'domainCreatedExternalLocal',
  disk: 'domainCreatedExternalLocal',
};

/** An existing table, relationships or diagram file that changed or went. */
export const OUTSIDE_CHANGE_FEATURES: Readonly<Record<OutsideChangeSource, TelemetryFeature>> = {
  git: 'modelChangedExternalGit',
  noGit: 'modelChangedExternalNoGit',
  editor: 'modelChangedExternalEditor',
  disk: 'modelChangedExternalDisk',
};

/** What the repository's files say: none readable, or when HEAD last moved (ms since the epoch). */
export type HeadLook = { repo: false } | { repo: true; movedAt: number };

/** A symbolic HEAD git writes: a ref under refs/, never anything that climbs out of the git folder. */
const SYMBOLIC_HEAD = /^ref: (refs\/[^\s\\]+)$/;
/** A detached HEAD: a SHA-1 or SHA-256 commit id. */
const DETACHED_HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function mtimeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * The git folder for `startDir` and the folder holding its refs, walking up
 * as git does: `.git` is a folder, or a file naming one (`gitdir: …`, a
 * linked worktree or a submodule) whose `commondir` holds the refs.
 * `'none'` when no `.git` is above; `'unreadable'` when one is but cannot be
 * followed.
 */
export function findGitDirs(startDir: string): { gitDir: string; commonDir: string } | 'none' | 'unreadable' {
  let dir = path.resolve(startDir);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let stat: fs.Stats | undefined;
    try { stat = fs.statSync(dotGit); } catch { stat = undefined; }
    if (stat) {
      let gitDir = dotGit;
      if (stat.isFile()) {
        let text: string;
        try { text = fs.readFileSync(dotGit, 'utf8'); } catch { return 'unreadable'; }
        const named = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
        if (!named) return 'unreadable';
        gitDir = path.resolve(dir, named);
      } else if (!stat.isDirectory()) {
        return 'unreadable';
      }
      let commonDir = gitDir;
      try {
        const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
        if (common) commonDir = path.resolve(gitDir, common);
      } catch { /* no commondir: the refs are in the git folder itself */ }
      return { gitDir, commonDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return 'none';
    dir = parent;
  }
}

/**
 * When the HEAD of the repository holding `startDir` last moved: the newest
 * mtime of `HEAD`, `logs/HEAD` (the per-worktree reflog, which every move
 * appends to), the loose ref HEAD names, and a reftable repository's
 * `tables.list`. `packed-refs` is left out: `git gc` rewrites it without a
 * move. (`git gc` and `git reflog expire` also rewrite `logs/HEAD`, so a
 * change just after one reads as git; the telemetry README lists it as a
 * limit.) No repository, or a HEAD that is not something git writes, is
 * `{ repo: false }`.
 */
export function lookAtHead(startDir: string): HeadLook {
  const found = findGitDirs(startDir);
  if (found === 'none' || found === 'unreadable') return { repo: false };
  const { gitDir, commonDir } = found;
  let head: string;
  try { head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(); } catch { return { repo: false }; }
  const ref = SYMBOLIC_HEAD.exec(head)?.[1];
  if (ref === undefined && !DETACHED_HEAD.test(head)) return { repo: false };
  if (ref !== undefined && ref.split('/').some((segment) => segment === '..' || segment === '')) return { repo: false };
  const times = [
    path.join(gitDir, 'HEAD'),
    path.join(gitDir, 'logs', 'HEAD'),
    ...(ref !== undefined ? [path.join(commonDir, ...ref.split('/'))] : []),
    path.join(commonDir, 'reftable', 'tables.list'),
  ].map(mtimeOf).filter((t): t is number => t !== undefined);
  return { repo: true, movedAt: Math.max(...times) };
}

/**
 * The rule. No readable repository → noGit. A file this window saved,
 * renamed or deleted just before → editor (stronger evidence than a HEAD
 * that moved next to it: a save, then a commit). HEAD moved from
 * {@link HEAD_MOVE_WINDOW_MS} before the change onwards → git. Otherwise
 * disk.
 */
export function classifyOutsideChange(input: { head: HeadLook; eventAt: number; handledHereAt?: number }): OutsideChangeSource {
  const { head, eventAt, handledHereAt } = input;
  if (!head.repo) return 'noGit';
  if (handledHereAt !== undefined && handledHereAt >= eventAt - HANDLED_HERE_WINDOW_MS) return 'editor';
  if (head.movedAt >= eventAt - HEAD_MOVE_WINDOW_MS) return 'git';
  return 'disk';
}

export interface OutsideChangeRecorderOptions {
  /** Where the repository is looked for (the ERD folder: every watched file is under it). */
  readonly repoFrom: string;
  /** Telemetry is on: while it is off nothing is kept and no git file is read. */
  enabled(): boolean;
  /** Record one presence key (once a day, off the onboarding trail). */
  record(feature: TelemetryFeature): void;
  /** When ERD Studio last restored files itself (a canvas's undo or redo), if it has. */
  restoredAt?(): number | undefined;
  /** Tests: the look. */
  look?(startDir: string): HeadLook;
}

interface PendingChange {
  readonly kind: OutsideChangeKind;
  readonly key: string;
  readonly eventAt: number;
}

/**
 * Collects the outside changes of a burst and classifies them together,
 * {@link LOOK_DELAY_MS} after the last: one look at HEAD however many files
 * changed, each key recorded once. Never throws to its caller (a watcher
 * refresh), and reads nothing while telemetry is off.
 */
export class OutsideChangeRecorder {
  private pending: PendingChange[] = [];
  private readonly handledHere = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstPendingAt = 0;
  /** When ERD Studio restored its own files, each time within reach of a change still waiting (a long restore notes many). */
  private ownRestoresAt: number[] = [];

  constructor(private readonly options: OutsideChangeRecorderOptions) {}

  private static key(fsPath: string): string {
    return path.normalize(path.resolve(fsPath));
  }

  /** This window saved, renamed or deleted `fsPath` (not ERD Studio's own save). */
  noteHandledHere(fsPath: string): void {
    try {
      if (!this.options.enabled()) return;
      const now = Date.now();
      for (const [key, at] of this.handledHere) if (now - at > HANDLED_HERE_WINDOW_MS) this.handledHere.delete(key);
      this.handledHere.set(OutsideChangeRecorder.key(fsPath), now);
    } catch { /* telemetry must never break a save */ }
  }

  /** ERD Studio is restoring files of its own (Edit > Undo of Convert brought one back): the changes around now are not counted. */
  noteRestored(): void {
    const now = Date.now();
    // Kept as long as a waiting change could still be near it: a later
    // restore must not replace one the first files of the burst were near.
    const keepFrom = now - OWN_RESTORE_WINDOW_MS - MAX_LOOK_WAIT_MS;
    this.ownRestoresAt = this.ownRestoresAt.filter((at) => at >= keepFrom);
    this.ownRestoresAt.push(now);
  }

  /** An outside change to `fsPath`, as the watcher reported it. */
  note(kind: OutsideChangeKind, fsPath: string): void {
    try {
      if (!this.options.enabled()) return;
      const now = Date.now();
      if (this.pending.length === 0) this.firstPendingAt = now;
      this.pending.push({ kind, key: OutsideChangeRecorder.key(fsPath), eventAt: now });
      if (this.timer !== undefined) clearTimeout(this.timer);
      const wait = Math.max(0, Math.min(LOOK_DELAY_MS, this.firstPendingAt + MAX_LOOK_WAIT_MS - now));
      this.timer = setTimeout(() => this.flush(), wait);
    } catch { /* telemetry must never break a refresh */ }
  }

  private flush(): void {
    this.timer = undefined;
    const batch = this.pending;
    this.pending = [];
    try {
      if (batch.length === 0 || !this.options.enabled()) return;
      const restored = [...this.ownRestoresAt, this.options.restoredAt?.()].filter((t): t is number => t !== undefined);
      const counted = batch.filter((c) => !restored.some((at) => Math.abs(c.eventAt - at) <= OWN_RESTORE_WINDOW_MS));
      if (counted.length === 0) return;
      let head: HeadLook;
      try {
        head = (this.options.look ?? lookAtHead)(this.options.repoFrom);
      } catch {
        head = { repo: false };
      }
      const keys = new Set<TelemetryFeature>();
      for (const change of counted) {
        const source = classifyOutsideChange({ head, eventAt: change.eventAt, handledHereAt: this.handledHereAt(change.key) });
        keys.add((change.kind === 'create' ? OUTSIDE_CREATE_FEATURES : OUTSIDE_CHANGE_FEATURES)[source]);
      }
      for (const key of keys) this.options.record(key);
    } catch { /* telemetry must never break a refresh */ }
  }

  /** When this window last saved, renamed or deleted `key`, or a folder holding it (a layer folder renamed in the Explorer). */
  private handledHereAt(key: string): number | undefined {
    let latest = this.handledHere.get(key);
    for (const [handled, at] of this.handledHere) {
      if (key.startsWith(handled + path.sep) && (latest === undefined || at > latest)) latest = at;
    }
    return latest;
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.handledHere.clear();
    this.ownRestoresAt = [];
  }
}
