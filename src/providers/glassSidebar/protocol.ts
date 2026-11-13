/**
 * The glass sidebar's host <-> webview protocol: the single source of truth
 * for every message and every serialised shape. The host
 * (GlassSidebarProvider.ts) builds these; the webview script (html.ts) reads
 * them. Change additively only: a new optional field, a new message type.
 *
 * Security rule the shapes encode: the webview never sends a command id, an
 * argument or a URL. It names a section, a row id the host gave it, and a
 * menu entry (`menu` + `index`) or a welcome link (`entry` + `link`) the
 * host gave it; the host looks each up again and re-checks its `when`. A drag
 * is the same: row ids only, and the host works out what they carry. So is a
 * selection of several rows (`invoke.selection`): ids the host listed, or dropped.
 * The one free text it sends is the search field's (`search.text`): checked
 * for type and length, and only ever handed to the sidebar filter as a query.
 *
 * Pure types (plus a few constants): no `vscode` import.
 */

import type { LibraryDragRelease } from '../../types/messages';

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** The four sections, in order: Diagrams, Table Library, Relationships, Help & Feedback. */
export type GlassSectionKey = 'diagrams' | 'tables' | 'relationships' | 'help';

export const GLASS_SECTION_KEYS: readonly GlassSectionKey[] = ['diagrams', 'tables', 'relationships', 'help'];

/** What the webview draws for a row's icon. */
export type SerialisedIcon =
  /**
   * A codicon id (`folder`) and an optional theme colour id (`list.warningForeground`, `erdStudio.layer.gold`).
   * Draw the colour as VS Code names its variable: only the FIRST `.` becomes `-`
   * (`--vscode-list-warningForeground`, `--vscode-erdStudio-layer.gold`), so any
   * later dot is escaped in `var()`.
   */
  | { kind: 'theme'; id: string; color?: string }
  /** An image (light and dark variants), already a webview URI (`asWebviewUri`); pick by the body's theme class. */
  | { kind: 'uri'; light: string; dark: string }
  /** A layer's colour swatch (`#rgb` / `#rrggbb`, validated by the host), drawn by the webview. */
  | { kind: 'swatch'; color: string };

/**
 * One menu entry the webview may show and send back. `menu` + `index` is all
 * the webview returns (in `invoke`); `title` and `icon` are for display.
 */
export interface GlassMenuEntry {
  /** The entry's index in `contributes.menus[menu]`. */
  index: number;
  /** The menu `index` is into: `view/item/context`, `view/title`, or a submenu id (`erdStudio.newMenu`). */
  menu: string;
  title: string;
  /** A codicon id (from `$(id)`), when the command has one. */
  icon?: string;
  /** A submenu (title bar only): its entries in groups, already resolved. */
  submenu?: GlassMenuEntry[][];
}

/** A row's hover button (an `inline` entry of `view/item/context`). */
export interface GlassInlineAction {
  index: number;
  menu: string;
  title: string;
  icon?: string;
}

export interface SerialisedNode {
  /** Stable while the row's place and label are: `<section>:<TreeItem.id>` when the item has an id. Opaque to the webview. */
  id: string;
  label: string;
  /** [start, end) ranges of `label` to highlight (TreeItemLabel.highlights). */
  highlights?: Array<[number, number]>;
  description?: string;
  /** Plain text (markdown stripped). */
  tooltip?: string;
  /** The TreeItem's contextValue (`domain`, `layerCreatable`, `logicalModel`, `relationship`, …): for styling only. */
  contextValue?: string;
  /** 0 none, 1 collapsed, 2 expanded (TreeItemCollapsibleState): the initial state. */
  collapsible: 0 | 1 | 2;
  /** Clicking the row runs its command (send `activate`); without one, a click toggles expansion. */
  hasCommand: boolean;
  icon?: SerialisedIcon;
  /** The resource's file name, when the row stands for a file. */
  resource?: string;
  /** Hover buttons, in order. */
  inline?: GlassInlineAction[];
  /** The row has a context menu (ask with `itemMenu`). */
  hasMenu?: boolean;
  /**
   * The row's menu holds only its hover button's action: draw no `…` (it
   * would repeat the button). Right-click and Shift+F10 still open the menu,
   * so the action stays reachable from the keyboard.
   */
  hideMore?: boolean;
  /**
   * A double-click on the row does something of its own (a table's or a
   * relationship's file: the code, where its click goes to a diagram): send
   * `doubleClick` with the row's id. The host decides what it runs.
   */
  secondary?: boolean;
  children?: SerialisedNode[];
  /** false: a collapsed row past the host's listing budget; expanding it sends `expand` and a new `state` follows. */
  childrenLoaded?: boolean;
  /**
   * The row can be dragged, and what its drag is called (`tables`, `layer`):
   * send `dragStart` when one begins. Opaque: only compared with `drop`.
   */
  drag?: string;
  /**
   * A `tables` drag of this row carries this many tables (a schema or layer
   * row all of its own; an ignored duplicate none), as the drop counts them:
   * the drag picture of several rows says "N tables" from it.
   */
  dragCount?: number;
  /** The drag kinds the row takes: send `drop` when a drag of one of them is let go on it. */
  drop?: string[];
}

