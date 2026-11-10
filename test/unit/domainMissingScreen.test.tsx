// @vitest-environment jsdom
/**
 * The "deleted or renamed" screen (issue #161).
 *
 * A diagram whose file was deleted or renamed outside ERD Studio cannot be
 * retried into existence or opened as text, so the screen offers the two
 * actions that can help — Close and Open Another Diagram — and replaces a
 * loaded canvas too, whose diagram is stale and can no longer be saved.
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
import type { DisplaySubjectArea } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();
const MISSING = { message: '.erd-studio/silver/showcase.json was deleted or renamed outside ERD Studio.', kind: 'domain-missing' };
const subjectArea = {
  schemaVersion: 5, domain: 'showcase', layer: 'silver', stage: 'logical', description: '',
  models: [], relationships: [], viewConfig: {}, readOnly: false, positionDraggable: true,
} as unknown as DisplaySubjectArea;

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

describe('the deleted-or-renamed screen', () => {
  it('names the file and offers Close and Open Another Diagram — no Retry, no Open as Text', () => {
    render(<App />);
    postFromHost({ type: 'error', payload: MISSING });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("This diagram's file was deleted or renamed");
    expect(alert.textContent).toContain(MISSING.message);
    expect(screen.queryByText('Retry')).toBeNull();
    expect(screen.queryByText(/Open as Text/)).toBeNull();

    fireEvent.click(screen.getByText('Open Another Diagram…'));
    expect(mockVsCode.postMessage).toHaveBeenLastCalledWith({ type: 'openAnotherDomain' });
    fireEvent.click(screen.getByText('Close'));
    expect(mockVsCode.postMessage).toHaveBeenLastCalledWith({ type: 'closeEditor' });
  });

  it('replaces a loaded canvas, not just the initial load', () => {
    useEditorStore.getState().setDomain(subjectArea);
    useEditorStore.getState().setError(MISSING.message, 'domain-missing');
    render(<App />);
    expect(screen.getByRole('alert').textContent).toContain("This diagram's file was deleted or renamed");
  });

  it('an ordinary domain-file error still offers Retry and Open as Text', () => {
    render(<App />);
    postFromHost({ type: 'error', payload: { message: 'Invalid JSON in domain file', kind: 'domain-file' } });
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(screen.getByText('Open as Text')).toBeTruthy();
    expect(screen.queryByText('Close')).toBeNull();
  });

  it('a load error offers Show Logs, which asks the host to open the ERD Studio log', () => {
    render(<App />);
    postFromHost({ type: 'error', payload: { message: 'Invalid JSON in domain file', kind: 'domain-file' } });
    fireEvent.click(screen.getByText('Show Logs'));
    expect(mockVsCode.postMessage).toHaveBeenLastCalledWith({ type: 'showLogs' });
  });
});
