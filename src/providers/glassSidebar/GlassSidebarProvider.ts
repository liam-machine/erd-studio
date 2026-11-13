/**
 * The glass sidebar (design prototype, exp/glass-ui): one WebviewView that
 * draws the four native ERD Studio trees (Diagrams, Table Library,
 * Relationships, Help & Feedback) as glass cards.
 *
 * Nothing is duplicated: it is a bridge over the SAME TreeDataProviders the
 * native views use. It walks `getChildren()` / `getTreeItem()` (eagerly, up to
 * a node budget per section; past it a collapsed row lists when expanded),
 * serialises each TreeItem to JSON ({@link serialiseTreeItem}) and keeps a
 * host-side map id → original element, so every action runs against the real
 * element. Row menus, inline buttons, title actions, section visibility and
 * empty states come from this extension's own package.json, decided by the
 * native views' `when` clauses over a mirror of the `erdStudio.*` context
 * keys ({@link ContributionIndex}, {@link evaluateWhen}, contextKeys.ts), then
 * put in one shape for every section: headers by titleActions.ts, rows (one
 * hover button, menus in one verb order) by rowActions.ts.
 *
 * The webview never names a command or a URL: it sends a row id and a menu
 * entry index, and the host looks both up and re-checks the entry's `when`.
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';

import { log } from '../../services/logger';
import { contextKeyValue, onDidChangeContextKey } from './contextKeys';
import {
  ContributionIndex,
  GLASS_SIDEBAR_CONTEXT_KEY,
  parseCommandLink,
  parseWelcomeContents,
  withoutGlassClause,
  type Contributions,
} from './contributions';
import { buildGlassSidebarHtml } from './html';
import type { GlassHostMessage, GlassMenuEntry, GlassSection, GlassSectionKey, GlassWebviewMessage, SerialisedNode } from './protocol';
import { consistentRowActions, type RowActions } from './rowActions';
import { nodeId, serialiseTreeItem } from './serialise';
import { consistentTitleActions } from './titleActions';
import { evaluateWhen, type ContextLookup } from './whenClause';

export const GLASS_SIDEBAR_VIEW_ID = 'erdStudio.glassSidebar';
export const TOGGLE_GLASS_SIDEBAR_COMMAND = 'erdStudio.toggleGlassSidebar';
/** globalState: whether the glass sidebar replaces the native trees (default on for the prototype). */
export const GLASS_SIDEBAR_ENABLED_KEY = 'erdStudio.glassSidebar.enabled';

export type { GlassSectionKey } from './protocol';

/** The sections, in order, and the native view each one stands for. */
export const GLASS_SECTIONS: ReadonlyArray<{ key: GlassSectionKey; viewId: string; multiSelect: boolean }> = [
  { key: 'diagrams', viewId: 'erdStudio.domainTree', multiSelect: false },
  // The native Table Library is canSelectMany: its menu commands get (element, selection).
  { key: 'tables', viewId: 'erdStudio.modelLibrary', multiSelect: true },
  { key: 'relationships', viewId: 'erdStudio.relationships', multiSelect: false },
  { key: 'help', viewId: 'erdStudio.help', multiSelect: false },
];

/** A tree the glass sidebar can draw: a TreeDataProvider, plus the sidebar filter's optional extras. */
export interface BridgedTree<T = unknown> {
  getChildren(element?: T): vscode.ProviderResult<T[]>;
  getTreeItem(element: T): vscode.TreeItem | Thenable<vscode.TreeItem>;
  getParent?(element: T): vscode.ProviderResult<T>;
  readonly onDidChangeTreeData?: vscode.Event<unknown>;
  /** `17 tables`: the count pill (sidebarFilter's FilterableTree). */
  headerTotal?(): string | undefined;
  /** The filter in force (sidebarFilter's FilterableTree). */
  getFilter?(): string;
  readonly onDidFilter?: vscode.Event<unknown>;
}