/** viewsWelcome markdown, parsed: paragraphs of text and links. */
export type GlassWelcomePart = { kind: 'text'; text: string } | { kind: 'link'; label: string; link: number };

export interface GlassWelcomeParagraph {
  /** The paragraph is one link and nothing else: VS Code draws it as a button. */
  button: boolean;
  parts: GlassWelcomePart[];
}

/** One viewsWelcome entry that applies now. Send `welcomeLink` with `entry` and a part's `link`. */
export interface GlassWelcomeEntry {
  /** Index into contributes.viewsWelcome. */
  entry: number;
  paragraphs: GlassWelcomeParagraph[];
}

/**
 * What the sidebar filter found in a section (the native view's message:
 * `Filtered: "cust" — 4 of 52 tables`). Present only while the section is
 * filtered and its tree has listed under that filter.
 */
export interface GlassFilterFound {
  /** Rows of the section's own kind that match (tables, diagrams, relationships). */
  shown: number;
  total: number;
  /** What the section calls its rows, plural: `tables`. */
  noun: string;
  /** The native view's message for it, word for word (`describeFilterOutcome`). */
  text: string;
  /** What the view could not use (`"owner:" doesn't filter this view`). */
  warnings?: string[];
  /** Table files are still being read for a `col:` term: more may match. */
  reading?: boolean;
}

/**
 * The search field's list of filter keys, from sidebarFilter.ts (built into
 * the page, not a message): picking one puts its text in the field.
 */
export interface GlassFilterGuide {
  keys: Array<{ key: string; meaning: string; where: string }>;
  /** How plain words, phrases and exclusions work. */
  syntax: string;
  /** How long typing pauses before the field's text is sent (the native Filter… box's own debounce). */
  debounceMs: number;
}

export interface GlassSection {
  key: GlassSectionKey;
  /** The native view's name: `Diagrams`, `Table Library`, `Relationships`, `Help & Feedback`. */
  title: string;
  /** The native view's own `when` holds (draw nothing for the section when false). */
  visible: boolean;
  /** The native view starts collapsed (`visibility: collapsed`): the default until the user toggles it. */
  defaultCollapsed: boolean;
  /** The view's total, as the native header shows it (`17 tables`), while not filtered. */
  count?: string;
  /** The sidebar Filter… text in force (the native view is filtered by it). */
  filter?: string;
  /**
   * The search field filters this section on the host (the native view's
   * own filter, through `search`): the page shows the rows the host sends
   * and never hides any by its own label match. Absent (Help & Feedback):
   * the page matches the field's text against the rows itself.
   */
  filterable?: boolean;
  /** What the filter in force found (the count, `4 of 52 tables`). */
  found?: GlassFilterFound;
  /** Title actions: `navigation` as icon buttons, `groups` under a `…` menu (separated by group). */
  actions: { navigation: GlassMenuEntry[]; groups: GlassMenuEntry[][] };
  /**
   * The native view selects many (`canSelectMany`): the page keeps a selection
   * of several rows (Cmd/Ctrl-click, Shift-click, Shift+arrows, Cmd/Ctrl+A) and
   * sends it with a row's `invoke` and `dragStart`. Absent: one row at a time.
   */
  multiSelect?: boolean;
  /**
   * The native view has Collapse All (`showCollapseAll`): the page offers it
   * as an icon button in the header, after the `+` and before the `…`, and
   * as Cmd/Ctrl+Left on a row. Page-local: it folds the section's rows and
   * sends nothing.
   */
  collapseAll?: boolean;
  /**
   * Work for this section is under way: the native view's progress bar
   * (the automatic draft building, table files read for a `col:` filter).
   * The page draws a thin moving bar along the section's header. Absent: idle.
   */
  busy?: boolean;
  /** Shown when `nodes` is empty. A sole `Loading…` paragraph means the view is still listing. */
  welcome: GlassWelcomeEntry[];
  nodes: SerialisedNode[];
}

// ---------------------------------------------------------------------------
// Host → webview
// ---------------------------------------------------------------------------

