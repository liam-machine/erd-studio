/**
 * The glass sidebar's lifecycle and its place among the host's views
 * (GlassSidebarProvider): a page retained while hidden, which the host neither
 * lists for nor writes to until it shows again; "show the Diagrams view" that
 * reaches whichever sidebar is on; progress drawn on the section the work is
 * for; "on screen" as the page says it, not as the bridge lists; and rows
 * deeper than the eager listing that load when asked, never "Loading…" for good.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  GLASS_SIDEBAR_VIEW_ID,
  GlassSidebarProvider,
  parseGlassInbound,
  registerGlassSidebar,
  type BridgedTree,
} from '../../src/providers/glassSidebar/GlassSidebarProvider';
import { _resetContextKeys, recordContextKey } from '../../src/providers/glassSidebar/contextKeys';
import type { Contributions } from '../../src/providers/glassSidebar/contributions';
import { GLASS_WEBVIEW_MESSAGE_TYPES, type GlassHostMessage, type GlassSection, type SerialisedNode } from '../../src/providers/glassSidebar/protocol';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as { contributes: Contributions };

type Node = { name: string; children?: Node[] };

/** A tree that counts its root listings and can say it changed. */
function countingTree(roots: Node[]): BridgedTree<Node> & { fire(): void; listings: () => number } {
  const emitter = new vscode.EventEmitter();
  let listings = 0;
  return {
    getChildren: (n?: Node) => {
      if (!n) listings++;
      return n ? n.children ?? [] : roots;
    },
    getTreeItem: (n: Node) => {
      const item = new vscode.TreeItem(n.name, n.children ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None) as vscode.TreeItem;
      item.id = n.name;
      item.contextValue = 'logicalModel';
      return item;
    },
    onDidChangeTreeData: emitter.event as vscode.Event<unknown>,
    fire: () => emitter.fire(undefined),
    listings: () => listings,
  };
}

/** A webview view whose visibility the test drives (a hidden one takes no messages, as VS Code's). */
function fakeView() {
  let receive: ((m: unknown) => void) | undefined;
  let visibility: (() => void) | undefined;
  const posted: GlassHostMessage[] = [];
  const view = {
    visible: true,
    show: vi.fn(),
    onDidChangeVisibility: (fn: () => void) => { visibility = fn; return { dispose() {} }; },
    onDidDispose: () => ({ dispose() {} }),
    webview: {
      options: {},
      html: '',
      cspSource: 'https://webview.test',
      asWebviewUri: (u: { path: string }) => ({ toString: () => `https://webview.test${u.path}` }),
      postMessage: async (m: GlassHostMessage) => {
        if (!view.visible) throw new Error('posted to a hidden webview');
        posted.push(m);
        return true;
      },
      onDidReceiveMessage: (fn: (m: unknown) => void) => { receive = fn; return { dispose() {} }; },
    },
  };
  return {
    view,
    posted,
    send: (m: unknown) => receive!(m),
    setVisible: (on: boolean) => { view.visible = on; visibility?.(); },
  };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const states = (posted: GlassHostMessage[]) => posted.filter((m): m is Extract<GlassHostMessage, { type: 'state' }> => m.type === 'state');
const lastSection = (posted: GlassHostMessage[], key: string): GlassSection => states(posted).pop()!.sections.find((s) => s.key === key)!;

let exec: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetContextKeys();
  recordContextKey('erdStudio.hasProject', true);
  recordContextKey('erdStudio.hasLogicalModelsDir', true);
  recordContextKey('erdStudio.glassSidebar', true);
  exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetContextKeys();
});

async function setUp(options: { enabled?: () => boolean } = {}) {
  const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes, options);
  const v = fakeView();
  provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
  const diagrams = countingTree([{ name: 'gold', children: [{ name: 'finance' }] }]);
  const tables = countingTree([{ name: 'dim_customer' }]);
  provider.setSource('diagrams', diagrams);
  provider.setSource('tables', tables);
  v.send({ type: 'ready' });
  await flush();
  return { provider, ...v, diagrams, tables };
}

