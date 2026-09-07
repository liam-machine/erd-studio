/**
 * graphTransformer.transformDomain — DisplayDomain → React Flow nodes/edges:
 * node data mapping, edge endpoint filtering, self-loops, annotations and the
 * discrepancy overlay (ghost nodes / edges). Complements graphTransformer.test.ts,
 * which covers handle-side selection geometry.
 */
import { describe, expect, it } from 'vitest';

import { transformDomain, type TransformResult } from '../../webview/lib/graphTransformer';
import type { DisplayColumn, DisplayDomain, DisplayModel, DisplayRelationship } from '../../src/types/display';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import type { AnnotationFlowEdge, AnnotationFlowNode, FkFlowEdge, ModelFlowNode } from '../../webview/types/graph';

function column(name: string, overrides: Partial<DisplayColumn> = {}): DisplayColumn {
  return { name, dataType: 'string', description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: false, ...overrides };
}

function model(name: string, overrides: Partial<DisplayModel> = {}): DisplayModel {
  return { name, schema: 'silver', description: '', columns: [column(`${name}_id`, { isPrimaryKey: true })], ...overrides };
}

function rel(fromModel: string, toModel: string, overrides: Partial<DisplayRelationship> = {}): DisplayRelationship {
  return { fromModel, fromColumn: `${toModel}_id`, toModel, toColumn: `${toModel}_id`, cardinality: 'many-to-one', ...overrides };
}

function domain(overrides: Partial<DisplayDomain> = {}): DisplayDomain {
  return {
    schemaVersion: 5,
    domain: 'orders',
    layer: 'silver',
    stage: 'logical',
    description: '',
    models: [],
    relationships: [],
    viewConfig: {},
    readOnly: false,
    positionDraggable: true,
    ...overrides,
  } as DisplayDomain;
}

const modelNodes = (r: TransformResult) => r.nodes.filter((n) => n.type === 'model') as ModelFlowNode[];
const annotationNodes = (r: TransformResult) => r.nodes.filter((n) => n.type === 'annotation') as AnnotationFlowNode[];
const fkEdges = (r: TransformResult) => r.edges.filter((e) => e.type === 'fk') as FkFlowEdge[];
const linkEdges = (r: TransformResult) => r.edges.filter((e) => e.type === 'annotationLink') as AnnotationFlowEdge[];
const nodeById = (r: TransformResult, id: string) => modelNodes(r).find((n) => n.id === id)!;

describe('transformDomain nodes', () => {
  it('maps each model to a model node at its saved position, or the origin when unsaved', () => {
    const result = transformDomain(domain({
      models: [model('fact_order'), model('dim_customer')],
      viewConfig: { positions: { dim_customer: { x: 300, y: 40 } } },
    }));

    expect(modelNodes(result).map((n) => n.id)).toEqual(['fact_order', 'dim_customer']);
    expect(nodeById(result, 'fact_order').position).toEqual({ x: 0, y: 0 });
    expect(nodeById(result, 'dim_customer').position).toEqual({ x: 300, y: 40 });
    const data = nodeById(result, 'dim_customer').data;
    expect(data.modelName).toBe('dim_customer');
    expect(data.stage).toBe('logical');
    expect(data.layer).toBe('silver');
    expect(data.schema).toBe('silver');
    expect(data.isStub).toBe(false);
    expect(data).not.toHaveProperty('readOnly');
    expect(data).not.toHaveProperty('isGhost');
    expect(data).not.toHaveProperty('discrepancy');
  });

  it('carries column flags and only the optional fields that are set', () => {
    const result = transformDomain(domain({
      models: [model('dim_customer', {
        columns: [
          column('customer_id', { isPrimaryKey: true, description: 'Surrogate key', scdType: 0 }),
          column('customer_nk', { isNaturalKey: true, scdType: 2, additiveType: 'non-additive', dataType: 'int' }),
          column('region_id', { isForeignKey: true }),
        ],
      })],
    }));

    const [pk, nk, fk] = nodeById(result, 'dim_customer').data.columns;
    expect(pk).toEqual({ name: 'customer_id', dataType: 'string', description: 'Surrogate key', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false, scdType: 0 });
    expect(nk).toEqual({ name: 'customer_nk', dataType: 'int', isPrimaryKey: false, isForeignKey: false, isNaturalKey: true, scdType: 2, additiveType: 'non-additive' });
    expect(fk).toEqual({ name: 'region_id', dataType: 'string', isPrimaryKey: false, isForeignKey: true, isNaturalKey: false });
  });

  it('flags stubs, rationale, grain, role, ghost and read-only on node data', () => {
    const result = transformDomain(domain({
      readOnly: true,
      stubColumns: ['fact_order'],
      models: [
        model('fact_order', { rationale: { purpose: 'One row per order line' }, grain: 'order line', modelRole: 'transaction-fact' }),
        model('dim_customer', { rationale: {}, existsInManifest: false }),
      ],
      relationships: [rel('fact_order', 'dim_customer')],
    }));

    const fact = nodeById(result, 'fact_order').data;
    expect(fact.isStub).toBe(true);
    expect(fact.hasRationale).toBe(true);
    expect(fact.grain).toBe('order line');
    expect(fact.modelRole).toBe('transaction-fact');
    expect(fact.readOnly).toBe(true);
    expect(fact).not.toHaveProperty('isGhost');

    const dim = nodeById(result, 'dim_customer').data;
    expect(dim.isStub).toBe(false);
    expect(dim).not.toHaveProperty('hasRationale');
    expect(dim).not.toHaveProperty('grain');
    expect(dim.isGhost).toBe(true);

    expect(fkEdges(result)[0].data?.readOnly).toBe(true);
  });
});

