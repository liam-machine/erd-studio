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
  startActionsFor,
  type StartAction,
  type StartContext,
  type StartSurface,
} from '../types/startActions';
import type { TelemetryFeature } from '../services/telemetryPayload';
import { telemetry } from '../services/telemetryService';

/** The funnel key for each start on each surface. */
export const START_FEATURES: Readonly<Record<StartSurface, Readonly<Record<StartAction, TelemetryFeature>>>> = {
  welcome: {
    convert: 'welcomeConvert',
    drawFromDbt: 'welcomeDrawFromDbt',
    blank: 'welcomeBlank',
    import: 'welcomeImport',
    example: 'welcomeExample',
  },
  walkthrough: {
    convert: 'walkthroughConvert',
    drawFromDbt: 'walkthroughDrawFromDbt',
    blank: 'walkthroughBlank',
    import: 'walkthroughImport',
    example: 'walkthroughExample',
  },
  sidebar: {
    convert: 'sidebarConvert',
    drawFromDbt: 'sidebarDrawFromDbt',
    blank: 'sidebarBlank',
    import: 'sidebarImport',
    example: 'sidebarExample',
  },
};

/** What a start's quick pick shows, when the command runs without an argument. */
export const START_PICK_ITEMS: Readonly<Record<StartAction, { label: string; detail: string }>> = {
  convert: { label: '$(arrow-swap) Convert to DBML', detail: 'Move this project from its YAML and JSON files to DBML, an open format' },
  drawFromDbt: { label: '$(wand) Draw from dbt', detail: 'Copy your dbt models and their relationships into a diagram' },
  blank: { label: '$(add) New Diagram', detail: 'Start with an empty canvas and add your own tables' },
  import: { label: '$(cloud-download) Import DBML…', detail: 'Start from a DBML file, from dbdiagram.io or any DBML tool' },
  example: { label: '$(book) Open an Example…', detail: 'See a finished data model first: eight common warehouse patterns' },
};

export interface StartDeps {
  /** Where the folder stands now: which starts apply. */
  context(): StartContext;
  executeCommand(command: string): Thenable<unknown>;
  /** Show the starts to choose from; undefined when closed. */
  pick(items: Array<{ label: string; detail: string; action: StartAction }>): Thenable<{ action: StartAction } | undefined>;
}

/** Record where a start was clicked. */
export function recordStart(action: StartAction, from: StartSurface): void {
  telemetry.feature(START_FEATURES[from][action]);
}

/**
 * Run `erdStudio.start`. A valid `{ action, from }` is counted and run; anything
 * else shows the starts that apply here, and runs the one picked (not counted:
 * it came from no start surface).
 */
export async function runStart(arg: unknown, deps: StartDeps): Promise<void> {
  const args = parseStartArgs(arg);
  if (args) {
    recordStart(args.action, args.from);
    await deps.executeCommand(START_ACTION_COMMANDS[args.action]);
    return;
  }
  const actions = startActionsFor(deps.context());
  const choice = await deps.pick(actions.map((action) => ({ ...START_PICK_ITEMS[action], action })));
  if (choice) await deps.executeCommand(START_ACTION_COMMANDS[choice.action]);
}
