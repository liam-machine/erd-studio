/**
 * What the sidebar says while activation looks through the open folders, and
 * after a look that stopped before it had been everywhere (#357).
 *
 * Activation waits on one look per open folder (`folderLook.ts`): the walk
 * that finds the project to open. On a slow disk or a very large folder that
 * is many seconds, and the walk gives up at a limit. The glass sidebar's
 * Diagrams section says so while it runs (what it is doing, how far it has
 * got, how long until it stops by itself) and, when it stopped early, offers
 * **Look for Longer**.
 *
 * Wording only, and the two decisions the wording hangs on. Pure and
 * vscode-free; `extension.ts` runs the looks and hands the status to the
 * sidebar (`GlassSidebarProvider.setSectionStatus`).
 *
 * A folder with no `dbt_project.yml` shows no dbt word (the wording rules in
 * `docs/dev/onboarding-and-cli.md`): while the look runs nobody knows yet, so
 * the looking text never says dbt, and a stopped look says "a project" unless
 * the window opened a dbt project.
 */

import type { DbtSearchStats } from './folderLook';

/** A status block of a sidebar section (structurally `GlassSectionStatus`, `glassSidebar/protocol.ts`). */
export interface LookStatus {
  title: string;
  detail?: string;
  working?: boolean;
  countdown?: { msLeft: number; text: string };
  actions?: string[];
}

export const LOOK_LONGER_BUTTON = 'Look for Longer';
export const LOOK_STOP_BUTTON = 'Stop Looking';
export const LOOK_DISMISS_BUTTON = 'Dismiss';
/** The command's own title (`erdStudio.selectDbtProject` in package.json). */
export const LOOK_SELECT_PROJECT_BUTTON = 'Select dbt Project…';

/** The status shows only for a look still running after this long: a look that answers at once never flashes text. */
export const LOOK_STATUS_DELAY_MS = 1000;
/** How often the folders counted and the time left are read again while a look runs. */
export const LOOK_STATUS_EVERY_MS = 1000;

/** `{time}` in a countdown's text is replaced by the page with the time left, counted down each second. */
const COUNTDOWN_TEXT = 'Stops in {time} if it has not finished.';

/** What a look that stopped early was like, summed over the open folders. */
export interface LookOutcome {
  /** Folders listed, in all. */
  folders: number;
  /** Some folder's search was not complete. */
  stoppedEarly: boolean;
  /** Why (time wins when both happened: it is what the user waited for). */
  stopped: 'time' | 'folders' | undefined;
  /** The longest a look was allowed to walk, in milliseconds. */
  maxMs: number;
}

/** The looks of every open folder as one outcome. */
export function lookOutcome(stats: readonly DbtSearchStats[]): LookOutcome {
  const early = stats.filter((s) => !s.complete);
  return {
    folders: stats.reduce((sum, s) => sum + s.folders, 0),
    stoppedEarly: early.length > 0,
    stopped: early.length === 0 ? undefined : early.some((s) => s.stopped === 'time') ? 'time' : 'folders',
    maxMs: stats.reduce((most, s) => Math.max(most, s.maxMs), 0),
  };
}

/**
 * Whether a look that stopped early may have missed a project: only when the
 * host's own search (`workspace.findFiles`, every depth) did not answer
 * either. When it answered, every `dbt_project.yml` is known whatever the
 * walk reached, and there is nothing to look longer for.
 */
export function lookMayHaveMissed(outcome: LookOutcome, hostSearchAnswered: boolean): boolean {
  return outcome.stoppedEarly && !hostSearchAnswered;
}

/** `1 folder`, `1,240 folders`. */
export function folderCount(n: number): string {
  const whole = Math.max(0, Math.floor(n));
  return `${whole.toLocaleString('en-US')} ${whole === 1 ? 'folder' : 'folders'}`;
}

/** A time limit in words: `45 seconds`, `1 minute`, `90 seconds`, `5 minutes`. Whole units, rounded. */
export function spokenDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 120 && seconds % 60 !== 0) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** The open folders by name: `shop`, `shop and data`, `3 folders`. */
export function lookedThrough(folderNames: readonly string[]): string {
  if (folderNames.length === 1) return folderNames[0];
  if (folderNames.length === 2) return `${folderNames[0]} and ${folderNames[1]}`;
  return folderNames.length === 0 ? 'the folder' : `${folderNames.length} folders`;
}

