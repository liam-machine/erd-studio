/**
 * The start suggestion: when a folder ERD Studio can model has no diagram
 * yet and the start screen's own suggestion (`startIntentFor`, through the
 * host's `StartIntentTracker`: never a second detector) is a concrete source,
 * one non-modal notification offers to show it as a diagram:
 *
 *   ERD Studio found CREATE TABLE scripts in this folder (24 tables). Show them
 *   as a diagram? Nothing is saved until you keep it.
 *   [Show Me] [Don't Ask Again for This Folder]
 *
 * **Show Me** opens the start's draft (Draft-first, `docs/dev/draft-first.md`
 * §3.3: a read-only preview, nothing written until Keep) by running the
 * start's own command with the `prompt` trigger; Convert keeps its own
 * **Convert to DBML…**. **Don't Ask Again for This Folder** turns it off for
 * this folder (workspace state: machine-local, nothing written into the
 * repo), and the folder then gets no automatic draft and no walkthrough.
 * It is shown once per folder ({@link MAX_START_SUGGESTION_SHOWS}): closing it
 * leaves the sidebar's button and the automatic draft on the ERD Studio icon,
 * never another notification. It is the window's one activation prompt
 * (`SessionPromptGate`, kind `startSuggestion`).
 *
 * Turned off by the button, by **ERD Studio: Turn Off Start Suggestions for
 * This Folder**, or by the `erdStudio.startSuggestions` setting (resource
 * scope: a team can commit `false` in `.vscode/settings.json`). What the look
 * found never leaves the machine: telemetry gets fixed keys only.
 *
 * Nothing concrete (a `blank` suggestion) gets no notification: the example
 * draft on the ERD Studio icon, once per machine, takes its place.
 *
 * vscode-free: the look, the state, the notification and the commands are injected.
 */

import * as path from 'path';

import {
  START_ACTION_COMMANDS,
  startActionArgs,
  type StartAction,
  type StartIntent,
} from '../types/startActions';
import type { TelemetryFeature } from './telemetryPayload';

/** The setting (read through `getErdStudioSetting`; resource scope). */
export const START_SUGGESTIONS_SETTING = 'startSuggestions';
/** Workspace state: how often the suggestion was shown here, and whether it is off or was answered. */
export const START_SUGGESTION_STATE_KEY = 'erdStudio.startSuggestion';
/** Context key: start suggestions are off for this folder (the flag or the setting); the palette shows Turn On, else Turn Off. */
export const START_SUGGESTIONS_OFF_CONTEXT_KEY = 'erdStudio.startSuggestionsOff';
export const TURN_OFF_START_SUGGESTIONS_COMMAND = 'erdStudio.turnOffStartSuggestions';
export const TURN_ON_START_SUGGESTIONS_COMMAND = 'erdStudio.turnOnStartSuggestions';
/** The commands as the palette names them (every message names them by their real title). */
export const TURN_OFF_START_SUGGESTIONS_TITLE = 'ERD Studio: Turn Off Start Suggestions for This Folder';
export const TURN_ON_START_SUGGESTIONS_TITLE = 'ERD Studio: Turn On Start Suggestions for This Folder';

/** Shown at most this many times per folder in all: once. Closing it never brings it back in a later window. */
export const MAX_START_SUGGESTION_SHOWS = 1;

/** Opens the start's draft (nothing is written until Keep). */
export const SHOW_ME_BUTTON = 'Show Me';
export const DONT_ASK_AGAIN_FOLDER_BUTTON = "Don't Ask Again for This Folder";
/** Convert creates no diagram: its button says what it does (the opening notice's own). */
export const CONVERT_BUTTON = 'Convert to DBML…';

/**
 * What "Don't Ask Again" (and Turn Off) answers with: one short line, and
 * {@link UNDO_BUTTON}, which runs Turn On Start Suggestions for This Folder
 * (also in the palette).
 */
export const START_SUGGESTIONS_OFF_MESSAGE = 'Start suggestions are off for this folder.';
export const UNDO_BUTTON = 'Undo';
export const START_SUGGESTIONS_ON_MESSAGE =
  'Start suggestions are on for this folder: ERD Studio suggests a start the next time it opens this folder without a diagram.';
/** Turn On while the setting is false: the folder's flag is cleared, but the setting still decides. */
export const START_SUGGESTIONS_SETTING_OFF_MESSAGE =
  'Start suggestions are turned off by the erdStudio.startSuggestions setting (in your settings or this folder\'s .vscode/settings.json).';
export const OPEN_SETTINGS_BUTTON = 'Open Settings';

