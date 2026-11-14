/**
 * The glass sidebar's page script (html.ts), run in jsdom: a `state` the page
 * already drew changes nothing, and a changed one is patched in place, so the
 * row under a resting pointer (its element, :hover, focus, open menu) survives
 * a refresh. Rebuilding every row on every `state` replayed the hover fill and
 * fade-ins under the pointer: the "flashes non stop" bug.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

import { readFileSync } from 'fs';
import { join } from 'path';

import { ContributionIndex, parseWelcomeContents, type Contributions } from '../../src/providers/glassSidebar/contributions';
import { buildGlassSidebarHtml } from '../../src/providers/glassSidebar/html';
import type { GlassFilterGuide, GlassSection, SerialisedNode } from '../../src/providers/glassSidebar/protocol';

type Win = JSDOM['window'];

const open: JSDOM[] = [];

afterEach(() => {
  for (const dom of open.splice(0)) dom.window.close();
});

function load(initial?: unknown, filterGuide?: GlassFilterGuide): { win: Win; posted: unknown[]; saved: { state: unknown } } {
  const posted: unknown[] = [];
  const saved = { state: initial };
  const html = buildGlassSidebarHtml({ cspSource: 'https://webview.test', nonce: 'bm9uY2U=', tokensCssUri: 'about:blank', ...(filterGuide ? { filterGuide } : {}) });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (m: unknown) => { posted.push(m); },
        getState: () => saved.state,
        setState: (s: unknown) => { saved.state = s; },
      });
      // jsdom has no scrolling.
      (window as unknown as { scrollTo: () => void }).scrollTo = () => undefined;
      window.Element.prototype.scrollIntoView = () => undefined;
    },
  });
  open.push(dom);
  return { win: dom.window, posted, saved };
}

function row(id: string, label: string, extra: Partial<SerialisedNode> = {}): SerialisedNode {
  return {
    id, label, collapsible: 0, hasCommand: true, hasMenu: true,
    inline: [{ index: 3, menu: 'view/item/context', title: 'Add to Diagram…', icon: 'add' }],
    ...extra,
  };
}

function sections(tables: SerialisedNode[], count = '2 tables'): GlassSection[] {
  return [
    {
      key: 'tables', title: 'Table Library', visible: true, defaultCollapsed: false, count,
      actions: { navigation: [{ index: 1, menu: 'view/title', title: 'Filter…', icon: 'filter' }], groups: [[{ index: 2, menu: 'view/title', title: 'Refresh' }]] },
      welcome: [], nodes: tables,
    },
  ];
}

function sendState(win: Win, s: GlassSection[]): void {
  // A fresh copy each time, as postMessage delivers one.
  win.dispatchEvent(new win.MessageEvent('message', { data: JSON.parse(JSON.stringify({ type: 'state', sections: s })) }));
}

function rowEl(win: Win, id: string): HTMLElement | undefined {
  return [...win.document.querySelectorAll<HTMLElement>('.gs-row[data-id]')].find((r) => r.dataset.id === id);
}

async function mutationsDuring(win: Win, fn: () => void): Promise<MutationRecord[]> {
  const records: MutationRecord[] = [];
  const mo = new win.MutationObserver((list) => { records.push(...list); });
  mo.observe(win.document, { subtree: true, childList: true, attributes: true, characterData: true });
  fn();
  await new Promise((r) => setTimeout(r, 0));
  records.push(...mo.takeRecords());
  mo.disconnect();
  return records;
}

/** A DataTransfer good enough for the page script (jsdom has none). */
function transfer() {
  const data: Record<string, string> = {};
  const image = { text: '', className: '' };
  return {
    data, image, effectAllowed: 'uninitialized', dropEffect: 'none',
    setData: (t: string, v: string) => { data[t] = v; },
    setDragImage: (el: Element) => { image.text = el.textContent ?? ''; image.className = el.className; },
  };
}

function fire(win: Win, el: Element, type: string, dataTransfer = transfer()): Event & { dataTransfer: ReturnType<typeof transfer> } {
  const ev = new win.Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: ReturnType<typeof transfer> };
  Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer });
  el.dispatchEvent(ev);
  return ev;
}

const base = [row('tables:a', 'dim_customer'), row('tables:b', 'fct_order')];

