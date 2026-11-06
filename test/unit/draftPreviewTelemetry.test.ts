/**
 * The draft preview's 2.0 telemetry events (B13, B17), against the stateful
 * vscode mock: the page saying ready (or never, while visible), its crashes,
 * its finished layout, and a tab closed while its draft was still being laid
 * out — then their mapping to keys (`draftPreviewEvents`), the built-in
 * examples left out of the layout keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { _resetMockWebviewPanels } from 'vscode';

import { DraftPreviewPanel } from '../../src/providers/DraftPreviewPanel';
import { draftPreviewEvents } from '../../src/providers/draftWiring';
import { READY_TIMEOUT_MS } from '../../src/services/readyWatch';
import type { Draft, DraftPreviewEvents, DraftView } from '../../src/types/draft';

const FIXTURES = path.resolve(__dirname, '../fixtures/draft');
const fixture = (name: string): DraftView => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as DraftView;
const draftOf = (name: string, patch: Partial<Draft> = {}): Draft => ({ ...fixture(name), keep: { writer: 'none' }, trigger: 'start', ...patch });

type MockPanel = ReturnType<typeof import('../__mocks__/vscode').createMockWebviewPanel>;
const lastPanel = (): MockPanel => {
  const all = (vscode.window as unknown as { _webviewPanels: MockPanel[] })._webviewPanels;
  return all[all.length - 1];
};
const extensionUri = vscode.Uri.file('/ext');

function events(): { [K in keyof DraftPreviewEvents]-?: ReturnType<typeof vi.fn> } {
  return {
    detailsOpened: vi.fn(),
    layoutFailed: vi.fn(),
    guide: vi.fn(),
    pageReady: vi.fn(),
    noReady: vi.fn(),
    pageError: vi.fn(),
    layoutFinished: vi.fn(),
    closedWhileLayingOut: vi.fn(),
  };
}

beforeEach(() => {
  DraftPreviewPanel.close();
  _resetMockWebviewPanels();
});

afterEach(() => {
  DraftPreviewPanel.close();
  vi.useRealTimers();
});

describe('the draft page ready watch', () => {
  it('reports the page ready', async () => {
    const ev = events();
    void DraftPreviewPanel.show(extensionUri, draftOf('large'), ev);
    await lastPanel()._simulateMessage({ type: 'ready' });
    expect(ev.pageReady).toHaveBeenCalledWith('sqlDdl', false);
    expect(ev.noReady).not.toHaveBeenCalled();
  });

  it('reports a visible page that never says ready, and not one closed first', () => {
    vi.useFakeTimers();
    const ev = events();
    void DraftPreviewPanel.show(extensionUri, draftOf('large'), ev);
    vi.advanceTimersByTime(READY_TIMEOUT_MS);
    expect(ev.noReady).toHaveBeenCalledWith('sqlDdl');

    const later = events();
    DraftPreviewPanel.close();
    void DraftPreviewPanel.show(extensionUri, draftOf('large'), later);
    lastPanel().dispose();
    vi.advanceTimersByTime(READY_TIMEOUT_MS * 2);
    expect(later.noReady).not.toHaveBeenCalled();
  });

  it('does not judge a page while it is hidden', () => {
    vi.useFakeTimers();
    const ev = events();
    void DraftPreviewPanel.show(extensionUri, draftOf('large'), ev);
    lastPanel()._simulateViewStateChange(false);
    vi.advanceTimersByTime(READY_TIMEOUT_MS * 2);
    expect(ev.noReady).not.toHaveBeenCalled();
  });
});

describe('the draft page crash and layout events', () => {
  it('passes a crash kind on', async () => {
    const ev = events();
    void DraftPreviewPanel.show(extensionUri, draftOf('large'), ev);
    await lastPanel()._simulateMessage({ type: 'pageError', kind: 'render', area: 'draft' });
    expect(ev.pageError).toHaveBeenCalledWith('sqlDdl', 'render');
  });

  it('passes a finished layout on, and then a close is no abandoned layout', async () => {
    const ev = events();
    void DraftPreviewPanel.show(extensionUri, draftOf('large'), ev);
    const panel = lastPanel();
    await panel._simulateMessage({ type: 'ready' });
    await panel._simulateMessage({ type: 'layoutFinished', ms: 6200, fitZoom: 'under30', fallback: true });
    expect(ev.layoutFinished).toHaveBeenCalledWith('sqlDdl', { ms: 6200, fitZoom: 'under30', fallback: true });
    panel.dispose();
    expect(ev.closedWhileLayingOut).not.toHaveBeenCalled();
  });

  it('reports a tab closed before its draft was laid out', async () => {
    const ev = events();
    void DraftPreviewPanel.show(extensionUri, draftOf('large'), ev);
    const panel = lastPanel();
    await panel._simulateMessage({ type: 'ready' });
    panel.dispose();
    expect(ev.closedWhileLayingOut).toHaveBeenCalledTimes(1);
    expect(ev.closedWhileLayingOut).toHaveBeenCalledWith('sqlDdl');
  });

  it('does not count a close once the layout returned, though the canvas never fitted it (a background tab)', async () => {
    const ev = events();
    const draft = draftOf('large');
    void DraftPreviewPanel.show(extensionUri, draft, ev);
    const panel = lastPanel();
    await panel._simulateMessage({ type: 'ready' });
    await panel._simulateMessage({ type: 'laidOut', id: draft.id });
    panel.dispose();
    expect(ev.closedWhileLayingOut).not.toHaveBeenCalled();
    expect(ev.layoutFinished).not.toHaveBeenCalled();
  });

  it('ignores a laidOut for another draft', async () => {
    const ev = events();
    void DraftPreviewPanel.show(extensionUri, draftOf('large'), ev);
    const panel = lastPanel();
    await panel._simulateMessage({ type: 'ready' });
    await panel._simulateMessage({ type: 'laidOut', id: 'some-earlier-draft' });
    panel.dispose();
    expect(ev.closedWhileLayingOut).toHaveBeenCalledTimes(1);
  });

  it('does not count a close when the layout failed, or there was none to run', async () => {
    const failed = events();
    void DraftPreviewPanel.show(extensionUri, draftOf('large'), failed);
    await lastPanel()._simulateMessage({ type: 'ready' });
    await lastPanel()._simulateMessage({ type: 'layoutFailed' });
    lastPanel().dispose();
    expect(failed.closedWhileLayingOut).not.toHaveBeenCalled();

    const placed = events();
    void DraftPreviewPanel.show(extensionUri, draftOf('small'), placed); // autoLayout: false
    await lastPanel()._simulateMessage({ type: 'ready' });
    lastPanel().dispose();
    expect(placed.closedWhileLayingOut).not.toHaveBeenCalled();
  });

  it('does not count a choice made while the layout runs', async () => {
    const ev = events();
    void DraftPreviewPanel.show(extensionUri, draftOf('large'), ev);
    await lastPanel()._simulateMessage({ type: 'ready' });
    await lastPanel()._simulateMessage({ type: 'discard' });
    expect(ev.closedWhileLayingOut).not.toHaveBeenCalled();
  });
});

describe('draftPreviewEvents (the keys)', () => {
  it('maps ready, never-ready and crashes for every source', () => {
    const feature = vi.fn();
    const error = vi.fn();
    const ev = draftPreviewEvents(feature, error);
    ev.pageReady?.('example', true);
    expect(feature.mock.calls.map(([k]) => k)).toEqual(['draftPageReady', 'readySlowOver10s']);
    ev.noReady?.('dbml');
    ev.pageError?.('sqlDdl', 'render');
    ev.pageError?.('sqlDdl', 'window');
    expect(error.mock.calls.map(([k]) => k)).toEqual(['webviewNoReadyDraft', 'webviewCrash', 'webviewCrashDraft', 'webviewWindowError']);
  });

  it('maps the layout keys, leaving the built-in examples out', () => {
    const feature = vi.fn();
    const ev = draftPreviewEvents(feature, vi.fn());
    ev.layoutFinished?.('example', { ms: 9000, fitZoom: 'under30' });
    ev.layoutFinished?.('exampleProject', { ms: 9000, fitZoom: 'under30' });
    ev.closedWhileLayingOut?.('example');
    expect(feature).not.toHaveBeenCalled();
    ev.layoutFinished?.('sqlDdl', { ms: 9000, fitZoom: 'under30', fallback: true });
    ev.closedWhileLayingOut?.('dbt');
    expect(feature.mock.calls.map(([k]) => k)).toEqual([
      'draftLayoutOver5s', 'draftFitZoomUnder30', 'draftLayoutFallback', 'draftClosedWhileLayingOut',
    ]);
  });
});
