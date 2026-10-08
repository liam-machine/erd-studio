// @vitest-environment jsdom
/**
 * The New Relationship dialog says which side holds the foreign key and why,
 * asks when nothing says, and offers to mark the "one" side's key (#133 L1).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

const postMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage, getState: vi.fn(), setState: vi.fn() }),
  getVsCodeApi: () => ({ postMessage, getState: vi.fn(), setState: vi.fn() }),
}));
vi.mock('@xyflow/react', () => ({ Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { NewFkDialog } from '../../webview/components/NewFkDialog/NewFkDialog';
import { useEditorStore } from '../../webview/store/editorStore';
import { orientDraggedRelationship } from '../../webview/lib/relationshipDirection';
import type { DbtKeyHint } from '@erd-studio/core';

type Col = { name: string; dataType: string; description: string; isPrimaryKey: boolean; isForeignKey: boolean; isNaturalKey: boolean; dbtKey?: DbtKeyHint };
const col = (name: string, extra: Partial<Col> = {}): Col =>
  ({ name, dataType: 'string', description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: false, ...extra });
const unique: DbtKeyHint = { key: 'unique', because: 'unique-test' };

function open(models: Array<{ name: string; columns: Col[] }>, drag: { fromModel: string; fromColumn: string; toModel: string; toColumn: string }) {
  useEditorStore.setState({
    domain: { schemaVersion: 5, domain: 'd', layer: 'silver', stage: 'logical', description: '', readOnly: false, viewConfig: {}, models, relationships: [] } as never,
  });
  useEditorStore.getState().openFkDialogWithPrefill(orientDraggedRelationship(drag, models));
  render(<NewFkDialog />);
}
const create = () => screen.getByRole('button', { name: /Create/ }) as HTMLButtonElement;
const sent = () => postMessage.mock.calls.map(([m]) => m).filter((m) => m.type === 'addRelationship').map((m) => m.payload);

beforeEach(() => postMessage.mockClear());
afterEach(cleanup);

describe('NewFkDialog — which side holds the foreign key (#133 L1)', () => {
  const bare = [{ name: 'dim_customer', columns: [col('customer_id')] }, { name: 'fct_order', columns: [col('customer_id')] }];
  const drag = { fromModel: 'dim_customer', fromColumn: 'customer_id', toModel: 'fct_order', toColumn: 'customer_id' };

  it('with no evidence, asks with two choices named after the models, no default, and Create disabled until one is picked', () => {
    open(bare, drag);
    expect(screen.getByText('Which side holds the foreign key?')).toBeTruthy();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([false, false]);
    expect(screen.getByText('Each dim_customer row points at one fct_order')).toBeTruthy();
    expect(screen.getByText('Each fct_order row points at one dim_customer')).toBeTruthy();
    expect(screen.getByText(/ERD Studio has no key or dbt test to tell/)).toBeTruthy();
    expect(create().disabled).toBe(true);

    fireEvent.click(screen.getByText('Each fct_order row points at one dim_customer'));
    expect(create().disabled).toBe(false);
    fireEvent.click(create());
    expect(sent()).toEqual([expect.objectContaining({ fromModel: 'fct_order', toModel: 'dim_customer', cardinality: 'many-to-one' })]);
    expect(sent()[0]).not.toHaveProperty('markKey');
  });

  it('says what decided it: the key flags', () => {
    open([{ name: 'dim_customer', columns: [col('customer_id', { isPrimaryKey: true })] }, bare[1]], drag);
    expect(screen.getByText("fct_order.customer_id points at dim_customer.customer_id — customer_id is dim_customer's primary key.")).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it.each([
    [{ key: 'unique', because: 'unique-test' }, 'dbt tests dim_customer.customer_id as unique'],
    [{ key: 'unique', because: 'unique-combination' }, 'dbt tests dim_customer.customer_id as a unique combination'],
  ] as Array<[DbtKeyHint, string]>)('says what decided it: dbt (%o)', (hint, words) => {
    open([{ name: 'dim_customer', columns: [col('customer_id', { dbtKey: hint })] }, bare[1]], drag);
    expect(screen.getByText(`fct_order.customer_id points at dim_customer.customer_id — ${words}.`)).toBeTruthy();
  });

  it('says what decided it: a relationships test leaving the other end', () => {
    open([bare[0], { name: 'fct_order', columns: [col('customer_id', { dbtKey: { key: 'not-unique', because: 'relationships-test' } })] }], drag);
    expect(screen.getByText('fct_order.customer_id points at dim_customer.customer_id — dbt has a relationships test leaving fct_order.customer_id.')).toBeTruthy();
  });

  it('offers to mark the one side\'s key only when that model has none, ticked when dbt says it is unique', () => {
    open([{ name: 'dim_customer', columns: [col('customer_id', { dbtKey: unique })] }, bare[1]], drag);
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByText("Mark dim_customer.customer_id as dim_customer's primary key")).toBeTruthy();
    fireEvent.click(create());
    expect(sent()).toEqual([expect.objectContaining({ fromModel: 'fct_order', markKey: { model: 'dim_customer', columns: ['customer_id'] } })]);
  });

  it('leaves the box unticked after a pick with no evidence, and sends no key unless ticked', () => {
    open(bare, drag);
    fireEvent.click(screen.getByText('Each fct_order row points at one dim_customer'));
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(create());
    expect(sent()[0].markKey).toEqual({ model: 'dim_customer', columns: ['customer_id'] });
  });
});

describe('NewFkDialog — self-reference (#133 L3)', () => {
  it('is allowed, oriented by the key: manager_id points at employee_id whichever column the drag started on', () => {
    const employee = [{ name: 'employee', columns: [col('employee_id', { isPrimaryKey: true }), col('manager_id')] }];
    open(employee, { fromModel: 'employee', fromColumn: 'employee_id', toModel: 'employee', toColumn: 'manager_id' });
    expect(screen.queryByText(/can't point at itself/)).toBeNull();
    expect(screen.getByText("employee.manager_id points at employee.employee_id — employee_id is employee's primary key.")).toBeTruthy();
    fireEvent.click(create());
    expect(sent()).toEqual([expect.objectContaining({ fromModel: 'employee', fromColumn: 'manager_id', toModel: 'employee', toColumn: 'employee_id' })]);
  });

  it('with no key, asks in the self-reference wording', () => {
    open([{ name: 'employee', columns: [col('employee_id'), col('manager_id')] }], { fromModel: 'employee', fromColumn: 'manager_id', toModel: 'employee', toColumn: 'employee_id' });
    expect(screen.getByText("Each employee row's manager_id points at one employee_id")).toBeTruthy();
    expect(screen.getByText("Each employee row's employee_id points at one manager_id")).toBeTruthy();
  });

  it('refuses a column pointing at itself', () => {
    open([{ name: 'employee', columns: [col('employee_id', { isPrimaryKey: true }), col('manager_id')] }], { fromModel: 'employee', fromColumn: 'manager_id', toModel: 'employee', toColumn: 'manager_id' });
    expect(screen.getByText("A column can't point at itself")).toBeTruthy();
    expect(create().disabled).toBe(true);
  });
});
