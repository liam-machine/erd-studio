// @vitest-environment jsdom
/**
 * A column row's SCD type and additivity dropdowns. With `fieldVisibility`
 * (the Detail panel works it out from the field list with core's resolver),
 * each shows when its field is on the list and suits the table's role, or
 * has a value. Without it the row keeps the role gating it always had: SCD
 * for a dimension role, additive for a fact role, neither with no role. The
 * natural key's badge always shows.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { STARTING_FIELD_LIST, type DisplayColumn, type DisplaySubjectArea, type FieldList, type TableRole } from '@erd-studio/core';
import { ColumnRowEditor, type ColumnRowEditorColumn, type ColumnFieldVisibility } from '../../src/components/common/ColumnRowEditor';
import { columnFieldVisibility } from '../../src/components/DetailPanel/ColumnEditor';
import { createCanvasStore, CanvasStoreProvider } from '../../src/store/editorStore';
import { DetailPanel } from '../../src/components/DetailPanel/DetailPanel';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';

afterEach(cleanup);

const COLUMN: ColumnRowEditorColumn = { name: 'amount', dataType: 'decimal', description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: true };

function labelsOf(options: { modelRole?: TableRole; fieldVisibility?: ColumnFieldVisibility; column?: ColumnRowEditorColumn }): string[] {
  const { container } = render(
    <ColumnRowEditor
      column={options.column ?? COLUMN}
      mode="editable"
      modelRole={options.modelRole}
      fieldVisibility={options.fieldVisibility}
      expanded
      onToggleExpand={() => {}}
    />,
  );
  const labels = [...container.querySelectorAll('.column-row-editor__metadata-label')].map((el) => el.textContent ?? '');
  cleanup();
  return labels;
}

describe('ColumnRowEditor without fieldVisibility (the role gating it always had)', () => {
  it('SCD for a dimension role, additive for a fact role, neither with no role', () => {
    expect(labelsOf({ modelRole: 'conformed-dim' })).toEqual(['SCD Type']);
    expect(labelsOf({ modelRole: 'reference' })).toEqual(['SCD Type']);
    expect(labelsOf({ modelRole: 'transaction-fact' })).toEqual(['Additive']);
    expect(labelsOf({ modelRole: 'periodic-snapshot' })).toEqual(['Additive']);
    expect(labelsOf({})).toEqual([]);
  });
});

describe('ColumnRowEditor with fieldVisibility', () => {
  it('shows exactly the dropdowns it names, whatever the role', () => {
    expect(labelsOf({ modelRole: 'conformed-dim', fieldVisibility: { scdType: false, additiveType: true } })).toEqual(['Additive']);
    expect(labelsOf({ fieldVisibility: { scdType: true, additiveType: true } })).toEqual(['SCD Type', 'Additive']);
    expect(labelsOf({ modelRole: 'transaction-fact', fieldVisibility: {} })).toEqual([]);
  });

  it('never hides the natural key badge', () => {
    const { container } = render(
      <ColumnRowEditor column={COLUMN} mode="editable" fieldVisibility={{ naturalKey: false }} expanded onToggleExpand={() => {}} />,
    );
    expect(container.querySelector('.key-badge-group')!.textContent).toContain('NK');
  });
});

describe('columnFieldVisibility (from the field list)', () => {
  const col = (extra: Partial<DisplayColumn> = {}): DisplayColumn => ({ name: 'amount', dataType: 'decimal', description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: false, ...extra });

  it('the starting set: both with no role, one per role kind', () => {
    expect(columnFieldVisibility(col(), {}, STARTING_FIELD_LIST)).toEqual({ scdType: true, additiveType: true, naturalKey: true });
    expect(columnFieldVisibility(col(), { modelRole: 'conformed-dim' }, STARTING_FIELD_LIST)).toEqual({ scdType: true, additiveType: false, naturalKey: true });
    expect(columnFieldVisibility(col(), { modelRole: 'transaction-fact' }, STARTING_FIELD_LIST)).toEqual({ scdType: false, additiveType: true, naturalKey: true });
  });

  it('a list without the fields hides them, unless the column has a value', () => {
    const none: FieldList = { tables: [], columns: [], leftOut: [] };
    expect(columnFieldVisibility(col(), {}, none)).toEqual({ scdType: false, additiveType: false, naturalKey: false });
    expect(columnFieldVisibility(col({ scdType: 2, isNaturalKey: true }), { modelRole: 'transaction-fact' }, none))
      .toEqual({ scdType: true, additiveType: false, naturalKey: true });
  });
});

describe('ColumnEditor in the Detail panel', () => {
  function expandedLabels(domain: DisplaySubjectArea, viewer?: boolean): string[] {
    const store = createCanvasStore({ domain, selectedNode: 'fct_order', detailPanelOpen: true });
    const panel = <ReactFlowProvider><DetailPanel /></ReactFlowProvider>;
    const { container } = render(
      <CanvasStoreProvider store={store}>
        {viewer === undefined ? panel : <CanvasEnvironmentProvider host={{ postMessage: () => {} }} viewer={viewer}>{panel}</CanvasEnvironmentProvider>}
      </CanvasStoreProvider>,
    );
    fireEvent.click(container.querySelector('.column-row-editor__chevron')!);
    return [...container.querySelectorAll('.column-row-editor__metadata-label')].map((el) => el.textContent ?? '');
  }
  const domainWith = (columnExtra: Partial<DisplayColumn>, extra: Partial<DisplaySubjectArea> = {}, modelRole?: TableRole): DisplaySubjectArea => ({
    schemaVersion: 5, domain: 'sales', layer: 'gold', stage: 'logical', description: '', viewConfig: {}, readOnly: false, positionDraggable: true,
    models: [{
      name: 'fct_order', schema: '', description: '', ...(modelRole ? { modelRole } : {}),
      columns: [{ name: 'amount', dataType: 'decimal', description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: false, ...columnExtra }],
    }],
    relationships: [],
    ...extra,
  } as DisplaySubjectArea);

  it('follows the field list: a fact table shows Additive; a list without SCD type still shows a column that has one', () => {
    expect(expandedLabels(domainWith({}, {}, 'transaction-fact'))).toEqual(['Additive']);
    cleanup();
    const noScd: FieldList = { tables: [], columns: STARTING_FIELD_LIST.columns.filter((f) => f.key !== 'scd_type'), leftOut: [] };
    expect(expandedLabels(domainWith({ scdType: 1 }, { fields: noScd }, 'transaction-fact'))).toEqual(['SCD Type', 'Additive']);
  });

  it('a table with no role: the editor offers both, but the viewer and a read-only stage show only fields with a value', () => {
    expect(expandedLabels(domainWith({}))).toEqual(['SCD Type', 'Additive']);
    cleanup();
    expect(expandedLabels(domainWith({}), true)).toEqual([]);
    cleanup();
    expect(expandedLabels(domainWith({}, { readOnly: true, stage: 'physical' }))).toEqual([]);
    cleanup();
    expect(expandedLabels(domainWith({ scdType: 2 }), true)).toEqual(['SCD Type']);
    cleanup();
    expect(expandedLabels(domainWith({ additiveType: 'additive' }, { readOnly: true, stage: 'physical' }))).toEqual(['Additive']);
  });
});