/** A look that is running: what, how far, and how long until it stops by itself. */
export function lookingStatus(options: {
  folderNames: readonly string[];
  folders: number;
  /** The most folders the look lists before it stops (so a stop at that number is no surprise). */
  maxFolders?: number;
  msLeft: number | undefined;
  canStop?: boolean;
}): LookStatus {
  const most = options.maxFolders !== undefined && Number.isFinite(options.maxFolders) ? `, of ${Math.floor(options.maxFolders).toLocaleString('en-US')} at most` : '';
  return {
    title: `Looking through ${lookedThrough(options.folderNames)}…`,
    ...(options.folders > 0 ? { detail: `${folderCount(options.folders)} checked so far${most}.` } : {}),
    working: true,
    ...(options.msLeft !== undefined ? { countdown: { msLeft: Math.max(0, Math.round(options.msLeft)), text: COUNTDOWN_TEXT } } : {}),
    ...(options.canStop ? { actions: [LOOK_STOP_BUTTON] } : {}),
  };
}

/** A look that stopped at a limit with folders left: what it did, and the way to look further. */
export function stoppedStatus(options: {
  folderNames: readonly string[];
  outcome: LookOutcome;
  /** The folder the window opened, by name. */
  opened: string;
  /** The window opened a dbt project (only then may the text say dbt). */
  hasDbt: boolean;
  /** This look was itself a longer one. */
  again?: boolean;
}): LookStatus {
  const { outcome } = options;
  const where = lookedThrough(options.folderNames);
  const title = outcome.stopped === 'time'
    ? `Stopped looking after ${spokenDuration(outcome.maxMs)}.`
    : `Stopped looking after ${folderCount(outcome.folders)}.`;
  const reach = outcome.stopped === 'time'
    ? `ERD Studio checked ${folderCount(outcome.folders)} in ${where}, ${options.again ? 'still ' : ''}not all of them.`
    : `That is ${options.again ? 'still ' : ''}not every folder in ${where}.`;
  const missed = `${options.hasDbt ? 'Another dbt project' : 'A project'} deeper down may have been missed.`;
  return {
    title,
    detail: `${reach} It opened ${options.opened}. ${missed}`,
    actions: [LOOK_LONGER_BUTTON, LOOK_DISMISS_BUTTON],
  };
}

/** The user pressed Stop Looking on a longer look. */
export function userStoppedStatus(options: { folderNames: readonly string[]; folders: number }): LookStatus {
  return {
    title: 'Stopped looking.',
    detail: `ERD Studio had checked ${folderCount(options.folders)} in ${lookedThrough(options.folderNames)}.`,
    actions: [LOOK_LONGER_BUTTON, LOOK_DISMISS_BUTTON],
  };
}

/** A longer look found dbt projects the window did not know: named by their path under the open folder. */
export function foundStatus(found: readonly string[]): LookStatus {
  const shown = found.slice(0, 3);
  const more = found.length - shown.length;
  return {
    title: found.length === 1 ? `Found a dbt project: ${found[0]}.` : `Found ${found.length} dbt projects.`,
    detail: found.length === 1
      ? `${LOOK_SELECT_PROJECT_BUTTON.replace('…', '')} opens it.`
      : `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}. ${LOOK_SELECT_PROJECT_BUTTON.replace('…', '')} opens one.`,
    actions: [LOOK_SELECT_PROJECT_BUTTON, LOOK_DISMISS_BUTTON],
  };
}

/** A longer look went everywhere and found nothing the window did not know. */
export function nothingMoreStatus(options: { folderNames: readonly string[]; folders: number }): LookStatus {
  return {
    title: 'Nothing more found.',
    detail: `ERD Studio checked ${folderCount(options.folders)} in ${lookedThrough(options.folderNames)}: every folder it looks in.`,
    actions: [LOOK_DISMISS_BUTTON],
  };
}
