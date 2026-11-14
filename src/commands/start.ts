/**
 * `erdStudio.start` — the one door every start surface goes through (see
 * `src/types/startActions.ts`): it counts which start was clicked on which
 * surface, then runs the real command. A run without a valid argument (the
 * Command Palette cannot reach it, but a stray link could) asks which start
 * instead, from the same list the surfaces show.
 */

import {
  START_ACTION_COMMANDS,
  START_ACTION_LABELS,
  moreStartsFor,
  parseStartArgs,
  parseStartPickArgs,
  startActionArgs,
  startActionsFor,
  type StartAction,
  type StartContext,
  type StartIntent,
  type StartSurface,
} from '../types/startActions';
import { IMPORT_GUIDE_COMMAND, IMPORT_GUIDE_PICK_ITEM } from '../services/importGuide';
import type { TelemetryFeature } from '../services/telemetryPayload';
import { telemetry } from '../services/telemetryService';

/** The funnel key for each start on each surface. */
export const START_FEATURES: Readonly<Record<StartSurface, Readonly<Record<StartAction, TelemetryFeature>>>> = {
  welcome: {
    convert: 'welcomeConvert',
    drawFromDbt: 'welcomeDrawFromDbt',
    importSemanticModel: 'welcomeImportSemanticModel',
    importSqlDdl: 'welcomeImportSqlDdl',
    importDbmlFile: 'welcomeImportDbmlFile',
    blank: 'welcomeBlank',
    import: 'welcomeImport',
    example: 'welcomeExample',
  },
  walkthrough: {
    convert: 'walkthroughConvert',
    drawFromDbt: 'walkthroughDrawFromDbt',
    importSemanticModel: 'walkthroughImportSemanticModel',
    importSqlDdl: 'walkthroughImportSqlDdl',
    importDbmlFile: 'walkthroughImportDbmlFile',
    blank: 'walkthroughBlank',
    import: 'walkthroughImport',
    example: 'walkthroughExample',
  },
  sidebar: {
    convert: 'sidebarConvert',
    drawFromDbt: 'sidebarDrawFromDbt',
    importSemanticModel: 'sidebarImportSemanticModel',
    importSqlDdl: 'sidebarImportSqlDdl',
    importDbmlFile: 'sidebarImportDbmlFile',
    blank: 'sidebarBlank',
    import: 'sidebarImport',
    example: 'sidebarExample',
  },
};

/** What a start's quick pick shows, when the command runs without an argument. */
export const START_PICK_ITEMS: Readonly<Record<StartAction, { label: string; detail: string }>> = {
  convert: { label: `$(arrow-swap) ${START_ACTION_LABELS.convert}`, detail: 'Move this project from its YAML and JSON files to DBML' },
  drawFromDbt: { label: `$(wand) ${START_ACTION_LABELS.drawFromDbt}`, detail: 'Your dbt models and their relationships, as a diagram' },
  importSemanticModel: { label: `$(graph) ${START_ACTION_LABELS.importSemanticModel}`, detail: 'The semantic model in this folder, as a diagram' },
  importSqlDdl: { label: `$(database) ${START_ACTION_LABELS.importSqlDdl}`, detail: 'The CREATE TABLE scripts in this folder, as a diagram' },
  importDbmlFile: { label: `$(file-code) ${START_ACTION_LABELS.importDbmlFile}`, detail: 'The DBML file in this folder, as a diagram' },
  blank: { label: `$(add) ${START_ACTION_LABELS.blank}`, detail: 'An empty canvas for your own tables' },
  import: { label: `$(cloud-download) ${START_ACTION_LABELS.import}`, detail: 'A DBML file, SQL scripts or a Power BI semantic model' },
  example: { label: `$(book) ${START_ACTION_LABELS.example}`, detail: 'A finished data model to look around' },
}

/**
 * What each suggestion is counted as when a surface the host can see shows it
 * (the Welcome panel's start card, the empty Diagrams view): at most once a
 * day, whichever surface showed it (`gettingStartedOpened` / `sidebarStartShown`
 * say which surfaces were seen).
 */
export const START_INTENT_FEATURES: Readonly<Record<StartIntent, TelemetryFeature>> = {
  convert: 'startSuggestedConvert',
  drawFromDbt: 'startSuggestedDrawFromDbt',
  importSemanticModel: 'startSuggestedImportSemanticModel',
  importSqlDdl: 'startSuggestedImportSqlDdl',
  importDbmlFile: 'startSuggestedImportDbmlFile',
  blank: 'startSuggestedBlank',
};

/** Record that a surface showed this suggestion (once a day per suggestion). */
export function recordStartSuggested(intent: StartIntent): void {
  telemetry.featureOnce(START_INTENT_FEATURES[intent]);
}

/** A start in the quick pick. */
export interface StartPickItem { label: string; detail: string; action: StartAction }
/** The quick pick's last item: the import guide (how to export from Databricks, Snowflake, Power BI…). */
export interface StartPickGuideItem { label: string; detail: string; guide: true }

/** The import guide's item, last in the start quick pick (`importGuideFromStartPick`). */
export const START_PICK_GUIDE_ITEM: StartPickGuideItem = { ...IMPORT_GUIDE_PICK_ITEM, guide: true };

export interface StartDeps {
  /** Where the folder stands now: which starts apply. */
  context(): StartContext;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
  /** Show the starts to choose from, then the guide; undefined when closed. */
  pick(items: Array<StartPickItem | StartPickGuideItem>): Thenable<StartPickItem | StartPickGuideItem | undefined>;
}

/** Record where a start was clicked. */
export function recordStart(action: StartAction, from: StartSurface): void {
  telemetry.feature(START_FEATURES[from][action]);
}

/**
 * Run `erdStudio.start`. A valid `{ action, from }` is counted and run. `{ from }`
 * alone is a surface's **More ways to start…** link: the starts other than
 * that surface's button (`moreStartsFor`), then **Import Your Data Model…**
 * (the import guide), the pick counted as that surface's start (or the
 * guide's `importGuideFrom<Surface>`). Anything else (a stray link, an old
 * keybinding) shows every start that applies here and the guide, and counts
 * no start (the guide counts `importGuideFromStartPick`).
 * A direct import runs its quick path and Import from dbt its folder draft
 * either way, each ending in the draft preview (`startActionArgs`, trigger
 * `start`): nothing is written until Keep.
 */
export async function runStart(arg: unknown, deps: StartDeps): Promise<void> {
  const args = parseStartArgs(arg);
  if (args) {
    recordStart(args.action, args.from);
    await runStartCommand(deps, args.action);
    return;
  }
  // "More ways to start…" under a surface's button: the other starts, counted as that surface's.
  const from = parseStartPickArgs(arg);
  const ctx = deps.context();
  const actions = from ? moreStartsFor(ctx) : startActionsFor(ctx);
  const choice = await deps.pick([...actions.map((action): StartPickItem => ({ ...START_PICK_ITEMS[action], action })), START_PICK_GUIDE_ITEM]);
  if (!choice) return;
  if ('guide' in choice) {
    await deps.executeCommand(IMPORT_GUIDE_COMMAND, { from: from ?? 'startPick' });
    return;
  }
  if (from) recordStart(choice.action, from);
  await runStartCommand(deps, choice.action);
}

/** Run a start's fixed command; a throw counts `startCommandFailed` (B18) and is rethrown unchanged. */
async function runStartCommand(deps: StartDeps, action: StartAction): Promise<void> {
  try {
    await deps.executeCommand(START_ACTION_COMMANDS[action], ...startActionArgs(action));
  } catch (err) {
    telemetry.error('startCommandFailed');
    throw err;
  }
}