describe('the glass sidebar page', () => {
  it('says ready, then draws a state', () => {
    const { win, posted } = load();
    expect(posted).toEqual([{ type: 'ready' }]);
    sendState(win, sections(base));
    expect(rowEl(win, 'tables:a')?.textContent).toContain('dim_customer');
    expect(rowEl(win, 'tables:b')).toBeDefined();
  });

  it('treats a state identical to the last as a no-op: no DOM mutation at all', async () => {
    const { win } = load();
    sendState(win, sections(base));
    const records = await mutationsDuring(win, () => {
      for (let i = 0; i < 5; i++) sendState(win, sections(base));
    });
    expect(records.map((r) => `${r.type} ${r.attributeName ?? ''}`)).toEqual([]);
  });

  it('patches a changed state in place: unchanged rows keep their elements and are not touched', async () => {
    const { win } = load();
    sendState(win, sections(base));
    const a = rowEl(win, 'tables:a')!;
    const aActions = a.querySelector('.gs-row__actions')!;
    const b = rowEl(win, 'tables:b')!;
    const records = await mutationsDuring(win, () => {
      sendState(win, sections([base[0], row('tables:b', 'fct_order_line'), row('tables:c', 'dim_date')], '3 tables'));
    });
    // The same elements, still in the document.
    expect(rowEl(win, 'tables:a') === a).toBe(true);
    expect(a.querySelector('.gs-row__actions') === aActions).toBe(true);
    expect(rowEl(win, 'tables:b') === b).toBe(true);
    expect(b.textContent).toContain('fct_order_line');
    expect(rowEl(win, 'tables:c')?.textContent).toContain('dim_date');
    // Nothing under row a was written but its aria-setsize (a row was added beside it).
    expect(records.filter((r) => (a.contains(r.target) || r.target === a) && r.attributeName !== 'aria-setsize').map((r) => `${r.type} ${r.attributeName ?? ""} ${(r.target as Element).className ?? r.target.nodeName}`)).toEqual([]);
    // And no row element was removed: b was patched, c inserted.
    const removed = records.flatMap((r) => [...r.removedNodes]).filter((n) => (n as HTMLElement).classList?.contains('gs-row'));
    expect(removed.length).toBe(0);
  });

  it('keeps focus on a section header and on a row across a changed state', () => {
    const { win } = load();
    sendState(win, sections(base));
    const head = win.document.getElementById('gs-head-tables')!;
    head.focus();
    sendState(win, sections(base, '3 tables'));
    expect(win.document.activeElement?.id).toBe('gs-head-tables');
    const a = rowEl(win, 'tables:a')!;
    a.focus();
    sendState(win, sections([row('tables:a', 'dim_customer_v2'), base[1]]));
    expect((win.document.activeElement as HTMLElement | null)?.dataset.id).toBe('tables:a');
  });

  it('keeps an open row menu attached to its row across a changed state', () => {
    const { win, posted } = load();
    sendState(win, sections(base));
    const more = rowEl(win, 'tables:a')!.querySelector<HTMLButtonElement>('[data-act="row-more"]')!;
    more.click();
    expect(posted[posted.length - 1]).toEqual({ type: 'itemMenu', section: 'tables', id: 'tables:a' });
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'itemMenu', section: 'tables', id: 'tables:a', groups: [[{ index: 5, menu: 'view/item/context', title: 'Rename…' }]] } }));
    expect(win.document.querySelector('.gs-menu')).not.toBeNull();
    sendState(win, sections([base[0], row('tables:b', 'fct_order_line')]));
    const a = rowEl(win, 'tables:a')!;
    expect(a.classList.contains('is-menu-open')).toBe(true);
    expect(a.querySelector('[data-act="row-more"]')!.getAttribute('aria-expanded')).toBe('true');
    // Escape closes it and returns focus to the row.
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(win.document.querySelector('.gs-menu')).toBeNull();
    expect(a.classList.contains('is-menu-open')).toBe(false);
    expect(win.document.activeElement === a).toBe(true);
  });

  it('sends only ids and indexes from delegated buttons, looked up in the current state', () => {
    const { win, posted } = load();
    sendState(win, sections(base));
    rowEl(win, 'tables:b')!.querySelector<HTMLButtonElement>('[data-act="inline"]')!.click();
    expect(posted[posted.length - 1]).toEqual({ type: 'invoke', section: 'tables', id: 'tables:b', menu: 'view/item/context', index: 3 });
    win.document.querySelector<HTMLButtonElement>('.gs-section__actions [data-act="title"]')!.click();
    expect(posted[posted.length - 1]).toEqual({ type: 'invoke', section: 'tables', menu: 'view/title', index: 1 });
    // A new state with a different entry behind the same button: the click follows the new state.
    const changed = sections([base[0], row('tables:b', 'fct_order', { inline: [{ index: 9, menu: 'view/item/context', title: 'Open', icon: 'go-to-file' }] })]);
    sendState(win, changed);
    rowEl(win, 'tables:b')!.querySelector<HTMLButtonElement>('[data-act="inline"]')!.click();
    expect(posted[posted.length - 1]).toEqual({ type: 'invoke', section: 'tables', id: 'tables:b', menu: 'view/item/context', index: 9 });
  });

  describe('drag and drop', () => {
    const diagramsAndTables = (): GlassSection[] => [
      {
        key: 'diagrams', title: 'Diagrams', visible: true, defaultCollapsed: false, actions: { navigation: [], groups: [] }, welcome: [],
        nodes: [
          row('diagrams:bronze', 'Bronze', { drag: 'layer', drop: ['layer'] }),
          row('diagrams:gold', 'Gold', { drag: 'layer', drop: ['layer'], collapsible: 2, children: [row('diagrams:gold/sales', 'sales', { drop: ['tables'] })] }),
        ],
      },
      ...sections([row('tables:a', 'dim_customer', { drag: 'tables' }), row('tables:dup', 'dim_customer', {})]),
    ];

    it('makes only the rows the host marked draggable', () => {
      const { win } = load();
      sendState(win, diagramsAndTables());
      expect(rowEl(win, 'tables:a')!.getAttribute('draggable')).toBe('true');
      expect(rowEl(win, 'tables:dup')!.hasAttribute('draggable')).toBe(false);
      expect(fire(win, rowEl(win, 'tables:dup')!, 'dragstart').defaultPrevented).toBe(true);
    });

    it('sends row ids only: dragStart, the drop on a row that takes the drag, then dragEnd', () => {
      const { win, posted } = load();
      sendState(win, diagramsAndTables());
      const start = fire(win, rowEl(win, 'tables:a')!, 'dragstart');
      expect(start.defaultPrevented).toBe(false);
      // Nothing of the table itself rides on the browser's drag: the host works out what the rows carry.
      expect(Object.keys(start.dataTransfer.data).sort()).toEqual(['application/vnd.code.tree.erdstudio.modellibrary', 'application/vnd.erdstudio.glass-drag']);
      expect(posted[posted.length - 1]).toEqual({ type: 'dragStart', section: 'tables', ids: ['tables:a'] });
      expect(rowEl(win, 'tables:a')!.classList.contains('is-dragging')).toBe(true);

      // A layer row takes layers, not tables: the drag is not accepted there.
      expect(fire(win, rowEl(win, 'diagrams:gold')!, 'dragover').defaultPrevented).toBe(false);
      expect(win.document.querySelector('.is-drop-target')).toBeNull();
      // A diagram's row takes it, and a redraw mid-drag keeps the highlight.
      const sales = rowEl(win, 'diagrams:gold/sales')!;
      expect(fire(win, sales, 'dragover').defaultPrevented).toBe(true);
      expect(sales.classList.contains('is-drop-target')).toBe(true);
      const again = diagramsAndTables();
      again[0].nodes[0].description = 'Layer';
      sendState(win, again);
      expect(rowEl(win, 'diagrams:gold/sales')!.classList.contains('is-drop-target')).toBe(true);
      expect(rowEl(win, 'tables:a')!.classList.contains('is-dragging')).toBe(true);

      const before = posted.length;
      expect(fire(win, sales, 'drop').defaultPrevented).toBe(true);
      expect(posted.slice(before)).toEqual([{ type: 'drop', section: 'diagrams', id: 'diagrams:gold/sales' }, { type: 'dragEnd' }]);
      expect(win.document.querySelector('.is-drop-target, .is-dragging')).toBeNull();
      expect(win.document.body.classList.contains('gs-dragging')).toBe(false);
    });

    it('posts no drop when the drag is let go on a row that does not take it, or outside the sidebar', () => {
      const { win, posted } = load();
      sendState(win, diagramsAndTables());
      fire(win, rowEl(win, 'tables:a')!, 'dragstart');
      const before = posted.length;
      expect(fire(win, rowEl(win, 'tables:dup')!, 'drop').defaultPrevented).toBe(false);
      fire(win, rowEl(win, 'tables:a')!, 'dragend');
      expect(posted.slice(before)).toEqual([{ type: 'dragEnd' }]);
      // A drag from somewhere else (no dragstart here) is none of the page's business.
      expect(fire(win, rowEl(win, 'diagrams:gold/sales')!, 'dragover').defaultPrevented).toBe(false);
      expect(fire(win, rowEl(win, 'diagrams:gold/sales')!, 'drop').defaultPrevented).toBe(false);
      expect(posted.slice(before)).toEqual([{ type: 'dragEnd' }]);
    });

    /** A pointer event with both its page and screen points (what the page reads where it sits on screen from). */
    const pointer = (win: Win, el: Element, type: string, client: { x: number; y: number }, screen: { x: number; y: number }) => {
      el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, clientX: client.x, clientY: client.y, screenX: screen.x, screenY: screen.y }));
    };
    /** A dragend at a page point (outside the page when let go over a canvas), with the drop effect the browser reports. */
    const dragendAt = (win: Win, el: Element, x: number, y: number, dropEffect = 'none') => {
      const ev = new win.MouseEvent('dragend', { bubbles: true, clientX: x, clientY: y, screenX: 1, screenY: 1 });
      Object.defineProperty(ev, 'dataTransfer', { value: { ...transfer(), dropEffect } });
      el.dispatchEvent(ev);
    };

    it('says where a drag let go outside the sidebar ended: the dragend\'s page point and the page\'s last pointer event, never the dragend\'s screenX', () => {
      const { win, posted } = load();
      sendState(win, diagramsAndTables());
      const a = rowEl(win, 'tables:a')!;
      // The page sits at (48, 68) on screen: its pointer events say so.
      pointer(win, a, 'pointerdown', { x: 30, y: 40 }, { x: 78, y: 108 });
      fire(win, a, 'dragstart');
      const before = posted.length;
      // Let go over the canvas, right of the sidebar: 520 px past the page's left edge.
      dragendAt(win, a, 1520, 449);
      // The page point as the dragend gave it, the pointer event it is mapped by, and the window's place.
      expect(posted.slice(before)).toEqual([{ type: 'dragEnd', at: { x: 1520, y: 449, refX: 30, refY: 40, refScreenX: 78, refScreenY: 108, windowX: 0, windowY: 0 } }]);
    });

    it('says nothing of where when the drag ended in the sidebar, something took the drop, the window moved, or the page never saw the pointer', () => {
      const { win, posted } = load();
      sendState(win, diagramsAndTables());
      const a = rowEl(win, 'tables:a')!;
      const before = posted.length;
      // Never saw a pointer event: its place on screen is unknown.
      fire(win, a, 'dragstart');
      dragendAt(win, a, 1520, 449);
      pointer(win, a, 'pointermove', { x: 30, y: 40 }, { x: 78, y: 108 });
      // Let go inside the page (over the sidebar).
      fire(win, a, 'dragstart');
      dragendAt(win, a, 100, 200);
      // A frame took the drop (an effect other than none).
      fire(win, a, 'dragstart');
      dragendAt(win, a, 1520, 449, 'copy');
      // The window moved since the page last saw the pointer.
      fire(win, a, 'dragstart');
      Object.defineProperty(win, 'screenX', { value: 300, configurable: true });
      dragendAt(win, a, 1520, 449);
      expect(posted.slice(before).filter((m) => (m as { type: string }).type === 'dragEnd')).toEqual([
        { type: 'dragEnd' }, { type: 'dragEnd' }, { type: 'dragEnd' }, { type: 'dragEnd' },
      ]);
    });

    it('draws a move within one tree as a line on the edge the row will sit at, under an open row\'s whole group', () => {
      const { win } = load();
      sendState(win, diagramsAndTables());
      fire(win, rowEl(win, 'diagrams:bronze')!, 'dragstart');
      fire(win, rowEl(win, 'diagrams:gold')!, 'dragover');
      // Bronze moves below Gold: the line sits under Gold's last row.
      expect(rowEl(win, 'diagrams:gold/sales')!.classList.contains('is-drop-after')).toBe(true);
      expect(rowEl(win, 'diagrams:gold')!.classList.contains('is-drop-after')).toBe(false);
      fire(win, rowEl(win, 'diagrams:bronze')!, 'dragend');
      fire(win, rowEl(win, 'diagrams:gold')!, 'dragstart');
      fire(win, rowEl(win, 'diagrams:bronze')!, 'dragover');
      expect(rowEl(win, 'diagrams:bronze')!.classList.contains('is-drop-before')).toBe(true);
      // A row is no target for itself.
      expect(fire(win, rowEl(win, 'diagrams:gold')!, 'dragover').defaultPrevented).toBe(false);
    });
  });

  it('names a dotted theme colour the way VS Code does (only the first dot becomes a dash)', () => {
    const { win } = load();
    sendState(win, sections([row('tables:gold', 'Gold', { icon: { kind: 'theme', id: 'folder', color: 'erdStudio.layer.gold' } })]));
    const holder = rowEl(win, 'tables:gold')!.querySelector<HTMLElement>('.gs-row__icon')!;
    expect(holder.getAttribute('style')).toContain('var(--vscode-erdStudio-layer\\.gold)');
  });
});

// ---------------------------------------------------------------------------
// Selection, Collapse All, double-click, reveal and keyboard
// ---------------------------------------------------------------------------

/** A Table Library that selects many (as the host marks it), and a single-select Diagrams section. */
function library(extra: Partial<GlassSection> = {}): GlassSection[] {
  const table = (id: string, label: string) => row(id, label, { drag: 'tables' });
  return [
    {
      key: 'diagrams', title: 'Diagrams', visible: true, defaultCollapsed: false, collapseAll: true,
      actions: { navigation: [], groups: [] }, welcome: [],
      nodes: [row('diagrams:sales', 'sales'), row('diagrams:finance', 'finance')],
    },
    {
      key: 'tables', title: 'Table Library', visible: true, defaultCollapsed: false, multiSelect: true, collapseAll: true,
      actions: { navigation: [], groups: [[{ index: 2, menu: 'view/title', title: 'Organise' }]] }, welcome: [],
      nodes: [
        row('tables:gold', 'Gold', { collapsible: 2, hasCommand: false, inline: undefined, children: [
          table('tables:a', 'dim_customer'), table('tables:b', 'dim_date'), table('tables:c', 'fct_order'),
        ] }),
        row('tables:silver', 'Silver', { collapsible: 1, hasCommand: false, inline: undefined, children: [table('tables:d', 'customer')] }),
      ],
      ...extra,
    },
  ];
}

function click(win: Win, el: Element, init: MouseEventInit = {}): void {
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...init }));
}

function key(win: Win, el: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
}

const selectedIds = (win: Win): string[] => [...win.document.querySelectorAll<HTMLElement>('.gs-row[aria-selected="true"]')].map((r) => r.dataset.id!);
const focusedId = (win: Win): string | undefined => (win.document.activeElement as HTMLElement | null)?.dataset?.id;
const lastPost = (posted: unknown[]) => posted[posted.length - 1];
const openMenuWith = (win: Win, id: string, titles: string[]) => {
  win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'itemMenu', section: id.split(':')[0], id, groups: [titles.map((title, i) => ({ index: 30 + i, menu: 'view/item/context', title }))] } }));
};

