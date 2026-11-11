// @vitest-environment jsdom
/**
 * The dialogs say where a new thing lands (DBML projects only):
 *  - New Table's Schema field: the host's default filled in, the layer's
 *    schema folders offered, the file it creates previewed, a name that
 *    cannot be a folder refused, and the schema sent as `schemaFolder`;
 *    no field and no `schemaFolder` without the host's `newTableSchemas`;
 *  - New Relationship asks the host where a new relationship goes when it
 *    opens to create one, and says "Will be stored in …" for the table
 *    holding the foreign key; with two or more files to choose from, a
 *    "Stored in" select, defaulting to the host's answer, whose pick is sent
 *    as `relationshipsFile` only when it is not the default.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as fs from 'fs';
import * as path from 'path';

const mockPostMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage: mockPostMessage, getState: vi.fn(), setState: vi.fn() }),
  getVsCodeApi: () => ({ postMessage: mockPostMessage, getState: vi.fn(), setState: vi.fn() }),
}));
vi.mock('@xyflow/react', () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { NewTableDialog, schemaFieldState } from '../../webview/components/NewModelDialog/NewModelDialog';
import { NewFkDialog, schemaFileHint, storedInChoiceLabel, storedInChoices, storedInText } from '../../webview/components/NewFkDialog/NewFkDialog';
import { useEditorStore } from '../../webview/store/editorStore';
import { SCHEMA_FOLDER_RULE } from '../../src/types/schemaFolder';

const initial = useEditorStore.getState();
const BLANK = { id: 'blank', label: 'Blank', prefix: '', description: '', columns: [] };
const CHOICE = { dir: '.erd-studio', layer: 'gold', schemas: ['Geo', 'gold', 'sales'], defaultSchema: 'sales' };
const col = (name: string, isPrimaryKey = false) =>
  ({ name, dataType: 'string', description: '', isPrimaryKey, isForeignKey: false, isNaturalKey: false });

function setDiagram(extra: Record<string, unknown> = {}) {
  useEditorStore.setState({
    domain: {
      schemaVersion: 7, domain: 'finance', layer: 'gold', stage: 'logical', description: '', readOnly: false, viewConfig: { positions: {} },
      models: [
        { name: 'fct_order', schema: 'sales', columns: [col('order_id', true), col('customer_id')] },
        { name: 'dim_customer', schema: 'sales', columns: [col('customer_id', true)] },
      ],
      relationships: [],
      ...extra,
    } as never,
    templates: [BLANK] as never,
  });
}

const input = (id: string) => document.getElementById(id) as HTMLInputElement | null;
const createButton = () => screen.getByRole('button', { name: 'Create Table' }) as HTMLButtonElement;
const sent = () => mockPostMessage.mock.calls.map(([m]) => m as { type: string; payload: Record<string, unknown> });

beforeEach(() => {
  mockPostMessage.mockClear();
  useEditorStore.setState(initial, true);
});
afterEach(cleanup);

describe('schemaFieldState', () => {
  it('blank or untouched is the default; typed text is trimmed', () => {
    expect(schemaFieldState(CHOICE, null, 'dim_store')).toEqual({ schema: 'sales', preview: 'Creates .erd-studio/gold/tables/sales/dim_store.dbml' });
    expect(schemaFieldState(CHOICE, '  ', '')).toEqual({ schema: 'sales', preview: 'Creates .erd-studio/gold/tables/sales/table_name.dbml' });
    expect(schemaFieldState(CHOICE, ' geo ', 'dim_store')).toEqual({ schema: 'geo', preview: 'Creates .erd-studio/gold/tables/Geo/dim_store.dbml' });
  });

  it('refuses a schema that cannot be a folder', () => {
    expect(schemaFieldState(CHOICE, 'a/b', 'x')?.error).toBe(SCHEMA_FOLDER_RULE);
  });

  it('no choice from the host (a YAML project): no field', () => {
    expect(schemaFieldState(undefined, 'sales', 'x')).toBeUndefined();
  });
});

describe('New Table: the Schema field', () => {
  function openDialog() {
    act(() => { useEditorStore.getState().setNewModelDialogOpen(true); });
    render(<NewTableDialog />);
  }

  it('fills in the default, offers the layer\'s schema folders and previews the file', () => {
    setDiagram({ newTableSchemas: CHOICE });
    openDialog();
    expect(screen.getByLabelText('Schema')).toBe(input('tableSchema'));
    expect(input('tableSchema')!.value).toBe('sales');
    const options = [...document.querySelectorAll('#tableSchemaChoices option')].map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['Geo', 'gold', 'sales']);
    fireEvent.change(input('modelName')!, { target: { value: 'dim_store' } });
    expect(screen.getByText('Creates .erd-studio/gold/tables/sales/dim_store.dbml')).toBeTruthy();
    fireEvent.change(input('tableSchema')!, { target: { value: 'finance' } });
    expect(screen.getByText('Creates .erd-studio/gold/tables/finance/dim_store.dbml')).toBeTruthy();
  });

  it('comes straight after the table name', () => {
    setDiagram({ newTableSchemas: CHOICE });
    openDialog();
    const fields = [...document.querySelectorAll('input, select, textarea')].map((e) => e.id).filter(Boolean);
    expect(fields.slice(0, 3)).toEqual(['modelName', 'tableSchema', 'template']);
  });

  it('refuses a schema that cannot be a folder, and Create stays off', () => {
    setDiagram({ newTableSchemas: CHOICE });
    openDialog();
    fireEvent.change(input('modelName')!, { target: { value: 'dim_store' } });
    expect(createButton().disabled).toBe(false);
    fireEvent.change(input('tableSchema')!, { target: { value: 'a/b' } });
    expect(screen.getByText(SCHEMA_FOLDER_RULE)).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });

  it('sends the schema with the table', () => {
    setDiagram({ newTableSchemas: CHOICE });
    openDialog();
    fireEvent.change(input('modelName')!, { target: { value: 'dim_store' } });
    fireEvent.change(input('tableSchema')!, { target: { value: ' finance ' } });
    fireEvent.click(createButton());
    expect(sent()).toEqual([expect.objectContaining({ type: 'addModel', payload: expect.objectContaining({ name: 'dim_store', schemaFolder: 'finance' }) })]);
  });

  it('a name a DBML table on the diagram has is refused only in that table\'s schema folder: in another it forms a pair', () => {
    setDiagram({
      newTableSchemas: CHOICE,
      models: [{ name: 'fct_order', schema: 'sales', layer: 'gold', columns: [col('order_id', true)] }],
    });
    openDialog();
    fireEvent.change(input('modelName')!, { target: { value: 'fct_order' } });
    fireEvent.blur(input('modelName')!);
    expect(screen.getByText(/Table "fct_order" already exists in this diagram/)).toBeTruthy();
    expect(createButton().disabled).toBe(true);
    fireEvent.change(input('tableSchema')!, { target: { value: 'finance' } });
    expect(screen.queryByText(/already exists in this diagram/)).toBeNull();
    expect(createButton().disabled).toBe(false);
    fireEvent.click(createButton());
    expect(sent()).toEqual([expect.objectContaining({ type: 'addModel', payload: expect.objectContaining({ name: 'fct_order', schemaFolder: 'finance' }) })]);
  });

  it('a YAML table on a DBML diagram (no layer) still refuses its name in any schema folder', () => {
    setDiagram({ newTableSchemas: CHOICE, models: [{ name: 'fct_refund', schema: '', columns: [col('id', true)] }] });
    openDialog();
    fireEvent.change(input('modelName')!, { target: { value: 'fct_refund' } });
    fireEvent.blur(input('modelName')!);
    fireEvent.change(input('tableSchema')!, { target: { value: 'finance' } });
    expect(screen.getByText(/Table "fct_refund" already exists in this diagram/)).toBeTruthy();
  });

  it('a YAML project: no Schema field, and no schema sent', () => {
    setDiagram();
    openDialog();
    expect(input('tableSchema')).toBeNull();
    expect(screen.queryByText(/^Creates /)).toBeNull();
    fireEvent.change(input('modelName')!, { target: { value: 'dim_store' } });
    fireEvent.click(createButton());
    const [message] = sent();
    expect(message.type).toBe('addModel');
    expect('schemaFolder' in message.payload).toBe(false);
  });
});

describe("New Relationship: how to give a schema its own relationships file", () => {
  it("says how, only when the relationship goes to its layer's shared file and the schema is not the layer", () => {
    expect(schemaFileHint('.erd-studio/source_aligned/relationships/source_aligned.dbml', 'accounts')).toBe(
      "That is the source_aligned layer's shared file. To keep the accounts schema's relationships apart, "
      + 'create .erd-studio/source_aligned/relationships/accounts.dbml (it can hold just a comment).',
    );
    // Already the schema's own file, or a team's split: nothing to suggest.
    expect(schemaFileHint('.erd-studio/source_aligned/relationships/shipping.dbml', 'shipping')).toBeUndefined();
    expect(schemaFileHint('.erd-studio/gold/relationships/finance.dbml', 'gold')).toBeUndefined();
    // A schema named as its layer (medallion, dbt layers): its layer's file is its own.
    expect(schemaFileHint('.erd-studio/gold/relationships/gold.dbml', 'GOLD')).toBeUndefined();
    expect(schemaFileHint(undefined, 'accounts')).toBeUndefined();
    expect(schemaFileHint('.erd-studio/gold/relationships/gold.dbml', undefined)).toBeUndefined();
  });
});

describe('New Relationship: where it will be stored', () => {
  const FILES = { fct_order: '.erd-studio/gold/relationships/finance.dbml', dim_customer: '.erd-studio/gold/relationships/gold.dbml' };

  it('names the file of the table that holds the foreign key', () => {
    expect(storedInText(FILES, { fromModel: 'FCT_ORDER', toModel: 'dim_customer', cardinality: 'many-to-one' }))
      .toBe('Will be stored in .erd-studio/gold/relationships/finance.dbml');
    // A one-to-many holds its key at its `to` end.
    expect(storedInText(FILES, { fromModel: 'fct_order', toModel: 'dim_customer', cardinality: 'one-to-many' }))
      .toBe('Will be stored in .erd-studio/gold/relationships/gold.dbml');
    expect(storedInText(FILES, { fromModel: '', toModel: 'dim_customer', cardinality: 'many-to-one' })).toBeUndefined();
    expect(storedInText(undefined, { fromModel: 'fct_order', toModel: 'dim_customer', cardinality: 'many-to-one' })).toBeUndefined();
  });

  const answer = (files: Record<string, string>) => act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'newRelationshipFiles', payload: { files } } }));
  });

  it('asks the host when it opens, and shows the answer once both tables are picked', () => {
    setDiagram();
    act(() => { useEditorStore.getState().setNewFkDialogOpen(true); });
    render(<NewFkDialog />);
    expect(sent().filter((m) => m.type === 'requestNewRelationshipFiles')).toHaveLength(1);
    answer(FILES);
    expect(screen.queryByText(/^Will be stored in/)).toBeNull();
    fireEvent.change(document.getElementById('fromModel')!, { target: { value: 'fct_order' } });
    fireEvent.change(document.getElementById('toModel')!, { target: { value: 'dim_customer' } });
    expect(screen.getByText('Will be stored in .erd-studio/gold/relationships/finance.dbml')).toBeTruthy();
  });

  it('says nothing when the host names no file (a YAML project)', () => {
    setDiagram();
    act(() => { useEditorStore.getState().setNewFkDialogOpen(true); });
    render(<NewFkDialog />);
    answer({});
    fireEvent.change(document.getElementById('fromModel')!, { target: { value: 'fct_order' } });
    fireEvent.change(document.getElementById('toModel')!, { target: { value: 'dim_customer' } });
    expect(screen.queryByText(/^Will be stored in/)).toBeNull();
  });
});

describe('New Relationship: choosing where it is stored', () => {
  const choice = (path: string) => ({ path, projectPath: `.erd-studio/${path}` });
  // fct_order (schema sales) in layer gold: its layer's shared file is the default, the finance team's file the other choice.
  const FILES = { fct_order: '.erd-studio/gold/relationships/gold.dbml', dim_customer: '.erd-studio/gold/relationships/gold.dbml' };
  const CHOICES = {
    fct_order: [choice('gold/relationships/gold.dbml'), choice('gold/relationships/finance.dbml')],
    dim_customer: [choice('gold/relationships/gold.dbml')],
  };
  const answer = (files: Record<string, string>, choices?: Record<string, unknown>) => act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'newRelationshipFiles', payload: { files, ...(choices ? { choices } : {}) } } }));
  });
  const select = () => document.getElementById('relationships-file') as HTMLSelectElement | null;
  const create = () => screen.getByRole('button', { name: 'Create Relationship' }) as HTMLButtonElement;
  const added = () => sent().filter((m) => m.type === 'addRelationship');

  /** Open New Relationship and pick fct_order.customer_id → dim_customer (its key, customer_id, filled in). */
  function openAndPick(choices: Record<string, unknown> | null = CHOICES, extra: Record<string, unknown> = {}) {
    setDiagram(extra);
    act(() => { useEditorStore.getState().setNewFkDialogOpen(true); });
    render(<NewFkDialog />);
    answer(FILES, choices ?? undefined);
    fireEvent.change(document.getElementById('fromModel')!, { target: { value: 'fct_order' } });
    fireEvent.change(document.getElementById('toModel')!, { target: { value: 'dim_customer' } });
  }

  it("storedInChoices: the foreign-key table's list, only with two or more", () => {
    expect(storedInChoices(CHOICES, { fromModel: 'FCT_ORDER', toModel: 'dim_customer', cardinality: 'many-to-one' })).toBe(CHOICES.fct_order);
    // A one-to-many holds its key at its `to` end, which has one choice: none to offer.
    expect(storedInChoices(CHOICES, { fromModel: 'fct_order', toModel: 'dim_customer', cardinality: 'one-to-many' })).toBeUndefined();
    expect(storedInChoices(undefined, { fromModel: 'fct_order', toModel: 'dim_customer', cardinality: 'many-to-one' })).toBeUndefined();
    expect(storedInChoices(CHOICES, { fromModel: '', toModel: 'dim_customer', cardinality: 'many-to-one' })).toBeUndefined();
    expect(storedInChoiceLabel(CHOICES.fct_order[0], 0)).toBe('.erd-studio/gold/relationships/gold.dbml (default)');
    expect(storedInChoiceLabel(CHOICES.fct_order[1], 1)).toBe('.erd-studio/gold/relationships/finance.dbml');
  });

  it('two or more files: a labelled "Stored in" select of project-relative paths, the default first and chosen', () => {
    openAndPick();
    expect(screen.getByLabelText('Stored in')).toBe(select());
    expect([...select()!.options].map((o) => o.textContent)).toEqual([
      '.erd-studio/gold/relationships/gold.dbml (default)',
      '.erd-studio/gold/relationships/finance.dbml',
    ]);
    expect(select()!.value).toBe('gold/relationships/gold.dbml');
    expect(screen.queryByText(/^Will be stored in/)).toBeNull();
  });

  it('the default sends no relationshipsFile; another pick sends its path relative to the semantic dir', () => {
    openAndPick();
    fireEvent.click(create());
    expect(added()).toHaveLength(1);
    expect('relationshipsFile' in added()[0].payload).toBe(false);

    mockPostMessage.mockClear();
    cleanup();
    openAndPick();
    fireEvent.change(select()!, { target: { value: 'gold/relationships/finance.dbml' } });
    expect(select()!.value).toBe('gold/relationships/finance.dbml');
    fireEvent.click(create());
    expect(added()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ fromModel: 'fct_order', toModel: 'dim_customer', relationshipsFile: 'gold/relationships/finance.dbml' }) })]);

    // Picking the default again sends nothing.
    mockPostMessage.mockClear();
    cleanup();
    openAndPick();
    fireEvent.change(select()!, { target: { value: 'gold/relationships/finance.dbml' } });
    fireEvent.change(select()!, { target: { value: 'gold/relationships/gold.dbml' } });
    fireEvent.click(create());
    expect('relationshipsFile' in added()[0].payload).toBe(false);
  });

  it("the schema hint follows the chosen file: only under the layer's shared file", () => {
    openAndPick();
    const hint = /^That is the gold layer's shared file\. To keep the sales schema's relationships apart/;
    expect(screen.getByText(hint)).toBeTruthy();
    expect(select()!.getAttribute('aria-describedby')).toBe('relationships-file-hint');
    fireEvent.change(select()!, { target: { value: 'gold/relationships/finance.dbml' } });
    expect(screen.queryByText(hint)).toBeNull();
    expect(select()!.getAttribute('aria-describedby')).toBeNull();
  });

  it("one file, or a host that sends no choices (an older one, a YAML project): today's plain line, nothing sent", () => {
    openAndPick({ fct_order: [choice('gold/relationships/gold.dbml')] });
    expect(select()).toBeNull();
    expect(screen.getByText('Will be stored in .erd-studio/gold/relationships/gold.dbml')).toBeTruthy();
    fireEvent.click(create());
    expect('relationshipsFile' in added()[0].payload).toBe(false);

    mockPostMessage.mockClear();
    cleanup();
    openAndPick(null);
    expect(select()).toBeNull();
    expect(screen.getByText('Will be stored in .erd-studio/gold/relationships/gold.dbml')).toBeTruthy();
  });

  it('turning the relationship round changes the table, and the pick goes back to its default', () => {
    openAndPick({ ...CHOICES, dim_customer: [choice('gold/relationships/gold.dbml'), choice('gold/relationships/customers.dbml')] });
    fireEvent.change(select()!, { target: { value: 'gold/relationships/finance.dbml' } });
    // Now dim_customer holds the key.
    fireEvent.change(document.getElementById('fromModel')!, { target: { value: 'dim_customer' } });
    fireEvent.change(document.getElementById('toModel')!, { target: { value: 'fct_order' } });
    expect([...select()!.options].map((o) => o.value)).toEqual(['gold/relationships/gold.dbml', 'gold/relationships/customers.dbml']);
    expect(select()!.value).toBe('gold/relationships/gold.dbml');
  });

  it('editing a relationship: no choice (it stays where it is), and nothing asked', () => {
    setDiagram({ relationships: [{ fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one' }] });
    act(() => {
      useEditorStore.getState().openFkDialogForEdit({ fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one' } as never);
    });
    render(<NewFkDialog />);
    answer(FILES, CHOICES);
    expect(sent().filter((m) => m.type === 'requestNewRelationshipFiles')).toHaveLength(0);
    expect(select()).toBeNull();
    expect(screen.queryByText(/^Will be stored in/)).toBeNull();
  });

  it('the physical stage offers no choice', () => {
    openAndPick(CHOICES, { stage: 'physical' });
    expect(select()).toBeNull();
  });

  it('the "Stored in" band sits outside the scrolling fields, just above the buttons, so the file stays in view', () => {
    openAndPick(CHOICES);
    const band = document.querySelector('.new-fk-dialog__stored-in')!;
    expect(band.closest('.new-fk-dialog__content')).toBeNull();
    expect(band.nextElementSibling?.classList.contains('new-fk-dialog__footer')).toBe(true);
  });
});

describe('New Relationship: the "Stored in" band', () => {
  // jsdom has no layout, so this pins the CSS rule. On a short canvas the fields above
  // scroll and are cut off; without a band of its own the cut Role hint ran straight into
  // "Stored in" and the two read as overlapping (#275).
  const css = fs.readFileSync(path.join(__dirname, '../../webview/components/NewFkDialog/NewFkDialog.css'), 'utf8');
  const rule = css.slice(css.indexOf('.new-fk-dialog__stored-in {'), css.indexOf('}', css.indexOf('.new-fk-dialog__stored-in {')) + 1);

  it('never shrinks, and a divider and top padding set it apart from the scrolling fields, in theme colours only', () => {
    expect(rule).toContain('flex-shrink: 0;');
    expect(rule).toMatch(/border-top: 1px solid var\(--panel-border\);/);
    const padding = /\n  padding: (\d+)px/.exec(rule);
    expect(Number(padding?.[1])).toBeGreaterThan(0);
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
