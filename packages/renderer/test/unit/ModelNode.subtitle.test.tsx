// @vitest-environment jsdom
/**
 * #367: the one line under a table's name (`.model-node__grain`) shows what
 * the reader chose, not only the grain.
 *
 * - `transformSubjectArea(domain, { tableSubtitle })`, where `tableSubtitle`
 *   is `field:<key>` (a TABLE field of `domain.fields ?? STARTING_FIELD_LIST`,
 *   built-in or the team's own, or a value the table carries that no list
 *   names), `description`, or `none`. Absent, or anything else: the grain,
 *   as before the choice existed. A prefixed key, so a team field that is
 *   itself named `description` or `none` (both legal field keys) never
 *   collides with the two choices.
 * - For the grain the node data is what it always was (`grain`, no
 *   `subtitle`), so nothing that draws the grain changes. For any other
 *   choice it carries `subtitle`: the text, or null for no line. `TableNode`
 *   draws `nodeSubtitle(data)` in `.model-node__grain` with the full text as
 *   its `title`; `resolveNodeDimensions` reserves the line's height only
 *   when there is one.
 * - No value (or only blank text) for the chosen field: no line, no height,
 *   never another field's value in its place.
 * - A line that is not the grain never widens its card
 *   (`.model-node__grain--clipped`).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type React from 'react';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
}));

const noop = vi.fn();
const mockStoreState: Record<string, unknown> = {
  highlightedColumns: new Set<string>(),
  startDragLine: noop,
  updateDragLineMouse: noop,
  endDragLine: noop,
  dragLineState: null,
  openNodeContextMenu: noop,
};

vi.mock('../../src/store/editorStore', () => ({
  useEditorStore: (selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

import { parseFieldsText, type DisplaySubjectArea, type DisplayTable } from '@erd-studio/core';
import { TableNode } from '../../src/components/Graph/ModelNode';
import { transformSubjectArea, type TransformOptions } from '../../src/lib/graphTransformer';
import { resolveNodeDimensions } from '../../src/lib/nodeSizing';
import type { TableFlowNode } from '../../src/types/graph';

afterEach(() => cleanup());

const FIELDS = parseFieldsText(`version: 1
tables:
  - grain
  - purpose
  - role
  - key: owner
    label: Owner
    type: value
  - key: description
    label: Team description
  - key: blank
`).list;

function table(name: string, extra: Partial<DisplayTable> = {}): DisplayTable {
  return {
    name,
    schema: 'sales',
    description: '',
    columns: [{ name: `${name}_key`, dataType: 'bigint', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false }],
    ...extra,
  };
}

/** dim_customer has every value; dim_region has a purpose, an owner and a description but no grain; dim_bare has nothing. */
function area(): DisplaySubjectArea {
  return {
    schemaVersion: 7,
    domain: 'sales',
    layer: 'gold',
    stage: 'logical',
    description: '',
    models: [
      table('dim_customer', {
        description: 'Every customer who has placed an order.',
        grain: 'One row per customer',
        rationale: { purpose: 'The one customer list every mart joins to.' },
        meta: { owner: 'crm-team', description: 'Owned by CRM' },
        modelRole: 'conformed-dim',
      }),
      table('dim_region', {
        description: 'Sales regions.',
        rationale: { purpose: 'Region roll-ups for finance.' },
        meta: { owner: 'finance-team', blank: '' },
      }),
      table('dim_bare'),
    ],
    relationships: [],
    viewConfig: {},
    readOnly: false,
    positionDraggable: true,
    fields: FIELDS,
  } as DisplaySubjectArea;
}

const transform = (options?: Record<string, unknown>) =>
  transformSubjectArea(area(), options as TransformOptions | undefined).nodes as TableFlowNode[];
const dataOf = (nodes: TableFlowNode[], id: string) => nodes.find((n) => n.id === id)!.data;

function lineOf(data: TableFlowNode['data']): { text: string | null; title: string | null } {
  const Node = TableNode as unknown as React.ComponentType<{ data: TableFlowNode['data']; selected: boolean }>;
  const { container } = render(<Node data={data} selected={false} />);
  const el = container.querySelector('.model-node__grain');
  const out = { text: el?.textContent ?? null, title: el?.getAttribute('title') ?? null };
  cleanup();
  return out;
}

function classOf(data: TableFlowNode['data']): string | null {
  const Node = TableNode as unknown as React.ComponentType<{ data: TableFlowNode['data']; selected: boolean }>;
  const { container } = render(<Node data={data} selected={false} />);
  const out = container.querySelector('.model-node__grain')?.className ?? null;
  cleanup();
  return out;
}