describe('transformDomain edges', () => {
  it('creates one fk edge per relationship whose endpoints are both on the canvas', () => {
    const result = transformDomain(domain({
      models: [model('fact_order'), model('dim_customer')],
      relationships: [
        rel('fact_order', 'dim_customer', { fromColumn: 'customer_id', toColumn: 'customer_id' }),
        rel('fact_order', 'dim_missing'),
        rel('dim_missing', 'fact_order'),
      ],
    }));

    const edges = fkEdges(result);
    expect(edges).toHaveLength(1);
    const [edge] = edges;
    expect(edge.id).toBe('fk-fact_order-customer_id-dim_customer-customer_id');
    expect(edge.source).toBe('fact_order');
    expect(edge.target).toBe('dim_customer');
    expect(edge.sourceHandle).toMatch(/^node-(top|right|bottom|left)-src$/);
    expect(edge.targetHandle).toMatch(/^node-(top|right|bottom|left)-tgt$/);
    expect(edge.data).toEqual({
      fromModel: 'fact_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id',
      cardinality: 'many-to-one', stage: 'logical',
    });
  });

  it('picks handle sides from the relative node positions', () => {
    const horizontal = transformDomain(domain({
      models: [model('a'), model('b')],
      viewConfig: { positions: { a: { x: 0, y: 0 }, b: { x: 800, y: 0 } } },
      relationships: [rel('a', 'b')],
    }));
    expect(fkEdges(horizontal)[0].sourceHandle).toBe('node-right-src');
    expect(fkEdges(horizontal)[0].targetHandle).toBe('node-left-tgt');

    const vertical = transformDomain(domain({
      models: [model('a'), model('b')],
      viewConfig: { positions: { a: { x: 0, y: 0 }, b: { x: 0, y: 900 } } },
      relationships: [rel('b', 'a')],
    }));
    expect(fkEdges(vertical)[0].sourceHandle).toBe('node-top-src');
    expect(fkEdges(vertical)[0].targetHandle).toBe('node-bottom-tgt');
  });

  it('routes self-referencing relationships via the top → right handles and flags them', () => {
    const result = transformDomain(domain({
      models: [model('dim_employee')],
      relationships: [rel('dim_employee', 'dim_employee', { fromColumn: 'manager_id', toColumn: 'employee_id' })],
    }));

    const [edge] = fkEdges(result);
    expect(edge.sourceHandle).toBe('node-top-src');
    expect(edge.targetHandle).toBe('node-right-tgt');
    expect(edge.data?.isSelfLoop).toBe(true);
  });
});

describe('transformDomain annotations', () => {
  it('renders annotations as nodes and links them only to models that exist', () => {
    const result = transformDomain(domain({
      models: [model('dim_customer')],
      viewConfig: {
        annotations: [
          { id: 'n1', x: 10, y: 20, text: 'Conformed dimension', linkedModel: 'dim_customer' },
          { id: 'n2', x: 0, y: 0, text: 'orphan', color: 'blue', width: 200, height: 90, linkedModel: 'dim_missing' },
        ],
      },
    }));

    const notes = annotationNodes(result);
    expect(notes.map((n) => n.id)).toEqual(['annotation-n1', 'annotation-n2']);
    expect(notes[0].position).toEqual({ x: 10, y: 20 });
    expect(notes[0].data).toEqual({ annotationId: 'n1', text: 'Conformed dimension', color: 'yellow', linkedModel: 'dim_customer' });
    expect(notes[1].data).toMatchObject({ color: 'blue', width: 200, height: 90 });

    const links = linkEdges(result);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ id: 'ann-link-n1', source: 'annotation-n1', target: 'dim_customer' });
    expect(links[0].data).toEqual({ annotationId: 'n1', targetModel: 'dim_customer' });
  });

  it('marks annotation nodes read-only on a read-only stage', () => {
    const result = transformDomain(domain({
      readOnly: true,
      viewConfig: { annotations: [{ id: 'n1', x: 0, y: 0, text: 'x' }] },
    }));
    expect(annotationNodes(result)[0].data.readOnly).toBe(true);
    expect(linkEdges(result)).toHaveLength(0);
  });
});

