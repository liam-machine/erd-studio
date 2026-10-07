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
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

describe('NewFkDialog — a many-to-many has no "one" side to contradict', () => {
  it('editing a many-to-many stored from the key\'s model shows no warning and a plain Save', () => {
    useEditorStore.getState().openFkDialogForEdit({
      fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_daily', toColumn: 'customer_key',
      cardinality: 'many-to-many',
    });
    renderDialog();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(primary().textContent).toBe('Save Changes');
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

describe('NewFkDialog — both ends not unique (an ambiguous many-to-many verdict)', () => {
  const twoForeignKeys = () => domain({
    models: [
      { name: 'a', description: '', columns: [col('x', { fk: true })] },
      { name: 'b', description: '', columns: [col('y', { fk: true })] },
    ],
  } as Partial<DisplayDomain>);

  it('prefills nothing it cannot back: Create stays disabled until a direction or a cardinality is chosen', () => {
    useEditorStore.getState().setDomain(twoForeignKeys());
    useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'b', fromColumn: 'y', toModel: 'a', toColumn: 'x' });
    renderDialog();
    expect((screen.getByRole('radio', { name: 'Many on both sides (use a bridge model)' }) as HTMLInputElement).checked).toBe(false);
    expect(primary().disabled).toBe(true);
    fireEvent.click(primary());
    expect(send).not.toHaveBeenCalled();
  });

  it('a many-to-many the user picks is theirs to create', () => {
    useEditorStore.getState().setDomain(twoForeignKeys());
    useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'b', fromColumn: 'y', toModel: 'a', toColumn: 'x' });
    renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: 'Many on both sides (use a bridge model)' }));
    expect(primary().disabled).toBe(false);
    fireEvent.click(primary());
    expect(send.mock.calls[0][0].payload).toMatchObject({ cardinality: 'many-to-many' });
  });
});

describe('NewFkDialog — editing a many-to-many into a one-sided relationship', () => {
  it('asks the direction when the keys do not settle it: the stored ends were never a choice', () => {
    useEditorStore.getState().openFkDialogForEdit({
      fromModel: 'a', fromColumn: 'x', toModel: 'b', toColumn: 'y', cardinality: 'many-to-many',
    });
    renderDialog();
    // Kept a many-to-many: nothing to ask.
    expect(primary().disabled).toBe(false);
    fireEvent.click(screen.getByRole('radio', { name: 'Many (usual)' }));
    expect(text()).toContain('Which side has many rows? The keys do not say.');
    expect(primary().disabled).toBe(true);
    fireEvent.click(primary());
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'b has many rows per a' }));
    expect(primary().disabled).toBe(false);
    fireEvent.click(primary());
    expect(send.mock.calls[0][0]).toMatchObject({
      type: 'editRelationship',
      payload: { originalFromModel: 'a', fromModel: 'b', fromColumn: 'y', toModel: 'a', toColumn: 'x', cardinality: 'many-to-one' },
    });
  });

  it('opens with the edge menu\'s pick chosen, still asking the direction', () => {
    useEditorStore.getState().openFkDialogForEdit({
      fromModel: 'a', fromColumn: 'x', toModel: 'b', toColumn: 'y', cardinality: 'many-to-many', pickedCardinality: 'one-to-one',
    });
    renderDialog();
    expect((screen.getByRole('radio', { name: 'Only one' }) as HTMLInputElement).checked).toBe(true);
    expect(primary().disabled).toBe(true);
  });

  it('the edge menu\'s Many → One on a many-to-many stored from the key\'s side is turned round by likely evidence, with Swap back (#133 review)', () => {
    // dim_customer.customer_key is its whole primary key; fct_order.customer_key has no key flags: likely.
    useEditorStore.getState().openFkDialogForEdit({
      fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key',
      cardinality: 'many-to-many', pickedCardinality: 'many-to-one',
    });
    renderDialog();
    expect(text()).toContain('Each fct_order points to one dim_customer');
    expect(text()).toContain("Turned round: dim_customer.customer_key is dim_customer's primary key.");
    expect(primary().textContent).toBe('Save Changes');
    fireEvent.click(primary());
    expect(send.mock.calls[0][0]).toMatchObject({
      type: 'editRelationship',
      payload: {
        originalFromModel: 'dim_customer', fromModel: 'fct_order', fromColumn: 'customer_key',
        toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one',
      },
    });
  });

  it('Swap back after the turn shows the reason with a Swap sides button that turns it again', () => {
    useEditorStore.getState().openFkDialogForEdit({
      fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key',
      cardinality: 'many-to-many', pickedCardinality: 'many-to-one',
    });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Swap back' }));
    expect(text()).toContain("Usually the other way round: dim_customer.customer_key is dim_customer's primary key.");
    fireEvent.click(screen.getByRole('button', { name: 'Swap sides' }));
    expect(text()).toContain('Each fct_order points to one dim_customer');
  });

  it('choosing a one-sided cardinality inside the dialog turns the stored drag order the same way', () => {
    useEditorStore.getState().openFkDialogForEdit({
      fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key',
      cardinality: 'many-to-many',
    });
    renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: 'Many (usual)' }));
    expect(text()).toContain('Each fct_order points to one dim_customer');
    fireEvent.click(primary());
    expect(send.mock.calls[0][0].payload).toMatchObject({ fromModel: 'fct_order', toModel: 'dim_customer', cardinality: 'many-to-one' });
  });

  it('a saved many-to-one keeps its direction as the user\'s choice', () => {
    useEditorStore.getState().openFkDialogForEdit({
      fromModel: 'a', fromColumn: 'x', toModel: 'b', toColumn: 'y', cardinality: 'many-to-one',
    });
    renderDialog();
    expect(primary().disabled).toBe(false);
  });
});

