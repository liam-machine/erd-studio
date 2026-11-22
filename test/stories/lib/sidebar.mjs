// The ERD Studio sidebar as a new user has it: the glass sidebar
// (src/providers/glassSidebar/, on by default), one webview that draws the
// Diagrams, Table Library, Relationships and Help & Feedback sections as
// cards. It is a page of its own, not workbench DOM: the workbench holds only
// the side bar's frame and title, so nothing in it can be found from the
// workbench (`s.wb`). `s.sidebar` is the actor inside that page; expressions
// see its document as `doc`, as in any webview (act.mjs `Webview`).
//
// Its DOM is ours (glassSidebar/html.ts), so its selectors live here, in one
// place, as the draft's do in draft.mjs and VS Code's in vscode.mjs.

import { Webview, sleep } from './act.mjs';
import { sel } from './vscode.mjs';

const q = JSON.stringify;

/** Shown: it has a box, and its section is not folded (a folded card keeps its content in the page). */
const SHOWN = `(e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('.gs-section--collapsed .gs-section__body'); }`;
/** A row's label (the search field's highlight marks are inside it). */
const LABEL = `(r) => (r.querySelector('.gs-row__label')?.textContent ?? '').trim()`;
const SECTION = (title) => `[...doc.querySelectorAll('.gs-section')].find(c => (c.querySelector('.gs-section__title')?.textContent ?? '').trim().toUpperCase() === ${q(title)}.toUpperCase())`;

/** Selector expressions inside the sidebar's page (JS that evaluates to an element, a value, or undefined). */
export const SIDEBAR = {
  /** A section's card (`Diagrams`, `Table Library`, `Relationships`, `Help & Feedback`), by its title. */
  section: SECTION,
  /** A section's header: its title, which folds and unfolds the card. */
  sectionHeader: (title) => `${SECTION(title)}?.querySelector('.gs-section__toggle')`,
  /** The sections on show, by title, in order. */
  sections: `[...doc.querySelectorAll('.gs-section .gs-section__title')].map(t => t.textContent.trim())`,
  /** A link or button of a section's empty state (its welcome text), by its text. */
  welcomeLink: (text) => `[...doc.querySelectorAll('.gs-welcome [data-act="welcome"]')].filter(${SHOWN}).find(a => a.textContent.trim() === ${q(text)})`,
  /**
   * The empty states' buttons on show, by text: a link alone on its line is a
   * button (the first one the primary), every other link is inline.
   */
  welcomeButtons: `[...doc.querySelectorAll('.gs-welcome .gs-button')].filter(${SHOWN}).map(b => b.textContent.trim())`,
  /** A row (a diagram, a layer, a table, a relationship, a help link), by its label. */
  row: (label) => `[...doc.querySelectorAll('.gs-row[data-id]')].filter(${SHOWN}).find(r => (${LABEL})(r) === ${q(label)})`,
  /** The rows on show, by label, in order; with `section`, that section's only. */
  rows: (section) => `[...(${section ? SECTION(section) : 'doc'}?.querySelectorAll('.gs-row[data-id]') ?? [])].filter(${SHOWN}).map(${LABEL})`,
  /** A section header's icon button (`New…`, a Clear Filter), by the start of its title. */
  titleAction: (section, title) => `[...(${SECTION(section)}?.querySelectorAll('.gs-section__actions [data-act="title"]') ?? [])].find(b => (b.getAttribute('aria-label') ?? '').startsWith(${q(title)}))`,
  /** A section header's `…`: every title action that is not its `+` (Watch the Tour, Go to Table…). */
  moreActions: (section) => `${SECTION(section)}?.querySelector('.gs-section__actions [data-act="title-more"]')`,
  /** The open menu's entries, by label, in order (a header's `…`, a row's, a `+`). */
  menuItems: `[...doc.querySelectorAll('.gs-menu [role="menuitem"] .gs-menu__item-label')].map(l => l.textContent.trim())`,
  /** An entry of the open menu, by its label. */
  menuItem: (label) => `[...doc.querySelectorAll('.gs-menu [role="menuitem"]')].find(i => (i.querySelector('.gs-menu__item-label')?.textContent ?? '').trim() === ${q(label)})`,
};

/**
 * The actor inside the ERD Studio sidebar's page. It finds the page each time
 * it acts (the page is another one after a window reload, and there is none
 * while another view container shows), so a story holds `s.sidebar` for its
 * whole run and never a page of its own.
 */
export class Sidebar {
  constructor(wb) {
    this.wb = wb;
    this.view = null;
  }

  /** The page's webview actor; throws when no ERD Studio page shows in the side bar within `timeout`. */
  async page({ timeout = 20000 } = {}) {
    // The page is drawn over the workbench's side bar (its frame: `sel.sidebar`).
    const found = await Webview.find(this.wb, { within: sel.sidebar, where: 'the side bar', timeout });
    if (this.view && this.view.target.id === found.target.id) return this.view;
    this.view?.close();
    this.view = found;
    return found;
  }

  /** Evaluate in the page (`doc`, `win`). */
  async ev(expr) {
    return (await this.page()).ev(expr);
  }

  /** Wait until `expr` is truthy in the page, through a reload; resolves its value. */
  async waitFor(expr, { timeout = 20000, what } = {}) {
    const until = Date.now() + timeout;
    for (;;) {
      const v = await this.page({ timeout: 0 })
        .then((page) => page.ev(`(() => { try { const v = (${expr}); return v && typeof v === 'object' && 'nodeType' in v ? true : (v || null); } catch { return null; } })()`))
        .catch(() => null);
      if (v) return v;
      if (Date.now() > until) throw new Error(`timed out after ${timeout} ms waiting in the ERD Studio sidebar for ${what ?? expr}`);
      await sleep(250);
    }
  }

  /** The element `expr` is on show in the sidebar (waits). */
  async expectVisible(expr, { timeout = 20000, what } = {}) {
    await this.waitFor(`(() => { const el=${expr}; if(!el) return false; const r=el.getBoundingClientRect(); return r.width>0 && r.height>0; })()`, { timeout, what: what ?? expr });
  }

  /** A trusted click on the element, as a person's (it is scrolled into view first). */
  async click(expr) {
    await this.expectVisible(expr);
    return (await this.page()).click(expr);
  }

  /**
   * Put the pointer on the element, as a person's hand does before a click:
   * a section header's icons (its `+`, Collapse All, its `…`) show only while
   * the pointer is on the header (or the keyboard's focus in it).
   */
  async hover(expr) {
    await this.expectVisible(expr);
    const p = await (await this.page()).center(expr);
    if (!p) throw new Error(`not found in the ERD Studio sidebar: ${expr}`);
    await this.wb.moveToPoint(p);
    return p;
  }

  /** Draw the workbench's highlight box around an element of the sidebar. */
  async highlight(expr, pad = 4) {
    return (await this.page()).highlight(expr, pad);
  }

  /** What the sidebar's page says (its visible text), or '' while it is not showing. */
  async text() {
    try {
      return (await (await this.page({ timeout: 0 })).ev(`doc.body?.innerText ?? ''`)) ?? '';
    } catch {
      return '';
    }
  }

  close() {
    this.view?.close();
    this.view = null;
  }
}
