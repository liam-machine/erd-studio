// @vitest-environment jsdom
/**
 * Two tables of one name from different schema folders on one diagram.
 *
 * A newer core names each `<schema>.<name>` (`bqs.addresse`, `ccc.addresse`)
 * and gives its own name beside it as `tableName`. The renderer keys
 * everything (node ids, edge ends, positions, selection) by that unique
 * name, as it always has, and prints the own name where a person reads one:
 * the header reads `ccc.addresse` once, the detail panel's title and rename
 * box `addresse`. A payload from an older core (no `tableName`) renders
 * exactly as before, and one with two tables sharing a name (what such a core
 * gives this diagram) does not crash.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type React from 'react';
import type { CanvasEditMessage, DisplaySubjectArea, DisplayTable } from '@erd-studio/core';

import { computeTableLabels, headerName } from '../../src/lib/modelLabels';
import { transformSubjectArea } from '../../src/lib/graphTransformer';
import { estimateNodeWidth } from '../../src/lib/nodeSizing';
import { TableNode } from '../../src/components/Graph/ModelNode';
import { AliasEditor } from '../../src/components/DetailPanel/AliasEditor';
import { DetailPanel } from '../../src/components/DetailPanel/DetailPanel';
import { createCanvasStore, CanvasStoreProvider } from '../../src/store/editorStore';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';
import { ErdCanvas } from '../../src/ErdCanvas';
import type { FkFlowEdge, TableFlowNode } from '../../src/types/graph';

beforeAll(() => {
  // React Flow measures nodes with a ResizeObserver, which jsdom lacks.
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;
});

afterEach(cleanup);

const col = (name: string, isPrimaryKey = false) => ({ name, dataType: 'int', description: '', isPrimaryKey, isForeignKey: false, isNaturalKey: false });

/** One of two same-named tables, as a newer core draws it. */
const twin = (schema: string, name: string, extra: Partial<DisplayTable> = {}): DisplayTable => ({
  name: `${schema}.${name}`, tableName: name, schema, layer: 'bronze', description: '', columns: [col('id', true), col('kunde_id')], ...extra,
});

function kunden(models: DisplayTable[] = [twin('bqs', 'addresse'), twin('ccc', 'addresse'), { name: 'kunde', schema: 'ccc', layer: 'bronze', description: '', columns: [col('id', true), col('addresse_id')] }]): DisplaySubjectArea {
  return {
    schemaVersion: 8, domain: 'kunden', layer: 'bronze', stage: 'logical', description: '',
    models,
    relationships: [
      { fromModel: 'ccc.addresse', fromColumn: 'id', toModel: 'bqs.addresse', toColumn: 'id', cardinality: 'many-to-one' },
      { fromModel: 'kunde', fromColumn: 'addresse_id', toModel: 'ccc.addresse', toColumn: 'id', cardinality: 'many-to-one' },
    ],
    viewConfig: { positions: { 'bqs.addresse': { x: 40, y: 40 }, 'ccc.addresse': { x: 40, y: 360 }, kunde: { x: 400, y: 360 } } },
    readOnly: false,
    positionDraggable: true,
  };
}

const modelNodes = (domain: DisplaySubjectArea) =>
  transformSubjectArea(domain).nodes.filter((n): n is TableFlowNode => n.type === 'model');

describe('labels and the header name', () => {
  it('a label starts from the own name, so two same-named tables get no label beyond their names', () => {
    const labels = computeTableLabels([
      { name: 'bqs.addresse', tableName: 'addresse', schema: 'bqs' },
      { name: 'ccc.addresse', tableName: 'addresse', schema: 'ccc' },
      { name: 'kunde', schema: 'ccc' },
    ]);
    expect([...labels]).toEqual([]);
  });

  it('two same-named tables whose files name no schema are labelled with their own name', () => {
    const labels = computeTableLabels([
      { name: 'bqs.addresse', tableName: 'addresse' },
      { name: 'ccc.addresse', tableName: 'addresse' },
    ]);
    expect([...labels]).toEqual([['bqs.addresse', 'addresse'], ['ccc.addresse', 'addresse']]);
  });

  it('the header prints the own name after a schema prefix, else the model name', () => {
    expect(headerName({ modelName: 'ccc.addresse', tableName: 'addresse', shownSchema: 'ccc' })).toBe('addresse');
    expect(headerName({ modelName: 'ccc.addresse', tableName: 'addresse' })).toBe('ccc.addresse');
    expect(headerName({ modelName: 'kunde', shownSchema: 'ccc' })).toBe('kunde');
    expect(headerName({ modelName: 'kunde' })).toBe('kunde');
  });
});

