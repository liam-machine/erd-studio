// @vitest-environment jsdom
/**
 * AddExistingTableDialog — picking several models at once (#160). A click
 * ticks or unticks a row; "Select all N shown" ticks what the search and
 * filters show. One pick posts `addExistingModel` as before, more post one
 * `addExistingModels`; double-click adds that row (with any other ticks).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';

const mockPostMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage: mockPostMessage, getState: vi.fn(), setState: vi.fn() }),
}));
vi.mock('@xyflow/react', () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { AddExistingTableDialog } from '../../webview/components/AddExistingModelDialog/AddExistingModelDialog';
import { useEditorStore } from '../../webview/store/editorStore';
import { ADD_EXISTING_TABLES_LIMIT } from '../../src/types/messages';

const table = (name: string) => ({
  name, schema: '', description: '', columnCount: 1, source: 'logical' as const,
  sourcePath: `.erd-studio/logical-models/${name}.yml`,
});

const ticked = () => screen.getAllByRole('option')
  .filter((o) => o.getAttribute('aria-selected') === 'true')
  .map((o) => o.querySelector('.add-existing-model-dialog__item-name')?.textContent);

beforeEach(() => {
  mockPostMessage.mockClear();
  useEditorStore.getState().setExistingModels([table('sap_a'), table('sap_b'), table('other')]);
  useEditorStore.getState().setAddExistingModelDialogOpen(true);
});
afterEach(cleanup);

describe('AddExistingTableDialog multi-select (#160)', () => {
  it('keeps two rows ticked and adds both in one message', () => {
    render(<AddExistingTableDialog />);
    fireEvent.click(screen.getByText('sap_a'));
    fireEvent.click(screen.getByText('sap_b'));
    expect(ticked()).toEqual(['sap_a', 'sap_b']);
    expect(screen.getByText('2 selected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add 2 Tables' }));
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'addExistingModels', payload: { modelNames: ['sap_a', 'sap_b'] } });
  });

  it('a single pick still posts addExistingModel', () => {
    render(<AddExistingTableDialog />);
    fireEvent.click(screen.getByText('other'));
    fireEvent.click(screen.getByRole('button', { name: 'Add Table' }));
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'addExistingModel', payload: { modelName: 'other' } });
  });

  it('a second click unticks a row', () => {
    render(<AddExistingTableDialog />);
    fireEvent.click(screen.getByText('sap_a'));
    fireEvent.click(screen.getByText('sap_a'));
    expect(ticked()).toEqual([]);
    expect((screen.getByRole('button', { name: 'Add Table' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('double-click adds that row straight away', () => {
    render(<AddExistingTableDialog />);
    fireEvent.doubleClick(screen.getByText('other'));
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'addExistingModel', payload: { modelName: 'other' } });
  });

  it('double-click with other rows ticked adds them all, never dropping the ticks', () => {
    render(<AddExistingTableDialog />);
    fireEvent.click(screen.getByText('sap_a'));
    fireEvent.doubleClick(screen.getByText('other'));
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'addExistingModels', payload: { modelNames: ['sap_a', 'other'] } });
  });

  it('a tick hidden by the search does not count toward the limit', () => {
    const many = Array.from({ length: ADD_EXISTING_TABLES_LIMIT }, (_, i) => table(`m_${String(i).padStart(3, '0')}`));
    useEditorStore.getState().setExistingModels([...many, table('sap_a')]);
    render(<AddExistingTableDialog />);
    fireEvent.change(screen.getByPlaceholderText('Search tables...'), { target: { value: 'm_' } });
    fireEvent.click(screen.getByRole('button', { name: `Select all ${ADD_EXISTING_TABLES_LIMIT} shown` }));
    fireEvent.change(screen.getByPlaceholderText('Search tables...'), { target: { value: 'sap' } });
    fireEvent.click(screen.getByText('sap_a'));
    expect(ticked()).toEqual(['sap_a']);
  });

  it('a v4 domain picks one model at a time, as before', () => {
    useEditorStore.setState({ domain: { ...(useEditorStore.getState().domain ?? {}), schemaVersion: 4 } as never });
    try {
      render(<AddExistingTableDialog />);
      expect(screen.queryByRole('checkbox', { hidden: true })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Select all/ })).toBeNull();
      fireEvent.click(screen.getByText('sap_a'));
      fireEvent.click(screen.getByText('sap_b'));
      expect(ticked()).toEqual(['sap_b']);
      fireEvent.click(screen.getByRole('button', { name: 'Add Table' }));
      expect(mockPostMessage).toHaveBeenCalledWith({ type: 'addExistingModel', payload: { modelName: 'sap_b' } });
    } finally {
      useEditorStore.setState({ domain: null as never });
    }
  });

  it('"Select all N shown" ticks only what the search shows', () => {
    render(<AddExistingTableDialog />);
    fireEvent.change(screen.getByPlaceholderText('Search tables...'), { target: { value: 'sap' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select all 2 shown' }));
    expect(ticked()).toEqual(['sap_a', 'sap_b']);

    fireEvent.click(screen.getByRole('button', { name: 'Add 2 Tables' }));
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'addExistingModels', payload: { modelNames: ['sap_a', 'sap_b'] } });
  });

  it('a tick the search hides is not added', () => {
    render(<AddExistingTableDialog />);
    fireEvent.click(screen.getByText('other'));
    fireEvent.change(screen.getByPlaceholderText('Search tables...'), { target: { value: 'sap' } });
    fireEvent.click(screen.getByText('sap_a'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Table' }));
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'addExistingModel', payload: { modelName: 'sap_a' } });
  });

  it('"Clear" unticks everything', () => {
    render(<AddExistingTableDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Select all 3 shown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(ticked()).toEqual([]);
  });

  it('closing with Escape (the store) leaves no tick for the next opening', () => {
    render(<AddExistingTableDialog />);
    fireEvent.click(screen.getByText('sap_a'));
    act(() => useEditorStore.getState().setAddExistingModelDialogOpen(false));
    act(() => useEditorStore.getState().setAddExistingModelDialogOpen(true));
    expect(ticked()).toEqual([]);
  });

  it(`stops at ${ADD_EXISTING_TABLES_LIMIT} models`, () => {
    const many = Array.from({ length: ADD_EXISTING_TABLES_LIMIT + 5 }, (_, i) => table(`m_${String(i).padStart(3, '0')}`));
    useEditorStore.getState().setExistingModels(many);
    render(<AddExistingTableDialog />);
    fireEvent.click(screen.getByRole('button', { name: `Select first ${ADD_EXISTING_TABLES_LIMIT} shown` }));
    expect(screen.getByText(`${ADD_EXISTING_TABLES_LIMIT} selected`)).toBeTruthy();
    // A further tick is refused rather than dropped later by the host.
    fireEvent.click(screen.getByText(many[ADD_EXISTING_TABLES_LIMIT].name));
    expect(screen.getByText(`${ADD_EXISTING_TABLES_LIMIT} selected`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `Add ${ADD_EXISTING_TABLES_LIMIT} Tables` }));
    const sent = mockPostMessage.mock.calls[0][0];
    expect(sent.type).toBe('addExistingModels');
    expect(sent.payload.modelNames).toHaveLength(ADD_EXISTING_TABLES_LIMIT);
  });
});

describe('AddExistingTableDialog empty state', () => {
  beforeEach(() => {
    useEditorStore.getState().setExistingModels([]);
    useEditorStore.getState().setManifestModels([]);
  });
  afterEach(() => { cleanup(); useEditorStore.getState().setLogicalOnly(false); });

  it('suggests dbt (yml files, dbt compile) in a dbt project', () => {
    render(<AddExistingTableDialog />);
    expect(screen.getByText('No tables available to add.')).toBeTruthy();
    expect(document.body.textContent).toContain('dbt compile');
  });

  it('says nothing about dbt without a dbt project (logicalOnly)', () => {
    useEditorStore.getState().setLogicalOnly(true);
    render(<AddExistingTableDialog />);
    expect(screen.getByText('No tables available to add.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('dbt');
    expect(document.body.textContent).toContain('Table Library');
  });
});
