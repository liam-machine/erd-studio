/**
 * The start screen (src/types/startActions.ts, src/commands/start.ts): which
 * starts each window offers, the one door they all go through, the funnel key
 * each click counts, and that the walkthrough and the sidebar's welcome views
 * offer exactly the starts the rule says — so the surfaces cannot drift apart.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  INTENT_STARTS,
  START_ACTIONS,
  START_ACTION_COMMANDS,
  START_COMMAND,
  START_INTENTS,
  START_INTENT_CONTEXT_KEY,
  START_SURFACES,
  isStartIntent,
  parseStartArgs,
  startActionsFor,
  startActionsForIntent,
  startCommandLink,
  startIntentFor,
  startNeedsLook,
  type DetectedImportSource,
  type StartAction,
  type StartContext,
  type StartIntent,
  type StartStorage,
} from '../../src/types/startActions';
import {
  START_FEATURES, START_INTENT_FEATURES, START_PICK_GUIDE_ITEM, START_PICK_ITEMS, recordStart, recordStartSuggested, runStart,
  type StartPickGuideItem, type StartPickItem,
} from '../../src/commands/start';
import { START_LABELS } from '../../src/types/gettingStarted';
import { IMPORT_MODEL_SOURCES } from '../../src/services/importSources';
import { FEATURES } from '../../src/services/telemetryPayload';
import { telemetry } from '../../src/services/telemetryService';
import { evalWhen, type WhenContext } from './helpers/whenClause';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as {
  contributes: {
    commands: Array<{ command: string; icon?: string }>;
    menus: { commandPalette: Array<{ command: string; when?: string }>; 'view/title': Array<{ command?: string; when?: string; group?: string }> };
    viewsWelcome: Array<{ view: string; contents: string; when?: string }>;
    walkthroughs: Array<{ steps: Array<{ id: string; description: string; when?: string; completionEvents?: string[] }> }>;
  };
};

/** Every start link in a piece of markdown, as `{ action, from }`, in order. */
function startLinks(markdown: string): Array<{ action: StartAction; from: string }> {
  return [...markdown.matchAll(/\(command:erdStudio\.start\?([^)]*)\)/g)].map(([, query]) => {
    const args = JSON.parse(decodeURIComponent(query)) as unknown[];
    expect(Array.isArray(args) && args.length === 1, query).toBe(true);
    const parsed = parseStartArgs(args[0]);
    expect(parsed, query).toBeDefined();
    return parsed!;
  });
}

afterEach(() => vi.restoreAllMocks());

const SOME_FOUND: ReadonlyArray<readonly DetectedImportSource[]> = [
  [], ['semanticModel'], ['sqlDdl'], ['dbml'], ['sqlDdl', 'dbml'], ['dbml', 'semanticModel'], ['dbml', 'sqlDdl', 'semanticModel'],
];
const STORAGES: ReadonlyArray<StartStorage | undefined> = [undefined, 'dbml', 'yaml', 'mixed'];

