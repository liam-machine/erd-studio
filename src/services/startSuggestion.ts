/**
 * The start suggestion: when a folder ERD Studio can model has no diagram
 * yet and the start screen's own suggestion (`startIntentFor`, through the
 * host's `StartIntentTracker`: never a second detector) is a concrete source,
 * one non-modal notification offers that start:
 *
 *   ERD Studio found CREATE TABLE scripts in this folder (24 tables). Create a diagram from them?
 *   [Create Diagram] [More Options…] [Don't Ask Again for This Folder]
 *
 * **Create Diagram** runs the start's own command on its quick path (an
 * import's defaults chosen, one confirm; Draw from dbt; Convert to DBML),
 * **More Options…** the start quick pick (`erdStudio.start` with no
 * argument), **Don't Ask Again for This Folder** turns it off for this
 * folder (workspace state: machine-local, nothing written into the repo).
 * Closing it asks again in a later window, at most
 * {@link MAX_START_SUGGESTION_SHOWS} times per folder; it is the window's one
 * activation prompt (`SessionPromptGate`, kind `startSuggestion`), so never
 * twice in a window.
 *
 * Turned off by the button, by **ERD Studio: Turn Off Start Suggestions for
 * This Folder**, or by the `erdStudio.startSuggestions` setting (resource
 * scope: a team can commit `false` in `.vscode/settings.json`). What the look
 * found never leaves the machine: telemetry gets fixed keys only.
 *
 * Nothing concrete (a `blank` suggestion) is the other notification here,
 * {@link runNothingFoundPrompt}: "No data model found in this folder yet…",
 * shown only once the user opened the empty Diagrams view, never because
 * ERD Studio activated.
 *
 * vscode-free: the look, the state, the notification and the commands are injected.
 */

