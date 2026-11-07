/**
 * The sidebar's Filter… box, one per view (Diagrams, Table Library,
 * Relationships): a `createInputBox` that filters the view live as you type
 * (debounced), prefilled with the filter in force. Enter, or clicking away,
 * keeps what is typed; Escape puts back the filter that was there before.
 * While filtered the view's `message` says what matched
 * (`Filtered: "cust layer:gold" — 4 of 52 tables`), its `description` shows
 * the filter, and a context key (`erdStudio.tableLibraryFiltered`, …) swaps
 * the title's Filter… icon for Clear Filter. Not filtered, the `description`
 * is the view's total (`17 tables`, the tree's `headerTotal`): the filter
 * owns the one description, so the two never overwrite each other. Session
 * only: nothing is saved.
 *
 * The query syntax and the matching are `services/treeSearch.ts` (pure); the
 * providers apply it to their rows (`setFilter`).
 */
import * as vscode from 'vscode';

import {
  DIAGRAMS_FILTER,
  RELATIONSHIPS_FILTER,
  TABLE_LIBRARY_FILTER,
  describeFilterOutcome,
  filterPrompt,
  type FilterNoun,
  type FilterOutcome,
  type FilterSpec,
} from '../services/treeSearch';

/** The filter commands of each view (`package.json` contributes them; `extension.ts` registers them). */
export const FILTER_COMMANDS = {
  diagrams: { filter: 'erdStudio.filterDiagrams', clear: 'erdStudio.clearDiagramsFilter', contextKey: 'erdStudio.diagramsFiltered' },
  tableLibrary: { filter: 'erdStudio.filterTableLibrary', clear: 'erdStudio.clearTableLibraryFilter', contextKey: 'erdStudio.tableLibraryFiltered' },
  relationships: { filter: 'erdStudio.filterRelationships', clear: 'erdStudio.clearRelationshipsFilter', contextKey: 'erdStudio.relationshipsFiltered' },
} as const;

/** Escape in an open filter box (code-only; bound to `escape` while {@link FILTER_OPEN_CONTEXT_KEY} is set). */
export const CANCEL_FILTER_COMMAND = 'erdStudio.cancelSidebarFilter';
/** Set while a filter box is open, so Escape can put the previous filter back. */
export const FILTER_OPEN_CONTEXT_KEY = 'erdStudio.sidebarFilterOpen';

/** How long typing pauses before the view filters again. */
export const FILTER_DEBOUNCE_MS = 150;

/** The provider side of a filterable view. */
export interface FilterableTree {
  getFilter(): string;
  setFilter(text: string): void;
  /** Fired after each root listing: what the filter found, or undefined while not filtered. */
  readonly onDidFilter: vscode.Event<FilterOutcome | undefined>;
  /**
   * The view's total from its last unfiltered listing (`5 diagrams`), shown
   * beside the view's title while not filtered; undefined when there is
   * none, or none listed yet. Optional.
   */
  headerTotal?(): string | undefined;
}

export interface SidebarFilterOptions {
  /** The box's title: `Filter Table Library`. */
  readonly title: string;
  /** Examples, shown in the empty box. */
  readonly placeholder: string;
  readonly spec: FilterSpec;
  /** What the view's rows are, for its message (`4 of 52 tables`). */
  readonly noun: FilterNoun;
  /** The context key set while filtered. */
  readonly contextKey: string;
  /** Tests pass their own; the default is `vscode.window.createInputBox`. */
  readonly createInputBox?: () => vscode.InputBox;
  readonly debounceMs?: number;
}

/**
 * The one row a filtered view shows when nothing matches (`No tables match`):
 * clicking it clears the filter. An empty view would show its welcome text
 * ("No tables yet") instead, which is not true.
 */
export function noMatchItem(nouns: string, clearCommand: string): vscode.TreeItem {
  const item = new vscode.TreeItem(`No ${nouns} match the filter`, vscode.TreeItemCollapsibleState.None);
  item.description = 'Clear Filter';
  item.tooltip = `Nothing matches the filter. Click to clear it and show all ${nouns} again.`;
  item.iconPath = new vscode.ThemeIcon('clear-all');
  item.contextValue = 'filterNoMatch';
  item.command = { command: clearCommand, title: 'Clear Filter' };
  return item;
}

/** The view a filter writes its message and description to. */
export type FilteredView = Pick<vscode.TreeView<unknown>, 'message' | 'description'>;

/** The one open filter box (any view): Escape closes it with its earlier filter restored. */
let openBox: { cancel(): void } | undefined;

/** Escape in the open filter box: close it and put back the filter it started from. */
export function cancelOpenFilter(): void {
  openBox?.cancel();
}