describe('startIntentFor: the strongest signal wins', () => {
  // [context, intent]: convert > drawFromDbt > importSemanticModel > importSqlDdl > importDbmlFile > blank.
  const table: Array<[StartContext, StartIntent | undefined]> = [
    [{ hasProject: false, hasDbt: false }, undefined],
    [{ hasProject: false, hasDbt: true, storage: 'yaml', found: ['sqlDdl'] }, undefined],
    [{ hasProject: true, hasDbt: false }, 'blank'],
    [{ hasProject: true, hasDbt: false, storage: 'dbml', found: [] }, 'blank'],
    [{ hasProject: true, hasDbt: false, storage: 'yaml' }, 'convert'],
    [{ hasProject: true, hasDbt: true, storage: 'mixed', found: ['semanticModel'] }, 'convert'],
    [{ hasProject: true, hasDbt: false, storage: 'yaml', found: ['sqlDdl'], hasDiagrams: true }, 'convert'],
    [{ hasProject: true, hasDbt: true }, 'drawFromDbt'],
    [{ hasProject: true, hasDbt: true, storage: 'dbml', found: ['sqlDdl', 'semanticModel', 'dbml'] }, 'drawFromDbt'],
    [{ hasProject: true, hasDbt: false, found: ['semanticModel'] }, 'importSemanticModel'],
    [{ hasProject: true, hasDbt: false, found: ['dbml', 'sqlDdl', 'semanticModel'] }, 'importSemanticModel'],
    [{ hasProject: true, hasDbt: false, found: ['sqlDdl'] }, 'importSqlDdl'],
    [{ hasProject: true, hasDbt: false, found: ['dbml', 'sqlDdl'] }, 'importSqlDdl'],
    [{ hasProject: true, hasDbt: false, found: ['dbml'] }, 'importDbmlFile'],
    [{ hasProject: true, hasDbt: false, storage: 'dbml', found: new Set<DetectedImportSource>(['dbml']) }, 'importDbmlFile'],
    // A project that already has a diagram has started: its files no longer decide.
    [{ hasProject: true, hasDbt: false, found: ['sqlDdl'], hasDiagrams: true }, 'blank'],
    [{ hasProject: true, hasDbt: true, found: ['sqlDdl'], hasDiagrams: true }, 'drawFromDbt'],
  ];
  it.each(table)('%j → %s', (ctx, intent) => {
    expect(startIntentFor(ctx)).toBe(intent);
  });

  it('looks at the folder only when its files can decide: a DBML (or new) project, no dbt, no diagram yet', () => {
    expect(startNeedsLook({ hasProject: true, hasDbt: false })).toBe(true);
    expect(startNeedsLook({ hasProject: true, hasDbt: false, storage: 'dbml' })).toBe(true);
    for (const ctx of [
      { hasProject: false, hasDbt: false }, { hasProject: true, hasDbt: true }, { hasProject: true, hasDbt: false, storage: 'yaml' as const },
      { hasProject: true, hasDbt: false, storage: 'mixed' as const }, { hasProject: true, hasDbt: false, hasDiagrams: true },
    ]) {
      expect(startNeedsLook(ctx), JSON.stringify(ctx)).toBe(false);
    }
  });

  it('reads the same source ids as Import… finds', () => {
    expect([...IMPORT_MODEL_SOURCES].sort()).toEqual(['dbml', 'semanticModel', 'sqlDdl']);
    expect(START_INTENTS.every(isStartIntent)).toBe(true);
    expect(isStartIntent('import')).toBe(false);
  });
});

