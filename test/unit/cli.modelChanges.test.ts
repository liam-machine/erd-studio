import { describe, expect, it } from 'vitest';

import { diffModelSnapshots, hasModelChanges } from '../../src/cli/modelChanges';
import { readModelSnapshot, tablesDirIsLayerOf } from '../../src/cli/modelSnapshot';

/** A snapshot from an in-memory folder (paths relative to the semantic dir). */
function snap(files: Record<string, string>) {
  return readModelSnapshot(Object.keys(files), (rel) => files[rel] ?? null);
}

const DIM_CUSTOMER = `Table gold.dim_customer [
  role: 'conformed-dim',
  grain: 'One row per customer'
] {
  customer_key BIGINT [pk]
  customer_id STRING [natural_key: 'true']
  name STRING
}
`;

const DIM_DATE = `Table gold.dim_date [role: 'conformed-dim'] {
  date_key INT [pk]
  calendar_date DATE
}
`;

const FCT_SALE = `Table gold.fct_sale [role: 'transaction-fact', grain: 'One row per sale'] {
  sale_id STRING [pk]
  customer_key BIGINT [foreign_key: 'true']
  sale_date_key INT [foreign_key: 'true']
  amount "DECIMAL(10,2)"
}
`;

const GOLD_REFS = `use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.dim_date } from '../tables/gold/dim_date.dbml'
use { table gold.fct_sale } from '../tables/gold/fct_sale.dbml'

Ref: gold.fct_sale.customer_key > gold.dim_customer.customer_key
Ref: gold.fct_sale.sale_date_key > gold.dim_date.date_key
`;

const SALES_DIAGRAM = `use { table gold.fct_sale } from '../tables/gold/fct_sale.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use * from '../relationships/gold.dbml'

Project sales {
  erd_schema_version: '7'
}
`;

const BASE: Record<string, string> = {
  'layers.json': '{"layers":[{"id":"gold","label":"Gold"}]}',
  'gold/tables/gold/dim_customer.dbml': DIM_CUSTOMER,
  'gold/tables/gold/dim_date.dbml': DIM_DATE,
  'gold/tables/gold/fct_sale.dbml': FCT_SALE,
  'gold/relationships/gold.dbml': GOLD_REFS,
  'gold/diagrams/sales.dbml': SALES_DIAGRAM,
};

