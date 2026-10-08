/**
 * graphTransformer.transformDomain — DisplayDomain → React Flow nodes/edges:
 * node data mapping, edge endpoint filtering, self-loops, annotations and the
 * discrepancy overlay (ghost nodes / edges). Complements graphTransformer.test.ts,
 * which covers handle-side selection geometry.
 */
import { describe, expect, it } from 'vitest';

import { transformDomain, type TransformResult } from '../../src/lib/graphTransformer';
import type { DisplayColumn, DisplayDomain, DisplayModel, DisplayRelationship } from '@erd-studio/core';
import type { DiscrepancyReport } from '@erd-studio/core';
import type { AnnotationFlowEdge, AnnotationFlowNode, FkFlowEdge, ModelFlowNode } from '../../src/types/graph';

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
    // Guards the `=== false` test in the transformer: a truthiness check here
    // would ghost every logical node, none of which sets existsInProject.
    expect(data).not.toHaveProperty('ghostReason');
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
        model('dim_customer', { rationale: {}, existsInProject: false }),
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
    expect(dim.ghostReason).toBe('not-in-project');

    expect(fkEdges(result)[0].data?.readOnly).toBe(true);
  });

  it('carries physical provenance onto node data, and only when the host set it', () => {
    const result = transformDomain(domain({
      stage: 'physical',
      models: [
        model('fact_order', { provenance: { columns: ['catalog', 'yml'], types: 'catalog' } }),
        model('dim_customer'),
      ],
    }));

    // The object must ride through by reference: applyNodeOverlays spreads
    // `...data` and short-circuits on identity, so a per-render copy here would
    // churn every memoised node on every search keystroke.
    expect(nodeById(result, 'fact_order').data.provenance).toEqual({ columns: ['catalog', 'yml'], types: 'catalog' });
    // A logical model (and any physical phantom) leaves it unset rather than
    // shipping a placeholder the chip would have to special-case.
    expect(nodeById(result, 'dim_customer').data).not.toHaveProperty('provenance');
  });

  it('carries a model file load error onto node data, and only when the host set it (#110)', () => {
    const result = transformDomain(domain({
      models: [model('dim_broken', { columns: [], loadError: { kind: 'yamlScalar', line: 4 } }), model('dim_customer')],
    }));
    expect(nodeById(result, 'dim_broken').data.loadError).toEqual({ kind: 'yamlScalar', line: 4 });
    expect(nodeById(result, 'dim_customer').data).not.toHaveProperty('loadError');
  });

  it('carries model and column meta for the hover cards, and drops an empty map', () => {
    const result = transformDomain(domain({
      models: [
        model('dim_customer', {
          meta: { owner: 'crm-team' },
          columns: [
            column('customer_id', { meta: { source: 'CRM' } }),
            column('email', { meta: {} }),
          ],
        }),
        model('dim_region', { meta: {} }),
      ],
    }));

    const dim = nodeById(result, 'dim_customer').data;
    expect(dim.meta).toEqual({ owner: 'crm-team' });
    expect(dim.columns[0].meta).toEqual({ source: 'CRM' });
    expect(dim.columns[1]).not.toHaveProperty('meta');
    expect(nodeById(result, 'dim_region').data).not.toHaveProperty('meta');
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

  it('carries a relationship role onto the edge it labels (#133)', () => {
    const result = transformDomain(domain({
      models: [model('fct_order'), model('dim_date')],
      relationships: [
        rel('fct_order', 'dim_date', { fromColumn: 'order_date_key', toColumn: 'date_key', role: 'order date' }),
        rel('fct_order', 'dim_date', { fromColumn: 'ship_date_key', toColumn: 'date_key' }),
      ],
    }));
    expect(fkEdges(result).map((e) => e.data?.role)).toEqual(['order date', undefined]);
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
    expect(region.data).toMatchObject({ isGhost: true, ghostReason: 'missing-in-comparison', readOnly: true, isStub: false, columns: [], discrepancy: report.models[1] });
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

  it('never emits two nodes with the same id when a phantom is also reported missing', () => {
    // The physical stage emits models that are not in the dbt project, and the
    // comparison reports the same name 'missing' from the logical side. Without
    // the guard in the ghost loop these are two React Flow nodes with one id,
    // and the second one's position overwrites the first one's rect.
    const result = transformDomain(domain({
      stage: 'physical',
      models: [model('fact_order'), model('dim_region', { existsInProject: false })],
      viewConfig: { positions: { fact_order: { x: 0, y: 0 }, dim_region: { x: 900, y: 12 } } },
    }), { discrepancyReport: report });

    const regions = modelNodes(result).filter((n) => n.id === 'dim_region');
    expect(regions).toHaveLength(1);
    expect(regions[0].position).toEqual({ x: 900, y: 12 });
    expect(regions[0].data.ghostReason).toBe('not-in-project');
    expect(new Set(modelNodes(result).map((n) => n.id)).size).toBe(modelNodes(result).length);
  });

  it('distinguishes a disabled model from one that is simply absent', () => {
    const result = transformDomain(domain({
      stage: 'physical',
      models: [
        model('dim_region', { existsInProject: false, missingReason: 'disabled' }),
        model('dim_channel', { existsInProject: false, missingReason: 'absent' }),
      ],
    }));

    expect(nodeById(result, 'dim_region').data).toMatchObject({ isGhost: true, ghostReason: 'disabled' });
    expect(nodeById(result, 'dim_channel').data).toMatchObject({ isGhost: true, ghostReason: 'not-in-project' });
  });

  it('adds no ghosts and no discrepancy keys without a report', () => {
    const result = transformDomain(base());
    expect(modelNodes(result)).toHaveLength(2);
    expect(fkEdges(result)).toHaveLength(1);
    expect(fkEdges(result)[0].data).not.toHaveProperty('discrepancyStatus');
    expect(nodeById(result, 'fact_order').data).not.toHaveProperty('discrepancySourceStage');
  });
});

describe('transformDomain — ends spelled in another case (#133 L4)', () => {
  it('a relationship core has respelled produces an edge; the transformer itself matches exactly', async () => {
    const { mergeLibraryRelationships } = await import('@erd-studio/core');
    const written = { fromModel: 'Fact_Order', fromColumn: 'DIM_CUSTOMER_ID', toModel: 'dim_CUSTOMER', toColumn: 'Dim_Customer_Id', cardinality: 'many-to-one' as const };
    const models = [model('fact_order', { columns: [column('dim_customer_id')] }), model('dim_customer')];
    expect(fkEdges(transformDomain(domain({ models, relationships: [written] })))).toEqual([]);
    const drawn = mergeLibraryRelationships(models.map((m) => ({ ...m, columns: m.columns })), [written]);
    const edges = fkEdges(transformDomain(domain({ models, relationships: drawn })));
    expect(edges.map((e) => [e.source, e.target])).toEqual([['fact_order', 'dim_customer']]);
  });
});

describe('transformDomain — self-references (#133 L3)', () => {
  it('two self-loops on one node get loopIndex 0 and 1, by edge id, and nest', () => {
    const employee = model('employee', { columns: [column('employee_id', { isPrimaryKey: true }), column('manager_id'), column('mentor_id')] });
    const loops = [
      { fromModel: 'employee', fromColumn: 'mentor_id', toModel: 'employee', toColumn: 'employee_id', cardinality: 'many-to-one' as const },
      { fromModel: 'employee', fromColumn: 'manager_id', toModel: 'employee', toColumn: 'employee_id', cardinality: 'many-to-one' as const },
    ];
    const edges = fkEdges(transformDomain(domain({ models: [employee], relationships: loops })));
    expect(edges.map((e) => [e.data!.fromColumn, e.data!.isSelfLoop, e.data!.loopIndex])).toEqual([
      ['mentor_id', true, 1],
      ['manager_id', true, 0],
    ]);
    expect(fkEdges(transformDomain(domain({ models: [employee], relationships: [...loops].reverse() }))).find((e) => e.data!.fromColumn === 'mentor_id')!.data!.loopIndex).toBe(1);
  });
});