describe('startActionsFor', () => {
  it('offers a plain folder with nothing to import New Diagram, then the example, then Import…', () => {
    expect(startActionsFor({ hasProject: true, hasDbt: false })).toEqual(['blank', 'example', 'import']);
    expect(startActionsFor({ hasProject: true, hasDbt: false, storage: 'dbml', found: [] })).toEqual(['blank', 'example', 'import']);
  });

  it('puts the import the folder suggests first, going straight to that source, with Import… kept as a secondary', () => {
    expect(startActionsFor({ hasProject: true, hasDbt: false, found: ['sqlDdl'] })).toEqual(['importSqlDdl', 'blank', 'import', 'example']);
    expect(startActionsFor({ hasProject: true, hasDbt: false, found: ['semanticModel'] })).toEqual(['importSemanticModel', 'blank', 'import', 'example']);
    expect(startActionsFor({ hasProject: true, hasDbt: false, found: ['dbml'] })).toEqual(['importDbmlFile', 'blank', 'import', 'example']);
    expect(START_ACTION_COMMANDS.importSqlDdl).toBe('erdStudio.importSqlDdl');
    expect(START_ACTION_COMMANDS.importSemanticModel).toBe('erdStudio.importSemanticModel');
    expect(START_ACTION_COMMANDS.importDbmlFile).toBe('erdStudio.importDbml');
  });

  it('puts Draw from dbt first in a dbt project', () => {
    expect(startActionsFor({ hasProject: true, hasDbt: true, storage: 'dbml' })).toEqual(['drawFromDbt', 'blank', 'import', 'example']);
  });

  it('offers a project from before 2.0 Convert first, then what it would otherwise offer, cut to four', () => {
    expect(startActionsFor({ hasProject: true, hasDbt: false, storage: 'yaml' })).toEqual(['convert', 'blank', 'example', 'import']);
    expect(startActionsFor({ hasProject: true, hasDbt: true, storage: 'mixed' })).toEqual(['convert', 'drawFromDbt', 'blank', 'import']);
    // Its files are never looked at: a pre-2.0 project is suggested Convert whatever it holds.
    expect(startActionsFor({ hasProject: true, hasDbt: false, storage: 'yaml', found: ['sqlDdl'] })).toEqual(['convert', 'blank', 'example', 'import']);
  });

  it('offers an empty window only the example, which opens in a folder of its own', () => {
    expect(startActionsFor({ hasProject: false, hasDbt: false })).toEqual(['example']);
    expect(startActionsFor({ hasProject: false, hasDbt: true, storage: 'yaml' })).toEqual(['example']);
  });

  it('is always short: the suggestion first, then at most three more, no start twice', () => {
    for (const intent of START_INTENTS) for (const hasDbt of [false, true]) {
      const starts = startActionsForIntent(intent, hasDbt);
      expect(starts[0], intent).toBe(intent);
      expect(starts.length, intent).toBeLessThanOrEqual(4);
      expect(new Set(starts).size, intent).toBe(starts.length);
      if (intent !== 'convert') expect(starts, intent).toEqual([...INTENT_STARTS[intent]]);
      // The generic Import… stays reachable wherever a folder's own files are suggested.
      if (intent.startsWith('import')) expect(starts, intent).toContain('import');
    }
    for (const storage of STORAGES) for (const found of SOME_FOUND) for (const hasDbt of [false, true]) for (const hasDiagrams of [false, true]) {
      const starts = startActionsFor({ hasProject: true, hasDbt, storage, found, hasDiagrams });
      expect(starts.length).toBeLessThanOrEqual(4);
      expect(starts[0]).toBe(startIntentFor({ hasProject: true, hasDbt, storage, found, hasDiagrams }));
    }
  });
});

