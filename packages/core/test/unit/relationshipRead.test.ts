/**
 * What a model file's `relationships:` entries read as, and what the canvas
 * payload carries for them (#133).
 */

import { describe, it, expect } from 'vitest';

import { parseLogicalModelText } from '../../src/logicalModel';
import { toDisplayDomain } from '../../src/displayDomain';
import type { SemanticDomain } from '../../src/types/semantic';

describe('readRelationships — per-entry issues (REL008)', () => {
  const text = [
    'name: fct_order',                                                                                           // 1
    'relationships:',                                                                                            // 2
    '  - fromColumn: customer_key',                                                                              // 3
    '    toModel: dim_customer',                                                                                 // 4
    '    toColumn: customer_key',                                                                                // 5
    '    cardinality: many-to-one',                                                                              // 6
    '  - { fromColumn: a, toModel: dim_a, toColumn: a, cardinality: one_to_many }',                             // 7
    '  - { fromColumn: b, toModel: dim_b }',                                                                     // 8
    '  - just text',                                                                                             // 9
    '  - { fromColumn: c, toModel: dim_c, toColumn: c }',                                                        // 10
    '  - { fromModel: dim_other, fromColumn: d, toModel: dim_d, toColumn: d, cardinality: one-to-one, role: [x] }', // 11
  ].join('\n');

  it('reads what it can and reports every entry it skipped or defaulted, with its line', () => {
    const model = parseLogicalModelText(text, 'fct_order')!;
    expect(model.relationships).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
      { fromColumn: 'a', toModel: 'dim_a', toColumn: 'a', cardinality: 'many-to-one' },
      { fromColumn: 'c', toModel: 'dim_c', toColumn: 'c', cardinality: 'many-to-one' },
      { fromColumn: 'd', toModel: 'dim_d', toColumn: 'd', cardinality: 'one-to-one' },
    ]);
    expect(model.relationshipIssues?.map(({ index, reason, skipped, line }) => ({ index, reason, skipped, line }))).toEqual([
      { index: 1, reason: 'unknown-cardinality', skipped: false, line: 7 },
      { index: 2, reason: 'missing-endpoint', skipped: true, line: 8 },
      { index: 3, reason: 'not-a-mapping', skipped: true, line: 9 },
      { index: 4, reason: 'missing-cardinality', skipped: false, line: 10 },
      { index: 5, reason: 'stray-from-model', skipped: false, line: 11 },
      { index: 5, reason: 'invalid-role', skipped: false, line: 11 },
    ]);
    expect(model.relationshipIssues?.[0].message).toMatch(/"one_to_many", which is not one of/);
    expect(model.relationshipIssues?.[1].message).toMatch(/has no toColumn and was skipped/);
    expect(model.relationshipIssues?.[4].message).toMatch(/"dim_other"/);
  });

  it('leaves the field off when every entry reads as written', () => {
    const model = parseLogicalModelText('name: m\nrelationships:\n  - { fromColumn: a, toModel: b, toColumn: a, cardinality: many-to-one }\n', 'm');
    expect(model).not.toHaveProperty('relationshipIssues');
  });

  it('has no line for entries of an aliased list', () => {
    const model = parseLogicalModelText([
      'name: m',
      'x: &rels',
      '  - { fromColumn: a, toModel: b, toColumn: a }',
      'relationships: *rels',
    ].join('\n'), 'm');
    expect(model?.relationshipIssues).toEqual([
      { index: 0, reason: 'missing-cardinality', skipped: false, message: expect.any(String) },
    ]);
  });
});

describe('toDisplayDomain — relationship evidence and provenance (#133)', () => {
  const domain: SemanticDomain = {
    schemaVersion: 5, domain: 'd', layer: 'gold', stage: 'logical', description: '',
    models: [
      { name: 'fct_order', columns: [
        { name: 'customer_key', dataType: 'INT', description: '' },
        { name: 'product_key', dataType: 'INT', description: '', isForeignKey: true },
      ] },
      { name: 'dim_customer', columns: [{ name: 'customer_key', dataType: 'INT', description: '', isPrimaryKey: true }] },
    ],
    relationships: [{
      fromModel: 'fct_order', fromColumn: 'Customer_Key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one',
      source: { kind: 'library', model: 'fct_order', index: 0 },
      stored: { fromModel: 'fct_order', fromColumn: 'Customer_Key', toModel: 'dim_customer', toColumn: 'customer_key' },
      issues: ['REL005'],
    }],
  };

  it('badges a relationship\'s from column (without case) but declares only what the model file says', () => {
    const display = toDisplayDomain(domain, { viewConfig: {}, layerConfig: undefined, readOnly: false });
    const [customer, product] = display.models[0].columns;
    expect(customer).toMatchObject({ isForeignKey: true });
    expect(customer).not.toHaveProperty('isForeignKeyDeclared');
    expect(product).toMatchObject({ isForeignKey: true, isForeignKeyDeclared: true });
    expect(display.models[1].columns[0]).toMatchObject({ isForeignKey: false });
  });

  it('passes source, stored and issues through, and the relationship context when given', () => {
    const display = toDisplayDomain(domain, {
      viewConfig: {}, layerConfig: undefined, readOnly: false,
      relationshipHome: 'library',
      relationshipIssues: [{ code: 'REL003', severity: 'error', message: 'x' }],
    });
    expect(display.relationships[0]).toMatchObject({
      source: { kind: 'library', model: 'fct_order', index: 0 },
      stored: { fromColumn: 'Customer_Key' },
      issues: ['REL005'],
    });
    expect(display.relationshipHome).toBe('library');
    expect(display.relationshipIssues).toHaveLength(1);
    const bare = toDisplayDomain(domain, { viewConfig: {}, layerConfig: undefined, readOnly: true, relationshipIssues: [] });
    expect(bare).not.toHaveProperty('relationshipHome');
    expect(bare).not.toHaveProperty('relationshipIssues');
  });
});
