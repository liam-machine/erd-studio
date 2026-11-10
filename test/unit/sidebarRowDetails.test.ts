/**
 * Quiet by default, details on demand: the `erdStudio.sidebar.rowDetails`
 * setting (`src/providers/rowDetails.ts`), its Show Row Details / Hide Row
 * Details toggle in each sidebar view's … menu, the context key that picks
 * which one shows, and each view's total beside its title (`SidebarFilter`
 * owns the one TreeView description: the filter while filtered, else the
 * total). The rows themselves are tested with each provider
 * (`domainTreeProvider`, `modelLibraryTreeProvider`, `relationshipsTreeProvider`
 * and `sidebarFilterTrees` tests, "compact rows").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  DEFAULT_ROW_DETAILS,
  ROW_DETAILS_COMMANDS,
  ROW_DETAILS_CONTEXT_KEY,
  ROW_DETAILS_SETTING,
  readRowDetails,
  registerRowDetails,
  type RowDetails,
} from '../../src/providers/rowDetails';
import { SidebarFilter, type FilterableTree, type FilteredView } from '../../src/providers/sidebarFilter';
import { NO_LEGACY_ALIAS } from '../../src/extension';
import { TABLE_LIBRARY_FILTER, parseTreeQuery, type FilterOutcome } from '../../src/services/treeSearch';

type MenuEntry = { command?: string; when?: string; group?: string };
const ROOT = path.join(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  contributes: {
    commands: Array<{ command: string; title: string; category?: string; icon?: string }>;
    menus: Record<string, MenuEntry[]>;
    configuration: { properties: Record<string, { type: string; enum?: string[]; enumDescriptions?: string[]; default?: unknown; markdownDescription?: string; scope?: string }> };
  };
};
const VIEWS = ['erdStudio.domainTree', 'erdStudio.modelLibrary', 'erdStudio.relationships'];

function fakeTree() {
  const modes: RowDetails[] = [];
  return { modes, setRowDetails: (mode: RowDetails) => { modes.push(mode); } };
}

let disposables: vscode.Disposable[] = [];
let configListeners: Array<(e: vscode.ConfigurationChangeEvent) => void>;
let exec: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vscode._resetRegisteredCommands();
  vscode._resetMockConfiguration();
  configListeners = [];
  vi.spyOn(vscode.workspace, 'onDidChangeConfiguration').mockImplementation(((listener: (e: vscode.ConfigurationChangeEvent) => void) => {
    configListeners.push(listener);
    return { dispose: () => { configListeners = configListeners.filter((l) => l !== listener); } };
  }) as never);
  exec = vi.spyOn(vscode.commands, 'executeCommand');
});

afterEach(() => {
  for (const d of disposables) d.dispose();
  disposables = [];
  vi.restoreAllMocks();
});

/** VS Code's configuration event for one changed key. */
const changed = (key: string): vscode.ConfigurationChangeEvent => ({ affectsConfiguration: (section: string) => key === section || key.startsWith(`${section}.`) });

describe('the setting', () => {
  it('is compact by default; anything but "full" reads as compact', () => {
    expect(DEFAULT_ROW_DETAILS).toBe('compact');
    expect(readRowDetails()).toBe('compact');
    vscode._setMockConfiguration('erdStudio', ROW_DETAILS_SETTING, { globalValue: 'full' });
    expect(readRowDetails()).toBe('full');
    vscode._setMockConfiguration('erdStudio', ROW_DETAILS_SETTING, { globalValue: 'loud' });
    expect(readRowDetails()).toBe('compact');
  });

  it('is contributed with both values described, compact by default', () => {
    const setting = pkg.contributes.configuration.properties['erdStudio.sidebar.rowDetails'];
    expect(setting).toMatchObject({ type: 'string', enum: ['compact', 'full'], default: 'compact' });
    expect(setting.enumDescriptions).toHaveLength(2);
    for (const text of setting.enumDescriptions!) expect(text.length).toBeGreaterThan(20);
    expect(setting.markdownDescription).toContain('**Show Row Details**');
  });

  it('is in the settings table of docs/dev/architecture.md, with its default', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs/dev/architecture.md'), 'utf8');
    expect(doc).toMatch(/^\| `erdStudio\.sidebar\.rowDetails` \| `compact` \|/m);
  });
});

