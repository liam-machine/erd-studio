/**
 * The major update notice: once per machine per major version, the first
 * window after a major update (1.x to 2.x) says the new version has a guide,
 * with **Show Me Around**, **What's New** (the bundled changelog) and
 * **Not now**. Without it an upgrader never hears of the guide: the Get
 * Started walkthrough is a fresh install's, the guide starts by itself only on
 * a draft, and the "This project has N ERD Studio diagrams" notice is spent in
 * most workspaces long before the update.
 *
 * **When it is owed** ({@link noteMajorUpdate}, run as `activate()` starts,
 * before the version last activated is overwritten): that version's major is
 * lower than the running one's. Never for a fresh install (no version last
 * activated), a patch or minor update, a downgrade, or a version that does
 * not parse.
 *
 * **The catch-up**, looked at once per machine (the first activation of a
 * version that has this notice): a machine already on the running major came
 * to it before the notice existed, so its version last activated says
 * nothing. It is owed the notice only when the machine itself recorded a
 * major update (`majorUpdateSeen`: telemetry's own on-device day of the first
 * start after one, kept only while telemetry is on) and the guide has never
 * started there. A machine that recorded nothing is left out, never guessed.
 *
 * **State** (`globalState` only; nothing here touches the workspace or a
 * file): the major it is owed for is written when the update is seen, since
 * the notice may wait for a later window (one prompt per window,
 * `activationPrompts.ts`); the major it was shown for is written only when
 * it shows, or when the guide runs first ({@link markMajorNoticeShown}).
 * Once shown for a major it never shows for it again; a later major owes it
 * again.
 *
 * vscode-free (pure but for the injected state), so the rule is unit tested
 * on its own.
 */

/** The major a notice is owed for (a whole number). Written when a major update is seen. */
export const MAJOR_NOTICE_OWED_KEY = 'erdStudio.majorUpdateNotice.owedMajor';
/** The latest major whose notice was shown, or spent by a run of the guide (a whole number). */
export const MAJOR_NOTICE_SHOWN_KEY = 'erdStudio.majorUpdateNotice.shownMajor';
/** `true` once the catch-up has been looked at on this machine: it is never looked at twice. */
export const MAJOR_NOTICE_CATCH_UP_KEY = 'erdStudio.majorUpdateNotice.catchUpChecked';

/** The notice's second button: the changelog that ships with the extension. */
export const WHATS_NEW_LABEL = "What's New";
/** The notice's last button; closing the notice is the same answer. */
export const MAJOR_NOTICE_NOT_NOW = 'Not now';
/** The changelog's path inside the extension (`.vscodeignore` keeps it in the VSIX). Fixed: never a URL. */
export const WHATS_NEW_FILE = 'CHANGELOG.md';
/** VS Code's own Markdown preview command, which **What's New** opens the changelog with. */
export const MARKDOWN_PREVIEW_COMMAND = 'markdown.showPreview';

/** The part of `globalState` the notice reads and writes. */
export interface MajorNoticeState {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

/**
 * The major of an extension version (`2.0.3` → 2; a pre-release such as
 * `1.9.9` → 1; `3.0.0-beta.1` → 3). Anything that is not `major.minor.patch`
 * (a missing value, a number, `2`, `2.x`, text) has none. Never throws.
 */
export function majorOf(version: unknown): number | undefined {
  if (typeof version !== 'string') return undefined;
  const match = /^(\d{1,6})\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/.exec(version.trim());
  return match ? Number(match[1]) : undefined;
}

/** A stored major: a whole number of at least 0, or nothing. */
function storedMajor(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The notice's one sentence, naming the running major ("ERD Studio 2.0 …"). The guide is "a guide", never "a tour": that is the video. */
export function majorUpdateNoticeMessage(major: number): string {
  return `ERD Studio ${major}.0 has a short guide that shows you around.`;
}

/** What the catch-up may go by: what this machine itself recorded before the notice existed. */
export interface MajorUpdateEvidence {
  /** The machine recorded a start after a major update (telemetry's on-device `majorSeenDay`; never written while telemetry is off). */
  majorUpdateSeen: boolean;
  /** The guide has started on this machine at some time (`GUIDE_STATE_KEY` holds a status). */
  guideStarted: boolean;
}

/**
 * Whether this activation owes the notice for the running major: the version
 * last activated is an older major, or (only on the catch-up's one look) the
 * machine is already on this major, recorded a major update, and has never
 * had the guide.
 */
export function majorUpdateOwes(o: { previous: unknown; current: unknown; catchUp: boolean; evidence: MajorUpdateEvidence }): boolean {
  const current = majorOf(o.current);
  const previous = majorOf(o.previous);
  if (current === undefined || previous === undefined) return false;
  if (previous < current) return true;
  return o.catchUp && previous === current && o.evidence.majorUpdateSeen && !o.evidence.guideStarted;
}

/**
 * Run as `activate()` starts, with the version last activated (before it is
 * overwritten) and the running one: records that the notice is owed for the
 * running major, and that the catch-up has had its one look. Writes nothing
 * else and never throws (a failed write only means the notice is not shown).
 */
export async function noteMajorUpdate(state: MajorNoticeState, previous: unknown, current: unknown, evidence: MajorUpdateEvidence): Promise<void> {
  try {
    const major = majorOf(current);
    if (major === undefined) return;
    const catchUp = state.get(MAJOR_NOTICE_CATCH_UP_KEY) !== true;
    if (majorUpdateOwes({ previous, current, catchUp, evidence }) && storedMajor(state.get(MAJOR_NOTICE_OWED_KEY)) !== major) {
      await state.update(MAJOR_NOTICE_OWED_KEY, major);
    }
    if (catchUp) await state.update(MAJOR_NOTICE_CATCH_UP_KEY, true);
  } catch {
    // The notice is news, never a reason for activation to fail.
  }
}

/**
 * The major the notice is due for now, if any: it is owed for the running
 * major and has not been shown (or spent) for it.
 */
export function majorNoticeDue(state: MajorNoticeState, current: unknown): number | undefined {
  try {
    const major = majorOf(current);
    if (major === undefined || storedMajor(state.get(MAJOR_NOTICE_OWED_KEY)) !== major) return undefined;
    const shown = storedMajor(state.get(MAJOR_NOTICE_SHOWN_KEY));
    return shown !== undefined && shown >= major ? undefined : major;
  } catch {
    return undefined;
  }
}

/**
 * The notice is about to show, or the guide ran before it could: it is not
 * shown again for this major. Returns the major when the notice was due (so
 * the caller may show it), undefined when there was nothing to mark. Never throws.
 */
export async function markMajorNoticeShown(state: MajorNoticeState, current: unknown): Promise<number | undefined> {
  const major = majorNoticeDue(state, current);
  if (major === undefined) return undefined;
  try {
    await state.update(MAJOR_NOTICE_SHOWN_KEY, major);
    return major;
  } catch {
    // Not recorded: do not show what could then repeat in every window.
    return undefined;
  }
}
