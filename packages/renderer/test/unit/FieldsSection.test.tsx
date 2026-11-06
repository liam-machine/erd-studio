// @vitest-environment jsdom
/**
 * FieldsSection: a table's (or a column's) context fields, driven by core's
 * resolver over the project's field list (the starting set without one).
 * Each edit is the message the field's home has always used: rationale →
 * updateModelRationale ('' clears), meta → updateMeta (a clear removes the
 * key), grain → updateModelGrain, role → updateModelRole. The editor shows
 * the list in order with guidance, retired fields with a badge, values the
 * list does not name under "Not in your list", and "+ Add field". The viewer
 * and a read-only stage show the filled rows only, and post nothing.
 *
 * The meta guarantees the old MetaEditor pinned are kept here: one post per
 * Enter + blur, no post for an unchanged value or on Escape, structured
 * values read-only, a remove for every meta key, and nothing posted in the
 * viewer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { STARTING_FIELD_LIST, builtInField } from '@erd-studio/core';
import type { CanvasEditMessage, DisplayColumn, FieldDefinition, FieldList, Meta } from '@erd-studio/core';
import { FieldsSection, type FieldsTable } from '../../src/components/DetailPanel/FieldsSection';
import { formatMetaValue } from '../../src/lib/metaFormat';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';

afterEach(cleanup);

const META: Meta = {
  owner: 'analytics',
  lineage: { source: 'sap', table: 'mara' },
  tags: ['pii', 'gold'],
  certified: true,
  empty: null,
};

interface SetupOptions {
  table?: FieldsTable;
  column?: DisplayColumn;
  fields?: FieldList;
  readOnly?: boolean;
  logicalOnly?: boolean;
  viewer?: boolean;
}

function setup(options: SetupOptions = {}) {
  const posted: CanvasEditMessage[] = [];
  const utils = render(
    <CanvasEnvironmentProvider host={{ postMessage: (m) => posted.push(m) }} viewer={options.viewer ?? false}>
      <FieldsSection
        modelName="fct_order"
        table={options.table ?? {}}
        column={options.column}
        fields={options.fields}
        readOnly={options.readOnly}
        logicalOnly={options.logicalOnly}
      />
    </CanvasEnvironmentProvider>,
  );
  return { ...utils, posted };
}

/** The label of every row, top to bottom (editor and read-only). */
const labels = (container: HTMLElement) =>
  [...container.querySelectorAll('.fields-section__name')].map((el) => el.textContent);