describe('selecting several rows (a section the host marks multiSelect)', () => {
  it('marks only the multi-select tree aria-multiselectable, and every row aria-selected true or false', () => {
    const { win } = load();
    sendState(win, library());
    const trees = [...win.document.querySelectorAll<HTMLElement>('.gs-tree')];
    expect(trees.map((t) => [t.dataset.section, t.getAttribute('aria-multiselectable')])).toEqual([['diagrams', null], ['tables', 'true']]);
    expect([...win.document.querySelectorAll('.gs-row[data-id]')].every((r) => r.getAttribute('aria-selected') === 'false')).toBe(true);
  });

  it('Ctrl-click toggles a row, Shift-click selects the range from the anchor; neither runs the row', () => {
    const { win, posted } = load();
    sendState(win, library());
    click(win, rowEl(win, 'tables:a')!);
    expect(lastPost(posted)).toEqual({ type: 'activate', section: 'tables', id: 'tables:a' });
    const before = posted.length;
    click(win, rowEl(win, 'tables:c')!, { ctrlKey: true });
    expect(selectedIds(win)).toEqual(['tables:a', 'tables:c']);
    expect(win.document.querySelector('.gs-tree[data-section="tables"]')!.classList.contains('gs-tree--many')).toBe(true);
    click(win, rowEl(win, 'tables:a')!, { ctrlKey: true });
    expect(selectedIds(win)).toEqual(['tables:c']);
    // The anchor is the last Ctrl-clicked row (a, though it left the selection): Shift-click on c selects a..c.
    click(win, rowEl(win, 'tables:c')!, { shiftKey: true });
    expect(selectedIds(win)).toEqual(['tables:a', 'tables:b', 'tables:c']);
    // Ctrl+Shift-click adds the range from the anchor (b, now out) to what is selected.
    click(win, rowEl(win, 'tables:b')!, { ctrlKey: true });
    expect(selectedIds(win)).toEqual(['tables:a', 'tables:c']);
    click(win, rowEl(win, 'tables:silver')!, { ctrlKey: true, shiftKey: true });
    expect(selectedIds(win)).toEqual(['tables:a', 'tables:b', 'tables:c', 'tables:silver']);
    expect(focusedId(win)).toBe('tables:silver');
    expect(posted.slice(before)).toEqual([]);
    // A plain click collapses the selection to the row and runs it.
    click(win, rowEl(win, 'tables:b')!);
    expect(selectedIds(win)).toEqual(['tables:b']);
    expect(lastPost(posted)).toEqual({ type: 'activate', section: 'tables', id: 'tables:b' });
  });

  it('keeps single selection in a section that does not select many: a modifier click selects the row and runs nothing', () => {
    const { win, posted } = load();
    sendState(win, library());
    click(win, rowEl(win, 'diagrams:sales')!, { ctrlKey: true });
    click(win, rowEl(win, 'diagrams:finance')!, { shiftKey: true });
    expect(selectedIds(win)).toEqual(['diagrams:finance']);
    // Nothing ran: the page only said which sections it draws open.
    expect(posted.filter((m) => (m as { type: string }).type !== 'sectionsShown')).toEqual([{ type: 'ready' }]);
    // Selecting in another section leaves this one.
    click(win, rowEl(win, 'tables:a')!, { ctrlKey: true });
    expect(selectedIds(win)).toEqual(['tables:a']);
  });

  it('extends with Shift+arrows and Shift+Home/End, selects all with Ctrl+A, and Escape shrinks to the focused row', () => {
    const { win } = load();
    sendState(win, library());
    click(win, rowEl(win, 'tables:a')!);
    rowEl(win, 'tables:a')!.focus();
    key(win, rowEl(win, 'tables:a')!, 'ArrowDown', { shiftKey: true });
    key(win, rowEl(win, 'tables:b')!, 'ArrowDown', { shiftKey: true });
    expect(selectedIds(win)).toEqual(['tables:a', 'tables:b', 'tables:c']);
    expect(focusedId(win)).toBe('tables:c');
    key(win, rowEl(win, 'tables:c')!, 'Home', { shiftKey: true });
    expect(selectedIds(win)).toEqual(['tables:gold', 'tables:a']);
    key(win, rowEl(win, 'tables:gold')!, 'End', { shiftKey: true });
    expect(selectedIds(win)).toEqual(['tables:a', 'tables:b', 'tables:c', 'tables:silver']);
    // Shift+Down on the last row stays in the tree (no jump to the next header).
    key(win, rowEl(win, 'tables:silver')!, 'ArrowDown', { shiftKey: true });
    expect(focusedId(win)).toBe('tables:silver');
    // Ctrl+A: every row the section shows (Silver's child is folded away), default prevented.
    expect(key(win, rowEl(win, 'tables:silver')!, 'a', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(selectedIds(win)).toEqual(['tables:gold', 'tables:a', 'tables:b', 'tables:c', 'tables:silver']);
    expect(rowEl(win, 'tables:a')!.getAttribute('aria-selected')).toBe('true');
    expect(key(win, rowEl(win, 'tables:silver')!, 'Escape').defaultPrevented).toBe(true);
    expect(selectedIds(win)).toEqual(['tables:silver']);
  });

  it('runs a row action on the whole selection when the row is in it, else on the row alone (which becomes the selection)', () => {
    const { win, posted } = load();
    sendState(win, library());
    click(win, rowEl(win, 'tables:c')!);
    click(win, rowEl(win, 'tables:a')!, { ctrlKey: true });
    // Right-click on a selected row: the selection stays, and the menu's entry carries it, in tree order.
    rowEl(win, 'tables:c')!.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 10 }));
    expect(selectedIds(win)).toEqual(['tables:a', 'tables:c']);
    expect(lastPost(posted)).toEqual({ type: 'itemMenu', section: 'tables', id: 'tables:c' });
    openMenuWith(win, 'tables:c', ['Delete Table']);
    win.document.querySelector<HTMLButtonElement>('.gs-menu__item')!.click();
    expect(lastPost(posted)).toEqual({ type: 'invoke', section: 'tables', id: 'tables:c', menu: 'view/item/context', index: 30, selection: ['tables:a', 'tables:c'] });
    // The hover button of a selected row: the same.
    rowEl(win, 'tables:a')!.querySelector<HTMLButtonElement>('[data-act="inline"]')!.click();
    expect(lastPost(posted)).toEqual({ type: 'invoke', section: 'tables', id: 'tables:a', menu: 'view/item/context', index: 3, selection: ['tables:a', 'tables:c'] });
    // A row outside the selection becomes the selection.
    rowEl(win, 'tables:b')!.querySelector<HTMLButtonElement>('[data-act="inline"]')!.click();
    expect(selectedIds(win)).toEqual(['tables:b']);
    expect(lastPost(posted)).toEqual({ type: 'invoke', section: 'tables', id: 'tables:b', menu: 'view/item/context', index: 3, selection: ['tables:b'] });
    // A single-select section sends no selection.
    rowEl(win, 'diagrams:sales')!.querySelector<HTMLButtonElement>('[data-act="inline"]')!.click();
    expect(lastPost(posted)).toEqual({ type: 'invoke', section: 'diagrams', id: 'diagrams:sales', menu: 'view/item/context', index: 3 });
  });

  it('drags the whole selection (rows of the drag\'s kind), and the drag picture counts the tables it carries', () => {
    const { win, posted } = load();
    sendState(win, library());
    click(win, rowEl(win, 'tables:a')!);
    click(win, rowEl(win, 'tables:c')!, { shiftKey: true });
    click(win, rowEl(win, 'tables:gold')!, { ctrlKey: true });
    const start = fire(win, rowEl(win, 'tables:b')!, 'dragstart');
    // Gold has no drag kind here: it is left out.
    expect(lastPost(posted)).toEqual({ type: 'dragStart', section: 'tables', ids: ['tables:a', 'tables:b', 'tables:c'] });
    // Tables, not rows: what the canvas's "Drop to add 3 tables" says.
    expect(start.dataTransfer.image).toEqual({ text: '3 tables', className: 'gs-dragpill gs-dragpill--many' });
    expect([...win.document.querySelectorAll<HTMLElement>('.gs-row.is-dragging')].map((r) => r.dataset.id)).toEqual(['tables:a', 'tables:b', 'tables:c']);
    fire(win, rowEl(win, 'tables:b')!, 'dragend');
    // An unselected row drags alone, with its own label, and becomes the selection.
    click(win, rowEl(win, 'tables:a')!, { ctrlKey: true });
    const alone = fire(win, rowEl(win, 'tables:a')!, 'dragstart');
    expect(alone.dataTransfer.image).toEqual({ text: 'dim_customer', className: 'gs-dragpill' });
    expect(lastPost(posted)).toEqual({ type: 'dragStart', section: 'tables', ids: ['tables:a'] });
    expect(selectedIds(win)).toEqual(['tables:a']);
  });

  it('keeps the selected rows that are still listed across a new state, and persists the selection', () => {
    const { win, saved } = load();
    sendState(win, library());
    click(win, rowEl(win, 'tables:a')!);
    click(win, rowEl(win, 'tables:c')!, { shiftKey: true });
    expect((saved.state as { selection: unknown }).selection).toEqual({ section: 'tables', ids: ['tables:a', 'tables:b', 'tables:c'], anchor: 'tables:a' });
    // b is gone (deleted elsewhere): a and c stay selected.
    const next = library();
    next[1].nodes[0].children = next[1].nodes[0].children!.filter((n) => n.id !== 'tables:b');
    sendState(win, next);
    expect(selectedIds(win)).toEqual(['tables:a', 'tables:c']);
    expect((saved.state as { selection: { ids: string[] } }).selection.ids).toEqual(['tables:a', 'tables:c']);
    // A reloaded page draws the saved selection.
    const again = load(saved.state);
    sendState(again.win, next);
    expect(selectedIds(again.win)).toEqual(['tables:a', 'tables:c']);
  });

  it('reads a selection saved by an earlier page ({ section, id })', () => {
    const { win } = load({ selected: { section: 'tables', id: 'tables:b' } });
    sendState(win, library());
    expect(selectedIds(win)).toEqual(['tables:b']);
  });

  it('drops selected rows a fold hides', () => {
    const { win } = load();
    sendState(win, library());
    click(win, rowEl(win, 'tables:a')!);
    click(win, rowEl(win, 'tables:silver')!, { ctrlKey: true });
    click(win, rowEl(win, 'tables:gold')!.querySelector('.gs-row__twistie')!);
    // A plain twistie click selects its row, then folds it: a is out of sight and out of the selection.
    expect(selectedIds(win)).toEqual(['tables:gold']);
    click(win, rowEl(win, 'tables:gold')!.querySelector('.gs-row__twistie')!);
    click(win, rowEl(win, 'tables:a')!, { ctrlKey: true });
    click(win, rowEl(win, 'tables:gold')!.querySelector('.gs-row__twistie')!, { ctrlKey: true });
    // A modifier twistie click folds without touching the selection first; the hidden row still leaves it.
    expect(selectedIds(win)).toEqual(['tables:gold']);
  });
});