describe('hidden and shown again (the page is retained)', () => {
  it('registers the view retained while hidden', () => {
    const register = vi.spyOn(vscode.window, 'registerWebviewViewProvider');
    const state = new Map<string, unknown>();
    const context = {
      subscriptions: [] as vscode.Disposable[],
      extension: { packageJSON: pkg },
      extensionUri: vscode.Uri.file('/ext'),
      globalState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } },
    } as unknown as vscode.ExtensionContext;
    registerGlassSidebar(context);
    expect(register).toHaveBeenCalledWith(GLASS_SIDEBAR_VIEW_ID, expect.any(GlassSidebarProvider), { webviewOptions: { retainContextWhenHidden: true } });
    for (const d of context.subscriptions) d.dispose();
  });

  it('lists nothing and sends nothing while hidden; the first show lists each changed tree once and sends one state', async () => {
    const { posted, diagrams, tables, setVisible } = await setUp();
    const sent = posted.length;
    const before = { d: diagrams.listings(), t: tables.listings() };
    setVisible(false);
    // Several changes while hidden, and a context key: nothing listed, nothing posted.
    diagrams.fire(); diagrams.fire(); tables.fire();
    recordContextKey('erdStudio.storage', 'dbml');
    await new Promise((r) => setTimeout(r, 200));
    await flush();
    expect({ d: diagrams.listings(), t: tables.listings() }).toEqual(before);
    expect(posted.length).toBe(sent);

    setVisible(true);
    await new Promise((r) => setTimeout(r, 200));
    await flush();
    expect({ d: diagrams.listings(), t: tables.listings() }).toEqual({ d: before.d + 1, t: before.t + 1 });
    expect(states(posted.slice(sent))).toHaveLength(1);
  });

  it('shows again without listing or sending when nothing changed meanwhile', async () => {
    const { posted, diagrams, setVisible } = await setUp();
    const sent = posted.length;
    const listed = diagrams.listings();
    setVisible(false);
    setVisible(true);
    await flush();
    expect(diagrams.listings()).toBe(listed);
    expect(posted.length).toBe(sent);
  });

  it('keeps what was asked of a hidden page (show a section) and sends it after the state, once shown', async () => {
    const { provider, posted, view, diagrams, setVisible } = await setUp();
    setVisible(false);
    diagrams.fire();
    await provider.showSection('tables');
    expect(view.show).toHaveBeenCalledWith(false);
    expect(posted.filter((m) => m.type === 'showSection')).toEqual([]);
    setVisible(true);
    await flush();
    const tail = posted.slice(-2).map((m) => m.type);
    expect(tail).toEqual(['state', 'showSection']);
    expect(posted[posted.length - 1]).toEqual({ type: 'showSection', section: 'tables', focus: true });
  });

  it('a page reloaded in the same webview gets the whole state again without the trees being read again', async () => {
    const { posted, diagrams, tables, send } = await setUp();
    const before = { d: diagrams.listings(), t: tables.listings() };
    const sent = states(posted).length;
    send({ type: 'ready' });
    await flush();
    expect({ d: diagrams.listings(), t: tables.listings() }).toEqual(before);
    expect(states(posted)).toHaveLength(sent + 1);
  });

  it('a new webview for the view (re-resolved) lists every tree again: its image URIs are its own', async () => {
    const { provider, diagrams } = await setUp();
    const listed = diagrams.listings();
    const again = fakeView();
    provider.resolveWebviewView(again.view as unknown as vscode.WebviewView);
    again.send({ type: 'ready' });
    await flush();
    expect(diagrams.listings()).toBe(listed + 1);
    expect(states(again.posted)).toHaveLength(1);
  });

  it('a page that loads while hidden waits for the show to be listed for', async () => {
    const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    const v = fakeView();
    provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    const diagrams = countingTree([{ name: 'gold' }]);
    provider.setSource('diagrams', diagrams);
    v.view.visible = false;
    v.send({ type: 'ready' });
    await flush();
    expect(diagrams.listings()).toBe(0);
    v.setVisible(true);
    await flush();
    expect(diagrams.listings()).toBe(1);
    expect(states(v.posted)).toHaveLength(1);
  });
});

describe('"show the Diagrams view", wherever it is drawn (focusView)', () => {
  it('with the glass sidebar on: its section, unfolded and focused; the native view is not asked for', async () => {
    const { provider, posted, view } = await setUp({ enabled: () => true });
    exec.mockClear();
    await provider.focusView('diagrams');
    expect(view.show).toHaveBeenCalledWith(false);
    expect(posted[posted.length - 1]).toEqual({ type: 'showSection', section: 'diagrams', focus: true });
    expect(exec).not.toHaveBeenCalledWith('erdStudio.domainTree.focus');
    // Without focus: shown, the focus left where it was.
    await provider.focusView('tables', { focus: false });
    expect(view.show).toHaveBeenLastCalledWith(true);
    expect(posted[posted.length - 1]).toEqual({ type: 'showSection', section: 'tables', focus: false });
  });

  it('with it off: VS Code\'s own focus command for the native view, nothing sent to the page', async () => {
    const { provider, posted } = await setUp({ enabled: () => false });
    const sent = posted.length;
    await provider.focusView('diagrams');
    await provider.focusView('relationships');
    expect(exec).toHaveBeenCalledWith('erdStudio.domainTree.focus');
    expect(exec).toHaveBeenCalledWith('erdStudio.relationships.focus');
    expect(posted.length).toBe(sent);
  });

  it('opens a glass view not yet resolved, and shows the section once its page is ready', async () => {
    const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    await provider.showSection('diagrams');
    expect(exec).toHaveBeenCalledWith(`${GLASS_SIDEBAR_VIEW_ID}.focus`);
    const v = fakeView();
    provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    v.send({ type: 'ready' });
    await flush();
    expect(v.posted.map((m) => m.type)).toEqual(['state', 'showSection']);
  });
});

