// @vitest-environment jsdom
/**
 * The Detail panel's "Sample data" section: a table's sample rows (its DBML
 * file's records block), read-only, logical stage only.
 *
 * - A table with no rows (the field absent, or no row in it), and any table
 *   on the physical stage, draws exactly the panel it drew before.
 * - Each value is shown as written: null and an empty field as a muted NULL,
 *   an empty string as (empty), a number right-aligned as written, an
 *   expression with its backticks, a line break as ↵, a long value cut with
 *   its first 1,000 characters in the tooltip.
 * - One line per column, in the order of the table's Columns, whatever order
 *   the rows name them in; a column the rows name that the table lacks last.
 * - The first 10 rows, then "Showing 10 of N rows in the table file."
 * - A fold: open in the editor, closed in the viewer, and kept as it is from
 *   table to table. It posts nothing and logs nothing.
 * - Its scroll region can be reached and scrolled from the keyboard, and
 *   takes the wheel and the drag from the canvas (nowheel, nopan).
 * - It follows the payload: a new payload that changes only the rows redraws it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { CanvasEditMessage, DisplaySubjectArea, DisplayTable, SampleCell, SampleData } from '@erd-studio/core';
import { createCanvasStore, CanvasStoreProvider } from '../../src/store/editorStore';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';
import { DetailPanel } from '../../src/components/DetailPanel/DetailPanel';
import { SAMPLE_CELL_TITLE_LIMIT, sampleDataLines } from '../../src/components/DetailPanel/SampleDataSection';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const col = (name: string, isPrimaryKey = false) => ({ name, dataType: 'varchar', description: '', isPrimaryKey, isForeignKey: false, isNaturalKey: false });
const str = (text: string): SampleCell => ({ text, kind: 'string' });
const num = (text: string): SampleCell => ({ text, kind: 'number' });

const PRODUCT_COLUMNS = ['product_key', 'product_name', 'list_price', 'is_active', 'launched_on', 'status'].map((n, i) => col(n, i === 0));

/** Rows as core reads them from a table file. */
const PRODUCT_ROWS: SampleData = {
  columns: ['product_key', 'product_name', 'list_price', 'is_active', 'launched_on', 'status'],
  rows: [
    // 1, "dq", 5., TRUE, `now()`, status.active
    [num('1'), str('dq'), num('5.'), { text: 'TRUE', kind: 'boolean' }, { text: '`now()`', kind: 'expression' }, { text: 'status.active', kind: 'enum' }],
    // -5, '', 007, NuLL, (an empty field), 'two\nlines'
    [num('-5'), str(''), num('007'), null, null, str('two\nlines')],
  ],
  totalRows: 2,
};

function domain(models: DisplayTable[], stage: 'logical' | 'physical' = 'logical'): DisplaySubjectArea {
  return {
    schemaVersion: 7, domain: 'shop', layer: 'gold', stage, description: '', viewConfig: {},
    readOnly: stage === 'physical', positionDraggable: true,
    models,
    relationships: [{ fromModel: 'fct_sale', fromColumn: 'product_key', toModel: 'dim_product', toColumn: 'product_key', cardinality: 'many-to-one' }],
  } as DisplaySubjectArea;
}

function product(extra: Partial<DisplayTable> = {}): DisplayTable {
  return { name: 'dim_product', schema: 'gold', description: 'Products', columns: PRODUCT_COLUMNS, ...extra } as DisplayTable;
}

function sale(extra: Partial<DisplayTable> = {}): DisplayTable {
  return { name: 'fct_sale', schema: 'gold', description: 'Sales', columns: [col('sale_key', true), col('product_key')], ...extra } as DisplayTable;
}