/** Rows listed eagerly per section before collapsed rows wait to be expanded. */
const NODE_BUDGET = 2500;
const MAX_DEPTH = 8;
const TREE_DEBOUNCE_MS = 120;
const CONTEXT_DEBOUNCE_MS = 40;
const MAX_ID_LENGTH = 4096;

interface SectionState {
  readonly key: GlassSectionKey;
  readonly viewId: string;
  readonly multiSelect: boolean;
  tree?: BridgedTree;
  subscriptions: vscode.Disposable[];
  nodes: SerialisedNode[];
  elements: Map<string, unknown>;
  items: Map<string, vscode.TreeItem>;
  parents: Map<string, string | undefined>;
  /** Row ids the user expanded past the budget: always listed. */
  requested: Set<string>;
  walked: boolean;
  dirty: boolean;
  generation: number;
}

type Inbound = GlassWebviewMessage;

const SECTION_KEYS = new Set<string>(GLASS_SECTIONS.map((section) => section.key));

/**
 * The shape check of a webview message (pure; ids are checked against the
 * section's map by the provider). Anything else is dropped.
 */
export function parseGlassInbound(raw: unknown): Inbound | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 10000;
  const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH;
  if (m.type === 'ready') return { type: 'ready' };
  if (typeof m.section !== 'string' || !SECTION_KEYS.has(m.section)) return undefined;
  const section = m.section as GlassSectionKey;
  switch (m.type) {
    case 'activate':
    case 'expand':
    case 'itemMenu':
      return isId(m.id) ? { type: m.type, section, id: m.id } : undefined;
    case 'invoke':
      if (typeof m.menu !== 'string' || m.menu.length > 200 || !isIndex(m.index)) return undefined;
      if (m.id !== undefined && !isId(m.id)) return undefined;
      return { type: 'invoke', section, ...(m.id !== undefined ? { id: m.id as string } : {}), menu: m.menu, index: m.index };
    case 'welcomeLink':
      return isIndex(m.entry) && isIndex(m.link) ? { type: 'welcomeLink', section, entry: m.entry, link: m.link } : undefined;
    default:
      return undefined;
  }
}

