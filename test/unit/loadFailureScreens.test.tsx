// @vitest-environment jsdom
/**
 * The two load-failure screens of #261.
 *
 * A diagram that fails to load for a reason of ours says so, keeps the
 * exception to a dimmed line and offers Retry and Send Feedback. A file ERD
 * Studio reads but can't accept is the user's to fix: Open as Text and Retry,
 * never Report a Bug; one saved by a newer ERD Studio offers Update instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const initialStoreState = useEditorStore.getState();

function postFromHost(data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState(initialStoreState, true);
});

afterEach(() => cleanup());

describe('the "problem in ERD Studio" screen', () => {
  const INTERNAL = { message: "Cannot read properties of undefined (reading 'columns')", kind: 'internal' };

  it('says the problem is ERD Studio\'s, not the user\'s, and offers Retry and Send Feedback', () => {
    render(<App />);
    postFromHost({ type: 'error', payload: INTERNAL });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("ERD Studio couldn't show this diagram");
    expect(alert.textContent).toContain('not in your files');
    expect(alert.textContent).toContain(INTERNAL.message);
    expect(alert.textContent).not.toContain('Error:');
    expect(screen.queryByText('Report a Bug')).toBeNull();
    expect(screen.queryByText('Open as Text')).toBeNull();

    fireEvent.click(screen.getByText('Retry'));
    expect(mockVsCode.postMessage).toHaveBeenLastCalledWith({ type: 'ready' });
  });

  it('fills Send Feedback in with the error, paths redacted', () => {
    render(<App />);
    postFromHost({ type: 'error', payload: { ...INTERNAL, message: 'boom at /Users/jo/acme/.erd-studio/silver/sales.json' } });

    fireEvent.click(screen.getByText('Send Feedback'));
    const { feedbackDialogOpen, feedbackPrefill } = useEditorStore.getState();
    expect(feedbackDialogOpen).toBe(true);
    expect(feedbackPrefill?.kind).toBe('bug');
    expect(feedbackPrefill?.description).toContain('boom at');
    expect(feedbackPrefill?.description).not.toContain('/Users/jo');
  });
});

describe('the "can\'t read this diagram\'s file" screen', () => {
  it('says the file is the user\'s to fix, and offers Open as Text and Retry — no Report a Bug', () => {
    render(<App />);
    const message = 'Subject area file .erd-studio/silver/sales.json is missing a valid "schemaVersion" field.';
    postFromHost({ type: 'error', payload: { message, kind: 'invalid' } });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("ERD Studio can't read this diagram's file");
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain('not in ERD Studio');
    expect(screen.queryByText('Report a Bug')).toBeNull();
    expect(screen.queryByText('Send Feedback')).toBeNull();

    fireEvent.click(screen.getByText('Open as Text'));
    expect(mockVsCode.postMessage).toHaveBeenLastCalledWith({ type: 'viewFile' });
    fireEvent.click(screen.getByText('Retry'));
    expect(mockVsCode.postMessage).toHaveBeenLastCalledWith({ type: 'ready' });
  });

  it('offers Update ERD Studio, not Open as Text, for a diagram saved by a newer version', () => {
    render(<App />);
    postFromHost({
      type: 'error',
      payload: { message: '.erd-studio/silver/sales.dbml has erd_schema_version 9.', kind: 'invalid', newerSchema: true },
    });

    expect(screen.getByRole('alert').textContent).toContain('This diagram was saved by a newer ERD Studio');
    expect(screen.queryByText('Open as Text')).toBeNull();
    expect(screen.queryByText('Report a Bug')).toBeNull();
    fireEvent.click(screen.getByText('Update ERD Studio'));
    expect(mockVsCode.postMessage).toHaveBeenLastCalledWith({ type: 'openFeedbackLink', payload: { target: 'extension' } });
  });

  it('forgets the newer-version flag once a later error has none', () => {
    render(<App />);
    postFromHost({ type: 'error', payload: { message: 'newer', kind: 'invalid', newerSchema: true } });
    postFromHost({ type: 'error', payload: { message: 'something else', kind: 'invalid' } });
    expect(screen.getByText('Open as Text')).toBeTruthy();
    expect(screen.queryByText('Update ERD Studio')).toBeNull();
  });
});
