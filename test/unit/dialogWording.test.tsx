// @vitest-environment jsdom
/**
 * Plain words in the editor's dialogs and tabs:
 *  - New Relationship asks "How many?" with options named after the chosen
 *    tables; the N:1 notation is only in each option's tooltip; the context
 *    menu says Many-to-one / One-to-many / One-to-one / Many-to-many;
 *  - New Table puts the name first, then "Starter columns (optional)" with
 *    Blank first and a one-line hint on each template;
 *  - the stage tabs say "Logical · your design" and "Physical · read from dbt".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const mockPostMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage: mockPostMessage, getState: vi.fn(), setState: vi.fn() }),
  getVsCodeApi: () => ({ postMessage: mockPostMessage, getState: vi.fn(), setState: vi.fn() }),
}));
vi.mock('@xyflow/react', () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { NewFkDialog } from '../../webview/components/NewFkDialog/NewFkDialog';
import { NewTableDialog, STARTER_COLUMNS_LABEL, starterOptionText, starterOrder } from '../../webview/components/NewModelDialog/NewModelDialog';
import { StageTabs, STAGE_LABELS } from '../../webview/components/Toolbar/StageTabs';
import { CARDINALITY_NAMES, HOW_MANY_LABEL, cardinalityChoice } from '../../webview/lib/relationshipDialog';
import { useEditorStore } from '../../webview/store/editorStore';

const initial = useEditorStore.getState();
const col = (name: string, isPrimaryKey = false) => ({ name, dataType: 'string', description: '', isPrimaryKey, isForeignKey: false, isNaturalKey: false });
const TEMPLATES = [
  { id: 'dimension', label: 'Dimension', prefix: 'dim_', description: 'Standard dimension table', columns: [] },
  { id: 'fact', label: 'Fact', prefix: 'fct_', description: 'Transactional fact table', columns: [] },
  { id: 'blank', label: 'Blank', prefix: '', description: 'Empty table', columns: [] },
  { id: 'team_audit', label: 'Audit', prefix: '', description: 'Our audit columns', columns: [] },
];

beforeEach(() => {
  mockPostMessage.mockClear();
  useEditorStore.setState(initial, true);
  useEditorStore.setState({
    domain: {
      domain: 'd', layer: 'gold', stage: 'logical', readOnly: false, viewConfig: { positions: {} },
      models: [
        { name: 'fct_order', columns: [col('order_key', true), col('customer_key')] },
        { name: 'dim_customer', columns: [col('customer_key', true)] },
      ],
      relationships: [],
    } as never,
    templates: TEMPLATES as never,
  });
});
afterEach(cleanup);

describe('relationship cardinality: one vocabulary', () => {
  it('phrases each choice with the tables, keeping the notation for the tooltip', () => {
    expect(cardinalityChoice('many-to-one', 'fct_order', 'dim_customer')).toEqual({ text: 'Many fct_order rows → one dim_customer', title: 'Many-to-one (N:1, *→1)' });
    expect(cardinalityChoice('one-to-one', 'customer', 'profile')).toEqual({ text: 'One customer row → one profile', title: 'One-to-one (1:1)' });
    expect(cardinalityChoice('many-to-many', 'a', 'b').text).toBe('Many → many');
    expect(cardinalityChoice('many-to-one', '', '').text).toBe('Many → one');
    expect(Object.values(CARDINALITY_NAMES)).toEqual(['Many-to-one', 'One-to-many', 'One-to-one', 'Many-to-many']);
  });

  it('the New Relationship dialog asks "How many?" in those words', () => {
    useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' });
    render(<NewFkDialog />);
    const select = screen.getByLabelText(HOW_MANY_LABEL) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Many fct_order rows → one dim_customer', 'One fct_order row → one dim_customer', 'Many → many']);
    expect(select.options[0].title).toBe('Many-to-one (N:1, *→1)');
    expect(screen.queryByText('Cardinality')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\*→1|1→1|\*↔\*/);
  });
});

describe('New Table dialog', () => {
  it('Blank comes first, and each template has a one-line hint', () => {
    expect(starterOrder(TEMPLATES).map((t) => t.id)).toEqual(['blank', 'dimension', 'fact', 'team_audit']);
    expect(starterOptionText(TEMPLATES[0])).toBe('Dimension — something you describe (customer, product)');
    expect(starterOptionText(TEMPLATES[1])).toBe('Fact — something that happens (an order, a payment)');
    // A project's own template is described by its own description.
    expect(starterOptionText(TEMPLATES[3])).toBe('Audit — Our audit columns');
  });

  it('asks for the table name first, then the optional starter columns', () => {
    act(() => { useEditorStore.getState().setNewModelDialogOpen(true); });
    render(<NewTableDialog />);
    const labels = [...document.querySelectorAll('.new-model-dialog__label')].map((l) => l.textContent?.trim());
    expect(labels.slice(0, 2)).toEqual(['Table Name', STARTER_COLUMNS_LABEL]);
    expect(STARTER_COLUMNS_LABEL).toBe('Starter columns (optional)');
    const select = screen.getByLabelText(STARTER_COLUMNS_LABEL) as HTMLSelectElement;
    expect(select.options[0].textContent).toBe('Blank — no columns yet');
    expect(select.value).toBe('blank');
    expect(screen.queryByText('Template')).toBeNull();
  });
});

describe('stage tabs', () => {
  it('say what each stage is, as the wording rules explain them', () => {
    render(<StageTabs activeStage="physical" readOnly />);
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.replace('🔒', '').trim());
    expect(tabs).toEqual(['Logical· your design', 'Physical· read from dbt']);
    expect(STAGE_LABELS.map((s) => `${s.label} · ${s.hint}`)).toEqual(['Logical · your design', 'Physical · read from dbt']);
    expect(screen.getAllByRole('tab')[1].getAttribute('title')).toBe('Read from dbt: what your dbt project has. Read-only, never saved (Alt+2)');
  });
});