describe('the drag picture of several rows', () => {
  /** A Table Library whose rows carry the host's table counts: a schema of 3, its tables, another schema of 2 (folded). */
  function counted(): GlassSection[] {
    const t = (id: string, label: string) => row(id, label, { drag: 'tables', dragCount: 1 });
    return [{
      key: 'tables', title: 'Table Library', visible: true, defaultCollapsed: false, multiSelect: true,
      actions: { navigation: [], groups: [] }, welcome: [],
      nodes: [
        row('tables:sales', 'sales', { collapsible: 2, hasCommand: false, inline: undefined, drag: 'tables', dragCount: 3, children: [
          t('tables:a', 'dim_customer'), t('tables:b', 'dim_date'), t('tables:c', 'fct_order'),
        ] }),
        row('tables:crm', 'crm', { collapsible: 1, hasCommand: false, inline: undefined, drag: 'tables', dragCount: 2, children: [t('tables:d', 'x'), t('tables:e', 'y')] }),
        row('tables:dup', 'dim_customer', { drag: 'tables', dragCount: 0 }),
      ],
    }];
  }
  const dragOf = (win: Win, id: string) => fire(win, rowEl(win, id)!, 'dragstart').dataTransfer.image;

  it('counts a schema\'s tables, a table under a dragged schema once, and a duplicate that is ignored not at all', () => {
    const { win } = load();
    sendState(win, counted());
    // Ctrl-clicks only select (a plain click on a schema row would fold it).
    click(win, rowEl(win, 'tables:sales')!, { ctrlKey: true });
    click(win, rowEl(win, 'tables:a')!, { ctrlKey: true });
    click(win, rowEl(win, 'tables:crm')!, { ctrlKey: true });
    click(win, rowEl(win, 'tables:dup')!, { ctrlKey: true });
    expect(dragOf(win, 'tables:sales')).toEqual({ text: '5 tables', className: 'gs-dragpill gs-dragpill--many' });
  });

  it('says "1 table" for several rows that carry one, and keeps a single row\'s own label', () => {
    const { win } = load();
    sendState(win, counted());
    click(win, rowEl(win, 'tables:a')!);
    click(win, rowEl(win, 'tables:dup')!, { ctrlKey: true });
    expect(dragOf(win, 'tables:a')).toEqual({ text: '1 table', className: 'gs-dragpill gs-dragpill--many' });
    fire(win, rowEl(win, 'tables:a')!, 'dragend');
    // One row alone: its own picture, as before (a schema too).
    click(win, rowEl(win, 'tables:dup')!);
    expect(dragOf(win, 'tables:sales')).toEqual({ text: 'sales', className: 'gs-dragpill' });
  });

  it('never says more tables than one drop adds (the host\'s limit)', () => {
    const { win } = load();
    const state = counted();
    state[0].nodes[0].dragCount = 150;
    state[0].nodes[1].dragCount = 150;
    sendState(win, state);
    click(win, rowEl(win, 'tables:sales')!, { ctrlKey: true });
    click(win, rowEl(win, 'tables:crm')!, { ctrlKey: true });
    expect(dragOf(win, 'tables:sales').text).toBe('200 tables');
  });
});

describe('Collapse All', () => {
  const groupsOf = (win: Win) => [...win.document.querySelectorAll('.gs-menu > *')].map((e) => (e.classList.contains('gs-menu__sep') ? '|' : e.textContent?.trim()));
  const headerButtons = (win: Win, key: string) => [...win.document.querySelectorAll<HTMLElement>(`.gs-section[data-key="${key}"] .gs-section__actions > button`)]
    .map((b) => b.getAttribute('data-act') === 'collapse-all' ? 'Collapse All' : b.getAttribute('data-act') === 'title-more' ? '…' : b.title);

  it('is a header button after the + and before the …, folds every row of the section (not the card), and sends nothing', () => {
    const { win, posted, saved } = load();
    const state = library({
      actions: { navigation: [{ index: 9, menu: 'view/title', title: 'New…', icon: 'add', submenu: [[{ index: 4, menu: 'view/title', title: 'New Table…' }]] }], groups: [[{ index: 2, menu: 'view/title', title: 'Organise' }]] },
    });
    state[1].nodes[1].collapsible = 2;
    sendState(win, state);
    expect(headerButtons(win, 'tables')).toEqual(['New', 'Collapse All', '…']);
    const button = win.document.querySelector<HTMLButtonElement>('.gs-section[data-key="tables"] [data-act="collapse-all"]')!;
    expect(button.getAttribute('aria-label')).toBe('Table Library: collapse all');
    // It left the … menu.
    win.document.querySelector<HTMLButtonElement>('.gs-section[data-key="tables"] [data-act="title-more"]')!.click();
    expect(groupsOf(win)).toEqual(['Table Library', 'Organise']);
    win.document.querySelector<HTMLElement>('.gs-menu__item')!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const before = posted.length;
    win.document.querySelector<HTMLButtonElement>('.gs-section[data-key="tables"] [data-act="collapse-all"]')!.click();
    expect(posted.slice(before)).toEqual([]);
    expect(rowEl(win, 'tables:gold')!.getAttribute('aria-expanded')).toBe('false');
    expect(rowEl(win, 'tables:silver')!.getAttribute('aria-expanded')).toBe('false');
    expect(rowEl(win, 'tables:a')).toBeUndefined();
    expect(win.document.querySelector('.gs-section[data-key="tables"]')!.classList.contains('gs-section--collapsed')).toBe(false);
    // Persisted as manual folding is: a default-open row is stored folded, a default-folded one is forgotten.
    const expanded = (saved.state as { expanded: Record<string, boolean> }).expanded;
    expect(expanded['tables\u0000tables:gold']).toBe(false);
    expect(expanded['tables\u0000tables:silver']).toBe(false);
  });

  it('takes the first slot in a section with no +, needs no … of its own, and is not drawn without the flag', () => {
    const { win } = load();
    sendState(win, library());
    // Diagrams here has no title actions at all: Collapse All alone, no empty ….
    expect(headerButtons(win, 'diagrams')).toEqual(['Collapse All']);
    // A non-add icon (a Clear Filter) comes after it.
    const withClear = load();
    sendState(withClear.win, library({ actions: { navigation: [{ index: 5, menu: 'view/title', title: 'Clear Filter', icon: 'clear-all' }], groups: [] } }));
    expect(headerButtons(withClear.win, 'tables')).toEqual(['Collapse All', 'Clear Filter']);
    const plain = load();
    sendState(plain.win, sections(base));
    expect(plain.win.document.querySelector('[data-act="collapse-all"]')).toBeNull();
    plain.win.document.querySelector<HTMLButtonElement>('[data-act="title-more"]')!.click();
    expect(plain.win.document.querySelector('.gs-menu')!.textContent).not.toContain('Collapse All');
  });

  it('folds the search results while searching (typing again opens them to the matches), and the rows behind the search too', () => {
    const { win } = load();
    sendState(win, library());
    const input = win.document.querySelector<HTMLInputElement>('.gs-search__input')!;
    input.value = 'dim';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    // The search renders on the next frame.
    return new Promise<void>((resolve) => win.requestAnimationFrame(() => {
      expect(rowEl(win, 'tables:a')).toBeDefined();
      win.document.querySelector<HTMLButtonElement>('.gs-section[data-key="tables"] [data-act="collapse-all"]')!.click();
      expect(rowEl(win, 'tables:a')).toBeUndefined();
      expect(rowEl(win, 'tables:gold')!.getAttribute('aria-expanded')).toBe('false');
      input.value = 'dim_';
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      win.requestAnimationFrame(() => {
        expect(rowEl(win, 'tables:a')).toBeDefined();
        // Cleared, the tree behind the search is folded as well.
        input.value = '';
        input.dispatchEvent(new win.Event('input', { bubbles: true }));
        win.requestAnimationFrame(() => {
          expect(rowEl(win, 'tables:gold')!.getAttribute('aria-expanded')).toBe('false');
          resolve();
        });
      });
    }));
  });

  it('used from the keyboard, leaves focus on its own button; the … menu still hands focus back to the …', () => {
    const { win } = load();
    sendState(win, library());
    const button = () => win.document.querySelector<HTMLButtonElement>('.gs-section[data-key="tables"] [data-act="collapse-all"]')!;
    // Enter on the button (a click): the rows fold, the render may redraw the header, focus stays on the button.
    button().focus();
    button().click();
    expect(rowEl(win, 'tables:a')).toBeUndefined();
    expect(win.document.activeElement === button()).toBe(true);
    // Escape in the … menu: back on the ….
    const more = win.document.querySelector<HTMLButtonElement>('.gs-section[data-key="tables"] [data-act="title-more"]')!;
    more.focus();
    more.click();
    win.document.querySelector<HTMLElement>('.gs-menu__item')!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(win.document.querySelector('.gs-menu')).toBeNull();
    expect(win.document.activeElement === more).toBe(true);
  });

  it('closes a header menu whose … button a new state took away onto the section\'s header, never the page', () => {
    const { win } = load();
    sendState(win, sections(base));
    win.document.querySelector<HTMLButtonElement>('.gs-section[data-key="tables"] [data-act="title-more"]')!.click();
    expect(win.document.querySelector('.gs-menu')).not.toBeNull();
    // The view's … entries are gone (their when no longer holds), and the section has no Collapse All.
    sendState(win, sections(base).map((s) => ({ ...s, actions: { navigation: s.actions.navigation, groups: [] } })));
    expect(win.document.querySelector('.gs-section[data-key="tables"] [data-act="title-more"]')).toBeNull();
    win.document.querySelector<HTMLElement>('.gs-menu__item')!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(win.document.activeElement?.id).toBe('gs-head-tables');
  });

  it('runs from the keyboard: Ctrl+Left on a row folds the section, hands focus to the row\'s top-level row, and says so', async () => {
    const { win } = load();
    sendState(win, library());
    rowEl(win, 'tables:b')!.focus();
    expect(key(win, rowEl(win, 'tables:b')!, 'ArrowLeft', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(rowEl(win, 'tables:b')).toBeUndefined();
    expect(focusedId(win)).toBe('tables:gold');
    await new Promise((r) => setTimeout(r, 60));
    expect(win.document.querySelector('.gs-live')!.textContent).toBe('Table Library: all rows collapsed');
  });
});

describe('double-click (as a VS Code tree)', () => {
  const dbl = (win: Win, el: Element) => {
    click(win, el, { detail: 1 });
    click(win, el, { detail: 2 });
    el.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
  };

  it('runs a row\'s command once, not once per click', () => {
    const { win, posted } = load();
    sendState(win, sections(base));
    dbl(win, rowEl(win, 'tables:a')!);
    expect(posted.filter((m) => (m as { type: string }).type === 'activate')).toEqual([{ type: 'activate', section: 'tables', id: 'tables:a' }]);
  });

  it('folds or unfolds a row with a command once, after running it once', () => {
    const { win, posted } = load();
    sendState(win, sections([row('tables:s', 'sales', { collapsible: 1, children: [row('tables:s/a', 'a')] })]));
    dbl(win, rowEl(win, 'tables:s')!);
    expect(posted.filter((m) => (m as { type: string }).type === 'activate')).toHaveLength(1);
    expect(rowEl(win, 'tables:s')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('leaves a row without a command opened once (never opened then shut), and the twistie toggles once', () => {
    const { win, posted } = load();
    sendState(win, sections([
      row('tables:g', 'Gold', { collapsible: 1, hasCommand: false, children: [row('tables:g/a', 'a')] }),
      row('tables:s', 'Silver', { collapsible: 1, hasCommand: false, children: [row('tables:s/a', 'b')] }),
    ]));
    dbl(win, rowEl(win, 'tables:g')!);
    expect(rowEl(win, 'tables:g')!.getAttribute('aria-expanded')).toBe('true');
    dbl(win, rowEl(win, 'tables:s')!.querySelector('.gs-row__twistie')!);
    expect(rowEl(win, 'tables:s')!.getAttribute('aria-expanded')).toBe('true');
    expect(posted.filter((m) => (m as { type: string }).type !== 'sectionsShown')).toEqual([{ type: 'ready' }]);
  });

  it('sends doubleClick (the row\'s id only) for a row the host gave one, after its click ran once', () => {
    const { win, posted } = load();
    sendState(win, sections([row('tables:a', 'dim_customer', { secondary: true }), row('tables:b', 'fct_order')]));
    dbl(win, rowEl(win, 'tables:a')!);
    const sent = posted.filter((m) => ['activate', 'doubleClick'].includes((m as { type: string }).type));
    expect(sent).toEqual([{ type: 'activate', section: 'tables', id: 'tables:a' }, { type: 'doubleClick', section: 'tables', id: 'tables:a' }]);
    // A row without one: two clicks are one activation, nothing more.
    dbl(win, rowEl(win, 'tables:b')!);
    expect(posted.filter((m) => (m as { type: string }).type === 'doubleClick')).toHaveLength(1);
    // Never from its buttons, nor with a modifier (Cmd/Ctrl- and Shift-click only select).
    rowEl(win, 'tables:a')!.querySelector('[data-act="inline"]')!.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    rowEl(win, 'tables:a')!.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2, metaKey: true }));
    rowEl(win, 'tables:a')!.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2, shiftKey: true }));
    expect(posted.filter((m) => (m as { type: string }).type === 'doubleClick')).toHaveLength(1);
  });

  it('runs a row\'s hover button once per double-click', () => {
    const { win, posted } = load();
    sendState(win, sections(base));
    const b = rowEl(win, 'tables:a')!.querySelector('[data-act="inline"]')!;
    click(win, b, { detail: 1 });
    click(win, b, { detail: 2 });
    expect(posted.filter((m) => (m as { type: string }).type === 'invoke')).toHaveLength(1);
  });
});