/** The row element for a field id (`meta:owner`, `rationale:purpose`, `grain`, …). */
const rowOf = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-field="${id}"]`);

/** The shown value of a row. */
const valueOf = (container: HTMLElement, id: string) =>
  rowOf(container, id)?.querySelector('.fields-section__text, .fields-section__value')?.textContent;

const team = (def: Partial<FieldDefinition> & { key: string }, scope: 'table' | 'column' = 'table'): FieldDefinition => ({
  scope,
  label: def.key,
  type: 'text',
  filledBy: 'anyone',
  showFor: 'all',
  status: 'team',
  home: { kind: 'meta' },
  ...def,
});

/** A project's fields.yml: the starting set plus Owner (dbt), Sensitivity (people, choice) and Personal data (column, yes-no). */
const TEAM_LIST: FieldList = {
  tables: [
    ...STARTING_FIELD_LIST.tables,
    team({ key: 'owner', label: 'Owner', type: 'value', guidance: 'The team that owns it, e.g. crm-team.', filledBy: 'dbt' }),
    team({ key: 'sensitivity', label: 'Sensitivity', type: 'choice', values: ['public', 'internal', 'confidential'], filledBy: 'people' }),
  ],
  columns: [
    ...STARTING_FIELD_LIST.columns,
    team({ key: 'pii', label: 'Personal data', type: 'yes-no', filledBy: 'dbt' }, 'column'),
  ],
  leftOut: [],
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

describe('FieldsSection — the starting set', () => {
  it('lists the starting fields in order, with their guidance, for a table with no role', () => {
    const { container } = setup();
    expect(labels(container)).toEqual(['Grain', 'Purpose', 'Decisions', 'Open questions', 'Table role', 'History', 'Measures']);
    expect(screen.getByLabelText('Add Purpose').textContent).toBe('Who uses this table and the question it answers.');
    expect(screen.getByLabelText('Add Open questions').textContent).toBe('What is still undecided. Assistants ask about these and never guess.');
  });

  it('leaves out a field that does not suit the role, unless it has a value', () => {
    const dim = setup({ table: { modelRole: 'conformed-dim' } });
    expect(labels(dim.container)).toContain('History');
    expect(labels(dim.container)).not.toContain('Measures');
    cleanup();
    const fact = setup({ table: { modelRole: 'transaction-fact' } });
    expect(labels(fact.container)).not.toContain('History');
    expect(labels(fact.container)).toContain('Measures');
    cleanup();
    const filled = setup({ table: { modelRole: 'transaction-fact', rationale: { scdStrategy: 'Type 2 on status' } } });
    expect(valueOf(filled.container, 'rationale:scdStrategy')).toBe('Type 2 on status');
  });

  it('a rationale field posts one key, and an empty save clears it with ""', () => {
    const { posted } = setup({ table: { rationale: { purpose: 'Sales' } } });
    fireEvent.click(screen.getByLabelText('Add Decisions'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Decisions' }), { target: { value: '  Surrogate keys, because ids are reused.  ' } });
    fireEvent.click(screen.getByText('Save'));
    fireEvent.click(screen.getByLabelText('Edit Purpose'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Purpose' }), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Save'));
    expect(posted).toEqual([
      { type: 'updateModelRationale', payload: { modelName: 'fct_order', rationale: { decisions: 'Surrogate keys, because ids are reused.' } } },
      { type: 'updateModelRationale', payload: { modelName: 'fct_order', rationale: { purpose: '' } } },
    ]);
  });

  it('× clears a rationale field with ""; Open questions posts openQuestions', () => {
    const { posted } = setup({ table: { rationale: { purpose: 'Sales', openQuestions: 'Which currency?' } } });
    fireEvent.click(screen.getByLabelText('Clear Purpose'));
    fireEvent.click(screen.getByLabelText('Edit Open questions'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Open questions' }), { target: { value: 'Which currency, AUD?' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Open questions' }), { key: 'Enter', ctrlKey: true });
    expect(posted).toEqual([
      { type: 'updateModelRationale', payload: { modelName: 'fct_order', rationale: { purpose: '' } } },
      { type: 'updateModelRationale', payload: { modelName: 'fct_order', rationale: { openQuestions: 'Which currency, AUD?' } } },
    ]);
  });

  it('posts nothing for an unchanged text, or when the edit is cancelled with Escape', () => {
    const { posted } = setup({ table: { rationale: { purpose: 'Sales' } } });
    fireEvent.click(screen.getByLabelText('Edit Purpose'));
    fireEvent.click(screen.getByText('Save'));
    fireEvent.doubleClick(rowOf(document.body, 'rationale:purpose')!.querySelector('.fields-section__text')!);
    fireEvent.change(screen.getByRole('textbox', { name: 'Purpose' }), { target: { value: 'Changed' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Purpose' }), { key: 'Escape' });
    expect(posted).toEqual([]);
    expect(screen.queryByRole('textbox', { name: 'Purpose' })).toBeNull();
  });

  it('Grain posts updateModelGrain ("" clears it)', () => {
    const { posted } = setup({ table: { grain: 'One row per order' } });
    fireEvent.click(screen.getByLabelText('Edit Grain'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Grain' }), { target: { value: 'One row per order line' } });
    fireEvent.click(screen.getByText('Save'));
    fireEvent.click(screen.getByLabelText('Clear Grain'));
    expect(posted).toEqual([
      { type: 'updateModelGrain', payload: { modelName: 'fct_order', grain: 'One row per order line' } },
      { type: 'updateModelGrain', payload: { modelName: 'fct_order', grain: '' } },
    ]);
  });

  it('Table role is a dropdown of the roles with plain names, posting updateModelRole (null clears it)', () => {
    const { posted } = setup({ table: { modelRole: 'transaction-fact' } });
    const select = screen.getByRole('combobox', { name: 'Table role' }) as HTMLSelectElement;
    expect(select.value).toBe('transaction-fact');
    const options = [...select.options].map((o) => [o.value, o.textContent]);
    expect(options[0]).toEqual(['', 'Not set']);
    expect(options).toContainEqual(['gold-fact', 'Pre-joined fact']);
    expect(options).toContainEqual(['domain-dim', 'Local dimension']);
    fireEvent.change(select, { target: { value: 'periodic-snapshot' } });
    fireEvent.change(select, { target: { value: '' } });
    expect(posted).toEqual([
      { type: 'updateModelRole', payload: { modelName: 'fct_order', modelRole: 'periodic-snapshot' } },
      { type: 'updateModelRole', payload: { modelName: 'fct_order', modelRole: null } },
    ]);
  });

  it('keeps a role outside the list as a marked option, never replacing it', () => {
    setup({ table: { modelRole: 'bridge' as never } });
    const select = screen.getByRole('combobox', { name: 'Table role' }) as HTMLSelectElement;
    expect(select.value).toBe('bridge');
    expect(select.selectedOptions[0].textContent).toBe('bridge (not one of the choices)');
  });
});

describe('FieldsSection — retired and unlisted fields', () => {
  it('shows a retired field with a badge and its guidance, after the list, editable in place', () => {
    const { container, posted } = setup({ table: { rationale: { design: 'Transaction grain' } } });
    expect(labels(container).at(-1)).toBe('Design');
    const row = rowOf(container, 'rationale:design')!;
    expect(row.querySelector('.fields-section__badge--retired')!.textContent).toBe('Retired');
    expect(row.textContent).toContain('Move to Decisions, or to Purpose.');
    fireEvent.click(screen.getByLabelText('Edit Design'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Design' }), { target: { value: 'Kept' } });
    fireEvent.click(screen.getByText('Save'));
    expect(posted).toEqual([{ type: 'updateModelRationale', payload: { modelName: 'fct_order', rationale: { design: 'Kept' } } }]);
  });

  it('puts values the list does not name under "Not in your list": an optional built-in and meta keys', () => {
    const { container } = setup({ table: { rationale: { freshness: 'Daily' }, meta: { owner: 'crm-team' } } });
    const group = container.querySelector('.fields-section__group')!;
    expect(group.querySelector('.fields-section__group-title')!.textContent).toBe('Not in your list');
    expect([...group.querySelectorAll('.fields-section__name')].map((el) => el.textContent)).toEqual(['Freshness', 'owner']);
    expect(group.textContent).toContain('Kept as it is. Add it to fields.yml to give it a label and a type.');
  });

  it('a meta key named like a built-in is its own row, never the built-in (A2)', () => {
    const { container, posted } = setup({ table: { rationale: { purpose: 'Built-in' }, meta: { purpose: 'From meta' } } });
    expect(valueOf(container, 'rationale:purpose')).toBe('Built-in');
    expect(valueOf(container, 'meta:purpose')).toBe('From meta');
    expect(rowOf(container, 'meta:purpose')!.querySelector('.fields-section__name')!.textContent).toBe('purpose (metadata)');
    fireEvent.click(screen.getByLabelText('Remove purpose (metadata)'));
    expect(posted).toEqual([{ type: 'updateMeta', payload: { modelName: 'fct_order', remove: ['purpose'] } }]);
  });

  it('shows Import DBML\'s kept settings as one read-only row', () => {
    const { container } = setup({ table: { meta: { dbml: { headercolor: '#fff', tier: 'gold' } } } });
    const row = rowOf(container, 'meta:dbml')!;
    expect(row.querySelector('.fields-section__name')!.textContent).toBe('Kept from DBML import');
    expect(row.textContent).toContain('{ headercolor: #fff, tier: gold }');
    expect(row.querySelector('button')).toBeNull();
    expect(container.textContent).not.toContain('Not in your list');
  });

  it('a field from a newer core (unknown type or home) shows its value read-only', () => {
    const fields: FieldList = {
      tables: [team({ key: 'score', label: 'Score', type: 'rating' as never }), team({ key: 'tier', label: 'Tier', home: { kind: 'somewhere' } as never })],
      columns: [],
      leftOut: [],
    };
    const { container } = setup({ table: { meta: { score: '4', tier: 'gold' } }, fields });
    expect(valueOf(container, 'meta:score')).toBe('4');
    expect(valueOf(container, 'meta:tier')).toBe('gold');
    expect(screen.queryByLabelText('Edit Score')).toBeNull();
    expect(screen.queryByLabelText('Remove Score')).toBeNull();
    expect(screen.queryByLabelText('Edit Tier')).toBeNull();
  });
});

describe('FieldsSection — meta values (the old MetaEditor guarantees)', () => {
  it('shows text, nested, list, boolean and null values', () => {
    const { container } = setup({ table: { meta: META } });
    expect(valueOf(container, 'meta:owner')).toBe('analytics');
    expect(valueOf(container, 'meta:lineage')).toBe('{ source: sap, table: mara }');
    expect(valueOf(container, 'meta:tags')).toBe('[pii, gold]');
    expect(valueOf(container, 'meta:certified')).toBe('true');
    expect(valueOf(container, 'meta:empty')).toBe('—');
  });

  it('offers an edit only for a text value, and a remove for every key', () => {
    setup({ table: { meta: META } });
    expect(screen.getByLabelText('Edit owner')).toBeTruthy();
    for (const key of ['lineage', 'tags', 'empty']) {
      expect(screen.queryByLabelText(`Edit ${key}`)).toBeNull();
      expect(screen.getByLabelText(`Remove ${key}`)).toBeTruthy();
    }
    expect(screen.getByLabelText('Remove certified')).toBeTruthy();
  });

  it('posts a set patch on Enter, once, even when blur follows', () => {
    const { posted } = setup({ table: { meta: META } });
    fireEvent.click(screen.getByLabelText('Edit owner'));
    const input = screen.getByRole('textbox', { name: 'owner' });
    fireEvent.change(input, { target: { value: 'finance' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(posted).toEqual([{ type: 'updateMeta', payload: { modelName: 'fct_order', set: { owner: 'finance' } } }]);
    expect(screen.queryByRole('textbox', { name: 'owner' })).toBeNull();
  });

  it('posts nothing when the value is unchanged, or the edit is cancelled with Escape', () => {
    const { posted } = setup({ table: { meta: META } });
    fireEvent.click(screen.getByLabelText('Edit owner'));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'owner' }), { key: 'Enter' });
    fireEvent.click(screen.getByLabelText('Edit owner'));
    fireEvent.change(screen.getByRole('textbox', { name: 'owner' }), { target: { value: 'finance' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'owner' }), { key: 'Escape' });
    expect(posted).toEqual([]);
  });

  it('a meta text cleared in the panel is removed, not set to "" (A22)', () => {
    const { posted } = setup({ table: { meta: { owner: 'analytics' } } });
    fireEvent.click(screen.getByLabelText('Edit owner'));
    fireEvent.change(screen.getByRole('textbox', { name: 'owner' }), { target: { value: '' } });
    fireEvent.blur(screen.getByRole('textbox', { name: 'owner' }));
    expect(posted).toEqual([{ type: 'updateMeta', payload: { modelName: 'fct_order', remove: ['owner'] } }]);
  });

  it('shows a meta key holding "" in the editor so it can be removed', () => {
    const { container, posted } = setup({ table: { meta: { owner: '' } } });
    expect(rowOf(container, 'meta:owner')!.textContent).toContain('(empty)');
    fireEvent.click(screen.getByLabelText('Remove owner'));
    expect(posted).toEqual([{ type: 'updateMeta', payload: { modelName: 'fct_order', remove: ['owner'] } }]);
  });

  it('includes columnName in every patch of a column', () => {
    const column: DisplayColumn = { name: 'amount', dataType: 'decimal', description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: false, meta: { owner: 'a' } };
    const { posted } = setup({ column });
    fireEvent.click(screen.getByLabelText('Remove owner'));
    fireEvent.click(screen.getByText('+ Add field'));
    fireEvent.change(screen.getByLabelText('Field key'), { target: { value: 'unit' } });
    fireEvent.change(screen.getByLabelText('Field value'), { target: { value: 'AUD' } });
    fireEvent.click(screen.getByText('Add'));
    expect(posted).toEqual([
      { type: 'updateMeta', payload: { modelName: 'fct_order', columnName: 'amount', remove: ['owner'] } },
      { type: 'updateMeta', payload: { modelName: 'fct_order', columnName: 'amount', set: { unit: 'AUD' } } },
    ]);
  });
});

describe('FieldsSection — the team\'s own fields', () => {
  it('a value field is a one-line box with its guidance; dbt and people-only badges show', () => {
    const { container, posted } = setup({ fields: TEAM_LIST });
    expect(labels(container)).toEqual(['Grain', 'Purpose', 'Decisions', 'Open questions', 'Table role', 'History', 'Measures', 'Owner', 'Sensitivity']);
    expect(rowOf(container, 'meta:owner')!.querySelector('.fields-section__badge--dbt')!.textContent).toBe('from dbt');
    expect(rowOf(container, 'meta:sensitivity')!.querySelector('.fields-section__badge--people')!.textContent).toBe('people only');
    fireEvent.click(screen.getByLabelText('Add Owner'));
    const input = screen.getByRole('textbox', { name: 'Owner' }) as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect(input.placeholder).toBe('The team that owns it, e.g. crm-team.');
    fireEvent.change(input, { target: { value: 'crm-team' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(posted).toEqual([{ type: 'updateMeta', payload: { modelName: 'fct_order', set: { owner: 'crm-team' } } }]);
  });

  it('no "from dbt" badge without a dbt project', () => {
    const { container } = setup({ fields: TEAM_LIST, logicalOnly: true });
    expect(container.querySelector('.fields-section__badge--dbt')).toBeNull();
    expect(container.querySelector('.fields-section__badge--people')).toBeTruthy();
  });

  it('a choice is a dropdown of its values; "Not set" removes the key', () => {
    const { posted } = setup({ fields: TEAM_LIST, table: { meta: { sensitivity: 'internal' } } });
    const select = screen.getByRole('combobox', { name: 'Sensitivity' }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'public', 'internal', 'confidential']);
    expect(select.value).toBe('internal');
    fireEvent.change(select, { target: { value: 'confidential' } });
    fireEvent.change(select, { target: { value: '' } });
    expect(posted).toEqual([
      { type: 'updateMeta', payload: { modelName: 'fct_order', set: { sensitivity: 'confidential' } } },
      { type: 'updateMeta', payload: { modelName: 'fct_order', remove: ['sensitivity'] } },
    ]);
  });

  it('a value outside the choices is kept as a marked option', () => {
    setup({ fields: TEAM_LIST, table: { meta: { sensitivity: 'secret' } } });
    const select = screen.getByRole('combobox', { name: 'Sensitivity' }) as HTMLSelectElement;
    expect(select.value).toBe('secret');
    expect(select.selectedOptions[0].textContent).toBe('secret (not one of the choices)');
  });

  it('a yes-no column field reads a boolean as Yes and posts "true" / "false"', () => {
    const column: DisplayColumn = { name: 'email', dataType: 'varchar', description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: false, meta: { pii: true } };
    const { posted } = setup({ fields: TEAM_LIST, column });
    const select = screen.getByRole('combobox', { name: 'Personal data' }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Not set', 'Yes', 'No']);
    expect(select.value).toBe('true');
    fireEvent.change(select, { target: { value: 'false' } });
    expect(posted).toEqual([{ type: 'updateMeta', payload: { modelName: 'fct_order', columnName: 'email', set: { pii: 'false' } } }]);
  });
});

describe('FieldsSection — + Add field', () => {
  function add(key: string, value = 'x', meta: Meta = META, fields?: FieldList) {
    const result = setup({ table: { meta }, fields });
    fireEvent.click(screen.getByText('+ Add field'));
    fireEvent.change(screen.getByLabelText('Field key'), { target: { value: key } });
    fireEvent.change(screen.getByLabelText('Field value'), { target: { value } });
    return result;
  }
  const errorOf = (container: HTMLElement) => container.querySelector('.fields-section__error')?.textContent;

  it('adds a new key with a set patch, trimming the key', () => {
    const { posted } = add('  steward ', 'jane');
    fireEvent.keyDown(screen.getByLabelText('Field value'), { key: 'Enter' });
    expect(posted).toEqual([{ type: 'updateMeta', payload: { modelName: 'fct_order', set: { steward: 'jane' } } }]);
    expect(screen.queryByLabelText('Field key')).toBeNull();
  });

  it('refuses an empty key or one that already exists, posting nothing', () => {
    const empty = add('');
    fireEvent.click(screen.getByText('Add'));
    expect(empty.posted).toEqual([]);
    expect(errorOf(empty.container)).toBe('Key is required');
    cleanup();
    const taken = add('owner');
    fireEvent.click(screen.getByText('Add'));
    expect(taken.posted).toEqual([]);
    expect(errorOf(taken.container)).toBe('"owner" already exists');
  });

  it('refuses a reserved key and a built-in, pointing at the built-in', () => {
    const cases: Array<[string, string]> = [
      ['note', '"note" is a DBML setting and cannot be a field. Pick another key.'],
      ['alias', '"alias" is one of ERD Studio\'s own settings and cannot be a field. Pick another key.'],
      ['meta_owner', 'Keys starting erd_, rationale_ or meta_ are reserved. Pick another key.'],
      ['constructor', '"constructor" cannot be a field key. Pick another key.'],
      ['purpose', '"purpose" is the Purpose field: fill it in above.'],
      ['freshness', '"freshness" is the built-in field Freshness: add freshness to fields.yml to use it.'],
      // A retired built-in is never offered for fields.yml: its guidance says where the text goes.
      ['design', '"design" is a retired field. Move to Decisions, or to Purpose.'],
      ['role_choice', '"role_choice" is a retired field. Move to Decisions.'],
      ['grain_choice', '"grain_choice" is a retired field. Move to Decisions.'],
    ];
    for (const [key, message] of cases) {
      const { container, posted } = add(key, 'x', {});
      fireEvent.click(screen.getByText('Add'));
      expect(posted).toEqual([]);
      expect(errorOf(container)).toBe(message);
      cleanup();
    }
  });

  it('refuses a field the list already names', () => {
    const { container, posted } = add('owner', 'x', {}, TEAM_LIST);
    fireEvent.click(screen.getByText('Add'));
    expect(posted).toEqual([]);
    expect(errorOf(container)).toBe('"owner" is the Owner field: fill it in above.');
  });

  it('warns that a key that is not lower-case letters, digits and underscores goes into meta_json, and still adds it', () => {
    const { container, posted } = add('Source System', 'SAP', {});
    expect(container.querySelector('.fields-section__warning')!.textContent).toContain('meta_json');
    fireEvent.click(screen.getByText('Add'));
    expect(posted).toEqual([{ type: 'updateMeta', payload: { modelName: 'fct_order', set: { 'Source System': 'SAP' } } }]);
  });
});

describe('FieldsSection — Customise fields', () => {
  it('the editor\'s table section links to fields.yml with openFieldsFile', () => {
    const { posted } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Customise fields' }));
    expect(posted).toEqual([{ type: 'openFieldsFile' }]);
  });

  it('is not offered on a column, a read-only stage or in the viewer', () => {
    const column: DisplayColumn = { name: 'amount', dataType: 'decimal', description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: false, meta: { owner: 'a' } };
    for (const options of [{ column }, { readOnly: true, table: { grain: 'x' } }, { viewer: true, table: { grain: 'x' } }]) {
      setup(options);
      expect(screen.queryByRole('button', { name: 'Customise fields' })).toBeNull();
      cleanup();
    }
  });
});

describe('FieldsSection — columns', () => {
  it('lists only the fields kept in the column\'s meta (its typed fields stay in the row)', () => {
    const fields: FieldList = { ...TEAM_LIST, columns: [...TEAM_LIST.columns, builtInField('business_rule', 'column')!] };
    const column: DisplayColumn = {
      name: 'amount', dataType: 'decimal', description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: true, scdType: 2,
      meta: { business_rule: 'Net of tax', unit: 'AUD' },
    };
    const { container } = setup({ fields, column, table: { modelRole: 'transaction-fact' } });
    expect(labels(container)).toEqual(['Personal data', 'Business rule', 'unit']);
    expect(valueOf(container, 'meta:business_rule')).toBe('Net of tax');
  });

  it('with the starting set and no meta, offers only "+ Add field"', () => {
    const column: DisplayColumn = { name: 'amount', dataType: 'decimal', description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: false };
    const { container } = setup({ column });
    expect(container.querySelectorAll('.fields-section__field')).toHaveLength(0);
    expect(screen.getByText('+ Add field')).toBeTruthy();
  });
});

describe('FieldsSection — read-only (viewer and physical stage)', () => {
  const FILLED: FieldsTable = {
    grain: 'One row per order line',
    modelRole: 'transaction-fact',
    rationale: { purpose: 'Sales reporting', design: 'Old notes', decisions: '' },
    meta: { owner: 'crm-team', sensitivity: 'secret', blank: '', dbml: { tier: 'gold' } },
  };

  for (const options of [{ viewer: true }, { readOnly: true }, { viewer: true, readOnly: true }]) {
    const name = options.viewer ? (options.readOnly ? 'viewer on a read-only domain' : 'viewer') : 'physical stage';
    it(`${name}: filled rows only, in resolver order, labels and values, no headings, badges, guidance or controls`, () => {
      const { container, posted } = setup({ ...options, table: FILLED, fields: TEAM_LIST });
      expect(labels(container)).toEqual(['Grain', 'Purpose', 'Table role', 'Owner', 'Sensitivity', 'Design', 'Kept from DBML import']);
      expect(valueOf(container, 'role')).toBe('Transaction fact');
      expect(valueOf(container, 'meta:sensitivity')).toBe('secret');
      expect(container.textContent).not.toContain('Not in your list');
      expect(container.textContent).not.toContain('Retired');
      expect(container.textContent).not.toContain('from dbt');
      expect(container.textContent).not.toContain('people only');
      expect(container.textContent).not.toContain('Move to Decisions');
      expect(container.textContent).not.toContain('+ Add field');
      expect(container.querySelectorAll('button, input, select, textarea')).toHaveLength(0);
      fireEvent.doubleClick(rowOf(container, 'rationale:purpose')!);
      expect(container.querySelector('textarea')).toBeNull();
      expect(posted).toEqual([]);
    });
  }

  it('a yes-no reads Yes in the viewer', () => {
    const column: DisplayColumn = { name: 'email', dataType: 'varchar', description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: false, meta: { pii: 'true' } };
    const { container } = setup({ viewer: true, fields: TEAM_LIST, column });
    expect(valueOf(container, 'meta:pii')).toBe('Yes');
  });

  it('renders nothing when no field has a value', () => {
    for (const options of [{ viewer: true }, { readOnly: true }]) {
      expect(setup({ ...options, table: { grain: '  ', meta: {} } }).container.innerHTML).toBe('');
      cleanup();
    }
  });

  it('an unknown field type from a newer core still shows its value', () => {
    const fields: FieldList = { tables: [team({ key: 'score', label: 'Score', type: 'rating' as never })], columns: [], leftOut: [] };
    const { container } = setup({ viewer: true, table: { meta: { score: '4' } }, fields });
    expect(valueOf(container, 'meta:score')).toBe('4');
  });
});
