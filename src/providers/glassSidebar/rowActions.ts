/**
 * The glass sidebar's rows, made consistent across Diagrams, the Table
 * Library and Relationships (the row counterpart of titleActions.ts):
 *
 * - **One hover button, then `…`.** A row shows at most one of its `inline`
 *   entries as a hover button: the one that adds or creates (`+`: New
 *   Diagram… on a layer, New Table… on a layer or schema, Add to Open Diagram
 *   on a table), else the first other one (Open in File on a relationship
 *   whose click goes to the diagram, Open in Diagram on one whose click opens
 *   the file, the duplicate's fix). The button offers the next thing you do
 *   with the row, never what its click already does (package.json's `when`s
 *   keep the click's own action off the row). Delete is never a hover button.
 * - **No `…` that repeats the button.** A row whose menu would hold nothing
 *   but its hover button's action draws no `…` (`menuRepeatsHover`); its
 *   right-click and Shift+F10 still open that one-entry menu, so the action
 *   is reachable from the keyboard (the hover button is not in the tab order).
 * - **One menu order.** Every row's menu is the same verbs in the same order,
 *   one group per verb, separated: open / reveal, then add / create, then
 *   rename / move / edit, then export / copy, then anything else, then delete
 *   or remove last, on its own.
 * - **The menu holds everything.** A hover entry with no menu entry of its
 *   own (Refresh My Reports) is added to the menu, and so is an inline entry
 *   no longer shown as a button: every row action is reachable from the
 *   keyboard (Shift+F10) as well as the pointer. A command is listed once.
 *
 * Pure, and only a view of package.json's `view/item/context` entries: each
 * action keeps its (menu, index), so the host still resolves the command and
 * re-checks its `when` when one is invoked.
 */
import type { MenuAction } from './contributions';

/** What an action does to a row, in menu order. */
export type RowVerb = 'open' | 'create' | 'edit' | 'export' | 'other' | 'delete';

export const ROW_VERB_ORDER: readonly RowVerb[] = ['open', 'create', 'edit', 'export', 'other', 'delete'];

/** Which hover entry wins when a row has several `inline` entries (lower first). */
const HOVER_RANK: Readonly<Record<RowVerb, number>> = { create: 0, open: 1, edit: 2, export: 3, other: 4, delete: 99 };

/** The row commands package.json contributes today, by verb. */
const VERB_OF_COMMAND: Readonly<Record<string, RowVerb>> = {
  // open / reveal
  'erdStudio.openTableFile': 'open',
  'erdStudio.openInDiagram': 'open',
  'erdStudio.showOnAnotherDiagram': 'open',
  'erdStudio.openRelationshipSource': 'open',
  'erdStudio.revealLogicalModel': 'open',
  // add / create
  'erdStudio.createDomain': 'create',
  'erdStudio.newTable': 'create',
  'erdStudio.newSchema': 'create',
  'erdStudio.addToOpenDiagram': 'create',
  'erdStudio.addToDiagram': 'create',
  'erdStudio.addLayer': 'create',
  // rename / move / edit
  'erdStudio.renameDomain': 'edit',
  'erdStudio.moveDiagram': 'edit',
  'erdStudio.moveTable': 'edit',
  'erdStudio.editLayer': 'edit',
  'erdStudio.resolveDuplicateModel': 'edit',
  // export / copy
  'erdStudio.exportDiagram': 'export',
  // delete / remove
  'erdStudio.deleteDomain': 'delete',
  'erdStudio.deleteLogicalModel': 'delete',
  'erdStudio.removeLayer': 'delete',
};

/** A command's verb: from {@link VERB_OF_COMMAND}, else read from its title's first word. */
export function rowVerb(command: string | undefined, title: string): RowVerb {
  if (command && Object.prototype.hasOwnProperty.call(VERB_OF_COMMAND, command)) return VERB_OF_COMMAND[command];
  if (/^(Open|Reveal|Show|Go to)\b/.test(title)) return 'open';
  if (/^(New|Add|Create|Import)\b/.test(title)) return 'create';
  if (/^(Rename|Move|Edit|Change)\b/.test(title)) return 'edit';
  if (/^(Export|Copy)\b/.test(title)) return 'export';
  if (/^(Delete|Remove)\b/.test(title)) return 'delete';
  return 'other';
}

export interface RowMenu {
  inline: MenuAction[];
  navigation: MenuAction[];
  groups: MenuAction[][];
}

export interface RowActions {
  /** The hover button (none or one), drawn before the row's `…`. */
  inline: MenuAction[];
  /** The context menu: one group per verb, in {@link ROW_VERB_ORDER}. */
  groups: MenuAction[][];
  /** The menu holds only the hover button's action: the row draws no `…` (right-click still lists it). */
  menuRepeatsHover?: true;
}

/**
 * @param menu a row's `view/item/context`, as {@link ContributionIndex.resolve} returns it.
 * @param commandOf the command an action runs (undefined for a submenu).
 */
export function consistentRowActions(menu: RowMenu, commandOf: (action: MenuAction) => string | undefined): RowActions {
  const verbOf = (a: MenuAction): RowVerb => rowVerb(commandOf(a), a.title);

  // The hover button: the best-ranked inline entry, never a delete. Stable: ties keep package.json's order.
  const hover = menu.inline
    .map((a, i) => ({ a, i, rank: HOVER_RANK[verbOf(a)] }))
    .filter((x) => x.rank < HOVER_RANK.delete)
    .sort((x, y) => x.rank - y.rank || x.i - y.i)[0]?.a;

  // The menu: its own entries first (they carry the menu's own `when`), then any inline entry not already there.
  const seen = new Set<string>();
  const entries: MenuAction[] = [];
  for (const a of [...menu.navigation, ...menu.groups.flat(), ...menu.inline]) {
    const command = commandOf(a);
    if (command) {
      if (seen.has(command)) continue;
      seen.add(command);
    }
    entries.push(a);
  }
  const buckets = new Map<RowVerb, MenuAction[]>(ROW_VERB_ORDER.map((v) => [v, []]));
  for (const a of entries) buckets.get(verbOf(a))!.push(a);

  const repeats = !!hover && entries.length === 1 && (entries[0] === hover || (commandOf(entries[0]) !== undefined && commandOf(entries[0]) === commandOf(hover)));
  return {
    inline: hover ? [hover] : [],
    groups: ROW_VERB_ORDER.map((v) => buckets.get(v)!).filter((g) => g.length > 0),
    ...(repeats ? { menuRepeatsHover: true as const } : {}),
  };
}
