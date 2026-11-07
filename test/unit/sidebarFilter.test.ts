/**
 * The sidebar's Filter… box (`src/providers/sidebarFilter.ts`): live,
 * debounced filtering as you type, prefilled with the filter in force; Enter
 * (or clicking away) keeps it, Escape puts back the one before; the view's
 * message, description and `…Filtered` context key while filtered; and the
 * commands, menus and keybindings `package.json` contributes for it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  CANCEL_FILTER_COMMAND,
  FILTER_COMMANDS,
  FILTER_DEBOUNCE_MS,
  FILTER_OPEN_CONTEXT_KEY,
  SidebarFilter,
  cancelOpenFilter,
  registerSidebarFilters,
  type FilterableTree,
  type FilteredView,
} from '../../src/providers/sidebarFilter';
import { NO_LEGACY_ALIAS } from '../../src/extension';
import { TABLE_LIBRARY_FILTER, parseTreeQuery, type FilterOutcome } from '../../src/services/treeSearch';

/** An InputBox stand-in: records what the filter sets, and lets a test type, press Enter or click away. */
function fakeInputBox() {
  const listeners: Record<string, (arg?: unknown) => void> = {};
  const box = {
    value: '',
    title: '' as string | undefined,
    placeholder: '' as string | undefined,
    prompt: '' as string | undefined,
    shown: 0,
    disposed: false,
    show() { box.shown++; },
    hide() { listeners.hide?.(); },
    dispose() { box.disposed = true; },
    onDidChangeValue(fn: (v: string) => void) { listeners.value = fn as (arg?: unknown) => void; return { dispose() {} }; },
    onDidAccept(fn: () => void) { listeners.accept = fn; return { dispose() {} }; },
    onDidHide(fn: () => void) { listeners.hide = fn; return { dispose() {} }; },
    type(value: string) { box.value = value; listeners.value?.(value); },
    enter() { listeners.accept?.(); },
  };
  return box;
}

/** A filterable tree that records each filter and reports an outcome when told to list. */
function fakeTree(initial = '') {
  const emitter = new vscode.EventEmitter<FilterOutcome | undefined>();
  let filter = initial;
  const tree = {
    set: [] as string[],
    getFilter: () => filter,
    setFilter: (text: string) => {
      tree.set.push(text);
      filter = parseTreeQuery(text).terms.length > 0 ? text.trim() : '';
    },
    onDidFilter: emitter.event,
    list(shown: number, total: number) {
      emitter.fire(filter ? { query: parseTreeQuery(filter), shown, total } : undefined);
    },
  };
  return tree as typeof tree & FilterableTree;
}

const view = (): FilteredView => ({ message: undefined, description: undefined });

let exec: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  exec = vi.spyOn(vscode.commands, 'executeCommand');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function filterFor(tree: FilterableTree, v = view(), box = fakeInputBox()) {
  const filter = new SidebarFilter(v, tree, {
    title: 'Filter Table Library',
    placeholder: 'customer  layer:gold  owner:finance  col:customer_id  is:unused',
    spec: TABLE_LIBRARY_FILTER,
    noun: { one: 'table', many: 'tables' },
    contextKey: FILTER_COMMANDS.tableLibrary.contextKey,
    createInputBox: () => box as unknown as vscode.InputBox,
  });
  return { filter, box, view: v };
}

