// @vitest-environment jsdom
/**
 * The line under each table's name in the webview (#367): the toolbar's
 * "Under name" menu lists the project's table fields, the values tables
 * carry that the list does not name, Description and Nothing, on every stage
 * (a view preference, so read-only and physical diagrams have it too). A pick
 * switches the store at once and posts `setTableSubtitle`; the host's
 * `tableSubtitle` message sets the store, and the tables redraw without a
 * new diagram payload.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { parseFieldsText } from '@erd-studio/core';
import { nodeSubtitle } from '@erd-studio/renderer/editor';

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
import type { DisplaySubjectArea, DisplayTable } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

const table = (name: string, extra: Partial<DisplayTable> = {}): DisplayTable =>
  ({
    name,
    schema: 'sales',
    description: '',
    columns: [{ name: `${name}_key`, dataType: 'bigint', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false }],
    ...extra,
  }) as DisplayTable;

const subjectArea = (overrides: Partial<DisplaySubjectArea> = {}) =>
  ({
    schemaVersion: 7, domain: 'sales', layer: 'gold', stage: 'logical', description: '',
    models: [
      table('dim_customer', {
        description: 'Every customer who has placed an order.',
        grain: 'One row per customer',
        rationale: { purpose: 'The one customer list.' },
        meta: { owner: 'crm-team', steward: 'ana' },
      }),
      table('dim_region', { description: 'Sales regions.', meta: { owner: 'finance-team' } }),
    ],
    relationships: [], viewConfig: {}, readOnly: false, positionDraggable: true,
    fields: parseFieldsText('version: 1\ntables:\n  - grain\n  - purpose\n  - key: owner\n    label: Owner\n').list,
    ...overrides,
  }) as unknown as DisplaySubjectArea;

function postFromHost(data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
}

const sent = () => mockVsCode.postMessage.mock.calls.map((c) => c[0] as { type: string; payload?: unknown });
const button = () => screen.getByRole('button', { name: /^Under name:/ });
const openMenu = () => {
  fireEvent.click(button());
  return screen.getByRole('menu', { name: "The line under every table's name" });
};
const item = (name: string) => screen.getByRole('menuitemradio', { name });
/** What each table's line reads, from the nodes the canvas was given. */
const lines = () =>
  Object.fromEntries(
    useEditorStore.getState().nodes
      .filter((n) => n.type === 'model')
      .map((n) => [n.id, nodeSubtitle(n.data as { grain?: string; subtitle?: string | null }) ?? null]),
  );

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState(initialStoreState, true);
});

afterEach(() => cleanup());