const height = (data: TableFlowNode['data']) => resolveNodeDimensions({ data, measured: undefined }).height;

describe('#367 with no choice: the line under the name is the grain, as it always was', () => {
  it('shows a table\'s grain, in full on hover', () => {
    expect(lineOf(dataOf(transform(), 'dim_customer'))).toEqual({ text: 'One row per customer', title: 'One row per customer' });
  });

  it('shows no line for a table with a purpose, a team field and a description but no grain', () => {
    const nodes = transform();
    expect(lineOf(dataOf(nodes, 'dim_region')).text).toBeNull();
    expect(lineOf(dataOf(nodes, 'dim_bare')).text).toBeNull();
    // and reserves no height for one: the 15px row is grain's alone
    expect(height(dataOf(nodes, 'dim_customer')) - height(dataOf(nodes, 'dim_bare'))).toBe(15);
    expect(height(dataOf(nodes, 'dim_region'))).toBe(height(dataOf(nodes, 'dim_bare')));
  });

  it('anything that is not a choice reads as the grain: the node data is identical', () => {
    const plain = transform();
    for (const value of ['purpose', 'owner', 'Description', 'field:', 'field: owner', 'meta:owner', '', 7, null, { kind: 'none' }]) {
      expect(transform({ tableSubtitle: value }).map((n) => n.data)).toEqual(plain.map((n) => n.data));
    }
    expect(transform({ tableSubtitle: 'field:grain' }).map((n) => n.data)).toEqual(plain.map((n) => n.data));
  });

  it('the grain line sizes the card as before: it is never marked clipped', () => {
    expect(dataOf(transform(), 'dim_customer')).not.toHaveProperty('subtitle');
    expect(classOf(dataOf(transform(), 'dim_customer'))).toBe('model-node__grain');
  });

  it('the node data carries no purpose, owner or description text to draw: only grain reaches the card', () => {
    const data = dataOf(transform(), 'dim_region');
    const text = JSON.stringify(data);
    expect(text).not.toContain('Region roll-ups for finance.');
    expect(text).not.toContain('Sales regions.');
    expect(data).toHaveProperty('meta'); // the team field rides along only for the hover card
    expect(data).toHaveProperty('hasRationale', true); // a flag, not the text
    expect(data).not.toHaveProperty('grain');
  });
});

describe('#367 the chosen field: the line shows what the setting names', () => {
  const choose = (tableSubtitle: string) => transform({ tableSubtitle });

  it('absent means grain, as today', () => {
    expect(lineOf(dataOf(transform(), 'dim_customer')).text).toBe('One row per customer');
    expect(lineOf(dataOf(choose('field:grain'), 'dim_customer')).text).toBe('One row per customer');
  });

  it('a built-in text field (purpose) shows its text on every table that has one', () => {
    const nodes = choose('field:purpose');
    expect(dataOf(nodes, 'dim_customer')).toHaveProperty('subtitle', 'The one customer list every mart joins to.');
    expect(lineOf(dataOf(nodes, 'dim_region'))).toEqual({ text: 'Region roll-ups for finance.', title: 'Region roll-ups for finance.' });
  });

  it('a team field from fields.yml (owner) shows its value', () => {
    const nodes = choose('field:owner');
    expect(lineOf(dataOf(nodes, 'dim_customer')).text).toBe('crm-team');
    expect(lineOf(dataOf(nodes, 'dim_region')).text).toBe('finance-team');
  });

  it('the table\'s description shows its description', () => {
    const nodes = choose('description');
    expect(lineOf(dataOf(nodes, 'dim_customer')).text).toBe('Every customer who has placed an order.');
    expect(lineOf(dataOf(nodes, 'dim_region')).text).toBe('Sales regions.');
  });

  it('a team field that is itself named `description` is that field, not the table description', () => {
    expect(lineOf(dataOf(choose('field:description'), 'dim_customer')).text).toBe('Owned by CRM');
  });

  it('a table with no value for the chosen field shows no line and reserves no height (no fallback to grain)', () => {
    const nodes = choose('field:purpose');
    expect(lineOf(dataOf(nodes, 'dim_bare')).text).toBeNull();
    expect(dataOf(nodes, 'dim_bare')).toHaveProperty('subtitle', null);
    expect(lineOf(dataOf(choose('field:owner'), 'dim_bare')).text).toBeNull();
    // dim_region has no grain: choosing grain shows nothing there
    expect(lineOf(dataOf(choose('field:grain'), 'dim_region')).text).toBeNull();
  });

  it('blank text is no value: no empty line', () => {
    expect(lineOf(dataOf(choose('field:blank'), 'dim_region')).text).toBeNull();
  });

  it('`none` hides the line on every table, and its height', () => {
    const nodes = choose('none');
    for (const id of ['dim_customer', 'dim_region', 'dim_bare']) {
      expect(lineOf(dataOf(nodes, id)).text).toBeNull();
    }
    expect(height(dataOf(nodes, 'dim_customer'))).toBe(height(dataOf(nodes, 'dim_bare')));
  });

  it('the reserved height follows the chosen line, not the grain', () => {
    const nodes = choose('field:purpose');
    expect(height(dataOf(nodes, 'dim_region')) - height(dataOf(nodes, 'dim_bare'))).toBe(15);
  });
});

