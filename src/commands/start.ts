/**
 * `erdStudio.start` — the one door every start surface goes through (see
 * `src/types/startActions.ts`): it counts which start was clicked on which
 * surface, then runs the real command. A run without a valid argument (the
 * Command Palette cannot reach it, but a stray link could) asks which start
 * instead, from the same list the surfaces show.
 */

import {
  START_ACTION_COMMANDS,
  parseStartArgs,
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
  convert: { label: '$(arrow-swap) Convert to DBML', detail: 'Move this project from its YAML and JSON files to DBML, an open format' },
  drawFromDbt: { label: '$(wand) Draw from dbt', detail: 'Copy your dbt models and their relationships into a diagram' },
  importSemanticModel: { label: '$(graph) Import your Power BI semantic model', detail: 'Start from a Power BI or Fabric semantic model in this folder' },
  importSqlDdl: { label: '$(database) Import your SQL scripts', detail: 'Start from CREATE TABLE scripts in this folder' },
  importDbmlFile: { label: '$(file-code) Import your DBML file', detail: 'Start from a DBML file (an open format) in this folder' },
  blank: { label: '$(add) New Diagram', detail: 'Start with an empty canvas and add your own tables' },
  import: { label: '$(cloud-download) Import…', detail: 'Start from a DBML file, SQL DDL scripts or a Power BI semantic model' },
  example: { label: '$(book) Open an Example…', detail: 'See a finished data model first: eight common warehouse patterns' },
};

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
 * Run `erdStudio.start`. A valid `{ action, from }` is counted and run; anything
 * else (the start suggestion's More Options…) shows the starts that apply
 * here, then the import guide's "How do I export from Databricks, Snowflake,
 * Power BI…?", and runs the one picked (a start is not counted: it came from
 * no start surface; the guide counts `importGuideFromStartPick`).
 * A direct import runs its quick path either way (`startActionArgs`).
 */
export async function runStart(arg: unknown, deps: StartDeps): Promise<void> {
  const args = parseStartArgs(arg);
  if (args) {
    recordStart(args.action, args.from);
    await deps.executeCommand(START_ACTION_COMMANDS[args.action], ...startActionArgs(args.action));
    return;
  }
  const actions = startActionsFor(deps.context());
  const choice = await deps.pick([...actions.map((action): StartPickItem => ({ ...START_PICK_ITEMS[action], action })), START_PICK_GUIDE_ITEM]);
  if (!choice) return;
  if ('guide' in choice) {
    await deps.executeCommand(IMPORT_GUIDE_COMMAND, { from: 'startPick' });
    return;
  }
  await deps.executeCommand(START_ACTION_COMMANDS[choice.action], ...startActionArgs(choice.action));
}
