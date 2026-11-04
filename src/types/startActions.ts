/**
 * The start screen: the one-click ways to begin a data model, offered the same
 * way on every surface a new user meets — the Welcome panel, the Get Started
 * walkthrough and the empty Diagrams view.
 *
 * Pure and vscode-free: the host, the Welcome panel's page and the tests share
 * it. What the folder suggests (the **intent**) comes from {@link startIntentFor}
 * only, and which starts a surface shows from {@link startActionsFor} only, so
 * the surfaces cannot drift apart: each shows one primary start (the
 * suggestion) and at most three more. Each surface reaches its start through
 * {@link START_COMMAND} with `{ action, from }`, which records where the click
 * came from (the onboarding funnel) and then runs the real command.
 */

/**
 * Every start, in the order the Welcome panel renders its buttons (the page
 * reorders them by {@link startActionsFor}). The three `import*` starts go
 * straight to one source's import; `import` is the generic Import… picker.
 */
export const START_ACTIONS = [
  'convert', 'drawFromDbt', 'importSemanticModel', 'importSqlDdl', 'importDbmlFile', 'blank', 'import', 'example',
] as const;
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
  // The three sources Import… offers, each run directly: one click less than the picker.
  importSemanticModel: 'erdStudio.importSemanticModel',
  importSqlDdl: 'erdStudio.importSqlDdl',
  importDbmlFile: 'erdStudio.importDbml',
  blank: 'erdStudio.createDomain',
  // Import…: a picker over DBML, SQL DDL and a Power BI / Fabric semantic model.
  import: 'erdStudio.importModel',
  example: 'erdStudio.openExampleProject',
};

/**
 * What the open folder suggests as its first start, strongest first: a project
 * from before 2.0 converts, a dbt project draws from dbt, then the files the
 * bounded look found (a Power BI / Fabric semantic model, CREATE TABLE
 * scripts, a DBML file), else a blank diagram. Each names its primary start.
 */
export const START_INTENTS = ['convert', 'drawFromDbt', 'importSemanticModel', 'importSqlDdl', 'importDbmlFile', 'blank'] as const;
export type StartIntent = (typeof START_INTENTS)[number];

/** The context key the host sets to the intent (`package.json` gates the start variants on it). */
export const START_INTENT_CONTEXT_KEY = 'erdStudio.startIntent';

/**
 * The import sources the folder's quick look can find (`detectImportSources`,
 * `src/commands/importModel.ts`; the same ids as `IMPORT_MODEL_SOURCES`).
 */
export type DetectedImportSource = 'dbml' | 'sqlDdl' | 'semanticModel';

/** How the project stores its model (`erdStudio.storage`); `dbml` for a new folder. */
export type StartStorage = 'dbml' | 'yaml' | 'mixed';

export interface StartContext {
  /** A folder is open. */
  hasProject: boolean;
  /** The folder is a dbt project. */
  hasDbt: boolean;
  /** How the project stores its model; absent reads as `dbml`. */
  storage?: StartStorage;
  /** The project already holds a diagram: the folder's files are not suggested any more. */
  hasDiagrams?: boolean;
  /** What the bounded look at the folder found; absent (not looked yet) reads as nothing. */
  found?: Iterable<DetectedImportSource>;
}

/** Whether the folder's own files decide the suggestion (a new DBML project, no dbt, no diagram yet). */
export function startNeedsLook(ctx: StartContext): boolean {
  return ctx.hasProject && !ctx.hasDbt && !isPre20(ctx.storage) && !ctx.hasDiagrams;
}

function isPre20(storage: StartStorage | undefined): boolean {
  return storage === 'yaml' || storage === 'mixed';
}

/**
 * The suggested start for an open folder (`undefined` with no folder open:
 * the empty window's only start is the example). Strongest signal first:
 * convert > drawFromDbt > importSemanticModel > importSqlDdl > importDbmlFile
 * > blank. The found files count only while {@link startNeedsLook} holds.
 */
export function startIntentFor(ctx: StartContext): StartIntent | undefined {
  if (!ctx.hasProject) return undefined;
  if (isPre20(ctx.storage)) return 'convert';
  if (ctx.hasDbt) return 'drawFromDbt';
  if (startNeedsLook(ctx)) {
    const found = new Set(ctx.found ?? []);
    if (found.has('semanticModel')) return 'importSemanticModel';
    if (found.has('sqlDdl')) return 'importSqlDdl';
    if (found.has('dbml')) return 'importDbmlFile';
  }
  return 'blank';
}

