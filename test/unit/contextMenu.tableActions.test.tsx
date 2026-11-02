// @vitest-environment jsdom
/**
 * A table's canvas context menu (`webview/components/ContextMenu`): Open
 * Table File, Show on Other Diagrams…, Move Table… (a DBML table on an
 * editable canvas), Copy Path, Reveal in Table Library and Remove from
 * Diagram (asked twice). A read-only canvas (the physical stage) keeps only
 * the items that write nothing. Each item posts its message with the
 * table's name; the host side is `test/unit/revealTable.test.ts`.
 *
 * And the toolbar search's "Not on this diagram" count (`searchElsewhere`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const mockPostMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage: mockPostMessage, getState: vi.fn(), setState: vi.fn() }),
}));

import { ContextMenu, tableMenuActions } from '../../webview/components/ContextMenu/ContextMenu';
import { otherProjectMatches, searchElsewhereLabel } from '../../webview/components/Toolbar/searchElsewhere';
import { useEditorStore } from '../../webview/store/editorStore';
import type { DisplaySubjectArea, ExistingTablePreview } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

function openMenu(options: { readOnly?: boolean; layer?: string } = {}): void {
  useEditorStore.setState({
    domain: {
      schemaVersion: 5,
      domain: 'sales',
      layer: 'gold',
      stage: options.readOnly ? 'physical' : 'logical',
      models: [{ name: 'fct_order', columns: [], ...(options.layer ? { layer: options.layer } : {}) }],
      relationships: [],
      viewConfig: { positions: {} },
      readOnly: options.readOnly ?? false,
    } as unknown as DisplaySubjectArea,
  });
  useEditorStore.getState().openNodeContextMenu(20, 20, 'fct_order');
}

const items = (): string[] => screen.queryAllByRole('menuitem').map((b) => b.textContent ?? '');

beforeEach(() => {
  useEditorStore.setState(initialStoreState, true);
  mockPostMessage.mockClear();
});

afterEach(() => cleanup());

describe('tableMenuActions', () => {
  it('lists every action for a DBML table on an editable canvas', () => {
    expect(tableMenuActions({ readOnly: false, dbml: true }).map((a) => a.label)).toEqual([
      'Open Table File', 'Show on Other Diagrams…', 'Move Table…', 'Copy Path', 'Reveal in Table Library', 'Remove from Diagram',
    ]);
  });

  it('leaves out Move Table… for a YAML table, and every write on a read-only canvas', () => {
    expect(tableMenuActions({ readOnly: false, dbml: false }).map((a) => a.id)).not.toContain('moveTable');
    expect(tableMenuActions({ readOnly: true, dbml: true }).map((a) => a.id)).toEqual([
      'openModelFile', 'showTableOnOtherDiagrams', 'copyTablePath', 'revealTableInLibrary',
    ]);
  });
});

describe('a table\'s context menu', () => {
  it('posts each action with the table\'s name and closes', () => {
    for (const [label, type] of [
      ['Open Table File', 'openModelFile'],
      ['Show on Other Diagrams…', 'showTableOnOtherDiagrams'],
      ['Move Table…', 'moveTable'],
      ['Copy Path', 'copyTablePath'],
      ['Reveal in Table Library', 'revealTableInLibrary'],
    ] as const) {
      openMenu({ layer: 'gold' });
      render(<ContextMenu />);
      fireEvent.click(screen.getByRole('menuitem', { name: label }));
      expect(mockPostMessage).toHaveBeenLastCalledWith({ type, payload: { modelName: 'fct_order' } });
      expect(useEditorStore.getState().contextMenu).toBeNull();
      cleanup();
    }
  });

  it('asks again before Remove from Diagram', () => {
    openMenu({ layer: 'gold' });
    render(<ContextMenu />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from Diagram' }));
    expect(mockPostMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Click again to remove' }));
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'removeModel', payload: { modelName: 'fct_order' } });
  });

  it('shows no write on a read-only canvas', () => {
    openMenu({ readOnly: true, layer: 'gold' });
    render(<ContextMenu />);
    expect(items()).toEqual(['Open Table File', 'Show on Other Diagrams…', 'Copy Path', 'Reveal in Table Library']);
  });

  it('shows no Move Table… for a table with no layer of its own (YAML)', () => {
    openMenu();
    render(<ContextMenu />);
    expect(items()).not.toContain('Move Table…');
    expect(items()).toContain('Remove from Diagram');
  });
});

describe('the search\'s "Not on this diagram" count', () => {
  const row = (name: string, source: ExistingTablePreview['source'] = 'logical'): ExistingTablePreview =>
    ({ name, schema: '', description: '', columnCount: 0, source, sourcePath: '' });

  it('counts library tables off this diagram whose name holds the search, ignoring case', () => {
    const existing = [row('fct_order'), row('FCT_Return'), row('dim_customer'), row('fct_dbt_only', 'yml'), row('fct_here')];
    expect(otherProjectMatches(existing, ['fct_here'], 'FCT')).toBe(2);
    expect(otherProjectMatches(existing, [], '  ')).toBe(0);
    expect(otherProjectMatches(undefined, [], 'fct')).toBe(0);
  });

  it('says where they are', () => {
    expect(searchElsewhereLabel(3)).toBe('Not on this diagram — 3 in the project');
  });
});