function renderPanel(models: DisplayTable[], options: { viewer?: boolean; stage?: 'logical' | 'physical'; selected?: string } = {}) {
  const posted: CanvasEditMessage[] = [];
  const host = { postMessage: vi.fn((m: CanvasEditMessage) => { posted.push(m); }) };
  const store = createCanvasStore({
    domain: domain(models, options.stage),
    selectedNode: options.selected ?? 'dim_product',
    detailPanelOpen: true,
  });
  const utils = render(
    <CanvasStoreProvider store={store}>
      <CanvasEnvironmentProvider host={host} viewer={options.viewer ?? false}>
        <ReactFlowProvider><DetailPanel /></ReactFlowProvider>
      </CanvasEnvironmentProvider>
    </CanvasStoreProvider>,
  );
  const section = () => utils.container.querySelector<HTMLElement>('.sample-data');
  const toggle = () => utils.container.querySelector<HTMLButtonElement>('.sample-data__toggle');
  const body = () => utils.container.querySelector<HTMLElement>('.sample-data__body');
  const line = (column: string) => [...utils.container.querySelectorAll<HTMLTableRowElement>('.sample-data__line')]
    .find((tr) => tr.querySelector('th')!.textContent === column)!;
  return { ...utils, store, posted, host, section, toggle, body, line };
}

describe('nothing to show: the panel is the one it was', () => {
  it.each([false, true])('a table with no rows draws the same HTML (viewer: %s)', (viewer) => {
    const absent = renderPanel([product(), sale()], { viewer }).container.innerHTML;
    cleanup();
    const noRows = renderPanel([product({ sampleData: { columns: ['product_key'], rows: [], totalRows: 0 } }), sale()], { viewer }).container.innerHTML;
    cleanup();
    expect(noRows).toBe(absent);
    expect(absent).not.toContain('sample-data');
  });

  it.each([false, true])('the physical stage never shows rows, even if a payload carried them (viewer: %s)', (viewer) => {
    const absent = renderPanel([product(), sale()], { viewer, stage: 'physical' }).container.innerHTML;
    cleanup();
    const carried = renderPanel([product({ sampleData: PRODUCT_ROWS }), sale()], { viewer, stage: 'physical' }).container.innerHTML;
    expect(carried).toBe(absent);
  });
});

describe('the cells', () => {
  it('show each value as written, one line each', () => {
    const { line } = renderPanel([product({ sampleData: PRODUCT_ROWS }), sale()]);
    const cells = (column: string) => [...line(column).querySelectorAll('td')];

    // A double-quoted string, and an empty string.
    expect(cells('product_name').map((td) => td.textContent)).toEqual(['dq', '(empty)']);
    expect(cells('product_name')[1].querySelector('em.fields-section__empty-value')).not.toBeNull();
    // Numbers as written (never 5 or 7), right-aligned with tabular figures.
    expect(cells('product_key').map((td) => td.textContent)).toEqual(['1', '-5']);
    expect(cells('list_price').map((td) => td.textContent)).toEqual(['5.', '007']);
    expect(cells('list_price').every((td) => td.classList.contains('sample-data__cell--number'))).toBe(true);
    // A boolean as written; NuLL and an empty field as a muted NULL, read out as null.
    expect(cells('is_active').map((td) => td.textContent)).toEqual(['TRUE', 'NULL']);
    expect(cells('is_active')[1].classList.contains('sample-data__cell--null')).toBe(true);
    expect(cells('is_active')[1].getAttribute('aria-label')).toBe('null');
    expect(cells('launched_on')[1].getAttribute('aria-label')).toBe('null');
    // An expression with its backticks, in monospace.
    expect(cells('launched_on')[0].textContent).toBe('`now()`');
    expect(cells('launched_on')[0].classList.contains('sample-data__cell--expression')).toBe(true);
    // An Enum reference as written; a line break as ↵, the tooltip keeping the text.
    expect(cells('status').map((td) => td.textContent)).toEqual(['status.active', 'two↵lines']);
    expect(cells('status')[1].getAttribute('title')).toBe('two\nlines');
  });

  it('a long value is cut on screen, its first 1,000 characters in the tooltip', () => {
    const long = 'x'.repeat(SAMPLE_CELL_TITLE_LIMIT + 500);
    const { line } = renderPanel([product({ sampleData: { columns: ['product_name'], rows: [[str(long)]], totalRows: 1 } }), sale()]);
    const td = line('product_name').querySelector('td')!;
    expect(td.textContent).toBe(long);
    expect(td.getAttribute('title')).toBe('x'.repeat(SAMPLE_CELL_TITLE_LIMIT));
  });
});