describe('parseStartArgs / startCommandLink', () => {
  it('accepts exactly a known action from a known surface', () => {
    expect(parseStartArgs({ action: 'blank', from: 'sidebar' })).toEqual({ action: 'blank', from: 'sidebar' });
    for (const bad of [undefined, null, 'blank', [{ action: 'blank', from: 'sidebar' }], { action: 'blank' },
      { action: 'deleteEverything', from: 'sidebar' }, { action: 'blank', from: 'https://example.com' }, { action: 'toString', from: 'welcome' }]) {
      expect(parseStartArgs(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('builds a command link whose argument parses back', () => {
    for (const action of START_ACTIONS) {
      for (const from of ['walkthrough', 'sidebar'] as const) {
        expect(startLinks(`[x](${startCommandLink(action, from)})`)).toEqual([{ action, from }]);
      }
    }
  });
});

describe('erdStudio.start', () => {
  it('has a funnel key per start per surface, each in the telemetry allowlist, all distinct', () => {
    const keys = START_SURFACES.flatMap((from) => START_ACTIONS.map((action) => START_FEATURES[from][action]));
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(FEATURES).toContain(key);
    // The Welcome panel's Draw from dbt keeps the key it has always counted.
    expect(START_FEATURES.welcome.drawFromDbt).toBe('welcomeDrawFromDbt');
    // The direct imports are named for the start, never for a file.
    expect(START_FEATURES.sidebar.importSqlDdl).toBe('sidebarImportSqlDdl');
    // A surface's key starts with the surface's name (the funnel query reads them by prefix).
    for (const from of START_SURFACES) for (const action of START_ACTIONS) expect(START_FEATURES[from][action].startsWith(from)).toBe(true);
  });

  it('counts each suggestion shown under its own fixed key, once a day, outside the click prefixes', () => {
    const keys = START_INTENTS.map((i) => START_INTENT_FEATURES[i]);
    expect(keys).toEqual([
      'startSuggestedConvert', 'startSuggestedDrawFromDbt', 'startSuggestedImportSemanticModel',
      'startSuggestedImportSqlDdl', 'startSuggestedImportDbmlFile', 'startSuggestedBlank',
    ]);
    for (const key of keys) expect(FEATURES).toContain(key);
    const once = vi.spyOn(telemetry, 'featureOnce');
    recordStartSuggested('importSqlDdl');
    expect(once.mock.calls).toEqual([['startSuggestedImportSqlDdl']]);
  });

  it('counts where the click came from, then runs the real command with no argument', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const executeCommand = vi.fn(async () => undefined);
    const pick = vi.fn();
    await runStart({ action: 'example', from: 'sidebar' }, { context: () => ({ hasProject: false, hasDbt: false }), executeCommand, pick });
    expect(feature).toHaveBeenCalledWith('sidebarExample');
    expect(executeCommand).toHaveBeenCalledWith('erdStudio.openExampleProject');
    expect(executeCommand.mock.calls[0]).toHaveLength(1);
    expect(pick).not.toHaveBeenCalled();
  });

  it('without a valid argument, asks which start (from the same rule) and counts nothing', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const executeCommand = vi.fn(async () => undefined);
    const pick = vi.fn(async (items: Array<{ action?: StartAction }>) => items[1] as { action: StartAction });
    await runStart(undefined, { context: () => ({ hasProject: true, hasDbt: true }), executeCommand, pick });
    // The starts, then the import guide last.
    expect(pick.mock.calls[0][0].map((i: { action?: StartAction }) => i.action)).toEqual(['drawFromDbt', 'blank', 'import', 'example', undefined]);
    expect(pick.mock.calls[0][0].at(-1)).toEqual(START_PICK_GUIDE_ITEM);
    expect(executeCommand).toHaveBeenCalledWith('erdStudio.createDomain');
    expect(feature).not.toHaveBeenCalled();

    // The pick follows the folder's suggestion too.
    const suggested = vi.fn(async (items: Array<{ action?: StartAction }>) => items[0] as { action: StartAction });
    const ran = vi.fn(async () => undefined);
    await runStart(undefined, { context: () => ({ hasProject: true, hasDbt: false, found: ['sqlDdl'] }), executeCommand: ran, pick: suggested });
    expect(suggested.mock.calls[0][0].map((i: { action?: StartAction }) => i.action)).toEqual(['importSqlDdl', 'blank', 'import', 'example', undefined]);
    // A direct import runs its quick path (defaults chosen), ending in its draft (trigger `start`).
    expect(ran).toHaveBeenCalledWith('erdStudio.importSqlDdl', { quick: true, draft: 'start' });

    const closed = vi.fn(async () => undefined);
    await runStart({ action: 'nope' }, { context: () => ({ hasProject: true, hasDbt: false }), executeCommand: closed, pick: closed });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('the quick pick ends with the import guide, which opens it from the start pick and counts no start', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const executeCommand = vi.fn(async (..._args: unknown[]) => undefined);
    const pick = vi.fn(async (items: Array<StartPickItem | StartPickGuideItem>) => items[items.length - 1]);
    await runStart(undefined, { context: () => ({ hasProject: false, hasDbt: false }), executeCommand, pick });
    expect(pick.mock.calls[0][0].map((i) => i.label)).toEqual([
      '$(book) Open an Example…', '$(question) How do I export from Databricks, Snowflake, Power BI…?',
    ]);
    expect(executeCommand.mock.calls).toEqual([['erdStudio.showImportGuide', { from: 'startPick' }]]);
    expect(feature).not.toHaveBeenCalled();
  });

  it('records one key for recordStart', () => {
    const feature = vi.spyOn(telemetry, 'feature');
    recordStart('convert', 'welcome');
    expect(feature.mock.calls).toEqual([['welcomeConvert']]);
  });

  it('is contributed (so a link activates the extension) but hidden from the palette; every target command is contributed', () => {
    const contributed = pkg.contributes.commands.map((c) => c.command);
    expect(contributed).toContain(START_COMMAND);
    expect(pkg.contributes.menus.commandPalette).toContainEqual({ command: START_COMMAND, when: 'false' });
    for (const command of Object.values(START_ACTION_COMMANDS)) expect(contributed, command).toContain(command);
    for (const action of START_ACTIONS) expect(START_PICK_ITEMS[action].label.length).toBeGreaterThan(0);
  });
});

describe('the start surfaces in package.json', () => {
  const step = (id: string) => pkg.contributes.walkthroughs[0].steps.find((s) => s.id === id)!;
  const diagramsWelcome = pkg.contributes.viewsWelcome.filter((w) => w.view === 'erdStudio.domainTree');

  /** A link alone on its line: VS Code draws it as a button. */
  const buttons = (md: string) => md.split('\n').filter((line) => /^\[[^\]]+\]\(command:erdStudio\.start\?[^)]*\)$/.test(line));
  const buttonLabel = (line: string) => /^\[([^\]]+)\]/.exec(line)![1];

  /** `waiting`: the empty Diagrams view shows "Loading diagrams…" until the look publishes the suggestion. */
  interface Window { name: string; keys: WhenContext; starts: StartAction[]; waiting?: boolean }

  /**
   * Every window a start surface can be seen in, with the context keys the
   * host sets and the starts the rule gives there: an empty window, then each
   * dbt / storage / what-the-look-found combination, both before the look
   * has published `erdStudio.startIntent` and after.
   */
  const windows: Window[] = [{ name: 'empty window', keys: { workspaceFolderCount: 0 }, starts: startActionsFor({ hasProject: false, hasDbt: false }) }];
  for (const hasDbt of [false, true]) for (const storage of STORAGES) for (const found of SOME_FOUND) for (const looked of [false, true]) {
    const ctx: StartContext = { hasProject: true, hasDbt, storage, hasDiagrams: false, found: looked ? found : undefined };
    const intent = startIntentFor(ctx);
    windows.push({
      name: `${hasDbt ? 'dbt' : 'plain'} ${storage ?? 'no storage key'} found=[${found.join(',')}] ${looked ? `published ${intent}` : 'not looked yet'}`,
      keys: {
        workspaceFolderCount: 1,
        'erdStudio.hasProject': true,
        'erdStudio.hasDbtProject': hasDbt,
        'erdStudio.diagramsLoading': false,
        'erdStudio.hasDiagrams': false,
        ...(storage ? { 'erdStudio.storage': storage } : {}),
        ...(looked ? { [START_INTENT_CONTEXT_KEY]: intent } : {}),
      },
      starts: startActionsFor(ctx),
      // A folder without dbt whose files can decide: no start shows before the suggestion
      // (New Diagram first, then an import under the cursor, was the flash this prevents).
      waiting: !looked && !hasDbt && storage !== 'yaml' && storage !== 'mixed',
    });
  }

  it('every start link anywhere is valid and names its own surface', () => {
    for (const w of pkg.contributes.viewsWelcome) for (const link of startLinks(w.contents)) expect(link.from).toBe('sidebar');
    for (const s of pkg.contributes.walkthroughs[0].steps) for (const link of startLinks(s.description)) expect(link.from).toBe('walkthrough');
  });

  it.each(windows)('the empty Diagrams view offers exactly the rule\'s starts, one button for the suggestion: $name', ({ keys, starts, waiting }) => {
    const shown = diagramsWelcome.filter((w) => evalWhen(w.when, keys));
    if (waiting) {
      // Until the suggestion is published: Loading, and no start that may change under the cursor.
      expect(shown.map((w) => w.contents)).toEqual(['Loading diagrams…']);
      return;
    }
    const links = shown.flatMap((w) => startLinks(w.contents).map((l) => l.action));
    expect(links).toEqual(starts);
    if (keys.workspaceFolderCount === 0) {
      // Open Folder (VS Code's own command) is the empty window's button; the example a link.
      expect(shown.flatMap((w) => w.contents.split('\n')).filter((l) => /^\[[^\]]+\]\([^)]*\)$/.test(l))).toEqual(['[Open Folder](command:workbench.action.files.openFolder)']);
      return;
    }
    const startButtons = shown.flatMap((w) => buttons(w.contents));
    expect(startButtons).toHaveLength(1);
    expect(startLinks(startButtons[0])[0].action).toBe(starts[0]);
  });

  it.each(windows)('the empty Diagrams view has one button in all, and the tour as a quiet link: $name', ({ keys, waiting }) => {
    // Any link alone on its line is a full-width button: "Get started" used
    // to be one, a second blue button beside the start (onboarding story 03).
    if (waiting) return; // Loading diagrams… (above)
    const shown = diagramsWelcome.filter((w) => evalWhen(w.when, keys));
    const anyButtons = shown.flatMap((w) => w.contents.split('\n')).filter((l) => /^\[[^\]]+\]\([^)]*\)$/.test(l));
    expect(anyButtons).toHaveLength(1);
    // Convert's entry keeps to Convert and the other starts; the ▶ button is above it.
    const converting = keys['erdStudio.storage'] === 'yaml' || keys['erdStudio.storage'] === 'mixed';
    if (!converting) expect(shown.map((w) => w.contents).join('\n')).toContain('](command:erdStudio.showGettingStarted)');
  });

  it('the Welcome tab is one click away in an empty window: the Diagrams view\'s ▶ button', () => {
    // The Welcome tab's footer names it ("ERD Studio sidebar ▶ button"); in a project it is Help & Feedback's ▶ row.
    const play = pkg.contributes.menus['view/title'].find((m) => m.command === 'erdStudio.showGettingStarted');
    expect(play).toEqual({ command: 'erdStudio.showGettingStarted', when: 'view == erdStudio.domainTree && !erdStudio.hasProject', group: expect.stringMatching(/^navigation/) });
    expect(pkg.contributes.commands.find((c) => c.command === 'erdStudio.showGettingStarted')?.icon).toBe('$(play-circle)');
  });

  it.each(windows)('the walkthrough offers the same starts in one start step, its button the suggestion: $name', ({ keys, starts }) => {
    const shown = pkg.contributes.walkthroughs[0].steps.filter((s) => evalWhen(s.when, keys));
    const withStarts = shown.filter((s) => startLinks(s.description).length > 0);
    expect(withStarts).toHaveLength(1);
    expect(startLinks(withStarts[0].description).map((l) => l.action)).toEqual(starts);
    if (keys.workspaceFolderCount === 0) return; // Open Folder is that step's button (VS Code's own command).
    const startButtons = buttons(withStarts[0].description);
    expect(startButtons).toHaveLength(1);
    expect(startLinks(startButtons[0])[0].action).toBe(starts[0]);
  });

  it('a direct import\'s button says what the Welcome panel and the quick pick say, and its step completes on that import', () => {
    for (const intent of ['importSemanticModel', 'importSqlDdl', 'importDbmlFile'] as const) {
      const entry = diagramsWelcome.find((w) => w.when?.includes(`${START_INTENT_CONTEXT_KEY} == ${intent}`))!;
      expect(buttons(entry.contents).map(buttonLabel)).toEqual([START_LABELS[intent]]);
      expect(buttons(step(intent).description).map(buttonLabel)).toEqual([START_LABELS[intent]]);
      expect(START_PICK_ITEMS[intent].label).toContain(START_LABELS[intent]);
      expect(step(intent).completionEvents).toContain(`onCommand:${START_ACTION_COMMANDS[intent]}`);
      expect(step(intent).completionEvents).toContain('onCommand:erdStudio.start');
      // The kind of file only, never its name.
      expect(entry.contents).not.toMatch(/\.(sql|bim|pbip|tmdl)\b/);
    }
  });

  it('gates every start variant on context keys the host sets (no stray key)', () => {
    const keys = new Set<string>();
    for (const w of diagramsWelcome) for (const [, key] of (w.when ?? '').matchAll(/(erdStudio\.[A-Za-z]+)/g)) keys.add(key);
    for (const s of pkg.contributes.walkthroughs[0].steps) for (const [, key] of (s.when ?? '').matchAll(/(erdStudio\.[A-Za-z]+)/g)) keys.add(key);
    expect([...keys].sort()).toEqual([
      'erdStudio.diagramsLoading', 'erdStudio.hasDbtProject', 'erdStudio.hasDiagrams', 'erdStudio.hasMultipleDbtProjects',
      'erdStudio.hasProject', 'erdStudio.startIntent', 'erdStudio.storage',
    ]);
  });
});
