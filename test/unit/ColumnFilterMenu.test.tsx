// @vitest-environment jsdom
/**
 * ColumnFilterMenu — the button beside Names / Keys / All that chooses which
 * columns the Keys level shows (#359): three key rules and a name pattern,
 * any of which shows a column. Changing a rule puts the diagram at Keys;
 * nothing is posted to the host; and the level switch's arrow keys stay out
 * of the pattern box.
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
  ColumnFilterMenu, COLUMN_PATTERN_DEBOUNCE_MS, describeColumnFilter,
} from '../../webview/components/Toolbar/ColumnFilterMenu';
import { TableDetailSwitch } from '../../webview/components/Toolbar/TableDetailSwitch';
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
  useEditorStore.getState().setTableDetail('all');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const button = () => screen.getByRole('button', { name: /Choose the columns Keys shows/ });
const open = () => fireEvent.click(button());
const box = (name: string) => screen.getByRole('checkbox', { name: new RegExp(name) }) as HTMLInputElement;
const pattern = () => screen.getByRole('textbox', { name: 'Name matches' }) as HTMLInputElement;
const filter = () => useEditorStore.getState().columnFilter ?? null;

describe('ColumnFilterMenu', () => {
  it('is closed until its button is pressed, then lists the three key rules, all on, and an empty pattern', () => {
    render(<ColumnFilterMenu />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button().getAttribute('aria-expanded')).toBe('false');

    open();

    expect(screen.getByRole('dialog', { name: 'Columns shown at Keys' })).toBeTruthy();
    expect(button().getAttribute('aria-expanded')).toBe('true');
    expect([box('Primary keys').checked, box('Foreign keys').checked, box('Natural').checked]).toEqual([true, true, true]);
    expect(pattern().value).toBe('');
    expect(screen.getByRole('status').textContent).toBe('4 columns in 2 of 3 tables');
  });

  it('unticking a rule sets the filter, puts the diagram at Keys, and posts nothing', () => {
    render(<ColumnFilterMenu />);
    open();

    fireEvent.click(box('Primary keys'));

    expect(filter()).toEqual({ primaryKeys: false, foreignKeys: true, naturalKeys: true, namePattern: '' });
    expect(useEditorStore.getState().tableDetail).toBe('keys');
    expect(screen.getByRole('status').textContent).toBe('2 columns in 2 of 3 tables');
    expect(mockVsCode.postMessage).not.toHaveBeenCalled();
  });

  it('the pattern is applied a moment after typing stops, and says where it lands', () => {
    vi.useFakeTimers();
    render(<ColumnFilterMenu />);
    open();
    fireEvent.click(box('Primary keys'));
    fireEvent.click(box('Foreign keys'));
    fireEvent.click(box('Natural'));

    fireEvent.change(pattern(), { target: { value: '*_da' } });
    fireEvent.change(pattern(), { target: { value: '*_date' } });
    expect(filter()?.namePattern).toBe('');
    act(() => { vi.advanceTimersByTime(COLUMN_PATTERN_DEBOUNCE_MS); });

    expect(filter()).toEqual({ primaryKeys: false, foreignKeys: false, naturalKeys: false, namePattern: '*_date' });
    expect(screen.getByRole('status').textContent).toBe('2 columns in 2 of 3 tables');
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

  it('Reset goes back to the three key kinds', () => {
    render(<ColumnFilterMenu />);
    open();
    const reset = screen.getByRole('button', { name: 'Reset' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    fireEvent.click(box('Foreign keys'));
    fireEvent.change(pattern(), { target: { value: 'date' } });
    fireEvent.keyDown(pattern(), { key: 'Enter' });
    expect(reset.disabled).toBe(false);

    fireEvent.click(reset);

    expect(filter()).toBeNull();
    expect(pattern().value).toBe('');
    expect(box('Foreign keys').checked).toBe(true);
  });

  it('opens on the filter the diagram already has, and its button says the rules are not the default', () => {
    useEditorStore.getState().setColumnFilter({ primaryKeys: false, namePattern: 'date, *_at' });
    render(<ColumnFilterMenu />);

    expect(button().className).toContain('column-filter__button--custom');
    expect(button().title).toBe('Choose the columns Keys shows. Now: foreign keys, natural (business) keys, names matching date, *_at');
    open();
    expect(box('Primary keys').checked).toBe(false);
    expect(pattern().value).toBe('date, *_at');
  });

  it('Escape closes it and hands focus back to the button', () => {
    render(<ColumnFilterMenu />);
    open();
    fireEvent.keyDown(pattern(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it('the arrow keys in the pattern box do not choose a level', () => {
    useEditorStore.getState().setTableDetail('keys');
    render(<div><TableDetailSwitch /><ColumnFilterMenu /></div>);
    open();
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      fireEvent.keyDown(pattern(), { key });
    }
    expect(useEditorStore.getState().tableDetail).toBe('keys');
  });
});

describe('describeColumnFilter', () => {
  it('names the rules that are on', () => {
    expect(describeColumnFilter(null)).toBe('primary keys, foreign keys, natural (business) keys');
    expect(describeColumnFilter({ primaryKeys: false, foreignKeys: false, naturalKeys: false, namePattern: '' })).toBe('no columns');
    expect(describeColumnFilter({ primaryKeys: false, foreignKeys: false, naturalKeys: false, namePattern: ' Date ' })).toBe('names matching date');
  });
});

describe('ColumnFilterMenu: what a change leaves alone', () => {
  it('already at Keys, a table opened on its own stays open through ticks and typing', () => {
    vi.useFakeTimers();
    useEditorStore.getState().setTableDetail('keys');
    useEditorStore.getState().toggleExpansion('fct_order');
    render(<ColumnFilterMenu />);
    open();

    fireEvent.click(box('Primary keys'));
    fireEvent.change(pattern(), { target: { value: 'date' } });
    act(() => { vi.advanceTimersByTime(COLUMN_PATTERN_DEBOUNCE_MS); });

    expect(filter()?.namePattern).toBe('date');
    expect([...useEditorStore.getState().expandedNodes]).toEqual(['fct_order']);
  });

  it('Escape drops a pattern still waiting for its pause', () => {
    vi.useFakeTimers();
    render(<ColumnFilterMenu />);
    open();
    fireEvent.change(pattern(), { target: { value: 'half_typ' } });
    fireEvent.keyDown(pattern(), { key: 'Escape' });
    act(() => { vi.advanceTimersByTime(COLUMN_PATTERN_DEBOUNCE_MS * 2); });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(filter()).toBeNull();
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
