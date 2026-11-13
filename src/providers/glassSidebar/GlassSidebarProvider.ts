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
 *
 * The page's search field is the native views' own filter: its text (plain
 * data, checked for type and length) goes through each view's
 * `SidebarFilter.apply` (setFilters, search), so the Filter… commands, the
 * native views and the glass field share one filter per view, and the
 * filtered trees come back as the normal state with what each found.
 *
 * Drag and drop is bridged the same way ({@link BridgedDragAndDrop}): a drag
 * that starts on a glass row runs the native view's own `handleDrag` on a
 * DataTransfer made here, and a drop on a glass row hands that DataTransfer to
 * the target view's own `handleDrop`. A drag that leaves the sidebar for a
 * diagram is finished by the canvas, as a native one is (the Table Library's
 * controller tells the editor provider about it; see tableLibraryDrag.ts).
 *
 * Lifecycle: the page is retained while hidden, and the host lists and posts
 * nothing then; the first show lists what changed once. It also stands in for
 * the native views to the rest of the host: `focusView` (show a view, glass or
 * native), `withSectionProgress` (progress on both), and `sectionShown` /
 * `listingNow` (a bridge listing is not a drawn view). docs/dev/architecture.md.
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';

import { log } from '../../services/logger';
import { describeFilterOutcome, type FilterNoun, type FilterOutcome } from '../../services/treeSearch';
import {
  FILTER_DEBOUNCE_MS,
  SIDEBAR_FILTER_SYNTAX,
  VIEW_FILTERS,
  sidebarFilterKeys,
  type SidebarFilterViewName,
} from '../sidebarFilter';
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
import {
  GLASS_SEARCH_MAX_LENGTH,
  type GlassFilterFound,
  type GlassFilterGuide,
  type GlassHostMessage,
  type GlassMenuEntry,
  type GlassSection,
  type GlassSectionKey,
  type GlassWebviewMessage,
  type SerialisedNode,
} from './protocol';
import { consistentRowActions, type RowActions } from './rowActions';
import { nodeId, serialiseTreeItem } from './serialise';
import { consistentTitleActions } from './titleActions';
import { evaluateWhen, type ContextLookup } from './whenClause';

export const GLASS_SIDEBAR_VIEW_ID = 'erdStudio.glassSidebar';
export const TOGGLE_GLASS_SIDEBAR_COMMAND = 'erdStudio.toggleGlassSidebar';
/** Cmd/Ctrl+F while the glass view has focus (package.json keybinding): the caret goes to its search field. */
export const FOCUS_GLASS_SEARCH_COMMAND = 'erdStudio.focusGlassSidebarSearch';
/** globalState: whether the glass sidebar replaces the native trees (default on for the prototype). */
export const GLASS_SIDEBAR_ENABLED_KEY = 'erdStudio.glassSidebar.enabled';

export type { GlassSectionKey } from './protocol';

/**
 * The sections, in order, the native view each one stands for, and that
 * view's `createTreeView` options the glass page mirrors (extension.ts):
 * `multiSelect` is `canSelectMany`, `collapseAll` is `showCollapseAll`.
 */
export const GLASS_SECTIONS: ReadonlyArray<{ key: GlassSectionKey; viewId: string; multiSelect: boolean; collapseAll: boolean; filter?: SidebarFilterViewName }> = [
  { key: 'diagrams', viewId: 'erdStudio.domainTree', multiSelect: false, collapseAll: true, filter: 'diagrams' },
  // The native Table Library is canSelectMany: its menu commands get (element, selection).
  { key: 'tables', viewId: 'erdStudio.modelLibrary', multiSelect: true, collapseAll: true, filter: 'tableLibrary' },
  { key: 'relationships', viewId: 'erdStudio.relationships', multiSelect: false, collapseAll: true, filter: 'relationships' },
  // Help & Feedback has no filter: the page matches the field's text against its rows.
  { key: 'help', viewId: 'erdStudio.help', multiSelect: false, collapseAll: false },
];

/**
 * A section's sidebar filter: the one the native view's Filter… and Clear
 * Filter commands drive (sidebarFilter.ts's `SidebarFilter`). Applying it
 * filters the tree (and the native view's message, description and
 * `…Filtered` context key follow).
 */
export interface GlassSectionFilter {
  apply(text: string): void;
}

/** The search field's keys list and timing, built into the page (sidebarFilter.ts, so it cannot drift). */
export function glassFilterGuide(): GlassFilterGuide {
  return { keys: sidebarFilterKeys(), syntax: SIDEBAR_FILTER_SYNTAX, debounceMs: FILTER_DEBOUNCE_MS };
}

/** How a reveal opens the revealed row: `true` one level, a number that many (at most 3), as `TreeView.reveal`. */
export interface GlassRevealOptions {
  focus?: boolean;
  expand?: boolean | number;
}

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

/**
 * A bridged tree's drag and drop: the controller its native view uses, and
 * which rows the glass sidebar lets the user drag and drop on.
 */
