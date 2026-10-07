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
    ]);
    expect(model.relationshipIssues?.map(({ index, reason, skipped, line }) => ({ index, reason, skipped, line }))).toEqual([
      { index: 1, reason: 'unknown-cardinality', skipped: false, line: 7 },
      { index: 2, reason: 'missing-endpoint', skipped: true, line: 8 },
      { index: 3, reason: 'not-a-mapping', skipped: true, line: 9 },
      { index: 4, reason: 'missing-cardinality', skipped: false, line: 10 },
      { index: 5, reason: 'stray-from-model', skipped: true, line: 11 },
    ]);
    expect(model.relationshipIssues?.[0].message).toMatch(/"one_to_many", which is not one of/);
    expect(model.relationshipIssues?.[1].message).toMatch(/has no toColumn and was skipped/);
    expect(model.relationshipIssues?.[4].message).toMatch(/leaves dim_other, not fct_order/);
  });

  it('skips an entry whose fromModel names another model rather than drawing a self-loop on the holder', async () => {
    const dim = parseLogicalModelText([
      'name: dim_customer',
      'columns:',
      '  - { name: customer_id, dataType: INT, isPrimaryKey: true }',
      'relationships:',
      '  - fromModel: fct_order',
      '    fromColumn: customer_id',
      '    toModel: dim_customer',
      '    toColumn: customer_id',
      '    cardinality: many-to-one',
    ].join('\n'), 'dim_customer')!;
    expect(dim).not.toHaveProperty('relationships');
    expect(dim.relationshipIssues).toEqual([{
      index: 0, reason: 'stray-from-model', skipped: true, line: 5,
      message: expect.stringMatching(/describes fct_order\.customer_id → dim_customer\.customer_id.*move it to fct_order's model file/),
    }]);
    const fct = parseLogicalModelText('name: fct_order\ncolumns:\n  - { name: customer_id, dataType: INT }\n', 'fct_order')!;
    const { normaliseRelationships } = await import('../../src/normaliseRelationships');
    const { relationships } = normaliseRelationships({ models: [dim, fct], own: [] });
    expect(relationships).toEqual([]);
  });

  it('reads an entry whose fromModel is the holder itself (any case), flagging the key as not needed', () => {
    const model = parseLogicalModelText(
      'name: fct_order\nrelationships:\n  - { fromModel: FCT_order, fromColumn: a, toModel: dim_a, toColumn: a, cardinality: many-to-one }\n',
      'fct_order',
    )!;
    expect(model.relationships).toEqual([{ fromColumn: 'a', toModel: 'dim_a', toColumn: 'a', cardinality: 'many-to-one' }]);
    expect(model.relationshipIssues).toEqual([expect.objectContaining({ reason: 'stray-from-model', skipped: false })]);
  });

  it('skips an entry whose fromModel is not text', () => {
    const model = parseLogicalModelText(
      'name: fct_order\nrelationships:\n  - { fromModel: 12, fromColumn: a, toModel: dim_a, toColumn: a, cardinality: many-to-one }\n',
      'fct_order',
    )!;
    expect(model).not.toHaveProperty('relationships');
    expect(model.relationshipIssues).toEqual([expect.objectContaining({ reason: 'stray-from-model', skipped: true })]);
  });

  it('leaves the field off when every entry reads as written', () => {
    const model = parseLogicalModelText('name: m\nrelationships:\n  - { fromColumn: a, toModel: b, toColumn: a, cardinality: many-to-one }\n', 'm');
    expect(model).not.toHaveProperty('relationshipIssues');
  });

  it.each([
    ['a mapping (the list dash forgotten)', [
      'name: fct_order',
      'columns: []',
      'relationships:',
      '  fromColumn: customer_id',
      '  toModel: dim_customer',
      '  toColumn: customer_id',
      '  cardinality: many-to-one',
    ], /is a mapping, not a list/],
    ['a single value', ['name: fct_order', 'columns: []', 'relationships: oops'], /is a single value, not a list/],
  ])('reports a relationships: that is %s instead of drawing nothing silently', (_label, lines, message) => {
    const model = parseLogicalModelText(lines.join('\n'), 'fct_order')!;
    expect(model).not.toHaveProperty('relationships');
    expect(model.relationshipIssues).toEqual([
      { index: 0, reason: 'not-a-list', skipped: true, line: 3, message: expect.stringMatching(message) },
    ]);
  });

  it('reports a role longer than the canvas shows (REL008), with its line, instead of cutting it silently', async () => {
    const long = 'the date the order was shipped from the warehouse to the customer address on file';
    const model = parseLogicalModelText(
      ['name: fct_order', 'relationships:', '  - fromColumn: a', '    toModel: dim_a', '    toColumn: a', '    cardinality: many-to-one', `    role: ${long}`].join('\n'),
      'fct_order',
    )!;
    expect(model.relationships?.[0].role).toHaveLength(60);
    expect(model.relationshipIssues).toEqual([expect.objectContaining({ index: 0, reason: 'role-too-long', skipped: false, line: 3 })]);
    const { readDomainRelationshipEntries } = await import('../../src/domain');
    const entries = readDomainRelationshipEntries([{ fromModel: 'f', fromColumn: 'a', toModel: 'd', toColumn: 'a', cardinality: 'many-to-one', role: long }], 'gold/o');
    expect(entries.issues).toEqual([expect.objectContaining({ index: 0, reason: 'role-too-long', skipped: false })]);
    // At the limit: nothing to report.
    expect(readDomainRelationshipEntries([{ fromModel: 'f', fromColumn: 'a', toModel: 'd', toColumn: 'a', cardinality: 'many-to-one', role: long.slice(0, 60) }], 'gold/o').issues).toEqual([]);
  });

  it('says nothing about an empty relationships:', () => {
    expect(parseLogicalModelText('name: m\nrelationships:\n', 'm')).not.toHaveProperty('relationshipIssues');
    expect(parseLogicalModelText('name: m\nrelationships: []\n', 'm')).not.toHaveProperty('relationshipIssues');
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

describe('readDomainRelationshipEntries — a domain file\'s entries, nothing dropped silently', () => {
  it('reads what parseDomainJson draws and reports every entry skipped or defaulted, by position', async () => {
    const { readDomainRelationshipEntries } = await import('../../src/domain');
    const good = { fromModel: 'a', fromColumn: 'k', toModel: 'b', toColumn: 'k', cardinality: 'many-to-one' };
    const entries = [good, { ...good, toColumn: 'j', cardinality: 'one_to_many' }, { fromModel: 'a' }, 'nope', { ...good, toColumn: 'i' }, { ...good, toColumn: 'h', role: 7 }];
    const read = readDomainRelationshipEntries(entries, 'gold/x');
    expect(read.relationships.map((r) => r.toColumn)).toEqual(['k', 'j', 'i', 'h']);
    expect(read.rawIndexes).toEqual([0, 1, 4, 5]);
    expect(read.defaulted).toEqual([false, true, false, false]);
    expect(read.issues.map((i) => [i.index, i.reason, i.skipped])).toEqual([
      [1, 'unknown-cardinality', false], [2, 'missing-endpoint', true], [3, 'not-a-mapping', true], [5, 'invalid-role', false],
    ]);
    expect(readDomainRelationshipEntries({ not: 'a list' }, 'gold/x').issues.map((i) => i.reason)).toEqual(['not-a-list']);
    expect(readDomainRelationshipEntries(undefined, 'gold/x').issues).toEqual([]);
  });
});

describe('toDisplayDomain — models whose names differ only in case (#133 review 6)', () => {
  it('badges only the model a relationship leaves, never its case-only twin', () => {
    const domain: SemanticDomain = {
      schemaVersion: 5, domain: 'd', layer: 'silver', stage: 'logical', description: '',
      models: [
        { name: 'Dd', columns: [{ name: 'id', dataType: 'INT', description: '', isPrimaryKey: true }] },
        { name: 'DD', columns: [{ name: 'k', dataType: 'INT', description: '', isPrimaryKey: true }, { name: 'id', dataType: 'INT', description: '' }] },
      ],
      relationships: [{ fromModel: 'DD', fromColumn: 'id', toModel: 'Dd', toColumn: 'id', cardinality: 'many-to-one' }],
    };
    const display = toDisplayDomain(domain, { viewConfig: {}, layerConfig: undefined, readOnly: false });
    expect(display.models.find((m) => m.name === 'Dd')!.columns[0]).toMatchObject({ isForeignKey: false });
    expect(display.models.find((m) => m.name === 'DD')!.columns[1]).toMatchObject({ isForeignKey: true });
  });
});