describe('the Filter… box', () => {
  it('opens prefilled with the filter in force, with examples and the view\'s keys', () => {
    const tree = fakeTree('cust');
    const { filter, box } = filterFor(tree);
    void filter.open();
    expect(box.shown).toBe(1);
    expect(box.value).toBe('cust');
    expect(box.title).toBe('Filter Table Library');
    expect(box.placeholder).toBe('customer  layer:gold  owner:finance  col:customer_id  is:unused');
    expect(box.prompt).toContain('owner: type: col:');
    expect(exec).toHaveBeenCalledWith('setContext', FILTER_OPEN_CONTEXT_KEY, true);
  });

  it('filters as you type, once typing pauses', () => {
    const tree = fakeTree();
    const { filter, box } = filterFor(tree);
    void filter.open();
    box.type('c');
    box.type('cu');
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS - 1);
    expect(tree.set).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(tree.set).toEqual(['cu']);
    expect(exec).toHaveBeenCalledWith('setContext', 'erdStudio.tableLibraryFiltered', true);
  });

  it('keeps the filter on Enter, at once, and closes', async () => {
    const tree = fakeTree();
    const { filter, box } = filterFor(tree);
    const done = filter.open();
    box.type('layer:gold');
    box.enter();
    await done;
    expect(tree.getFilter()).toBe('layer:gold');
    expect(box.disposed).toBe(true);
    expect(exec).toHaveBeenCalledWith('setContext', FILTER_OPEN_CONTEXT_KEY, false);
    // Nothing was waiting on the debounce.
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS);
    expect(tree.getFilter()).toBe('layer:gold');
  });

  it('puts back the filter it opened with on Escape', async () => {
    const tree = fakeTree('old');
    const { filter, box } = filterFor(tree);
    const done = filter.open();
    box.type('new');
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS);
    expect(tree.getFilter()).toBe('new');
    // Escape: the keybinding runs erdStudio.cancelSidebarFilter.
    cancelOpenFilter();
    await done;
    expect(tree.getFilter()).toBe('old');
    expect(exec).toHaveBeenCalledWith('setContext', FILTER_OPEN_CONTEXT_KEY, false);
  });

  it('keeps what was typed when it closes for another reason (a click into the tree)', async () => {
    const tree = fakeTree();
    const { filter, box } = filterFor(tree);
    const done = filter.open();
    box.type('dim');
    box.hide();
    await done;
    expect(tree.getFilter()).toBe('dim');
  });

  it('shows one box at a time', () => {
    const tree = fakeTree();
    let made = 0;
    const box = fakeInputBox();
    const filter = new SidebarFilter(view(), tree, {
      title: 't', placeholder: 'p', spec: TABLE_LIBRARY_FILTER, noun: { one: 'table', many: 'tables' }, contextKey: 'k',
      createInputBox: () => { made++; return box as unknown as vscode.InputBox; },
    });
    void filter.open();
    void filter.open();
    expect(made).toBe(1);
    expect(box.shown).toBe(2);
  });
});

describe('the filtered view', () => {
  it('says what matched in its message, shows the filter as its description, and clears both', () => {
    const tree = fakeTree();
    const { filter, view: v } = filterFor(tree);
    filter.apply('cust layer:gold');
    // The title says the filter at once, before the view lists (a collapsed view does not).
    expect(v.description).toBe('cust layer:gold');
    expect(v.message).toBeUndefined();
    tree.list(4, 52);
    expect(v.message).toBe('Filtered: "cust layer:gold" — 4 of 52 tables');
    expect(v.description).toBe('cust layer:gold');
    tree.list(0, 52);
    expect(v.message).toBe('No tables match "cust layer:gold"');
    expect(filter.isFiltered()).toBe(true);
    filter.clear();
    expect(v.message).toBeUndefined();
    expect(v.description).toBeUndefined();
    expect(filter.isFiltered()).toBe(false);
    expect(exec).toHaveBeenCalledWith('setContext', 'erdStudio.tableLibraryFiltered', false);
  });
});

