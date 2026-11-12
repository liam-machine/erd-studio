/**
 * The glass sidebar's page script (html.ts), run in jsdom: a `state` the page
 * already drew changes nothing, and a changed one is patched in place, so the
 * row under a resting pointer (its element, :hover, focus, open menu) survives
 * a refresh. Rebuilding every row on every `state` replayed the hover fill and
 * fade-ins under the pointer: the "flashes non stop" bug.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

import { buildGlassSidebarHtml } from '../../src/providers/glassSidebar/html';
import type { GlassSection, SerialisedNode } from '../../src/providers/glassSidebar/protocol';

type Win = JSDOM['window'];

const open: JSDOM[] = [];

afterEach(() => {
  for (const dom of open.splice(0)) dom.window.close();
});

function load(): { win: Win; posted: unknown[] } {
  const posted: unknown[] = [];
  const html = buildGlassSidebarHtml({ cspSource: 'https://webview.test', nonce: 'bm9uY2U=', tokensCssUri: 'about:blank' });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (m: unknown) => { posted.push(m); },
        getState: () => undefined,
        setState: () => undefined,
      });
      // jsdom has no scrolling.
      (window as unknown as { scrollTo: () => void }).scrollTo = () => undefined;
    },
  });
  open.push(dom);
  return { win: dom.window, posted };
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

  it('names a dotted theme colour the way VS Code does (only the first dot becomes a dash)', () => {
    const { win } = load();
    sendState(win, sections([row('tables:gold', 'Gold', { icon: { kind: 'theme', id: 'folder', color: 'erdStudio.layer.gold' } })]));
    const holder = rowEl(win, 'tables:gold')!.querySelector<HTMLElement>('.gs-row__icon')!;
    expect(holder.getAttribute('style')).toContain('var(--vscode-erdStudio-layer\\.gold)');
  });
});
