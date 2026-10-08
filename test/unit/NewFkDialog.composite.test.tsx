// @vitest-environment jsdom
/**
 * The New / Edit Relationship dialog builds a composite foreign key from
 * several column pairs (#133 L2).
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

const col = (name: string, isPrimaryKey = false) => ({ name, dataType: 'string', description: '', isPrimaryKey, isForeignKey: false, isNaturalKey: false });
const MODELS = [
  { name: 'pit_customer', columns: [col('pit_id', true), col('customer_hk'), col('as_of_date'), col('extra')] },
  { name: 'sat_customer', columns: [col('customer_hk', true), col('load_date', true), col('name')] },
];

function setDomain(relationships: unknown[] = []) {
  useEditorStore.setState({
    domain: { schemaVersion: 5, domain: 'd', layer: 'silver', stage: 'logical', description: '', readOnly: false, viewConfig: {}, models: MODELS, relationships } as never,
  });
}
const openNew = () => {
  useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'pit_customer', fromColumn: 'customer_hk', toModel: 'sat_customer', toColumn: 'customer_hk' });
  render(<NewFkDialog />);
};
const submit = () => screen.getByRole('button', { name: /Create|Save/ }) as HTMLButtonElement;
const pick = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const sent = () => postMessage.mock.calls.map(([m]) => m);

beforeEach(() => postMessage.mockClear());
afterEach(cleanup);

describe('NewFkDialog — composite foreign keys (#133 L2)', () => {
  it('+ Add another column pair adds a row; the key is oriented on the column sets and sent with extraPairs', () => {
    setDomain();
    openNew();
    expect(screen.getByText('New Relationship')).toBeTruthy();
    fireEvent.click(screen.getByText('+ Add another column pair'));
    expect(screen.getByText('New Composite Relationship')).toBeTruthy();
    expect(submit().disabled).toBe(true);
    expect(screen.getByText('Pick both columns')).toBeTruthy();
    pick('Source column 2', 'as_of_date');
    pick('Target column 2', 'load_date');
    expect(screen.getByText("pit_customer.(customer_hk, as_of_date) points at sat_customer.(customer_hk, load_date) — (customer_hk, load_date) is sat_customer's primary key.")).toBeTruthy();
    fireEvent.click(submit());
    expect(sent()).toEqual([{
      type: 'addRelationship',
      payload: {
        fromModel: 'pit_customer', fromColumn: 'customer_hk', toModel: 'sat_customer', toColumn: 'customer_hk', cardinality: 'many-to-one',
        extraPairs: [{ fromColumn: 'as_of_date', toColumn: 'load_date' }],
      },
    }]);
  });

  it('with two or more pairs, many-to-many is disabled and refused', () => {
    setDomain();
    openNew();
    fireEvent.change(screen.getByLabelText('Cardinality'), { target: { value: 'many-to-many' } });
    fireEvent.click(screen.getByText('+ Add another column pair'));
    const option = screen.getByRole('option', { name: 'Many-to-Many (*↔*)' }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(option.title).toBe("A composite key can't be many-to-many");
    pick('Source column 2', 'as_of_date');
    pick('Target column 2', 'load_date');
    expect(screen.getByText("A composite key can't be many-to-many — pick many-to-one or one-to-one")).toBeTruthy();
    expect(submit().disabled).toBe(true);
  });

  it('a column used twice at one end is an error on its row; removing the row makes it a single link again', () => {
    setDomain();
    openNew();
    fireEvent.click(screen.getByText('+ Add another column pair'));
    pick('Source column 2', 'customer_hk');
    pick('Target column 2', 'load_date');
    expect(screen.getByText('customer_hk is already used in this key')).toBeTruthy();
    expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Remove column pair 2'));
    expect(screen.getByText('New Relationship')).toBeTruthy();
    // One pair of two non-key columns: nothing says which side holds the key, so the dialog asks.
    fireEvent.click(screen.getByText('Each pit_customer row points at one sat_customer'));
    fireEvent.click(submit());
    expect(sent()[0].payload).not.toHaveProperty('extraPairs');
  });

  it('a pair already drawn as a single link between the two models is absorbed, not refused', () => {
    setDomain([{ fromModel: 'pit_customer', fromColumn: 'as_of_date', toModel: 'sat_customer', toColumn: 'load_date', cardinality: 'many-to-one' }]);
    openNew();
    fireEvent.click(screen.getByText('+ Add another column pair'));
    pick('Source column 2', 'as_of_date');
    pick('Target column 2', 'load_date');
    expect(screen.getByText('Already a relationship — it will become part of this key.')).toBeTruthy();
    expect(screen.queryByText('This relationship already exists')).toBeNull();
    expect(submit().disabled).toBe(false);
  });

  it('edit prefills every pair of the composite, and saves without counting its own members as duplicates', () => {
    const members = [['customer_hk', 'customer_hk'], ['as_of_date', 'load_date']].map(([f, t]) =>
      ({ fromModel: 'pit_customer', fromColumn: f, toModel: 'sat_customer', toColumn: t, cardinality: 'many-to-one', compositeKey: 'fk_sat_customer' }));
    setDomain(members);
    useEditorStore.getState().openFkDialogForEdit({
      fromModel: 'pit_customer', fromColumn: 'customer_hk', toModel: 'sat_customer', toColumn: 'customer_hk', cardinality: 'many-to-one', role: 'as of',
      pairs: [{ fromColumn: 'customer_hk', toColumn: 'customer_hk' }, { fromColumn: 'as_of_date', toColumn: 'load_date' }],
    });
    render(<NewFkDialog />);
    expect(screen.getByText('Edit Composite Relationship')).toBeTruthy();
    expect((screen.getByLabelText('Source column 2') as HTMLSelectElement).value).toBe('as_of_date');
    expect((screen.getByLabelText('Target column 2') as HTMLSelectElement).value).toBe('load_date');
    fireEvent.click(submit());
    expect(sent()).toEqual([{
      type: 'editRelationship',
      payload: expect.objectContaining({
        originalFromColumn: 'customer_hk', fromColumn: 'customer_hk', role: 'as of',
        extraPairs: [{ fromColumn: 'as_of_date', toColumn: 'load_date' }],
      }),
    }]);
  });
});
