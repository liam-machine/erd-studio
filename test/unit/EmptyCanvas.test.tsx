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

const setNewModelDialogOpen = vi.hoisted(() => vi.fn());
const storeState = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('../../webview/store/editorStore', () => ({
  useEditorStore: (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
}));

import { EmptyCanvas } from '../../webview/components/EmptyCanvas/EmptyCanvas';

function setDomain(overrides: Record<string, unknown> = {}) {
  storeState.domain = { stage: 'logical', readOnly: false, models: [], relationships: [], ...overrides };
}

beforeEach(() => {
  Object.assign(storeState, { newModelDialogOpen: false, setNewModelDialogOpen });
  setDomain();
});

afterEach(() => {
  cleanup();
  send.mockClear();
  setNewModelDialogOpen.mockClear();
});

describe('EmptyCanvas', () => {
  it('shows the prompt for an empty logical domain', () => {
    const { getByRole, getByText } = render(<EmptyCanvas />);
    expect(getByRole('heading', { name: 'This diagram is empty' })).toBeTruthy();
    expect(getByText('Start from your dbt project, or add a model by hand.')).toBeTruthy();
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
    fireEvent.click(getByRole('button', { name: 'Add models from dbt' }));
    expect(send).toHaveBeenCalledWith({ type: 'addModelsFromDbt' });
  });

  it('"New model" opens the New Design Model dialog', () => {
    const { getByRole } = render(<EmptyCanvas />);
    fireEvent.click(getByRole('button', { name: 'New model' }));
    expect(setNewModelDialogOpen).toHaveBeenCalledWith(true);
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
    setDomain(overrides);
    const { container } = render(<EmptyCanvas />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing before a domain has loaded', () => {
    storeState.domain = null;
    const { container } = render(<EmptyCanvas />);
    expect(container.innerHTML).toBe('');
  });

  it('steps aside while the New Design Model dialog is open', () => {
    storeState.newModelDialogOpen = true;
    const { container } = render(<EmptyCanvas />);
    expect(container.innerHTML).toBe('');
  });
});
