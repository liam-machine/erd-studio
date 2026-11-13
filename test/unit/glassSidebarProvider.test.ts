/**
 * The glass sidebar's bridge (GlassSidebarProvider): it draws the native
 * trees' own providers, decides menus / visibility / empty states from the
 * real package.json, and runs only what the host looks up itself — the
 * webview sends a row id and a menu index, never a command.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { GlassSidebarProvider, MAX_ROWS_SENT, glassFilterGuide, parseGlassInbound, type BridgedDragAndDrop, type BridgedTree } from '../../src/providers/glassSidebar/GlassSidebarProvider';
import { FILTER_COMMANDS, FILTER_DEBOUNCE_MS, SidebarFilter, VIEW_FILTERS, sidebarFilterKeys, type FilteredView, type SidebarFilterViewName } from '../../src/providers/sidebarFilter';
import { isEmptyQuery, matchTreeQuery, parseTreeQuery, type FilterSpec, type TreeQuery } from '../../src/services/treeSearch';
import { _resetContextKeys, recordContextKey } from '../../src/providers/glassSidebar/contextKeys';
import type { Contributions } from '../../src/providers/glassSidebar/contributions';
import { GLASS_SEARCH_MAX_LENGTH, GLASS_WEBVIEW_MESSAGE_TYPES, type GlassHostMessage, type GlassSection, type SerialisedNode } from '../../src/providers/glassSidebar/protocol';
import { tableRowsFromTreeArgs } from '../../src/commands/goToTable';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as { contributes: Contributions };

type Node = { kind: 'layer' | 'domain' | 'table'; name: string; children?: Node[] };

/** A tree with the native providers' shape: rows with ids and contextValues. */
function tree(roots: Node[], contextValue: (n: Node) => string, extras: Partial<BridgedTree<Node>> = {}): BridgedTree<Node> & { fire(): void } {
  const emitter = new vscode.EventEmitter();
  return {
    getChildren: (n?: Node) => (n ? n.children ?? [] : roots),
    getTreeItem: (n: Node) => {
      const item = new vscode.TreeItem(n.name, n.children ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None) as vscode.TreeItem;
      item.id = `${n.kind}:${n.name}`;
      item.contextValue = contextValue(n);
      if (n.kind === 'domain') item.command = { command: 'erdStudio.openDomain', title: 'Open', arguments: [`/ws/${n.name}.dbml`] };
      item.iconPath = new vscode.ThemeIcon(n.kind === 'layer' ? 'layers' : 'json');
      return item;
    },
    onDidChangeTreeData: emitter.event as vscode.Event<unknown>,
    fire: () => emitter.fire(undefined),
    ...extras,
  };
}

function fakeView() {
  let handler: ((m: unknown) => void) | undefined;
  const posted: GlassHostMessage[] = [];
  const view = {
    visible: true,
    show: vi.fn(),
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
    webview: {
      options: {} as { enableScripts?: boolean; localResourceRoots?: Array<{ path: string }> },
      html: '',
      cspSource: 'https://webview.test',
      asWebviewUri: (u: { path: string }) => ({ toString: () => `https://webview.test${u.path}` }),
      postMessage: async (m: GlassHostMessage) => { posted.push(m); return true; },
      onDidReceiveMessage: (fn: (m: unknown) => void) => { handler = fn; return { dispose() {} }; },
    },
  };
  return { view, posted, send: (m: unknown) => handler!(m) };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const lastState = (posted: GlassHostMessage[]): GlassSection[] => {
  const states = posted.filter((m): m is Extract<GlassHostMessage, { type: 'state' }> => m.type === 'state');
  return states[states.length - 1].sections;
};
const section = (posted: GlassHostMessage[], key: string): GlassSection => lastState(posted).find((s) => s.key === key)!;

const diagrams: Node[] = [{ kind: 'layer', name: 'gold', children: [{ kind: 'domain', name: 'finance' }] }];
const tables: Node[] = [{ kind: 'table', name: 'dim_customer' }];

let exec: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetContextKeys();
  recordContextKey('erdStudio.hasProject', true);
  recordContextKey('erdStudio.hasLogicalModelsDir', true);
  recordContextKey('erdStudio.storage', 'dbml');
  recordContextKey('erdStudio.glassSidebar', true);
  exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetContextKeys();
});

async function setUp() {
  const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
  const v = fakeView();
  provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
  const diagramTree = tree(diagrams, (n) => (n.kind === 'layer' ? 'layerCreatable' : 'domain'), { headerTotal: () => '1 diagram' });
  const tableTree = tree(tables, () => 'logicalModel');
  provider.setSource('diagrams', diagramTree);
  provider.setSource('tables', tableTree);
  v.send({ type: 'ready' });
  await flush();
  return { provider, ...v, diagramTree, tableTree };
}