export interface BridgedDragAndDrop<T = unknown> {
  /** The native view's `dragAndDropController`. */
  readonly controller: {
    handleDrag?(source: readonly T[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void | Thenable<void>;
    handleDrop?(target: T | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void | Thenable<void>;
  };
  /** What a drag of this row is called (`tables`, `layer`); undefined when it cannot be dragged. */
  dragKind?(element: T): string | undefined;
  /** The drag kinds this row takes (from any section). */
  dropKinds?(element: T): readonly string[];
}

/** Rows listed eagerly per section before collapsed rows wait to be expanded. */
const NODE_BUDGET = 2500;
/** How deep the eager listing goes: a collapsed row below this lists when expanded (asked for). */
const MAX_DEPTH = 8;
/**
 * The deepest any row is listed, asked for or not: a guard against a tree
 * that nests without end (a cycle through getChildren). A collapsible row at
 * this depth is drawn as a leaf rather than as a row that never loads.
 */
const MAX_TREE_DEPTH = 64;
const TREE_DEBOUNCE_MS = 120;
const CONTEXT_DEBOUNCE_MS = 40;
const MAX_ID_LENGTH = 4096;
/**
 * The most rows one row action or one drag may name. Far past any selection a
 * user makes (a Table Library of thousands, Cmd/Ctrl+A): it only refuses a
 * message no page could have sent. A row action or drag is never run on part
 * of what was selected: a longer one is refused whole, and the user told
 * (the page does not start such a drag; see html.ts's MAX_ROWS_SENT).
 */
export const MAX_ROWS_SENT = 20000;
/** The deepest a reveal opens below the revealed row (`TreeView.reveal`'s own limit). */
const MAX_REVEAL_EXPAND = 3;
/** A drag kind, as a row's `drag` / `drop` carry it. */
const DRAG_KIND = /^[a-z][a-zA-Z]{0,31}$/;

interface SectionState {
  readonly key: GlassSectionKey;
  readonly viewId: string;
  readonly multiSelect: boolean;
  readonly collapseAll: boolean;
  /** The native view's filter name (`tableLibrary`), for its noun; undefined for Help & Feedback. */
  readonly filterName?: SidebarFilterViewName;
  /** The view's sidebar filter, once extension.ts has registered it (setFilters). */
  filter?: GlassSectionFilter;
  /** What the tree's last root listing said its filter found (onDidFilter); undefined while not filtered. */
  outcome?: FilterOutcome;
  tree?: BridgedTree;
  dragAndDrop?: BridgedDragAndDrop;
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
  /** The newest walk while it runs (undefined once it is done): what {@link GlassSidebarProvider.walkSettled} waits for. */
  inflight?: Promise<void>;
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
  if (m.type === 'dragEnd') return { type: 'dragEnd' };
  if (m.type === 'sectionsShown') {
    // Section keys only, each a known one: anything else refuses the message.
    if (!Array.isArray(m.open) || m.open.length > GLASS_SECTIONS.length * 4) return undefined;
    if (!m.open.every((k) => typeof k === 'string' && SECTION_KEYS.has(k))) return undefined;
    return { type: 'sectionsShown', open: [...new Set(m.open as GlassSectionKey[])] };
  }
  if (m.type === 'search') {
    // Plain user text: a string of bounded length, handed to the filter as a query and nothing else.
    if (typeof m.text !== 'string' || m.text.length > GLASS_SEARCH_MAX_LENGTH) return undefined;
    if (m.seq !== undefined && !(typeof m.seq === 'number' && Number.isInteger(m.seq) && m.seq >= 0 && m.seq <= Number.MAX_SAFE_INTEGER)) return undefined;
    return { type: 'search', text: m.text, ...(m.seq !== undefined ? { seq: m.seq as number } : {}) };
  }
  if (typeof m.section !== 'string' || !SECTION_KEYS.has(m.section)) return undefined;
  const section = m.section as GlassSectionKey;
  switch (m.type) {
    case 'activate':
    case 'expand':
    case 'itemMenu':
    case 'drop':
      return isId(m.id) ? { type: m.type, section, id: m.id } : undefined;
    case 'dragStart':
      if (!Array.isArray(m.ids) || m.ids.length === 0 || m.ids.length > MAX_ROWS_SENT || !m.ids.every(isId)) return undefined;
      return { type: 'dragStart', section, ids: [...new Set(m.ids as string[])] };
    case 'invoke': {
      if (typeof m.menu !== 'string' || m.menu.length > 200 || !isIndex(m.index)) return undefined;
      if (m.id !== undefined && !isId(m.id)) return undefined;
      // A selection rides only with a row's entry: row ids, each once, every one of them
      // (never part of it: a longer one than MAX_ROWS_SENT refuses the message).
      let selection: string[] | undefined;
      if (m.selection !== undefined && m.id !== undefined) {
        if (!Array.isArray(m.selection) || m.selection.length > MAX_ROWS_SENT || !m.selection.every(isId)) return undefined;
        selection = [...new Set(m.selection as string[])];
      }
      return {
        type: 'invoke', section,
        ...(m.id !== undefined ? { id: m.id as string } : {}),
        menu: m.menu, index: m.index,
        ...(selection ? { selection } : {}),
      };
    }
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
  /**
   * The drag in progress (from `dragStart` until `drop` or `dragEnd`): its
   * kind and, once the source view's `handleDrag` has run, what it collected.
   */
  private drag: { kind: string; dataTransfer: Promise<vscode.DataTransfer> } | undefined;
  /** A reveal asked for before the webview had loaded: run once it is ready. */
  private pendingReveal: { key: GlassSectionKey; element: unknown; options: GlassRevealOptions } | undefined;
  /**
   * Requests for the page (focusSearch, showSection, reveal) it could not take
   * yet: not loaded, or hidden (a hidden webview gets no messages, retained or
   * not). The newest of each type is sent, in order, once it can.
   */
  private queued: GlassHostMessage[] = [];
  /** Tasks under way per section (withSectionProgress): the section's header shows a bar while any run. */
  private readonly busy = new Map<GlassSectionKey, number>();
  /** The sections the page last said it draws open (`sectionsShown`). */
  private pageOpen = new Set<GlassSectionKey>();
  private readonly shownEmitter = new vscode.EventEmitter<void>();
  /**
   * Fires when what {@link sectionShown} answers may have changed: the view
   * shown or hidden, the page loaded, a card folded or unfolded.
   */
  readonly onDidChangeShownSections: vscode.Event<void> = this.shownEmitter.event;
  /** Whether the glass sidebar stands in for the native views now (globalState; registerGlassSidebar). */
  private readonly enabled: () => boolean;
  /**
   * The search field's last text, and what each filterable tree's filter read
   * right after it was applied. While the trees still hold exactly that, the
   * field shows the text as typed (`cust ` keeps its space, `layer:` its
   * colon); once any differs, a filter was changed from elsewhere.
   */
  private fieldSearch: { text: string; applied: Map<GlassSectionKey, string> } | undefined;
  /** The newest `search` (its seq) whose listing has been sent. */
  private searchSeq: number | undefined;

  constructor(private readonly extensionUri: vscode.Uri, contributes: Contributions, options: { enabled?: () => boolean } = {}) {
    this.enabled = options.enabled ?? (() => true);
    this.index = new ContributionIndex(contributes);
    for (const s of GLASS_SECTIONS) {
      this.sections.set(s.key, {
        key: s.key, viewId: s.viewId, multiSelect: s.multiSelect, collapseAll: s.collapseAll,
        ...(s.filter ? { filterName: s.filter } : {}),
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
  setSource<T>(key: GlassSectionKey, tree: BridgedTree<T>, dragAndDrop?: BridgedDragAndDrop<T>): void {
    const section = this.sections.get(key)!;
    for (const d of section.subscriptions) d.dispose();
    section.subscriptions = [];
    section.tree = tree as BridgedTree;
    section.dragAndDrop = dragAndDrop as BridgedDragAndDrop | undefined;
    if (tree.onDidChangeTreeData) section.subscriptions.push(tree.onDidChangeTreeData(() => this.invalidate(section)));
    // The bridged trees fire onDidFilter from inside their own root getChildren()
    // (so the native view's title can show the count), i.e. during every walk.
    // Re-walking on it loops forever (walk -> onDidFilter -> walk ...). A filter
    // change already arrives as onDidChangeTreeData (setFilter refreshes), and the
    // count pill and filter chip are read at snapshot time, so this only keeps
    // what the listing found (the section's `found`) and re-sends the
    // snapshot, which post() drops when nothing changed.
    if (tree.onDidFilter) {
      section.subscriptions.push(tree.onDidFilter((outcome) => {
        section.outcome = asFilterOutcome(outcome);
        this.schedulePost();
      }));
    }
    this.invalidate(section);
  }

  /**
   * The native views' sidebar filters (extension.ts, once registerSidebarFilters
   * has made them): the search field applies its text through them, so the
   * glass field, the Filter… commands and the native views share one filter
   * per view.
   */
  setFilters(filters: Partial<Record<SidebarFilterViewName, GlassSectionFilter>>): void {
    for (const section of this.sections.values()) {
      if (section.filterName) section.filter = filters[section.filterName];
    }
    this.schedulePost();
  }

  // ------------------------------------------------------------------ search

  /** The sections the search field filters: a sidebar filter and a tree to read it back from. */
  private filterableSections(): SectionState[] {
    return [...this.sections.values()].filter((s) => s.filter && s.tree?.getFilter);
  }

  /**
   * Filter every filterable section by `text` (the search field's), through
   * each view's own sidebar filter (the Filter… commands' path), then list
   * the changed sections at once and send them, acknowledging `seq`.
   */
  async search(text: string, seq?: number): Promise<void> {
    const sections = this.filterableSections();
    for (const section of sections) section.filter!.apply(text);
    this.fieldSearch = { text, applied: new Map(sections.map((s) => [s.key, s.tree!.getFilter!()])) };
    // The trees fired onDidChangeTreeData (a changed filter lists again): walk now, not after the
    // tree debounce. That debounce is every section's, so this walks every section it was waiting
    // for (Help & Feedback too), not only the filtered ones: none is left dirty with no timer.
    if (this.treeTimer) { clearTimeout(this.treeTimer); this.treeTimer = undefined; }
    if (this.ready) {
      await Promise.all([...this.sections.values()].filter((s) => s.dirty || !s.walked).map((s) => this.walkSettled(s)));
      // A filtered section a newer walk is listing (an `expand` that came first): its rows are the answer.
      await Promise.all(sections.map((s) => this.settled(s)));
    }
    if (seq !== undefined && (this.searchSeq === undefined || seq > this.searchSeq)) this.searchSeq = seq;
    this.post();
  }

  /**
   * What the search field shows: the text it last sent while every
   * filterable tree still holds what that text applied; else the filter they
   * all share (set from the Command Palette, `''` for none); else undefined:
   * the sections carry different filters.
   */
  private fieldText(): string | undefined {
    const sections = this.filterableSections();
    const now = sections.map((s) => s.tree!.getFilter!());
    if (this.fieldSearch && sections.every((s, i) => this.fieldSearch!.applied.get(s.key) === now[i])) return this.fieldSearch.text;
    if (sections.length === 0) return this.fieldSearch?.text ?? '';
    return now.every((f) => f === now[0]) ? now[0] : undefined;
  }

  /**
   * Clear the filter that hides `key`'s rows, before a reveal of a row it
   * left out: the search field's (every section's) when the section's filter
   * is the field's, else that section's own. Lists the section again.
   */
  clearFilter(key: GlassSectionKey): void {
    const section = this.sections.get(key)!;
    if (!section.filter) return;
    const field = this.fieldText();
    if (field !== undefined && field.trim() !== '') {
      void this.search('');
      return;
    }
    section.filter.apply('');
  }

  /** Cmd/Ctrl+F in the view: show it and put the caret in its search field. */
  async focusSearch(): Promise<void> {
    // Sent now when the page can take it, else queued until it is loaded and on screen.
    this.send({ type: 'focusSearch' });
    await this.showView(false);
  }

  /**
   * Bring `key`'s section into view, as focusing its native view does: the
   * glass view shown, the section's card unfolded and scrolled to, its header
   * focused when `focus` (the default).
   */
  async showSection(key: GlassSectionKey, options: { focus?: boolean } = {}): Promise<void> {
    const focus = options.focus !== false;
    this.send({ type: 'showSection', section: key, focus });
    await this.showView(!focus);
  }

  /**
   * Show the ERD Studio view that stands for `key`, wherever it is drawn now:
   * the glass sidebar's section while it is on, else the native tree view
   * (VS Code's generated `<view>.focus`). The one place that choice is made,
   * for every "show the Diagrams view" (Show Me, notices, commands).
   */
  async focusView(key: GlassSectionKey, options: { focus?: boolean } = {}): Promise<void> {
    if (this.enabled()) {
      await this.showSection(key, options);
      return;
    }
    const viewId = GLASS_SECTIONS.find((s) => s.key === key)!.viewId;
    await vscode.commands.executeCommand(`${viewId}.focus`).then(undefined, () => undefined);
  }

  /** The glass view on screen: shown when resolved, else opened (its generated `<view>.focus`). */
  private async showView(preserveFocus: boolean): Promise<void> {
    if (this.view) this.view.show(preserveFocus);
    else await vscode.commands.executeCommand(`${GLASS_SIDEBAR_VIEW_ID}.focus`).then(undefined, () => undefined);
  }

  /**
   * True only while the bridge itself is inside a tree's `getChildren` (a
   * provider's callback runs there). A native view is listed by VS Code only
   * to draw it; the bridge lists every section as soon as its page loads, so
   * a callback that sees this true must not read the listing as "on screen":
   * {@link sectionShown} says when it is.
   */
  get listingNow(): boolean {
    return this.bridgeListing > 0;
  }
  private bridgeListing = 0;

  /** Whether the glass view is on screen. */
  get visible(): boolean {
    return this.view?.visible === true;
  }

  /**
   * Whether `key`'s section is on screen now: the glass sidebar is on, its
   * view is visible with the page loaded, and the page draws that section's
   * card open. What a native view being listed means ("VS Code lists a view
   * only to draw it"), which the bridge's own listings do not: it lists every
   * section, folded or not, as soon as the page loads.
   */
  sectionShown(key: GlassSectionKey): boolean {
    return this.enabled() && this.visible && this.ready && this.pageOpen.has(key);
  }

  /**
   * The glass sidebar was turned on or off (Toggle Glass Sidebar): what
   * {@link sectionShown} answers, and which sidebar draws the trees, changed.
   */
  enabledChanged(): void {
    this.shownEmitter.fire();
  }

  // ---------------------------------------------------------------- progress

  /**
   * Run `task` with a progress bar where its work shows: the native view's
   * own (`withProgress` on its view id, as before) and a thin bar on the
   * glass section's header, so the user sees it whichever sidebar is on.
   */
  withSectionProgress<T>(key: GlassSectionKey, task: () => Thenable<T> | Promise<T>): Thenable<T> {
    const viewId = GLASS_SECTIONS.find((s) => s.key === key)!.viewId;
    this.busy.set(key, (this.busy.get(key) ?? 0) + 1);
    this.schedulePost();
    const done = (): void => {
      const left = (this.busy.get(key) ?? 1) - 1;
      if (left > 0) this.busy.set(key, left); else this.busy.delete(key);
      this.schedulePost();
    };
    return vscode.window.withProgress({ location: { viewId } }, () => Promise.resolve(task())).then(
      (value) => { done(); return value; },
      (err: unknown) => { done(); throw err; },
    );
  }

  // ---------------------------------------------------------------- the view

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    for (const d of this.viewSubscriptions) d.dispose();
    this.view = webviewView;
    this.ready = false;
    this.lastPosted = undefined;
    this.pageOpen = new Set();
    // A new webview: its rows' image URIs are its own (asWebviewUri), so every section lists again for it.
    for (const s of this.sections.values()) s.dirty = true;
    const nonce = crypto.randomBytes(16).toString('base64');
    // The page first, then the options: when the view is re-resolved while already on
    // screen (toggling back from the native panes), setting options first makes VS Code
    // load the still-empty page, which it reports as "a webview without a content
    // security policy". Every load then carries the CSP meta tag.
    webviewView.webview.html = buildGlassSidebarHtml({
      cspSource: webviewView.webview.cspSource,
      nonce,
      tokensCssUri: webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css')).toString(),
      filterGuide: glassFilterGuide(),
    });
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    this.viewSubscriptions = [
      webviewView.webview.onDidReceiveMessage((raw: unknown) => { void this.onMessage(raw); }),
      // The page is retained while hidden (registerGlassSidebar): nothing is listed or sent
      // meanwhile, so the first show after changes lists the changed sections once, sends
      // one state, then what was asked of the page while it was away.
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) void this.refreshDirty().then(() => this.flushQueued());
        this.shownEmitter.fire();
      }),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined; this.ready = false; this.lastPosted = undefined; this.pageOpen = new Set();
          this.shownEmitter.fire();
        }
      }),
    ];
  }

  /**
   * Select (and scroll to) `element`'s row in `key`, expanding its ancestors,
   * as `TreeView.reveal` does on the native trees. Shows the view when asked.
   * `expand` opens the row itself too (`true`: one level; a number: that many
   * levels, at most 3), as the native option does.
   */
  async reveal(key: GlassSectionKey, element: unknown, options: GlassRevealOptions = {}): Promise<void> {
    const section = this.sections.get(key)!;
    const tree = section.tree;
    if (!tree) return;
    // Ancestors first (getParent), so a row past the budget is listed.
    const chain: unknown[] = [];
    let at: unknown = element;
    for (let i = 0; i < MAX_TREE_DEPTH && at !== undefined && at !== null; i++) {
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
    // The rows as the tree has them now: a walk already under way (the listing a cleared
    // filter started, clearFilter) is waited for, never looked up in the rows it replaces.
    if (!section.walked || section.dirty) await this.walkSettled(section);
    else await this.settled(section);
    let ids = await this.idsOf(section, chain);
    // A row under collapsed ancestors past the budget: list that path one level per pass, then look again.
    for (let pass = 0; pass < MAX_TREE_DEPTH && ids.some((id) => id === undefined); pass++) {
      const before = section.requested.size;
      for (const id of ids) if (id) section.requested.add(id);
      if (section.requested.size === before) break;
      await this.walkSettled(section);
      ids = await this.idsOf(section, chain);
    }
    const target = ids[ids.length - 1];
    if (!target) return;
    const open = await this.openBelow(section, target, revealLevels(options.expand));
    this.post();
    this.send({
      type: 'reveal', section: key, id: target,
      expand: ids.filter((id): id is string => id !== undefined).slice(0, -1),
      focus: options.focus === true,
      ...(open.length ? { open } : {}),
    });
  }

  /**
   * The rows a reveal opens below `target`, `levels` deep (the target first,
   * then its collapsible children, ...), each listed before it is named: a
   * row past the budget is requested and the section walked again.
   */
  private async openBelow(section: SectionState, target: string, levels: number): Promise<string[]> {
    const open: string[] = [];
    let frontier = [target];
    for (let level = 0; level < levels && frontier.length; level++) {
      const rows = frontier.map((id) => findNode(section.nodes, id)).filter((n): n is SerialisedNode => !!n && n.collapsible !== 0);
      if (rows.some((n) => n.childrenLoaded === false)) {
        for (const n of rows) section.requested.add(n.id);
        await this.walkSettled(section);
      }
      const listed = rows.map((n) => findNode(section.nodes, n.id)).filter((n): n is SerialisedNode => !!n);
      open.push(...listed.map((n) => n.id));
      frontier = listed.flatMap((n) => (n.children ?? []).filter((c) => c.collapsible !== 0).map((c) => c.id));
    }
    return open;
  }

  /**
   * Each element of `chain`'s row id (root first): by identity, else by the
   * id the bridge gave the same item when it listed it ({@link nodeId}: its
   * TreeItem's own id, else its parent row and label). A provider that lists
   * afresh each time (the Table Library) hands a reveal an equal element,
   * never the one listed, and its table rows carry no id of their own.
   */
  private async idsOf(section: SectionState, chain: unknown[]): Promise<Array<string | undefined>> {
    const out: Array<string | undefined> = [];
    for (const element of chain) {
      let found: string | undefined;
      for (const [id, e] of section.elements) if (e === element) { found = id; break; }
      if (!found && section.tree) {
        const id = nodeId(section.key, out[out.length - 1], await section.tree.getTreeItem(element), new Map());
        if (section.elements.has(id)) found = id;
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
    // Hidden: the sections stay dirty, and the next show lists them.
    if (!this.ready || !this.visible) return;
    await Promise.all([...this.sections.values()].filter((s) => s.dirty || !s.walked).map((s) => this.walkSettled(s)));
    this.post();
  }

  /**
   * List `section`, then wait out any newer walk that replaced this one
   * (a newer walk discards the older one's rows): once it returns, the
   * section holds the newest listing, so a state sent then never pairs one
   * listing's rows with another's `found` or `searchSeq`.
   */
  private async walkSettled(section: SectionState): Promise<void> {
    await this.walk(section);
    await this.settled(section);
  }

  /** Until no walk of `section` is running. */
  private async settled(section: SectionState): Promise<void> {
    // Each pass waits for the newest walk; one started meanwhile is waited for next.
    while (section.inflight) await section.inflight;
  }

  /** List `section`'s tree (see {@link listSection}), remembered as the walk in flight until it is done. */
  private walk(section: SectionState): Promise<void> {
    const run = this.listSection(section);
    section.inflight = run;
    // Registered before any caller awaits `run`, so the walk is cleared before they go on.
    const clear = (): void => { if (section.inflight === run) section.inflight = undefined; };
    run.then(clear, clear);
    return run;
  }

  /** List `section`'s tree into JSON (and the id → element map). A newer walk supersedes an older one. */
  private async listSection(section: SectionState): Promise<void> {
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
      // Marked while the provider runs (synchronously): what it reports from inside its
      // own getChildren (an empty listing, say) was the bridge's listing, not a drawn view.
      this.bridgeListing++;
      let listed: vscode.ProviderResult<unknown[]>;
      try { listed = tree.getChildren(element); } finally { this.bridgeListing--; }
      const children = (await listed) ?? [];
      const seen = new Map<string, number>();
      const out: SerialisedNode[] = [];
      for (const child of children) {
        const item = await tree.getTreeItem(child);
        const id = nodeId(section.key, parentId, item, seen);
        const node = serialiseTreeItem(item, id, toWebviewUri);
        const drag = dragKindOf(section.dragAndDrop, child);
        if (drag) node.drag = drag;
        const drop = dropKindsOf(section.dragAndDrop, child);
        if (drop.length) node.drop = drop;
        elements.set(id, child);
        items.set(id, item);
        parents.set(id, parentId);
        budget--;
        if (node.collapsible && depth + 1 >= MAX_TREE_DEPTH) {
          // Past the guard: a leaf, never a row that shows "Loading…" for good.
          node.collapsible = 0;
        } else if (node.collapsible) {
          // A row the user (or a reveal) asked for is listed at any depth; the eager pass stops at MAX_DEPTH.
          const load = section.requested.has(id) || (depth < MAX_DEPTH && (budget > 0 || node.collapsible === 2));
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
    const field = this.fieldText();
    const sections = GLASS_SECTIONS.map(({ key }): GlassSection => {
      const section = this.sections.get(key)!;
      const contribution = this.viewContribution(section);
      const titleCtx = this.context(section.viewId);
      const filter = section.tree?.getFilter?.();
      const filterable = !!section.filter && !!section.tree?.getFilter;
      // One header shape for every section: `+` then `…` (titleActions.ts). A filter
      // the search field shows is cleared from the field, not from the header.
      const actions = consistentTitleActions(
        this.index.resolve('view/title', titleCtx),
        (a) => (a.submenu ? undefined : this.index.menu(a.menu)[a.index]?.command),
        { filterInField: filterable && field !== undefined },
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
      const found = filter && filter.trim() !== '' ? this.found(section, filter) : undefined;
      return {
        key,
        title: contribution?.name ?? key,
        visible,
        defaultCollapsed: contribution?.visibility === 'collapsed',
        ...(section.tree?.headerTotal?.() ? { count: section.tree.headerTotal!()! } : {}),
        ...(filter && filter.trim() !== '' ? { filter } : {}),
        ...(filterable ? { filterable: true } : {}),
        ...(found ? { found } : {}),
        actions: { navigation: actions.navigation, groups: actions.groups },
        ...(section.multiSelect ? { multiSelect: true } : {}),
        ...(section.collapseAll ? { collapseAll: true } : {}),
        ...(this.busy.has(key) ? { busy: true } : {}),
        welcome,
        nodes: decorate(section.nodes),
      };
    });
    return {
      type: 'state', sections,
      ...(field !== undefined ? { search: field } : {}),
      ...(this.searchSeq !== undefined ? { searchSeq: this.searchSeq } : {}),
    };
  }

  /**
   * What `section`'s filter found, as its native view's message says it:
   * from the tree's last listing, and only when that listing was under the
   * filter in force now (a stale count never shows).
   */
  private found(section: SectionState, filter: string): GlassFilterFound | undefined {
    const outcome = section.outcome;
    if (!outcome || outcome.query.text !== filter || !section.filterName) return undefined;
    const noun: FilterNoun = VIEW_FILTERS[section.filterName].noun;
    return {
      shown: outcome.shown,
      total: outcome.total,
      noun: noun.many,
      text: describeFilterOutcome(outcome, noun),
      ...(outcome.query.warnings.length ? { warnings: [...outcome.query.warnings] } : {}),
      ...(outcome.reading ? { reading: true } : {}),
    };
  }

  /**
   * Send the snapshot, unless it is exactly what the webview already has.
   * Never while hidden: the message would be lost (and `lastPosted` wrong);
   * the next show posts what changed.
   */
  private post(): void {
    if (!this.view || !this.ready || !this.view.visible) return;
    if (this.postTimer) { clearTimeout(this.postTimer); this.postTimer = undefined; }
    const snapshot = this.snapshot();
    const json = JSON.stringify(snapshot);
    if (json === this.lastPosted) return;
    this.lastPosted = json;
    void this.view.webview.postMessage(snapshot);
  }

  /**
   * Send a message to the page. One it cannot take yet (not loaded, or
   * hidden) is kept when it is a request the user is waiting on (focus the
   * search, show a section, reveal a row): the newest of each, sent once the
   * page is ready and on screen. Anything else is moot by then and dropped.
   */
  private send(message: GlassHostMessage): void {
    if (this.view && this.ready && this.view.visible) {
      void this.view.webview.postMessage(message);
      return;
    }
    if (message.type === 'focusSearch' || message.type === 'showSection' || message.type === 'reveal') {
      this.queued = [...this.queued.filter((q) => q.type !== message.type), message];
    }
  }

  private flushQueued(): void {
    if (!this.view || !this.ready || !this.view.visible || this.queued.length === 0) return;
    const queued = this.queued;
    this.queued = [];
    for (const message of queued) void this.view.webview.postMessage(message);
  }

  // ---------------------------------------------------------------- messages

  private async onMessage(raw: unknown): Promise<void> {
    const msg = parseGlassInbound(raw);
    if (!msg) {
      // An action on more rows than it takes runs on none of them, and says so (never on part of them).
      const rows = oversizedRowCount(raw);
      if (rows !== undefined) {
        void vscode.window.showWarningMessage(`ERD Studio: ${rows.toLocaleString('en-US')} rows are selected, more than one action can take (${MAX_ROWS_SENT.toLocaleString('en-US')}). Nothing was changed: select fewer rows and try again.`);
        return;
      }
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
      // A (re)loaded page has nothing yet: always send it the whole state. Its search counter starts again.
      this.lastPosted = undefined;
      this.searchSeq = undefined;
      this.pageOpen = new Set();
      // Only what changed since the last listing (a page reloaded in the same webview
      // re-reads nothing), and only on screen: hidden, the next show lists it.
      await this.refreshDirty();
      const pending = this.pendingReveal;
      this.pendingReveal = undefined;
      if (pending) await this.reveal(pending.key, pending.element, pending.options);
      this.flushQueued();
      this.shownEmitter.fire();
      return;
    }
    if (msg.type === 'sectionsShown') {
      const open = new Set(msg.open);
      const same = open.size === this.pageOpen.size && [...open].every((k) => this.pageOpen.has(k));
      this.pageOpen = open;
      if (!same) this.shownEmitter.fire();
      return;
    }
    if (msg.type === 'dragEnd') {
      this.drag = undefined;
      return;
    }
    if (msg.type === 'search') {
      await this.search(msg.text, msg.seq);
      return;
    }
    const section = this.sections.get(msg.section)!;
    switch (msg.type) {
      case 'dragStart': {
        this.drag = undefined;
        const dnd = section.dragAndDrop;
        if (!dnd?.controller.handleDrag || !msg.ids.every((id) => section.elements.has(id))) return;
        const elements = msg.ids.map((id) => section.elements.get(id));
        // One kind per drag, and every row must be one the host said could be dragged.
        const kind = dragKindOf(dnd, elements[0]);
        if (!kind || elements.some((e) => dragKindOf(dnd, e) !== kind)) return;
        const dataTransfer = new vscode.DataTransfer();
        const collected = (async () => {
          try {
            await dnd.controller.handleDrag!(elements, dataTransfer, new vscode.CancellationTokenSource().token);
          } catch (err) {
            log.warn(`[ERD Studio] Glass sidebar: starting a drag in ${section.viewId} failed:`, err);
          }
          return dataTransfer;
        })();
        this.drag = { kind, dataTransfer: collected };
        await collected;
        return;
      }
      case 'drop': {
        // The drag is used up by its drop, whether or not the row takes it.
        const drag = this.drag;
        this.drag = undefined;
        const dnd = section.dragAndDrop;
        if (!drag || !dnd?.controller.handleDrop || !section.elements.has(msg.id)) return;
        const target = section.elements.get(msg.id);
        if (!dropKindsOf(dnd, target).includes(drag.kind)) return;
        await dnd.controller.handleDrop(target, await drag.dataTransfer, new vscode.CancellationTokenSource().token);
        return;
      }
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
          await vscode.commands.executeCommand(command, ...(section.multiSelect ? [element, this.selectionFor(section, msg.id, msg.selection)] : [element]));
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

  /**
   * The selection a row's command runs with in a section that selects many,
   * as a native tree passes it: every selected element when the row is one of
   * them, else the row alone. Only rows this host listed count.
   */
  private selectionFor(section: SectionState, id: string, selection: readonly string[] | undefined): unknown[] {
    const known = (selection ?? []).filter((s) => section.elements.has(s));
    if (!known.includes(id)) return [section.elements.get(id)];
    return known.map((s) => section.elements.get(s));
  }

  dispose(): void {
    for (const d of this.viewSubscriptions) d.dispose();
    for (const d of this.subscriptions) d.dispose();
    for (const s of this.sections.values()) {
      for (const d of s.subscriptions) d.dispose();
    }
    if (this.postTimer) clearTimeout(this.postTimer);
    if (this.treeTimer) clearTimeout(this.treeTimer);
    this.shownEmitter.dispose();
  }
}

/**
 * How many rows a refused row action or drag named, when that (more than
 * {@link MAX_ROWS_SENT}) is why it was refused; else undefined. Reads only
 * the array's length: the message itself is never acted on.
 */
function oversizedRowCount(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  const rows = m.type === 'invoke' ? m.selection : m.type === 'dragStart' ? m.ids : undefined;
  return Array.isArray(rows) && rows.length > MAX_ROWS_SENT ? rows.length : undefined;
}

/** A tree's onDidFilter payload, when it has the shape sidebarFilter's FilterOutcome has; else undefined (not filtered). */
function asFilterOutcome(value: unknown): FilterOutcome | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Partial<FilterOutcome>;
  const query = v.query as Partial<FilterOutcome['query']> | undefined;
  if (typeof v.shown !== 'number' || typeof v.total !== 'number' || !query || typeof query.text !== 'string') return undefined;
  return v as FilterOutcome;
}

/** How many levels a reveal's `expand` opens: `true` one, a number that many (0 to 3), else none. */
function revealLevels(expand: boolean | number | undefined): number {
  if (expand === true) return 1;
  if (typeof expand === 'number' && Number.isFinite(expand)) return Math.max(0, Math.min(MAX_REVEAL_EXPAND, Math.floor(expand)));
  return 0;
}

/** A row by id, anywhere in `nodes`. */
function findNode(nodes: readonly SerialisedNode[], id: string): SerialisedNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const inner = n.children ? findNode(n.children, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

/** A row's drag kind, when its section can be dragged from and the kind is well formed. */
function dragKindOf(dnd: BridgedDragAndDrop | undefined, element: unknown): string | undefined {
  if (!dnd?.controller.handleDrag || !dnd.dragKind) return undefined;
  const kind = dnd.dragKind(element);
  return kind !== undefined && DRAG_KIND.test(kind) ? kind : undefined;
}

/** The drag kinds a row takes, when its section takes drops. */
function dropKindsOf(dnd: BridgedDragAndDrop | undefined, element: unknown): string[] {
  if (!dnd?.controller.handleDrop || !dnd.dropKinds) return [];
  return dnd.dropKinds(element).filter((kind) => DRAG_KIND.test(kind));
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
  const provider = new GlassSidebarProvider(context.extensionUri, contributes, { enabled: () => glassSidebarEnabled(context.globalState) });
  const apply = (on: boolean): Thenable<unknown> => vscode.commands.executeCommand('setContext', GLASS_SIDEBAR_CONTEXT_KEY, on);
  void apply(glassSidebarEnabled(context.globalState));
  context.subscriptions.push(
    provider,
    // Retained while hidden: switching to another sidebar and back keeps the page as it
    // was (scroll, open rows, focus) instead of reloading it and listing every tree again.
    // The page itself is light (one document, no framework); a real reload still restores
    // its scroll and open rows from its saved state (html.ts).
    vscode.window.registerWebviewViewProvider(GLASS_SIDEBAR_VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand(TOGGLE_GLASS_SIDEBAR_COMMAND, async () => {
      const on = !glassSidebarEnabled(context.globalState);
      await context.globalState.update(GLASS_SIDEBAR_ENABLED_KEY, on);
      await apply(on);
      provider.enabledChanged();
      void vscode.window.showInformationMessage(on
        ? 'ERD Studio: the glass sidebar is on.'
        : 'ERD Studio: the glass sidebar is off; the standard tree views are back.');
    }),
    // Cmd/Ctrl+F with the glass view focused (its keybinding), when the page itself did not get the key.
    vscode.commands.registerCommand(FOCUS_GLASS_SEARCH_COMMAND, () => provider.focusSearch()),
  );
  return provider;
}
