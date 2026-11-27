/**
 * `addTablesMessage` and `relatedTablesToAdd` (#365): the one place that turns
 * "these tables are related and not on the diagram" into the host's add
 * message. The detail panel's "+ Add" / "Add all related" and the editor's
 * "Add Related Tables" all post through it.
 */
import { describe, it, expect } from 'vitest';
import type { CanvasContext, DisplaySubjectArea } from '@erd-studio/core';
import { ADD_TABLES_LIMIT, addTablesMessage, relatedTablesToAdd } from '../../src/editor';

describe('addTablesMessage', () => {
  it('posts nothing for no tables', () => {
    expect(addTablesMessage([])).toBeNull();
  });

  it('adds one table with addExistingModel, by its file when the host named one', () => {
    expect(addTablesMessage([{ otherTable: 'dim_store' }])).toEqual({ type: 'addExistingModel', payload: { modelName: 'dim_store' } });
    expect(addTablesMessage([{ otherTable: 'dim_store', otherTablePath: 'a/dim_store.dbml' }]))
      .toEqual({ type: 'addExistingModel', payload: { modelName: 'dim_store', sourcePath: 'a/dim_store.dbml' } });
  });

  it('adds several with one addExistingModels, sourcePaths index for index only when one has a file', () => {
    expect(addTablesMessage([{ otherTable: 'a' }, { otherTable: 'b' }]))
      .toEqual({ type: 'addExistingModels', payload: { modelNames: ['a', 'b'] } });
    expect(addTablesMessage([{ otherTable: 'a', otherTablePath: 'x/a.dbml' }, { otherTable: 'b' }]))
      .toEqual({ type: 'addExistingModels', payload: { modelNames: ['a', 'b'], sourcePaths: ['x/a.dbml', ''] } });
  });

  it(`asks for at most ${ADD_TABLES_LIMIT} tables in one go`, () => {
    const many = Array.from({ length: ADD_TABLES_LIMIT + 50 }, (_v, i) => ({ otherTable: `t${i}` }));
    const message = addTablesMessage(many);
    expect(message?.type).toBe('addExistingModels');
    expect(message?.type === 'addExistingModels' && message.payload.modelNames).toHaveLength(ADD_TABLES_LIMIT);
  });
});

describe('relatedTablesToAdd', () => {
  const domain = (stage: 'logical' | 'physical', names: string[]): DisplaySubjectArea =>
    ({ stage, models: names.map((name) => ({ name, columns: [] })), relationships: [] }) as unknown as DisplaySubjectArea;
  const context: CanvasContext = {
    tableFiles: {},
    offDiagram: {
      fct_order: [
        // Two relationships to one table: one table to add.
        { otherTable: 'dim_customer', columns: 'customer_key', cardinality: 'many-to-one', direction: 'out' },
        { otherTable: 'dim_customer', columns: 'ship_to_key → customer_key', cardinality: 'many-to-one', direction: 'out' },
        { otherTable: 'fct_return', columns: 'order_key', cardinality: 'many-to-one', direction: 'in' },
        // On the diagram since the context was worked out.
        { otherTable: 'DIM_DATE', columns: 'date_key', cardinality: 'many-to-one', direction: 'out' },
      ],
    },
  };

  it('lists each related table off the diagram once, either direction, ignoring ones added since', () => {
    expect(relatedTablesToAdd(context, domain('logical', ['fct_order', 'dim_date']), 'fct_order'))
      .toEqual([{ otherTable: 'dim_customer' }, { otherTable: 'fct_return' }]);
  });

  it('lists nothing on the physical stage, without a context, or for a table with none', () => {
    expect(relatedTablesToAdd(context, domain('physical', ['fct_order']), 'fct_order')).toEqual([]);
    expect(relatedTablesToAdd(null, domain('logical', ['fct_order']), 'fct_order')).toEqual([]);
    expect(relatedTablesToAdd(context, domain('logical', ['dim_date']), 'dim_date')).toEqual([]);
  });
});