describe('a row whose menu only repeats its hover button (hideMore)', () => {
  it('draws the hover button and no …; right-click still asks for the menu', () => {
    const { win, posted } = load();
    sendState(win, sections([row('tables:s', 'sales', { inline: [{ index: 8, menu: 'view/item/context', title: 'New Table…', icon: 'add' }], hideMore: true }), row('tables:b', 'fct_order')]));
    const actions = (id: string) => [...rowEl(win, id)!.querySelectorAll<HTMLElement>('.gs-row__actions [data-act]')].map((b) => b.dataset.act);
    expect(actions('tables:s')).toEqual(['inline']);
    expect(actions('tables:b')).toEqual(['inline', 'row-more']);
    rowEl(win, 'tables:s')!.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 }));
    expect(lastPost(posted)).toEqual({ type: 'itemMenu', section: 'tables', id: 'tables:s' });
  });
});

describe('reveal', () => {
  it('opens the revealed row itself when the host asks (open), with its ancestors', () => {
    const { win } = load();
    const state = library();
    state[1].nodes[0].collapsible = 1;
    sendState(win, state);
    expect(rowEl(win, 'tables:a')).toBeUndefined();
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'reveal', section: 'tables', id: 'tables:silver', expand: [], focus: true, open: ['tables:silver'] } }));
    expect(rowEl(win, 'tables:silver')!.getAttribute('aria-expanded')).toBe('true');
    expect(rowEl(win, 'tables:d')).toBeDefined();
    expect(selectedIds(win)).toEqual(['tables:silver']);
    expect(focusedId(win)).toBe('tables:silver');
    // Without open, the row stays as it was.
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'reveal', section: 'tables', id: 'tables:gold', expand: [], focus: false } }));
    expect(rowEl(win, 'tables:gold')!.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('keyboard', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => row(`tables:r${i}`, `${String.fromCharCode(97 + (i % 4))}_table_${i}`));

  it('PageDown and PageUp move focus by a page, clamped to the tree', () => {
    const { win } = load();
    sendState(win, sections(many(60)));
    rowEl(win, 'tables:r0')!.focus();
    key(win, rowEl(win, 'tables:r0')!, 'PageDown');
    const after = Number(focusedId(win)!.slice('tables:r'.length));
    expect(after).toBeGreaterThan(5);
    key(win, win.document.activeElement!, 'PageDown');
    key(win, win.document.activeElement!, 'PageDown');
    key(win, win.document.activeElement!, 'PageDown');
    expect(focusedId(win)).toBe('tables:r59');
    key(win, win.document.activeElement!, 'PageUp');
    expect(focusedId(win)).toBe(`tables:r${59 - after}`);
  });

  it('jumps by type-ahead to the next row whose label starts with what was typed, and leaves / and modified keys alone', () => {
    const { win } = load();
    sendState(win, sections([row('tables:1', 'dim_customer'), row('tables:2', 'fct_order'), row('tables:3', 'dim_date'), row('tables:4', 'fct_payment')]));
    rowEl(win, 'tables:1')!.focus();
    expect(key(win, rowEl(win, 'tables:1')!, 'f').defaultPrevented).toBe(true);
    expect(focusedId(win)).toBe('tables:2');
    // One letter again cycles; a longer prefix narrows.
    key(win, win.document.activeElement!, 'f');
    expect(focusedId(win)).toBe('tables:4');
    return new Promise<void>((resolve) => setTimeout(() => {
      key(win, win.document.activeElement!, 'd');
      key(win, win.document.activeElement!, 'i');
      key(win, win.document.activeElement!, 'm');
      key(win, win.document.activeElement!, '_');
      key(win, win.document.activeElement!, 'd');
      expect(focusedId(win)).toBe('tables:3');
      // Cmd/Ctrl letters are shortcuts, not type-ahead; "/" still goes to the search field.
      expect(key(win, win.document.activeElement!, 'f', { ctrlKey: true }).defaultPrevented).toBe(true);
      expect(win.document.activeElement!.classList.contains('gs-search__input')).toBe(true);
      rowEl(win, 'tables:1')!.focus();
      key(win, rowEl(win, 'tables:1')!, '/');
      expect(win.document.activeElement!.classList.contains('gs-search__input')).toBe(true);
      resolve();
    }, 900));
  });

  it('Space folds or unfolds a row that folds (even one with a command), and activates a leaf; Enter runs the row', () => {
    const { win, posted } = load();
    sendState(win, sections([row('tables:s', 'sales', { collapsible: 1, children: [row('tables:s/a', 'a')] }), row('tables:x', 'leaf')]));
    const s = rowEl(win, 'tables:s')!;
    s.focus();
    key(win, s, ' ');
    expect(rowEl(win, 'tables:s')!.getAttribute('aria-expanded')).toBe('true');
    expect(posted.filter((m) => (m as { type: string }).type === 'activate')).toEqual([]);
    key(win, rowEl(win, 'tables:s')!, 'Enter');
    expect(lastPost(posted)).toEqual({ type: 'activate', section: 'tables', id: 'tables:s' });
    rowEl(win, 'tables:x')!.focus();
    key(win, rowEl(win, 'tables:x')!, ' ');
    expect(lastPost(posted)).toEqual({ type: 'activate', section: 'tables', id: 'tables:x' });
  });
});

// ---------------------------------------------------------------------------
// The search field drives the host's filter
// ---------------------------------------------------------------------------