describe('the toolbar "Under name" menu', () => {
  it('says Grain by default and lists the fields, what the tables carry, Description and Nothing', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea() });
    expect(button().getAttribute('aria-label')).toBe('Under name: Grain');
    const menu = openMenu();
    expect(within(menu).getAllByRole('menuitemradio').map((el) => el.textContent)).toEqual([
      '✓Grain', 'Purpose', 'Owner', 'steward', 'Description', 'Nothing',
    ]);
    expect(within(menu).getByRole('group', { name: 'Not in your list' }).textContent).toContain('steward');
    expect(item('Grain').getAttribute('aria-checked')).toBe('true');
    expect(item('Owner').getAttribute('aria-checked')).toBe('false');
  });

  it('a pick switches every table at once, posts setTableSubtitle and closes; the same pick posts nothing', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea() });
    expect(lines()).toEqual({ dim_customer: 'One row per customer', dim_region: null });
    mockVsCode.postMessage.mockClear();

    openMenu();
    fireEvent.click(item('Owner'));
    expect(useEditorStore.getState().tableSubtitle).toBe('field:owner');
    // No new diagram payload arrived: the choice alone redraws the tables.
    expect(lines()).toEqual({ dim_customer: 'crm-team', dim_region: 'finance-team' });
    expect(sent()).toEqual([{ type: 'setTableSubtitle', payload: { tableSubtitle: 'field:owner' } }]);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button().getAttribute('aria-label')).toBe('Under name: Owner');

    openMenu();
    fireEvent.click(item('Owner'));
    expect(sent()).toHaveLength(1);
  });

  it('Description shows each description, a value no list names shows by its key, Nothing shows no line', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea() });
    openMenu();
    fireEvent.click(item('Description'));
    expect(lines()).toEqual({ dim_customer: 'Every customer who has placed an order.', dim_region: 'Sales regions.' });
    openMenu();
    fireEvent.click(item('steward'));
    expect(sent().at(-1)).toEqual({ type: 'setTableSubtitle', payload: { tableSubtitle: 'field:steward' } });
    // A table with nothing written for it shows no line: never the grain in its place.
    expect(lines()).toEqual({ dim_customer: 'ana', dim_region: null });
    openMenu();
    fireEvent.click(item('Nothing'));
    expect(sent().at(-1)).toEqual({ type: 'setTableSubtitle', payload: { tableSubtitle: 'none' } });
    expect(lines()).toEqual({ dim_customer: null, dim_region: null });
  });

  it('is there on a read-only diagram and on the physical stage too', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea({ readOnly: true }) });
    expect(button()).toBeTruthy();
    postFromHost({ type: 'stageData', payload: subjectArea({ stage: 'physical', readOnly: true }) });
    openMenu();
    fireEvent.click(item('Purpose'));
    expect(sent().at(-1)).toEqual({ type: 'setTableSubtitle', payload: { tableSubtitle: 'field:purpose' } });
  });

  it('Escape closes it without choosing', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea() });
    mockVsCode.postMessage.mockClear();
    fireEvent.keyDown(openMenu(), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(sent()).toEqual([]);
  });
});

describe("the host's tableSubtitle message", () => {
  it('sets the store, the button and the tables; anything that is not a choice reads as the grain', () => {
    render(<App />);
    postFromHost({ type: 'tableSubtitle', payload: { tableSubtitle: 'field:owner' } });
    expect(useEditorStore.getState().tableSubtitle).toBe('field:owner');
    postFromHost({ type: 'domainLoaded', payload: subjectArea() });
    expect(button().getAttribute('aria-label')).toBe('Under name: Owner');
    expect(lines()).toEqual({ dim_customer: 'crm-team', dim_region: 'finance-team' });

    // A message with no usable payload changes nothing.
    postFromHost({ type: 'tableSubtitle' });
    postFromHost({ type: 'tableSubtitle', payload: { tableSubtitle: 7 } });
    expect(useEditorStore.getState().tableSubtitle).toBe('field:owner');

    postFromHost({ type: 'tableSubtitle', payload: { tableSubtitle: 'none' } });
    expect(lines()).toEqual({ dim_customer: null, dim_region: null });
    postFromHost({ type: 'tableSubtitle', payload: { tableSubtitle: 'Owner' } });
    expect(useEditorStore.getState().tableSubtitle).toBe('field:grain');
    expect(lines()).toEqual({ dim_customer: 'One row per customer', dim_region: null });
  });

  it('survives a new diagram payload and a stage switch (setDomain keeps the reader\'s choice)', () => {
    render(<App />);
    postFromHost({ type: 'tableSubtitle', payload: { tableSubtitle: 'description' } });
    postFromHost({ type: 'domainLoaded', payload: subjectArea() });
    postFromHost({ type: 'stageData', payload: subjectArea({ stage: 'physical', readOnly: true }) });
    expect(useEditorStore.getState().tableSubtitle).toBe('description');
    expect(lines().dim_region).toBe('Sales regions.');
  });

  it('a field from another project stays chosen and is named as missing, not silently dropped', () => {
    render(<App />);
    postFromHost({ type: 'tableSubtitle', payload: { tableSubtitle: 'field:cost_centre' } });
    postFromHost({ type: 'domainLoaded', payload: subjectArea() });
    expect(button().getAttribute('aria-label')).toBe('Under name: cost_centre');
    const menu = openMenu();
    expect(within(menu).getByRole('group', { name: 'Not in this project' }).textContent).toContain('cost_centre');
    expect(item('cost_centre').getAttribute('aria-checked')).toBe('true');
    expect(lines()).toEqual({ dim_customer: null, dim_region: null });
  });
});
