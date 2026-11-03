// @vitest-environment jsdom
/**
 * The detail panel's "Warehouse name" row (the model's alias) without a dbt
 * project (`logicalOnly`): hidden for a table with no alias, shown for one
 * that has one (it is the user's data, so they can see and clear it) and then
 * worded without dbt. In a dbt project the row is what it always was. The
 * viewer keeps the read-only row, but never names dbt: a page outside VS Code
 * cannot know whether the project uses it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { CanvasEditMessage, DisplaySubjectArea, DisplayTable } from '@erd-studio/core';
import { createCanvasStore, CanvasStoreProvider } from '../../src/store/editorStore';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';
import { DetailPanel } from '../../src/components/DetailPanel/DetailPanel';
import { aliasHint, aliasTitle } from '../../src/components/DetailPanel/AliasEditor';

afterEach(cleanup);

const col = (name: string, isPrimaryKey = false) => ({ name, dataType: 'bigint', description: '', isPrimaryKey, isForeignKey: false, isNaturalKey: false });

function domain(sale: Partial<DisplayTable> = {}): DisplaySubjectArea {
  return {
    schemaVersion: 7, domain: 'sales', layer: 'gold', stage: 'logical', description: '', viewConfig: {},
    readOnly: false, positionDraggable: true,
    models: [{ name: 'fct_sale', schema: 'gold', description: 'One row per sale line', columns: [col('sale_key', true)], ...sale }],
    relationships: [],
  } as DisplaySubjectArea;
}

function renderPanel(options: { logicalOnly: boolean; alias?: string; viewer?: boolean }) {
  const posted: CanvasEditMessage[] = [];
  const host = { postMessage: vi.fn((m: CanvasEditMessage) => { posted.push(m); }) };
  const store = createCanvasStore({
    domain: domain(options.alias === undefined ? {} : { alias: options.alias }),
    selectedNode: 'fct_sale',
    detailPanelOpen: true,
    logicalOnly: options.logicalOnly,
  });
  const utils = render(
    <CanvasStoreProvider store={store}>
      <CanvasEnvironmentProvider host={host} viewer={options.viewer ?? false}>
        <ReactFlowProvider><DetailPanel /></ReactFlowProvider>
      </CanvasEnvironmentProvider>
    </CanvasStoreProvider>,
  );
  const row = () => utils.container.querySelector('.detail-panel__metadata-row--alias');
  return { ...utils, posted, row };
}

/** Every visible string and tooltip in the panel. */
function allText(container: HTMLElement): string {
  const titles = [...container.querySelectorAll('[title]')].map((el) => el.getAttribute('title'));
  const labels = [...container.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label'));
  const placeholders = [...container.querySelectorAll('[placeholder]')].map((el) => el.getAttribute('placeholder'));
  return [container.textContent, ...titles, ...labels, ...placeholders].join('\n');
}

describe('DetailPanel — Warehouse name in a dbt project (unchanged)', () => {
  it('shows the row with the model name dimmed and a pencil, even with no alias', () => {
    const { row } = renderPanel({ logicalOnly: false });
    expect(row()).not.toBeNull();
    expect(row()!.textContent).toContain('Warehouse name');
    expect(row()!.querySelector('.detail-panel__value--muted')!.textContent).toBe('fct_sale');
    expect(row()!.querySelector('.detail-panel__alias-edit-btn')).not.toBeNull();
  });

  it('names dbt in the tooltip and the edit hint', () => {
    const { row } = renderPanel({ logicalOnly: false, alias: 'sale' });
    expect(row()!.querySelector('.detail-panel__value')!.getAttribute('title')).toBe("Built as sale (dbt alias); the table's name is fct_sale");
    fireEvent.click(row()!.querySelector('.detail-panel__alias-edit-btn')!);
    expect(row()!.querySelector('.detail-panel__alias-hint')!.textContent).toBe("The table dbt builds (its alias). Leave blank to use the table's name.");
  });
});

describe('DetailPanel — Warehouse name without a dbt project (logicalOnly)', () => {
  it('hides the row for a table with no alias, and the panel says nothing about dbt', () => {
    const { container, row } = renderPanel({ logicalOnly: true });
    expect(row()).toBeNull();
    expect(container.textContent).not.toContain('Warehouse name');
    expect(allText(container)).not.toMatch(/dbt/i);
  });

  it('hides the row for an alias that is only whitespace', () => {
    const { row } = renderPanel({ logicalOnly: true, alias: '  ' });
    expect(row()).toBeNull();
  });

  it('shows a set alias, worded without dbt, and lets the user clear it', () => {
    const { container, row, posted } = renderPanel({ logicalOnly: true, alias: 'sale' });
    expect(row()).not.toBeNull();
    const value = row()!.querySelector('.detail-panel__value')!;
    expect(value.textContent).toBe('sale');
    expect(value.getAttribute('title')).toBe("Named sale in the warehouse; the table's name is fct_sale");

    fireEvent.click(row()!.querySelector('.detail-panel__alias-edit-btn')!);
    expect(row()!.querySelector('.detail-panel__alias-hint')!.textContent).toBe("The table's name in the warehouse (its alias). Leave blank to use the table's name.");
    expect(allText(container)).not.toMatch(/dbt/i);

    const input = row()!.querySelector('input')!;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(posted).toEqual([{ type: 'updateModelAlias', payload: { modelName: 'fct_sale', alias: '' } }]);
  });
});

describe('DetailPanel — Warehouse name in the viewer', () => {
  it.each([false, true])('keeps the read-only row (logicalOnly %s)', (logicalOnly) => {
    const { row } = renderPanel({ logicalOnly, viewer: true });
    expect(row()).not.toBeNull();
    expect(row()!.querySelector('.detail-panel__value')!.textContent).toBe('fct_sale');
    expect(row()!.querySelector('.detail-panel__alias-edit-btn')).toBeNull();
  });

  it.each([false, true])('words a set alias without dbt (logicalOnly %s)', (logicalOnly) => {
    const { row, container } = renderPanel({ logicalOnly, alias: 'sale', viewer: true });
    expect(row()!.querySelector('.detail-panel__value')!.getAttribute('title')).toBe("Named sale in the warehouse; the table's name is fct_sale");
    expect(allText(container)).not.toMatch(/dbt/i);
  });
});

describe('aliasHint / aliasTitle', () => {
  it('words the hint with and without dbt', () => {
    expect(aliasHint(true)).toMatch(/dbt/);
    expect(aliasHint(false)).not.toMatch(/dbt/i);
  });

  it('words the tooltip with and without dbt; no alias is the same either way', () => {
    expect(aliasTitle('fct_sale', 'sale', true)).toMatch(/dbt alias/);
    expect(aliasTitle('fct_sale', 'sale', false)).not.toMatch(/dbt/i);
    expect(aliasTitle('fct_sale', undefined, true)).toBe("Same as the table's name");
    expect(aliasTitle('fct_sale', undefined, false)).toBe("Same as the table's name");
  });
});