describe('the search field (the host filters Diagrams, Table Library and Relationships)', () => {
  const DEBOUNCE = 40;
  const guide: GlassFilterGuide = {
    keys: [
      { key: 'layer:', meaning: 'In a layer (its id or name)', where: 'diagrams, tables, relationships' },
      { key: 'col:', meaning: 'Has a column', where: 'tables, relationships' },
      { key: 'is:unused', meaning: 'Tables on no diagram', where: 'tables' },
    ],
    syntax: 'Every word must match · "a phrase" · -word leaves out',
    debounceMs: DEBOUNCE,
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const frame = (win: Win) => new Promise<void>((r) => win.requestAnimationFrame(() => r()));

  /** Table Library (host-filtered) and Help & Feedback (matched here). */
  function filtered(tables: SerialisedNode[], extra: Partial<GlassSection> = {}): GlassSection[] {
    return [
      {
        key: 'tables', title: 'Table Library', visible: true, defaultCollapsed: false, count: '3 tables', filterable: true,
        actions: { navigation: [], groups: [] }, welcome: [], nodes: tables, ...extra,
      },
      {
        key: 'help', title: 'Help & Feedback', visible: true, defaultCollapsed: false,
        actions: { navigation: [], groups: [] }, welcome: [],
        nodes: [row('help:feedback', 'Send Feedback', { inline: undefined, hasMenu: false }), row('help:logs', 'Show Logs', { inline: undefined, hasMenu: false })],
      },
    ];
  }
  const all = [row('tables:a', 'dim_customer'), row('tables:b', 'fct_order'), row('tables:c', 'stg_events')];

  function sendFull(win: Win, s: GlassSection[], extra: { search?: string; searchSeq?: number } = { search: '' }): void {
    win.dispatchEvent(new win.MessageEvent('message', { data: JSON.parse(JSON.stringify({ type: 'state', sections: s, ...extra })) }));
  }
  function type(win: Win, text: string): HTMLInputElement {
    const input = win.document.querySelector<HTMLInputElement>('.gs-search__input')!;
    input.focus();
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    return input;
  }
  const searches = (posted: unknown[]) => posted.filter((m) => (m as { type: string }).type === 'search');
  const input = (win: Win) => win.document.querySelector<HTMLInputElement>('.gs-search__input')!;

  it('sends the text once typing pauses (debounced), numbered, and never the same text twice', async () => {
    const { win, posted } = load(undefined, guide);
    sendFull(win, filtered(all));
    type(win, 'c');
    type(win, 'cu');
    type(win, 'cust');
    expect(searches(posted)).toEqual([]);
    await wait(DEBOUNCE + 30);
    expect(searches(posted)).toEqual([{ type: 'search', text: 'cust', seq: 1 }]);
    // Typed back to the same text: nothing new to send.
    type(win, 'cus');
    type(win, 'cust');
    await wait(DEBOUNCE + 30);
    expect(searches(posted)).toHaveLength(1);
    // Clearing goes at once.
    win.document.querySelector<HTMLButtonElement>('.gs-search__clear')!.click();
    expect(searches(posted)[1]).toEqual({ type: 'search', text: '', seq: 2 });
  });

  it('never hides a host-filtered section\'s rows by its own match, and still matches Help & Feedback itself', async () => {
    const { win } = load(undefined, guide);
    sendFull(win, filtered(all));
    type(win, 'customer_id');
    await frame(win);
    // The host matches columns, owners…: until it answers, its rows stay as they are.
    expect(['tables:a', 'tables:b', 'tables:c'].every((id) => rowEl(win, id))).toBe(true);
    expect(win.document.querySelector('.gs-row[data-id="tables:a"] .gs-mark')).toBeNull();
    // Help & Feedback has no host filter: matched here, and left out when nothing matches.
    expect(win.document.querySelector('.gs-section[data-key="help"]')).toBeNull();
    expect(win.document.querySelector<HTMLElement>('.gs-noresults')!.hidden).toBe(true);
    // The answer: only what the host kept, its highlights, and its count in the header.
    sendFull(win, filtered([row('tables:a', 'dim_customer', { description: 'column customer_id' }), row('tables:b', 'fct_order', { highlights: [[0, 3]] })], {
      filter: 'customer_id', found: { shown: 2, total: 3, noun: 'tables', text: 'Filtered: "customer_id" — 2 of 3 tables' },
    }), { search: 'customer_id', searchSeq: 1 });
    expect(rowEl(win, 'tables:c')).toBeUndefined();
    expect(rowEl(win, 'tables:b')!.querySelector('.gs-mark')!.textContent).toBe('fct');
    const pill = win.document.querySelector<HTMLElement>('.gs-section[data-key="tables"] .gs-section__count')!;
    expect(pill.textContent).toBe('2 of 3');
    expect(pill.title).toBe('Filtered: "customer_id" — 2 of 3 tables');
    expect(pill.getAttribute('aria-label')).toBe('2 of 3 tables');
    // The field's own filter: no chip beside the title.
    expect(win.document.querySelector('.gs-section__filter')).toBeNull();
    // Help & Feedback, matched here.
    type(win, 'logs');
    await frame(win);
    expect(rowEl(win, 'help:logs')).toBeDefined();
    expect(rowEl(win, 'help:feedback')).toBeUndefined();
  });

  it('says when a section found nothing (in its own words, not the host\'s Clear Filter row), and when nothing anywhere did', async () => {
    const { win, posted } = load(undefined, guide);
    sendFull(win, filtered(all));
    type(win, 'owner:zz');
    await wait(DEBOUNCE + 30);
    const none = row('tables:none', 'No tables match the filter', { contextValue: 'filterNoMatch', inline: undefined });
    sendFull(win, filtered([none], {
      filter: 'owner:zz', found: { shown: 0, total: 3, noun: 'tables', text: 'No tables match "owner:zz"', warnings: ['unknown filter key "owner:"'] },
    }), { search: 'owner:zz', searchSeq: 1 });
    // Help & Feedback has no match either: one message for the whole sidebar, with the reason and a way out.
    expect(win.document.querySelector('.gs-section')).toBeNull();
    const panel = win.document.querySelector<HTMLElement>('.gs-noresults')!;
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain('Nothing matches “owner:zz”.');
    expect(panel.textContent).toContain('unknown filter key "owner:"');
    // Help & Feedback matching: the empty section says so in a line, and the host's row is not drawn.
    type(win, 'Send');
    await frame(win);
    expect(panel.hidden).toBe(true);
    const line = win.document.querySelector<HTMLElement>('.gs-section[data-key="tables"] .gs-section__none')!;
    expect(line.textContent).toContain('No tables match');
    expect(line.textContent).toContain('unknown filter key "owner:"');
    expect(rowEl(win, 'tables:none')).toBeUndefined();
    expect(win.document.querySelector('.gs-section[data-key="tables"] .gs-section__count')!.textContent).toBe('0 of 3');
    // Clear Search in the panel clears the field (and the host's filters).
    type(win, 'owner:zz');
    await frame(win);
    win.document.querySelector<HTMLButtonElement>('.gs-noresults [data-nr="clear"]')!.click();
    expect(input(win).value).toBe('');
    expect(searches(posted).pop()).toMatchObject({ type: 'search', text: '' });
  });

  it('shows in the field a filter set from the Command Palette; an empty field when the sections\' filters differ; never over the user\'s own typing', async () => {
    const { win } = load(undefined, guide);
    sendFull(win, filtered(all));
    sendFull(win, filtered(all, { filter: 'layer:gold' }), { search: 'layer:gold' });
    expect(input(win).value).toBe('layer:gold');
    // Different filters per section: the field is empty, each filtered section shows its own chip.
    sendFull(win, filtered(all, { filter: 'stg' }), {});
    expect(input(win).value).toBe('');
    expect(input(win).placeholder).toBe('Filters differ per section');
    expect(win.document.querySelector('.gs-section__filter')!.textContent).toBe('stg');
    // Typing: a state from the host with something else does not overwrite it.
    type(win, 'dim');
    sendFull(win, filtered(all), { search: 'fct' });
    expect(input(win).value).toBe('dim');
    expect(input(win).placeholder).toBe('Search');
  });

  it('shows a quiet busy ring only when the answer is slow, and plays no entrance animation for the rows a search swapped in', async () => {
    const { win } = load(undefined, guide);
    sendFull(win, filtered(all));
    const strip = win.document.querySelector('.gs-search')!;
    type(win, 'cust');
    await wait(DEBOUNCE + 30);
    expect(strip.classList.contains('is-busy')).toBe(false);
    await wait(300);
    expect(strip.classList.contains('is-busy')).toBe(true);
    // The answer: new ids (filtered rows), none of them "entering".
    sendFull(win, filtered([row('tables:a#filter1', 'dim_customer'), row('tables:x#filter1', 'cust_new')], {
      filter: 'cust', found: { shown: 2, total: 3, noun: 'tables', text: '…' },
    }), { search: 'cust', searchSeq: 1 });
    expect(strip.classList.contains('is-busy')).toBe(false);
    expect(win.document.querySelectorAll('.gs-row--enter').length).toBe(0);
    // Still reading table files (col:): the ring shows while it reads.
    sendFull(win, filtered([row('tables:a#filter1', 'dim_customer')], {
      filter: 'cust', found: { shown: 1, total: 3, noun: 'tables', text: '…', reading: true },
    }), { search: 'cust', searchSeq: 1 });
    await wait(300);
    expect(strip.classList.contains('is-busy')).toBe(true);
    // Cleared: the whole tree comes back (unfiltered ids), and none of it "enters" either.
    win.document.querySelector<HTMLButtonElement>('.gs-search__clear')!.click();
    sendFull(win, filtered(all), { search: '', searchSeq: 2 });
    expect(rowEl(win, 'tables:c')).toBeDefined();
    expect(win.document.querySelectorAll('.gs-row--enter').length).toBe(0);
    expect(strip.classList.contains('is-busy')).toBe(false);
  });

  it('lists the filter keys under the funnel, and a picked key goes into the field where the caret is', async () => {
    const { win, posted } = load(undefined, guide);
    sendFull(win, filtered(all));
    const keys = win.document.querySelector<HTMLButtonElement>('.gs-search__keys')!;
    expect(keys.hidden).toBe(false);
    keys.click();
    const menu = win.document.querySelector<HTMLElement>('.gs-menu.gs-menu--keys')!;
    expect([...menu.querySelectorAll('.gs-menu__item-label')].map((e) => e.textContent)).toEqual(['layer:', 'col:', 'is:unused']);
    expect(menu.querySelector('.gs-menu__item')!.getAttribute('title')).toBe('In a layer (its id or name) (filters diagrams, tables, relationships)');
    expect(menu.querySelector('.gs-menu__note')!.textContent).toBe(guide.syntax);
    expect(keys.getAttribute('aria-expanded')).toBe('true');
    type(win, 'cust');
    keys.click();
    [...win.document.querySelectorAll<HTMLButtonElement>('.gs-menu__item')][1].click();
    // A key that takes a value waits for it, after a space; the caret is after the colon.
    expect(input(win).value).toBe('cust col:');
    expect(input(win).selectionStart).toBe('cust col:'.length);
    expect(win.document.activeElement === input(win)).toBe(true);
    keys.click();
    [...win.document.querySelectorAll<HTMLButtonElement>('.gs-menu__item')][2].click();
    // A complete one is followed by a space.
    expect(input(win).value).toBe('cust col: is:unused ');
    await wait(DEBOUNCE + 30);
    expect(searches(posted).pop()).toMatchObject({ text: 'cust col: is:unused ' });
    // No keys from the host: no funnel.
    const plain = load();
    expect(plain.win.document.querySelector<HTMLButtonElement>('.gs-search__keys')!.hidden).toBe(true);
  });

  it('Cmd/Ctrl+F or "/" from a header or a row focuses the field; Escape there clears and goes back', async () => {
    const { win, posted } = load(undefined, guide);
    sendFull(win, filtered(all));
    const head = win.document.getElementById('gs-head-tables')!;
    head.focus();
    expect(key(win, head, 'f', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(win.document.activeElement === input(win)).toBe(true);
    // Escape with nothing typed: straight back.
    key(win, input(win), 'Escape');
    expect(win.document.activeElement === head).toBe(true);
    const r = rowEl(win, 'tables:b')!;
    r.focus();
    key(win, r, '/');
    expect(win.document.activeElement === input(win)).toBe(true);
    type(win, 'fct');
    await wait(DEBOUNCE + 30);
    expect(key(win, input(win), 'Escape').defaultPrevented).toBe(true);
    expect(input(win).value).toBe('');
    expect(searches(posted).pop()).toMatchObject({ text: '', seq: 2 });
    // Back to the row once the host's answer to the cleared field is in.
    sendFull(win, filtered(all), { search: '', searchSeq: 2 });
    expect((win.document.activeElement as HTMLElement).dataset.id).toBe('tables:b');
    // Cmd+Shift+F is VS Code's own search, never the field's.
    r.focus();
    key(win, r, 'F', { ctrlKey: true, shiftKey: true });
    expect(win.document.activeElement === r).toBe(true);
  });

  it('takes the host\'s focusSearch, but leaves a field that already has focus (and the user\'s typing) alone', () => {
    const { win } = load(undefined, guide);
    sendFull(win, filtered(all));
    rowEl(win, 'tables:a')!.focus();
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'focusSearch' } }));
    expect(win.document.activeElement === input(win)).toBe(true);
    const field = type(win, 'dim');
    field.setSelectionRange(3, 3);
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'focusSearch' } }));
    expect([field.selectionStart, field.selectionEnd]).toEqual([3, 3]);
  });

  it('Enter sends at once and focuses the first row once the answer is in', async () => {
    const { win, posted } = load(undefined, guide);
    sendFull(win, filtered(all));
    type(win, 'fct');
    key(win, input(win), 'Enter');
    expect(searches(posted)).toEqual([{ type: 'search', text: 'fct', seq: 1 }]);
    expect(win.document.activeElement === input(win)).toBe(true);
    sendFull(win, filtered([row('tables:b', 'fct_order')], { filter: 'fct', found: { shown: 1, total: 3, noun: 'tables', text: '…' } }), { search: 'fct', searchSeq: 1 });
    expect((win.document.activeElement as HTMLElement).dataset.id).toBe('tables:b');
  });

  // A container row listed under a filter has a new id (`#filterN`, so a native view opens it), and so
  // has a child named after it: the same rows as the unfiltered tree's, under other ids.
  const gold = (mark = '') => row(`tables:gold${mark}`, 'Gold', {
    collapsible: 2, hasCommand: false, inline: undefined,
    children: [row(`tables:gold${mark}/dim_store`, 'dim_store'), row(`tables:gold${mark}/fct_sale`, 'fct_sale')],
  });
  const silver = () => row('tables:silver', 'Silver', { collapsible: 2, hasCommand: false, inline: undefined, children: [row('tables:silver/stg_fin', 'stg_fin')] });
  const found = (shown: number) => ({ found: { shown, total: 3, noun: 'tables', text: '…' } });
  const active = (win: Win) => win.document.activeElement as HTMLElement;

  it('Escape from the results clears the search and keeps focus on the row, onto its unfiltered row once the rows are back', async () => {
    const { win } = load(undefined, guide);
    sendFull(win, filtered([gold(), silver()]));
    type(win, 'sal');
    key(win, input(win), 'Enter');
    sendFull(win, filtered([gold('#filter1')], { filter: 'sal', ...found(1) }), { search: 'sal', searchSeq: 1 });
    expect(active(win).dataset.id).toBe('tables:gold#filter1');
    expect(key(win, active(win), 'Escape').defaultPrevented).toBe(true);
    expect(input(win).value).toBe('');
    // The host's unfiltered answer replaces the filtered row: focus follows it, never to the page.
    sendFull(win, filtered([gold(), silver()]), { search: '', searchSeq: 2 });
    expect(active(win).dataset.id).toBe('tables:gold');
    // A child named after a filtered container follows it the same way.
    type(win, 'store');
    key(win, input(win), 'Enter');
    sendFull(win, filtered([gold('#filter2')], { filter: 'store', ...found(1) }), { search: 'store', searchSeq: 3 });
    rowEl(win, 'tables:gold#filter2/dim_store')!.focus();
    key(win, active(win), 'Escape');
    sendFull(win, filtered([gold(), silver()]), { search: '', searchSeq: 4 });
    expect(active(win).dataset.id).toBe('tables:gold/dim_store');
  });

  it('Escape in the field goes back to the row it came from once the rows are back, even one the search hid', async () => {
    const { win } = load(undefined, guide);
    sendFull(win, filtered([gold(), silver()]));
    // "/" from dim_store, a search that hides it, then Escape in the field.
    const store = rowEl(win, 'tables:gold/dim_store')!;
    store.focus();
    key(win, store, '/');
    type(win, 'fin');
    await wait(DEBOUNCE + 30);
    sendFull(win, filtered([silver()], { filter: 'fin', ...found(1) }), { search: 'fin', searchSeq: 1 });
    expect(rowEl(win, 'tables:gold/dim_store')).toBeUndefined();
    key(win, input(win), 'Escape');
    // Not the section header while the answer is on its way: the field keeps focus until then.
    expect(active(win) === input(win)).toBe(true);
    sendFull(win, filtered([gold(), silver()]), { search: '', searchSeq: 2 });
    expect(active(win).dataset.id).toBe('tables:gold/dim_store');
    // A container row it came from, listed under the filter's id meanwhile: its unfiltered row.
    const silverRow = rowEl(win, 'tables:silver')!;
    silverRow.focus();
    key(win, silverRow, '/');
    type(win, 'stg');
    await wait(DEBOUNCE + 30);
    sendFull(win, filtered([{ ...silver(), id: 'tables:silver#filter3', children: [row('tables:silver#filter3/stg_fin', 'stg_fin')] }], { filter: 'stg', ...found(1) }), { search: 'stg', searchSeq: 2 + 1 });
    key(win, input(win), 'Escape');
    sendFull(win, filtered([gold(), silver()]), { search: '', searchSeq: 4 });
    expect(active(win).dataset.id).toBe('tables:silver');
  });

  it('Down in the field waits for the answer to what was typed, as Enter does: never onto the rows it replaces', async () => {
    const { win } = load(undefined, guide);
    sendFull(win, filtered(all));
    type(win, 'fct');
    expect(key(win, input(win), 'ArrowDown').defaultPrevented).toBe(true);
    expect(active(win) === input(win)).toBe(true);
    sendFull(win, filtered([row('tables:b#filter1', 'fct_order')], { filter: 'fct', ...found(1) }), { search: 'fct', searchSeq: 1 });
    expect(active(win).dataset.id).toBe('tables:b#filter1');
    // With the answer in, Down goes straight to the first row.
    input(win).focus();
    key(win, input(win), 'ArrowDown');
    expect(active(win).dataset.id).toBe('tables:b#filter1');
  });

  it('typing after Enter keeps the caret in the field: the pending "focus the first row" is dropped', async () => {
    const { win } = load(undefined, guide);
    sendFull(win, filtered(all));
    type(win, 'di');
    key(win, input(win), 'Enter');
    type(win, 'dim');
    sendFull(win, filtered([row('tables:a', 'dim_customer')], { filter: 'di', ...found(1) }), { search: 'di', searchSeq: 1 });
    expect(active(win) === input(win)).toBe(true);
    await wait(DEBOUNCE + 30);
    sendFull(win, filtered([row('tables:a', 'dim_customer')], { filter: 'dim', ...found(1) }), { search: 'dim', searchSeq: 2 });
    expect(active(win) === input(win)).toBe(true);
    expect(input(win).value).toBe('dim');
  });

  it('a key picked from the list after "/" (the text selected) adds to the query instead of replacing it', async () => {
    const { win } = load(undefined, guide);
    sendFull(win, filtered(all));
    type(win, 'cust');
    const r = rowEl(win, 'tables:a')!;
    r.focus();
    key(win, r, '/');
    expect([input(win).selectionStart, input(win).selectionEnd]).toEqual([0, 4]);
    win.document.querySelector<HTMLButtonElement>('.gs-search__keys')!.click();
    win.document.querySelector<HTMLButtonElement>('.gs-menu__item')!.click();
    expect(input(win).value).toBe('cust layer:');
    expect(input(win).selectionStart).toBe('cust layer:'.length);
  });

  it('clearing the search plays no entrance for the Help & Feedback rows that come back', async () => {
    const { win } = load(undefined, guide);
    sendFull(win, filtered(all));
    type(win, 'feed');
    await wait(DEBOUNCE + 30);
    sendFull(win, filtered(all), { search: 'feed', searchSeq: 1 });
    await frame(win);
    expect(rowEl(win, 'help:logs')).toBeUndefined();
    win.document.querySelector<HTMLButtonElement>('.gs-search__clear')!.click();
    expect(rowEl(win, 'help:logs')).toBeDefined();
    expect(win.document.querySelectorAll('.gs-row--enter').length).toBe(0);
  });
});