/** The starts the notification offers: every suggestion but a blank diagram (nothing found to start from). */
export type SuggestedStart = Exclude<StartIntent, 'blank'>;

export function isConcreteSuggestion(intent: StartIntent | undefined): intent is SuggestedStart {
  return intent !== undefined && intent !== 'blank';
}

/** What the workspace state holds. */
export interface StartSuggestionState {
  /** How many times it was shown in this folder. */
  shown: number;
  /** Don't Ask Again, or Turn Off Start Suggestions for This Folder. */
  off?: boolean;
  /** Show Me (or Convert to DBML…) was chosen, or a draft was kept here: the user has the start. */
  answered?: boolean;
  /** The automatic draft (the ERD Studio icon) was shown in this folder: it is never shown automatically again. */
  draftShown?: boolean;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The state as stored, or a fresh one for anything else (a hand-edited or older value). */
export function readStartSuggestionState(raw: unknown): StartSuggestionState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { shown: 0 };
  const r = raw as Record<string, unknown>;
  return {
    shown: count(r.shown),
    ...(r.off === true ? { off: true } : {}),
    ...(r.answered === true ? { answered: true } : {}),
    ...(r.draftShown === true ? { draftShown: true } : {}),
  };
}

/** Whether start suggestions are off here: the folder's flag, or the setting. */
export function startSuggestionsOff(state: StartSuggestionState, settingOn: boolean): boolean {
  return state.off === true || !settingOn;
}

/** Whether the notification may still be shown in this folder (cheap: no look at the files). */
export function startSuggestionDue(input: { settingOn: boolean; state: StartSuggestionState; hasDiagrams: boolean }): boolean {
  const { settingOn, state, hasDiagrams } = input;
  return settingOn && !state.off && !state.answered && !hasDiagrams && state.shown < MAX_START_SUGGESTION_SHOWS;
}

/** Every suggestion but Convert's ends on this: Show Me writes nothing. */
const NOTHING_SAVED = 'Nothing is saved until you keep it.';

/**
 * The notification's text: what ERD Studio found (the kind of file and, for
 * SQL, how many tables when the look could count them exactly — never a file
 * name) and the one question.
 */
export function startSuggestionMessage(intent: SuggestedStart, found: { sqlTables?: number; dbtAbove?: boolean } = {}): string {
  switch (intent) {
    case 'importSqlDdl': {
      const n = found.sqlTables;
      const count = n !== undefined && n > 0 ? ` (${n} ${n === 1 ? 'table' : 'tables'})` : '';
      return `ERD Studio found CREATE TABLE scripts in this folder${count}. Show them as a diagram? ${NOTHING_SAVED}`;
    }
    case 'importSemanticModel':
      return `ERD Studio found a Power BI or Fabric semantic model in this folder. Show it as a diagram? ${NOTHING_SAVED}`;
    case 'importDbmlFile':
      return `ERD Studio found a DBML file in this folder. Show it as a diagram? ${NOTHING_SAVED}`;
    case 'drawFromDbt':
      // Opened from inside it (its models/, say): the project is in a folder above, not this one.
      return `ERD Studio found a dbt project in ${found.dbtAbove ? 'a folder above this one' : 'this folder'}. Show its models as a diagram? ${NOTHING_SAVED}`;
    case 'convert':
      return 'This project is from an older ERD Studio. Convert it once to DBML, an open format: your tables stay as they are.';
  }
}

/**
 * Whether the dbt project root sits above every open folder: the window
 * opened one of its subfolders (its models/, say), and upward discovery found
 * the project. False with no folder open, or when any open folder is the root
 * or contains it.
 */