export type GlassHostMessage =
  /**
   * The whole sidebar. Sent after `ready`, and again whenever a tree, filter or
   * context key changes what it shows; never twice in a row with the same
   * content. Replaces the last one: the webview patches its DOM to it in place.
   */
  | {
    type: 'state'; sections: GlassSection[];
    /**
     * What the search field shows: the filter every filterable section shares
     * (`''` when none is filtered), exactly as last typed in the field when it
     * is still the one in force. Absent when the sections carry different
     * filters (set one at a time from the Command Palette): the field is then
     * empty and each filtered section shows its own filter.
     */
    search?: string;
    /** The newest `search` message (its `seq`) whose rows this state holds. */
    searchSeq?: number;
  }
  /** The answer to `itemMenu`: the row's context menu, in groups (separators between them). */
  | { type: 'itemMenu'; section: GlassSectionKey; id: string; groups: GlassMenuEntry[][] }
  /**
   * Select and scroll to a row (the native `TreeView.reveal`): expand each id
   * in `expand` (its ancestors, outermost first), open the section, clear the
   * search, and focus the row when `focus`. Sent after a `state` that has it.
   * `open` (optional): rows to expand below its ancestors, the revealed row
   * first (the native `reveal`'s `expand` option), already listed by the host.
   */
  | { type: 'reveal'; section: GlassSectionKey; id: string; expand: string[]; focus: boolean; open?: string[] }
  /**
   * Put the caret in the search field, its text selected (Cmd/Ctrl+F while
   * the view has focus but the page did not get the key). A page whose field
   * already has focus leaves it as it is.
   */
  | { type: 'focusSearch' }
  /**
   * Bring a section into view (what focusing the native view does): unfold
   * its card, scroll its header to the top, and focus the header when
   * `focus`. A search that hides the whole card is cleared first.
   */
  | { type: 'showSection'; section: GlassSectionKey; focus: boolean };

// ---------------------------------------------------------------------------
// Webview → host
// ---------------------------------------------------------------------------

export type GlassWebviewMessage =
  /** The script is listening: the host answers with `state`. */
  | { type: 'ready' }
  /** A row was clicked (or Enter): the host runs its TreeItem command. */
  | { type: 'activate'; section: GlassSectionKey; id: string }
  /**
   * A row with `secondary` was double-clicked (after its first click sent
   * `activate`): the host runs the row's double-click action, which its tree
   * names (`BridgedTree.secondaryCommand`), never anything the page says.
   */
  | { type: 'doubleClick'; section: GlassSectionKey; id: string }
  /** A row with `childrenLoaded: false` was expanded: the host lists it and sends `state`. */
  | { type: 'expand'; section: GlassSectionKey; id: string }
  /** Right-click / More / Shift+F10 on a row: the host answers with `itemMenu`. */
  | { type: 'itemMenu'; section: GlassSectionKey; id: string }
  /**
   * Run a menu entry: with `id`, a row's (inline or context menu) entry, run
   * with that row's element as a native tree would; without, a title action.
   * `selection` (optional, multi-select sections only): the selected rows'
   * ids, when `id` is one of them. The host runs the command with
   * (element, selected elements), as a native tree that selects many does;
   * it keeps only ids it listed, refuses the whole message (with a warning)
   * past MAX_ROWS_SENT ids rather than run on part of them, and ignores the
   * field for a single-select section or a selection that does not hold `id`.
   */
  | { type: 'invoke'; section: GlassSectionKey; id?: string; menu: string; index: number; selection?: string[] }
  /** A link or button in an empty state: `entry` from GlassWelcomeEntry, `link` from its part. */
  | { type: 'welcomeLink'; section: GlassSectionKey; entry: number; link: number }
  /**
   * A drag of these rows (each with a `drag` kind, all the same) has begun:
   * the host runs the native view's own `handleDrag` for them and keeps what
   * it collected for the `drop`.
   */
  | { type: 'dragStart'; section: GlassSectionKey; ids: string[] }
  /** The drag was let go on this row (its `drop` lists the drag's kind): the host runs that view's own `handleDrop`. */
  | { type: 'drop'; section: GlassSectionKey; id: string }
  /**
   * The drag is over, wherever it ended (sent after any `drop`). `at`: it was
   * let go outside the sidebar with no drop taken: the `dragend`'s point in
   * this page (outside its bounds), one pointer event of the page for
   * reference (page and screen point) and the window's place
   * (`LibraryDragRelease`, src/types/messages.ts). Absent when the page cannot
   * say (or the drag ended in the sidebar). Numbers only; the host passes it
   * to the canvases, which decide whether it is on their diagram.
   */
  | { type: 'dragEnd'; at?: LibraryDragRelease }
  /**
   * The search field's text (debounced as typed; at once when cleared): the
   * host filters every filterable section by it, through the same path the
   * Filter… commands use, and answers with a `state` carrying `searchSeq`.
   * Plain user text, data only: the host checks it is a string of at most
   * {@link GLASS_SEARCH_MAX_LENGTH} characters and never runs it. `seq`
   * (optional): a counter the page raises with each search.
   */
  | { type: 'search'; text: string; seq?: number }
  /**
   * The sections the page draws open now (a card drawn, not folded), sent
   * after a render or a fold whenever the list changes. Section keys only.
   * The host reads it as "on screen" (with the view visible): what VS Code
   * means when it lists a native view to draw it.
   */
  | { type: 'sectionsShown'; open: GlassSectionKey[] };

/** The longest search text the host takes (longer is refused). */
export const GLASS_SEARCH_MAX_LENGTH = 512;

export const GLASS_WEBVIEW_MESSAGE_TYPES: ReadonlyArray<GlassWebviewMessage['type']> = ['ready', 'activate', 'doubleClick', 'expand', 'itemMenu', 'invoke', 'welcomeLink', 'dragStart', 'drop', 'dragEnd', 'search', 'sectionsShown'];
