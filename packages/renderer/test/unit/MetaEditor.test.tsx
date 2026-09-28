// @vitest-environment jsdom
/**
 * MetaEditor: a model's or column's structured metadata. Text values are
 * edited in place; nested, list and boolean values are shown but only
 * editable in the model file. Every change is one `updateMeta` patch.
 */
import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import type { Meta } from '@erd-studio/core';
import { MetaEditor, formatMetaValue } from '../../src/components/DetailPanel/MetaEditor';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';

const META: Meta = {
  owner: 'analytics',
  lineage: { source: 'sap', table: 'mara' },
  tags: ['pii', 'gold'],
  certified: true,
  empty: null,
};

function setup(
  props: { meta?: Meta; columnName?: string; readOnly?: boolean } = {},
  viewer = false,
) {
  const posted: unknown[] = [];
  const utils = render(
    <CanvasEnvironmentProvider host={{ postMessage: (m) => posted.push(m) }} viewer={viewer}>
      <MetaEditor modelName="fct_order" {...props} />
    </CanvasEnvironmentProvider>,
  );
  return { ...utils, posted };
}

const valueOf = (container: HTMLElement, key: string) => {
  const row = [...container.querySelectorAll('.meta-editor__row')].find(
    (r) => r.querySelector('.meta-editor__key')?.textContent === key,
  );
  return row?.querySelector('.meta-editor__text')?.textContent;
};

describe('formatMetaValue', () => {
  it('renders text, booleans, null, lists and nested maps on one line', () => {
    expect(formatMetaValue('x')).toBe('x');
    expect(formatMetaValue(false)).toBe('false');
    expect(formatMetaValue(null)).toBe('—');
    expect(formatMetaValue(['a', true])).toBe('[a, true]');
    expect(formatMetaValue({ a: 'b', c: { d: ['e'] } })).toBe('{ a: b, c: { d: [e] } }');
  });
});

