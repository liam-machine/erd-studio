/**
 * The glass sidebar reads this extension's own package.json contributions —
 * `views`, `viewsWelcome`, `menus` (`view/title`, `view/item/context`, the
 * submenus) and `commands` — so its sections, empty states, title actions
 * and row menus are exactly what the native trees show, decided by the same
 * `when` clauses ({@link evaluateWhen}). Nothing here is duplicated content:
 * a menu change in package.json reaches both sidebars.
 *
 * Pure (no `vscode`): the provider passes the parsed manifest in.
 */
import { evaluateWhen, type ContextLookup } from './whenClause';

export interface CommandContribution {
  command: string;
  title: string;
  shortTitle?: string;
  icon?: string | { light: string; dark: string };
  category?: string;
}

export interface MenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}

export interface ViewContribution {
  id: string;
  name: string;
  when?: string;
  visibility?: 'visible' | 'hidden' | 'collapsed';
  type?: string;
}

export interface ViewsWelcomeContribution {
  view: string;
  contents: string;
  when?: string;
}

export interface SubmenuContribution {
  id: string;
  label: string;
  icon?: string;
}

export interface Contributions {
  commands?: CommandContribution[];
  menus?: Record<string, MenuEntry[]>;
  views?: Record<string, ViewContribution[]>;
  viewsWelcome?: ViewsWelcomeContribution[];
  submenus?: SubmenuContribution[];
}

/** The context key the glass sidebar is shown by; the native views add `&& !erdStudio.glassSidebar`. */
export const GLASS_SIDEBAR_CONTEXT_KEY = 'erdStudio.glassSidebar';

/** One action as the webview shows it: what to draw, and the index to send back. */
export interface MenuAction {
  /** The entry's index in its menu array (`menus[menu][index]`), all the webview may send back. */
  index: number;
  /** The menu the index is into: `view/item/context`, `view/title` or a submenu id. */
  menu: string;
  title: string;
  /** A codicon id (`add`, from `$(add)`), when the command has one. */
  icon?: string;
  /** A submenu entry: its own groups, resolved. */
  submenu?: MenuAction[][];
}

/**
 * `navigation@2` → group `navigation`, order 2. An entry without a group gets
 * the empty group name, which {@link compareGroups} sorts last, as VS Code does.
 */
export function parseGroup(group: string | undefined): { group: string; order: number } {
  if (!group) return { group: '', order: 0 };
  const at = group.lastIndexOf('@');
  if (at < 0) return { group, order: 0 };
  const order = Number(group.slice(at + 1));
  return { group: group.slice(0, at), order: Number.isFinite(order) ? order : 0 };
}

/**
 * VS Code's menu group order (`compareMenuItems` in the workbench): the
 * `navigation` group first, groups without a name last, the rest by name.
 */
export function compareGroups(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  if (a === 'navigation') return -1;
  if (b === 'navigation') return 1;
  return a.localeCompare(b);
}

/** The codicon id in `$(name)` form, or undefined. */
export function codiconId(icon: unknown): string | undefined {
  if (typeof icon !== 'string') return undefined;
  const m = /^\$\(([\w-]+)(?:~[\w-]+)?\)$/.exec(icon.trim());
  return m ? m[1] : undefined;
}

export class ContributionIndex {
  private readonly commands = new Map<string, CommandContribution>();
  private readonly submenus = new Map<string, SubmenuContribution>();

  constructor(readonly contributes: Contributions) {
    for (const c of contributes.commands ?? []) this.commands.set(c.command, c);
    for (const s of contributes.submenus ?? []) this.submenus.set(s.id, s);
  }

  command(id: string): CommandContribution | undefined {
    return this.commands.get(id);
  }

  menu(id: string): MenuEntry[] {
    const menus = this.contributes.menus;
    // Own keys only: an id like `constructor` must not reach Object.prototype.
    if (!menus || !Object.prototype.hasOwnProperty.call(menus, id)) return [];
    const entries = menus[id];
    return Array.isArray(entries) ? entries : [];
  }

