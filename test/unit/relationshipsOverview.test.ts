/**
 * The Relationships view's model (`buildRelationshipsOverview`): one entry per
 * line the canvas draws, grouped under both of its tables, with the problems
 * the library can see.
 */
import { describe, it, expect } from 'vitest';

import { buildRelationshipsOverview, cardinalityFrom, columnList, describeProblem } from '../../src/services/relationshipsOverview';
import type { SemanticTable } from '../../src/types/semantic';

const table = (name: string, columns: string[], relationships: SemanticTable['relationships'] = []): SemanticTable =>
  ({ name, columns: columns.map((c) => ({ name: c })), ...(relationships.length ? { relationships } : {}) }) as SemanticTable;

const dimCustomer = table('dim_customer', ['customer_sk', 'customer_id']);
const dimDate = table('dim_date', ['date_sk']);
const fctOrder = table('fct_order', ['order_id', 'customer_sk', 'order_date_sk'], [
  { fromColumn: 'customer_sk', toModel: 'dim_customer', toColumn: 'customer_sk', cardinality: 'many-to-one' },
  { fromColumn: 'order_date_sk', toModel: 'dim_date', toColumn: 'date_sk', cardinality: 'many-to-one', role: 'ordered on' },
]);

describe('buildRelationshipsOverview', () => {
  it('lists each relationship under both tables: outgoing from the FK table, incoming at the other', () => {
    const o = buildRelationshipsOverview([dimCustomer, dimDate, fctOrder]);
    expect(o.entries).toHaveLength(2);
    expect(o.problems).toEqual([]);
    expect(o.tables.map((t) => [t.table, t.outgoing.length, t.incoming.length])).toEqual([
      ['dim_customer', 0, 1],
      ['dim_date', 0, 1],
      ['fct_order', 2, 0],
    ]);
    const toDate = o.tables[2].outgoing.find((e) => e.toModel === 'dim_date')!;
    expect(toDate.role).toBe('ordered on');
    expect(toDate.source).toEqual({ kind: 'library', table: 'fct_order' });
  });

  it('leaves tables with no relationship out', () => {
    const o = buildRelationshipsOverview([dimCustomer, table('lonely', ['id']), fctOrder]);
    expect(o.tables.map((t) => t.table)).not.toContain('lonely');
  });

  it('folds a composite key into one entry, as the canvas draws one line', () => {
    const line = table('fct_line', ['order_id', 'line_no'], [
      { fromColumn: 'order_id', toModel: 'fct_order_line', toColumn: 'order_id', cardinality: 'many-to-one', compositeKey: 'fk_ol' },
      { fromColumn: 'line_no', toModel: 'fct_order_line', toColumn: 'line_no', cardinality: 'many-to-one', compositeKey: 'fk_ol' },
    ]);
    const o = buildRelationshipsOverview([line, table('fct_order_line', ['order_id', 'line_no'])]);
    expect(o.entries).toHaveLength(1);
    expect(o.entries[0].fromColumns).toEqual(['order_id', 'line_no']);
    expect(columnList(o.entries[0].toColumns)).toBe('(order_id, line_no)');
  });

  it('reads a one-to-many from its FK side (canonical), as the canvas does', () => {
    const dim = table('dim_customer', ['customer_sk'], [
      { fromColumn: 'customer_sk', toModel: 'fct_order', toColumn: 'customer_sk', cardinality: 'one-to-many' },
    ]);
    const o = buildRelationshipsOverview([dim, table('fct_order', ['customer_sk'])]);
    expect(o.entries[0]).toMatchObject({ fromModel: 'fct_order', toModel: 'dim_customer', cardinality: 'many-to-one' });
  });

  it('lists a link a diagram also keeps once (the library\'s), and a diagram-only link with its diagram', () => {
    const o = buildRelationshipsOverview([dimCustomer, dimDate, fctOrder], [{
      label: 'gold/sales', filePath: '/p/.erd-studio/gold/sales.json', models: ['fct_order', 'dim_customer', 'dim_date'],
      relationships: [
        // The same link, written from the other end and in another case.
        { fromModel: 'DIM_CUSTOMER', fromColumn: 'customer_sk', toModel: 'fct_order', toColumn: 'Customer_SK', cardinality: 'one-to-many' },
        { fromModel: 'dim_customer', fromColumn: 'customer_id', toModel: 'dim_date', toColumn: 'date_sk', cardinality: 'one-to-one' },
      ],
    }]);
    expect(o.entries).toHaveLength(3);
    const fromDiagram = o.entries.filter((e) => e.source.kind === 'diagram');
    expect(fromDiagram).toHaveLength(1);
    expect(fromDiagram[0]).toMatchObject({ fromModel: 'dim_customer', toModel: 'dim_date', source: { label: 'gold/sales' } });
  });

  it('flags a missing table, and a column its table does not have', () => {
    const fct = table('fct_x', ['a', 'b'], [
      { fromColumn: 'a', toModel: 'dim_gone', toColumn: 'id', cardinality: 'many-to-one' },
      { fromColumn: 'b', toModel: 'dim_customer', toColumn: 'nope', cardinality: 'many-to-one' },
    ]);
    const o = buildRelationshipsOverview([dimCustomer, fct]);
    expect(o.problems.map((e) => e.problems)).toEqual([
      [{ kind: 'missingColumn', table: 'dim_customer', column: 'nope' }],
      [{ kind: 'missingTable', table: 'dim_gone' }],
    ]);
    expect(describeProblem(o.problems[1].problems[0])).toBe('No table named "dim_gone" in the table library.');
    // A missing table still has its row, so the relationship can be found from it.
    expect(o.tables.map((t) => t.table)).toContain('dim_gone');
  });

  it('lists a self-reference once, as outgoing, with one problem when its table is missing', () => {
    const emp = table('dim_employee', ['employee_sk', 'manager_sk'], [
      { fromColumn: 'manager_sk', toModel: 'dim_employee', toColumn: 'employee_sk', cardinality: 'many-to-one' },
    ]);
    const o = buildRelationshipsOverview([emp]);
    expect(o.tables).toHaveLength(1);
    expect([o.tables[0].outgoing.length, o.tables[0].incoming.length]).toEqual([1, 0]);
    expect(o.problems).toEqual([]);
  });

  it('reads the cardinality from the other end', () => {
    const [entry] = buildRelationshipsOverview([dimCustomer, fctOrder]).entries;
    expect(cardinalityFrom(entry, 'from')).toBe('many-to-one');
    expect(cardinalityFrom(entry, 'to')).toBe('one-to-many');
  });
});