describe('lifecycle: a page that comes back as it was', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const scrollCalls = (win: Win) => {
    const calls: unknown[][] = [];
    (win as unknown as { scrollTo: (...a: unknown[]) => void }).scrollTo = (...a: unknown[]) => { calls.push(a); };
    return calls;
  };
  const tall = (win: Win, height: number) => Object.defineProperty(win.document.documentElement, 'scrollHeight', { configurable: true, value: height });
  const setScrollY = (win: Win, y: number) => Object.defineProperty(win, 'scrollY', { configurable: true, value: y });

  it('rises in on a first visit, and draws a saved session without the entrance; the first draw marks the session', () => {
    const first = load();
    sendState(first.win, sections(base));
    expect(first.win.document.querySelector('.gs-sections')!.classList.contains('gs-sections--intro')).toBe(true);
    expect(first.saved.state).toMatchObject({ scrollY: 0 });

    const again = load(first.saved.state);
    sendState(again.win, sections(base));
    expect(again.win.document.querySelector('.gs-sections')!.classList.contains('gs-sections--intro')).toBe(false);
    expect(again.win.document.querySelector<HTMLElement>('.gs-section')!.style.animationDelay).toBe('');
  });

  it('saves the scroll place as the list scrolls, a few times a second at most', async () => {
    const { win, saved } = load();
    sendState(win, sections(base));
    setScrollY(win, 420);
    for (let i = 0; i < 6; i++) { win.dispatchEvent(new win.Event('scroll')); await wait(20); }
    // Not yet: the save waits out the scrolling.
    expect((saved.state as { scrollY: number }).scrollY).toBe(0);
    await wait(320);
    expect((saved.state as { scrollY: number }).scrollY).toBe(420);
  });

  it('puts the saved scroll place back once a state is drawn, waiting out a section still loading', () => {
    const { win } = load({ collapsedSections: {}, scrollY: 600 });
    const calls = scrollCalls(win);
    // Still loading ("Loading tables…" in place of rows): too short to hold the place, so it waits.
    tall(win, 900);
    const loading = sections([]).map((s) => ({ ...s, welcome: [{ entry: 0, paragraphs: [{ button: false, parts: [{ kind: 'text' as const, text: 'Loading tables…' }] }] }] }));
    sendState(win, loading);
    expect(calls).toEqual([]);
    tall(win, 2400);
    sendState(win, sections(base));
    expect(calls).toEqual([[0, 600]]);
    // Once only.
    sendState(win, sections(base, '9 tables'));
    expect(calls).toEqual([[0, 600]]);
  });

  it('comes back as far as the list now reaches when it has shrunk since', () => {
    const { win } = load({ collapsedSections: {}, scrollY: 600 });
    const calls = scrollCalls(win);
    tall(win, 1068);
    sendState(win, sections(base));
    expect(calls).toEqual([[0, 300]]);
  });

  it('gives the saved place up when the user scrolls first, or a row is revealed', () => {
    const wheel = load({ collapsedSections: {}, scrollY: 600 });
    const calls = scrollCalls(wheel.win);
    wheel.win.dispatchEvent(new wheel.win.Event('wheel'));
    tall(wheel.win, 2400);
    sendState(wheel.win, sections(base));
    expect(calls).toEqual([]);

    const revealed = load({ collapsedSections: {}, scrollY: 600 });
    const calls2 = scrollCalls(revealed.win);
    revealed.win.dispatchEvent(new revealed.win.MessageEvent('message', { data: { type: 'reveal', section: 'tables', id: 'tables:a', expand: [], focus: false } }));
    tall(revealed.win, 2400);
    sendState(revealed.win, sections(base));
    expect(calls2).toEqual([]);
  });

  it('asks the host, once, for an open row it restored that the host has not listed', () => {
    const lazy = row('tables:s', 'sales', { collapsible: 1, hasCommand: false, childrenLoaded: false });
    const { win, posted } = load({ expanded: { 'tables\u0000tables:s': true } });
    sendState(win, sections([lazy]));
    const expands = () => posted.filter((m) => (m as { type: string }).type === 'expand');
    expect(expands()).toEqual([{ type: 'expand', section: 'tables', id: 'tables:s' }]);
    // A state before the answer (another change): not asked again.
    sendState(win, sections([lazy], '1 table'));
    expect(expands()).toHaveLength(1);
    // The answer lists it.
    sendState(win, sections([{ ...lazy, childrenLoaded: true, children: [row('tables:t', 'orders')] }]));
    expect(rowEl(win, 'tables:t')).toBeDefined();
    expect(win.document.querySelector('.gs-row--loading')).toBeNull();
  });
});

