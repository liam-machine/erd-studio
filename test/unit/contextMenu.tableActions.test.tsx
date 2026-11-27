// @vitest-environment jsdom
/**
 * A table's canvas context menu (`webview/components/ContextMenu`): Open
 * Table File, Show on Other Diagrams…, Move Table… (a DBML table on an
 * editable canvas), Copy Path, Reveal in Table Library and Remove from
 * Diagram (asked twice). A read-only canvas (the physical stage) keeps only
 * the items that write nothing. Each item posts its message with the
 * table's name; the host side is `test/unit/revealTable.test.ts`. Add
 * Related Tables (n) (#365) is the exception: it posts the detail panel's
 * `addExistingModel(s)` for the related tables off the diagram.
 *
 * And the toolbar search's "Not on this diagram" count (`searchElsewhere`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const mockPostMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage: mockPostMessage, getState: vi.fn(), setState: vi.fn() }),
}));

import { ContextMenu, addRelatedTablesLabel, tableMenuActions } from '../../webview/components/ContextMenu/ContextMenu';
import { otherProjectMatches, searchElsewhereLabel } from '../../webview/components/Toolbar/searchElsewhere';
import { useEditorStore } from '../../webview/store/editorStore';
import type { DisplaySubjectArea, ExistingTablePreview } from '../../src/types/display';
import type { CanvasContext } from '@erd-studio/core';
import { ADD_TABLES_LIMIT } from '@erd-studio/renderer/editor';
import { ADD_EXISTING_TABLES_LIMIT } from '../../src/types/messages';

const initialStoreState = useEditorStore.getState();

function openMenu(options: { readOnly?: boolean; layer?: string; context?: CanvasContext; onDiagram?: string[] } = {}): void {
  useEditorStore.setState({
    domain: {
      schemaVersion: 5,
      domain: 'sales',
      layer: 'gold',
      stage: options.readOnly ? 'physical' : 'logical',
      models: [
        { name: 'fct_order', columns: [], ...(options.layer ? { layer: options.layer } : {}) },
        ...(options.onDiagram ?? []).map((name) => ({ name, columns: [] })),
      ],
      relationships: [],
      viewConfig: { positions: {} },
      readOnly: options.readOnly ?? false,
    } as unknown as DisplaySubjectArea,
    canvasContext: options.context ?? null,
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

  it('puts Add Related Tables (n) after Show on Other Diagrams… when the table has related tables off the diagram', () => {
    expect(tableMenuActions({ readOnly: false, dbml: true, related: 3 }).map((a) => a.label)).toEqual([
      'Open Table File', 'Show on Other Diagrams…', 'Add Related Tables (3)', 'Move Table…', 'Copy Path', 'Reveal in Table Library', 'Remove from Diagram',
    ]);
    expect(tableMenuActions({ readOnly: false, dbml: true, related: 0 }).map((a) => a.id)).not.toContain('addRelatedTables');
    expect(tableMenuActions({ readOnly: true, dbml: true, related: 3 }).map((a) => a.id)).not.toContain('addRelatedTables');
  });

  it('asks for no more tables in one go than the host takes', () => {
    expect(ADD_TABLES_LIMIT).toBe(ADD_EXISTING_TABLES_LIMIT);
  });

  it('says when more related tables than one add takes are waiting', () => {
    expect(addRelatedTablesLabel(1)).toBe('Add Related Tables (1)');
    expect(addRelatedTablesLabel(250)).toBe('Add Related Tables (200 of 250)');
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

describe('Add Related Tables (#365)', () => {
  const CONTEXT: CanvasContext = {
    tableFiles: {},
    offDiagram: {
      fct_order: [
        { otherTable: 'dim_customer', columns: 'customer_key', cardinality: 'many-to-one', direction: 'out', otherTablePath: '.erd-studio/gold/tables/dim_customer.dbml' },
        // A second relationship to the same table: still one table.
        { otherTable: 'dim_customer', columns: 'ship_to_key → customer_key', cardinality: 'many-to-one', direction: 'out', otherTablePath: '.erd-studio/gold/tables/dim_customer.dbml' },
        { otherTable: 'fct_return', columns: 'order_key', cardinality: 'many-to-one', direction: 'in' },
        { otherTable: 'dim_date', columns: 'order_date_key → date_key', cardinality: 'many-to-one', direction: 'out' },
      ],
    },
  };

  it('counts the related tables off the diagram, not the relationships, and adds them all in one message', () => {
    // dim_date was added since the host worked the context out.
    openMenu({ context: CONTEXT, onDiagram: ['dim_date'] });
    render(<ContextMenu />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add Related Tables (2)' }));
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'addExistingModels',
      payload: { modelNames: ['dim_customer', 'fct_return'], sourcePaths: ['.erd-studio/gold/tables/dim_customer.dbml', ''] },
    });
    expect(useEditorStore.getState().contextMenu).toBeNull();
  });

  it('adds a single related table with addExistingModel', () => {
    openMenu({ context: CONTEXT, onDiagram: ['dim_customer', 'dim_date'] });
    render(<ContextMenu />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add Related Tables (1)' }));
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'addExistingModel', payload: { modelName: 'fct_return' } });
  });

  it('appears in a menu already open when the host\'s context arrives', () => {
    openMenu();
    render(<ContextMenu />);
    expect(items().some((label) => label.startsWith('Add Related Tables'))).toBe(false);
    act(() => useEditorStore.setState({ canvasContext: CONTEXT }));
    expect(items()).toContain('Add Related Tables (3)');
  });

  it('is not offered once every related table is on the diagram, without a context, or on the physical stage', () => {
    openMenu({ context: CONTEXT, onDiagram: ['dim_customer', 'fct_return', 'dim_date'] });
    render(<ContextMenu />);
    expect(items().some((label) => label.startsWith('Add Related Tables'))).toBe(false);
    cleanup();

    openMenu();
    render(<ContextMenu />);
    expect(items().some((label) => label.startsWith('Add Related Tables'))).toBe(false);
    cleanup();

    openMenu({ readOnly: true, context: CONTEXT });
    render(<ContextMenu />);
    expect(items().some((label) => label.startsWith('Add Related Tables'))).toBe(false);
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