describe('transformDomain discrepancy overlay', () => {
  const report: DiscrepancyReport = {
    domain: 'orders',
    layer: 'silver',
    sourceStage: 'logical',
    targetStage: 'physical',
    models: [
      { name: 'fact_order', status: 'matched', columns: [{ name: 'amount', status: 'type-mismatch', sourceDataType: 'decimal', targetDataType: 'float' }] },
      { name: 'dim_region', status: 'missing', columns: [] },
      { name: 'dim_channel', status: 'missing', columns: [] },
    ],
    relationships: [
      { fromModel: 'fact_order', fromColumn: 'dim_customer_id', toModel: 'dim_customer', toColumn: 'dim_customer_id', status: 'cardinality-mismatch', sourceCardinality: 'many-to-one', targetCardinality: 'one-to-one' },
      { fromModel: 'fact_order', fromColumn: 'region_id', toModel: 'dim_region', toColumn: 'region_id', status: 'missing', targetCardinality: 'one-to-many' },
      { fromModel: 'fact_order', fromColumn: 'x_id', toModel: 'dim_nowhere', toColumn: 'x_id', status: 'missing' },
    ],
    summary: {} as DiscrepancyReport['summary'],
  };

  const base = () => domain({
    models: [model('fact_order'), model('dim_customer')],
    relationships: [rel('fact_order', 'dim_customer')],
    viewConfig: { positions: { fact_order: { x: 0, y: 0 }, dim_customer: { x: 400, y: 0 }, dim_channel: { x: 5, y: 6 } } },
  });

  it('attaches discrepancy data and the compared stages to matched model nodes only', () => {
    const result = transformDomain(base(), { discrepancyReport: report });

    const fact = nodeById(result, 'fact_order').data;
    expect(fact.discrepancy).toBe(report.models[0]);
    expect(fact.discrepancySourceStage).toBe('logical');
    expect(fact.discrepancyTargetStage).toBe('physical');
    expect(fact).not.toHaveProperty('isGhost');

    expect(nodeById(result, 'dim_customer').data).not.toHaveProperty('discrepancy');
  });

  it('adds ghost nodes for missing models, stacked above the canvas unless a position is saved', () => {
    const result = transformDomain(base(), { discrepancyReport: report });

    expect(modelNodes(result).map((n) => n.id)).toEqual(['fact_order', 'dim_customer', 'dim_region', 'dim_channel']);
    const region = nodeById(result, 'dim_region');
    expect(region.position).toEqual({ x: 50, y: -150 });
    expect(region.data).toMatchObject({ isGhost: true, readOnly: true, isStub: false, columns: [], discrepancy: report.models[1] });
    expect(nodeById(result, 'dim_channel').position).toEqual({ x: 5, y: 6 });
  });

  it('marks existing edges with their relationship discrepancy status', () => {
    const result = transformDomain(base(), { discrepancyReport: report });
    const edge = fkEdges(result).find((e) => e.id === 'fk-fact_order-dim_customer_id-dim_customer-dim_customer_id')!;
    expect(edge.data?.discrepancyStatus).toBe('cardinality-mismatch');
  });

  it('adds ghost edges for missing relationships whose endpoints are on the canvas', () => {
    const result = transformDomain(base(), { discrepancyReport: report });
    const ghosts = fkEdges(result).filter((e) => e.id.startsWith('ghost-fk-'));
    expect(ghosts.map((e) => e.id)).toEqual(['ghost-fk-fact_order-region_id-dim_region-region_id']);
    expect(ghosts[0]).toMatchObject({ source: 'fact_order', target: 'dim_region' });
    expect(ghosts[0].data).toMatchObject({ discrepancyStatus: 'missing', cardinality: 'one-to-many', stage: 'logical' });
  });

  it('adds no ghosts and no discrepancy keys without a report', () => {
    const result = transformDomain(base());
    expect(modelNodes(result)).toHaveLength(2);
    expect(fkEdges(result)).toHaveLength(1);
    expect(fkEdges(result)[0].data).not.toHaveProperty('discrepancyStatus');
    expect(nodeById(result, 'fact_order').data).not.toHaveProperty('discrepancySourceStage');
  });
});