describe('the glass sidebar bridge', () => {
  it('serves a nonce-only page whose resources come from dist/ and media/ only', async () => {
    const { view } = await setUp();
    expect(view.webview.options.enableScripts).toBe(true);
    expect(view.webview.options.localResourceRoots!.map((u) => u.path)).toEqual(['/ext/dist', '/ext/media']);
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(view.webview.html)![1].replace(/&#39;|&quot;/g, "'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('draws the native providers\' rows, with their menus decided by the views\' own when clauses', async () => {
    const { posted } = await setUp();
    const d = section(posted, 'diagrams');
    expect(d).toMatchObject({ title: 'Diagrams', visible: true, count: '1 diagram' });
    const layer = d.nodes[0];
    expect(layer).toMatchObject({ id: 'diagrams:layer:gold', label: 'gold', collapsible: 1, childrenLoaded: true, contextValue: 'layerCreatable' });
    // layerCreatable: New Diagram… as a hover button (the inline entry), and a context menu.
    expect(layer.inline?.map((a) => a.title)).toEqual(['New Diagram…']);
    expect(layer.hasMenu).toBe(true);
    const domain = layer.children![0] as SerialisedNode;
    expect(domain).toMatchObject({ id: 'diagrams:domain:finance', hasCommand: true, hasMenu: true, icon: { kind: 'theme', id: 'json' } });
    // The Diagrams title: the + submenu as an icon, Export All… under the … menu only when its key holds.
    expect(d.actions.navigation.map((a) => a.title)).toContain('New…');
    expect(d.actions.navigation.find((a) => a.title === 'New…')!.submenu!.flat().map((a) => a.title)).toContain('New Diagram…');
    // Table rows: one hover button, the + that adds the table to the open diagram (rowActions.ts), then the menu.
    const table = section(posted, 'tables').nodes[0];
    expect(table.inline?.map((a) => a.title)).toEqual(['Add to Open Diagram']);
    expect(table.inline?.[0].icon).toBe('add');
    expect(table.hasMenu).toBe(true);
  });

  it('follows each native view\'s original when: no Table Library without a library folder', async () => {
    recordContextKey('erdStudio.hasLogicalModelsDir', false);
    const { posted } = await setUp();
    expect(section(posted, 'tables').visible).toBe(false);
    expect(section(posted, 'relationships').visible).toBe(false);
    expect(section(posted, 'diagrams').visible).toBe(true);
  });

  it('runs a row\'s own TreeItem command on click, and a menu entry with the real element', async () => {
    const { send, posted } = await setUp();
    send({ type: 'activate', section: 'diagrams', id: 'diagrams:domain:finance' });
    await flush();
    expect(exec).toHaveBeenCalledWith('erdStudio.openDomain', '/ws/finance.dbml');

    const domain = section(posted, 'diagrams').nodes[0].children![0];
    send({ type: 'itemMenu', section: 'diagrams', id: domain.id });
    await flush();
    const menu = posted.find((m): m is Extract<GlassHostMessage, { type: 'itemMenu' }> => m.type === 'itemMenu')!;
    const rename = menu.groups.flat().find((a) => a.title === 'Rename Diagram…')!;
    send({ type: 'invoke', section: 'diagrams', id: domain.id, menu: rename.menu, index: rename.index });
    await flush();
    expect(exec).toHaveBeenCalledWith('erdStudio.renameDomain', diagrams[0].children![0]);

    // The Table Library selects many natively: (element, selection).
    const add = section(posted, 'tables').nodes[0].inline!.find((a) => a.title === 'Add to Open Diagram')!;
    send({ type: 'invoke', section: 'tables', id: 'tables:table:dim_customer', menu: add.menu, index: add.index });
    await flush();
    expect(exec).toHaveBeenCalledWith('erdStudio.addToOpenDiagram', tables[0], [tables[0]]);

    // The click goes to the diagram, so the table's menu opens with Open File (never Open in Diagram…).
    send({ type: 'itemMenu', section: 'tables', id: 'tables:table:dim_customer' });
    await flush();
    const tableMenu = posted.filter((m): m is Extract<GlassHostMessage, { type: 'itemMenu' }> => m.type === 'itemMenu').pop()!;
    expect(tableMenu.groups.map((g) => g.map((a) => a.title))).toEqual([
      ['Open File', 'Reveal in Explorer'],
      ['Add to Open Diagram', 'Add to Diagram…'],
      ['Move Table…'],
      ['Delete Table'],
    ]);
    const open = tableMenu.groups[0][0];
    send({ type: 'invoke', section: 'tables', id: 'tables:table:dim_customer', menu: open.menu, index: open.index });
    await flush();
    expect(exec).toHaveBeenCalledWith('erdStudio.openTableFile', tables[0], [tables[0]]);
  });

  it('runs a row\'s double-click as its tree names it (row ids only), and marks the rows that have one', async () => {
    const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    const v = fakeView();
    provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    const secondary = vi.fn((n: Node) => (n.kind === 'table' ? { command: 'erdStudio.openTableFile', title: 'Open File', arguments: [n, { doubleClick: true }] } : undefined));
    provider.setSource('tables', tree([...tables, { kind: 'layer', name: 'gold', children: [] }], (n) => (n.kind === 'table' ? 'logicalModel' : 'tableLibraryLayer'), { secondaryCommand: secondary }));
    v.send({ type: 'ready' });
    await flush();
    const rows = section(v.posted, 'tables').nodes;
    expect(rows.find((r) => r.label === 'dim_customer')?.secondary).toBe(true);
    expect(rows.find((r) => r.label === 'gold')?.secondary).toBeUndefined();
    exec.mockClear();
    v.send({ type: 'doubleClick', section: 'tables', id: 'tables:table:dim_customer' });
    await flush();
    expect(exec).toHaveBeenCalledWith('erdStudio.openTableFile', tables[0], { doubleClick: true });
    // A row with none, a row never listed, a command the page names: nothing runs.
    exec.mockClear();
    v.send({ type: 'doubleClick', section: 'tables', id: 'tables:layer:gold' });
    v.send({ type: 'doubleClick', section: 'tables', id: 'tables:table:nope' });
    v.send({ type: 'doubleClick', section: 'tables', id: 'tables:table:dim_customer', command: 'workbench.action.terminal.new' });
    await flush();
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['erdStudio.openTableFile']);
    expect(parseGlassInbound({ type: 'doubleClick', section: 'tables', id: 'x', command: 'y' })).toEqual({ type: 'doubleClick', section: 'tables', id: 'x' });
    expect(parseGlassInbound({ type: 'doubleClick', section: 'tables' })).toBeUndefined();
  });

  it('draws no … on a row whose menu only repeats its hover button (a relationship\'s Open in File), and still answers its right-click', async () => {
    const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    const v = fakeView();
    provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    provider.setSource('tables', tree([{ kind: 'layer', name: 'gold', children: [{ kind: 'layer', name: 'sales', children: [] }] }],
      (n) => (n.name === 'gold' ? 'tableLibraryLayer' : 'tableLibrarySchema')));
    provider.setSource('relationships', tree([{ kind: 'table', name: 'dim_customer' }], () => 'relationship'));
    v.send({ type: 'ready' });
    await flush();
    const layer = section(v.posted, 'tables').nodes[0];
    const schema = layer.children![0];
    // Their menus hold more than the + (Reveal in Explorer, New Schema…): the … stays.
    expect(layer).toMatchObject({ hasMenu: true });
    expect(layer.hideMore).toBeUndefined();
    expect(schema.hideMore).toBeUndefined();
    const rel = section(v.posted, 'relationships').nodes[0];
    expect(rel).toMatchObject({ hasMenu: true, hideMore: true });
    expect(rel.inline?.map((a) => a.title)).toEqual(['Open in File']);
    v.send({ type: 'itemMenu', section: 'relationships', id: rel.id });
    await flush();
    const menu = v.posted.filter((m): m is Extract<GlassHostMessage, { type: 'itemMenu' }> => m.type === 'itemMenu').pop()!;
    expect(menu.groups.map((g) => g.map((a) => a.title))).toEqual([['Open in File']]);
  });

  it('gives each draggable row the number of tables its drag carries (the drag picture\'s count)', async () => {
    const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    const v = fakeView();
    provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    provider.setSource('tables', tree([{ kind: 'layer', name: 'gold', children: [{ kind: 'table', name: 'a' }, { kind: 'table', name: 'b' }] }], () => 'logicalModel'), {
      controller: { handleDrag: () => undefined },
      dragKind: () => 'tables',
      dragCount: (n: Node) => (n.kind === 'layer' ? n.children!.length : 1),
    });
    v.send({ type: 'ready' });
    await flush();
    const layer = section(v.posted, 'tables').nodes[0];
    expect(layer.dragCount).toBe(2);
    expect(layer.children!.map((c) => c.dragCount)).toEqual([1, 1]);
  });

  it('refuses what it did not offer: unknown rows, entries whose when fails, menus a row cannot reach', async () => {
    const { send, posted } = await setUp();
    exec.mockClear();
    const entries = pkg.contributes.menus!['view/item/context'];
    const deleteTable = entries.findIndex((e) => e.command === 'erdStudio.deleteLogicalModel');
    // A diagram row cannot run the Table Library's Delete Table (its when names another view and item).
    send({ type: 'invoke', section: 'diagrams', id: 'diagrams:domain:finance', menu: 'view/item/context', index: deleteTable });
    // A row id the host never gave out.
    send({ type: 'invoke', section: 'tables', id: 'tables:table:nope', menu: 'view/item/context', index: deleteTable });
    // A row entry through the title menu, and a made-up menu.
    send({ type: 'invoke', section: 'tables', menu: 'view/item/context', index: deleteTable });
    send({ type: 'invoke', section: 'tables', menu: 'commandPalette', index: 0 });
    // Not a command id anywhere: a command field is ignored by the shape check.
    send({ type: 'invoke', section: 'tables', id: 'tables:table:dim_customer', command: 'workbench.action.terminal.new', menu: 'x', index: 0 });
    send({ type: 'run', command: 'erdStudio.deleteDomain' });
    // While the project is not DBML, Move Table's when fails.
    recordContextKey('erdStudio.storage', 'yaml');
    const moveTable = entries.findIndex((e) => e.command === 'erdStudio.moveTable');
    send({ type: 'invoke', section: 'tables', id: 'tables:table:dim_customer', menu: 'view/item/context', index: moveTable });
    await flush();
    expect(exec).not.toHaveBeenCalled();
    expect(posted.filter((m) => m.type === 'itemMenu')).toEqual([]);
  });

  it('shows the view\'s welcome when it has no rows, and runs only its erdStudio.* links', async () => {
    const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    const v = fakeView();
    provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    recordContextKey('erdStudio.diagramsLoading', false);
    recordContextKey('erdStudio.startIntent', 'blank');
    provider.setSource('diagrams', tree([], () => ''));
    v.send({ type: 'ready' });
    await flush();
    const d = section(v.posted, 'diagrams');
    expect(d.nodes).toEqual([]);
    const entry = d.welcome.find((w) => w.paragraphs.some((p) => p.parts.some((part) => part.kind === 'text' && part.text.startsWith('No diagrams or tables yet'))))!;
    // An empty project: the one button is Import Your Data Model…, New Diagram… a quiet link under it.
    const button = entry.paragraphs.find((p) => p.button)!.parts[0] as { kind: 'link'; label: string; link: number };
    expect(button.label).toBe('Import Your Data Model…');
    v.send({ type: 'welcomeLink', section: 'diagrams', entry: entry.entry, link: button.link });
    await flush();
    expect(exec).toHaveBeenCalledWith('erdStudio.showImportGuide', { from: 'sidebar' });
    exec.mockClear();
    const blank = entry.paragraphs.flatMap((p) => p.parts).find((part) => part.kind === 'link' && part.label === 'New Diagram…') as { kind: 'link'; link: number };
    v.send({ type: 'welcomeLink', section: 'diagrams', entry: entry.entry, link: blank.link });
    await flush();
    expect(exec).toHaveBeenCalledWith('erdStudio.start', { action: 'blank', from: 'sidebar' });
    // An entry whose when does not hold now is refused.
    exec.mockClear();
    const other = pkg.contributes.viewsWelcome!.findIndex((w) => (w.when ?? '').includes('erdStudio.hasMultipleDbtProjects'));
    v.send({ type: 'welcomeLink', section: 'diagrams', entry: other, link: 0 });
    await flush();
    expect(exec).not.toHaveBeenCalled();
  });

  it('lists again when a provider changes, and reveals a row with its ancestors', async () => {
    const { posted, diagramTree, provider, view } = await setUp();
    diagrams[0].children!.push({ kind: 'domain', name: 'sales' });
    diagramTree.fire();
    await new Promise((r) => setTimeout(r, 200));
    await flush();
    expect(section(posted, 'diagrams').nodes[0].children!.map((n) => n.label)).toEqual(['finance', 'sales']);

    const withParent = { ...diagramTree, getParent: (n: Node) => (n.kind === 'domain' ? diagrams[0] : undefined) };
    provider.setSource('diagrams', withParent);
    await provider.reveal('diagrams', diagrams[0].children![1], { focus: true });
    expect(view.show).toHaveBeenCalledWith(false);
    expect(posted[posted.length - 1]).toEqual({ type: 'reveal', section: 'diagrams', id: 'diagrams:domain:sales', expand: ['diagrams:layer:gold'], focus: true });
    diagrams[0].children!.pop();
  });
});

