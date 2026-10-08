/**
 * MCP `read_domain` reports the relationships the diagram draws — the same
 * view as the canvas and `diff` (#133): a domain-file entry whose end is not
 * one of the domain's models (REL003) is not drawn, so it is not reported as
 * drawn; everything else carries its `issues`.
 */
import { describe, expect, it } from 'vitest';
import { normaliseRelationships } from '@erd-studio/core';

import { drawnRelationships } from '../../mcp-server/src/lib/relationships';

const fct = {
  name: 'fct_order',
  columns: [
    { name: 'order_key', dataType: 'INT', description: '', isPrimaryKey: true },
    { name: 'customer_key', dataType: 'INT', description: '' },
    { name: 'date_key', dataType: 'INT', description: '' },
  ],
};
const dimDate = { name: 'dim_date', columns: [{ name: 'date_key', dataType: 'INT', description: '', isPrimaryKey: true }] };

describe('MCP read_domain relationships', () => {
  it('leaves out a domain-file entry to a model the domain does not list (REL003), and reports issues on the rest', () => {
    const { relationships } = normaliseRelationships({
      models: [fct, dimDate],
      own: [
        { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
        { fromModel: 'FCT_ORDER', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', role: 'ordered' },
      ],
    });
    expect(relationships.map((r) => r.issues ?? [])).toEqual([['REL003'], ['REL005']]);
    expect(drawnRelationships(relationships)).toEqual([{
      from_model: 'fct_order', from_column: 'date_key', to_model: 'dim_date', to_column: 'date_key',
      cardinality: 'many-to-one', role: 'ordered', issues: ['REL005'],
    }]);
  });

  it('a sound relationship carries no issues field', () => {
    const { relationships } = normaliseRelationships({
      models: [fct, dimDate],
      own: [{ fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' }],
    });
    expect(drawnRelationships(relationships)).toEqual([{
      from_model: 'fct_order', from_column: 'date_key', to_model: 'dim_date', to_column: 'date_key', cardinality: 'many-to-one',
    }]);
  });
});
