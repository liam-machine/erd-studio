/**
 * The glass sidebar's section headers, made consistent: every section shows
 * at most a `+` (what it can create), then Collapse All (an icon, in each
 * section whose native view has `showCollapseAll`: Diagrams, Table Library,
 * Relationships; drawn by the page, which also takes Cmd/Ctrl+Left on a
 * row), then a `…` (everything else), in that order. A section with no `+`
 * draws Collapse All first; Collapse All is never in the `…` menu. The native trees' title bars differ per view (a search here, a
 * filter there, a grouping toggle on one), and the glass sidebar has one
 * search field over all sections, so here:
 *
 * - the per-view Filter… commands are left out: the search field drives the
 *   same filters (all three at once). They stay in the Command Palette;
 * - a section's Clear Filter shows (as an icon) only while that section has
 *   a filter of its own, set from the Command Palette, that the field does
 *   not show; a filter typed in the field is cleared from the field;
 * - Go to Table… stays, at the top of the Table Library's `…` menu. It is
 *   not a filter the field replaces but a jump to one table (a picker with
 *   each table's details, opening it on a diagram), and it belongs to the
 *   Table Library; the header rule leaves no room for a third icon, and every
 *   other non-create title icon moves to the top of `…` the same way;
 * - the Table Library's New Table… / New Schema… become its `+`, as the
 *   Diagrams view's New… menu is;
 * - any other title-bar icon (the Relationships grouping toggle) moves to the
 *   top of the `…` menu.
 *
 * Pure, and only a view of package.json's `view/title` entries: each action
 * keeps its (menu, index), so the host still resolves and re-checks the
 * command when one is invoked.
 */
import type { MenuAction } from './contributions';

/** The Filter… boxes the one search field replaces. */
const HIDDEN_COMMANDS: ReadonlySet<string> = new Set([
  'erdStudio.filterDiagrams',
  'erdStudio.filterTableLibrary',
  'erdStudio.filterRelationships',
]);

/** Shown as an icon while a Command Palette filter is in force, so it can be cleared. */
const CLEAR_FILTER_COMMANDS: ReadonlySet<string> = new Set([
  'erdStudio.clearDiagramsFilter',
  'erdStudio.clearTableLibraryFilter',
  'erdStudio.clearRelationshipsFilter',
]);

/** Create commands that a section without a `+` submenu gets one made from. */
const CREATE_COMMANDS: ReadonlySet<string> = new Set(['erdStudio.newTable', 'erdStudio.newSchema']);

export interface TitleActions {
  navigation: MenuAction[];
  groups: MenuAction[][];
}

export interface TitleActionOptions {
  /**
   * The section's filter is the search field's (every section shares it):
   * the field clears it, so the section offers no Clear Filter of its own.
   */
  filterInField?: boolean;
}

/**
 * @param commandOf the command a title action runs (undefined for a submenu).
 */
export function consistentTitleActions(
  actions: TitleActions,
  commandOf: (action: MenuAction) => string | undefined,
  options: TitleActionOptions = {},
): TitleActions {
  const keep = (a: MenuAction): boolean => { const c = commandOf(a); return !c || !HIDDEN_COMMANDS.has(c); };
  const isCreate = (a: MenuAction): boolean => { const c = commandOf(a); return !!c && CREATE_COMMANDS.has(c); };

  const add: MenuAction[] = [];
  const clear: MenuAction[] = [];
  const moved: MenuAction[] = [];
  for (const a of actions.navigation.filter(keep)) {
    const command = commandOf(a);
    if (a.submenu) add.push(a);
    else if (command && CLEAR_FILTER_COMMANDS.has(command)) { if (!options.filterInField) clear.push(a); }
    else moved.push(a);
  }

  const created: MenuAction[] = [];
  const groups: MenuAction[][] = [];
  for (const group of actions.groups) {
    const rest: MenuAction[] = [];
    for (const a of group.filter(keep)) (isCreate(a) ? created : rest).push(a);
    if (rest.length) groups.push(rest);
  }
  if (created.length) {
    if (add.length === 0) add.push({ index: -1, menu: created[0].menu, title: 'New…', icon: 'add', submenu: [created] });
    else groups.unshift(created);
  }
  if (moved.length) groups.unshift(moved);

  return { navigation: [...add, ...clear], groups };
}
