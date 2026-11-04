// @vitest-environment jsdom
/**
 * The draft preview page (`webview-draft/DraftApp.tsx`, docs/dev/draft-first.md
 * §2) per fixture: the banner text and its buttons (one primary), the
 * switcher posting `scope`, More ways to start posting `otherStart` ids, the
 * busy and notice lines, the schema panel filtering the canvas locally, the
 * details drawer rendering text only, and the layout state.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as fs from 'fs';
import * as path from 'path';

import { DraftApp } from '../../webview-draft/DraftApp';
import { getDraftHost } from '../../webview-draft/lib/draftHost';
import type { DraftToHost, DraftToWebview, DraftView } from '../../src/types/draft';
import type { DisplaySubjectArea } from '../../src/types/display';
import type { NodePosition } from '../../src/types/semantic';

const FIXTURES = path.resolve(__dirname, '../fixtures/draft');
const fixture = (name: string): DraftView => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as DraftView;

beforeAll(() => {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;
});

afterEach(cleanup);

function send(message: DraftToWebview | Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

type Layout = (display: DisplaySubjectArea) => Promise<Record<string, NodePosition>>;

function renderPage(view?: DraftView, layout?: Layout) {
  const posts: DraftToHost[] = [];
  const host = { post: (m: DraftToHost) => { posts.push(m); } };
  const lay = layout ?? vi.fn<Layout>(async (d) => Object.fromEntries(d.models.map((m, i) => [m.name, { x: i * 400, y: 0 }])));
  const utils = render(<DraftApp host={host} layout={lay} />);
  if (view) send({ type: 'draft', view });
  return { ...utils, posts, layout: lay };
}

const buttons = () => screen.getAllByRole('button');
const primaries = (container: HTMLElement) => container.querySelectorAll('.draft-button--primary');

describe('the page handshake', () => {
  it('says ready, waits with Drawing…, and ignores what is not a draft message', () => {
    const { posts } = renderPage();
    expect(posts).toEqual([{ type: 'ready' }]);
    expect(screen.getByRole('status').textContent).toBe('Drawing…');
    send({ type: 'draft', view: { id: 1 } });
    send({ type: 'runCommand' });
    expect(screen.getByRole('status').textContent).toBe('Drawing…');
  });

  it('getDraftHost posts through acquireVsCodeApi, acquired once', () => {
    const postMessage = vi.fn();
    const acquire = vi.fn(() => ({ postMessage }));
    (window as unknown as { acquireVsCodeApi: typeof acquire }).acquireVsCodeApi = acquire;
    const host = getDraftHost();
    host.post({ type: 'ready' });
    getDraftHost().post({ type: 'discard' });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls).toEqual([[{ type: 'ready' }], [{ type: 'discard' }]]);
  });
});

describe('small (a SQL find)', () => {
  it('shows the banner text, one primary Keep, the menu and Discard', () => {
    const view = fixture('small');
    const { container } = renderPage(view);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(view.banner.headline);
    expect(screen.getByText(view.banner.detail)).toBeTruthy();
    expect(container.querySelector('.draft-banner__counts')?.textContent).toBe('2 notes, 1 left out: ');
    expect(primaries(container)).toHaveLength(1);
    expect(primaries(container)[0].textContent).toBe('Keep as Diagram');
    const labels = buttons().map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Change options…', 'Show details', 'Keep as Diagram', 'More ways to start▾', 'Discard']));
    // No switcher (no scopes) and no schema panel (one schema).
    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelector('.draft-schemas')).toBeNull();
  });

  it('posts keep, then shows Saving… with every choice disabled until idle brings them back with the notice', () => {
    const { posts } = renderPage(fixture('small'));
    fireEvent.click(screen.getByRole('button', { name: 'Keep as Diagram' }));
    expect(posts.at(-1)).toEqual({ type: 'keep' });
    send({ type: 'busy', action: 'keep' });
    expect(screen.getByText('Saving…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Keep as Diagram' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Change options…' }) as HTMLButtonElement).disabled).toBe(true);
    send({ type: 'idle', notice: 'Your files changed, so the draft was redrawn. Check it and keep it again.' });
    expect(screen.queryByText('Saving…')).toBeNull();
    expect((screen.getByRole('button', { name: 'Keep as Diagram' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('Your files changed, so the draft was redrawn. Check it and keep it again.')).toBeTruthy();
  });

  it('posts changeOptions and discard', () => {
    const { posts } = renderPage(fixture('small'));
    fireEvent.click(screen.getByRole('button', { name: 'Change options…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(posts.slice(1)).toEqual([{ type: 'changeOptions' }, { type: 'discard' }]);
  });

  it('More ways to start lists the other starts and posts their ids only', () => {
    const { posts } = renderPage(fixture('small'));
    const menuButton = screen.getByRole('button', { name: /More ways to start/ });
    expect(menuButton.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(menuButton);
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['New Diagram…', 'Import…', 'Bring In Your Data Model…', 'Open an Example…']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Bring In Your Data Model…' }));
    expect(posts.at(-1)).toEqual({ type: 'otherStart', start: 'guide' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('the menu is keyboard reachable: ArrowDown opens it, arrows move, Escape closes it', () => {
    renderPage(fixture('small'));
    const menuButton = screen.getByRole('button', { name: /More ways to start/ });
    fireEvent.keyDown(menuButton, { key: 'ArrowDown' });
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: 'ArrowUp' });
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[3]);
    fireEvent.keyDown(items[3], { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(menuButton);
  });

  it('draws the stored positions without a layout', () => {
    const { layout, container } = renderPage(fixture('small'));
    expect(layout).not.toHaveBeenCalled();
    expect(container.querySelector('.draft-canvas .editor-canvas')).toBeTruthy();
    expect(container.querySelector('.editor-canvas--neutral')).toBeTruthy(); // logicalOnly
  });

  it('the details drawer renders every section as text, never as HTML, and posts detailsOpened', () => {
    const { posts, container } = renderPage(fixture('small'));
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(posts.at(-1)).toEqual({ type: 'detailsOpened' });
    const drawer = screen.getByRole('complementary', { name: 'Details' });
    expect(within(drawer).getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Tables (3)', 'Relationships (2)', 'Left out (1)', 'Notes (2)',
    ]);
    expect(within(drawer).getByText('Views, indexes and other statements are not tables.')).toBeTruthy();
    expect(within(drawer).getByText('sales.orders')).toBeTruthy();
    // The note holding markup is shown as its characters.
    expect(within(drawer).getByText('<img src=x onerror="alert(1)"> renamed to img_src')).toBeTruthy();
    expect(container.querySelector('.draft-drawer img')).toBeNull();
    expect(within(drawer).getAllByText('new')).toHaveLength(3);
    fireEvent.keyDown(drawer, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Details' })).toBeNull();
  });
});

describe('large (several schemas)', () => {
  it('opens the schema panel on the focus schema, lays out only it, and says what it shows', async () => {
    let resolveLayout: (p: Record<string, NodePosition>) => void = () => {};
    const layout = vi.fn<Layout>(() => new Promise((r) => { resolveLayout = r; }));
    const { container } = renderPage(fixture('large'), layout);
    expect(layout).toHaveBeenCalledTimes(1);
    expect(layout.mock.calls[0][0].models).toHaveLength(40);
    expect(layout.mock.calls[0][0].models.every((m) => m.schema === 'sales')).toBe(true);
    expect(screen.getAllByText('Laying out 40 tables…').length).toBeGreaterThan(0);
    const nav = screen.getByRole('navigation', { name: 'Schemas' });
    expect(within(nav).getByText('Showing sales: 40 of 80 tables')).toBeTruthy();
    const items = within(nav).getAllByRole('button').filter((b) => b.classList.contains('draft-schemas__item'));
    expect(items.map((b) => b.textContent)).toEqual(['All tables (80)', 'sales40', 'finance25', 'hr15']);
    expect(items[1].getAttribute('aria-pressed')).toBe('true');
    await act(async () => { resolveLayout({}); });
    expect(screen.queryByText('Laying out 40 tables…')).toBeNull();
    expect(container.querySelector('.draft-canvas .editor-canvas')).toBeTruthy();
  });

  it('choosing a schema filters the canvas on the page and posts nothing', async () => {
    const layout = vi.fn<Layout>(async () => ({}));
    const { posts } = renderPage(fixture('large'), layout);
    await act(async () => {});
    const before = posts.length;
    const nav = screen.getByRole('navigation', { name: 'Schemas' });
    await act(async () => { fireEvent.click(within(nav).getByRole('button', { name: 'finance, 25 tables' })); });
    expect(layout.mock.calls.at(-1)?.[0].models.map((m) => m.schema)).toEqual(Array(25).fill('finance'));
    expect(layout.mock.calls.at(-1)?.[0].relationships).toHaveLength(24);
    expect(within(nav).getByText('Showing finance: 25 of 80 tables')).toBeTruthy();
    await act(async () => { fireEvent.click(within(nav).getByRole('button', { name: 'All tables (80)' })); });
    expect(layout.mock.calls.at(-1)?.[0].models).toHaveLength(80);
    expect(within(nav).queryByText(/^Showing/)).toBeNull();
    expect(posts.slice(before)).toEqual([]);
  });

  it('the panel collapses and opens again, counting a user open as detailsOpened', async () => {
    const { posts } = renderPage(fixture('large'), vi.fn<Layout>(async () => ({})));
    await act(async () => {});
    const toggle = screen.getByRole('button', { name: 'Hide schemas' });
    fireEvent.click(toggle);
    expect(screen.queryByText('All tables (80)')).toBeNull();
    expect(posts.filter((p) => p.type === 'detailsOpened')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Show schemas' }));
    expect(screen.getByText('All tables (80)')).toBeTruthy();
    expect(posts.filter((p) => p.type === 'detailsOpened')).toHaveLength(1);
  });

  it('a failed layout draws the fallback placement and posts layoutFailed once for the draft', async () => {
    const layout = vi.fn<Layout>(async () => { throw new Error('ELK layout worker crashed'); });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { posts, container } = renderPage(fixture('large'), layout);
    await act(async () => {});
    expect(container.querySelector('.draft-canvas .editor-canvas')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Schemas' });
    await act(async () => { fireEvent.click(within(nav).getByRole('button', { name: 'hr, 15 tables' })); });
    expect(posts.filter((p) => p.type === 'layoutFailed')).toHaveLength(1);
    spy.mockRestore();
  });

  it('the drawer shows the first 200 items of a section, then Show all', () => {
    renderPage(fixture('large'), vi.fn<Layout>(async () => ({})));
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    const tables = screen.getByRole('region', { name: 'Tables' });
    expect(within(tables).getByRole('heading').textContent).toBe('Tables (80)');
    expect(within(tables).getAllByRole('listitem')).toHaveLength(200);
    fireEvent.click(within(tables).getByRole('button', { name: 'Show all (250)' }));
    expect(within(tables).getAllByRole('listitem')).toHaveLength(250);
    expect(within(tables).queryByRole('button', { name: /Show all/ })).toBeNull();
  });
});

describe('dbt (a folder switcher)', () => {
  it('shows the Folder switcher on the current folder and posts scope, then Drawing… until the next draft', async () => {
    const view = fixture('dbt');
    const { posts, container } = renderPage(view, vi.fn<Layout>(async () => ({})));
    await act(async () => {});
    const select = screen.getByLabelText('Folder') as HTMLSelectElement;
    expect(select.value).toBe('folder:marts/finance');
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'marts/finance · 12 models', 'marts/core · 8 models', 'staging · 20 models',
    ]);
    fireEvent.change(select, { target: { value: 'folder:staging' } });
    expect(posts.at(-1)).toEqual({ type: 'scope', scopeId: 'folder:staging' });
    send({ type: 'busy', action: 'scope' });
    expect(screen.getByText('Drawing…')).toBeTruthy();
    expect(select.disabled).toBe(true);
    send({ type: 'draft', view: { ...view, id: 'staging', scopes: { ...view.scopes!, current: 'folder:staging' } } });
    await act(async () => {});
    expect(screen.queryByText('Drawing…')).toBeNull();
    expect((screen.getByLabelText('Folder') as HTMLSelectElement).value).toBe('folder:staging');
    // Stage colours: dbt folders draw with them.
    expect(container.querySelector('.editor-canvas--neutral')).toBeNull();
  });

  it('lists only the starts the dbt draft offers', () => {
    renderPage(fixture('dbt'), vi.fn<Layout>(async () => ({})));
    fireEvent.click(screen.getByRole('button', { name: /More ways to start/ }));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['New Diagram…', 'Import…', 'Open an Example…']);
  });
});

describe('example with no folder open', () => {
  it('has Open Folder… as the one primary, Discard, no Keep, no menu and no Change options…', async () => {
    const { container, posts } = renderPage(fixture('example-no-folder'), vi.fn<Layout>(async () => ({})));
    await act(async () => {});
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Example: a coffee-shop star schema · 2 tables, 1 relationship · not saved');
    expect(screen.getByText('Open a folder to keep a copy of it.')).toBeTruthy();
    expect(primaries(container)).toHaveLength(1);
    expect(primaries(container)[0].textContent).toBe('Open Folder…');
    const labels = buttons().map((b) => b.textContent);
    expect(labels).not.toContain('Change options…');
    expect(labels.some((l) => /Keep/.test(l ?? ''))).toBe(false);
    expect(labels.some((l) => /More ways to start/.test(l ?? ''))).toBe(false);
    expect(labels).toContain('Discard');
    expect((screen.getByLabelText('Example') as HTMLSelectElement).value).toBe('example:coffee-shop');
    fireEvent.click(primaries(container)[0]);
    expect(posts.at(-1)).toEqual({ type: 'otherStart', start: 'openFolder' });
  });

  it('example in a folder: New Diagram… primary, Bring In Your Data Model… beside it, Keep This Example quiet, Import… in the menu', () => {
    const base = fixture('example-no-folder');
    const view: DraftView = {
      ...base,
      banner: { ...base.banner, keepLabel: 'Keep This Example', primary: 'blank', shownStarts: ['guide'] },
      otherStarts: [
        { id: 'blank', label: 'New Diagram…' },
        { id: 'guide', label: 'Bring In Your Data Model…' },
        { id: 'import', label: 'Import…' },
      ],
    };
    const { container, posts } = renderPage(view, vi.fn<Layout>(async () => ({})));
    expect(primaries(container)).toHaveLength(1);
    expect(primaries(container)[0].textContent).toBe('New Diagram…');
    const keep = screen.getByRole('button', { name: 'Keep This Example' });
    expect(keep.classList.contains('draft-button--quiet')).toBe(true);
    fireEvent.click(keep);
    expect(posts.at(-1)).toEqual({ type: 'keep' });
    fireEvent.click(screen.getByRole('button', { name: 'Bring In Your Data Model…' }));
    expect(posts.at(-1)).toEqual({ type: 'otherStart', start: 'guide' });
    fireEvent.click(screen.getByRole('button', { name: /More ways to start/ }));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Import…']);
  });
});
