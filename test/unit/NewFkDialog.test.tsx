// @vitest-environment jsdom
/**
 * NewFkDialog (#133): direction from evidence, never a silent guess.
 *
 * - certain: prefilled, Create enabled with no extra click; the other way
 *   round warns ("Create anyway") with Swap sides; a turned-round drag says so
 *   and offers Swap back.
 * - likely: prefilled with its reason line.
 * - ambiguous: no default; two buttons named after the models; Create disabled
 *   until one is chosen; optional "Mark <col> as <model>'s key".
 * - Many on both sides shows the bridge hint; the read-back names the home.
 * - Edit sends the stored ends; duplicates are found either way round.
 *
 * Driven by the real editor store; only the message sender is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';

const send = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useMessageBus', () => ({ useSend: () => send }));

import { NewFkDialog, validateForm } from '../../webview/components/NewFkDialog/NewFkDialog';
import { BRIDGE_HINT } from '../../webview/lib/relationshipDialog';
import { useEditorStore } from '../../webview/store/editorStore';
import type { DisplayColumn, DisplayDomain, DisplayRelationship } from '../../src/types/display';

const col = (name: string, keys: { pk?: boolean; fk?: boolean } = {}): DisplayColumn => ({
  name, dataType: 'string', description: '',
  isPrimaryKey: keys.pk ?? false, isNaturalKey: false, isForeignKey: keys.fk ?? false,
  ...(keys.fk ? { isForeignKeyDeclared: true } : {}),
});

function domain(overrides: Partial<DisplayDomain> = {}, relationships: DisplayRelationship[] = []): DisplayDomain {
  return {
    schemaVersion: 5, domain: 'sales', layer: 'gold', stage: 'logical', description: '',
    models: [
      { name: 'dim_customer', description: '', columns: [col('customer_key', { pk: true })] },
      { name: 'fct_daily', description: '', columns: [col('customer_key', { pk: true }), col('date_key', { pk: true })] },
      { name: 'fct_order', description: '', columns: [col('order_key', { pk: true }), col('customer_key')] },
      { name: 'a', description: '', columns: [col('x')] },
      { name: 'b', description: '', columns: [col('y')] },
    ],
    relationships, viewConfig: {}, readOnly: false, positionDraggable: true,
    relationshipHome: 'library',
    ...overrides,
  } as DisplayDomain;
}

function renderDialog() {
  return render(<ReactFlowProvider><NewFkDialog /></ReactFlowProvider>);
}

const primary = () => document.querySelector<HTMLButtonElement>('.new-fk-dialog__button--primary')!;
const text = () => document.querySelector('.new-fk-dialog')!.textContent ?? '';

beforeEach(() => {
  useEditorStore.getState().setDomain(domain());
  useEditorStore.setState({ newFkDialogOpen: false, fkDialogPrefill: null, fkDialogEditData: null });
});

afterEach(() => {
  cleanup();
  send.mockClear();
});

describe('NewFkDialog — certain evidence', () => {
  it('is prefilled and can be created without another click', () => {
    useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'fct_daily', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' });
    renderDialog();
    expect(text()).toContain('Each fct_daily points to one dim_customer');
    expect(text()).toContain('How many fct_daily rows can share one dim_customer?');
    expect(text()).toContain('A dim_customer has many fct_daily.');
    expect(text()).toContain('Saved in fct_daily.yml');
    expect(screen.getByText('Why here?').getAttribute('title')).toBe(
      'Relationships live with the model holding the foreign key, so adding a fact never edits its dimensions.',
    );
    expect(primary().disabled).toBe(false);
    expect(primary().textContent).toBe('Create Relationship');
    fireEvent.click(primary());
    expect(send).toHaveBeenCalledWith({
      type: 'addRelationship',
      payload: { fromModel: 'fct_daily', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
    });
  });

  it('a turned-round drag says so; Swap back puts it the way it was dragged and warns', () => {
    useEditorStore.getState().openFkDialogWithPrefill({
      fromModel: 'fct_daily', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', turnedRound: true,
    });
    renderDialog();
    expect(text()).toContain("Turned round: fct_daily.customer_key is only part of fct_daily's primary key; dim_customer.customer_key is dim_customer's primary key.");
    fireEvent.click(screen.getByRole('button', { name: 'Swap back' }));
    expect(text()).toContain('Each dim_customer points to one fct_daily');
    expect(text()).not.toContain('Turned round');
    expect(screen.getByRole('alert').textContent).toContain(
      "dim_customer.customer_key is dim_customer's primary key, so dim_customer is normally the 'one' side.",
    );
    // Soft: still allowed.
    expect(primary().disabled).toBe(false);
    expect(primary().textContent).toBe('Create anyway');
    fireEvent.click(screen.getByRole('button', { name: 'Swap sides' }));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(primary().textContent).toBe('Create Relationship');
  });
});

describe('NewFkDialog — likely evidence', () => {
  it('is prefilled with a reason line', () => {
    useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' });
    renderDialog();
    expect(text()).toContain("Suggested because dim_customer.customer_key is dim_customer's primary key.");
    expect(primary().disabled).toBe(false);
  });
});

describe('NewFkDialog — ambiguous evidence', () => {
  beforeEach(() => {
    useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'b', fromColumn: 'y', toModel: 'a', toColumn: 'x' });
    renderDialog();
  });

  it('has no default direction and Create is disabled until one is chosen', () => {
    expect(text()).toContain('Which side has many rows? The keys do not say.');
    expect(text()).not.toContain('Each b points to one a');
    expect(primary().disabled).toBe(true);
    // Buttons named after the models, in a fixed order.
    const choices = [...document.querySelectorAll('.new-fk-dialog__choice-button')].map((b) => b.textContent);
    expect(choices).toEqual(['a has many rows per b', 'b has many rows per a']);
  });

  it('choosing a direction enables Create, and the key tick sends markKey', () => {
    fireEvent.click(screen.getByRole('button', { name: 'a has many rows per b' }));
    expect(primary().disabled).toBe(false);
    expect(text()).toContain('Each a points to one b');
    const tick = screen.getByRole('checkbox', { name: "Mark y as b's key" }) as HTMLInputElement;
    fireEvent.click(tick);
    fireEvent.click(primary());
    expect(send).toHaveBeenCalledWith({
      type: 'addRelationship',
      payload: { fromModel: 'a', fromColumn: 'x', toModel: 'b', toColumn: 'y', cardinality: 'many-to-one', markKey: { model: 'b', column: 'y' } },
    });
  });

  it('without the tick no markKey is sent', () => {
    fireEvent.click(screen.getByRole('button', { name: 'b has many rows per a' }));
    fireEvent.click(primary());
    expect(send.mock.calls[0][0].payload).not.toHaveProperty('markKey');
    expect(send.mock.calls[0][0].payload).toMatchObject({ fromModel: 'b', toModel: 'a' });
  });

  it('Many on both sides needs no direction and shows the bridge hint', () => {
    fireEvent.click(screen.getByRole('radio', { name: 'Many on both sides (use a bridge model)' }));
    expect(text()).toContain(BRIDGE_HINT);
    expect(primary().disabled).toBe(false);
  });
});

describe('NewFkDialog — per-domain projects and edit', () => {
  it('reads back "Saved in this diagram" for a per-domain project', () => {
    useEditorStore.getState().setDomain(domain({ relationshipHome: 'domain' }));
    useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'fct_daily', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' });
    renderDialog();
    expect(text()).toContain('Saved in this diagram');
  });

  it('edit sends the drawn ends as the original key and the stored ends as stored', () => {
    const stored = { fromModel: 'FCT_DAILY', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' };
    useEditorStore.getState().setDomain(domain({}, [
      { fromModel: 'fct_daily', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one', stored },
    ]));
    useEditorStore.getState().openFkDialogForEdit({
      fromModel: 'fct_daily', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key',
      cardinality: 'many-to-one', role: 'billing', stored,
    });
    renderDialog();
    expect(primary().textContent).toBe('Save Changes');
    fireEvent.click(primary());
    expect(send).toHaveBeenCalledWith({
      type: 'editRelationship',
      payload: {
        originalFromModel: 'fct_daily', originalFromColumn: 'customer_key', originalToModel: 'dim_customer', originalToColumn: 'customer_key',
        fromModel: 'fct_daily', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key',
        cardinality: 'many-to-one', role: 'billing', stored,
      },
    });
  });
});

describe('validateForm duplicate check', () => {
  const existing = [{ fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' }];
  it('finds the same link either way round and in any case', () => {
    expect(validateForm('dim_customer', 'customer_key', 'fct_order', 'customer_key', existing).duplicate).toBeDefined();
    expect(validateForm('FCT_ORDER', 'Customer_Key', 'dim_customer', 'customer_key', existing).duplicate).toBeDefined();
  });
  it('the link being edited is not its own duplicate, even reversed', () => {
    expect(validateForm('dim_customer', 'customer_key', 'fct_order', 'customer_key', existing, {
      fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key',
    }).duplicate).toBeUndefined();
  });
});