describe('transformSubjectArea', () => {
  it('gives each table its own node, id and position, and passes its own name to the header', () => {
    const nodes = modelNodes(kunden());
    expect(nodes.map((n) => [n.id, n.data.modelName, n.data.tableName ?? null, n.data.shownSchema ?? null])).toEqual([
      ['bqs.addresse', 'bqs.addresse', 'addresse', 'bqs'],
      ['ccc.addresse', 'ccc.addresse', 'addresse', 'ccc'],
      ['kunde', 'kunde', null, 'ccc'],
    ]);
    expect(nodes.map((n) => n.position)).toEqual([{ x: 40, y: 40 }, { x: 40, y: 360 }, { x: 400, y: 360 }]);
    expect(nodes.every((n) => !('label' in n.data))).toBe(true);
  });

  it('draws the line between the two tables between two nodes, not as a self-loop', () => {
    const edges = transformSubjectArea(kunden()).edges.filter((e): e is FkFlowEdge => e.type === 'fk');
    const between = edges.find((e) => e.data!.fromModel === 'ccc.addresse' && e.data!.toModel === 'bqs.addresse')!;
    expect(between.source).toBe('ccc.addresse');
    expect(between.target).toBe('bqs.addresse');
    expect(between.data!.isSelfLoop).toBeFalsy();
    const kundeEdge = edges.find((e) => e.data!.fromModel === 'kunde')!;
    expect([kundeEdge.source, kundeEdge.target]).toEqual(['kunde', 'ccc.addresse']);
  });

  it('an alias equal to the own name is not shown as one', () => {
    const [node] = modelNodes(kunden([twin('bqs', 'addresse', { alias: 'addresse' }), twin('ccc', 'addresse', { alias: 'adr' })]));
    expect(node.data).not.toHaveProperty('alias');
    expect(modelNodes(kunden([twin('bqs', 'addresse'), twin('ccc', 'addresse', { alias: 'adr' })]))[1].data.alias).toBe('adr');
  });

  it('two same-named tables whose files declare one schema (a copied schema folder) keep headers that tell them apart', () => {
    // tables/bqs/addresse.dbml and tables/bqs_backup/addresse.dbml both declare `Table bqs.addresse`.
    const nodes = modelNodes(kunden([twin('bqs', 'addresse'), { ...twin('bqs_backup', 'addresse'), schema: 'bqs' }]));
    const headers = nodes.map((n) => `${n.data.shownSchema}.${headerName(n.data)}`);
    expect(headers).toEqual(['bqs.bqs.addresse', 'bqs.bqs_backup.addresse']);
    expect(new Set(headers).size).toBe(2);
    // Each still compares an alias with its own name.
    expect(modelNodes(kunden([twin('bqs', 'addresse', { alias: 'addresse' }), { ...twin('bqs_backup', 'addresse'), schema: 'bqs' }]))[0].data).not.toHaveProperty('alias');
  });

  it('a blank tableName is no own name', () => {
    const [node] = modelNodes(kunden([{ ...twin('bqs', 'addresse'), tableName: '', alias: 'addresse' }]));
    expect(node.data).not.toHaveProperty('tableName');
    expect(node.data.alias).toBe('addresse');
  });

  it('an older core\'s payload (no tableName) gives exactly the node data it always did', () => {
    const plain = kunden([{ name: 'addresse', schema: 'ccc', layer: 'bronze', description: '', columns: [col('id', true)] }]);
    const [node] = modelNodes(plain);
    expect(node.id).toBe('addresse');
    expect(node.data).not.toHaveProperty('tableName');
    expect(node.data.modelName).toBe('addresse');
  });

  it('two tables sharing one name (what an older core gives this diagram) do not crash', () => {
    const older = kunden([
      { name: 'addresse', schema: 'bqs', description: '', columns: [col('id', true)] },
      { name: 'addresse', schema: 'ccc', description: '', columns: [col('id', true)] },
    ]);
    expect(() => transformSubjectArea(older)).not.toThrow();
  });
});