export function dbtProjectAboveOpenFolders(projectRoot: string, openFolders: readonly string[]): boolean {
  if (openFolders.length === 0) return false;
  return openFolders.every((folder) => {
    const rel = path.relative(projectRoot, folder);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

/** The primary button: Show Me (the draft), or Convert's own (it creates no diagram). */
export function startSuggestionPrimary(intent: SuggestedStart): string {
  return intent === 'convert' ? CONVERT_BUTTON : SHOW_ME_BUTTON;
}

/** The funnel keys (`telemetry/README.md` → Onboarding funnel): user choices, never what was found. */
export const START_SUGGESTION_FEATURES = {
  shown: 'suggestPromptShown',
  /** Show Me: the draft. */
  showMe: 'suggestPromptShowMe',
  /** Convert to DBML… (Convert's own; `suggestPromptMore`, More Options…, is no longer sent). */
  accepted: 'suggestPromptAccepted',
  off: 'suggestPromptOff',
  dismissed: 'suggestPromptDismissed',
} as const satisfies Record<string, TelemetryFeature>;

export interface StartSuggestionDeps {
  /** The suggestion, after the tracker's bounded look (`StartIntentTracker.refresh`). */
  intent(): Promise<StartIntent | undefined>;
  /** The CREATE TABLE count the look made, when exact. */
  sqlTables(): number | undefined;
  /** Whether the dbt project sits above every open folder (one of its subfolders, such as models/, was opened). */
  dbtAbove?(): boolean;
  /** Whether the folder has a diagram now (it may have one since activation). */
  hasDiagrams(): boolean;
  /** `erdStudio.startSuggestions` (default on). */
  settingOn(): boolean;
  /** For Convert: whether the Convert offer's own checks pass (`convertOfferApplies`): no second Convert prompt. */
  convertApplies(): boolean;
  state(): StartSuggestionState;
  saveState(state: StartSuggestionState): PromiseLike<unknown>;
  /** The notification (non-modal); resolves with the button chosen, undefined when closed. */
  show(message: string, ...buttons: string[]): PromiseLike<string | undefined>;
  /** A short non-modal message with optional buttons; resolves with the one chosen. */
  info(message: string, ...buttons: string[]): PromiseLike<string | undefined> | void;
  executeCommand(command: string, ...args: unknown[]): PromiseLike<unknown>;
  /** The start-screen count for a shown suggestion (`startSuggested<Intent>`). */
  recordSuggested(intent: StartIntent): void;
  feature(key: TelemetryFeature): void;
  /** Publish {@link START_SUGGESTIONS_OFF_CONTEXT_KEY}. */
  setOffContext(off: boolean): void;
}

export interface StartSuggestionRun {
  /** The notification was shown (the window's prompt is spent); false: nothing concrete to offer, hand the window on. */
  shown: boolean;
  /** Settles once the user's choice (or the close) has been acted on. */
  done: Promise<void>;
}

/**
 * Look, and offer the start when there is a concrete one and it is still
 * due. The count is saved before the notification shows, so a crash cannot
 * make it ask more often. Never throws.
 */
export async function runStartSuggestion(deps: StartSuggestionDeps): Promise<StartSuggestionRun> {
  const nothing: StartSuggestionRun = { shown: false, done: Promise.resolve() };
  let intent: StartIntent | undefined;
  try {
    intent = await deps.intent();
  } catch {
    return nothing;
  }
  if (!isConcreteSuggestion(intent)) return nothing;
  if (intent === 'convert' && !deps.convertApplies()) return nothing;
  const state = deps.state();
  // Checked again after the look: a diagram made meanwhile, a setting or a command since activation.
  if (!startSuggestionDue({ settingOn: deps.settingOn(), state, hasDiagrams: deps.hasDiagrams() })) return nothing;

  await deps.saveState({ ...state, shown: state.shown + 1 });
  deps.feature(START_SUGGESTION_FEATURES.shown);
  deps.recordSuggested(intent);
  const primary = startSuggestionPrimary(intent);
  const start: StartAction = intent;
  const done = Promise.resolve(deps.show(startSuggestionMessage(intent, { sqlTables: deps.sqlTables(), dbtAbove: deps.dbtAbove?.() }), primary, DONT_ASK_AGAIN_FOLDER_BUTTON))
    .then(async (choice) => {
      const latest = deps.state();
      if (choice === primary) {
        deps.feature(start === 'convert' ? START_SUGGESTION_FEATURES.accepted : START_SUGGESTION_FEATURES.showMe);
        await deps.saveState({ ...latest, answered: true });
        // Show Me: the start's draft, opened by the prompt (it already holds the window's gate).
        await deps.executeCommand(START_ACTION_COMMANDS[start], ...startActionArgs(start, 'prompt'));
      } else if (choice === DONT_ASK_AGAIN_FOLDER_BUTTON) {
        deps.feature(START_SUGGESTION_FEATURES.off);
        await deps.saveState({ ...latest, off: true });
        deps.setOffContext(true);
        const undo = await deps.info(START_SUGGESTIONS_OFF_MESSAGE, UNDO_BUTTON);
        if (undo === UNDO_BUTTON) await deps.executeCommand(TURN_ON_START_SUGGESTIONS_COMMAND);
      } else {
        deps.feature(START_SUGGESTION_FEATURES.dismissed);
      }
    })
    .catch(() => { /* a start that fails reports itself */ });
  return { shown: true, done };
}
