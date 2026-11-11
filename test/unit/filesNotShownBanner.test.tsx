// @vitest-environment jsdom
/**
 * The "not shown" strip above the diagram: what the files hold that the
 * canvas is not drawing, each with its file and line and, where there is
 * one, its button. Shown for as long as the host says so; the × hides it
 * until the list changes, except while the picture itself is out of date.
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

import { FilesNotShownBanner, filesNotShownLead } from '../../webview/components/Canvas/FilesNotShownBanner';
import { useEditorStore } from '../../webview/store/editorStore';
import type { FileNote } from '../../src/types/filesNotShown';
import type { DisplaySubjectArea } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

const domainOn = (stage: 'logical' | 'physical'): DisplaySubjectArea => ({
  domain: 'sales', layer: 'gold', stage, schemaVersion: 7, models: [], relationships: [], viewConfig: {}, readOnly: stage === 'physical',
} as unknown as DisplaySubjectArea);

const IMPORT: FileNote = {
  code: 'relationshipsNotImported',
  message: '.erd-studio/gold/relationships/customers.dbml holds a relationship between two tables of this diagram.',
  file: '.erd-studio/gold/relationships/customers.dbml',
  action: 'addRelationshipsImports',
};
const REF: FileNote = { code: 'notDrawnInTableFile', message: 'Relationships live in a relationships file.', file: '.erd-studio/gold/tables/gold/fct_order.dbml', line: 12 };
const STRAY: FileNote = { code: 'fileNotRead', message: 'ERD Studio does not read this file.', file: '.erd-studio/gold/tables/x.dbml' };
const STALE: FileNote = { code: 'diagramNotRead', message: 'sales.dbml has a syntax error.', file: '.erd-studio/gold/diagrams/sales.dbml', line: 3 };
const FAILED: FileNote = { code: 'refreshFailed', message: 'ERD Studio could not redraw.', action: 'reloadFromDisk' };

const show = (items: FileNote[], stage: 'logical' | 'physical' = 'logical') => act(() => {
  useEditorStore.setState({ domain: domainOn(stage) });
  useEditorStore.getState().setFilesNotShown(items);
});

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState(initialStoreState, true);
});

afterEach(() => cleanup());

describe('FilesNotShownBanner', () => {
  it('renders nothing while the files are all shown', () => {
    const { container } = render(<FilesNotShownBanner />);
    show([]);
    expect(container.textContent).toBe('');
  });

  it('lists a note with its file link and its button, which ask the host', () => {
    render(<FilesNotShownBanner />);
    show([IMPORT]);
    expect(screen.getByRole('status').textContent).toContain("1 thing in your files isn't shown on this diagram.");
    expect(screen.getByText(IMPORT.message)).toBeTruthy();
    fireEvent.click(screen.getByText('Open file'));
    expect(mockVsCode.postMessage).toHaveBeenCalledWith({ type: 'openNotedFile', payload: { file: IMPORT.file } });
    fireEvent.click(screen.getByText('Add the import'));
    expect(mockVsCode.postMessage).toHaveBeenCalledWith({ type: 'addRelationshipsImports' });
  });

  it('a note with a line opens the file at that line', () => {
    render(<FilesNotShownBanner />);
    show([REF]);
    fireEvent.click(screen.getByText('Open at line 12'));
    expect(mockVsCode.postMessage).toHaveBeenCalledWith({ type: 'openNotedFile', payload: { file: REF.file, line: 12 } });
  });

  it('folds a longer list behind Show details, and counts it', () => {
    render(<FilesNotShownBanner />);
    show([IMPORT, REF, STRAY]);
    expect(screen.getByRole('status').textContent).toContain("3 things in your files aren't shown on this diagram.");
    expect(screen.queryByText(REF.message)).toBeNull();
    fireEvent.click(screen.getByText('Show details'));
    expect(screen.getByText(REF.message)).toBeTruthy();
    expect(screen.getByText(STRAY.message)).toBeTruthy();
    fireEvent.click(screen.getByText('Hide details'));
    expect(screen.queryByText(REF.message)).toBeNull();
  });

  it('goes by itself when the host takes the notes back', () => {
    render(<FilesNotShownBanner />);
    show([IMPORT]);
    show([]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('the × hides it until the list changes', () => {
    render(<FilesNotShownBanner />);
    show([STRAY]);
    fireEvent.click(screen.getByLabelText('Hide until this list changes'));
    expect(screen.queryByRole('status')).toBeNull();
    // The same list posted again (every redraw re-posts it) stays hidden.
    show([{ ...STRAY }]);
    expect(screen.queryByRole('status')).toBeNull();
    // Something new in the files: it is back.
    show([STRAY, REF]);
    expect(screen.getByRole('status').textContent).toContain('2 things');
  });

  it('cannot be hidden while the picture itself is out of date', () => {
    render(<FilesNotShownBanner />);
    show([STALE, STRAY]);
    expect(screen.getByRole('status').className).toContain('files-not-shown--stale');
    expect(screen.getByRole('status').textContent).toContain("This diagram may not match your files, and 1 thing in your files isn't shown on this diagram.");
    expect(screen.queryByLabelText('Hide until this list changes')).toBeNull();
    expect(screen.getByText(STALE.message)).toBeTruthy();
  });

  it('a failed redraw offers Reload from disk', () => {
    render(<FilesNotShownBanner />);
    show([FAILED]);
    expect(screen.getByRole('status').textContent).toContain('This diagram may not match your files.');
    fireEvent.click(screen.getByText('Reload from disk'));
    expect(mockVsCode.postMessage).toHaveBeenCalledWith({ type: 'reloadFromDisk' });
  });

  it('is not shown on the physical stage, which is drawn from dbt', () => {
    render(<FilesNotShownBanner />);
    show([IMPORT], 'physical');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a new diagram payload does not clear the notes: only the host takes them back', () => {
    render(<FilesNotShownBanner />);
    show([IMPORT]);
    act(() => useEditorStore.getState().setDomain(domainOn('logical')));
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

describe('filesNotShownLead', () => {
  it('counts what is not shown, and says first when the picture is old', () => {
    expect(filesNotShownLead([IMPORT])).toBe("1 thing in your files isn't shown on this diagram.");
    expect(filesNotShownLead([IMPORT, REF])).toBe("2 things in your files aren't shown on this diagram.");
    expect(filesNotShownLead([STALE])).toBe('This diagram may not match your files.');
    expect(filesNotShownLead([FAILED, IMPORT, REF])).toBe("This diagram may not match your files, and 2 things in your files aren't shown on this diagram.");
  });
});
