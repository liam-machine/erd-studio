// @vitest-environment jsdom
/**
 * The "isn't valid JSON" and "is empty" screens (issue #186).
 *
 * A domain file with a JSON mistake, or with no content, is the user's file to
 * fix, not an ERD Studio fault. The screen says so in plain words, points at
 * the mistake, and never offers Report a Bug. The merge-conflict screen and an
 * error from an older host (no `fileProblem`) are left as they were.
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
const SYNTAX = {
  message: '.erd-studio/gold/reporting.json has a mistake at line 61, column 5: a comma is missing after this value.',
  kind: 'domain-file',
  fileProblem: 'syntax',
  line: 61,
  column: 5,
};
const EMPTY = { message: '.erd-studio/gold/reporting.json has no content.', kind: 'domain-file', fileProblem: 'empty' };

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

describe('the "isn\'t valid JSON" screen', () => {
  it('says where the mistake is and whose it is, and opens the file at that line — no Report a Bug', () => {
    render(<App />);
    postFromHost({ type: 'error', payload: SYNTAX });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("This diagram's file isn't valid JSON");
    expect(alert.textContent).toContain(SYNTAX.message);
    expect(alert.textContent).toContain('not in ERD Studio');
    expect(alert.textContent).toContain('reloads by itself');
    expect(alert.textContent).not.toContain('Error:');
    expect(screen.queryByText('Report a Bug')).toBeNull();
    expect(screen.queryByText('Open as Text')).toBeNull();

    fireEvent.click(screen.getByText('Open at Line 61'));
    expect(mockVsCode.postMessage).toHaveBeenLastCalledWith({ type: 'viewFile', payload: { line: 61, column: 5 } });
    fireEvent.click(screen.getByText('Retry'));
    expect(mockVsCode.postMessage).toHaveBeenLastCalledWith({ type: 'ready' });
  });

  it('says DBML for a .dbml diagram (native DBML storage), and JSON when an older host sends no file type', () => {
    render(<App />);
    postFromHost({
      type: 'error',
      payload: {
        message: ".erd-studio/gold/sales.dbml has a mistake at line 6, column 1: Expect a closing brace '}' [1005].",
        kind: 'domain-file', fileProblem: 'syntax', line: 6, column: 1, fileType: 'DBML',
      },
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("This diagram's file isn't valid DBML");
    expect(alert.textContent).not.toContain('valid JSON');
    fireEvent.click(screen.getByText('Open at Line 6'));
    expect(mockVsCode.postMessage).toHaveBeenLastCalledWith({ type: 'viewFile', payload: { line: 6, column: 1 } });
  });

  it('offers Open as Text when the mistake could not be located', () => {
    render(<App />);
    postFromHost({ type: 'error', payload: { message: '.erd-studio/gold/reporting.json is not valid JSON.', kind: 'domain-file', fileProblem: 'syntax' } });

    expect(screen.getByRole('alert').textContent).toContain("This diagram's file isn't valid JSON");
    expect(screen.queryByText(/Open at Line/)).toBeNull();
    fireEvent.click(screen.getByText('Open as Text'));
    expect(mockVsCode.postMessage).toHaveBeenLastCalledWith({ type: 'viewFile' });
    expect(screen.queryByText('Report a Bug')).toBeNull();
  });

  it('forgets the line once a later error has none', () => {
    render(<App />);
    postFromHost({ type: 'error', payload: SYNTAX });
    postFromHost({ type: 'error', payload: { message: 'Something else went wrong', kind: 'domain-file' } });
    expect(screen.queryByText(/Open at Line/)).toBeNull();
    expect(screen.getByText('Report a Bug')).toBeTruthy();
  });
});

describe('the "is empty" screen', () => {
  it('says the file has no content and how to get it back — Open as Text and Retry, no Report a Bug', () => {
    render(<App />);
    postFromHost({ type: 'error', payload: EMPTY });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("This diagram's file is empty");
    expect(alert.textContent).toContain(EMPTY.message);
    expect(alert.textContent).toContain('git checkout --');
    expect(screen.getByText('Open as Text')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(screen.queryByText('Report a Bug')).toBeNull();
  });
});

describe('what did not change', () => {
  it('the merge-conflict screen', () => {
    render(<App />);
    postFromHost({ type: 'error', payload: { message: 'x.json has unresolved git merge conflicts (first at line 9).', kind: 'domain-file', mergeConflict: true } });
    expect(screen.getByRole('alert').textContent).toContain('This diagram has unresolved git merge conflicts');
    expect(screen.getByText('Open as Text to Resolve')).toBeTruthy();
    expect(screen.queryByText('Retry')).toBeNull();
  });

  it('an error from a host that predates fileProblem', () => {
    render(<App />);
    postFromHost({ type: 'error', payload: { message: 'Invalid JSON in subject area file x.json: …', kind: 'domain-file' } });
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(screen.getByText('Open as Text')).toBeTruthy();
    expect(screen.getByText('Report a Bug')).toBeTruthy();
  });
});
