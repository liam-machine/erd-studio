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

import type { DraftTrigger } from './draft';

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
 * One label per action, on every surface (the walkthrough, the empty
 * Diagrams view, the start quick pick, a draft's buttons, the Welcome tab,
 * `package.json`'s command titles): `docs/dev/onboarding-and-cli.md` →
 * "One label per action" lists them, and `test/unit/startActions.test.ts`
 * holds every surface to them. A walkthrough step's title is its action's
 * label without the ellipsis.
 */
export const START_ACTION_LABELS: Readonly<Record<StartAction, string>> = {
  convert: 'Convert to DBML…',
  drawFromDbt: 'Draw from dbt',
  importSemanticModel: 'Import your Power BI semantic model',
  importSqlDdl: 'Import your SQL scripts',
  importDbmlFile: 'Import your DBML file',
  blank: 'New Diagram…',
  import: 'Import…',
  example: 'Open an Example…',
};

/** The import guide (`erdStudio.showImportGuide`): its command title, its tab and every link to it. */
export const IMPORT_GUIDE_LABEL = 'Bring In Your Data Model…';
/** The one link under a start surface's button: the other starts, in a quick pick (`erdStudio.start` with `{ from }` alone). */
export const MORE_STARTS_LABEL = 'More ways to start…';
/** The start quick pick's title (the same words as the link that opens it). */
export const START_PICK_TITLE = 'More ways to start';
export const START_PICK_PLACEHOLDER = 'Choose how to start your data model';
/** The one name of the getting-started video, `erdStudio.showGettingStarted`'s title. */
export const TOUR_LABEL = 'Watch the One-Minute Tour';
/** Opening a folder, wherever ERD Studio offers it (VS Code's own command). */
export const OPEN_FOLDER_LABEL = 'Open Folder…';

/** A label as a walkthrough step's title: without its ellipsis. */
export function stepTitleOf(label: string): string {
  return label.replace(/…$/, '');
}

/**
 * What opened a start's draft (`DraftTrigger`, `src/types/draft.ts`), as a
 * command argument may carry it: a start surface or the start quick pick
 * (`start`), the start suggestion's Show Me (`prompt`). The automatic draft
 * (`sidebar`) is started by the host itself, never through an argument.
 */
export type StartDraftTrigger = Extract<DraftTrigger, 'start' | 'prompt'>;
const START_DRAFT_TRIGGERS: readonly StartDraftTrigger[] = ['start', 'prompt'];

/**
 * The argument a direct import gets from a start surface, the start
 * suggestion or the start quick pick: its **quick path** — every answer with
 * an obvious default is chosen (the files the folder holds, the dialect, the
 * layer, the name) — ending in the draft preview (Draft-first: nothing is
 * written until Keep), with Change options… for the step-by-step flow.
 * `draft` says what opened it (default `start`). The palette and Import…'s
 * picker run the commands without it: step by step, ending in a draft too.
 */
export interface QuickImportArg {
  quick: true;
  draft?: StartDraftTrigger;
}
export const QUICK_IMPORT_ARG: QuickImportArg = { quick: true };

/** Whether a command's argument asks for the quick path. */
export function isQuickImportArg(arg: unknown): arg is QuickImportArg {
  return typeof arg === 'object' && arg !== null && !Array.isArray(arg) && (arg as { quick?: unknown }).quick === true;
}

/**
 * The draft trigger a command's argument names (`{ draft: 'start' }`,
 * `{ quick: true, draft: 'prompt' }`), or undefined for anything else (the
 * palette, a file URI, a stray value).
 */
export function startDraftTriggerOf(arg: unknown): StartDraftTrigger | undefined {
  if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) return undefined;
  const draft = (arg as { draft?: unknown }).draft;
  return (START_DRAFT_TRIGGERS as readonly unknown[]).includes(draft) ? draft as StartDraftTrigger : undefined;
}

/** The starts whose command takes {@link QUICK_IMPORT_ARG}: the three direct imports. */
const QUICK_STARTS: ReadonlySet<StartAction> = new Set<StartAction>(['importSemanticModel', 'importSqlDdl', 'importDbmlFile']);

/**
 * The arguments {@link START_ACTION_COMMANDS}[action] runs with from a start:
 * a direct import's quick path, and for it and Draw from dbt the draft's
 * trigger (`start` by default, `prompt` for Show Me); none for the others.
 */
export function startActionArgs(action: StartAction, trigger: StartDraftTrigger = 'start'): unknown[] {
  if (QUICK_STARTS.has(action)) return [{ ...QUICK_IMPORT_ARG, draft: trigger }];
  if (action === 'drawFromDbt') return [{ draft: trigger }];
  return [];
}

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
 * What the {@link MORE_STARTS_LABEL} link offers: in a folder, every start but
 * the surface's button (the suggestion); in an empty window, whose button is
 * Open Folder…, every start there is (the example). The quick pick adds the
 * import guide last.
 */
export function moreStartsFor(ctx: StartContext): StartAction[] {
  const all = startActionsFor(ctx);
  return ctx.hasProject ? all.slice(1) : all;
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

/**
 * The surface a {@link MORE_STARTS_LABEL} link came from (`{ from }` with no
 * action), or undefined for anything else: the quick pick it opens counts
 * the start picked as that surface's (`START_FEATURES[from][action]`).
 */
export function parseStartPickArgs(arg: unknown): Exclude<StartSurface, 'welcome'> | undefined {
  if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) return undefined;
  const { action, from } = arg as Record<string, unknown>;
  if (action !== undefined) return undefined;
  return from === 'walkthrough' || from === 'sidebar' ? from : undefined;
}

/** A `command:` link for a walkthrough step or welcome view: runs {@link START_COMMAND} with `{ action, from }`. */
export function startCommandLink(action: StartAction, from: Exclude<StartSurface, 'welcome'>): string {
  return `command:${START_COMMAND}?${encodeURIComponent(JSON.stringify([{ action, from }]))}`;
}

/** The {@link MORE_STARTS_LABEL} link: {@link START_COMMAND} with `{ from }` alone opens the other starts in a quick pick. */
export function moreStartsCommandLink(from: Exclude<StartSurface, 'welcome'>): string {
  return `command:${START_COMMAND}?${encodeURIComponent(JSON.stringify([{ from }]))}`;
}

// ---------------------------------------------------------------------------
// The import guide: one quiet link on every start surface
// ---------------------------------------------------------------------------

/** **Bring In Your Data Model…** (`src/services/importGuide.ts`). */
export const IMPORT_GUIDE_COMMAND = 'erdStudio.showImportGuide';

/**
 * A `command:` link to the guide, saying where it was opened from. The start
 * surfaces no longer carry one: the guide is the last item of the
 * {@link MORE_STARTS_LABEL} quick pick (and of Import…'s picker).
 */
export function importGuideCommandLink(from: 'walkthrough' | 'sidebar'): string {
  return `command:${IMPORT_GUIDE_COMMAND}?${encodeURIComponent(JSON.stringify([{ from }]))}`;
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