export class GlassSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private viewSubscriptions: vscode.Disposable[] = [];
  private readonly sections = new Map<GlassSectionKey, SectionState>();
  private readonly index: ContributionIndex;
  private readonly subscriptions: vscode.Disposable[] = [];
  private postTimer: ReturnType<typeof setTimeout> | undefined;
  /** One debounce for every section's tree changes: the dirty sections are walked together and posted once. */
  private treeTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The JSON of the last `state` the webview was sent. A snapshot equal to it
   * is not sent again (cleared whenever the webview (re)loads, or a send fails).
   */
  private lastPosted: string | undefined;
  private ready = false;
  /** A reveal asked for before the webview had loaded: run once it is ready. */
  private pendingReveal: { key: GlassSectionKey; element: unknown; options: { focus?: boolean } } | undefined;

  constructor(private readonly extensionUri: vscode.Uri, contributes: Contributions) {
    this.index = new ContributionIndex(contributes);
    for (const s of GLASS_SECTIONS) {
      this.sections.set(s.key, {
        key: s.key, viewId: s.viewId, multiSelect: s.multiSelect,
        subscriptions: [], nodes: [], elements: new Map(), items: new Map(), parents: new Map(),
        requested: new Set(), walked: false, dirty: true, generation: 0,
      });
    }
    // Menus, visibility and empty states follow the context keys: re-send (no re-walk).
    this.subscriptions.push(onDidChangeContextKey(() => this.schedulePost()));
    this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders?.(() => this.schedulePost()) ?? { dispose: () => {} });
  }

  // ------------------------------------------------------------------ sources

  /** Draw `tree` in `section` (the native view keeps its own provider: this only reads it). */
  setSource(key: GlassSectionKey, tree: BridgedTree): void {
    const section = this.sections.get(key)!;
    for (const d of section.subscriptions) d.dispose();
    section.subscriptions = [];
    section.tree = tree;
    if (tree.onDidChangeTreeData) section.subscriptions.push(tree.onDidChangeTreeData(() => this.invalidate(section)));
    // The bridged trees fire onDidFilter from inside their own root getChildren()
    // (so the native view's title can show the count), i.e. during every walk.
    // Re-walking on it loops forever (walk -> onDidFilter -> walk ...). A filter
    // change already arrives as onDidChangeTreeData (setFilter refreshes), and the
    // count pill and filter chip are read at snapshot time, so this only re-sends
    // the snapshot, which post() drops when nothing changed.
    if (tree.onDidFilter) section.subscriptions.push(tree.onDidFilter(() => this.schedulePost()));
    this.invalidate(section);
  }

  /** Whether the glass view is on screen. */
  get visible(): boolean {
    return this.view?.visible === true;
  }

  // ---------------------------------------------------------------- the view

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    for (const d of this.viewSubscriptions) d.dispose();
    this.view = webviewView;
    this.ready = false;
    this.lastPosted = undefined;
    const nonce = crypto.randomBytes(16).toString('base64');
    // The page first, then the options: when the view is re-resolved while already on
    // screen (toggling back from the native panes), setting options first makes VS Code
    // load the still-empty page, which it reports as "a webview without a content
    // security policy". Every load then carries the CSP meta tag.
    webviewView.webview.html = buildGlassSidebarHtml({
      cspSource: webviewView.webview.cspSource,
      nonce,
      tokensCssUri: webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css')).toString(),
    });
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    this.viewSubscriptions = [
      webviewView.webview.onDidReceiveMessage((raw: unknown) => { void this.onMessage(raw); }),
      webviewView.onDidChangeVisibility(() => { if (webviewView.visible) void this.refreshDirty(); }),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) { this.view = undefined; this.ready = false; this.lastPosted = undefined; }
      }),
    ];
  }

  /**
   * Select (and scroll to) `element`'s row in `key`, expanding its ancestors,
   * as `TreeView.reveal` does on the native trees. Shows the view when asked.
   */
  async reveal(key: GlassSectionKey, element: unknown, options: { focus?: boolean } = {}): Promise<void> {
    const section = this.sections.get(key)!;
    const tree = section.tree;
    if (!tree) return;
    // Ancestors first (getParent), so a row past the budget is listed.
    const chain: unknown[] = [];
    let at: unknown = element;
    for (let i = 0; i < MAX_DEPTH && at !== undefined && at !== null; i++) {
      chain.unshift(at);
      at = tree.getParent ? await tree.getParent(at) : undefined;
    }
    if (!this.view || !this.ready) {
      // Not loaded yet: open it (VS Code's generated `<view>.focus`), and reveal once its script is listening.
      this.pendingReveal = { key, element, options };
      if (!this.view) await vscode.commands.executeCommand(`${GLASS_SIDEBAR_VIEW_ID}.focus`).then(undefined, () => undefined);
      else this.view.show(!options.focus);
      return;
    }
    if (!this.view.visible || options.focus) this.view.show(!options.focus);
    if (!section.walked || section.dirty) await this.walk(section);
    let ids = await this.idsOf(section, chain);
    // A row under collapsed ancestors past the budget: list that path one level per pass, then look again.
    for (let pass = 0; pass < MAX_DEPTH && ids.some((id) => id === undefined); pass++) {
      const before = section.requested.size;
      for (const id of ids) if (id) section.requested.add(id);
      if (section.requested.size === before) break;
      await this.walk(section);
      ids = await this.idsOf(section, chain);
    }
    const target = ids[ids.length - 1];
    if (!target) return;
    this.post();
    this.send({ type: 'reveal', section: key, id: target, expand: ids.filter((id): id is string => id !== undefined).slice(0, -1), focus: options.focus === true });
  }

  /** Each element of `chain`'s row id: by identity, else by its TreeItem's own id. */
  private async idsOf(section: SectionState, chain: unknown[]): Promise<Array<string | undefined>> {
    const out: Array<string | undefined> = [];
    for (const element of chain) {
      let found: string | undefined;
      for (const [id, e] of section.elements) if (e === element) { found = id; break; }
      if (!found && section.tree) {
        const own = (await section.tree.getTreeItem(element)).id;
        if (own && section.elements.has(`${section.key}:${own}`)) found = `${section.key}:${own}`;
      }
      out.push(found);
    }
    return out;
  }

  // ----------------------------------------------------------------- walking

  private invalidate(section: SectionState): void {
    section.dirty = true;
    if (!this.visible || !this.ready) return;
    if (this.treeTimer) clearTimeout(this.treeTimer);
    this.treeTimer = setTimeout(() => {
      this.treeTimer = undefined;
      void this.refreshDirty();
    }, TREE_DEBOUNCE_MS);
  }

  private async refreshDirty(): Promise<void> {
    if (!this.ready) return;
    await Promise.all([...this.sections.values()].filter((s) => s.dirty || !s.walked).map((s) => this.walk(s)));
    this.post();
  }

  /** List `section`'s tree into JSON (and the id → element map). A newer walk supersedes an older one. */
  private async walk(section: SectionState): Promise<void> {
    const generation = ++section.generation;
    section.dirty = false;
    const tree = section.tree;
    if (!tree) {
      section.nodes = [];
      section.walked = true;
      return;
    }
    const elements = new Map<string, unknown>();
    const items = new Map<string, vscode.TreeItem>();
    const parents = new Map<string, string | undefined>();
    let budget = NODE_BUDGET;
    const toWebviewUri = (uri: vscode.Uri): string | undefined => this.view?.webview.asWebviewUri(uri).toString();
    const visit = async (element: unknown, parentId: string | undefined, depth: number): Promise<SerialisedNode[]> => {
      const children = (await tree.getChildren(element)) ?? [];
      const seen = new Map<string, number>();
      const out: SerialisedNode[] = [];
      for (const child of children) {
        const item = await tree.getTreeItem(child);
        const id = nodeId(section.key, parentId, item, seen);
        const node = serialiseTreeItem(item, id, toWebviewUri);
        elements.set(id, child);
        items.set(id, item);
        parents.set(id, parentId);
        budget--;
        if (node.collapsible) {
          const load = depth < MAX_DEPTH && (budget > 0 || node.collapsible === 2 || section.requested.has(id));
          if (load) {
            node.children = await visit(child, id, depth + 1);
            node.childrenLoaded = true;
          } else {
            node.childrenLoaded = false;
          }
        }
        out.push(node);
      }
      return out;
    };
    try {
      const nodes = await visit(undefined, undefined, 0);
      if (generation !== section.generation) return;
      section.nodes = nodes;
      section.elements = elements;
      section.items = items;
      section.parents = parents;
      section.walked = true;
    } catch (err) {
      if (generation !== section.generation) return;
      // The native view would show its error the same way: the last good rows stay.
      log.warn(`[ERD Studio] Glass sidebar: listing ${section.viewId} failed:`, err);
      section.walked = true;
    }
  }

  // ---------------------------------------------------------------- context

  /** The context a `when` clause sees: the mirrored erdStudio.* keys, plus `view`, `viewItem` and the folder count. */
  private context(viewId: string | undefined, viewItem?: string): ContextLookup {
    return (key: string) => {
      if (key === 'view') return viewId;
      if (key === 'viewItem') return viewItem;
      if (key === 'workspaceFolderCount') return vscode.workspace.workspaceFolders?.length ?? 0;
      return contextKeyValue(key);
    };
  }

  /** A row's hover button and menu: package.json's `view/item/context` for it, in the one shape every section shares. */
  private rowActions(viewId: string, viewItem: string | undefined): RowActions {
    return consistentRowActions(
      this.index.resolve('view/item/context', this.context(viewId, viewItem)),
      (a) => (a.submenu ? undefined : this.index.menu(a.menu)[a.index]?.command),
    );
  }

  private viewContribution(section: SectionState) {
    return this.index.views().find((v) => v.id === section.viewId);
  }

  // ----------------------------------------------------------------- posting

  private schedulePost(): void {
    if (!this.visible || !this.ready) return;
    if (this.postTimer) clearTimeout(this.postTimer);
    this.postTimer = setTimeout(() => { this.postTimer = undefined; this.post(); }, CONTEXT_DEBOUNCE_MS);
  }

  /** The whole sidebar as the webview draws it. */
  snapshot(): Extract<GlassHostMessage, { type: 'state' }> {
    const base = this.context(undefined);
    const sections = GLASS_SECTIONS.map(({ key }): GlassSection => {
      const section = this.sections.get(key)!;
      const contribution = this.viewContribution(section);
      const titleCtx = this.context(section.viewId);
      // One header shape for every section: `+` then `…` (titleActions.ts).
      const actions = consistentTitleActions(
        this.index.resolve('view/title', titleCtx),
        (a) => (a.submenu ? undefined : this.index.menu(a.menu)[a.index]?.command),
      );
      // The native view's own clause, without the `!erdStudio.glassSidebar` that hides it while this view shows.
      const visible = evaluateWhen(withoutGlassClause(contribution?.when), base);
      // Rows share a handful of contextValues: resolve each one's menu once per snapshot.
      const menus = new Map<string | undefined, RowActions>();
      const menuOf = (viewItem: string | undefined) => {
        let menu = menus.get(viewItem);
        if (!menu) { menu = this.rowActions(section.viewId, viewItem); menus.set(viewItem, menu); }
        return menu;
      };
      const decorate = (nodes: SerialisedNode[]): SerialisedNode[] => nodes.map((n) => {
        const menu = menuOf(n.contextValue);
        const out: SerialisedNode = { ...n };
        // One hover button at most, then `…` (rowActions.ts).
        if (menu.inline.length) out.inline = menu.inline.map((a) => ({ index: a.index, menu: a.menu, title: a.title, ...(a.icon ? { icon: a.icon } : {}) }));
        else delete out.inline;
        out.hasMenu = menu.groups.length > 0;
        if (n.children) out.children = decorate(n.children);
        return out;
      });
      const welcome = this.index.welcome(section.viewId, base).map(({ index, contents }) => ({
        entry: index,
        paragraphs: parseWelcomeContents(contents).paragraphs,
      }));
      const filter = section.tree?.getFilter?.();
      return {
        key,
        title: contribution?.name ?? key,
        visible,
        defaultCollapsed: contribution?.visibility === 'collapsed',
        ...(section.tree?.headerTotal?.() ? { count: section.tree.headerTotal!()! } : {}),
        ...(filter && filter.trim() !== '' ? { filter } : {}),
        actions: { navigation: actions.navigation, groups: actions.groups },
        welcome,
        nodes: decorate(section.nodes),
      };
    });
    return { type: 'state', sections };
  }

  /** Send the snapshot, unless it is exactly what the webview already has. */
  private post(): void {
    if (!this.view || !this.ready) return;
    if (this.postTimer) { clearTimeout(this.postTimer); this.postTimer = undefined; }
    const snapshot = this.snapshot();
    const json = JSON.stringify(snapshot);
    if (json === this.lastPosted) return;
    this.lastPosted = json;
    this.send(snapshot);
  }

  private send(message: GlassHostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  // ---------------------------------------------------------------- messages

  private async onMessage(raw: unknown): Promise<void> {
    const msg = parseGlassInbound(raw);
    if (!msg) {
      log.debug?.('[ERD Studio] Glass sidebar: dropped an unknown message');
      return;
    }
    try {
      await this.handle(msg);
    } catch (err) {
      log.warn('[ERD Studio] Glass sidebar: an action failed:', err);
    }
  }

  private async handle(msg: Inbound): Promise<void> {
    if (msg.type === 'ready') {
      this.ready = true;
      // A (re)loaded page has nothing yet: always send it the whole state.
      this.lastPosted = undefined;
      await Promise.all([...this.sections.values()].map((s) => this.walk(s)));
      this.post();
      const pending = this.pendingReveal;
      this.pendingReveal = undefined;
      if (pending) await this.reveal(pending.key, pending.element, pending.options);
      return;
    }
    const section = this.sections.get(msg.section)!;
    switch (msg.type) {
      case 'activate': {
        const item = section.items.get(msg.id);
        if (!item) return;
        const command = item.command;
        if (command?.command) await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
        return;
      }
      case 'expand': {
        if (!section.elements.has(msg.id)) return;
        section.requested.add(msg.id);
        await this.walk(section);
        this.post();
        return;
      }
      case 'itemMenu': {
        const item = section.items.get(msg.id);
        if (!item) return;
        const groups: GlassMenuEntry[][] = this.rowActions(section.viewId, item.contextValue).groups;
        this.send({ type: 'itemMenu', section: section.key, id: msg.id, groups });
        return;
      }
      case 'invoke': {
        if (msg.id !== undefined) {
          const item = section.items.get(msg.id);
          if (!item || !section.elements.has(msg.id)) return;
          const element = section.elements.get(msg.id);
          const command = this.index.commandFor(msg.menu, msg.index, this.context(section.viewId, item.contextValue), new Set(['view/item/context']));
          if (!command) return;
          // As a native tree: the element, and the selection where the view selects many.
          await vscode.commands.executeCommand(command, ...(section.multiSelect ? [element, [element]] : [element]));
          return;
        }
        const ctx = this.context(section.viewId);
        const allowed = new Set(['view/title', ...this.index.submenusOf('view/title', ctx)]);
        const command = this.index.commandFor(msg.menu, msg.index, ctx, allowed);
        if (command) await vscode.commands.executeCommand(command);
        return;
      }
      case 'welcomeLink': {
        // Only an empty state the section shows now, and only a link in it.
        if (section.nodes.length > 0) return;
        const shown = this.index.welcome(section.viewId, this.context(undefined)).some((w) => w.index === msg.entry);
        const entry = shown ? this.index.welcomeEntry(msg.entry) : undefined;
        if (!entry || entry.view !== section.viewId) return;
        const link = parseWelcomeContents(entry.contents).links[msg.link];
        const parsed = link ? parseCommandLink(link.href) : undefined;
        if (parsed) await vscode.commands.executeCommand(parsed.command, ...parsed.args);
        return;
      }
    }
  }

  dispose(): void {
    for (const d of this.viewSubscriptions) d.dispose();
    for (const d of this.subscriptions) d.dispose();
    for (const s of this.sections.values()) {
      for (const d of s.subscriptions) d.dispose();
    }
    if (this.postTimer) clearTimeout(this.postTimer);
    if (this.treeTimer) clearTimeout(this.treeTimer);
  }
}