describe('TableNode header', () => {
  function renderNode(extra: Partial<TableFlowNode['data']>) {
    const data: TableFlowNode['data'] = {
      modelName: 'ccc.addresse', tableName: 'addresse', stage: 'logical', layer: 'bronze', columns: [], isStub: false, ...extra,
    };
    const Node = TableNode as unknown as React.ComponentType<{ data: TableFlowNode['data']; selected: boolean }>;
    return render(
      <CanvasStoreProvider store={createCanvasStore({})}>
        <ReactFlowProvider><Node data={data} selected={false} /></ReactFlowProvider>
      </CanvasStoreProvider>,
    );
  }

  it('reads ccc.addresse once, its schema as the prefix', () => {
    const { container } = renderNode({ shownSchema: 'ccc', schema: 'ccc' });
    const name = container.querySelector('.model-node__name')!;
    expect(name.textContent).toBe('ccc.addresse');
    expect(name.getAttribute('aria-label')).toBe('ccc.addresse');
    expect(container.querySelector('[data-model-name]')!.getAttribute('data-model-name')).toBe('ccc.addresse');
  });

  it('reads ccc.addresse once when no prefix is shown (the schema is the layer\'s name)', () => {
    const { container } = renderNode({ schema: 'ccc' });
    expect(container.querySelector('.model-node__name')!.textContent).toBe('ccc.addresse');
  });

  it('keeps the warehouse name after it', () => {
    const { container } = renderNode({ shownSchema: 'ccc', alias: 'adr' });
    expect(container.querySelector('.model-node__name')!.textContent).toBe('ccc.addresseas adr');
    expect(container.querySelector('.model-node__name')!.getAttribute('aria-label')).toBe('ccc.addresse (warehouse table adr)');
  });

  it('is sized for the name it prints', () => {
    const twinWidth = estimateNodeWidth({ modelName: 'ccc.a_long_table_name_for_addresses', tableName: 'a_long_table_name_for_addresses', shownSchema: 'ccc', columns: [] });
    const plainWidth = estimateNodeWidth({ modelName: 'a_long_table_name_for_addresses', shownSchema: 'ccc', columns: [] });
    expect(twinWidth).toBe(plainWidth);
  });
});