describe('the lines', () => {
  it('follow the table\'s Columns, whatever order the rows name them in, listing only the columns the rows hold', () => {
    const data: SampleData = { columns: ['launched_on', 'PRODUCT_KEY'], rows: [[str('2020-01-15'), num('1')]], totalRows: 1 };
    const { container } = renderPanel([product({ sampleData: data }), sale()]);
    expect([...container.querySelectorAll('.sample-data__line th')].map((th) => th.textContent)).toEqual(['product_key', 'launched_on']);
  });

  it('a column the rows name that the table lacks goes last', () => {
    const data: SampleData = { columns: ['retired_code', 'product_name'], rows: [[str('R1'), str('Widget')]], totalRows: 1 };
    expect(sampleDataLines(PRODUCT_COLUMNS, data).map((l) => [l.column, l.cells.map((c) => c?.text)])).toEqual([
      ['product_name', ['Widget']],
      ['retired_code', ['R1']],
    ]);
  });
});

describe('the row count', () => {
  const rows = (n: number, total = n): SampleData => ({
    columns: ['product_key'],
    rows: Array.from({ length: n }, (_, i) => [num(String(i + 1))]),
    totalRows: total,
  });

  it('shows the first 10 rows and says how many the file holds', () => {
    const { section, container } = renderPanel([product({ sampleData: rows(24) }), sale()]);
    expect(section()!.querySelector('.sample-data__toggle')!.textContent).toBe('Sample data (24 rows)');
    expect(container.querySelectorAll('.sample-data__row-number')).toHaveLength(10);
    expect(container.querySelector('.sample-data__line')!.querySelectorAll('td')).toHaveLength(10);
    expect(container.querySelector('.sample-data__more')!.textContent).toBe('Showing 10 of 24 rows in the table file.');
  });

  it('counts rows past what core carries', () => {
    const { container, section } = renderPanel([product({ sampleData: rows(100, 250) }), sale()]);
    expect(section()!.querySelector('.sample-data__count')!.textContent).toBe('(250 rows)');
    expect(container.querySelector('.sample-data__more')!.textContent).toBe('Showing 10 of 250 rows in the table file.');
  });

  it('says nothing more when every row is shown', () => {
    const { container, section } = renderPanel([product({ sampleData: rows(1) }), sale()]);
    expect(section()!.querySelector('.sample-data__count')!.textContent).toBe('(1 row)');
    expect(container.querySelector('.sample-data__more')).toBeNull();
  });
});