  /** The ERD Studio container's views, in order. */
  views(container = 'erd-studio'): ViewContribution[] {
    return this.contributes.views?.[container] ?? [];
  }

  /**
   * The entries of `menu` whose `when` holds, grouped as VS Code groups them
   * (`navigation` first, then by group name, ungrouped last; within a group
   * by `@order`, then by title). `inline` entries are returned separately
   * (row hover buttons; VS Code leaves them out of the context menu) and so
   * is `navigation` (the title bar's icons; first group of a context menu).
   */
  resolve(menu: string, ctx: ContextLookup, depth = 0): { inline: MenuAction[]; navigation: MenuAction[]; groups: MenuAction[][] } {
    const all = this.resolveGroups(menu, ctx, depth);
    const pick = (name: string): MenuAction[] => all.find((g) => g.group === name)?.actions ?? [];
    return {
      inline: pick('inline'),
      navigation: pick('navigation'),
      groups: all.filter((g) => g.group !== 'inline' && g.group !== 'navigation').map((g) => g.actions),
    };
  }

  /** Every group of `menu` whose entries hold, in VS Code's order, `inline` included where its name sorts. */
  private resolveGroups(menu: string, ctx: ContextLookup, depth: number): Array<{ group: string; actions: MenuAction[] }> {
    const byGroup = new Map<string, Array<{ order: number; action: MenuAction }>>();
    this.menu(menu).forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      if (!evaluateWhen(entry.when, ctx)) return;
      const action = this.action(menu, entry, index, ctx, depth);
      if (!action) return;
      const { group, order } = parseGroup(entry.group);
      let list = byGroup.get(group);
      if (!list) { list = []; byGroup.set(group, list); }
      list.push({ order, action });
    });
    return [...byGroup.keys()]
      .sort(compareGroups)
      .map((group) => ({
        group,
        actions: (byGroup.get(group) ?? [])
          .slice()
          .sort((a, b) => a.order - b.order || a.action.title.localeCompare(b.action.title))
          .map((e) => e.action),
      }));
  }

  private action(menu: string, entry: MenuEntry, index: number, ctx: ContextLookup, depth: number): MenuAction | undefined {
    if (entry.command) {
      // VS Code drops a menu item whose command is not contributed.
      const c = this.command(entry.command);
      if (!c) return undefined;
      const icon = codiconId(c.icon);
      return { index, menu, title: typeof c.title === 'string' ? c.title : entry.command, ...(icon ? { icon } : {}) };
    }
    if (entry.submenu && depth < 2) {
      // …and one whose submenu is not contributed.
      const s = this.submenus.get(entry.submenu);
      if (!s) return undefined;
      const groups = this.resolveGroups(entry.submenu, ctx, depth + 1).map((g) => g.actions).filter((g) => g.length > 0);
      if (groups.length === 0) return undefined;
      const icon = codiconId(s.icon);
      return {
        index, menu,
        title: typeof s.label === 'string' ? s.label : entry.submenu,
        ...(icon ? { icon } : {}),
        submenu: groups,
      };
    }
    return undefined;
  }

  /**
   * The command a webview's (menu, index) names, when that entry exists and
   * its `when` still holds. `allowedMenus` are the menus the caller lets this
   * request reach (the item menu, or the title menu plus the submenus a
   * visible title entry opens).
   */
  commandFor(menu: string, index: number, ctx: ContextLookup, allowedMenus: ReadonlySet<string>): string | undefined {
    if (!allowedMenus.has(menu)) return undefined;
    if (!Number.isInteger(index) || index < 0) return undefined;
    const entry = this.menu(menu)[index];
    if (!entry?.command || !this.command(entry.command)) return undefined;
    if (!evaluateWhen(entry.when, ctx)) return undefined;
    return entry.command;
  }

  /** The submenus `menu`'s entries open, when their `when` holds (one level). */
  submenusOf(menu: string, ctx: ContextLookup): string[] {
    return this.menu(menu)
      .filter((e) => e?.submenu && this.submenus.has(e.submenu) && evaluateWhen(e.when, ctx))
      .map((e) => e.submenu as string);
  }

  /** The viewsWelcome entries for `viewId` whose `when` holds, with their index. */
  welcome(viewId: string, ctx: ContextLookup): Array<{ index: number; contents: string }> {
    const out: Array<{ index: number; contents: string }> = [];
    (this.contributes.viewsWelcome ?? []).forEach((w, index) => {
      if (w.view === viewId && evaluateWhen(w.when, ctx)) out.push({ index, contents: w.contents });
    });
    return out;
  }

  welcomeEntry(index: number): ViewsWelcomeContribution | undefined {
    if (!Number.isInteger(index) || index < 0) return undefined;
    return this.contributes.viewsWelcome?.[index];
  }
}