describe('progress where the work is (withSectionProgress)', () => {
  it('runs the native view\'s withProgress and marks the glass section busy until the task settles', async () => {
    const { provider, posted } = await setUp();
    const withProgress = vi.spyOn(vscode.window, 'withProgress');
    let finish!: () => void;
    const task = new Promise<void>((resolve) => { finish = resolve; });
    const run = provider.withSectionProgress('diagrams', () => task);
    expect(withProgress).toHaveBeenCalledWith({ location: { viewId: 'erdStudio.domainTree' } }, expect.any(Function));
    await new Promise((r) => setTimeout(r, 60));
    expect(lastSection(posted, 'diagrams').busy).toBe(true);
    expect(lastSection(posted, 'tables').busy).toBeUndefined();
    finish();
    await run;
    await new Promise((r) => setTimeout(r, 60));
    expect(lastSection(posted, 'diagrams').busy).toBeUndefined();
  });

  it('stays busy while any of two tasks runs, clears on a failure, and passes the result or error through', async () => {
    const { provider, posted } = await setUp();
    let finishA!: (v: number) => void;
    const a = provider.withSectionProgress('tables', () => new Promise<number>((r) => { finishA = r; }));
    const b = provider.withSectionProgress('tables', () => Promise.reject(new Error('read failed')));
    await expect(b).rejects.toThrow('read failed');
    await new Promise((r) => setTimeout(r, 60));
    expect(lastSection(posted, 'tables').busy).toBe(true);
    finishA(7);
    await expect(a).resolves.toBe(7);
    await new Promise((r) => setTimeout(r, 60));
    expect(lastSection(posted, 'tables').busy).toBeUndefined();
  });

  it('is in the state a hidden page gets once shown', async () => {
    const { provider, posted, setVisible } = await setUp();
    setVisible(false);
    let finish!: () => void;
    const run = provider.withSectionProgress('tables', () => new Promise<void>((r) => { finish = r; }));
    await new Promise((r) => setTimeout(r, 60));
    setVisible(true);
    await flush();
    expect(lastSection(posted, 'tables').busy).toBe(true);
    finish();
    await run;
  });
});

