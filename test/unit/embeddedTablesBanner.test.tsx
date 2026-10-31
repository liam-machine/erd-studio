// @vitest-environment jsdom
/**
 * The "This file holds its own tables. Import these tables…" banner (native
 * DBML storage, §2.5): shown when the host posts `dbmlEmbeddedTables` after a
 * DBML diagram that declares Tables and has no table `use` line; its button
 * posts `importEmbeddedTables`; the next load clears it.
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

import { EmbeddedTablesBanner } from '../../webview/components/Canvas/EmbeddedTablesBanner';
import { useEditorStore } from '../../webview/store/editorStore';

const initialStoreState = useEditorStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState(initialStoreState, true);
});

afterEach(() => cleanup());

describe('EmbeddedTablesBanner', () => {
  it('renders nothing until the host says the file holds its own tables', () => {
    const { container } = render(<EmbeddedTablesBanner />);
    expect(container.textContent).toBe('');
  });

  it('says so, and its button asks the host to import the file', () => {
    render(<EmbeddedTablesBanner />);
    act(() => useEditorStore.getState().setEmbeddedTables(true));
    expect(screen.getByRole('status').textContent).toContain('This file holds its own tables.');
    fireEvent.click(screen.getByText('Import these tables…'));
    expect(mockVsCode.postMessage).toHaveBeenCalledWith({ type: 'importEmbeddedTables' });
  });

  it('goes away when cleared (the next domainLoaded)', () => {
    render(<EmbeddedTablesBanner />);
    act(() => useEditorStore.getState().setEmbeddedTables(true));
    act(() => useEditorStore.getState().setEmbeddedTables(false));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