export class SidebarFilter implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;
  private box: vscode.InputBox | undefined;
  private filtered = false;

  constructor(
    private readonly view: FilteredView,
    private readonly tree: FilterableTree,
    private readonly options: SidebarFilterOptions,
  ) {
    this.subscription = tree.onDidFilter((outcome) => this.show(outcome));
  }

  /** Whether a filter is in force. */
  isFiltered(): boolean {
    return this.tree.getFilter() !== '';
  }

  /** Filter the view by `text` now (`''` clears it). */
  apply(text: string): void {
    this.tree.setFilter(text);
    const filtered = this.tree.getFilter() !== '';
    if (filtered !== this.filtered) {
      this.filtered = filtered;
      void vscode.commands.executeCommand('setContext', this.options.contextKey, filtered);
    }
    if (!filtered) {
      this.view.message = undefined;
      // The total the view showed before it was filtered (the listing that follows brings it up to date).
      this.view.description = this.tree.headerTotal?.();
    } else {
      // At once, even for a collapsed view that will not list until it is opened.
      this.view.description = this.tree.getFilter();
    }
  }

  /** Clear Filter: every row shows again. */
  clear(): void {
    this.apply('');
  }

  /**
   * Filter… (the title icon, Cmd/Ctrl+F in the view): the box, prefilled
   * with the filter in force. Resolves once it has closed.
   */
  open(): Promise<void> {
    if (this.box) {
      this.box.show();
      return Promise.resolve();
    }
    const before = this.tree.getFilter();
    const box = (this.options.createInputBox ?? (() => vscode.window.createInputBox()))();
    this.box = box;
    box.title = this.options.title;
    box.placeholder = this.options.placeholder;
    box.prompt = filterPrompt(this.options.spec);
    box.value = before;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const flush = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const handle = { cancel: () => { cancelled = true; box.hide(); } };
    openBox = handle;
    void vscode.commands.executeCommand('setContext', FILTER_OPEN_CONTEXT_KEY, true);
    return new Promise<void>((resolve) => {
      box.onDidChangeValue((value) => {
        flush();
        timer = setTimeout(() => {
          timer = undefined;
          this.apply(value);
        }, this.options.debounceMs ?? FILTER_DEBOUNCE_MS);
      });
      box.onDidAccept(() => {
        flush();
        this.apply(box.value);
        box.hide();
      });
      box.onDidHide(() => {
        flush();
        // Escape puts the earlier filter back; Enter or clicking away keeps what was typed.
        this.apply(cancelled ? before : box.value);
        if (openBox === handle) {
          openBox = undefined;
          void vscode.commands.executeCommand('setContext', FILTER_OPEN_CONTEXT_KEY, false);
        }
        this.box = undefined;
        box.dispose();
        resolve();
      });
      box.show();
    });
  }

  /** The view's message and description after a listing. */
  private show(outcome: FilterOutcome | undefined): void {
    if (!outcome) {
      this.view.message = undefined;
      this.view.description = this.tree.headerTotal?.();
      return;
    }
    this.view.message = describeFilterOutcome(outcome, this.options.noun);
    this.view.description = outcome.query.text;
  }

  dispose(): void {
    this.subscription.dispose();
    this.box?.dispose();
  }
}

/** Each view's box: its title, examples and what it calls its rows. */
const VIEW_FILTERS = {
  diagrams: {
    title: 'Filter Diagrams',
    placeholder: 'sales  layer:gold  table:dim_customer  schema:finance',
    spec: DIAGRAMS_FILTER,
    noun: { one: 'diagram', many: 'diagrams' },
  },
  tableLibrary: {
    title: 'Filter Table Library',
    placeholder: 'customer  layer:gold  owner:finance  col:customer_id  is:unused',
    spec: TABLE_LIBRARY_FILTER,
    noun: { one: 'table', many: 'tables' },
  },
  relationships: {
    title: 'Filter Relationships',
    placeholder: 'customer  layer:gold  file:sales  col:customer_id  is:problem',
    spec: RELATIONSHIPS_FILTER,
    noun: { one: 'relationship', many: 'relationships' },
  },
} as const;

export type SidebarFilterViewName = keyof typeof VIEW_FILTERS;

export type SidebarFilters = Record<SidebarFilterViewName, SidebarFilter>;

/**
 * One filter per sidebar view, and their commands: Filter… and Clear Filter
 * for each view, and Escape in an open box. `createInputBox` is for tests.
 */
export function registerSidebarFilters(
  views: Record<SidebarFilterViewName, { view: FilteredView; tree: FilterableTree }>,
  createInputBox?: () => vscode.InputBox,
): { filters: SidebarFilters; disposables: vscode.Disposable[] } {
  const names = Object.keys(VIEW_FILTERS) as SidebarFilterViewName[];
  const filters = Object.fromEntries(names.map((name) => [name, new SidebarFilter(views[name].view, views[name].tree, {
    ...VIEW_FILTERS[name],
    contextKey: FILTER_COMMANDS[name].contextKey,
    ...(createInputBox ? { createInputBox } : {}),
  })])) as SidebarFilters;
  const disposables: vscode.Disposable[] = [
    ...Object.values(filters),
    ...names.flatMap((name) => [
      vscode.commands.registerCommand(FILTER_COMMANDS[name].filter, () => filters[name].open()),
      vscode.commands.registerCommand(FILTER_COMMANDS[name].clear, () => filters[name].clear()),
    ]),
    vscode.commands.registerCommand(CANCEL_FILTER_COMMAND, cancelOpenFilter),
  ];
  return { filters, disposables };
}