/**
 * The starts each intent offers, primary first, at most four. Someone with
 * nothing to import sees the example second; the generic Import… always
 * stays as a quieter choice. Convert is not listed: it leads the starts the
 * project would otherwise offer ({@link startActionsForIntent}).
 */
export const INTENT_STARTS: Readonly<Record<Exclude<StartIntent, 'convert'>, readonly StartAction[]>> = {
  drawFromDbt: ['drawFromDbt', 'blank', 'import', 'example'],
  importSemanticModel: ['importSemanticModel', 'blank', 'import', 'example'],
  importSqlDdl: ['importSqlDdl', 'blank', 'import', 'example'],
  importDbmlFile: ['importDbmlFile', 'blank', 'import', 'example'],
  blank: ['blank', 'example', 'import'],
};

/** Most starts a surface offers: the suggestion and three quieter ones. */
export const MAX_STARTS = 4;

/**
 * The starts for an intent, primary first (`undefined`: no folder open, only
 * the example). Convert, in a project from before 2.0, leads what that
 * project would otherwise offer (Draw from dbt's starts with dbt, a blank
 * diagram's without), cut to {@link MAX_STARTS}: the project keeps working
 * as it is, so its other starts stay, quieter.
 */
export function startActionsForIntent(intent: StartIntent | undefined, hasDbt = false): StartAction[] {
  if (!intent) return ['example'];
  if (intent === 'convert') return ['convert' as StartAction, ...INTENT_STARTS[hasDbt ? 'drawFromDbt' : 'blank']].slice(0, MAX_STARTS);
  return [...INTENT_STARTS[intent]];
}

/**
 * The starts to offer, primary first: {@link INTENT_STARTS} of the folder's
 * {@link startIntentFor}. An empty window offers only the example (it opens in
 * a folder of its own; everything else needs a folder first).
 */
export function startActionsFor(ctx: StartContext): StartAction[] {
  return startActionsForIntent(startIntentFor(ctx), ctx.hasDbt);
}

/**
 * The one-line reason the Welcome panel's start card gives for its primary
 * start, when the folder's files suggested it. Counts and kinds only, never a
 * file name. The other intents explain themselves (their card's own text).
 */
export const START_INTENT_REASONS: Readonly<Partial<Record<StartIntent, string>>> = {
  importSemanticModel: 'This folder has a Power BI or Fabric semantic model.',
  importSqlDdl: 'This folder has CREATE TABLE scripts.',
  importDbmlFile: 'This folder has a DBML file.',
};

export function isStartIntent(value: unknown): value is StartIntent {
  return (START_INTENTS as readonly unknown[]).includes(value);
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

// ---------------------------------------------------------------------------
// "Watch how": one short clip per suggestion on the Welcome panel's start card
// ---------------------------------------------------------------------------

/** Where the clips live, relative to the extension root (under the Welcome panel's media folder). */
export const HOW_TO_CLIP_DIR = ['media', 'onboarding', 'stories'] as const;

/**
 * What a "Watch how" clip shows: the start each suggestion leads with (Convert
 * has none: its panel lists every change before anything is written), and
 * the example the page offers with no folder open (no suggestion there).
 */
export type HowToClipKey = Exclude<StartIntent, 'convert'> | 'example';
export const HOW_TO_CLIP_KEYS: readonly HowToClipKey[] = ['example', 'blank', 'importSqlDdl', 'importSemanticModel', 'importDbmlFile', 'drawFromDbt'];

/**
 * The clip for each: a short onboarding story video, narrated (MP3) with its
 * captions burned in, published by `node test/stories/run.mjs --record --publish`
 * (`test/stories/lib/publish.mjs` names the story behind each). No poster
 * file: the clip loads its metadata, so its first frame shows (fewer files in
 * the VSIX). The panel shows the slot only when the clip is in the extension.
 */
export const HOW_TO_CLIPS: Readonly<Record<HowToClipKey, string>> = {
  example: 'open-an-example.mp4',
  blank: 'start-a-blank-diagram.mp4',
  importSqlDdl: 'import-sql-scripts.mp4',
  importSemanticModel: 'import-power-bi-model.mp4',
  importDbmlFile: 'import-a-dbml-file.mp4',
  drawFromDbt: 'draw-from-dbt.mp4',
};

/** The clip a Welcome page shows: the example with no folder open, else its suggestion's (none for Convert). */
export function howToClipFor(hasProject: boolean, intent: StartIntent | undefined): HowToClipKey | undefined {
  if (!hasProject) return 'example';
  return intent && intent !== 'convert' ? intent : undefined;
}