describe('registerSidebarFilters', () => {
  it('registers Filter… and Clear Filter for each view, and Escape in the box', async () => {
    vscode._resetRegisteredCommands();
    const trees = { diagrams: fakeTree(), tableLibrary: fakeTree(), relationships: fakeTree() };
    const views = { diagrams: view(), tableLibrary: view(), relationships: view() };
    const { filters, disposables } = registerSidebarFilters({
      diagrams: { view: views.diagrams, tree: trees.diagrams },
      tableLibrary: { view: views.tableLibrary, tree: trees.tableLibrary },
      relationships: { view: views.relationships, tree: trees.relationships },
    }, () => fakeInputBox() as unknown as vscode.InputBox);
    expect(vscode._registeredCommands.map((c) => c.command)).toEqual([
      'erdStudio.filterDiagrams', 'erdStudio.clearDiagramsFilter',
      'erdStudio.filterTableLibrary', 'erdStudio.clearTableLibraryFilter',
      'erdStudio.filterRelationships', 'erdStudio.clearRelationshipsFilter',
      CANCEL_FILTER_COMMAND,
    ]);
    filters.relationships.apply('is:problem');
    expect(trees.relationships.getFilter()).toBe('is:problem');
    await vscode.commands.executeCommand('erdStudio.clearRelationshipsFilter');
    expect(trees.relationships.getFilter()).toBe('');
    for (const d of disposables) d.dispose();
    expect(vscode._registeredCommands).toEqual([]);
  });
});

describe('contributions', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')) as {
    contributes: {
      commands: Array<{ command: string; title: string; category?: string; icon?: string }>;
      menus: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
      keybindings: Array<{ command: string; key: string; mac?: string; when?: string }>;
    };
  };
  const { commands, menus, keybindings } = pkg.contributes;
  const VIEWS = [
    ['erdStudio.domainTree', 'Diagrams', FILTER_COMMANDS.diagrams, 'erdStudio.hasProject'],
    ['erdStudio.modelLibrary', 'Table Library', FILTER_COMMANDS.tableLibrary, 'erdStudio.hasLogicalModelsDir'],
    ['erdStudio.relationships', 'Relationships', FILTER_COMMANDS.relationships, 'erdStudio.hasLogicalModelsDir'],
  ] as const;

  it('contribute Filter… and Clear Filter for each view, under ERD Studio, with no legacy alias', () => {
    for (const [, name, ids] of VIEWS) {
      expect(commands.find((c) => c.command === ids.filter)).toEqual({ command: ids.filter, title: `Filter ${name}…`, category: 'ERD Studio', icon: '$(filter)' });
      expect(commands.find((c) => c.command === ids.clear)).toEqual({ command: ids.clear, title: `Clear ${name} Filter`, category: 'ERD Studio', icon: '$(filter-filled)' });
      expect(NO_LEGACY_ALIAS.has(ids.filter), ids.filter).toBe(true);
      expect(NO_LEGACY_ALIAS.has(ids.clear), ids.clear).toBe(true);
    }
    // Escape in the box is code-only: bound to a key, never in the palette.
    expect(NO_LEGACY_ALIAS.has(CANCEL_FILTER_COMMAND)).toBe(true);
    expect(commands.some((c) => c.command === CANCEL_FILTER_COMMAND)).toBe(false);
  });

  it('put Filter… in the palette while the view can show, and Clear Filter only while filtered', () => {
    for (const [, , ids, shows] of VIEWS) {
      expect(menus.commandPalette).toContainEqual({ command: ids.filter, when: shows });
      expect(menus.commandPalette).toContainEqual({ command: ids.clear, when: ids.contextKey });
    }
  });

  it('bind Cmd+F (Ctrl+F) in each view to its filter, and Escape in an open box', () => {
    for (const [viewId, , ids] of VIEWS) {
      expect(keybindings).toContainEqual({ command: ids.filter, key: 'ctrl+f', mac: 'cmd+f', when: `focusedView == ${viewId}` });
    }
    expect(keybindings).toContainEqual({ command: CANCEL_FILTER_COMMAND, key: 'escape', when: FILTER_OPEN_CONTEXT_KEY });
    // Nothing else claims Cmd+F: an editor's find keeps working.
    expect(keybindings.filter((k) => k.mac === 'cmd+f').every((k) => k.when?.startsWith('focusedView == erdStudio.'))).toBe(true);
  });
});
