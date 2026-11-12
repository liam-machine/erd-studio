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

import { GlassSidebarProvider, parseGlassInbound, type BridgedTree } from '../../src/providers/glassSidebar/GlassSidebarProvider';
import { _resetContextKeys, recordContextKey } from '../../src/providers/glassSidebar/contextKeys';
import type { Contributions } from '../../src/providers/glassSidebar/contributions';
import type { GlassHostMessage, GlassSection, SerialisedNode } from '../../src/providers/glassSidebar/protocol';

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
    // Table rows get Add to Diagram as a hover button: the drag the native tree offers cannot leave a webview.
    expect(section(posted, 'tables').nodes[0].inline?.map((a) => a.title)).toEqual(['Open in Diagram…', 'Add to Diagram…']);
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
    const add = section(posted, 'tables').nodes[0].inline!.find((a) => a.title === 'Add to Diagram…')!;
    send({ type: 'invoke', section: 'tables', id: 'tables:table:dim_customer', menu: add.menu, index: add.index });
    await flush();
    expect(exec).toHaveBeenCalledWith('erdStudio.addToDiagram', tables[0], [tables[0]]);
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
    const entry = d.welcome.find((w) => w.paragraphs.some((p) => p.parts.some((part) => part.kind === 'text' && part.text.startsWith('No diagrams yet'))))!;
    const button = entry.paragraphs.find((p) => p.button)!.parts[0] as { kind: 'link'; label: string; link: number };
    expect(button.label).toBe('New Diagram…');
    v.send({ type: 'welcomeLink', section: 'diagrams', entry: entry.entry, link: button.link });
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

describe('parseGlassInbound', () => {
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
