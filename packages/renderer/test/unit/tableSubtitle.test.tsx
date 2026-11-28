// @vitest-environment jsdom
/**
 * The line under a table's name beyond one node (#367): what a reader is
 * offered on a diagram (`tableSubtitleOptions`), what a choice is called
 * (`tableSubtitleLabel`), what the legend says, and `ErdCanvas`'s
 * `tableSubtitle` prop. The text for one table is pinned in
 * `ModelNode.subtitle.test.tsx`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { parseFieldsText, type DisplaySubjectArea, type DisplayTable } from '@erd-studio/core';

import { ErdCanvas } from '../../src/ErdCanvas';
import { legendFacts } from '../../src/components/Legend/Legend';
import { transformSubjectArea } from '../../src/lib/graphTransformer';
import { tableSubtitleLabel, tableSubtitleOptions } from '../../src/lib/tableSubtitle';

afterEach(() => cleanup());

const FIELDS = parseFieldsText(`version: 1
tables:
  - grain
  - key: purpose
    label: Why it exists
  - design
  - key: owner
    label: Owner
`).list;

const table = (name: string, extra: Partial<DisplayTable> = {}): DisplayTable => ({
  name,
  schema: 'sales',
  description: '',
  columns: [{ name: `${name}_key`, dataType: 'bigint', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false }],
  ...extra,
});

function area(extra: Partial<DisplaySubjectArea> = {}): DisplaySubjectArea {
  return {
    schemaVersion: 7, domain: 'sales', layer: 'gold', stage: 'logical', description: '',
    models: [
      table('dim_customer', {
        description: 'Every customer.',
        grain: 'One row per customer',
        rationale: { purpose: 'The customer list.', freshness: 'Hourly.' },
        meta: { owner: 'crm-team', steward: 'ana', purpose: 'a meta value beside the built-in', dbml: { note: 'kept' } },
      }),
      table('dim_region', { meta: { steward: 'bo', 'Data Owner': 'finance' } }),
    ],
    relationships: [], viewConfig: {}, readOnly: true, positionDraggable: false,
    fields: FIELDS,
    ...extra,
  } as DisplaySubjectArea;
}

const summary = (options: ReturnType<typeof tableSubtitleOptions>) => options.map((o) => `${o.group}|${o.value}|${o.label}`);

describe('what the line can be set to on a diagram', () => {
  it('the list\'s fields in order (retired ones left out), what the tables carry, then Description and Nothing', () => {
    expect(summary(tableSubtitleOptions(area()))).toEqual([
      'list|field:grain|Grain',
      'list|field:purpose|Why it exists',
      'list|field:owner|Owner',
      // An optional built-in the list leaves out, then `meta` keys no list names. Never
      // `meta.purpose` (the key means the built-in) or Import DBML's bookkeeping.
      'carried|field:freshness|Freshness',
      'carried|field:steward|steward',
      'carried|field:Data Owner|Data Owner',
      'other|description|Description',
      'other|none|Nothing',
    ]);
  });

  it('with no field list, the starting set; with no diagram, the starting set and the two fixed choices', () => {
    const noList = tableSubtitleOptions(area({ fields: undefined }));
    expect(noList.filter((o) => o.group === 'list').map((o) => o.label))
      .toEqual(['Grain', 'Purpose', 'Decisions', 'Open questions', 'Table role', 'History', 'Measures']);
    expect(noList.filter((o) => o.group === 'carried').map((o) => o.value)).toEqual(['field:freshness', 'field:owner', 'field:steward', 'field:Data Owner']);
    expect(tableSubtitleOptions(null).slice(-2).map((o) => o.value)).toEqual(['description', 'none']);
  });

  it('keeps a choice nothing here has, named as missing; never twice, and never for a choice that is offered', () => {
    expect(summary(tableSubtitleOptions(area(), 'field:cost_centre')).filter((row) => row.startsWith('missing'))).toEqual(['missing|field:cost_centre|cost_centre']);
    for (const offered of ['field:owner', 'field:steward', 'description', 'none', 'not a choice', undefined]) {
      expect(tableSubtitleOptions(area(), offered).some((o) => o.group === 'missing')).toBe(false);
    }
    // A built-in the list leaves out and no table fills in keeps its own label.
    expect(tableSubtitleOptions(area(), 'field:retention').find((o) => o.group === 'missing')?.label).toBe('Retention');
  });

  it('never throws on a malformed list or table', () => {
    const odd = area({ fields: { tables: [null, 7, { key: '' }, { key: 'owner' }] } as never, models: [table('t', { meta: 3 as never })] });
    // The grain is the choice in force, and nothing here has it: it is still shown, as missing.
    expect(summary(tableSubtitleOptions(odd))).toEqual([
      'list|field:owner|owner', 'missing|field:grain|Grain', 'other|description|Description', 'other|none|Nothing',
    ]);
    expect(summary(tableSubtitleOptions(odd, 'none'))).toEqual(['list|field:owner|owner', 'other|description|Description', 'other|none|Nothing']);
  });
});

describe('what a choice is called', () => {
  it('the list\'s label, else the built-in\'s, else the key', () => {
    expect(tableSubtitleLabel('field:grain', FIELDS)).toBe('Grain');
    expect(tableSubtitleLabel('field:purpose', FIELDS)).toBe('Why it exists');
    expect(tableSubtitleLabel('field:purpose')).toBe('Purpose');
    expect(tableSubtitleLabel('field:owner', FIELDS)).toBe('Owner');
    expect(tableSubtitleLabel('field:steward', FIELDS)).toBe('steward');
    expect(tableSubtitleLabel('description', FIELDS)).toBe('Description');
    expect(tableSubtitleLabel('none', FIELDS)).toBe('Nothing');
    expect(tableSubtitleLabel('nonsense', FIELDS)).toBe('Grain');
  });
});

describe('the legend', () => {
  const facts = (tableSubtitle?: string) => {
    const domain = area();
    const { nodes, edges } = transformSubjectArea(domain, tableSubtitle ? { tableSubtitle } : undefined);
    return legendFacts({ viewer: true, logicalOnly: true, domain, nodes, edges, ...(tableSubtitle ? { tableSubtitle } : {}) });
  };

  it('says grain for the grain, as before, and names any other choice', () => {
    expect([facts().grain, facts().subtitle]).toEqual([true, undefined]);
    expect([facts('field:owner').grain, facts('field:owner').subtitle]).toEqual([false, 'Owner']);
    expect(facts('description').subtitle).toBe('Description');
  });

  it('has no row for the line when no table draws one', () => {
    expect([facts('none').grain, facts('none').subtitle]).toEqual([false, undefined]);
    expect([facts('field:cost_centre').grain, facts('field:cost_centre').subtitle]).toEqual([false, undefined]);
  });
});

describe("ErdCanvas's tableSubtitle prop", () => {
  const settle = () => act(async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 10)); });
  const linesOf = (root: ParentNode) =>
    Object.fromEntries(
      [...root.querySelectorAll('.react-flow__node')].map((node) => [
        node.getAttribute('data-id'),
        node.querySelector('.model-node__grain')?.textContent ?? null,
      ]),
    );

  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  }

  it('draws the grain without it, and with a value that is not a choice', async () => {
    const domain = area();
    const { container, rerender } = render(<div style={{ width: 800, height: 600 }}><ErdCanvas domain={domain} /></div>);
    await settle();
    expect(linesOf(container)).toEqual({ dim_customer: 'One row per customer', dim_region: null });
    rerender(<div style={{ width: 800, height: 600 }}><ErdCanvas domain={domain} tableSubtitle={'owner' as string} /></div>);
    await settle();
    expect(linesOf(container)).toEqual({ dim_customer: 'One row per customer', dim_region: null });
  });

  it('follows the prop: a field, the description, nothing', async () => {
    const domain = area();
    const { container, rerender } = render(<div style={{ width: 800, height: 600 }}><ErdCanvas domain={domain} tableSubtitle="field:steward" /></div>);
    await settle();
    expect(linesOf(container)).toEqual({ dim_customer: 'ana', dim_region: 'bo' });
    expect(container.querySelector('.model-node__grain')?.className).toBe('model-node__grain model-node__grain--clipped');
    rerender(<div style={{ width: 800, height: 600 }}><ErdCanvas domain={domain} tableSubtitle="description" /></div>);
    await settle();
    expect(linesOf(container)).toEqual({ dim_customer: 'Every customer.', dim_region: null });
    rerender(<div style={{ width: 800, height: 600 }}><ErdCanvas domain={domain} tableSubtitle="none" /></div>);
    await settle();
    expect(linesOf(container)).toEqual({ dim_customer: null, dim_region: null });
  });
});