describe('NewFkDialog — Escape then New Relationship starts afresh', () => {
  it('a direction and key tick chosen before Escape are not carried into the next open', () => {
    useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'b', fromColumn: 'y', toModel: 'a', toColumn: 'x' });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'a has many rows per b' }));
    fireEvent.click(screen.getByRole('checkbox', { name: "Mark y as b's key" }));
    // What the global Escape shortcut does (useCanvasShortcuts): close through the store only.
    act(() => {
      const s = useEditorStore.getState();
      s.setNewFkDialogOpen(false);
      s.clearFkDialogPrefill();
      s.clearFkDialogEditData();
    });
    expect(document.querySelector('.new-fk-dialog')).toBeNull();
    // The toolbar's New Relationship.
    act(() => { useEditorStore.getState().setNewFkDialogOpen(true); });
    expect(text()).toContain('New Relationship');
    expect(screen.queryByRole('checkbox', { name: "Mark y as b's key" })).toBeNull();
    expect(primary().disabled).toBe(true);
    fireEvent.click(primary());
    expect(send).not.toHaveBeenCalled();
  });
});

describe('NewFkDialog — per-domain projects and edit', () => {
  it('reads back "Saved in this diagram" for a per-domain project', () => {
    useEditorStore.getState().setDomain(domain({ relationshipHome: 'domain' }));
    useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'fct_daily', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' });
    renderDialog();
    expect(text()).toContain('Saved in this diagram');
  });

  it('an older-format (v4) diagram explains its own file and names the migration, not the project mode or the move (#133 review)', () => {
    useEditorStore.getState().setDomain(domain({ relationshipHome: 'domain', schemaVersion: 4 }));
    useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'fct_daily', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' });
    renderDialog();
    expect(text()).toContain('Saved in this diagram');
    const why = screen.getByText('Why here?').getAttribute('title');
    expect(why).toBe('This diagram is in the older format, so its relationships live in its own file. Run "ERD Studio: Migrate Domains to Central Model Store" to store them with their models.');
    expect(why).not.toContain('Move Relationships to Model Library');
  });

  it('a v5 per-diagram project keeps the project-mode explanation', () => {
    useEditorStore.getState().setDomain(domain({ relationshipHome: 'domain' }));
    useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'fct_daily', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' });
    renderDialog();
    expect(screen.getByText('Why here?').getAttribute('title')).toContain('Move Relationships to Model Library');
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

describe('NewFkDialog — #133 review 6', () => {
  it('a key tick belongs to the column it named: after the ends change, the box is unticked and nothing is marked', () => {
    const base = domain();
    useEditorStore.getState().setDomain({
      ...base,
      models: base.models.map((m) => (m.name === 'b' ? { ...m, columns: [col('y'), col('z')] } : m)),
    } as DisplayDomain);
    useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'a', fromColumn: 'x', toModel: 'b', toColumn: 'y' });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'a has many rows per b' }));
    fireEvent.click(screen.getByRole('checkbox', { name: "Mark y as b's key" }));
    // Another To column: the direction is asked again, the box hidden meanwhile.
    fireEvent.change(document.querySelector('select#toColumn')!, { target: { value: 'z' } });
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'a has many rows per b' }));
    const box = screen.getByRole('checkbox', { name: "Mark z as b's key" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(primary());
    expect(send.mock.calls[0][0].payload).toMatchObject({ fromModel: 'a', toModel: 'b', toColumn: 'z' });
    expect(send.mock.calls[0][0].payload).not.toHaveProperty('markKey');
  });

  it('an existing self-reference can be edited (its role, its cardinality) and saved', () => {
    const employee = { name: 'employee', description: '', columns: [col('employee_id', { pk: true }), col('manager_id')] };
    const self = { fromModel: 'employee', fromColumn: 'manager_id', toModel: 'employee', toColumn: 'employee_id', cardinality: 'many-to-one' as const };
    const base = domain({}, [self]);
    useEditorStore.getState().setDomain({ ...base, models: [...base.models, employee] } as DisplayDomain);
    useEditorStore.getState().openFkDialogForEdit({ ...self, role: '' });
    renderDialog();
    expect(text()).not.toContain('cannot have a relationship with itself');
    fireEvent.change(document.querySelector('#relationship-role')!, { target: { value: 'manager' } });
    expect(primary().disabled).toBe(false);
    fireEvent.click(primary());
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'editRelationship',
      payload: expect.objectContaining({ fromModel: 'employee', fromColumn: 'manager_id', toModel: 'employee', toColumn: 'employee_id', role: 'manager' }),
    }));
  });

  it('validateForm: a new self-reference is still refused; an edited one only when both ends are the same column', () => {
    expect(validateForm('employee', 'manager_id', 'employee', 'employee_id', []).selfReference).toBeDefined();
    const original = { fromModel: 'employee', fromColumn: 'manager_id', toModel: 'employee', toColumn: 'employee_id' };
    expect(validateForm('employee', 'manager_id', 'employee', 'employee_id', [], original).selfReference).toBeUndefined();
    expect(validateForm('employee', 'manager_id', 'employee', 'Manager_Id', [], original).selfReference)
      .toBe('A column cannot have a relationship with itself');
    // Editing a relationship between two models into a self-reference is not offered either.
    expect(validateForm('employee', 'manager_id', 'employee', 'employee_id', [], { ...original, toModel: 'dim_x' }).selfReference).toBeDefined();
  });
});