describe('the fold', () => {
  it('is open in the editor, after Columns and before Relationships', () => {
    const { container, toggle, body } = renderPanel([product({ sampleData: PRODUCT_ROWS }), sale()]);
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true');
    expect(body()!.hidden).toBe(false);
    const order = [...container.querySelectorAll('.detail-panel__section--columns, .sample-data, .detail-panel__section--relationships')].map((el) => el.className.split(' ').find((c) => c === 'sample-data' || c.startsWith('detail-panel__section--')));
    expect(order).toEqual(['detail-panel__section--columns', 'sample-data', 'detail-panel__section--relationships']);
  });

  it('is closed in the viewer, after Columns there too, and opens and closes without a post', () => {
    const { container, toggle, body, host } = renderPanel([product({ sampleData: PRODUCT_ROWS }), sale()], { viewer: true });
    expect(toggle()!.getAttribute('aria-expanded')).toBe('false');
    expect(body()!.hidden).toBe(true);
    const order = [...container.querySelectorAll('.detail-panel__section--columns, .sample-data, .detail-panel__section--relationships')].map((el) => el.className.split(' ').find((c) => c === 'sample-data' || c.startsWith('detail-panel__section--')));
    expect(order).toEqual(['detail-panel__section--columns', 'sample-data', 'detail-panel__section--relationships']);
    fireEvent.click(toggle()!);
    expect(body()!.hidden).toBe(false);
    fireEvent.click(toggle()!);
    expect(body()!.hidden).toBe(true);
    // Scrolling and selecting in the region post nothing either.
    fireEvent.wheel(container.querySelector('.sample-data__scroll')!, { deltaX: 40 });
    fireEvent.mouseDown(container.querySelector('.sample-data__cell')!);
    expect(host.postMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps its state from table to table (viewer: %s)', (viewer) => {
    const { toggle, store } = renderPanel([product({ sampleData: PRODUCT_ROWS }), sale({ sampleData: { columns: ['sale_key'], rows: [[num('9')]], totalRows: 1 } })], { viewer });
    fireEvent.click(toggle()!);
    const state = toggle()!.getAttribute('aria-expanded');
    act(() => { store.setState({ selectedNode: 'fct_sale' }); });
    expect(toggle()!.getAttribute('aria-expanded')).toBe(state);
    act(() => { store.setState({ selectedNode: 'dim_product' }); });
    expect(toggle()!.getAttribute('aria-expanded')).toBe(state);
  });
});

describe('accessibility', () => {
  it('a labelled region reached and scrolled from the keyboard, which the canvas does not pan or zoom under', () => {
    const { container, toggle } = renderPanel([product({ sampleData: PRODUCT_ROWS }), sale()]);
    const region = container.querySelector<HTMLElement>('.sample-data__scroll')!;
    expect(region.getAttribute('role')).toBe('region');
    expect(region.tabIndex).toBe(0);
    expect(region.getAttribute('aria-label')).toBe('Sample data for dim_product');
    expect(region.classList.contains('nowheel')).toBe(true);
    expect(region.classList.contains('nopan')).toBe(true);
    expect(container.querySelector('caption')!.textContent).toBe('The first 2 sample rows of dim_product: one line per column, one column per row.');
    expect([...container.querySelectorAll('.sample-data__line > th')].every((th) => th.getAttribute('scope') === 'row')).toBe(true);
    expect([...container.querySelectorAll('thead th')].every((th) => th.getAttribute('scope') === 'col')).toBe(true);
    expect(toggle()!.getAttribute('aria-controls')).toBe(container.querySelector('.sample-data__body')!.id);
  });
});

describe('it follows the payload', () => {
  it('a payload that changes only the rows of the selected table redraws the section', () => {
    const { store, line, section } = renderPanel([product({ sampleData: PRODUCT_ROWS }), sale()]);
    expect([...line('product_name').querySelectorAll('td')].map((td) => td.textContent)).toEqual(['dq', '(empty)']);
    const changed: SampleData = { ...PRODUCT_ROWS, rows: [...PRODUCT_ROWS.rows, [num('3'), str('Green gizmo'), num('7.25'), null, null, null]], totalRows: 3 };
    act(() => { store.getState().setDomain(domain([product({ sampleData: changed }), sale()])); });
    expect([...line('product_name').querySelectorAll('td')].map((td) => td.textContent)).toEqual(['dq', '(empty)', 'Green gizmo']);
    expect(section()!.querySelector('.sample-data__count')!.textContent).toBe('(3 rows)');
    // And goes when the rows go.
    act(() => { store.getState().setDomain(domain([product(), sale()])); });
    expect(section()).toBeNull();
  });
});

describe('values go nowhere but the page', () => {
  it('rendering, opening and switching tables logs nothing', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level));
    const { toggle, store } = renderPanel([product({ sampleData: PRODUCT_ROWS }), sale()], { viewer: true });
    fireEvent.click(toggle()!);
    act(() => { store.setState({ selectedNode: 'fct_sale' }); });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('the section parses no value, reads no clock or locale, logs nothing, posts nothing and copies nothing', () => {
    const source = readFileSync(join(__dirname, '../../src/components/DetailPanel/SampleDataSection.tsx'), 'utf8');
    for (const forbidden of [/JSON\.parse/, /\bNumber\b/, /\bBigInt\b/, /\bDate\b/, /\bIntl\b/, /\bconsole\b/, /postMessage/, /useCanvasHost/, /clipboard/i, /toLocale/]) {
      expect(source, String(forbidden)).not.toMatch(forbidden);
    }
  });
});
