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
  IMPORT_GUIDE_LABEL,
  INTENT_STARTS,
  MORE_STARTS_LABEL,
  OPEN_FOLDER_LABEL,
  START_ACTIONS,
  START_ACTION_LABELS,
  START_ACTION_COMMANDS,
  START_COMMAND,
  START_INTENTS,
  START_INTENT_CONTEXT_KEY,
  START_SURFACES,
  TOUR_LABEL,
  isStartIntent,
  moreStartsCommandLink,
  moreStartsFor,
  parseStartArgs,
  parseStartPickArgs,
  startActionsFor,
  startActionsForIntent,
  startCommandLink,
  startIntentFor,
  startNeedsLook,
  stepTitleOf,
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
import { DRAFT_OTHER_START_LABELS } from '../../src/services/draftModel';
import { HELP_ACTIONS } from '../../src/providers/HelpTreeProvider';
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
  return [...markdown.matchAll(/\(command:erdStudio\.start\?([^)]*)\)/g)].flatMap(([, query]) => {
    const args = JSON.parse(decodeURIComponent(query)) as unknown[];
    expect(Array.isArray(args) && args.length === 1, query).toBe(true);
    // A "More ways to start…" link: `{ from }` alone, checked by the surface tests.
    if (parseStartPickArgs(args[0])) return [];
    const parsed = parseStartArgs(args[0]);
    expect(parsed, query).toBeDefined();
    return [parsed!];
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

  it('puts Import from dbt first in a dbt project', () => {
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
    // The Welcome panel's Import from dbt keeps the key it has always counted.
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
      '$(book) Open an Example…', '$(question) Bring In Your Data Model…',
    ]);
    expect(executeCommand.mock.calls).toEqual([['erdStudio.showImportGuide', { from: 'startPick' }]]);
    expect(feature).not.toHaveBeenCalled();
  });

  it('"More ways to start…" offers the starts other than the surface\'s button, counted as that surface\'s', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const executeCommand = vi.fn(async (..._args: unknown[]) => undefined);
    const second = vi.fn(async (items: Array<StartPickItem | StartPickGuideItem>) => items[1]);
    await runStart({ from: 'sidebar' }, { context: () => ({ hasProject: true, hasDbt: false, found: ['sqlDdl'] }), executeCommand, pick: second });
    // The suggestion is the view's button: the pick holds the rest, then the guide.
    expect(second.mock.calls[0][0].map((i) => ('action' in i ? i.action : 'guide'))).toEqual(['blank', 'import', 'example', 'guide']);
    expect(feature.mock.calls).toEqual([['sidebarImport']]);
    expect(executeCommand.mock.calls).toEqual([['erdStudio.importModel']]);

    // The guide, opened from the walkthrough's link, says so.
    const guide = vi.fn(async (items: Array<StartPickItem | StartPickGuideItem>) => items[items.length - 1]);
    const ran = vi.fn(async (..._args: unknown[]) => undefined);
    await runStart({ from: 'walkthrough' }, { context: () => ({ hasProject: true, hasDbt: true }), executeCommand: ran, pick: guide });
    expect(guide.mock.calls[0][0].map((i) => ('action' in i ? i.action : 'guide'))).toEqual(['blank', 'import', 'example', 'guide']);
    expect(ran.mock.calls).toEqual([['erdStudio.showImportGuide', { from: 'walkthrough' }]]);

    // An empty window: its button is Open Folder…, so the pick keeps the example.
    expect(moreStartsFor({ hasProject: false, hasDbt: false })).toEqual(['example']);
    expect(parseStartPickArgs({ from: 'welcome' })).toBeUndefined();
    expect(parseStartPickArgs({ from: 'sidebar', action: 'blank' })).toBeUndefined();
    expect(parseStartPickArgs(JSON.parse(decodeURIComponent(moreStartsCommandLink('walkthrough').split('?')[1]))[0])).toBe('walkthrough');
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

  /** A link alone on its line (paragraph): VS Code draws it as a full-width button. */
  const isButtonLine = (line: string) => /^\[[^\]]+\]\([^)]*\)$/.test(line.trim());
  const buttonLines = (md: string) => md.split('\n').filter(isButtonLine);
  const labelOf = (line: string) => /\[([^\]]+)\]/.exec(line)![1];
  /** Every markdown link: `[label](target)`. */
  const allLinks = (md: string) => [...md.matchAll(/\[([^\]]+)\]\(([^)]*)\)/g)].map(([, label, target]) => ({ label, target }));
  /** The text a reader reads: link labels kept, targets dropped, the button line left out. */
  const proseLines = (md: string) => md.split('\n').filter((l) => l.trim() !== '' && !isButtonLine(l)).map((l) => l.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'));
  const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

  /** `waiting`: the empty Diagrams view shows "Loading diagrams…" until the look publishes the suggestion. */
  interface Window { name: string; keys: WhenContext; ctx: StartContext; starts: StartAction[]; waiting?: boolean }

  /**
   * Every window a start surface can be seen in, with the context keys the
   * host sets and the starts the rule gives there: an empty window, then each
   * dbt / storage / what-the-look-found combination, both before the look
   * has published `erdStudio.startIntent` and after.
   */
  const emptyCtx: StartContext = { hasProject: false, hasDbt: false };
  const windows: Window[] = [{ name: 'empty window', keys: { workspaceFolderCount: 0 }, ctx: emptyCtx, starts: startActionsFor(emptyCtx) }];
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
      ctx,
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

  /**
   * The one shape every start surface has: the suggestion's button (an empty
   * window's: Open Folder…), labelled with its action's one label, and one
   * quiet "More ways to start…" link (inside a sentence, so never a second
   * button) to the rest of the rule's starts.
   */
  function expectStartShape(md: string, w: Window, from: 'sidebar' | 'walkthrough'): void {
    const btns = buttonLines(md);
    expect(btns, md).toHaveLength(1);
    if (w.keys.workspaceFolderCount === 0) {
      expect(btns[0]).toBe(`[${OPEN_FOLDER_LABEL}](command:workbench.action.files.openFolder)`);
    } else {
      expect(startLinks(btns[0]).map((l) => l.action)).toEqual([w.starts[0]]);
      expect(labelOf(btns[0])).toBe(START_ACTION_LABELS[w.starts[0]]);
    }
    const others = allLinks(md).filter((l) => !btns[0].includes(`(${l.target})`));
    expect(others).toEqual([{ label: MORE_STARTS_LABEL, target: moreStartsCommandLink(from) }]);
    // What that link offers, with the button, is exactly the rule's starts.
    const offered = w.keys.workspaceFolderCount === 0 ? moreStartsFor(w.ctx) : [w.starts[0], ...moreStartsFor(w.ctx)];
    expect(offered).toEqual(w.starts);
  }

  it.each(windows)('the empty Diagrams view: one button for the suggestion and one "More ways to start…" link: $name', (w) => {
    const shown = diagramsWelcome.filter((e) => evalWhen(e.when, w.keys));
    if (w.waiting) {
      // Until the suggestion is published: Loading, and no start that may change under the cursor.
      expect(shown.map((e) => e.contents)).toEqual(['Loading diagrams…']);
      return;
    }
    expect(shown).toHaveLength(1);
    expectStartShape(shown[0].contents, w, 'sidebar');
  });

  it.each(windows)('the empty Diagrams view stays short: at most two short lines, no question: $name', ({ keys, waiting }) => {
    if (waiting) return;
    for (const entry of diagramsWelcome.filter((e) => evalWhen(e.when, keys))) {
      const prose = proseLines(entry.contents);
      expect(prose.length, entry.contents).toBeLessThanOrEqual(2);
      expect(words(prose.join(' ')), entry.contents).toBeLessThanOrEqual(22);
      expect(prose.join(' '), 'no rhetorical questions').not.toContain('?');
    }
  });

  it.each(windows)('the walkthrough has one start step, the same shape, its title the action\'s label: $name', (w) => {
    const shown = pkg.contributes.walkthroughs[0].steps.filter((s) => evalWhen(s.when, w.keys));
    const withStarts = shown.filter((s) => allLinks(s.description).some((l) => l.target.startsWith(`command:${START_COMMAND}`)));
    expect(withStarts).toHaveLength(1);
    const start = withStarts[0] as { title?: string; description: string };
    expectStartShape(start.description, w, 'walkthrough');
    if (w.keys.workspaceFolderCount !== 0) expect(start.title).toBe(stepTitleOf(START_ACTION_LABELS[w.starts[0]]));
  });

  it('every walkthrough step stays short: one button, at most one other link, no question', () => {
    const steps = pkg.contributes.walkthroughs[0].steps as Array<{ id: string; title: string; description: string }>;
    for (const s of steps) {
      expect(buttonLines(s.description), s.id).toHaveLength(1);
      expect(allLinks(s.description).length, s.id).toBeLessThanOrEqual(2);
      expect(words(proseLines(s.description).join(' ')), s.id).toBeLessThanOrEqual(32);
      expect(proseLines(s.description).join(' '), s.id).not.toContain('?');
    }
    // The walkthrough's subtitle fits VS Code's Welcome page without being cut off.
    const { description } = pkg.contributes.walkthroughs[0] as unknown as { description: string };
    expect(description.length).toBeLessThanOrEqual(60);
  });

  it('the Welcome tab is one click away in an empty window: the Diagrams view\'s ▶ button', () => {
    // The tab's footer names it ("ERD Studio sidebar ▶ button"); in a project it is Help & Feedback's ▶ row.
    const play = pkg.contributes.menus['view/title'].find((m) => m.command === 'erdStudio.showGettingStarted');
    expect(play).toEqual({ command: 'erdStudio.showGettingStarted', when: 'view == erdStudio.domainTree && !erdStudio.hasProject', group: expect.stringMatching(/^navigation/) });
    expect(pkg.contributes.commands.find((c) => c.command === 'erdStudio.showGettingStarted')?.icon).toBe('$(play-circle)');
  });

  it('a direct import\'s step completes on that import, and no surface names the file', () => {
    for (const intent of ['importSemanticModel', 'importSqlDdl', 'importDbmlFile'] as const) {
      const entry = diagramsWelcome.find((w) => w.when?.includes(`${START_INTENT_CONTEXT_KEY} == ${intent}`))!;
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

describe('one label per action, on every surface', () => {
  const titleOf = (id: string) => pkg.contributes.commands.find((c) => c.command === id) as { title?: string } | undefined;
  const allText = () => {
    const files = [
      'package.json',
      ...['src/types/startActions.ts', 'src/commands/start.ts', 'src/types/gettingStarted.ts', 'src/services/importGuide.ts', 'src/services/draftModel.ts',
        'src/services/startSuggestion.ts', 'src/providers/HelpTreeProvider.ts', 'src/extension.ts', 'webview-draft/lib/wording.ts'],
    ];
    return files.map((f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8')).join('\n');
  };

  it('every surface takes its label from START_ACTION_LABELS', () => {
    for (const action of START_ACTIONS) {
      expect(START_PICK_ITEMS[action].label.endsWith(` ${START_ACTION_LABELS[action]}`), action).toBe(true);
      expect(START_LABELS[action].replace('&hellip;', '…'), action).toBe(START_ACTION_LABELS[action]);
    }
    expect(DRAFT_OTHER_START_LABELS).toEqual({
      blank: START_ACTION_LABELS.blank, import: START_ACTION_LABELS.import, guide: IMPORT_GUIDE_LABEL,
      example: START_ACTION_LABELS.example, openFolder: OPEN_FOLDER_LABEL,
    });
    expect(START_PICK_GUIDE_ITEM.label).toBe(`$(question) ${IMPORT_GUIDE_LABEL}`);
  });

  it('the palette says the same words', () => {
    expect(titleOf('erdStudio.createDomain')?.title).toBe(START_ACTION_LABELS.blank);
    expect(titleOf('erdStudio.importModel')?.title).toBe(START_ACTION_LABELS.import);
    expect(titleOf('erdStudio.openExampleProject')?.title).toBe(START_ACTION_LABELS.example);
    expect(titleOf('erdStudio.showImportGuide')?.title).toBe(IMPORT_GUIDE_LABEL);
    expect(titleOf('erdStudio.showGettingStarted')?.title).toBe(TOUR_LABEL);
    expect(HELP_ACTIONS.find((a) => a.command === 'erdStudio.showGettingStarted')?.label).toBe(TOUR_LABEL);
  });

  it('no surface keeps an old name for an action or for the tour', () => {
    const text = allText();
    for (const old of [
      'See how to bring it in', 'Show Me How', 'Bring In an Existing Data Model', 'Bring In My Model', 'Start Blank', 'See an Example',
      'Other Ways to Start', 'Create Diagram', 'Start from your SQL scripts', 'Start your data model', 'Watch Getting Started Video',
      'Watch the video', 'one-minute dbt tour', 'Watch the One-Minute Tour', 'one-minute tour', 'Welcome to ERD Studio', 'Get started</a>', '[Get started]',
    ]) expect(text, old).not.toContain(old);
  });

  it('says "an open format, no lock-in" once, where DBML is introduced, and "Each table is a file in .erd-studio/" once', () => {
    const json = fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8');
    expect(json.split('no lock-in').length - 1).toBe(1);
    expect(pkg.contributes.viewsWelcome.find((w) => w.when === 'workspaceFolderCount == 0')!.contents).toContain('DBML files: an open format, no lock-in');
    const sources = [json, ...['src/types/gettingStarted.ts', 'src/services/importGuide.ts', 'webview/components/EmptyCanvas/EmptyCanvas.tsx', 'webview/components/Toolbar/Toolbar.tsx']
      .map((f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8'))].join('\n');
    expect(sources.split(/Each (?:table|one) is a file/).length - 1).toBe(1);
    expect(sources).not.toContain('(DBML, an open format, no lock-in; SQL DDL scripts; or a Power BI semantic model)');
    expect(sources).not.toContain('open formats, no lock-in');
  });
});
