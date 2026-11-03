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
  START_ACTIONS,
  START_ACTION_COMMANDS,
  START_COMMAND,
  START_SURFACES,
  parseStartArgs,
  startActionsFor,
  startCommandLink,
  type StartAction,
} from '../../src/types/startActions';
import { START_FEATURES, START_PICK_ITEMS, recordStart, runStart } from '../../src/commands/start';
import { FEATURES } from '../../src/services/telemetryPayload';
import { telemetry } from '../../src/services/telemetryService';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as {
  contributes: {
    commands: Array<{ command: string }>;
    menus: { commandPalette: Array<{ command: string; when?: string }> };
    viewsWelcome: Array<{ view: string; contents: string; when?: string }>;
    walkthroughs: Array<{ steps: Array<{ id: string; description: string; when?: string }> }>;
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

describe('startActionsFor', () => {
  it('offers a plain folder three starts, blank first', () => {
    expect(startActionsFor({ hasProject: true, hasDbt: false })).toEqual(['blank', 'import', 'example']);
    expect(startActionsFor({ hasProject: true, hasDbt: false, storage: 'dbml' })).toEqual(['blank', 'import', 'example']);
  });

  it('puts Draw from dbt first in a dbt project', () => {
    expect(startActionsFor({ hasProject: true, hasDbt: true, storage: 'dbml' })).toEqual(['drawFromDbt', 'blank', 'import', 'example']);
  });

  it('offers Convert only for a project from before 2.0, ahead of everything else', () => {
    expect(startActionsFor({ hasProject: true, hasDbt: false, storage: 'yaml' })).toEqual(['convert', 'blank', 'import', 'example']);
    expect(startActionsFor({ hasProject: true, hasDbt: true, storage: 'mixed' })).toEqual(['convert', 'drawFromDbt', 'blank', 'import', 'example']);
  });

  it('offers an empty window only the example, which opens in a folder of its own', () => {
    expect(startActionsFor({ hasProject: false, hasDbt: false })).toEqual(['example']);
    expect(startActionsFor({ hasProject: false, hasDbt: true, storage: 'yaml' })).toEqual(['example']);
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
    const pick = vi.fn(async (items: Array<{ action: StartAction }>) => items[1]);
    await runStart(undefined, { context: () => ({ hasProject: true, hasDbt: true }), executeCommand, pick });
    expect(pick.mock.calls[0][0].map((i: { action: StartAction }) => i.action)).toEqual(['drawFromDbt', 'blank', 'import', 'example']);
    expect(executeCommand).toHaveBeenCalledWith('erdStudio.createDomain');
    expect(feature).not.toHaveBeenCalled();

    const closed = vi.fn(async () => undefined);
    await runStart({ action: 'nope' }, { context: () => ({ hasProject: true, hasDbt: false }), executeCommand: closed, pick: closed });
    expect(closed).toHaveBeenCalledTimes(1);
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
  const welcome = (when: string) => pkg.contributes.viewsWelcome.find((w) => w.view === 'erdStudio.domainTree' && w.when === when)!.contents;
  const step = (id: string) => pkg.contributes.walkthroughs[0].steps.find((s) => s.id === id)!;

  it('every start link anywhere is valid and names its own surface', () => {
    for (const w of pkg.contributes.viewsWelcome) for (const link of startLinks(w.contents)) expect(link.from).toBe('sidebar');
    for (const s of pkg.contributes.walkthroughs[0].steps) for (const link of startLinks(s.description)) expect(link.from).toBe('walkthrough');
  });

  it('the empty Diagrams view offers exactly the rule\'s starts, primary first, in each window', () => {
    const actions = (md: string) => startLinks(md).map((l) => l.action);
    expect(actions(welcome('workspaceFolderCount == 0'))).toEqual(startActionsFor({ hasProject: false, hasDbt: false }));
    expect(actions(welcome('erdStudio.hasProject && !erdStudio.hasDbtProject && !erdStudio.diagramsLoading'))).toEqual(startActionsFor({ hasProject: true, hasDbt: false }));
    expect(actions(welcome('erdStudio.hasDbtProject && !erdStudio.diagramsLoading'))).toEqual(startActionsFor({ hasProject: true, hasDbt: true }));
    // Convert is its own entry, stacked above the others in a project from before 2.0.
    expect(actions(welcome('erdStudio.hasProject && !erdStudio.diagramsLoading && (erdStudio.storage == yaml || erdStudio.storage == mixed)'))).toEqual(['convert']);
  });

  it('the walkthrough offers the same starts, primary first, as a button, the rest as links', () => {
    const actions = (id: string) => startLinks(step(id).description).map((l) => l.action);
    expect(actions('openProject')).toEqual(startActionsFor({ hasProject: false, hasDbt: false }));
    expect(actions('newDiagram')).toEqual(startActionsFor({ hasProject: true, hasDbt: false }));
    expect(actions('draw')).toEqual(startActionsFor({ hasProject: true, hasDbt: true }));
    expect(actions('convert')).toEqual(['convert']);
    // One button per step (a link alone on its line); the other starts are inline links.
    for (const id of ['newDiagram', 'draw', 'convert']) {
      const buttons = step(id).description.split('\n').filter((line) => /^\[[^\]]+\]\(command:erdStudio\.start\?[^)]*\)$/.test(line));
      expect(buttons, id).toHaveLength(1);
    }
  });
});
