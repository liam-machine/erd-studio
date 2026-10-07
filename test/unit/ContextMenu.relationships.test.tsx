// @vitest-environment jsdom
/**
 * The edge context menu (#133): no "One → Many" option (⇄ covers it), ⇄ on a
 * one-to-one / many-to-many swaps the ends through editRelationship with the
 * role kept, and every change, edit and remove names the record by its
 * stored ends. Driven by the real editor store; only the VS Code API is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const postMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({ useVsCodeApi: () => ({ postMessage }) }));

import { ContextMenu, CARDINALITY_OPTIONS } from '../../webview/components/ContextMenu/ContextMenu';
import { useEditorStore } from '../../webview/store/editorStore';
import type { FkEdgeData } from '@erd-studio/renderer/editor';
import type { DisplayDomain } from '../../src/types/display';

const DRAWN = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' };
const STORED = { fromModel: 'FCT_ORDER', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' };

function openMenu(data: Partial<FkEdgeData> = {}, readOnly = false) {
  useEditorStore.getState().setDomain({
    schemaVersion: 5, domain: 'sales', layer: 'gold', stage: readOnly ? 'physical' : 'logical', description: '',
    models: [], relationships: [], viewConfig: {}, readOnly, positionDraggable: true,
  } as DisplayDomain);
  useEditorStore.getState().openEdgeContextMenu(10, 10, { ...DRAWN, cardinality: 'many-to-one', stored: STORED, ...data });
  return render(<ContextMenu />);
}

beforeEach(() => postMessage.mockClear());
afterEach(() => {
  cleanup();
  useEditorStore.getState().closeContextMenu();
});

describe('edge ContextMenu (#133)', () => {
  it('offers no One → Many cardinality', () => {
    expect(CARDINALITY_OPTIONS.map((o) => o.value)).toEqual(['many-to-one', 'one-to-one', 'many-to-many']);
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: /Many → One/ }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Many → One', 'One → One', 'Many → Many']);
  });

  it('a cardinality change sends the stored ends', () => {
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: /Many → One/ }));
    fireEvent.click(screen.getByRole('option', { name: 'One → One' }));
    expect(postMessage).toHaveBeenCalledWith({
      type: 'updateRelationship', payload: { ...DRAWN, stored: STORED, cardinality: 'one-to-one' },
    });
  });

  it('⇄ on a many-to-one makes the other model the many side', () => {
    openMenu();
    const swap = screen.getByRole('button', { name: 'Make dim_customer the many side' });
    expect(swap.getAttribute('title')).toBe('Make dim_customer the many side');
    fireEvent.click(swap);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'updateRelationship', payload: { ...DRAWN, stored: STORED, cardinality: 'one-to-many' },
    });
  });

  it('⇄ on a one-to-one swaps the ends with the role kept', () => {
    openMenu({ cardinality: 'one-to-one', role: 'billing' });
    fireEvent.click(screen.getByRole('button', { name: 'Make dim_customer the side that holds the foreign key' }));
    expect(postMessage).toHaveBeenCalledWith({
      type: 'editRelationship',
      payload: {
        originalFromModel: 'fct_order', originalFromColumn: 'customer_key', originalToModel: 'dim_customer', originalToColumn: 'customer_key',
        fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key',
        cardinality: 'one-to-one', role: 'billing', stored: STORED,
      },
    });
  });

  it('⇄ on a many-to-many swaps the ends too', () => {
    openMenu({ cardinality: 'many-to-many' });
    fireEvent.click(screen.getByRole('button', { name: 'Swap the ends (list dim_customer first)' }));
    expect(postMessage.mock.calls[0][0]).toMatchObject({ type: 'editRelationship', payload: { fromModel: 'dim_customer', cardinality: 'many-to-many', role: '' } });
  });

  describe('a many-to-many whose direction the keys do not settle', () => {
    const plain = (name: string) => ({
      name, dataType: 'string', description: '', isPrimaryKey: false, isNaturalKey: false, isForeignKey: false,
    });
    const AB = { fromModel: 'a', fromColumn: 'x', toModel: 'b', toColumn: 'y' };
    function openOnPlainColumns(cardinality: FkEdgeData['cardinality']) {
      useEditorStore.getState().setDomain({
        schemaVersion: 5, domain: 'sales', layer: 'gold', stage: 'logical', description: '',
        models: [
          { name: 'a', description: '', columns: [plain('x')] },
          { name: 'b', description: '', columns: [plain('y')] },
        ],
        relationships: [], viewConfig: {}, readOnly: false, positionDraggable: true,
      } as unknown as DisplayDomain);
      useEditorStore.setState({ newFkDialogOpen: false, fkDialogEditData: null });
      useEditorStore.getState().openEdgeContextMenu(10, 10, { ...AB, cardinality, role: 'link', stored: AB });
      return render(<ContextMenu />);
    }

    it('Many → One opens Edit with it chosen instead of making the stored from-model the many side', () => {
      openOnPlainColumns('many-to-many');
      fireEvent.click(screen.getByRole('button', { name: /Many → Many/ }));
      fireEvent.click(screen.getByRole('option', { name: 'Many → One' }));
      expect(postMessage).not.toHaveBeenCalled();
      const s = useEditorStore.getState();
      expect(s.newFkDialogOpen).toBe(true);
      expect(s.fkDialogEditData).toEqual({ ...AB, cardinality: 'many-to-many', role: 'link', stored: AB, pickedCardinality: 'many-to-one' });
    });

    it('a many-to-one on the same columns still changes in place (its direction was chosen)', () => {
      openOnPlainColumns('many-to-one');
      fireEvent.click(screen.getByRole('button', { name: /Many → One/ }));
      fireEvent.click(screen.getByRole('option', { name: 'One → One' }));
      expect(postMessage).toHaveBeenCalledWith({ type: 'updateRelationship', payload: { ...AB, stored: AB, cardinality: 'one-to-one' } });
    });
  });

  it('Remove (confirmed) sends the stored ends', () => {
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Confirm?' }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'removeRelationship', payload: { ...DRAWN, stored: STORED } });
  });

  it('Edit… opens the dialog with the stored ends', () => {
    openMenu({ role: 'billing' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit...' }));
    expect(useEditorStore.getState().fkDialogEditData).toEqual({ ...DRAWN, cardinality: 'many-to-one', role: 'billing', stored: STORED });
  });

  it('a read-only (physical) menu still shows a one-to-many label and no actions', () => {
    openMenu({ cardinality: 'one-to-many', stored: undefined }, true);
    expect(document.body.textContent).toContain('One → Many');
    expect(screen.queryByRole('menuitem', { name: 'Remove' })).toBeNull();
  });
});