describe('#367 what the line reads as', () => {
  const withMeta = (meta: Record<string, unknown>, extra: Partial<DisplayTable> = {}): DisplaySubjectArea => ({
    ...area(),
    models: [table('dim_x', { grain: 'One row per x', meta: meta as DisplayTable['meta'], ...extra })],
  });
  const line = (domain: DisplaySubjectArea, tableSubtitle: string) =>
    lineOf(dataOf(transformSubjectArea(domain, { tableSubtitle }).nodes as TableFlowNode[], 'dim_x'));

  it('a value that is not text is one line of text, never a crash or an empty strip', () => {
    expect(line(withMeta({ owner: ['crm', 'finance'] }), 'field:owner').text).toBe('[crm, finance]');
    expect(line(withMeta({ owner: { team: 'crm', lead: 'ana' } }), 'field:owner').text).toBe('{ team: crm, lead: ana }');
    expect(line(withMeta({ owner: true }), 'field:owner').text).toBe('true');
    expect(line(withMeta({ owner: null }), 'field:owner').text).toBeNull();
    expect(line(withMeta({ owner: '   ' }), 'field:owner').text).toBeNull();
  });

  it('a yes / no field says which question it answers; a role reads as its label', () => {
    const list = parseFieldsText('version: 1\ntables:\n  - grain\n  - role\n  - key: certified\n    label: Certified\n    type: yes-no\n').list;
    const domain = { ...withMeta({ certified: true }, { modelRole: 'conformed-dim' }), fields: list } as DisplaySubjectArea;
    expect(line(domain, 'field:certified').text).toBe('Certified: Yes');
    expect(line(domain, 'field:role').text).toBe('Conformed dimension');
  });

  it('a value no list names can still be chosen by its key', () => {
    const domain = { ...withMeta({ steward: 'ana' }), fields: undefined } as DisplaySubjectArea;
    expect(line(domain, 'field:steward').text).toBe('ana');
  });

  it('`field:purpose` is the Purpose field, never a `meta.purpose` beside it', () => {
    const domain = withMeta({ purpose: 'from meta' }, { rationale: { purpose: 'from rationale' } });
    expect(line(domain, 'field:purpose').text).toBe('from rationale');
    expect(line(withMeta({ purpose: 'from meta' }), 'field:purpose').text).toBeNull();
  });

  it('a line that is not the grain is clipped to the card: it never widens a table', () => {
    const nodes = transformSubjectArea(area(), { tableSubtitle: 'description' }).nodes as TableFlowNode[];
    expect(classOf(dataOf(nodes, 'dim_customer'))).toBe('model-node__grain model-node__grain--clipped');
    expect(classOf(dataOf(nodes, 'dim_bare'))).toBeNull();
  });

  it('a display from an older core, with no field list, still resolves against the starting set', () => {
    const domain = { ...area(), fields: undefined } as DisplaySubjectArea;
    const nodes = transformSubjectArea(domain, { tableSubtitle: 'field:purpose' }).nodes as TableFlowNode[];
    expect(dataOf(nodes, 'dim_region')).toHaveProperty('subtitle', 'Region roll-ups for finance.');
  });
});

describe('#367 node data built without the choice (an older transformer, a host of its own)', () => {
  it('draws its grain and reserves its height, exactly as before', () => {
    const data = { ...dataOf(transform(), 'dim_bare'), grain: 'One row per thing' };
    expect(lineOf(data)).toEqual({ text: 'One row per thing', title: 'One row per thing' });
    expect(classOf(data)).toBe('model-node__grain');
    expect(height(data) - height(dataOf(transform(), 'dim_bare'))).toBe(15);
  });
});