describe('readModelSnapshot', () => {
  it('reads DBML tables, Refs (attached to their owner) and diagram members', () => {
    const s = snap(BASE);
    expect([...s.tables.keys()]).toEqual(['dim_customer', 'dim_date', 'fct_sale']);
    const sale = s.tables.get('fct_sale')!;
    expect(sale).toMatchObject({ layer: 'gold', schema: 'gold', role: 'transaction-fact', grain: 'One row per sale', storage: 'dbml' });
    expect(sale.columns.find((c) => c.name === 'customer_key')).toMatchObject({ fk: true, pk: false });
    expect(s.tables.get('dim_customer')!.columns.find((c) => c.name === 'customer_id')!.nk).toBe(true);
    const rels = [...s.relationships.values()];
    expect(rels).toHaveLength(2);
    expect(rels[0]).toMatchObject({ fromTable: 'fct_sale', cardinality: 'many-to-one', file: 'gold/relationships/gold.dbml' });
    expect(s.relationshipsFiles.get('gold/relationships/gold.dbml')!.refs.size).toBe(2);
    expect(s.diagrams.get('gold/sales')!.tables).toEqual(['fct_sale', 'dim_customer']);
    expect(s.problems).toEqual([]);
  });

  it('reads a YAML library and JSON diagrams (relationships in the library and in the domain file)', () => {
    const s = snap({
      'logical-models/dim_customer.yml': 'name: dim_customer\nalias: customer\ncolumns:\n  - name: customer_id\n    dataType: INT\n    isPrimaryKey: true\n',
      'logical-models/gold/fct_order.yml': [
        'name: fct_order',
        'columns:',
        '  - name: order_id',
        '    dataType: INT',
        '  - name: customer_id',
        '    dataType: INT',
        'relationships:',
        '  - fromColumn: customer_id',
        '    toModel: dim_customer',
        '    toColumn: customer_id',
        '    cardinality: many-to-one',
        '',
      ].join('\n'),
      'gold/sales.json': JSON.stringify({
        schemaVersion: 5,
        domain: 'sales',
        layer: 'gold',
        logical: {
          models: ['fct_order', 'dim_customer', 'fct_order'],
          relationships: [{ fromModel: 'dim_customer', fromColumn: 'customer_id', toModel: 'fct_order', toColumn: 'order_id', cardinality: 'one-to-many' }],
        },
      }),
    });
    expect(s.tables.get('dim_customer')).toMatchObject({ alias: 'customer', storage: 'yaml' });
    expect(s.tables.get('fct_order')).toMatchObject({ layer: 'gold', storage: 'yaml' });
    expect(s.diagrams.get('gold/sales')!.tables).toEqual(['fct_order', 'dim_customer']);
    const rels = [...s.relationships.values()].sort((a, b) => a.fromColumn.localeCompare(b.fromColumn));
    expect(rels.map((r) => [r.fromTable, r.fromColumn, r.toTable, r.toColumn, r.cardinality, r.file])).toEqual([
      ['fct_order', 'customer_id', 'dim_customer', 'customer_id', 'many-to-one', 'logical-models/gold/fct_order.yml'],
      // A one-to-many is stored the canonical way round: the many end is `from`.
      ['fct_order', 'order_id', 'dim_customer', 'customer_id', 'many-to-one', 'gold/sales.json'],
    ]);
  });

  it('reads the inline models of a v4 diagram', () => {
    const s = snap({
      'bronze/orders.json': JSON.stringify({
        schemaVersion: 4,
        domain: 'orders',
        layer: 'bronze',
        logical: { models: [{ name: 'raw_orders', columns: [{ name: 'id', dataType: 'INT', description: '' }] }], relationships: [] },
      }),
    });
    expect(s.tables.get('raw_orders')).toMatchObject({ storage: 'json', file: 'bronze/orders.json' });
    expect(s.diagrams.get('bronze/orders')!.tables).toEqual(['raw_orders']);
  });

  it('reports a file it cannot read and keeps going', () => {
    const s = snap({ ...BASE, 'gold/tables/gold/broken.dbml': 'Table gold.broken {\n  id INT [pk\n' });
    expect(s.tables.get('broken')).toMatchObject({ unreadable: true });
    expect(s.problems.map((p) => p.file)).toEqual(['gold/tables/gold/broken.dbml']);
    expect(s.tables.size).toBe(4);
  });

  it('knows a tables/ folder holding a diagram is a layer, not the library', () => {
    expect(tablesDirIsLayerOf(['tables/orders.json'], null)).toBe(true);
    expect(tablesDirIsLayerOf(['tables/dim_x.yml'], null)).toBe(false);
    expect(tablesDirIsLayerOf(['tables/dim_x.yml'], '{"layers":[{"id":"tables"}]}')).toBe(true);
    expect(tablesDirIsLayerOf([], null)).toBe(false);
  });
});