describe('MetaEditor', () => {
  it('shows text, nested, list and boolean values', () => {
    const { container } = setup({ meta: META });
    expect(valueOf(container, 'owner')).toBe('analytics');
    expect(valueOf(container, 'lineage')).toBe('{ source: sap, table: mara }');
    expect(valueOf(container, 'tags')).toBe('[pii, gold]');
    expect(valueOf(container, 'certified')).toBe('true');
    expect(valueOf(container, 'empty')).toBe('—');
  });

  it('offers an edit button only for text values, and remove for every key', () => {
    setup({ meta: META });
    expect(screen.getByLabelText('Edit owner')).toBeTruthy();
    for (const key of ['lineage', 'tags', 'certified', 'empty']) {
      expect(screen.queryByLabelText(`Edit ${key}`)).toBeNull();
      expect(screen.getByLabelText(`Remove ${key}`)).toBeTruthy();
    }
  });

  it('posts a set patch when a value is edited and Enter pressed (once, even when blur follows)', () => {
    const { posted } = setup({ meta: META });
    fireEvent.click(screen.getByLabelText('Edit owner'));
    const input = screen.getByLabelText('Value of owner');
    fireEvent.change(input, { target: { value: 'finance' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(posted).toEqual([{ type: 'updateMeta', payload: { modelName: 'fct_order', set: { owner: 'finance' } } }]);
    expect(screen.queryByLabelText('Value of owner')).toBeNull();
  });

  it('posts nothing when the value is unchanged', () => {
    const { posted } = setup({ meta: META });
    fireEvent.click(screen.getByLabelText('Edit owner'));
    fireEvent.keyDown(screen.getByLabelText('Value of owner'), { key: 'Enter' });
    expect(posted).toEqual([]);
  });

  it('posts nothing when the edit is cancelled with Escape', () => {
    const { posted } = setup({ meta: META });
    fireEvent.click(screen.getByLabelText('Edit owner'));
    const input = screen.getByLabelText('Value of owner');
    fireEvent.change(input, { target: { value: 'finance' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(posted).toEqual([]);
  });

  it('posts a remove patch for ×', () => {
    const { posted } = setup({ meta: META });
    fireEvent.click(screen.getByLabelText('Remove lineage'));
    expect(posted).toEqual([{ type: 'updateMeta', payload: { modelName: 'fct_order', remove: ['lineage'] } }]);
  });

  it('adds a new key with a set patch', () => {
    const { posted } = setup({ meta: META });
    fireEvent.click(screen.getByText('+ Add Metadata'));
    fireEvent.change(screen.getByLabelText('Metadata key'), { target: { value: '  steward ' } });
    const value = screen.getByLabelText('Metadata value');
    fireEvent.change(value, { target: { value: 'jane' } });
    fireEvent.keyDown(value, { key: 'Enter' });
    expect(posted).toEqual([{ type: 'updateMeta', payload: { modelName: 'fct_order', set: { steward: 'jane' } } }]);
    expect(screen.queryByLabelText('Metadata key')).toBeNull();
  });

  it('refuses a key that already exists, posting nothing', () => {
    const { posted, container } = setup({ meta: META });
    fireEvent.click(screen.getByText('+ Add Metadata'));
    fireEvent.change(screen.getByLabelText('Metadata key'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Metadata value'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Add'));
    expect(posted).toEqual([]);
    expect(container.querySelector('.meta-editor__error')?.textContent).toBe('"owner" already exists');
  });

  it('refuses an empty key, posting nothing', () => {
    const { posted, container } = setup({ meta: META });
    fireEvent.click(screen.getByText('+ Add Metadata'));
    fireEvent.click(screen.getByText('Add'));
    expect(posted).toEqual([]);
    expect(container.querySelector('.meta-editor__error')?.textContent).toBe('Key is required');
  });

  it('includes columnName in every patch when editing a column', () => {
    const { posted } = setup({ meta: { owner: 'a' }, columnName: 'amount' });
    fireEvent.click(screen.getByLabelText('Remove owner'));
    fireEvent.click(screen.getByText('+ Add Metadata'));
    fireEvent.change(screen.getByLabelText('Metadata key'), { target: { value: 'unit' } });
    fireEvent.change(screen.getByLabelText('Metadata value'), { target: { value: 'AUD' } });
    fireEvent.click(screen.getByText('Add'));
    expect(posted).toEqual([
      { type: 'updateMeta', payload: { modelName: 'fct_order', columnName: 'amount', remove: ['owner'] } },
      { type: 'updateMeta', payload: { modelName: 'fct_order', columnName: 'amount', set: { unit: 'AUD' } } },
    ]);
  });

  it('renders nothing when read-only with no entries', () => {
    expect(setup({ readOnly: true }).container.innerHTML).toBe('');
    expect(setup({ meta: {}, readOnly: true }).container.innerHTML).toBe('');
  });

  it('offers only the add button when editable with no entries', () => {
    const { container } = setup();
    expect(container.querySelector('.meta-editor__list')).toBeNull();
    expect(screen.getByText('+ Add Metadata')).toBeTruthy();
  });

  it('read-only shows the values with no edit, remove or add controls', () => {
    const { container } = setup({ meta: META, readOnly: true });
    expect(valueOf(container, 'owner')).toBe('analytics');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('viewer mode shows the values with no edit, remove or add controls', () => {
    const { container, posted } = setup({ meta: META }, true);
    expect(valueOf(container, 'owner')).toBe('analytics');
    expect(container.querySelectorAll('button')).toHaveLength(0);
    // Double-clicking a value does not start an edit either.
    fireEvent.doubleClick(container.querySelector('.meta-editor__text')!);
    expect(container.querySelector('input')).toBeNull();
    expect(posted).toEqual([]);
  });

  it('renders nothing in viewer mode with no entries', () => {
    expect(setup({}, true).container.innerHTML).toBe('');
  });
});
