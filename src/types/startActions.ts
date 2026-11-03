/**
 * The start screen: the one-click ways to begin a data model, offered the same
 * way on every surface a new user meets — the Welcome panel, the Get Started
 * walkthrough and the empty Diagrams view.
 *
 * Pure and vscode-free: the host, the Welcome panel's page and the tests share
 * it. Which starts a surface shows comes from {@link startActionsFor} only, so
 * the surfaces cannot drift apart. Each surface reaches its start through
 * {@link START_COMMAND} with `{ action, from }`, which records where the click
 * came from (the onboarding funnel) and then runs the real command.
 */

/** Every start, in the order a surface lists them (the first one shown is the primary). */
export const START_ACTIONS = ['convert', 'drawFromDbt', 'blank', 'import', 'example'] as const;
export type StartAction = (typeof START_ACTIONS)[number];

/** Where a start was clicked. */
export const START_SURFACES = ['welcome', 'walkthrough', 'sidebar'] as const;
export type StartSurface = (typeof START_SURFACES)[number];

/** The hidden command every start surface runs, with one {@link StartArgs}. */
export const START_COMMAND = 'erdStudio.start';

/** The command each start runs. */
export const START_ACTION_COMMANDS: Readonly<Record<StartAction, string>> = {
  convert: 'erdStudio.convertProjectToDbml',
  drawFromDbt: 'erdStudio.drawFromDbt',
  blank: 'erdStudio.createDomain',
  import: 'erdStudio.importDbml',
  example: 'erdStudio.openExampleProject',
};

/** How the project stores its model (`erdStudio.storage`); `dbml` for a new folder. */
export type StartStorage = 'dbml' | 'yaml' | 'mixed';

export interface StartContext {
  /** A folder is open. */
  hasProject: boolean;
  /** The folder is a dbt project. */
  hasDbt: boolean;
  /** How the project stores its model; absent reads as `dbml`. */
  storage?: StartStorage;
}

/**
 * The starts to offer, primary first. Kept short on purpose: Convert shows
 * only in a project from before 2.0 (YAML tables or JSON diagrams), Draw from
 * dbt only in a dbt project, and an empty window offers only the example (it
 * opens in a folder of its own; everything else needs a folder first).
 */
export function startActionsFor(ctx: StartContext): StartAction[] {
  if (!ctx.hasProject) return ['example'];
  return START_ACTIONS.filter((action) => {
    if (action === 'convert') return ctx.storage === 'yaml' || ctx.storage === 'mixed';
    if (action === 'drawFromDbt') return ctx.hasDbt;
    return true;
  });
}

export interface StartArgs {
  action: StartAction;
  from: StartSurface;
}

/** The argument of {@link START_COMMAND}, or undefined for anything else (a palette run, a stray value). */
export function parseStartArgs(arg: unknown): StartArgs | undefined {
  if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) return undefined;
  const { action, from } = arg as Record<string, unknown>;
  if (!(START_ACTIONS as readonly unknown[]).includes(action)) return undefined;
  if (!(START_SURFACES as readonly unknown[]).includes(from)) return undefined;
  return { action: action as StartAction, from: from as StartSurface };
}

/** A `command:` link for a walkthrough step or welcome view: runs {@link START_COMMAND} with `{ action, from }`. */
export function startCommandLink(action: StartAction, from: Exclude<StartSurface, 'welcome'>): string {
  return `command:${START_COMMAND}?${encodeURIComponent(JSON.stringify([{ action, from }]))}`;
}