describe('sections on screen (sectionsShown)', () => {
  const two = (): GlassSection[] => [
    { key: 'diagrams', title: 'Diagrams', visible: true, defaultCollapsed: false, actions: { navigation: [], groups: [] }, welcome: [], nodes: [row('diagrams:a', 'sales')] },
    ...sections(base),
  ];
  const shown = (posted: unknown[]) => posted.filter((m) => (m as { type: string }).type === 'sectionsShown');

  it('says which cards are drawn open after a draw, and again only when that changes', () => {
    const { win, posted } = load({ collapsedSections: { tables: true } });
    sendState(win, two());
    expect(shown(posted)).toEqual([{ type: 'sectionsShown', open: ['diagrams'] }]);
    sendState(win, [two()[0], { ...two()[1], count: '5 tables' }]);
    expect(shown(posted)).toHaveLength(1);
    // Unfolding the Table Library, then folding Diagrams.
    win.document.getElementById('gs-head-tables')!.click();
    expect(shown(posted).pop()).toEqual({ type: 'sectionsShown', open: ['diagrams', 'tables'] });
    // Left on a header folds it (a click on a header jsdom reports as parked would scroll instead).
    win.document.getElementById('gs-head-diagrams')!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(shown(posted).pop()).toEqual({ type: 'sectionsShown', open: ['tables'] });
  });

  it('leaves out a section the host does not show (its when is false)', () => {
    const { win, posted } = load();
    sendState(win, [{ ...two()[0], visible: false }, two()[1]]);
    expect(shown(posted)).toEqual([{ type: 'sectionsShown', open: ['tables'] }]);
  });
});

describe('showSection (the host shows a view: Show Me, a notice)', () => {
  const two = (): GlassSection[] => [
    { key: 'diagrams', title: 'Diagrams', visible: true, defaultCollapsed: false, actions: { navigation: [], groups: [] }, welcome: [], nodes: [row('diagrams:a', 'sales')] },
    ...sections(base),
  ];
  const show = (win: Win, section: string, focus = true) =>
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'showSection', section, focus } }));

  it('unfolds a folded section, scrolls to it and focuses its header', () => {
    const { win, saved } = load({ collapsedSections: { tables: true } });
    sendState(win, two());
    const calls: unknown[][] = [];
    (win as unknown as { scrollTo: (...a: unknown[]) => void }).scrollTo = (...a: unknown[]) => { calls.push(a); };
    expect(win.document.querySelector('.gs-section[data-key="tables"]')!.classList.contains('gs-section--collapsed')).toBe(true);
    show(win, 'tables');
    expect(win.document.querySelector('.gs-section[data-key="tables"]')!.classList.contains('gs-section--collapsed')).toBe(false);
    expect(win.document.activeElement?.id).toBe('gs-head-tables');
    expect((saved.state as { collapsedSections: Record<string, boolean> }).collapsedSections.tables).toBe(false);
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toMatchObject({ top: expect.any(Number) });
  });

  it('leaves focus where it was without focus, and ignores a section it does not draw', () => {
    const { win } = load();
    sendState(win, two());
    rowEl(win, 'tables:a')!.focus();
    show(win, 'diagrams', false);
    expect((win.document.activeElement as HTMLElement).dataset.id).toBe('tables:a');
    show(win, 'relationships');
    show(win, 'nonsense');
    expect((win.document.activeElement as HTMLElement).dataset.id).toBe('tables:a');
  });

  it('clears a search that hides the whole card first', async () => {
    const { win } = load();
    sendState(win, sections(base));
    const field = win.document.querySelector<HTMLInputElement>('.gs-search__input')!;
    field.value = 'zzz';
    field.dispatchEvent(new win.Event('input', { bubbles: true }));
    await new Promise<void>((r) => win.requestAnimationFrame(() => r()));
    expect(win.document.querySelector('.gs-section[data-key="tables"]')).toBeNull();
    show(win, 'tables');
    expect(field.value).toBe('');
    expect(win.document.querySelector('.gs-section[data-key="tables"]')).not.toBeNull();
  });
});

describe('progress on a section (busy)', () => {
  it('draws a progress bar on the header while busy, from the state, and takes it away after', () => {
    const { win } = load();
    sendState(win, sections(base).map((s) => ({ ...s, busy: true })));
    const card = win.document.querySelector('.gs-section[data-key="tables"]')!;
    const bar = card.querySelector('.gs-section__header .gs-section__progress')!;
    expect(bar).not.toBeNull();
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-label')).toBe('Table Library: working…');
    expect(card.getAttribute('aria-busy')).toBe('true');
    // A new state that still is busy keeps the same bar (its animation is not restarted).
    sendState(win, sections(base, '3 tables').map((s) => ({ ...s, busy: true })));
    expect(card.querySelector('.gs-section__progress') === bar).toBe(true);
    sendState(win, sections(base));
    expect(card.querySelector('.gs-section__progress')).toBeNull();
    expect(card.hasAttribute('aria-busy')).toBe(false);
  });

  it('keeps the bar still under reduced motion (the CSS)', () => {
    const html = buildGlassSidebarHtml({ cspSource: 'x', nonce: 'n', tokensCssUri: 'about:blank' });
    const reduced = [...html.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
    expect(reduced).toMatch(/\.gs-section__progress::before \{[^}]*animation: gs-breathe/);
    expect(reduced).not.toMatch(/gs-progress /);
  });
});

describe('the empty project: Import Your Data Model… first', () => {
  // The real package.json's empty-state content, resolved as the host does (GlassSidebarProvider.snapshot).
  const contributes = (JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { contributes: Contributions }).contributes;
  const index = new ContributionIndex(contributes);
  const welcomeFor = (viewId: string, keys: Record<string, unknown>) => index
    .welcome(viewId, (k) => (k === 'workspaceFolderCount' ? 1 : keys[k]))
    .map(({ index: entry, contents }) => ({ entry, paragraphs: parseWelcomeContents(contents).paragraphs }));
  const EMPTY = { 'erdStudio.hasProject': true, 'erdStudio.storage': 'dbml', 'erdStudio.diagramsLoading': false, 'erdStudio.startIntent': 'blank' };
  const empty = (keys: Record<string, unknown>): GlassSection[] => [
    { key: 'diagrams', title: 'Diagrams', visible: true, defaultCollapsed: false, actions: { navigation: [], groups: [] }, welcome: welcomeFor('erdStudio.domainTree', keys), nodes: [] },
    { key: 'tables', title: 'Table Library', visible: true, defaultCollapsed: false, actions: { navigation: [], groups: [] }, welcome: welcomeFor('erdStudio.modelLibrary', keys), nodes: [] },
  ];

  it('draws one primary button, Import Your Data Model…, at the top of the Diagrams card, with New Diagram… a quiet link under it', () => {
    const { win, posted } = load();
    sendState(win, empty(EMPTY));
    const diagrams = win.document.querySelector('[data-section="diagrams"]') ?? win.document.querySelectorAll('.gs-section')[0];
    const welcome = diagrams!.querySelector('.gs-welcome')!;
    // In order: the glyph, the title, one line, the primary button, the link.
    expect([...welcome.children].map((c) => c.className)).toEqual(['gs-welcome__glyph gs-welcome__glyph--diagrams', 'gs-welcome__lead', '', 'gs-button gs-button--primary', '']);
    expect(welcome.querySelector('.gs-welcome__lead')?.textContent).toBe('No diagrams or tables yet.');
    const primary = win.document.querySelectorAll('.gs-button--primary');
    expect(primary).toHaveLength(1);
    expect(primary[0].textContent).toBe('Import Your Data Model…');
    expect(welcome.querySelector('.gs-link')?.textContent).toBe('New Diagram…');
    // The Table Library points the same way, as a link: no second button competing with it.
    const library = win.document.querySelectorAll('.gs-welcome')[1];
    expect(library.querySelectorAll('.gs-button')).toHaveLength(0);
    expect([...library.querySelectorAll('.gs-link')].map((l) => l.textContent)).toEqual(['Import Your Data Model…']);
    // A click names the entry and the link, never a command.
    (primary[0] as HTMLElement).click();
    const sent = posted.filter((m) => (m as { type: string }).type === 'welcomeLink');
    expect(sent).toHaveLength(1);
    const { entry, link } = sent[0] as { entry: number; link: number };
    expect(parseWelcomeContents(contributes.viewsWelcome![entry].contents).links[link].href).toBe('command:erdStudio.showImportGuide?%5B%7B%22from%22%3A%22sidebar%22%7D%5D');
    expect(JSON.stringify(sent[0])).not.toContain('erdStudio.');
  });

  it('a project with tables but no diagram: its one button is New Diagram…', () => {
    const { win } = load();
    sendState(win, empty({ ...EMPTY, 'erdStudio.hasTables': true }));
    const primary = win.document.querySelectorAll('.gs-button--primary');
    expect([...primary].map((b) => b.textContent)).toEqual(['New Diagram…']);
  });
});
