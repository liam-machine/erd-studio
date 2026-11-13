// @vitest-environment jsdom
/**
 * #294 — an Auto Layout failure's toast offers Send Feedback (and Try Again
 * for a bug), through App.tsx and the store's `toastActions`:
 *
 *  - a toast with buttons stays until it is dismissed, so its buttons cannot
 *    vanish after the usual 4 seconds;
 *  - Send Feedback opens the feedback dialog filled in with the toast's words;
 *  - Try Again runs Auto Layout again (the toolbar's registered layout);
 *  - a plain store toast still dismisses itself, and a new toast drops the
 *    buttons of the one before.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const mockVsCode = vi.hoisted(() => ({
  postMessage: vi.fn(),
  getState: vi.fn(),
  setState: vi.fn(),
}));

vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => mockVsCode,
  getVsCodeApi: () => mockVsCode,
}));

import { App } from '../../webview/App';
import { useEditorStore, type ToastAction } from '../../webview/store/editorStore';
import { TOAST_AUTO_DISMISS_MS } from '../../webview/components/Toast/Toast';
import { layoutFailureNotice } from '../../webview/lib/elkLayout';
import type { DisplaySubjectArea } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

const emptySubjectArea = {
  schemaVersion: 6, domain: 'sales', layer: 'gold', stage: 'logical', description: '',
  models: [], relationships: [], viewConfig: {}, readOnly: false, positionDraggable: true,
} as unknown as DisplaySubjectArea;

function openApp() {
  render(<App />);
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'domainLoaded', payload: emptySubjectArea, welcomeDismissed: true, logicalOnly: true },
    }));
  });
}

function raise(notice: { message: string; actions: ToastAction[] }) {
  act(() => useEditorStore.getState().setToastMessage(notice.message, notice.actions));
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  mockVsCode.getState.mockReset();
  useEditorStore.setState(initialStoreState, true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Auto Layout failure toast buttons (#294)', () => {
  it('a timeout toast keeps Send Feedback on screen past the usual 4 s, and it opens the dialog filled in', () => {
    openApp();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const notice = layoutFailureNotice('timeout', true);
    raise(notice);
    act(() => { vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS * 3); });

    expect(screen.getByRole('alert').textContent).toContain('too large to arrange automatically');
    expect(screen.queryByRole('button', { name: 'Try Again' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send Feedback' }));

    const state = useEditorStore.getState();
    expect(state.toastMessage).toBeNull();
    expect(state.toastActions).toBeNull();
    expect(state.feedbackDialogOpen).toBe(true);
    expect(state.feedbackPrefill).toMatchObject({ kind: 'bug', description: expect.stringContaining(notice.message) });
  });

  it('Try Again runs Auto Layout again', () => {
    openApp();
    const layout = vi.fn();
    act(() => useEditorStore.getState().registerAutoLayout(layout));
    raise(layoutFailureNotice('worker', false));

    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(layout).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().toastMessage).toBeNull();
  });

  it('a plain store toast still dismisses itself and shows no buttons', () => {
    openApp();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    act(() => useEditorStore.getState().setToastMessage('Saved'));
    expect(screen.queryByRole('button', { name: 'Send Feedback' })).toBeNull();
    act(() => { vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS + 1); });
    expect(useEditorStore.getState().toastMessage).toBeNull();
  });

  it('a local toast drawn over it dismisses only itself, and the buttons come back', () => {
    // The persisted selection names a table that is gone: App's own toast.
    mockVsCode.getState.mockReturnValue({ selectedNode: 'ghost' });
    const notice = layoutFailureNotice('timeout', true);
    act(() => useEditorStore.getState().setToastMessage(notice.message, notice.actions));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    openApp();
    expect(screen.getByRole('alert').textContent).toContain('no longer exists');

    act(() => { vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS + 1); });
    expect(useEditorStore.getState().toastMessage).toBe(notice.message);
    expect(useEditorStore.getState().toastActions).toEqual(['layoutFeedback']);
    expect(screen.getByRole('alert').textContent).toContain('too large to arrange automatically');
    act(() => { vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS * 3); });
    expect(screen.getByRole('button', { name: 'Send Feedback' })).toBeTruthy();
  });

  it('a stage switch takes it away (its Try Again would lay out the other stage); a plain toast is left alone', () => {
    openApp();
    raise(layoutFailureNotice('worker', true));
    act(() => useEditorStore.getState().setDomain({ ...emptySubjectArea, stage: 'physical' } as DisplaySubjectArea));
    expect(useEditorStore.getState().toastMessage).toBeNull();
    expect(useEditorStore.getState().toastActions).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try Again' })).toBeNull();

    act(() => useEditorStore.getState().setToastMessage('Saved'));
    act(() => useEditorStore.getState().setDomain({ ...emptySubjectArea, stage: 'logical' } as DisplaySubjectArea));
    expect(useEditorStore.getState().toastMessage).toBe('Saved');
  });

  it('a host error in the same corner hides it until the error is closed', () => {
    openApp();
    raise(layoutFailureNotice('worker', true));
    act(() => useEditorStore.setState({ error: 'Something went wrong' }));
    expect(screen.queryByRole('button', { name: 'Try Again' })).toBeNull();
    act(() => useEditorStore.setState({ error: null }));
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeTruthy();
  });

  it('a new toast without buttons drops the earlier one\'s buttons', () => {
    act(() => useEditorStore.getState().setToastMessage('first', ['retryLayout', 'layoutFeedback']));
    expect(useEditorStore.getState().toastActions).toEqual(['retryLayout', 'layoutFeedback']);
    act(() => useEditorStore.getState().setToastMessage('second'));
    expect(useEditorStore.getState().toastActions).toBeNull();
    act(() => useEditorStore.getState().setToastMessage(null, ['layoutFeedback']));
    expect(useEditorStore.getState().toastActions).toBeNull();
  });
});