describe('registerRowDetails', () => {
  it('applies the setting to every tree at once, and sets the context key', () => {
    const trees = [fakeTree(), fakeTree(), fakeTree()];
    disposables = registerRowDetails(trees);
    for (const t of trees) expect(t.modes).toEqual(['compact']);
    expect(exec).toHaveBeenCalledWith('setContext', ROW_DETAILS_CONTEXT_KEY, 'compact');
  });

  it('Show Row Details writes "full" at user scope and redraws the trees; Hide Row Details writes "compact"', async () => {
    const trees = [fakeTree(), fakeTree()];
    disposables = registerRowDetails(trees);
    await vscode.commands.executeCommand(ROW_DETAILS_COMMANDS.show);
    expect(vscode.workspace.getConfiguration('erdStudio').inspect(ROW_DETAILS_SETTING)).toMatchObject({ globalValue: 'full' });
    expect(vscode.workspace.getConfiguration('erdStudio').inspect(ROW_DETAILS_SETTING)).not.toHaveProperty('workspaceValue');
    for (const t of trees) expect(t.modes).toEqual(['compact', 'full']);
    expect(exec).toHaveBeenCalledWith('setContext', ROW_DETAILS_CONTEXT_KEY, 'full');

    await vscode.commands.executeCommand(ROW_DETAILS_COMMANDS.hide);
    expect(vscode.workspace.getConfiguration('erdStudio').inspect(ROW_DETAILS_SETTING)).toMatchObject({ globalValue: 'compact' });
    for (const t of trees) expect(t.modes).toEqual(['compact', 'full', 'compact']);
    expect(exec).toHaveBeenLastCalledWith('setContext', ROW_DETAILS_CONTEXT_KEY, 'compact');
  });

  it('follows the setting when it is changed elsewhere (Settings, settings.json), and ignores other settings', () => {
    const tree = fakeTree();
    disposables = registerRowDetails([tree]);
    vscode._setMockConfiguration('erdStudio', ROW_DETAILS_SETTING, { globalValue: 'full' });
    for (const l of configListeners) l(changed('erdStudio.semanticDir'));
    expect(tree.modes).toEqual(['compact']);
    for (const l of configListeners) l(changed('erdStudio.sidebar.rowDetails'));
    expect(tree.modes).toEqual(['compact', 'full']);
    // The event a toggle's own write fires changes nothing more.
    for (const l of configListeners) l(changed('erdStudio.sidebar.rowDetails'));
    expect(tree.modes).toEqual(['compact', 'full']);
  });

  it('registers the two commands, and lets them go when disposed', () => {
    disposables = registerRowDetails([fakeTree()]);
    const registered = vscode._registeredCommands.map((c) => c.command);
    expect(registered).toEqual(expect.arrayContaining([ROW_DETAILS_COMMANDS.show, ROW_DETAILS_COMMANDS.hide]));
    for (const d of disposables) d.dispose();
    disposables = [];
    expect(vscode._registeredCommands.map((c) => c.command)).not.toContain(ROW_DETAILS_COMMANDS.show);
  });
});