describe('the glass sidebar at rest (the hover flicker: an endless re-send loop)', () => {
  const states = (posted: GlassHostMessage[]) => posted.filter((m) => m.type === 'state').length;

  /** As the native providers do: every root listing fires onDidFilter (the view's title shows the count). */
  function filteringTree(roots: Node[]) {
    const filterEmitter = new vscode.EventEmitter();
    const base = tree(roots, () => 'logicalModel', { onDidFilter: filterEmitter.event as vscode.Event<unknown>, getFilter: () => '' });
    const listings = { count: 0 };
    return {
      listings,
      tree: {
        ...base,
        getChildren: (n?: Node) => {
          if (!n) { listings.count++; filterEmitter.fire(undefined); }
          return base.getChildren(n);
        },
      } as BridgedTree<Node> & { fire(): void },
    };
  }

  it('does not walk again because a walk fired onDidFilter: one state, then silence', async () => {
    const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    const v = fakeView();
    provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    const t = filteringTree(tables);
    const d = filteringTree(diagrams);
    provider.setSource('tables', t.tree);
    provider.setSource('diagrams', d.tree);
    v.send({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 700));
    await flush();
    expect(states(v.posted)).toBe(1);
    // Listed once on ready, never again by itself.
    expect(t.listings.count).toBe(1);
    expect(d.listings.count).toBe(1);
    provider.dispose();
  });

  it('never re-sends a state the webview already has; a real change is sent once', async () => {
    const { posted, diagramTree, tableTree, provider } = await setUp();
    expect(states(posted)).toBe(1);
    // A refresh that changed nothing (both trees at once): walked, but not sent.
    diagramTree.fire();
    tableTree.fire();
    await new Promise((r) => setTimeout(r, 250));
    await flush();
    expect(states(posted)).toBe(1);
    // A context key the menus do not depend on changing value: nothing new to send either.
    recordContextKey('erdStudio.someUnrelatedKey', 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(states(posted)).toBe(1);
    // Two trees changing together: one walk of both, one state.
    diagrams[0].children!.push({ kind: 'domain', name: 'sales' });
    tables.push({ kind: 'table', name: 'dim_date' });
    diagramTree.fire();
    tableTree.fire();
    await new Promise((r) => setTimeout(r, 250));
    await flush();
    expect(states(posted)).toBe(2);
    expect(section(posted, 'tables').nodes.map((n) => n.label)).toEqual(['dim_customer', 'dim_date']);
    diagrams[0].children!.pop();
    tables.pop();
    provider.dispose();
  });

  it('sends the whole state again to a page that (re)loaded', async () => {
    const { posted, send, provider } = await setUp();
    expect(states(posted)).toBe(1);
    send({ type: 'ready' });
    await flush();
    expect(states(posted)).toBe(2);
    provider.dispose();
  });
});

describe('the glass sidebar\'s drag and drop (the native views\' own controllers)', () => {
  const NAMES = 'application/vnd.erdstudio.tables+json';

  /** setUp(), with the Table Library a drag source and the Diagrams rows drop targets, as extension.ts wires them. */
  async function setUpDnd() {
    const s = await setUp();
    const drags: Node[][] = [];
    const drops: Array<{ target: Node | undefined; names: unknown }> = [];
    const tableDnd: BridgedDragAndDrop<Node> = {
      controller: {
        handleDrag: (rows, dataTransfer) => {
          drags.push([...rows]);
          dataTransfer.set(NAMES, new vscode.DataTransferItem(JSON.stringify(rows.map((r) => r.name))));
        },
      },
      dragKind: (row) => (row.kind === 'table' ? 'tables' : undefined),
    };
    const diagramDnd: BridgedDragAndDrop<Node> = {
      controller: {
        handleDrag: (rows, dataTransfer) => { dataTransfer.set('layer', new vscode.DataTransferItem(rows[0].name)); },
        handleDrop: (target, dataTransfer) => { drops.push({ target, names: dataTransfer.get(NAMES)?.value ?? dataTransfer.get('layer')?.value }); },
      },
      dragKind: (row) => (row.kind === 'layer' ? 'layer' : undefined),
      dropKinds: (row) => (row.kind === 'domain' ? ['tables'] : ['layer']),
    };
    s.provider.setSource('tables', s.tableTree, tableDnd);
    s.provider.setSource('diagrams', s.diagramTree, diagramDnd);
    await new Promise((r) => setTimeout(r, 200));
    await flush();
    return { ...s, drags, drops };
  }

  it('marks the rows that drag and the rows that take a drop, and none without a controller', async () => {
    const plain = await setUp();
    expect(JSON.stringify(lastState(plain.posted))).not.toMatch(/"drag"|"drop"/);
    const { posted } = await setUpDnd();
    expect(section(posted, 'tables').nodes[0]).toMatchObject({ drag: 'tables' });
    expect(section(posted, 'tables').nodes[0].drop).toBeUndefined();
    const layer = section(posted, 'diagrams').nodes[0];
    expect(layer).toMatchObject({ drag: 'layer', drop: ['layer'] });
    expect(layer.children![0].drag).toBeUndefined();
    expect(layer.children![0].drop).toEqual(['tables']);
  });

  it('runs the source view\'s handleDrag at dragStart and hands what it collected to the target view\'s handleDrop', async () => {
    const { send, drags, drops } = await setUpDnd();
    send({ type: 'dragStart', section: 'tables', ids: ['tables:table:dim_customer'] });
    await flush();
    // The drag is announced as it starts (the canvas hint), before any drop.
    expect(drags).toEqual([[tables[0]]]);
    send({ type: 'drop', section: 'diagrams', id: 'diagrams:domain:finance' });
    send({ type: 'dragEnd' });
    await flush();
    expect(drops).toEqual([{ target: diagrams[0].children![0], names: '["dim_customer"]' }]);
  });

  it('reorders through the same view: a layer row dropped on a layer row', async () => {
    const { send, drops } = await setUpDnd();
    send({ type: 'dragStart', section: 'diagrams', ids: ['diagrams:layer:gold'] });
    send({ type: 'drop', section: 'diagrams', id: 'diagrams:layer:gold' });
    await flush();
    expect(drops).toEqual([{ target: diagrams[0], names: 'gold' }]);
  });

  it('refuses what it did not offer: a row that takes another kind, an unknown row, a drop with no drag, a drag used twice', async () => {
    const { send, drags, drops } = await setUpDnd();
    // A table on a layer row (it takes layers only).
    send({ type: 'dragStart', section: 'tables', ids: ['tables:table:dim_customer'] });
    send({ type: 'drop', section: 'diagrams', id: 'diagrams:layer:gold' });
    await flush();
    // The same drag again on a row that would take it: used up by its first drop.
    send({ type: 'drop', section: 'diagrams', id: 'diagrams:domain:finance' });
    await flush();
    // A row that cannot be dragged, and one the host never listed.
    send({ type: 'dragStart', section: 'diagrams', ids: ['diagrams:domain:finance'] });
    send({ type: 'drop', section: 'diagrams', id: 'diagrams:domain:finance' });
    send({ type: 'dragStart', section: 'tables', ids: ['tables:table:nope'] });
    send({ type: 'drop', section: 'diagrams', id: 'diagrams:domain:finance' });
    // A drag that ended without a drop leaves nothing for a later drop.
    send({ type: 'dragStart', section: 'tables', ids: ['tables:table:dim_customer'] });
    send({ type: 'dragEnd' });
    send({ type: 'drop', section: 'diagrams', id: 'diagrams:domain:finance' });
    // A section that takes no drops.
    send({ type: 'dragStart', section: 'tables', ids: ['tables:table:dim_customer'] });
    send({ type: 'drop', section: 'tables', id: 'tables:table:dim_customer' });
    await flush();
    expect(drops).toEqual([]);
    expect(drags).toHaveLength(3);
  });

  it('a drag let go outside the sidebar: the source view is told the release point once its handleDrag has run, and only then', async () => {
    const s = await setUp();
    const order: string[] = [];
    const released: unknown[] = [];
    const at = { x: 812, y: 455, refX: 30, refY: 40, refScreenX: 118, refScreenY: 148, windowX: 40, windowY: 40 };
    let finishDrag: () => void = () => undefined;
    s.provider.setSource('tables', s.tableTree, {
      controller: { handleDrag: () => new Promise<void>((resolve) => { finishDrag = () => { order.push('handleDrag done'); resolve(); }; }) },
      dragKind: () => 'tables',
      released: (at) => { order.push('released'); released.push(at); },
    });
    await new Promise((r) => setTimeout(r, 200));
    await flush();
    s.send({ type: 'dragStart', section: 'tables', ids: ['tables:table:dim_customer'] });
    s.send({ type: 'dragEnd', at });
    await flush();
    expect(released).toEqual([]);
    finishDrag();
    await flush();
    expect(order).toEqual(['handleDrag done', 'released']);
    expect(released).toEqual([at]);
    // Used up: a second dragEnd, one with no point, or one with no drag says nothing.
    s.send({ type: 'dragEnd', at });
    s.send({ type: 'dragStart', section: 'tables', ids: ['tables:table:dim_customer'] });
    finishDrag();
    s.send({ type: 'dragEnd' });
    await flush();
    expect(released).toHaveLength(1);
  });

  it('a release point from a section whose bridge has no released handler (Diagrams layers) is ignored', async () => {
    const { send, drops } = await setUpDnd();
    send({ type: 'dragStart', section: 'diagrams', ids: ['diagrams:layer:gold'] });
    send({ type: 'dragEnd', at: { x: 5, y: 5, refX: 1, refY: 1, refScreenX: 2, refScreenY: 2, windowX: 0, windowY: 0 } });
    await flush();
    expect(drops).toEqual([]);
  });

  it('logs a handleDrag that throws and carries on: the target view gets an empty drop, nothing reaches the user', async () => {
    const s = await setUp();
    const dropped = vi.fn();
    s.provider.setSource('tables', s.tableTree, { controller: { handleDrag: () => { throw new Error('boom'); } }, dragKind: () => 'tables' });
    s.provider.setSource('diagrams', s.diagramTree, { controller: { handleDrop: dropped }, dropKinds: () => ['tables'] });
    await new Promise((r) => setTimeout(r, 200));
    await flush();
    s.send({ type: 'dragStart', section: 'tables', ids: ['tables:table:dim_customer'] });
    s.send({ type: 'drop', section: 'diagrams', id: 'diagrams:domain:finance' });
    await flush();
    // The target view still gets the (empty) drop, and says what it says for one: nothing is thrown at the user.
    expect(dropped).toHaveBeenCalledTimes(1);
  });
});

describe('the glass sidebar\'s multi-selection (the Table Library selects many)', () => {
  type Row = { type: 'schema' | 'model'; name: string; filePath?: string; children?: Row[] };
  const t = (name: string): Row => ({ type: 'model', name, filePath: `/ws/.erd-studio/gold/tables/sales/${name}.dbml` });
  const lib: Row[] = [{ type: 'schema', name: 'sales', children: [t('dim_customer'), t('dim_date'), t('fct_order')] }];
  const [a, b, c] = lib[0].children!;

  async function setUpLibrary() {
    const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    const v = fakeView();
    provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    provider.setSource<Row>('tables', {
      getChildren: (n?: Row) => (n ? n.children ?? [] : lib),
      getTreeItem: (n: Row) => {
        const item = new vscode.TreeItem(n.name, n.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None) as vscode.TreeItem;
        item.id = `${n.type}:${n.name}`;
        item.contextValue = n.type === 'model' ? 'logicalModel' : 'tableLibrarySchema';
        return item;
      },
    });
    provider.setSource('diagrams', tree(diagrams, (n) => (n.kind === 'layer' ? 'layerCreatable' : 'domain')));
    v.send({ type: 'ready' });
    await flush();
    const entries = pkg.contributes.menus!['view/item/context'];
    const entry = (command: string) => ({ menu: 'view/item/context', index: entries.findIndex((e) => e.command === command && (e.when ?? '').includes('erdStudio.modelLibrary')) });
    return { provider, ...v, entry };
  }

  it('marks the Table Library multiSelect, and Diagrams, Table Library and Relationships collapseAll, as their native views', async () => {
    const { posted } = await setUpLibrary();
    expect(lastState(posted).map((s) => [s.key, !!s.multiSelect, !!s.collapseAll])).toEqual([
      ['diagrams', false, true], ['tables', true, true], ['relationships', false, true], ['help', false, false],
    ]);
  });

  it('runs a row\'s command with (element, every selected element) when the row is in the selection', async () => {
    const { send, entry } = await setUpLibrary();
    send({ type: 'invoke', section: 'tables', id: 'tables:model:dim_date', ...entry('erdStudio.deleteLogicalModel'), selection: ['tables:model:dim_customer', 'tables:model:dim_date', 'tables:model:fct_order'] });
    await flush();
    expect(exec).toHaveBeenCalledWith('erdStudio.deleteLogicalModel', b, [a, b, c]);
    // What the commands read from it: Delete Table and Move Table test `selection.includes(node)`, Add to Diagram the same through tableRowsFromTreeArgs.
    const [, element, selection] = exec.mock.calls[exec.mock.calls.length - 1] as [string, Row, Row[]];
    expect(selection.includes(element)).toBe(true);
    expect(tableRowsFromTreeArgs(element, selection).map((r) => r.name)).toEqual(['dim_customer', 'dim_date', 'fct_order']);
  });

  it('keeps only rows it listed, runs a row outside the selection alone, and ignores a selection in a single-select section', async () => {
    const { send, entry } = await setUpLibrary();
    exec.mockClear();
    send({ type: 'invoke', section: 'tables', id: 'tables:model:fct_order', ...entry('erdStudio.moveTable'), selection: ['tables:model:dim_customer', 'tables:model:nope', 'tables:model:fct_order'] });
    await flush();
    expect(exec).toHaveBeenLastCalledWith('erdStudio.moveTable', c, [a, c]);
    send({ type: 'invoke', section: 'tables', id: 'tables:model:fct_order', ...entry('erdStudio.addToOpenDiagram'), selection: ['tables:model:dim_customer', 'tables:model:dim_date'] });
    await flush();
    expect(exec).toHaveBeenLastCalledWith('erdStudio.addToOpenDiagram', c, [c]);
    // With no selection field: the row alone, as before.
    send({ type: 'invoke', section: 'tables', id: 'tables:model:dim_date', ...entry('erdStudio.addToOpenDiagram') });
    await flush();
    expect(exec).toHaveBeenLastCalledWith('erdStudio.addToOpenDiagram', b, [b]);
    // Diagrams selects one row: its commands get the element only.
    const rename = pkg.contributes.menus!['view/item/context'].findIndex((e) => e.command === 'erdStudio.renameDomain');
    send({ type: 'invoke', section: 'diagrams', id: 'diagrams:domain:finance', menu: 'view/item/context', index: rename, selection: ['diagrams:domain:finance', 'diagrams:layer:gold'] });
    await flush();
    expect(exec).toHaveBeenLastCalledWith('erdStudio.renameDomain', diagrams[0].children![0]);
  });

  it('runs a row action on every selected row, however many (800 tables after Cmd/Ctrl+A); more than it takes runs on none, and says so', async () => {
    const many: Row[] = Array.from({ length: 800 }, (_, i) => t(`t${i}`));
    const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    const v = fakeView();
    provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    provider.setSource<Row>('tables', {
      getChildren: (n?: Row) => (n ? [] : many),
      getTreeItem: (n: Row) => {
        const item = new vscode.TreeItem(n.name) as vscode.TreeItem;
        item.id = `model:${n.name}`;
        item.contextValue = 'logicalModel';
        return item;
      },
    });
    v.send({ type: 'ready' });
    await flush();
    const index = pkg.contributes.menus!['view/item/context'].findIndex((e) => e.command === 'erdStudio.deleteLogicalModel' && (e.when ?? '').includes('erdStudio.modelLibrary'));
    const ids = many.map((r) => `tables:model:${r.name}`);
    v.send({ type: 'invoke', section: 'tables', id: ids[700], menu: 'view/item/context', index, selection: ids });
    await flush();
    expect(exec).toHaveBeenLastCalledWith('erdStudio.deleteLogicalModel', many[700], many);
    // Past what one action takes: nothing runs on part of it, and the user is told.
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    exec.mockClear();
    v.send({ type: 'invoke', section: 'tables', id: ids[0], menu: 'view/item/context', index, selection: Array.from({ length: MAX_ROWS_SENT + 1 }, (_, i) => ids[i % ids.length]) });
    await flush();
    expect(exec.mock.calls.filter((c) => c[0] === 'erdStudio.deleteLogicalModel')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${(MAX_ROWS_SENT + 1).toLocaleString('en-US')} rows are selected`));
    expect(warn.mock.calls[0][0]).toContain('Nothing was changed');
  });

  it('parses a selection as row ids only: deduplicated, every one kept (never part of it); anything else is refused', () => {
    const base = { type: 'invoke', section: 'tables', id: 'x', menu: 'view/item/context', index: 1 };
    expect(parseGlassInbound({ ...base, selection: ['x', 'y', 'x'] })).toEqual({ ...base, selection: ['x', 'y'] });
    // A Table Library of 800 tables, Cmd/Ctrl+A: all 800 (and the clicked row) reach the command.
    const big = Array.from({ length: 800 }, (_, i) => `r${i}`);
    const whole = parseGlassInbound({ ...base, selection: [...big, 'x'] }) as { selection: string[] };
    expect(whole.selection).toEqual([...big, 'x']);
    expect((parseGlassInbound({ ...base, selection: Array.from({ length: MAX_ROWS_SENT }, (_, i) => `r${i}`) }) as { selection: string[] }).selection).toHaveLength(MAX_ROWS_SENT);
    expect(parseGlassInbound({ ...base, selection: 'x' })).toBeUndefined();
    expect(parseGlassInbound({ ...base, selection: ['x', 7] })).toBeUndefined();
    expect(parseGlassInbound({ ...base, selection: ['x', ''] })).toBeUndefined();
    expect(parseGlassInbound({ ...base, selection: Array.from({ length: MAX_ROWS_SENT + 1 }, () => 'x') })).toBeUndefined();
    // A title action carries none.
    expect(parseGlassInbound({ type: 'invoke', section: 'tables', menu: 'view/title', index: 1, selection: ['x'] })).toEqual({ type: 'invoke', section: 'tables', menu: 'view/title', index: 1 });
  });
});

describe('the glass sidebar\'s reveal with expand (TreeView.reveal\'s expand option)', () => {
  type R = { name: string; children?: R[] };
  const roots: R[] = [{ name: 'gold', children: [{ name: 'fct_order', children: [{ name: 'to_customer', children: [{ name: 'col' }] }, { name: 'to_date' }] }] }];
  const parentOf = (n: R, among: R[] = roots, parent?: R): R | undefined => {
    for (const r of among) {
      if (r === n) return parent;
      const inner = r.children ? parentOf(n, r.children, r) : undefined;
      if (inner) return inner;
    }
    return undefined;
  };

  async function setUpRelationships() {
    const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    const v = fakeView();
    provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    provider.setSource<R>('relationships', {
      getChildren: (n?: R) => (n ? n.children ?? [] : roots),
      getTreeItem: (n: R) => {
        const item = new vscode.TreeItem(n.name, n.children ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None) as vscode.TreeItem;
        item.id = n.name;
        return item;
      },
      getParent: (n: R) => parentOf(n),
    });
    v.send({ type: 'ready' });
    await flush();
    return { provider, ...v };
  }
  const table = roots[0].children![0];

  it('opens the revealed row with expand: true, and nothing more without it', async () => {
    const { provider, posted } = await setUpRelationships();
    await provider.reveal('relationships', table, { focus: true, expand: true });
    expect(posted[posted.length - 1]).toEqual({ type: 'reveal', section: 'relationships', id: 'relationships:fct_order', expand: ['relationships:gold'], focus: true, open: ['relationships:fct_order'] });
    await provider.reveal('relationships', table, { focus: true });
    expect(posted[posted.length - 1]).toEqual({ type: 'reveal', section: 'relationships', id: 'relationships:fct_order', expand: ['relationships:gold'], focus: true });
  });

  it('reveals a row of a provider that lists afresh each time (an equal element, never the one listed) and gives its rows no id', async () => {
    // As the Table Library: every getChildren builds new nodes, table rows have no TreeItem id, getParent matches by value.
    type F = { kind: 'schema' | 'table'; name: string; parent?: string };
    const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    const v = fakeView();
    provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    provider.setSource<F>('tables', {
      getChildren: (n?: F) => (n ? [{ kind: 'table', name: 'dim_a', parent: n.name }, { kind: 'table', name: 'dim_b', parent: n.name }] : [{ kind: 'schema', name: 'gold' }]),
      getTreeItem: (n: F) => new vscode.TreeItem(n.name, n.kind === 'schema' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None) as vscode.TreeItem,
      getParent: (n: F) => (n.parent ? { kind: 'schema', name: n.parent } : undefined),
    });
    v.send({ type: 'ready' });
    await flush();
    await provider.reveal('tables', { kind: 'table', name: 'dim_b', parent: 'gold' }, { focus: true });
    expect(v.posted[v.posted.length - 1]).toEqual({ type: 'reveal', section: 'tables', id: 'tables/gold/dim_b', expand: ['tables/gold'], focus: true });
  });

  it('opens that many levels for a number (at most 3), and a leaf opens nothing', async () => {
    const { provider, posted } = await setUpRelationships();
    await provider.reveal('relationships', table, { expand: 2 });
    expect((posted[posted.length - 1] as { open?: string[] }).open).toEqual(['relationships:fct_order', 'relationships:to_customer']);
    await provider.reveal('relationships', roots[0], { expand: 99 });
    expect((posted[posted.length - 1] as { open?: string[] }).open).toEqual(['relationships:gold', 'relationships:fct_order', 'relationships:to_customer']);
    await provider.reveal('relationships', table.children![1], { expand: true });
    expect((posted[posted.length - 1] as { open?: string[] }).open).toBeUndefined();
  });
});

describe('parseGlassInbound', () => {
  it('reads a drag as row ids only', () => {
    expect(parseGlassInbound({ type: 'dragStart', section: 'tables', ids: ['a', 'b', 'a'], names: ['evil'] })).toEqual({ type: 'dragStart', section: 'tables', ids: ['a', 'b'] });
    expect(parseGlassInbound({ type: 'dragStart', section: 'tables', ids: [] })).toBeUndefined();
    expect(parseGlassInbound({ type: 'dragStart', section: 'tables', ids: 'a' })).toBeUndefined();
    expect(parseGlassInbound({ type: 'dragStart', section: 'tables', ids: ['a', 3] })).toBeUndefined();
    expect(parseGlassInbound({ type: 'dragStart', section: 'tables', ids: Array.from({ length: 800 }, (_, i) => `r${i}`) })).toMatchObject({ ids: expect.arrayContaining(['r799']) });
    expect(parseGlassInbound({ type: 'dragStart', section: 'tables', ids: Array.from({ length: MAX_ROWS_SENT + 1 }, (_, i) => `r${i}`) })).toBeUndefined();
    expect(parseGlassInbound({ type: 'drop', section: 'diagrams', id: 'x', uris: ['file:///etc/passwd'] })).toEqual({ type: 'drop', section: 'diagrams', id: 'x' });
    expect(parseGlassInbound({ type: 'drop', section: 'diagrams' })).toBeUndefined();
    expect(parseGlassInbound({ type: 'dragEnd', anything: 1 })).toEqual({ type: 'dragEnd' });
    // The release point: its eight finite numbers in range, else left out (the drag still ends).
    const at = { x: -20.5, y: 900, refX: 30, refY: 40, refScreenX: 118, refScreenY: 148, windowX: 40, windowY: 40 };
    expect(parseGlassInbound({ type: 'dragEnd', at })).toEqual({ type: 'dragEnd', at });
    for (const bad of [{ ...at, x: '1' }, { x: 1, y: 2 }, { ...at, y: Number.NaN }, { ...at, refX: 1_000_001 }, { ...at, path: '/etc' }, [1, 2], null, 'here']) {
      expect(parseGlassInbound({ type: 'dragEnd', at: bad })).toEqual({ type: 'dragEnd' });
    }
  });

  it('accepts the six message types and drops everything else', () => {
    expect(parseGlassInbound({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseGlassInbound({ type: 'expand', section: 'tables', id: 'x' })).toEqual({ type: 'expand', section: 'tables', id: 'x' });
    expect(parseGlassInbound({ type: 'invoke', section: 'help', menu: 'view/title', index: 2, command: 'evil' })).toEqual({ type: 'invoke', section: 'help', menu: 'view/title', index: 2 });
    expect(parseGlassInbound({ type: 'invoke', section: 'help', menu: 'view/title', index: -1 })).toBeUndefined();
    expect(parseGlassInbound({ type: 'invoke', section: 'help', menu: 'view/title', index: 1.5 })).toBeUndefined();
    expect(parseGlassInbound({ type: 'activate', section: 'nope', id: 'x' })).toBeUndefined();
    expect(parseGlassInbound({ type: 'activate', section: 'help', id: '' })).toBeUndefined();
    expect(parseGlassInbound({ type: 'openUrl', section: 'help', url: 'https://example.com' })).toBeUndefined();
    expect(parseGlassInbound(null)).toBeUndefined();
    expect(parseGlassInbound('ready')).toBeUndefined();
  });
});

describe('the search field drives the sidebar filter (the Filter… commands\' own path)', () => {
  type Row = { name: string; layer: string; columns: string[] };
  const libraryRows: Row[] = [
    { name: 'dim_customer', layer: 'gold', columns: ['customer_id', 'name'] },
    { name: 'fct_order', layer: 'gold', columns: ['order_id', 'customer_id'] },
    { name: 'stg_events', layer: 'silver', columns: ['event_id'] },
  ];

  /**
   * A tree shaped like the native providers': setFilter parses with the real
   * treeSearch parser and lists again; each root listing fires onDidFilter
   * with what it found (from inside getChildren, as they do); nothing found
   * lists the one `filterNoMatch` row.
   */
  function filterableTree(rows: Row[], spec: FilterSpec, noun: string) {
    const changed = new vscode.EventEmitter();
    const filtered = new vscode.EventEmitter();
    let query: TreeQuery | undefined;
    const t = {
      listings: 0,
      set: [] as string[],
      setFilter(text: string) {
        t.set.push(text);
        const q = parseTreeQuery(text, spec);
        const next = isEmptyQuery(q) ? undefined : q;
        if (next?.text === query?.text) return;
        query = next;
        changed.fire(undefined);
      },
      getFilter: () => query?.text ?? '',
      onDidFilter: filtered.event as vscode.Event<unknown>,
      onDidChangeTreeData: changed.event as vscode.Event<unknown>,
      headerTotal: () => `${rows.length} ${noun}`,
      getChildren(n?: Row): Row[] {
        if (n) return [];
        t.listings++;
        const kept = query ? rows.filter((r) => matchTreeQuery(query!, { name: r.name, facets: [{ key: 'layer', values: [r.layer] }, { key: 'col', text: false, values: r.columns }] })) : rows;
        filtered.fire(query ? { query, shown: kept.length, total: rows.length } : undefined);
        return query && kept.length === 0 ? [{ name: '__noMatch', layer: '', columns: [] }] : kept;
      },
      getTreeItem(r: Row) {
        const item = new vscode.TreeItem(r.name) as vscode.TreeItem;
        item.id = r.name;
        item.contextValue = r.name === '__noMatch' ? 'filterNoMatch' : 'logicalModel';
        return item;
      },
    };
    return t;
  }

  async function setUpSearch() {
    const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    const v = fakeView();
    provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    const trees = {
      diagrams: filterableTree([{ name: 'customer-360', layer: 'gold', columns: [] }, { name: 'orders', layer: 'silver', columns: [] }], VIEW_FILTERS.diagrams.spec, 'diagrams'),
      tables: filterableTree(libraryRows, VIEW_FILTERS.tableLibrary.spec, 'tables'),
      relationships: filterableTree([{ name: 'fct_order → dim_customer', layer: 'gold', columns: ['customer_id'] }], VIEW_FILTERS.relationships.spec, 'relationships'),
    };
    provider.setSource('diagrams', trees.diagrams);
    provider.setSource('tables', trees.tables);
    provider.setSource('relationships', trees.relationships);
    const helpRows: Node[] = [{ kind: 'table', name: 'Send Feedback' }];
    const help = tree(helpRows, () => 'helpAction');
    provider.setSource('help', help);
    // The native views' filters, as registerSidebarFilters makes them (the view a TreeView stand-in).
    const views: Record<SidebarFilterViewName, FilteredView> = {
      diagrams: { message: undefined, description: undefined },
      tableLibrary: { message: undefined, description: undefined },
      relationships: { message: undefined, description: undefined },
    };
    const filter = (name: SidebarFilterViewName, t: ReturnType<typeof filterableTree>) =>
      new SidebarFilter(views[name], t, { ...VIEW_FILTERS[name], contextKey: FILTER_COMMANDS[name].contextKey });
    const filters = { diagrams: filter('diagrams', trees.diagrams), tableLibrary: filter('tableLibrary', trees.tables), relationships: filter('relationships', trees.relationships) };
    provider.setFilters(filters);
    v.send({ type: 'ready' });
    await flush();
    return { provider, ...v, trees, views, filters, help, helpRows };
  }
  const stateMsg = (posted: GlassHostMessage[]) => posted.filter((m): m is Extract<GlassHostMessage, { type: 'state' }> => m.type === 'state').pop()!;
  const labels = (posted: GlassHostMessage[], key: string) => section(posted, key).nodes.map((n) => n.label);

  it('marks the three filterable sections, not Help & Feedback, and shows the empty field', async () => {
    const { posted } = await setUpSearch();
    expect(lastState(posted).map((s) => [s.key, !!s.filterable])).toEqual([['diagrams', true], ['tables', true], ['relationships', true], ['help', false]]);
    expect(stateMsg(posted).search).toBe('');
    expect(section(posted, 'tables').found).toBeUndefined();
  });

  it('applies the text to every filterable tree through its sidebar filter, finds rows by keys the page cannot see, and says what it found', async () => {
    const { send, posted, trees, views } = await setUpSearch();
    send({ type: 'search', text: 'col:customer_id ', seq: 1 });
    await flush();
    // The same text reached each tree's setFilter, through SidebarFilter.apply (which also set the native view's description and context key).
    expect(trees.tables.set).toEqual(['col:customer_id ']);
    expect(trees.diagrams.set).toEqual(['col:customer_id ']);
    expect(trees.relationships.set).toEqual(['col:customer_id ']);
    expect(views.tableLibrary.description).toBe('col:customer_id');
    expect(exec).toHaveBeenCalledWith('setContext', FILTER_COMMANDS.tableLibrary.contextKey, true);
    // A column match: the host's filter, not a label match.
    expect(labels(posted, 'tables')).toEqual(['dim_customer', 'fct_order']);
    const state = stateMsg(posted);
    // The field keeps exactly what was typed (its trailing space); the answer names its seq.
    expect(state.search).toBe('col:customer_id ');
    expect(state.searchSeq).toBe(1);
    expect(section(posted, 'tables').found).toEqual({ shown: 2, total: 3, noun: 'tables', text: 'Filtered: "col:customer_id" — 2 of 3 tables' });
    // Diagrams do not know col: — the native view's own words say so.
    const diagrams = section(posted, 'diagrams');
    expect(diagrams.found).toMatchObject({ shown: 0, total: 2, noun: 'diagrams', warnings: ['"col:" doesn\'t filter this view'] });
    expect(diagrams.nodes.map((n) => n.contextValue)).toEqual(['filterNoMatch']);
    // A filter typed in the field is cleared from the field: no Clear Filter in the headers.
    const clearIds = Object.values(FILTER_COMMANDS).map((c) => c.clear);
    for (const key of ['diagrams', 'tables', 'relationships']) {
      const nav = section(posted, key).actions.navigation;
      expect(nav.map((a) => pkg.contributes.menus!['view/title'][a.index]?.command).filter((c) => clearIds.includes(c as never))).toEqual([]);
    }
    // Help & Feedback has no host filter: untouched.
    expect(section(posted, 'help').found).toBeUndefined();
  });

  it('answers once per search, and the walk\'s own onDidFilter never starts another (no loop)', async () => {
    const { send, posted, trees } = await setUpSearch();
    const before = posted.filter((m) => m.type === 'state').length;
    const listed = trees.tables.listings;
    send({ type: 'search', text: 'cust', seq: 1 });
    await new Promise((r) => setTimeout(r, 400));
    await flush();
    expect(posted.filter((m) => m.type === 'state').length).toBe(before + 1);
    expect(trees.tables.listings).toBe(listed + 1);
    // The same filter again (a space more): nothing to list, but the answer still comes (its seq).
    send({ type: 'search', text: 'cust ', seq: 2 });
    await new Promise((r) => setTimeout(r, 300));
    await flush();
    expect(trees.tables.listings).toBe(listed + 1);
    expect(stateMsg(posted)).toMatchObject({ search: 'cust ', searchSeq: 2 });
    // An older seq answered late never takes the acknowledgement back.
    send({ type: 'search', text: 'cust ', seq: 1 });
    await flush();
    expect(stateMsg(posted).searchSeq).toBe(2);
  });

  it('lists Help & Feedback too when its tree changed just before a search (the debounce a search cuts short is every section\'s)', async () => {
    const { send, posted, help, helpRows } = await setUpSearch();
    expect(labels(posted, 'help')).toEqual(['Send Feedback']);
    // My Reports updated: the help tree changes, and within the debounce a search arrives.
    helpRows.push({ kind: 'table', name: 'My Reports' });
    help.fire();
    send({ type: 'search', text: 'cust', seq: 1 });
    await new Promise((r) => setTimeout(r, 300));
    await flush();
    expect(labels(posted, 'help')).toEqual(['Send Feedback', 'My Reports']);
    expect(stateMsg(posted).searchSeq).toBe(1);
  });

  it('answers a search with the newest listing: a walk started meanwhile (an expand) is waited for, never the rows it replaced', async () => {
    const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    const v = fakeView();
    provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    const rows = ['dim_customer', 'fct_order', 'stg_events'];
    // Each root listing waits until the test lets it finish, with the filter it was asked under.
    const gates: Array<() => void> = [];
    let filter = '';
    const changed = new vscode.EventEmitter();
    provider.setSource<string>('tables', {
      getChildren: (n?: string) => (n ? [] : new Promise<string[]>((resolve) => {
        const under = filter;
        gates.push(() => resolve(rows.filter((r) => r.includes(under))));
      })),
      getTreeItem: (n: string) => {
        const item = new vscode.TreeItem(n) as vscode.TreeItem;
        item.id = n;
        return item;
      },
      getFilter: () => filter,
      onDidChangeTreeData: changed.event as vscode.Event<unknown>,
    });
    provider.setFilters({ tableLibrary: { apply: (text: string) => { if (text.trim() === filter) return; filter = text.trim(); changed.fire(undefined); } } });
    v.send({ type: 'ready' });
    await flush();
    while (gates.length) gates.shift()!();
    await flush();
    expect(labels(v.posted, 'tables')).toEqual(rows);
    const answers = () => v.posted.filter((m): m is Extract<GlassHostMessage, { type: 'state' }> => m.type === 'state' && m.searchSeq === 1);
    // The search's walk starts; before it is done, an expand starts a newer one, which discards it.
    v.send({ type: 'search', text: 'cust', seq: 1 });
    await flush();
    v.send({ type: 'expand', section: 'tables', id: 'tables:dim_customer' });
    await flush();
    expect(gates).toHaveLength(2);
    gates.shift()!();
    await flush();
    // Not answered with the rows the discarded walk left in place (the unfiltered ones).
    expect(answers()).toEqual([]);
    gates.shift()!();
    await flush();
    expect(answers().length).toBeGreaterThan(0);
    for (const answer of answers()) expect(answer.sections.find((s) => s.key === 'tables')!.nodes.map((n) => n.label)).toEqual(['dim_customer']);
  });

  it('clears every filter when the field is cleared', async () => {
    const { send, posted, trees, views } = await setUpSearch();
    send({ type: 'search', text: 'layer:gold', seq: 1 });
    await flush();
    expect(labels(posted, 'diagrams')).toEqual(['customer-360']);
    send({ type: 'search', text: '', seq: 2 });
    await flush();
    expect([trees.diagrams.getFilter(), trees.tables.getFilter(), trees.relationships.getFilter()]).toEqual(['', '', '']);
    expect(views.tableLibrary.description).toBe('3 tables');
    expect(stateMsg(posted)).toMatchObject({ search: '', searchSeq: 2 });
    expect(section(posted, 'tables').found).toBeUndefined();
    expect(labels(posted, 'tables')).toEqual(['dim_customer', 'fct_order', 'stg_events']);
  });

  it('reflects a filter set from the Command Palette: shared, the field shows it; different, the field is empty and the section keeps its own Clear Filter', async () => {
    const { posted, filters } = await setUpSearch();
    // Filter Table Library… alone (the box applies as you type).
    filters.tableLibrary.apply('stg');
    recordContextKey(FILTER_COMMANDS.tableLibrary.contextKey, true);
    await new Promise((r) => setTimeout(r, 250));
    await flush();
    let state = stateMsg(posted);
    expect(state.search).toBeUndefined();
    expect(section(posted, 'tables')).toMatchObject({ filter: 'stg', found: { shown: 1, total: 3 } });
    const nav = section(posted, 'tables').actions.navigation.map((a) => pkg.contributes.menus!['view/title'][a.index]?.command);
    expect(nav).toContain(FILTER_COMMANDS.tableLibrary.clear);
    // The same filter on all three: the field shows it.
    filters.diagrams.apply('stg');
    filters.relationships.apply('stg');
    await new Promise((r) => setTimeout(r, 250));
    await flush();
    state = stateMsg(posted);
    expect(state.search).toBe('stg');
  });

  it('clearFilter before a reveal: the field\'s filter clears the field (every section), a section\'s own only that section', async () => {
    const { provider, send, trees, filters } = await setUpSearch();
    send({ type: 'search', text: 'cust', seq: 1 });
    await flush();
    provider.clearFilter('tables');
    expect([trees.diagrams.getFilter(), trees.tables.getFilter(), trees.relationships.getFilter()]).toEqual(['', '', '']);
    filters.tableLibrary.apply('stg');
    filters.diagrams.apply('orders');
    provider.clearFilter('tables');
    expect([trees.diagrams.getFilter(), trees.tables.getFilter()]).toEqual(['orders', '']);
  });

  it('puts the caret in the field on Focus Search: at once when loaded, else once the page is ready', async () => {
    const { provider, posted, view } = await setUpSearch();
    await provider.focusSearch();
    expect(view.show).toHaveBeenCalledWith(false);
    expect(posted[posted.length - 1]).toEqual({ type: 'focusSearch' });

    const later = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    const v = fakeView();
    later.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    await later.focusSearch();
    expect(v.posted).toEqual([]);
    v.send({ type: 'ready' });
    await flush();
    expect(v.posted.filter((m) => m.type === 'focusSearch')).toHaveLength(1);
  });

  it('reads a search as bounded plain text only: no command, no other field, nothing too long', () => {
    expect(GLASS_WEBVIEW_MESSAGE_TYPES).toContain('search');
    expect(parseGlassInbound({ type: 'search', text: 'layer:gold', seq: 3, command: 'workbench.action.terminal.new', section: 'tables' })).toEqual({ type: 'search', text: 'layer:gold', seq: 3 });
    expect(parseGlassInbound({ type: 'search', text: '' })).toEqual({ type: 'search', text: '' });
    expect(parseGlassInbound({ type: 'search', text: 'x'.repeat(GLASS_SEARCH_MAX_LENGTH) })).toBeDefined();
    expect(parseGlassInbound({ type: 'search', text: 'x'.repeat(GLASS_SEARCH_MAX_LENGTH + 1) })).toBeUndefined();
    expect(parseGlassInbound({ type: 'search', text: ['layer:gold'] })).toBeUndefined();
    expect(parseGlassInbound({ type: 'search' })).toBeUndefined();
    expect(parseGlassInbound({ type: 'search', text: 'x', seq: -1 })).toBeUndefined();
    expect(parseGlassInbound({ type: 'search', text: 'x', seq: 1.5 })).toBeUndefined();
    expect(parseGlassInbound({ type: 'search', text: 'x', seq: '1' })).toBeUndefined();
  });

  it('runs nothing for a search, whatever its text says', async () => {
    const { send } = await setUpSearch();
    exec.mockClear();
    send({ type: 'search', text: 'erdStudio.deleteDomain', seq: 1 });
    send({ type: 'search', text: 'command:workbench.action.terminal.new', seq: 2 });
    await flush();
    expect(exec.mock.calls.filter((c) => c[0] !== 'setContext')).toEqual([]);
  });

  it('builds its keys list from the three views\' filter specs (every key once, nothing they do not know), and the page carries it', async () => {
    const guide = glassFilterGuide();
    expect(guide.debounceMs).toBe(FILTER_DEBOUNCE_MS);
    const known = new Set(Object.values(VIEW_FILTERS).flatMap((v) => [
      ...v.spec.keys.filter((k) => k !== 'is').map((k) => `${k}:`),
      ...v.spec.flags.map((f) => `is:${f}`),
    ]));
    expect(new Set(guide.keys.map((k) => k.key))).toEqual(known);
    expect(guide.keys).toEqual(sidebarFilterKeys());
    expect(guide.keys.find((k) => k.key === 'col:')).toMatchObject({ where: 'tables, relationships' });
    expect(guide.keys.find((k) => k.key === 'is:unused')).toMatchObject({ where: 'tables' });
    expect(guide.keys.every((k) => k.meaning.length > 0)).toBe(true);
    const { view } = await setUpSearch();
    expect(view.webview.html).toContain('"key":"is:problem"');
  });
});