// ---------------------------------------------------------------------------
// viewsWelcome contents: paragraphs of text and [label](command:…) links
// ---------------------------------------------------------------------------

export type WelcomePart = { kind: 'text'; text: string } | { kind: 'link'; label: string; link: number };

export interface WelcomeParagraph {
  /** A paragraph that is one link and nothing else: VS Code draws it as a button. */
  button: boolean;
  parts: WelcomePart[];
}

export interface WelcomeLink {
  label: string;
  href: string;
}

/** Split viewsWelcome markdown into paragraphs (blank-line separated) of text and links, numbering the links in order. */
export function parseWelcomeContents(contents: string): { paragraphs: WelcomeParagraph[]; links: WelcomeLink[] } {
  const links: WelcomeLink[] = [];
  const paragraphs: WelcomeParagraph[] = [];
  for (const block of contents.split(/\n\s*\n/)) {
    const text = block.replace(/\s*\n\s*/g, ' ').trim();
    if (!text) continue;
    const parts: WelcomePart[] = [];
    const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push({ kind: 'text', text: text.slice(last, m.index) });
      links.push({ label: m[1], href: m[2] });
      parts.push({ kind: 'link', label: m[1], link: links.length - 1 });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
    paragraphs.push({ button: parts.length === 1 && parts[0].kind === 'link', parts });
  }
  return { paragraphs, links };
}

/** Command ids a welcome link may run from the glass sidebar. */
export function isAllowedWelcomeCommand(id: string): boolean {
  return /^erdStudio\.[\w.]+$/.test(id) || id === 'workbench.action.files.openFolder';
}

/**
 * A `command:id?<url-encoded JSON args>` link → the command and its
 * arguments, or undefined for any other link or a command outside
 * {@link isAllowedWelcomeCommand}.
 */
export function parseCommandLink(href: string): { command: string; args: unknown[] } | undefined {
  const m = /^command:([\w.-]+)(?:\?(.*))?$/.exec(href);
  if (!m) return undefined;
  const command = m[1];
  if (!isAllowedWelcomeCommand(command)) return undefined;
  if (m[2] === undefined || m[2] === '') return { command, args: [] };
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(m[2]));
    return { command, args: Array.isArray(parsed) ? parsed : [parsed] };
  } catch {
    return undefined;
  }
}

/**
 * A native view's `when` with the glass sidebar's own clause taken out: the
 * glass section shows when the native view would have shown with the glass
 * sidebar off.
 */
export function withoutGlassClause(when: string | undefined): string | undefined {
  if (!when) return when;
  const stripped = when
    .replace(/\s*&&\s*!\s*erdStudio\.glassSidebar\b/g, '')
    .replace(/^\s*!\s*erdStudio\.glassSidebar\s*(&&\s*)?/, '')
    .trim();
  return stripped === '' ? undefined : stripped;
}