describe('Show Row Details / Hide Row Details in package.json', () => {
  const commands = [ROW_DETAILS_COMMANDS.show, ROW_DETAILS_COMMANDS.hide];

  it('are contributed under ERD Studio, and never had a dbtSemantic alias', () => {
    const titles = commands.map((id) => pkg.contributes.commands.find((c) => c.command === id));
    expect(titles.map((c) => [c?.title, c?.category])).toEqual([['Show Row Details', 'ERD Studio'], ['Hide Row Details', 'ERD Studio']]);
    for (const id of commands) expect(NO_LEGACY_ALIAS.has(id), id).toBe(true);
  });

  it('sit in the … menu of Diagrams, the Table Library and Relationships (never the inline title bar), one at a time by the context key', () => {
    const entries = pkg.contributes.menus['view/title'].filter((m) => commands.includes(m.command as never));
    expect(entries).toHaveLength(2);
    for (const m of entries) {
      expect(m.group?.startsWith('navigation'), m.command).toBe(false);
      const pattern = /view =~ \/(.*?)\/ /.exec(m.when ?? '')?.[1];
      expect(pattern, m.when).toBeDefined();
      for (const view of VIEWS) expect(new RegExp(pattern!).test(view), view).toBe(true);
      expect(new RegExp(pattern!).test('erdStudio.help')).toBe(false);
      expect(m.when).toContain('erdStudio.hasProject');
    }
    expect(entries.find((m) => m.command === ROW_DETAILS_COMMANDS.show)?.when).toMatch(/erdStudio\.sidebarRowDetails != full$/);
    expect(entries.find((m) => m.command === ROW_DETAILS_COMMANDS.hide)?.when).toMatch(/erdStudio\.sidebarRowDetails == full$/);
    expect(ROW_DETAILS_CONTEXT_KEY).toBe('erdStudio.sidebarRowDetails');
  });

  it('show in the Command Palette only the one that changes something', () => {
    const palette = pkg.contributes.menus.commandPalette.filter((m) => commands.includes(m.command as never));
    expect(palette).toEqual([
      { command: ROW_DETAILS_COMMANDS.show, when: 'erdStudio.hasProject && erdStudio.sidebarRowDetails != full' },
      { command: ROW_DETAILS_COMMANDS.hide, when: 'erdStudio.hasProject && erdStudio.sidebarRowDetails == full' },
    ]);
  });
});

describe('New Diagram on a layer row (the compact tree drops the New Diagram… row under a layer that has diagrams)', () => {
  it('is an inline + on every layer row that takes new diagrams, running New Diagram… with the row', () => {
    const inline = pkg.contributes.menus['view/item/context']
      .filter((m) => m.command === 'erdStudio.createDomain' && m.group === 'inline');
    expect(inline).toEqual([{ command: 'erdStudio.createDomain', when: 'view == erdStudio.domainTree && viewItem == layerCreatable', group: 'inline' }]);
    expect(pkg.contributes.commands.find((c) => c.command === 'erdStudio.createDomain')?.icon).toBe('$(add)');
  });
});

describe('each view\'s total beside its title', () => {
  function tree(total: string | undefined) {
    const emitter = new vscode.EventEmitter<FilterOutcome | undefined>();
    let filter = '';
    const t = {
      total,
      getFilter: () => filter,
      setFilter: (text: string) => { filter = text.trim(); },
      onDidFilter: emitter.event,
      headerTotal: () => t.total,
      list: (shown = 1, all = 5) => emitter.fire(filter ? { query: parseTreeQuery(filter), shown, total: all } : undefined),
    };
    return t;
  }
  function filterOn(t: FilterableTree): { view: FilteredView; filter: SidebarFilter } {
    const view: FilteredView = { message: undefined, description: undefined };
    const filter = new SidebarFilter(view, t, {
      title: 'Filter Table Library', placeholder: '', spec: TABLE_LIBRARY_FILTER, noun: { one: 'table', many: 'tables' },
      contextKey: 'erdStudio.tableLibraryFiltered',
    });
    return { view, filter };
  }

  it('shows the total after each unfiltered listing, gives way to the filter, and comes back when it is cleared', () => {
    const t = tree('17 tables');
    const { view, filter } = filterOn(t);
    t.list();
    expect(view.description).toBe('17 tables');
    filter.apply('cust');
    expect(view.description).toBe('cust');
    t.list(2, 17);
    expect(view.description).toBe('cust');
    expect(view.message).toBe('Filtered: "cust" — 2 of 17 tables');
    filter.clear();
    expect(view.description).toBe('17 tables');
    expect(view.message).toBeUndefined();
    // The total follows the tree's next listing.
    t.total = '18 tables';
    t.list();
    expect(view.description).toBe('18 tables');
    filter.dispose();
  });

  it('shows nothing when the tree has no total (empty, or not listed yet), or offers none', () => {
    const t = tree(undefined);
    const { view, filter } = filterOn(t);
    t.list();
    expect(view.description).toBeUndefined();
    filter.dispose();
    const plain = { getFilter: () => '', setFilter: () => undefined, onDidFilter: new vscode.EventEmitter<FilterOutcome | undefined>().event };
    const other = filterOn(plain);
    other.filter.clear();
    expect(other.view.description).toBeUndefined();
    other.filter.dispose();
  });
});
