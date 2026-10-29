// @vitest-environment jsdom
/**
 * AddExistingTableDialog on a large Table Library opened before its files
 * were read: rows with `detailsPending` show "Reading…", opening the dialog
 * asks the host once for the rest (`requestExistingTables`), and a list with
 * nothing pending never asks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const mockPostMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage: mockPostMessage, getState: vi.fn(), setState: vi.fn() }),
}));
vi.mock('@xyflow/react', () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { AddExistingTableDialog } from '../../webview/components/AddExistingModelDialog/AddExistingModelDialog';
import { useEditorStore } from '../../webview/store/editorStore';

const row = (name: string, pending = false) => ({
  name, schema: '', description: '', columnCount: pending ? 0 : 3, source: 'logical' as const,
  sourcePath: `.erd-studio/tables/${name}.dbml`,
  ...(pending ? { detailsPending: true as const } : {}),
});

beforeEach(() => {
  mockPostMessage.mockClear();
  useEditorStore.getState().setAddExistingModelDialogOpen(false);
});
afterEach(cleanup);

describe('AddExistingTableDialog with rows not read yet', () => {
  it('asks the host for them once when it opens, and shows them as being read', () => {
    useEditorStore.getState().setExistingModels([row('read_one'), row('not_yet', true)]);
    render(<AddExistingTableDialog />);
    expect(mockPostMessage).not.toHaveBeenCalled();
    act(() => { useEditorStore.getState().setAddExistingModelDialogOpen(true); });
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'requestExistingTables' });
    expect(screen.getByText('Reading table details…')).toBeTruthy();
    expect(screen.getByText('Reading…')).toBeTruthy();
    expect(screen.getByText('3 columns')).toBeTruthy();

    // The host's answer fills the rows in; nothing more is asked.
    act(() => { useEditorStore.getState().setExistingModels([row('read_one'), row('not_yet')]); });
    expect(screen.queryByText('Reading table details…')).toBeNull();
    expect(screen.queryByText('Reading…')).toBeNull();
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });

  it('a list with every row read never asks', () => {
    useEditorStore.getState().setExistingModels([row('a'), row('b')]);
    render(<AddExistingTableDialog />);
    act(() => { useEditorStore.getState().setAddExistingModelDialogOpen(true); });
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(screen.queryByText('Reading table details…')).toBeNull();
  });

  it('asks again on the next opening if rows are still pending', () => {
    useEditorStore.getState().setExistingModels([row('x', true)]);
    render(<AddExistingTableDialog />);
    act(() => { useEditorStore.getState().setAddExistingModelDialogOpen(true); });
    act(() => { useEditorStore.getState().setAddExistingModelDialogOpen(false); });
    act(() => { useEditorStore.getState().setAddExistingModelDialogOpen(true); });
    expect(mockPostMessage).toHaveBeenCalledTimes(2);
  });
});
