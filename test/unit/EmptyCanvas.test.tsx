// @vitest-environment jsdom
/**
 * EmptyCanvas — the prompt over a logical canvas with no models. "Add models
 * from dbt" posts `addModelsFromDbt`; "New model" opens the same dialog as the
 * toolbar's New Design Model. Nothing renders on the physical stage, for a
 * read-only domain, or once a model exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

const send = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useMessageBus', () => ({ useSend: () => send }));

const setNewTableDialogOpen = vi.hoisted(() => vi.fn());
const setAddExistingDialogOpen = vi.hoisted(() => vi.fn());
const storeState = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('../../webview/store/editorStore', () => ({
  useEditorStore: (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
}));

import { EmptyCanvas } from '../../webview/components/EmptyCanvas/EmptyCanvas';

function setSubjectArea(overrides: Record<string, unknown> = {}) {
  storeState.domain = { stage: 'logical', readOnly: false, models: [], relationships: [], ...overrides };
}

beforeEach(() => {
  Object.assign(storeState, {
    newModelDialogOpen: false, setNewModelDialogOpen: setNewTableDialogOpen, logicalOnly: false,
    addExistingModelDialogOpen: false, setAddExistingModelDialogOpen: setAddExistingDialogOpen,
    existingModels: [], manifestModels: [],
  });
  setSubjectArea();
});

afterEach(() => {
  cleanup();
  send.mockClear();
  setNewTableDialogOpen.mockClear();
  setAddExistingDialogOpen.mockClear();
});

describe('EmptyCanvas', () => {
  it('shows the prompt for an empty logical domain', () => {
    const { getByRole, getByText } = render(<EmptyCanvas />);
    expect(getByRole('heading', { name: 'This diagram is empty' })).toBeTruthy();
    expect(getByText('Start from your dbt project, or add a table by hand.')).toBeTruthy();
    // No command is named: the setup skill may not be installed yet.
    expect(document.body.textContent).not.toContain('/erd-studio-setup');
  });

  it('the AI hint opens the Welcome panel', () => {
    const { getByRole } = render(<EmptyCanvas />);
    fireEvent.click(getByRole('button', { name: 'set it up in the Welcome panel' }));
    expect(send).toHaveBeenCalledWith({ type: 'openGettingStarted' });
  });

  it('"Add models from dbt" posts addModelsFromDbt', () => {
    const { getByRole } = render(<EmptyCanvas />);
    fireEvent.click(getByRole('button', { name: 'Add tables from dbt' }));
    expect(send).toHaveBeenCalledWith({ type: 'addModelsFromDbt' });
  });

  it('"New table" opens the New Design Table dialog', () => {
    const { getByRole } = render(<EmptyCanvas />);
    fireEvent.click(getByRole('button', { name: 'New table' }));
    expect(setNewTableDialogOpen).toHaveBeenCalledWith(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('uses native buttons so both actions are keyboard reachable', () => {
    const { getAllByRole } = render(<EmptyCanvas />);
    const buttons = getAllByRole('button');
    expect(buttons.map((b) => b.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
    expect(buttons.every((b) => b.getAttribute('type') === 'button')).toBe(true);
  });

  it.each([
    ['a domain with a model', { models: [{ name: 'dim_customer' }] }],
    ['the physical stage', { stage: 'physical' }],
    ['a read-only domain', { readOnly: true }],
  ])('renders nothing for %s', (_label, overrides) => {
    setSubjectArea(overrides);
    const { container } = render(<EmptyCanvas />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing before a domain has loaded', () => {
    storeState.domain = null;
    const { container } = render(<EmptyCanvas />);
    expect(container.innerHTML).toBe('');
  });

  it('keeps "Add tables from dbt" as the primary action in a dbt project', () => {
    const { getByRole } = render(<EmptyCanvas />);
    expect(getByRole('button', { name: 'Add tables from dbt' }).className).toContain('empty-canvas__button--primary');
    expect(getByRole('button', { name: 'New table' }).className).not.toContain('empty-canvas__button--primary');
  });

  describe('without a dbt project (logicalOnly)', () => {
    beforeEach(() => { storeState.logicalOnly = true; });

    it('drops "Add tables from dbt" and says each table is a file you can commit', () => {
      const { queryByRole, getByText } = render(<EmptyCanvas />);
      expect(queryByRole('button', { name: 'Add tables from dbt' })).toBeNull();
      expect(getByText('Add your first table. Each one is a file you can commit.')).toBeTruthy();
      expect(document.body.textContent).not.toContain('dbt');
    });

    it('makes "New table" the primary action, opening the New Design Table dialog', () => {
      const { getByRole } = render(<EmptyCanvas />);
      const button = getByRole('button', { name: 'New table' });
      expect(button.className).toContain('empty-canvas__button--primary');
      fireEvent.click(button);
      expect(setNewTableDialogOpen).toHaveBeenCalledWith(true);
      expect(send).not.toHaveBeenCalled();
    });

    it('still offers the AI route through the Welcome panel', () => {
      const { getByRole } = render(<EmptyCanvas />);
      fireEvent.click(getByRole('button', { name: 'set it up in the Welcome panel' }));
      expect(send).toHaveBeenCalledWith({ type: 'openGettingStarted' });
    });
  });

  it('steps aside while the New Design Model dialog is open', () => {
    storeState.newModelDialogOpen = true;
    const { container } = render(<EmptyCanvas />);
    expect(container.innerHTML).toBe('');
  });

  describe('"Add existing tables"', () => {
    const libraryRow = (name: string) => ({ name, schema: '', description: '', columnCount: 2, source: 'logical', sourcePath: `.erd-studio/tables/${name}.dbml` });
    const dbtRow = (name: string) => ({ ...libraryRow(name), source: 'yml', sourcePath: `models/${name}.yml` });
    const addExisting = (get: (role: string, opts: { name: string }) => HTMLElement) => get('button', { name: 'Add existing tables' });

    it('is the primary action, opening the Add Existing Table dialog, when the Table Library has tables this diagram lacks', () => {
      storeState.existingModels = [libraryRow('dim_customer')];
      const { getByRole } = render(<EmptyCanvas />);
      const button = addExisting(getByRole);
      expect(button.className).toContain('empty-canvas__button--primary');
      expect(getByRole('button', { name: 'Add tables from dbt' }).className).not.toContain('empty-canvas__button--primary');
      expect(getByRole('button', { name: 'New table' }).className).not.toContain('empty-canvas__button--primary');
      fireEvent.click(button);
      expect(setAddExistingDialogOpen).toHaveBeenCalledWith(true);
      expect(send).not.toHaveBeenCalled();
    });

    it('is the primary action without a dbt project too, and the text says to reuse the library', () => {
      storeState.logicalOnly = true;
      storeState.existingModels = [libraryRow('dim_customer')];
      const { getByRole, getByText } = render(<EmptyCanvas />);
      expect(addExisting(getByRole).className).toContain('empty-canvas__button--primary');
      expect(getByRole('button', { name: 'New table' }).className).not.toContain('empty-canvas__button--primary');
      expect(getByText('Reuse tables from your Table Library, or add a new one.')).toBeTruthy();
      expect(document.body.textContent).not.toContain('dbt');
    });

    it('is a secondary button when only dbt models are there to add', () => {
      storeState.existingModels = [dbtRow('stg_orders')];
      const { getByRole } = render(<EmptyCanvas />);
      expect(addExisting(getByRole).className).not.toContain('empty-canvas__button--primary');
      expect(getByRole('button', { name: 'Add tables from dbt' }).className).toContain('empty-canvas__button--primary');
    });

    it('is not offered when there is nothing to add', () => {
      const { queryByRole } = render(<EmptyCanvas />);
      expect(queryByRole('button', { name: 'Add existing tables' })).toBeNull();
    });

    it('steps aside while the Add Existing Table dialog is open', () => {
      storeState.existingModels = [libraryRow('dim_customer')];
      storeState.addExistingModelDialogOpen = true;
      const { container } = render(<EmptyCanvas />);
      expect(container.innerHTML).toBe('');
    });
  });
});