describe('on screen means drawn open in a visible view (sectionShown)', () => {
  it('is false until the page says the card is open, follows folds and visibility, and fires on each change', async () => {
    const { provider, send, setVisible } = await setUp();
    const fired = vi.fn();
    provider.onDidChangeShownSections(fired);
    // Listed (the bridge walked every section on ready), but nothing said yet about the cards.
    expect(provider.sectionShown('diagrams')).toBe(false);
    send({ type: 'sectionsShown', open: ['diagrams', 'tables'] });
    expect(provider.sectionShown('diagrams')).toBe(true);
    expect(fired).toHaveBeenCalledTimes(1);
    // The same list again: no change, no event.
    send({ type: 'sectionsShown', open: ['tables', 'diagrams'] });
    expect(fired).toHaveBeenCalledTimes(1);
    // Folded.
    send({ type: 'sectionsShown', open: ['tables'] });
    expect(provider.sectionShown('diagrams')).toBe(false);
    send({ type: 'sectionsShown', open: ['diagrams'] });
    // The view hidden, then shown.
    setVisible(false);
    expect(provider.sectionShown('diagrams')).toBe(false);
    setVisible(true);
    expect(provider.sectionShown('diagrams')).toBe(true);
    expect(fired.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('is false while the glass sidebar is off, and forgotten when the page reloads', async () => {
    let on = true;
    const { provider, send } = await setUp({ enabled: () => on });
    send({ type: 'sectionsShown', open: ['diagrams'] });
    expect(provider.sectionShown('diagrams')).toBe(true);
    on = false;
    expect(provider.sectionShown('diagrams')).toBe(false);
    on = true;
    send({ type: 'ready' });
    await flush();
    expect(provider.sectionShown('diagrams')).toBe(false);
  });

  it('says, to a provider\'s own callback, that the listing in progress is the bridge\'s (listingNow)', async () => {
    const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    const seen: boolean[] = [];
    const base = countingTree([{ name: 'gold', children: [{ name: 'finance' }] }]);
    provider.setSource('diagrams', { ...base, getChildren: (n?: Node) => { seen.push(provider.listingNow); return base.getChildren(n); } });
    const v = fakeView();
    provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    v.send({ type: 'ready' });
    await flush();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every(Boolean)).toBe(true);
    expect(provider.listingNow).toBe(false);
  });

  it('reads sectionsShown as known section keys only', () => {
    expect(GLASS_WEBVIEW_MESSAGE_TYPES).toContain('sectionsShown');
    expect(parseGlassInbound({ type: 'sectionsShown', open: ['diagrams', 'help', 'diagrams'] })).toEqual({ type: 'sectionsShown', open: ['diagrams', 'help'] });
    expect(parseGlassInbound({ type: 'sectionsShown', open: [] })).toEqual({ type: 'sectionsShown', open: [] });
    expect(parseGlassInbound({ type: 'sectionsShown', open: ['diagrams', 'erdStudio.domainTree'] })).toBeUndefined();
    expect(parseGlassInbound({ type: 'sectionsShown', open: 'diagrams' })).toBeUndefined();
    expect(parseGlassInbound({ type: 'sectionsShown', open: [1] })).toBeUndefined();
    expect(parseGlassInbound({ type: 'sectionsShown' })).toBeUndefined();
    expect(parseGlassInbound({ type: 'sectionsShown', open: new Array(100).fill('tables') })).toBeUndefined();
  });
});

describe('rows deeper than the eager listing', () => {
  /** A chain `levels` deep: each row has one child, every row collapsed. */
  function chain(levels: number): Node[] {
    let node: Node = { name: `n${levels - 1}` };
    for (let i = levels - 2; i >= 0; i--) node = { name: `n${i}`, children: [node] };
    return [node];
  }

  function find(nodes: SerialisedNode[], label: string): SerialisedNode | undefined {
    for (const n of nodes) {
      if (n.label === label) return n;
      const inner = n.children ? find(n.children, label) : undefined;
      if (inner) return inner;
    }
    return undefined;
  }

  it('lists a row past the eager depth when it is expanded, whatever its depth', async () => {
    const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    const v = fakeView();
    provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    provider.setSource('tables', countingTree(chain(14)));
    v.send({ type: 'ready' });
    await flush();
    // The eager pass stops: n8 is listed, its children are not.
    const n8 = find(lastSection(v.posted, 'tables').nodes, 'n8')!;
    expect(n8.childrenLoaded).toBe(false);
    v.send({ type: 'expand', section: 'tables', id: n8.id });
    await flush();
    const after = find(lastSection(v.posted, 'tables').nodes, 'n8')!;
    expect(after.childrenLoaded).toBe(true);
    expect(after.children!.map((c) => c.label)).toEqual(['n9']);
    // And on down, one level per expand.
    const n9 = after.children![0];
    expect(n9.childrenLoaded).toBe(false);
    v.send({ type: 'expand', section: 'tables', id: n9.id });
    await flush();
    expect(find(lastSection(v.posted, 'tables').nodes, 'n9')!.children!.map((c) => c.label)).toEqual(['n10']);
  });

  it('stops a tree that nests without end at a sane depth, with a leaf there instead of a row that never loads', async () => {
    // Every row has a child, for ever (a cycle through getChildren).
    const endless: BridgedTree<number> = {
      getChildren: (n?: number) => [n === undefined ? 0 : n + 1],
      getTreeItem: (n: number) => {
        const item = new vscode.TreeItem(`r${n}`, vscode.TreeItemCollapsibleState.Collapsed) as vscode.TreeItem;
        item.id = `r${n}`;
        return item;
      },
    };
    const provider = new GlassSidebarProvider(vscode.Uri.file('/ext') as vscode.Uri, pkg.contributes);
    const v = fakeView();
    provider.resolveWebviewView(v.view as unknown as vscode.WebviewView);
    provider.setSource('tables', endless);
    v.send({ type: 'ready' });
    await flush();
    // Expand the deepest unlisted row until none is left: it ends, and never in a row left loading.
    const deepest = (nodes: SerialisedNode[]): SerialisedNode => {
      let at = nodes[0];
      while (at.children && at.children.length) at = at.children[0];
      return at;
    };
    let rounds = 0;
    for (; rounds < 200; rounds++) {
      const last = deepest(lastSection(v.posted, 'tables').nodes);
      if (last.childrenLoaded !== false) break;
      v.send({ type: 'expand', section: 'tables', id: last.id });
      await flush();
    }
    expect(rounds).toBeLessThan(200);
    const last = deepest(lastSection(v.posted, 'tables').nodes);
    expect(last.collapsible).toBe(0);
    expect(last.childrenLoaded).toBeUndefined();
    expect(Number(last.label.slice(1))).toBeGreaterThanOrEqual(32);
  });
});