describe('NewFkDialog — editing a relationship whose model or column is missing (#133 review)', () => {
  const selectText = (id: string): string => {
    const select = document.getElementById(id) as HTMLSelectElement;
    return select.options[select.selectedIndex]?.textContent ?? '';
  };

  it('a model not in the diagram (REL003) shows in its select, with a warning — never a blank "Select model..."', () => {
    useEditorStore.getState().openFkDialogForEdit({
      fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'gone', toColumn: 'id', cardinality: 'many-to-one',
    });
    renderDialog();
    expect((document.getElementById('toModel') as HTMLSelectElement).value).toBe('gone');
    expect(selectText('toModel')).toBe('gone (not in this diagram)');
    expect(text()).toContain("gone is not one of this diagram's models, so the canvas cannot draw this relationship.");
    // Picking a real model drops the extra option and the warning.
    fireEvent.change(document.getElementById('toModel')!, { target: { value: 'dim_customer' } });
    expect(text()).not.toContain('(not in this diagram)');
    expect(text()).not.toContain('cannot draw this relationship');
  });

  it('a column the model does not have (REL004) shows in its select, with a warning', () => {
    useEditorStore.getState().openFkDialogForEdit({
      fromModel: 'fct_order', fromColumn: 'cust_id', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one',
    });
    renderDialog();
    expect((document.getElementById('fromColumn') as HTMLSelectElement).value).toBe('cust_id');
    expect(selectText('fromColumn')).toBe('cust_id (not a column of fct_order)');
    expect(text()).toContain('fct_order has no column cust_id, so the canvas cannot draw this relationship.');
  });

  it('a stub model excuses a missing column, as the checks read it: shown, but no warning', () => {
    useEditorStore.getState().setDomain(domain({ stubColumns: ['fct_order'] } as Partial<DisplayDomain>));
    useEditorStore.getState().openFkDialogForEdit({
      fromModel: 'fct_order', fromColumn: 'cust_id', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one',
    });
    renderDialog();
    expect(selectText('fromColumn')).toBe('cust_id (not a column of fct_order)');
    expect(text()).not.toContain('cannot draw this relationship');
  });
});