describe('detail panel', () => {
  function renderPanel(selectedNode: string) {
    const posted: CanvasEditMessage[] = [];
    const store = createCanvasStore({ domain: kunden(), selectedNode, detailPanelOpen: true });
    const utils = render(
      <CanvasStoreProvider store={store}>
        <CanvasEnvironmentProvider host={{ postMessage: (m: CanvasEditMessage) => { posted.push(m); } }}>
          <ReactFlowProvider><DetailPanel /></ReactFlowProvider>
        </CanvasEnvironmentProvider>
      </CanvasStoreProvider>,
    );
    return { ...utils, posted };
  }

  it('titles the table with its own name; the rename box starts from it and posts the diagram name as oldName', () => {
    const { container, posted } = renderPanel('ccc.addresse');
    expect(container.querySelector('.detail-panel__title')!.textContent).toBe('addresse');
    fireEvent.click(container.querySelector('.detail-panel__title-edit-btn')!);
    const input = container.querySelector<HTMLInputElement>('.detail-panel__title-input')!;
    expect(input.value).toBe('addresse');
    fireEvent.change(input, { target: { value: 'adresse2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(posted).toEqual([{ type: 'renameModel', payload: { oldName: 'ccc.addresse', newName: 'adresse2' } }]);
  });

  it('posts nothing for the own name unchanged, and refuses a case-only change of it', () => {
    const { container, posted } = renderPanel('ccc.addresse');
    fireEvent.click(container.querySelector('.detail-panel__title-edit-btn')!);
    const input = container.querySelector<HTMLInputElement>('.detail-panel__title-input')!;
    fireEvent.change(input, { target: { value: 'Addresse' } });
    expect(container.querySelector('.detail-panel__title-error')!.textContent).toContain('Only the upper/lower case differs');
    fireEvent.change(input, { target: { value: 'addresse' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(posted).toEqual([]);
  });

  it('a blank tableName titles the table with its name, and renames from it', () => {
    const posted: CanvasEditMessage[] = [];
    const domain = kunden([{ ...twin('bqs', 'addresse'), tableName: '' }]);
    const { container } = render(
      <CanvasStoreProvider store={createCanvasStore({ domain, selectedNode: 'bqs.addresse', detailPanelOpen: true })}>
        <CanvasEnvironmentProvider host={{ postMessage: (m: CanvasEditMessage) => { posted.push(m); } }}>
          <ReactFlowProvider><DetailPanel /></ReactFlowProvider>
        </CanvasEnvironmentProvider>
      </CanvasStoreProvider>,
    );
    expect(container.querySelector('.detail-panel__title')!.textContent).toBe('bqs.addresse');
    fireEvent.click(container.querySelector('.detail-panel__title-edit-btn')!);
    expect(container.querySelector<HTMLInputElement>('.detail-panel__title-input')!.value).toBe('bqs.addresse');
  });

  it('refuses the own name of another table on the diagram', () => {
    const { container } = renderPanel('bqs.addresse');
    fireEvent.click(container.querySelector('.detail-panel__title-edit-btn')!);
    const input = container.querySelector<HTMLInputElement>('.detail-panel__title-input')!;
    fireEvent.change(input, { target: { value: 'kunde' } });
    expect(container.querySelector('.detail-panel__title-error')!.textContent).toBe('A table with this name already exists');
  });
});

describe('detail panel rename: a DBML table is its schema folder and its name', () => {
  // kunde lives in `kundenSchema`; ccc.addresse and bqs.addresse in their own schema folders.
  function renameKundeTo(value: string, kundenSchema: string, existingSchemaFolder?: string): string | null {
    const store = createCanvasStore({ domain: kunden(), selectedNode: 'kunde', detailPanelOpen: true });
    store.getState().setCanvasContext({
      tableFiles: {
        'bqs.addresse': '.erd-studio/bronze/tables/bqs/addresse.dbml',
        'ccc.addresse': '.erd-studio/bronze/tables/ccc/addresse.dbml',
        kunde: `.erd-studio/bronze/tables/${kundenSchema}/kunde.dbml`,
      },
      offDiagram: {},
    });
    if (existingSchemaFolder !== undefined) {
      store.getState().setExistingModels([{ name: 'lieferant', schema: existingSchemaFolder, description: '', columnCount: 1, source: 'logical', sourcePath: `.erd-studio/bronze/tables/${existingSchemaFolder}/lieferant.dbml`, layer: 'bronze', schemaFolder: existingSchemaFolder }] as never);
    }
    const { container } = render(
      <CanvasStoreProvider store={store}>
        <CanvasEnvironmentProvider host={{ postMessage: () => {} }}>
          <ReactFlowProvider><DetailPanel /></ReactFlowProvider>
        </CanvasEnvironmentProvider>
      </CanvasStoreProvider>,
    );
    fireEvent.click(container.querySelector('.detail-panel__title-edit-btn')!);
    fireEvent.change(container.querySelector<HTMLInputElement>('.detail-panel__title-input')!, { target: { value } });
    return container.querySelector('.detail-panel__title-error')?.textContent ?? null;
  }

  it('refuses the name a table of its own schema folder has, on the diagram or in the Table Library', () => {
    expect(renameKundeTo('addresse', 'ccc')).toBe('A table with this name already exists');
    expect(renameKundeTo('lieferant', 'ccc', 'ccc')).toBe('A table with this name already exists in the Table Library');
  });

  it('allows a name only other schema folders\' tables have', () => {
    expect(renameKundeTo('addresse', 'ddd')).toBeNull();
    expect(renameKundeTo('lieferant', 'ddd', 'ccc')).toBeNull();
  });
});

describe('AliasEditor', () => {
  function setup(alias?: string) {
    const posted: unknown[] = [];
    const utils = render(
      <CanvasEnvironmentProvider host={{ postMessage: (m) => posted.push(m) }}>
        <AliasEditor modelName="ccc.addresse" tableName="addresse" alias={alias} readOnly={false} />
      </CanvasEnvironmentProvider>,
    );
    return { ...utils, posted };
  }

  it('shows the own name, dimmed, when there is no alias', () => {
    const { container } = setup();
    const value = container.querySelector('.detail-panel__value')!;
    expect(value.textContent).toBe('addresse');
    expect(value.getAttribute('title')).toBe("Same as the table's name");
  });

  it('clears an alias set to the own name, for the table the diagram names', () => {
    const { container, posted } = setup('adr');
    fireEvent.click(container.querySelector('.detail-panel__alias-edit-btn')!);
    const input = container.querySelector('input')!;
    expect(input.getAttribute('placeholder')).toBe('addresse');
    fireEvent.change(input, { target: { value: 'addresse' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(posted).toEqual([{ type: 'updateModelAlias', payload: { modelName: 'ccc.addresse', alias: '' } }]);
  });
});

describe('ErdCanvas', () => {
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  it('renders both tables as their own nodes, each header naming its schema once', async () => {
    const { container } = render(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={{ ...kunden(), readOnly: true }} />
      </div>,
    );
    await flush();
    const headers = [...container.querySelectorAll('.react-flow__node-model')].map((n) => [n.getAttribute('data-id'), n.querySelector('.model-node__name')!.textContent]);
    expect(headers).toEqual([['bqs.addresse', 'bqs.addresse'], ['ccc.addresse', 'ccc.addresse'], ['kunde', 'ccc.kunde']]);
  });

  it('renders what an older core gives this diagram (one name twice) without crashing', async () => {
    const older = kunden([
      { name: 'addresse', schema: 'bqs', description: '', columns: [col('id', true)] },
      { name: 'addresse', schema: 'ccc', description: '', columns: [col('id', true)] },
    ]);
    const { container } = render(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={{ ...older, readOnly: true }} />
      </div>,
    );
    await flush();
    expect(container.querySelectorAll('.react-flow__node-model').length).toBeGreaterThan(0);
  });
});
