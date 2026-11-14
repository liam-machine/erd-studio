// @vitest-environment jsdom
/**
 * #319 — a canvas action that failed on ERD Studio's side: the host's `error`
 * message carries Send Feedback's prefill, and the error toast over the live
 * canvas offers the button.
 *
 *  - the toast shows the host's words and a Send Feedback button, which opens
 *    the dialog filled in with the host's prefill (the cause is there, never
 *    in the toast);
 *  - an error without a prefill (a refusal, a problem in the user's files)
 *    has no button, as before;
 *  - the next error, a dismissal and a fresh diagram each drop the prefill,
 *    so a button never outlives the failure it belongs to;
 *  - the report's recent errors keep the cause.
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
import { useEditorStore } from '../../webview/store/editorStore';
import type { DisplaySubjectArea } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

const emptySubjectArea = {
  schemaVersion: 6, domain: 'sales', layer: 'gold', stage: 'logical', description: '',
  models: [], relationships: [], viewConfig: {}, readOnly: false, positionDraggable: true,
} as unknown as DisplaySubjectArea;

const OURS = "Saving this diagram's layout hit a problem in ERD Studio while writing the positions, so the tables you moved were not saved. This isn't something you did. Please send us a report.";
const PREFILL = { kind: 'bug', title: "Saving this diagram's layout failed", description: "Saving this diagram's layout hit a problem while writing the positions.\n\nError: boom" };

function host(data: unknown) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data })); });
}

function openApp() {
  render(<App />);
  host({ type: 'domainLoaded', payload: emptySubjectArea, welcomeDismissed: true, logicalOnly: true });
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

afterEach(() => cleanup());

describe('a handler failure of ours on the canvas (#319)', () => {
  it('shows the host\'s words with Send Feedback, which opens the dialog filled in by the host', () => {
    openApp();
    host({ type: 'error', payload: { message: OURS, feedback: PREFILL } });

    expect(screen.getByRole('alert').textContent).toContain(OURS);
    expect(screen.getByRole('alert').textContent).not.toContain('boom');
    fireEvent.click(screen.getByRole('button', { name: 'Send Feedback' }));

    const state = useEditorStore.getState();
    expect(state.feedbackDialogOpen).toBe(true);
    expect(state.feedbackPrefill).toEqual(PREFILL);
    // The toast went with the click, and its prefill with it.
    expect(state.error).toBeNull();
    expect(state.errorFeedback).toBeNull();
  });

  it('an error without a prefill has no button', () => {
    openApp();
    host({ type: 'error', payload: { message: 'Failed to add column: x.dbml has unsaved changes. Save or revert it, then try again.' } });
    expect(screen.getByRole('alert').textContent).toContain('has unsaved changes');
    expect(screen.queryByRole('button', { name: 'Send Feedback' })).toBeNull();
  });

  it('the next error, a dismissal and a fresh diagram each drop the button', () => {
    openApp();
    host({ type: 'error', payload: { message: OURS, feedback: PREFILL } });
    host({ type: 'error', payload: { message: 'Failed to add column: Column "a" already exists.' } });
    expect(screen.queryByRole('button', { name: 'Send Feedback' })).toBeNull();
    expect(useEditorStore.getState().errorFeedback).toBeNull();

    host({ type: 'error', payload: { message: OURS, feedback: PREFILL } });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(useEditorStore.getState().errorFeedback).toBeNull();

    host({ type: 'error', payload: { message: OURS, feedback: PREFILL } });
    act(() => useEditorStore.getState().setDomain(emptySubjectArea));
    expect(useEditorStore.getState().error).toBeNull();
    expect(useEditorStore.getState().errorFeedback).toBeNull();
  });

  it('the report\'s recent errors keep the cause the toast no longer shows', () => {
    openApp();
    host({ type: 'error', payload: { message: OURS, feedback: PREFILL } });
    expect(JSON.stringify(useEditorStore.getState().recentErrors)).toContain('Error: boom');
  });
});
