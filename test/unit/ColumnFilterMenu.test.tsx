// @vitest-environment jsdom
/**
 * ColumnFilterMenu — the toolbar's Columns control (#359), which replaced
 * the Names / Keys / All switch: one button saying what the tables show, and
 * a checklist of All columns, the three key kinds and a name pattern. A
 * column is shown when it matches any rule that is ticked; nothing ticked is
 * table names only. It drives the table detail level and the column filter,
 * and posts nothing to the host.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const mockVsCode = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => mockVsCode,
}));

import {
  ColumnFilterMenu, COLUMN_PATTERN_DEBOUNCE_MS, describeColumns,
} from '../../webview/components/Toolbar/ColumnFilterMenu';
import { useEditorStore } from '../../webview/store/editorStore';

const initialStoreState = useEditorStore.getState();

const col = (name: string, key: '' | 'pk' | 'fk' | 'nk' = '') => ({
  name, dataType: 'string', isPrimaryKey: key === 'pk', isForeignKey: key === 'fk', isNaturalKey: key === 'nk',
});
const table = (id: string, columns: ReturnType<typeof col>[]) => ({
  id, type: 'model', position: { x: 0, y: 0 },
  data: { modelName: id, stage: 'logical', layer: 'gold', columns, isStub: false },
});
const nodes = [
  table('fct_order', [col('order_id', 'pk'), col('customer_id', 'fk'), col('order_date'), col('amount')]),
  table('dim_customer', [col('customer_id', 'pk'), col('customer_code', 'nk'), col('created_date')]),
  table('dim_note', [col('note')]),
];

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState(initialStoreState, true);
  useEditorStore.setState({ nodes: nodes as never });
  useEditorStore.getState().setTableDetail('keys');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const button = () => screen.getByRole('button', { name: /^Columns/ });
const open = () => fireEvent.click(button());
const box = (name: string) => screen.getByRole('checkbox', { name: new RegExp(name) }) as HTMLInputElement;
const pattern = () => screen.getByRole('textbox', { name: 'Name matches' }) as HTMLInputElement;
const state = () => useEditorStore.getState();
const filter = () => state().columnFilter ?? null;
const level = () => state().tableDetail ?? null;
const ticks = () => [box('All columns').checked, box('Primary keys').checked, box('Foreign keys').checked, box('Natural').checked];
const summary = () => screen.getByRole('status').textContent;

describe('ColumnFilterMenu: the button', () => {
  it('says what the tables show, and is closed until pressed', () => {
    render(<ColumnFilterMenu />);
    expect(button().textContent).toBe('ColumnsKeys');
    expect(button().getAttribute('aria-label')).toBe('Columns: Keys');
    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();

    open();
    expect(screen.getByRole('dialog', { name: 'Columns to show' })).toBeTruthy();
    expect(button().getAttribute('aria-expanded')).toBe('true');
  });

  it('follows every state', () => {
    render(<ColumnFilterMenu />);
    act(() => { state().setTableDetail('all'); });
    expect(button().textContent).toBe('ColumnsAll');
    act(() => { state().setTableDetail('name'); });
    expect(button().textContent).toBe('ColumnsNames only');
    act(() => { state().setTableDetail('keys'); state().setColumnFilter({ primaryKeys: false, naturalKeys: false, namePattern: '*_at, Date' }); });
    expect(button().textContent).toBe('ColumnsFK, *_at, date');
  });

  it('before the diagram has loaded it says only "Columns"', () => {
    act(() => { state().setTableDetail(null); });
    render(<ColumnFilterMenu />);
    expect(button().textContent).toBe('Columns');
  });

  it('is the only column control: there is no Names / Keys / All switch', () => {
    render(<ColumnFilterMenu />);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

describe('ColumnFilterMenu: the three levels the switch had', () => {
  it('Keys: the three key kinds ticked', () => {
    render(<ColumnFilterMenu />);
    open();
    expect(ticks()).toEqual([false, true, true, true]);
    expect(pattern().value).toBe('');
    expect(summary()).toBe('4 columns in 2 of 3 tables');
  });

  it('All: "All columns" ticked, the rules set aside until it is unticked', () => {
    render(<ColumnFilterMenu />);
    open();
    fireEvent.click(box('All columns'));

    expect(level()).toBe('all');
    expect(box('All columns').checked).toBe(true);
    expect(box('Primary keys').disabled).toBe(true);
    expect(pattern().disabled).toBe(true);
    expect(summary()).toBe('8 columns in 3 of 3 tables');

    fireEvent.click(box('All columns'));
    expect(level()).toBe('keys');
    expect(box('Primary keys').disabled).toBe(false);
  });

  it('Names only: nothing ticked', () => {
    render(<ColumnFilterMenu />);
    open();
    fireEvent.click(box('Primary keys'));
    fireEvent.click(box('Foreign keys'));
    expect(level()).toBe('keys');
    fireEvent.click(box('Natural'));

    expect(level()).toBe('name');
    expect(ticks()).toEqual([false, false, false, false]);
    expect(summary()).toBe('0 columns in 0 of 3 tables');
    expect(button().textContent).toBe('ColumnsNames only');
  });

  it('from names only, ticking one rule shows just that rule', () => {
    act(() => { state().setTableDetail('name'); });
    render(<ColumnFilterMenu />);
    open();
    expect(ticks()).toEqual([false, false, false, false]);

    fireEvent.click(box('Foreign keys'));

    expect(level()).toBe('keys');
    expect(filter()).toEqual({ primaryKeys: false, foreignKeys: true, naturalKeys: false, namePattern: '' });
    expect(summary()).toBe('1 column in 1 of 3 tables');
  });

  it('unticking All goes back to the rules that were chosen, or to names only when there were none', () => {
    act(() => { state().setColumnFilter({ primaryKeys: false, naturalKeys: false }); state().setTableDetail('all'); });
    render(<ColumnFilterMenu />);
    open();
    fireEvent.click(box('All columns'));
    expect(level()).toBe('keys');
    expect(ticks()).toEqual([false, false, true, false]);
  });

  it('"Keys only" goes back to the three key kinds from anywhere', () => {
    act(() => { state().setColumnFilter({ primaryKeys: false, namePattern: 'date' }); });
    render(<ColumnFilterMenu />);
    open();
    const keysOnly = screen.getByRole('button', { name: 'Keys only' }) as HTMLButtonElement;
    expect(keysOnly.disabled).toBe(false);

    fireEvent.click(keysOnly);

    expect(filter()).toBeNull();
    expect(level()).toBe('keys');
    expect(pattern().value).toBe('');
    expect(keysOnly.disabled).toBe(true);

    fireEvent.click(box('All columns'));
    expect(keysOnly.disabled).toBe(false);
    fireEvent.click(keysOnly);
    expect(level()).toBe('keys');
  });
});

describe('ColumnFilterMenu: rules and the name pattern', () => {
  it('unticking a rule sets the filter and posts nothing', () => {
    render(<ColumnFilterMenu />);
    open();
    fireEvent.click(box('Primary keys'));

    expect(filter()).toEqual({ primaryKeys: false, foreignKeys: true, naturalKeys: true, namePattern: '' });
    expect(summary()).toBe('2 columns in 2 of 3 tables');
    expect(mockVsCode.postMessage).not.toHaveBeenCalled();
  });

  it('the pattern is applied a moment after typing stops, and says where it lands', () => {
    vi.useFakeTimers();
    act(() => { state().setTableDetail('name'); });
    render(<ColumnFilterMenu />);
    open();

    fireEvent.change(pattern(), { target: { value: '*_da' } });
    fireEvent.change(pattern(), { target: { value: '*_date' } });
    expect(level()).toBe('name');
    act(() => { vi.advanceTimersByTime(COLUMN_PATTERN_DEBOUNCE_MS); });

    expect(level()).toBe('keys');
    expect(filter()).toEqual({ primaryKeys: false, foreignKeys: false, naturalKeys: false, namePattern: '*_date' });
    expect(summary()).toBe('2 columns in 2 of 3 tables');
  });

  it('clearing the only rule left, the pattern, is names only', () => {
    act(() => { state().setColumnFilter({ primaryKeys: false, foreignKeys: false, naturalKeys: false, namePattern: 'date' }); });
    render(<ColumnFilterMenu />);
    open();
    fireEvent.change(pattern(), { target: { value: '' } });
    fireEvent.keyDown(pattern(), { key: 'Enter' });
    expect(level()).toBe('name');
  });

  it('Enter applies the pattern at once, and so does closing the menu', () => {
    vi.useFakeTimers();
    render(<ColumnFilterMenu />);
    open();
    fireEvent.change(pattern(), { target: { value: 'amount' } });
    fireEvent.keyDown(pattern(), { key: 'Enter' });
    expect(filter()?.namePattern).toBe('amount');

    fireEvent.change(pattern(), { target: { value: 'note' } });
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(filter()?.namePattern).toBe('note');
  });

  it('text no regex would accept is just text', () => {
    render(<ColumnFilterMenu />);
    open();
    for (const value of ['(', '*xyz*', '(a+)+$', '[']) {
      fireEvent.change(pattern(), { target: { value } });
      expect(() => fireEvent.keyDown(pattern(), { key: 'Enter' })).not.toThrow();
      expect(filter()?.namePattern).toBe(value);
    }
  });

  it('opens on the filter the diagram already has', () => {
    act(() => { state().setColumnFilter({ primaryKeys: false, namePattern: 'date, *_at' }); });
    render(<ColumnFilterMenu />);
    open();
    expect(ticks()).toEqual([false, false, true, true]);
    expect(pattern().value).toBe('date, *_at');
  });
});

describe('ColumnFilterMenu: what a change leaves alone', () => {
  it('a rule change at the same level keeps a table opened on its own open', () => {
    vi.useFakeTimers();
    state().toggleExpansion('fct_order');
    render(<ColumnFilterMenu />);
    open();

    fireEvent.click(box('Primary keys'));
    fireEvent.change(pattern(), { target: { value: 'date' } });
    act(() => { vi.advanceTimersByTime(COLUMN_PATTERN_DEBOUNCE_MS); });

    expect(filter()?.namePattern).toBe('date');
    expect([...state().expandedNodes]).toEqual(['fct_order']);
  });

  it('a change of level closes the tables opened on their own', () => {
    state().toggleExpansion('fct_order');
    render(<ColumnFilterMenu />);
    open();
    fireEvent.click(box('All columns'));
    expect(state().expandedNodes.size).toBe(0);
  });

  it('Escape closes it, hands focus back to the button, and drops a pattern still waiting', () => {
    vi.useFakeTimers();
    render(<ColumnFilterMenu />);
    open();
    fireEvent.change(pattern(), { target: { value: 'half_typ' } });
    fireEvent.keyDown(pattern(), { key: 'Escape' });
    act(() => { vi.advanceTimersByTime(COLUMN_PATTERN_DEBOUNCE_MS * 2); });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button());
    expect(filter()).toBeNull();
  });

  it('keys typed in the pattern box stay in the box', () => {
    const onKeyDown = vi.fn();
    render(<div onKeyDown={onKeyDown}><ColumnFilterMenu /></div>);
    open();
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete', 'a']) {
      fireEvent.keyDown(pattern(), { key });
    }
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it('the toolbar raises itself over the detail panel while the menu is open', () => {
    const css = readFileSync(join(__dirname, '../../webview/components/Toolbar/Toolbar.css'), 'utf8');
    const raised = css.split('\n').filter((l) => l.includes(':has(.toolbar__dropdown-menu'));
    expect(raised).toHaveLength(2);
    for (const line of raised) expect(line).toContain('.column-filter__panel');
  });

  it('says nothing about dbt, which a project may not have', () => {
    render(<ColumnFilterMenu />);
    open();
    expect(document.body.innerHTML.toLowerCase()).not.toContain('dbt');
  });
});

describe('describeColumns', () => {
  it('names each state in a few words', () => {
    expect(describeColumns(null, null)).toBe('');
    expect(describeColumns('all', { primaryKeys: false })).toBe('All');
    expect(describeColumns('name', null)).toBe('Names only');
    expect(describeColumns('keys', null)).toBe('Keys');
    expect(describeColumns('keys', { primaryKeys: false, foreignKeys: true, naturalKeys: true, namePattern: '' })).toBe('FK, NK');
    expect(describeColumns('keys', { primaryKeys: false, foreignKeys: false, naturalKeys: false, namePattern: ' Date ' })).toBe('date');
    expect(describeColumns('keys', { primaryKeys: false, foreignKeys: false, naturalKeys: false, namePattern: '' })).toBe('Names only');
  });
});
