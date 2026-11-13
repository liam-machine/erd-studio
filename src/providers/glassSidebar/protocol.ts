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
 * is the same: row ids only, and the host works out what they carry.
 *
 * Pure types (plus two constant lists): no `vscode` import.
 */

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
  children?: SerialisedNode[];
  /** false: a collapsed row past the host's listing budget; expanding it sends `expand` and a new `state` follows. */
  childrenLoaded?: boolean;
  /**
   * The row can be dragged, and what its drag is called (`tables`, `layer`):
   * send `dragStart` when one begins. Opaque: only compared with `drop`.
   */
  drag?: string;
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
  /** Title actions: `navigation` as icon buttons, `groups` under a `…` menu (separated by group). */
  actions: { navigation: GlassMenuEntry[]; groups: GlassMenuEntry[][] };
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
  | { type: 'state'; sections: GlassSection[] }
  /** The answer to `itemMenu`: the row's context menu, in groups (separators between them). */
  | { type: 'itemMenu'; section: GlassSectionKey; id: string; groups: GlassMenuEntry[][] }
  /**
   * Select and scroll to a row (the native `TreeView.reveal`): expand each id
   * in `expand` (its ancestors, outermost first), open the section, clear the
   * search, and focus the row when `focus`. Sent after a `state` that has it.
   */
  | { type: 'reveal'; section: GlassSectionKey; id: string; expand: string[]; focus: boolean }
  /** Put the caret in the search field (reserved; not sent yet). */
  | { type: 'focusSearch' };

// ---------------------------------------------------------------------------
// Webview → host
// ---------------------------------------------------------------------------

export type GlassWebviewMessage =
  /** The script is listening: the host answers with `state`. */
  | { type: 'ready' }
  /** A row was clicked (or Enter): the host runs its TreeItem command. */
  | { type: 'activate'; section: GlassSectionKey; id: string }
  /** A row with `childrenLoaded: false` was expanded: the host lists it and sends `state`. */
  | { type: 'expand'; section: GlassSectionKey; id: string }
  /** Right-click / More / Shift+F10 on a row: the host answers with `itemMenu`. */
  | { type: 'itemMenu'; section: GlassSectionKey; id: string }
  /**
   * Run a menu entry: with `id`, a row's (inline or context menu) entry, run
   * with that row's element as a native tree would; without, a title action.
   */
  | { type: 'invoke'; section: GlassSectionKey; id?: string; menu: string; index: number }
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
  /** The drag is over, wherever it ended (sent after any `drop`). */
  | { type: 'dragEnd' };

export const GLASS_WEBVIEW_MESSAGE_TYPES: ReadonlyArray<GlassWebviewMessage['type']> = ['ready', 'activate', 'expand', 'itemMenu', 'invoke', 'welcomeLink', 'dragStart', 'drop', 'dragEnd'];
