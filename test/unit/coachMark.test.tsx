// @vitest-environment jsdom
/**
 * The onboarding guide's coach marks (Show Me Around): where a callout goes
 * (pure placement), the callout itself (anchoring through CSS custom
 * properties, the centred fallback, re-anchoring, the focus, Esc), phase A on
 * the draft page (webview-draft/) and phase B on the canvas (webview/).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as fs from 'fs';
import * as path from 'path';

const mockVsCode = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => mockVsCode,
  getVsCodeApi: () => mockVsCode,
}));

import { placeCallout, isUsableAnchor, pickAnchor, type GuideRect } from '../../webview/components/Guide/coachMarkPlacement';
import { CoachMark, type CoachMarkProps } from '../../webview/components/Guide/CoachMark';
import { CanvasGuide, CANVAS_GUIDE_SETTLE_MS } from '../../webview/components/Guide/CanvasGuide';
import { useEditorStore } from '../../webview/store/editorStore';
import { DraftApp } from '../../webview-draft/DraftApp';
import type { DraftToHost, DraftToWebview, DraftView } from '../../src/types/draft';
import { ReactFlowProvider } from '@xyflow/react';

const VIEWPORT = { width: 1000, height: 800 };
const SIZE = { width: 300, height: 120 };

beforeAll(() => {
  class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('placeCallout (pure)', () => {
  const anchor: GuideRect = { left: 400, top: 100, width: 200, height: 40 };

  it('goes below its anchor, centred on it, with a ring and the arrow on the anchor', () => {
    const p = placeCallout(anchor, SIZE, VIEWPORT);
    expect(p).toMatchObject({ side: 'below', x: 350, y: 152, arrow: 150 });
    expect(p.ring).toEqual({ left: 396, top: 96, width: 208, height: 48 });
  });

  it('goes above when there is no room below, and clamps into the page', () => {
    const low: GuideRect = { left: 950, top: 740, width: 40, height: 40 };
    const p = placeCallout(low, SIZE, VIEWPORT);
    expect(p.side).toBe('above');
    expect(p.x).toBe(VIEWPORT.width - SIZE.width - 8);
    expect(p.y).toBe(740 - 12 - SIZE.height);
    expect(p.arrow).toBe(970 - (VIEWPORT.width - SIZE.width - 8));
  });

  it('prefers the right for the sidebar step (pointing left at the editor\'s edge)', () => {
    const edge: GuideRect = { left: 0, top: 380, width: 1, height: 40 };
    expect(placeCallout(edge, SIZE, VIEWPORT, { prefer: 'right' })).toMatchObject({ side: 'right', x: 13, y: 340, arrow: 60 });
  });

  it('is a centred card with no anchor, an empty one, or one out of view', () => {
    for (const a of [null, undefined, { left: 10, top: 10, width: 0, height: 0 }, { left: -500, top: 10, width: 100, height: 40 }, { left: 10, top: 2000, width: 100, height: 40 }]) {
      const p = placeCallout(a, SIZE, VIEWPORT);
      expect(p).toEqual({ side: 'centre', x: 350, y: 340, arrow: 0 });
      expect(isUsableAnchor(a, VIEWPORT)).toBe(false);
    }
  });
});

function renderMark(props: Partial<CoachMarkProps> = {}) {
  const onEscape = vi.fn();
  const onSkip = vi.fn();
  const next = vi.fn();
  const utils = render(
    <CoachMark
      stepKey="s1"
      title="A table"
      text="fct_order is one of your 3 tables."
      progress="1 of 3"
      resolveAnchor={() => ({ left: 400, top: 100, width: 200, height: 40 })}
      next={{ label: 'Next', onClick: next }}
      backLabel="Back"
      skipLabel="Skip guide"
      onSkip={onSkip}
      onEscape={onEscape}
      {...props}
    />,
  );
  const mark = utils.container.querySelector('.guide-mark') as HTMLElement;
  const ring = utils.container.querySelector('.guide-ring') as HTMLElement;
  return { ...utils, mark, ring, onEscape, onSkip, next };
}

describe('the callout', () => {
  it('anchors through CSS custom properties set on the CSSOM, never a style attribute it writes', () => {
    const { mark, ring } = renderMark();
    expect(mark.getAttribute('data-side')).toBe('below');
    // jsdom lays nothing out (size 0): centred on the anchor's middle, below it.
    expect(mark.style.getPropertyValue('--guide-x')).toBe('500px');
    expect(mark.style.getPropertyValue('--guide-y')).toBe('152px');
    expect(ring.hidden).toBe(false);
    expect(ring.style.getPropertyValue('--guide-ring-w')).toBe('208px');
    expect(mark.getAttribute('role')).toBe('dialog');
    expect(screen.getByRole('dialog', { name: 'A table' })).toBe(mark);
    expect(mark.textContent).toContain('1 of 3');
  });

  it('falls back to a centred card when the anchor is missing', () => {
    const { mark, ring } = renderMark({ resolveAnchor: () => null });
    expect(mark.getAttribute('data-side')).toBe('centre');
    expect(ring.hidden).toBe(true);
  });

  it('re-anchors when the anchor moves (pan, zoom, a resize)', () => {
    let rect: GuideRect | null = { left: 400, top: 100, width: 200, height: 40 };
    const { mark } = renderMark({ resolveAnchor: () => rect });
    expect(mark.style.getPropertyValue('--guide-y')).toBe('152px');
    rect = { left: 100, top: 300, width: 100, height: 40 };
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(mark.style.getPropertyValue('--guide-x')).toBe('150px');
    expect(mark.style.getPropertyValue('--guide-y')).toBe('352px');
    rect = null;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(mark.getAttribute('data-side')).toBe('centre');
  });

  it('puts the focus on Next; Tab reaches Back, Next and Skip guide, all buttons', () => {
    renderMark({ onBack: vi.fn() });
    expect(document.activeElement?.textContent).toBe('Next');
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['Back', 'Next', 'Skip guide']);
  });

  it('draws Star on GitHub in GitHub\'s gold, with its star icon; other buttons keep the plain look', () => {
    renderMark({ buttons: [{ label: 'Star on GitHub', primary: true, star: true, onClick: vi.fn() }, { label: 'Other', onClick: vi.fn() }] });
    const star = screen.getByRole('button', { name: 'Star on GitHub' });
    expect(star.className).toContain('guide-mark__button--star');
    expect(star.className).not.toContain('guide-mark__button--primary');
    expect(star.querySelector('svg.guide-mark__star-icon[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Other' }).querySelector('svg')).toBeNull();
  });

  it('the gold comes only from theme variables, and the shine and pop only move without reduced motion', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../webview/components/Guide/CoachMark.css'), 'utf8');
    const star = css.slice(css.indexOf('.guide-mark__button--star {'), css.indexOf('.guide-mark__button:focus-visible,'));
    expect(star).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(star).toContain('var(--star-gold');
    const theme = fs.readFileSync(path.join(__dirname, '../../packages/renderer/src/styles/theme.css'), 'utf8');
    for (const v of ['--star-gold:', '--star-gold-light:', '--star-gold-dark:', '--star-gold-fg:', '--star-gold-glow:', '--star-gold-shine:']) expect(theme).toContain(v);
    const motion = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference) {\n  .guide-mark__button--star'));
    expect(motion).toContain('animation: guide-star-shine');
    expect(css.slice(0, css.indexOf('@media (prefers-reduced-motion: no-preference) {\n  .guide-mark__button--star'))).not.toMatch(/animation:/);
  });

  it('puts the focus on the step\'s primary button when it has one (Star on GitHub)', () => {
    renderMark({ buttons: [{ label: 'Star on GitHub', primary: true, onClick: vi.fn() }], next: { label: 'Done', onClick: vi.fn(), quiet: true } });
    expect(document.activeElement?.textContent).toBe('Star on GitHub');
  });

  it('a step that waits for a click elsewhere has no Next, and the callout itself takes the focus', () => {
    const { mark } = renderMark({ next: undefined });
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(document.activeElement).toBe(mark);
  });

  it('Esc skips, from the callout or the page, but not from a field or another dialog', () => {
    const { onEscape, mark } = renderMark();
    fireEvent.keyDown(mark, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(2);
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    const inside = document.createElement('button');
    other.appendChild(inside);
    document.body.appendChild(other);
    fireEvent.keyDown(inside, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onEscape).toHaveBeenCalledTimes(2);
    input.remove();
    other.remove();
  });

  it('Skip guide and Next call back', () => {
    const { onSkip, next } = renderMark();
    fireEvent.click(screen.getByRole('button', { name: 'Skip guide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Phase A on the draft page
// ---------------------------------------------------------------------------

const FIXTURES = path.resolve(__dirname, '../fixtures/draft');
const fixture = (name: string): DraftView => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as DraftView;

function sendToPage(message: DraftToWebview | Record<string, unknown>) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: message })); });
}

async function renderDraft(view: DraftView) {
  const posts: DraftToHost[] = [];
  const host = { post: (m: DraftToHost) => { posts.push(m); } };
  const layout = vi.fn(async (d: { models: Array<{ name: string }> }) => Object.fromEntries(d.models.map((m, i) => [m.name, { x: i * 400, y: 0 }])));
  const utils = render(<DraftApp host={host} layout={layout} />);
  sendToPage({ type: 'draft', view });
  await act(async () => { await Promise.resolve(); });
  return { ...utils, posts };
}

const guidePosts = (posts: DraftToHost[]) => posts.filter((p) => p.type === 'guide');

describe('phase A on the draft page', () => {
  it('shows nothing until the host runs the guide; then names the draft\'s own source and counts', async () => {
    const { container, posts } = await renderDraft(fixture('small'));
    expect(container.querySelector('.guide-mark')).toBeNull();
    sendToPage({ type: 'guide', semanticDir: '.erd-studio' });
    const mark = await screen.findByRole('dialog', { name: 'Your draft' });
    expect(mark.textContent).toContain('This is a draft of your model, drawn from 4 SQL files (PostgreSQL): 3 tables, 2 relationships. Nothing is saved yet.');
    expect(mark.textContent).toContain('1 of 3');
    expect(guidePosts(posts)).toEqual([{ type: 'guide', action: 'step', step: 'draftBanner' }]);
  });

  it('anchors each step to its control: the banner, More ways to start, then Keep as Diagram', async () => {
    const rects: Record<string, GuideRect> = {
      'draft-banner': { left: 10, top: 10, width: 600, height: 60 },
      'draft-more': { left: 700, top: 40, width: 140, height: 24 },
      'draft-keep': { left: 550, top: 40, width: 120, height: 24 },
    };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const r = rects[this.getAttribute('data-guide') ?? ''] ?? { left: 0, top: 0, width: 0, height: 0 };
      return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
    });
    const { container } = await renderDraft(fixture('small'));
    sendToPage({ type: 'guide' });
    const mark = () => container.querySelector('.guide-mark') as HTMLElement;
    await screen.findByRole('dialog');
    expect(mark().style.getPropertyValue('--guide-y')).toBe('82px');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(mark().textContent).toContain('Import… reads SQL scripts, Power BI and Fabric models, and DBML.');
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(mark().style.getPropertyValue('--guide-x')).toBe('770px');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(mark().textContent).toContain('Keep as Diagram makes it your first logical model');
    expect(mark().textContent).toContain('3 of 3');
    // It waits for the click on Keep itself: no Next.
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(mark().style.getPropertyValue('--guide-x')).toBe('610px');
  });

  it('pressing Keep (the real button) is the step: the guide steps aside while the host saves, and is back if it did not', async () => {
    const { posts, container } = await renderDraft(fixture('small'));
    sendToPage({ type: 'guide' });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const keep = container.querySelector('[data-guide="draft-keep"]') as HTMLButtonElement;
    expect(keep.textContent).toBe('Keep as Diagram');
    fireEvent.click(keep);
    expect(posts.at(-1)).toEqual({ type: 'keep' });
    sendToPage({ type: 'busy', action: 'keep' });
    expect(container.querySelector('.guide-mark')).toBeNull();
    sendToPage({ type: 'idle' });
    expect(container.querySelector('.guide-mark')?.textContent).toContain('3 of 3');
  });

  it('Skip guide (and Esc) posts skip once and ends it on this page', async () => {
    const { posts, container } = await renderDraft(fixture('small'));
    sendToPage({ type: 'guide' });
    await screen.findByRole('dialog');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(container.querySelector('.guide-mark')).toBeNull();
    expect(guidePosts(posts).at(-1)).toEqual({ type: 'guide', action: 'skip' });
    // Nothing the page sends here is a command or a URL.
    for (const p of guidePosts(posts)) expect(Object.keys(p).sort()).toEqual(p.action === 'step' ? ['action', 'step', 'type'] : ['action', 'type']);
  });

  it('the example with no folder: says so, and its last step is Open Folder…', async () => {
    await renderDraft(fixture('example-no-folder'));
    sendToPage({ type: 'guide', nothingFound: true });
    const mark = await screen.findByRole('dialog', { name: 'An example' });
    expect(mark.textContent).toContain('No folder is open, so this is an example: 2 tables, 1 relationship.');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog').textContent).toContain('Open Folder… opens the folder your data model lives in');
    expect(screen.getByRole('dialog').textContent).toContain('2 of 2');
  });
});

// ---------------------------------------------------------------------------
// Phase B on the canvas
// ---------------------------------------------------------------------------

const initialStore = useEditorStore.getState();
const tableOf = (name: string) => ({ name, columns: [] });

function setCanvas(logicalOnly = true) {
  useEditorStore.setState({
    domain: {
      domain: 'sales', layer: 'main', stage: 'logical', readOnly: false, viewConfig: { positions: {} },
      models: [tableOf('dim_customer'), tableOf('fct_order_line')],
      relationships: [{ fromModel: 'fct_order_line', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one' }],
    } as never,
    nodes: [{ id: 'dim_customer', type: 'model', position: { x: 0, y: 0 }, data: {} }, { id: 'fct_order_line', type: 'model', position: { x: 300, y: 0 }, data: {} }] as never,
    edges: [] as never,
    logicalOnly,
    pendingAutoLayout: false,
  });
}

const guideMessages = () => mockVsCode.postMessage.mock.calls.map((c) => c[0]).filter((m) => m.type === 'guide').map((m) => m.payload);

describe('phase B on the canvas', () => {
  beforeEach(() => {
    mockVsCode.postMessage.mockClear();
    useEditorStore.setState(initialStore, true);
    vi.useFakeTimers();
  });

  function renderCanvasGuide(logicalOnly = true) {
    setCanvas(logicalOnly);
    const onEnd = vi.fn();
    const utils = render(<ReactFlowProvider><CanvasGuide start={{ dbml: true, semanticDir: '.erd-studio' }} onEnd={onEnd} /></ReactFlowProvider>);
    act(() => { vi.advanceTimersByTime(CANVAS_GUIDE_SETTLE_MS + 10); });
    return { ...utils, onEnd };
  }

  it('waits for the diagram to settle, then names a real table', () => {
    setCanvas();
    render(<ReactFlowProvider><CanvasGuide start={{ dbml: true, semanticDir: '.erd-studio' }} onEnd={vi.fn()} /></ReactFlowProvider>);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => { vi.advanceTimersByTime(CANVAS_GUIDE_SETTLE_MS + 10); });
    const mark = screen.getByRole('dialog', { name: 'A table' });
    expect(mark.textContent).toContain('dim_customer is one of your 2 tables.');
    expect(guideMessages()).toEqual([{ action: 'step', step: 'canvasTable' }]);
  });

  it('walks to the relationship, the toolbar, the sidebar (revealing it), the files and the finish; no dbt step without dbt', () => {
    renderCanvasGuide();
    const titles: string[] = [];
    for (;;) {
      const dialog = screen.getByRole('dialog');
      titles.push(dialog.querySelector('.guide-mark__title')!.textContent!);
      const next = screen.queryByRole('button', { name: 'Next' });
      if (!next) break;
      fireEvent.click(next);
    }
    expect(titles).toEqual(['A table', 'A relationship', 'Add and arrange', 'The ERD Studio sidebar', 'Your files and your AI', 'One last thing']);
    expect(guideMessages()).toContainEqual({ action: 'revealSidebar' });
    expect(guideMessages().filter((m) => m.action === 'revealSidebar')).toHaveLength(1);
    expect(screen.getByRole('dialog').textContent).toContain("You're set up. If ERD Studio helps you, a star on GitHub helps other modellers find it.");
    expect(screen.getByRole('button', { name: 'Star on GitHub' }).className).toContain('guide-mark__button--star');
    expect(screen.getByRole('dialog').querySelector('.guide-mark__note')?.textContent).toBe('Show Me Around in Help & Feedback runs this guide again.');
  });

  it('shows a note only on the step that has one', () => {
    renderMark({});
    expect(screen.getByRole('dialog').querySelector('.guide-mark__note')).toBeNull();
  });

  it('in a dbt project, the Logical / Physical step is there', () => {
    renderCanvasGuide(false);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(screen.getByRole('dialog').querySelector('.guide-mark__title')!.textContent!);
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    }
    expect(seen).toContain('Logical and Physical');
  });

  it('Set Up My AI Helper and Star on GitHub post their ids only; Star ends the guide', () => {
    const { onEnd } = renderCanvasGuide();
    while (!screen.queryByRole('button', { name: 'Set Up My AI Helper' })) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set Up My AI Helper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Star on GitHub' }));
    expect(guideMessages().filter((m) => m.action !== 'step' && m.action !== 'revealSidebar')).toEqual([{ action: 'aiHelper' }, { action: 'star' }]);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('Esc skips; on the last step it finishes', () => {
    const first = renderCanvasGuide();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(guideMessages().at(-1)).toEqual({ action: 'skip' });
    expect(first.onEnd).toHaveBeenCalledTimes(1);
    first.unmount();

    mockVsCode.postMessage.mockClear();
    const second = renderCanvasGuide();
    while (screen.queryByRole('button', { name: 'Next' })) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(guideMessages().at(-1)).toEqual({ action: 'complete' });
    expect(second.onEnd).toHaveBeenCalledTimes(1);
  });

  it('in a narrow editor whose toolbar clips + Add, the toolbar step points at Layout rather than a centred card', () => {
    const rects: Record<string, GuideRect> = {
      'canvas-add': { left: VIEWPORT.width + 20, top: 22, width: 62, height: 26 },
      'canvas-layout': { left: 316, top: 22, width: 93, height: 26 },
    };
    const targets = Object.keys(rects).map((id) => {
      const el = document.createElement('div');
      el.setAttribute('data-guide', id);
      document.body.appendChild(el);
      return el;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const r = rects[this.getAttribute('data-guide') ?? ''] ?? { left: 0, top: 0, width: 0, height: 0 };
      return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
    });
    try {
      const { container } = renderCanvasGuide();
      while (screen.getByRole('dialog').querySelector('.guide-mark__title')!.textContent !== 'Add and arrange') {
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      }
      act(() => { window.dispatchEvent(new Event('resize')); });
      const mark = container.querySelector('.guide-mark') as HTMLElement;
      expect(mark.getAttribute('data-side')).toBe('below');
      const ring = container.querySelector('.guide-ring') as HTMLElement;
      expect(ring.hidden).toBe(false);
      expect(ring.style.getPropertyValue('--guide-ring-x')).toBe('312px');
    } finally {
      for (const el of targets) el.remove();
    }
  });

  it('Done finishes', () => {
    const { onEnd } = renderCanvasGuide();
    while (screen.queryByRole('button', { name: 'Next' })) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(guideMessages().at(-1)).toEqual({ action: 'complete' });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('placeCallout: never over the controls it should leave free', () => {
  it('moves clear of an area to avoid (the draft\'s banner and its buttons, the toolbar)', () => {
    // The anchor sits in a banner 120 px tall; below the anchor would cover the banner's second row.
    const banner: GuideRect = { left: 0, top: 0, width: 1000, height: 120 };
    const anchor: GuideRect = { left: 400, top: 10, width: 200, height: 20 };
    const p = placeCallout(anchor, SIZE, VIEWPORT, { avoid: [banner] });
    expect(p.side).toBe('below');
    expect(p.y).toBe(132);
    const box = { left: p.x, top: p.y, width: SIZE.width, height: SIZE.height };
    expect(box.top >= banner.top + banner.height).toBe(true);
  });

  it('takes another side when the first cannot get clear', () => {
    const anchor: GuideRect = { left: 400, top: 600, width: 200, height: 40 };
    const blocker: GuideRect = { left: 0, top: 640, width: 1000, height: 160 };
    expect(placeCallout(anchor, SIZE, VIEWPORT, { avoid: [blocker] }).side).toBe('above');
  });
});

describe('pickAnchor: the first of a step\'s targets that is in view', () => {
  const add: GuideRect = { left: 1020, top: 22, width: 62, height: 26 };   // + Add, clipped off a narrow editor
  const layout: GuideRect = { left: 316, top: 22, width: 93, height: 26 };

  it('skips a target wholly out of view for the next one in view', () => {
    expect(pickAnchor([add, layout], VIEWPORT)).toEqual(layout);
    expect(pickAnchor([layout, add], VIEWPORT)).toEqual(layout);
  });

  it('skips a target that draws nothing (absent, or zero-sized)', () => {
    expect(pickAnchor([null, { left: 5, top: 5, width: 0, height: 0 }, layout], VIEWPORT)).toEqual(layout);
  });

  it('with none in view, the first that draws anything (the callout centres itself); with none at all, null', () => {
    expect(pickAnchor([add], VIEWPORT)).toEqual(add);
    expect(placeCallout(pickAnchor([add], VIEWPORT), SIZE, VIEWPORT).side).toBe('centre');
    expect(pickAnchor([null, undefined], VIEWPORT)).toBeNull();
  });
});
