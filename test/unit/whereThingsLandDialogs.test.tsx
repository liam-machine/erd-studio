// @vitest-environment jsdom
/**
 * The dialogs say where a new thing lands (DBML projects only):
 *  - New Table's Schema field: the host's default filled in, the layer's
 *    schema folders offered, the file it creates previewed, a name that
 *    cannot be a folder refused, and the schema sent as `schemaFolder`;
 *    no field and no `schemaFolder` without the host's `newTableSchemas`;
 *  - New Relationship asks the host where a new relationship goes when it
 *    opens to create one, and says "Will be stored in …" for the table
 *    holding the foreign key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const mockPostMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage: mockPostMessage, getState: vi.fn(), setState: vi.fn() }),
  getVsCodeApi: () => ({ postMessage: mockPostMessage, getState: vi.fn(), setState: vi.fn() }),
}));
vi.mock('@xyflow/react', () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { NewTableDialog, schemaFieldState } from '../../webview/components/NewModelDialog/NewModelDialog';
import { NewFkDialog, schemaFileHint, storedInText } from '../../webview/components/NewFkDialog/NewFkDialog';
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