describe('diffModelSnapshots', () => {
  it('finds nothing between two copies of the same model', () => {
    const changes = diffModelSnapshots(snap(BASE), snap(BASE));
    expect(hasModelChanges(changes)).toBe(false);
  });

  it('lists tables added and removed, and a diagram added and removed', () => {
    const head = { ...BASE };
    delete head['gold/tables/gold/dim_date.dbml'];
    delete head['gold/diagrams/sales.dbml'];
    head['gold/tables/gold/dim_product.dbml'] = 'Table gold.dim_product {\n  product_key BIGINT [pk]\n}\n';
    head['gold/diagrams/products.dbml'] = "use { table gold.dim_product } from '../tables/gold/dim_product.dbml'\n";
    const c = diffModelSnapshots(snap(BASE), snap(head));
    expect(c.tables.added.map((t) => t.name)).toEqual(['dim_product']);
    expect(c.tables.removed).toEqual([{ name: 'dim_date', file: 'gold/tables/gold/dim_date.dbml', layer: 'gold', schema: 'gold' }]);
    expect(c.diagrams.added).toEqual([{ name: 'products', layer: 'gold', file: 'gold/diagrams/products.dbml', tables: ['dim_product'] }]);
    expect(c.diagrams.removed.map((d) => d.name)).toEqual(['sales']);
  });

  it('lists columns added, removed and retyped, key flags, alias, role and grain', () => {
    const head = {
      ...BASE,
      'gold/tables/gold/fct_sale.dbml': `Table gold.fct_sale [role: 'periodic-snapshot', grain: 'One row per sale line', alias: 'sales'] {
  sale_id STRING [pk]
  customer_key BIGINT
  sale_date_key INT [foreign_key: 'true']
  amount "DECIMAL(12,2)"
  quantity INT
}
`,
    };
    const c = diffModelSnapshots(snap(BASE), snap(head));
    expect(c.tables.changed).toHaveLength(1);
    const change = c.tables.changed[0];
    expect(change.name).toBe('fct_sale');
    expect(change.columnsAdded).toEqual([{ name: 'quantity', dataType: 'INT' }]);
    expect(change.columnsRemoved).toEqual([]);
    expect(change.typesChanged).toEqual([{ column: 'amount', from: 'DECIMAL(10,2)', to: 'DECIMAL(12,2)' }]);
    expect(change.keysChanged).toEqual([{ column: 'customer_key', key: 'fk', from: true, to: false }]);
    expect(change.role).toEqual({ from: 'transaction-fact', to: 'periodic-snapshot' });
    expect(change.grain).toEqual({ from: 'One row per sale', to: 'One row per sale line' });
    expect(change.alias).toEqual({ from: null, to: 'sales' });
  });

  it('reports a table moved to another layer or schema', () => {
    const head = { ...BASE };
    delete head['gold/tables/gold/dim_date.dbml'];
    head['silver/tables/shared/dim_date.dbml'] = DIM_DATE.replace('gold.dim_date', 'shared.dim_date');
    const c = diffModelSnapshots(snap(BASE), snap(head));
    expect(c.tables.added).toEqual([]);
    expect(c.tables.removed).toEqual([]);
    expect(c.tables.moved).toEqual([{
      name: 'dim_date',
      from: { name: 'dim_date', file: 'gold/tables/gold/dim_date.dbml', layer: 'gold', schema: 'gold' },
      to: { name: 'dim_date', file: 'silver/tables/shared/dim_date.dbml', layer: 'silver', schema: 'shared' },
    }]);
  });

  it('does not call converting a flat YAML library to DBML a move', () => {
    const base = snap({ 'logical-models/dim_date.yml': 'name: dim_date\ncolumns:\n  - name: date_key\n    dataType: INT\n    isPrimaryKey: true\n' });
    const head = snap({ 'gold/tables/gold/dim_date.dbml': 'Table gold.dim_date {\n  date_key INT [pk]\n}\n' });
    const c = diffModelSnapshots(base, head);
    expect(hasModelChanges(c)).toBe(false);
  });

  it('detects a rename only when it is certain', () => {
    const head = { ...BASE };
    delete head['gold/tables/gold/dim_date.dbml'];
    head['gold/tables/gold/dim_calendar.dbml'] = DIM_DATE.replace('gold.dim_date', 'gold.dim_calendar');
    const c = diffModelSnapshots(snap(BASE), snap(head));
    expect(c.tables.renamed).toEqual([{ from: 'dim_date', to: 'dim_calendar', file: 'gold/tables/gold/dim_calendar.dbml' }]);
    expect(c.tables.added).toEqual([]);
    expect(c.tables.removed).toEqual([]);

    // Two new tables with the same columns: either could be the rename, so neither is.
    const twice = { ...head, 'gold/tables/gold/dim_day.dbml': DIM_DATE.replace('gold.dim_date', 'gold.dim_day') };
    const unsure = diffModelSnapshots(snap(BASE), snap(twice));
    expect(unsure.tables.renamed).toEqual([]);
    expect(unsure.tables.added.map((t) => t.name)).toEqual(['dim_calendar', 'dim_day']);
    expect(unsure.tables.removed.map((t) => t.name)).toEqual(['dim_date']);
  });

  it('lists relationships added, removed and with a new cardinality, and the Refs per relationships file', () => {
    const head = {
      ...BASE,
      'gold/relationships/gold.dbml': `use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.dim_date } from '../tables/gold/dim_date.dbml'
use { table gold.fct_sale } from '../tables/gold/fct_sale.dbml'

Ref: gold.fct_sale.customer_key - gold.dim_customer.customer_key
`,
      'gold/relationships/dates.dbml': `use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.dim_date } from '../tables/gold/dim_date.dbml'

Ref: gold.dim_customer.customer_key > gold.dim_date.date_key
`,
    };
    const c = diffModelSnapshots(snap(BASE), snap(head));
    expect(c.relationships.added.map((r) => `${r.fromTable}.${r.fromColumn}>${r.toTable}.${r.toColumn}`)).toEqual(['dim_customer.customer_key>dim_date.date_key']);
    expect(c.relationships.removed.map((r) => `${r.fromTable}.${r.fromColumn}`)).toEqual(['fct_sale.sale_date_key']);
    expect(c.relationships.changed).toHaveLength(1);
    expect(c.relationships.changed[0]).toMatchObject({ fromCardinality: 'many-to-one', cardinality: 'one-to-one' });
    expect(c.relationshipsFiles).toEqual([
      { file: 'gold/relationships/dates.dbml', status: 'added', refsAdded: 1, refsRemoved: 0, refsChanged: 0 },
      { file: 'gold/relationships/gold.dbml', status: 'changed', refsAdded: 0, refsRemoved: 1, refsChanged: 1 },
    ]);
  });

  it('compares a cardinality after turning the new copy to face the old one', () => {
    const one = 'name: a\ncolumns:\n  - name: b_id\n    dataType: INT\nrelationships:\n  - fromColumn: b_id\n    toModel: b\n    toColumn: id\n    cardinality: one-to-one\n';
    const b = 'name: b\ncolumns:\n  - name: id\n    dataType: INT\n';
    const turned = 'name: b\ncolumns:\n  - name: id\n    dataType: INT\nrelationships:\n  - fromColumn: id\n    toModel: a\n    toColumn: b_id\n    cardinality: one-to-one\n';
    const base = snap({ 'logical-models/a.yml': one, 'logical-models/b.yml': b });
    const head = snap({ 'logical-models/a.yml': 'name: a\ncolumns:\n  - name: b_id\n    dataType: INT\n', 'logical-models/b.yml': turned });
    expect(diffModelSnapshots(base, head).relationships).toEqual({ added: [], removed: [], changed: [] });
  });

  it('lists the tables added to and removed from a diagram, also across a JSON to DBML conversion', () => {
    const asJson: Record<string, string> = { ...BASE };
    delete asJson['gold/diagrams/sales.dbml'];
    const base = snap({
      ...asJson,
      'gold/sales.json': JSON.stringify({ schemaVersion: 5, domain: 'sales', layer: 'gold', logical: { models: ['fct_sale', 'dim_date'], relationships: [] } }),
    });
    const c = diffModelSnapshots(base, snap(BASE));
    expect(c.diagrams.added).toEqual([]);
    expect(c.diagrams.removed).toEqual([]);
    expect(c.diagrams.changed).toEqual([{
      name: 'sales', layer: 'gold', file: 'gold/diagrams/sales.dbml', movedFrom: 'gold/sales.json',
      tablesAdded: ['dim_customer'], tablesRemoved: ['dim_date'],
    }]);
  });

  it('leaves an unreadable table out of the content comparison', () => {
    const head = { ...BASE, 'gold/tables/gold/fct_sale.dbml': 'Table gold.fct_sale {\n  sale_id STRING [pk\n' };
    const c = diffModelSnapshots(snap(BASE), snap(head));
    expect(c.tables.changed).toEqual([]);
    expect(c.tables.removed).toEqual([]);
  });
});