/** Whether the glass sidebar is on (globalState; on by default in this prototype). */
export function glassSidebarEnabled(state: vscode.Memento): boolean {
  return state.get<boolean>(GLASS_SIDEBAR_ENABLED_KEY) !== false;
}

/**
 * Register the glass sidebar's view provider and its toggle, and set the
 * context key the views' `when` clauses read. Called before activation's
 * no-project return, so both work in an empty window.
 */
export function registerGlassSidebar(context: vscode.ExtensionContext): GlassSidebarProvider {
  const contributes = ((context.extension?.packageJSON as { contributes?: Contributions } | undefined)?.contributes) ?? {};
  const provider = new GlassSidebarProvider(context.extensionUri, contributes);
  const apply = (on: boolean): Thenable<unknown> => vscode.commands.executeCommand('setContext', GLASS_SIDEBAR_CONTEXT_KEY, on);
  void apply(glassSidebarEnabled(context.globalState));
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(GLASS_SIDEBAR_VIEW_ID, provider),
    vscode.commands.registerCommand(TOGGLE_GLASS_SIDEBAR_COMMAND, async () => {
      const on = !glassSidebarEnabled(context.globalState);
      await context.globalState.update(GLASS_SIDEBAR_ENABLED_KEY, on);
      await apply(on);
      void vscode.window.showInformationMessage(on
        ? 'ERD Studio: the glass sidebar is on.'
        : 'ERD Studio: the glass sidebar is off; the standard tree views are back.');
    }),
  );
  return provider;
}