import {
  IMPORT_GUIDE_COMMAND,
  START_ACTION_COMMANDS,
  START_COMMAND,
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

/** Shown at most this many times per folder in all; closing it without a choice asks again in a later window. */
export const MAX_START_SUGGESTION_SHOWS = 3;

export const CREATE_DIAGRAM_BUTTON = 'Create Diagram';
export const MORE_OPTIONS_BUTTON = 'More Options…';
export const DONT_ASK_AGAIN_FOLDER_BUTTON = "Don't Ask Again for This Folder";
/** Convert creates no diagram: its button says what it does (the opening notice's own). */
export const CONVERT_BUTTON = 'Convert to DBML…';

/** What "Don't Ask Again" answers with: it is off, and how to turn it back on. */
export const START_SUGGESTIONS_OFF_MESSAGE =
  `ERD Studio won't suggest a start for this folder again. To turn suggestions back on, run ${TURN_ON_START_SUGGESTIONS_TITLE}.`;
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
  /** Don't Ask Again, or Turn Off Start Suggestions for This Folder (both notifications). */
  off?: boolean;
  /** Create Diagram or More Options… was chosen: the user has the start. */
  answered?: boolean;
  /** How many times the nothing-found notification was shown in this folder (its own count). */
  nothingShown?: number;
  /** New Diagram or Show Me How was chosen on the nothing-found notification. */
  nothingAnswered?: boolean;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The state as stored, or a fresh one for anything else (a hand-edited or older value). */
export function readStartSuggestionState(raw: unknown): StartSuggestionState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { shown: 0 };
  const r = raw as Record<string, unknown>;
  const nothingShown = count(r.nothingShown);
  return {
    shown: count(r.shown),
    ...(r.off === true ? { off: true } : {}),
    ...(r.answered === true ? { answered: true } : {}),
    ...(nothingShown > 0 ? { nothingShown } : {}),
    ...(r.nothingAnswered === true ? { nothingAnswered: true } : {}),
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

/**
 * The notification's text: what ERD Studio found (the kind of file and, for
 * SQL, how many tables when the look could count them exactly — never a file
 * name) and the one question.
 */
export function startSuggestionMessage(intent: SuggestedStart, found: { sqlTables?: number } = {}): string {
  switch (intent) {
    case 'importSqlDdl': {
      const n = found.sqlTables;
      const count = n !== undefined && n > 0 ? ` (${n} ${n === 1 ? 'table' : 'tables'})` : '';
      return `ERD Studio found CREATE TABLE scripts in this folder${count}. Create a diagram from them?`;
    }
    case 'importSemanticModel':
      return 'ERD Studio found a Power BI or Fabric semantic model in this folder. Create a diagram from it?';
    case 'importDbmlFile':
      return 'ERD Studio found a DBML file in this folder. Create a diagram from it?';
    case 'drawFromDbt':
      return 'ERD Studio found a dbt project in this folder. Create a diagram from its models?';
    case 'convert':
      return 'This project is from an older ERD Studio. Convert it once to DBML, an open format: your tables stay as they are.';
  }
}

/** The primary button: Create Diagram, or Convert's own (it creates no diagram). */
export function startSuggestionPrimary(intent: SuggestedStart): string {
  return intent === 'convert' ? CONVERT_BUTTON : CREATE_DIAGRAM_BUTTON;
}

/** The funnel keys (`telemetry/README.md` → Onboarding funnel): user choices, never what was found. */
export const START_SUGGESTION_FEATURES = {
  shown: 'suggestPromptShown',
  accepted: 'suggestPromptAccepted',
  more: 'suggestPromptMore',
  off: 'suggestPromptOff',
  dismissed: 'suggestPromptDismissed',
} as const satisfies Record<string, TelemetryFeature>;

export interface StartSuggestionDeps {
  /** The suggestion, after the tracker's bounded look (`StartIntentTracker.refresh`). */
  intent(): Promise<StartIntent | undefined>;
  /** The CREATE TABLE count the look made, when exact. */
  sqlTables(): number | undefined;
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
  info(message: string): void;
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
  const done = Promise.resolve(deps.show(startSuggestionMessage(intent, { sqlTables: deps.sqlTables() }), primary, MORE_OPTIONS_BUTTON, DONT_ASK_AGAIN_FOLDER_BUTTON))
    .then(async (choice) => {
      const latest = deps.state();
      if (choice === primary) {
        deps.feature(START_SUGGESTION_FEATURES.accepted);
        await deps.saveState({ ...latest, answered: true });
        await deps.executeCommand(START_ACTION_COMMANDS[start], ...startActionArgs(start));
      } else if (choice === MORE_OPTIONS_BUTTON) {
        deps.feature(START_SUGGESTION_FEATURES.more);
        await deps.saveState({ ...latest, answered: true });
        await deps.executeCommand(START_COMMAND);
      } else if (choice === DONT_ASK_AGAIN_FOLDER_BUTTON) {
        deps.feature(START_SUGGESTION_FEATURES.off);
        await deps.saveState({ ...latest, off: true });
        deps.setOffContext(true);
        deps.info(START_SUGGESTIONS_OFF_MESSAGE);
      } else {
        deps.feature(START_SUGGESTION_FEATURES.dismissed);
      }
    })
    .catch(() => { /* a start that fails reports itself */ });
  return { shown: true, done };
}

// ---------------------------------------------------------------------------
// Nothing found: a folder with no diagram and nothing concrete to start from
// ---------------------------------------------------------------------------

/**
 * The nothing-found notification: shown only when the user clearly came to
 * ERD Studio — the empty Diagrams view was drawn in this folder — and the
 * look found nothing concrete (the suggestion is `blank`). Never merely
 * because ERD Studio activated: a repository of query `.sql` files activates
 * it too, and would be nagged every time. On a first run the walkthrough
 * keeps the window (its blank start step links the import guide), so this
 * waits for a later window. Same rules as the concrete suggestion: the
 * window's one prompt (`SessionPromptGate`), at most
 * {@link MAX_START_SUGGESTION_SHOWS} times per folder (its own count), Don't
 * Ask Again for This Folder, and the `erdStudio.startSuggestions` setting.
 */
export const NOTHING_FOUND_MESSAGE =
  'No data model found in this folder yet. Start a new diagram, or bring in your data model from Databricks, Snowflake, Power BI, Fabric and more as DBML, an open format. ERD Studio is free to use.';
export const NEW_DIAGRAM_BUTTON = 'New Diagram';
export const SHOW_ME_HOW_BUTTON = 'Show Me How';

/** The command Show Me How runs, and its argument (the guide counts where it was opened from). */
export const SHOW_ME_HOW_COMMAND = IMPORT_GUIDE_COMMAND;
export const SHOW_ME_HOW_ARGS = [{ from: 'prompt' }] as const;

/** Its keys (`telemetry/README.md` → Onboarding funnel). Closed without a choice is shown minus the three answers. */
export const NOTHING_FOUND_FEATURES = {
  shown: 'suggestPromptNothingShown',
  newDiagram: 'suggestPromptNothingNewDiagram',
  guide: 'suggestPromptNothingGuide',
  off: 'suggestPromptNothingOff',
} as const satisfies Record<string, TelemetryFeature>;

/** Whether the nothing-found notification may still be shown in this folder (cheap: no look at the files). */
export function nothingFoundDue(input: { settingOn: boolean; state: StartSuggestionState; hasDiagrams: boolean; hasTables?: boolean }): boolean {
  const { settingOn, state, hasDiagrams, hasTables } = input;
  return settingOn && !state.off && !state.nothingAnswered && !hasDiagrams && hasTables !== true
    && (state.nothingShown ?? 0) < MAX_START_SUGGESTION_SHOWS;
}

export interface NothingFoundDeps extends Omit<StartSuggestionDeps, 'sqlTables' | 'convertApplies' | 'recordSuggested'> {
  /** Whether the Table Library holds a table (a model with no diagram yet is not "no data model"). */
  hasTables(): boolean;
  /** Take the window's one prompt (`SessionPromptGate.claim`); false when another prompt has it. */
  claim(): boolean;
}

/**
 * Offer the nothing-found notification, when it is due, the suggestion is
 * `blank` and the window's prompt is free. Never throws.
 */
export async function runNothingFoundPrompt(deps: NothingFoundDeps): Promise<StartSuggestionRun> {
  const nothing: StartSuggestionRun = { shown: false, done: Promise.resolve() };
  const due = (state: StartSuggestionState): boolean =>
    nothingFoundDue({ settingOn: deps.settingOn(), state, hasDiagrams: deps.hasDiagrams(), hasTables: deps.hasTables() });
  if (!due(deps.state())) return nothing;
  let intent: StartIntent | undefined;
  try {
    intent = await deps.intent();
  } catch {
    return nothing;
  }
  if (intent !== 'blank') return nothing;
  const state = deps.state();
  // Checked again after the look: a diagram made meanwhile, a setting or a command since.
  if (!due(state)) return nothing;
  if (!deps.claim()) return nothing;

  await deps.saveState({ ...state, nothingShown: (state.nothingShown ?? 0) + 1 });
  deps.feature(NOTHING_FOUND_FEATURES.shown);
  const done = Promise.resolve(deps.show(NOTHING_FOUND_MESSAGE, NEW_DIAGRAM_BUTTON, SHOW_ME_HOW_BUTTON, DONT_ASK_AGAIN_FOLDER_BUTTON))
    .then(async (choice) => {
      const latest = deps.state();
      if (choice === NEW_DIAGRAM_BUTTON) {
        deps.feature(NOTHING_FOUND_FEATURES.newDiagram);
        await deps.saveState({ ...latest, nothingAnswered: true });
        await deps.executeCommand(START_ACTION_COMMANDS.blank);
      } else if (choice === SHOW_ME_HOW_BUTTON) {
        deps.feature(NOTHING_FOUND_FEATURES.guide);
        await deps.saveState({ ...latest, nothingAnswered: true });
        await deps.executeCommand(SHOW_ME_HOW_COMMAND, ...SHOW_ME_HOW_ARGS);
      } else if (choice === DONT_ASK_AGAIN_FOLDER_BUTTON) {
        deps.feature(NOTHING_FOUND_FEATURES.off);
        await deps.saveState({ ...latest, off: true });
        deps.setOffContext(true);
        deps.info(START_SUGGESTIONS_OFF_MESSAGE);
      }
    })
    .catch(() => { /* a start that fails reports itself */ });
  return { shown: true, done };
}
