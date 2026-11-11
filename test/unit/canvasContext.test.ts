/**
 * The canvas context's pure builder: each diagram table's file and reviewers,
 * and its Table Library relationships to tables not on the diagram, read
 * from the foreign-key end, a composite key as one row.
 */
import { describe, it, expect } from 'vitest';
import { buildCanvasContext, joinColumnsText } from '../../src/services/canvasContext';
import type { SemanticTable } from '../../src/types/semantic';

const table = (name: string, columns: string[], relationships: SemanticTable['relationships'] = []): SemanticTable => ({
  name,
  columns: columns.map((c) => ({ name: c, dataType: 'bigint' })),
  ...(relationships && relationships.length > 0 ? { relationships } : {}),
} as unknown as SemanticTable);

const library: SemanticTable[] = [
  table('fct_sale', ['sale_key', 'store_key', 'date_key', 'region_code', 'country_code'], [
    { fromColumn: 'store_key', toModel: 'dim_store', toColumn: 'store_key', cardinality: 'many-to-one' },
    { fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' },
    { fromColumn: 'region_code', toModel: 'dim_region', toColumn: 'region_code', cardinality: 'many-to-one', compositeKey: 'region' },
    { fromColumn: 'country_code', toModel: 'dim_region', toColumn: 'country_code', cardinality: 'many-to-one', compositeKey: 'region' },
  ] as SemanticTable['relationships']),
  table('dim_store', ['store_key']),
  table('dim_date', ['date_key']),
  table('dim_region', ['region_code', 'country_code']),
  table('fct_return', ['return_key', 'sale_ref'], [
    { fromColumn: 'sale_ref', toModel: 'fct_sale', toColumn: 'sale_key', cardinality: 'many-to-one' },
  ] as SemanticTable['relationships']),
  table('fct_ghost', ['x'], [
    { fromColumn: 'x', toModel: 'dim_missing', toColumn: 'x', cardinality: 'many-to-one' },
  ] as SemanticTable['relationships']),
];

const layers: Record<string, string> = { fct_sale: 'Gold', dim_store: 'Silver', dim_date: 'Gold', dim_region: 'Silver', fct_return: 'Gold' };

describe('buildCanvasContext', () => {
  it('lists each diagram table\'s relationships to tables not on the diagram, both ways', () => {
    const context = buildCanvasContext({
      members: ['fct_sale', 'dim_date'],
      libraryTables: library,
      fileOf: (name) => `.erd-studio/gold/tables/gold/${name}.dbml`,
      layerLabelOf: (name) => layers[name],
      diagramLayerLabel: 'Gold',
    });
    expect(context.offDiagram).toEqual({
      fct_sale: [
        { otherTable: 'dim_region', otherLayer: 'Silver', columns: '(region_code, country_code)', cardinality: 'many-to-one', direction: 'out' },
        { otherTable: 'dim_store', otherLayer: 'Silver', columns: 'store_key', cardinality: 'many-to-one', direction: 'out' },
        // Same layer as the diagram: no "in Gold".
        { otherTable: 'fct_return', columns: 'sale_ref → sale_key', cardinality: 'many-to-one', direction: 'in' },
      ],
    });
    // dim_date's only relationship is with fct_sale, which is on the diagram.
    expect(context.offDiagram.dim_date).toBeUndefined();
    expect(context.tableFiles).toEqual({
      fct_sale: '.erd-studio/gold/tables/gold/fct_sale.dbml',
      dim_date: '.erd-studio/gold/tables/gold/dim_date.dbml',
    });
    expect(context.owners).toBeUndefined();
  });

  it('matches the diagram\'s names without case and keys rows by the diagram\'s spelling', () => {
    const context = buildCanvasContext({ members: ['FCT_SALE'], libraryTables: library, fileOf: () => undefined });
    expect(Object.keys(context.offDiagram)).toEqual(['FCT_SALE']);
    expect(context.tableFiles).toEqual({});
  });

  it('leaves out a relationship to a table the library does not have', () => {
    const context = buildCanvasContext({ members: ['fct_ghost'], libraryTables: library, fileOf: () => undefined });
    expect(context.offDiagram).toEqual({});
  });

  it('names each table\'s reviewers in one line', () => {
    const context = buildCanvasContext({
      members: ['fct_sale', 'dim_date'],
      libraryTables: library,
      fileOf: () => undefined,
      ownersOf: (name) => (name === 'fct_sale' ? ['@acme/sales', '@ana'] : []),
    });
    expect(context.owners).toEqual({ fct_sale: '@acme/sales, @ana' });
  });

  it('a table named like an Object property is an own key', () => {
    const context = buildCanvasContext({
      members: ['constructor'],
      libraryTables: [table('constructor', ['a'], [{ fromColumn: 'a', toModel: 'dim_store', toColumn: 'store_key', cardinality: 'many-to-one' }] as SemanticTable['relationships']), table('dim_store', ['store_key'])],
      fileOf: () => 'x.dbml',
    });
    expect(Object.prototype.hasOwnProperty.call(context.offDiagram, 'constructor')).toBe(true);
    expect(context.offDiagram.constructor).toHaveLength(1);
  });
});

describe('buildCanvasContext, the diagram naming its tables differently from the library', () => {
  it('finds members by what the library calls them (memberOf), and gives each other table its file', () => {
    // A diagram of ccc's tables alone calls them addresse and kunde; the library, where bqs has both names too, ccc.addresse and ccc.kunde.
    const twins = [
      table('ccc.kunde', ['id', 'addresse_id'], [{ fromColumn: 'addresse_id', toModel: 'ccc.addresse', toColumn: 'id', cardinality: 'many-to-one' }] as SemanticTable['relationships']),
      table('ccc.addresse', ['id'], [{ fromColumn: 'id', toModel: 'bqs.addresse', toColumn: 'id', cardinality: 'many-to-one' }] as SemanticTable['relationships']),
      table('bqs.addresse', ['id']),
    ];
    const onDiagram: Record<string, string> = { 'ccc.kunde': 'kunde', 'ccc.addresse': 'addresse' };
    const context = buildCanvasContext({
      members: ['addresse', 'kunde'],
      libraryTables: twins,
      fileOf: (name) => `.erd-studio/bronze/tables/ccc/${name}.dbml`,
      memberOf: (name) => onDiagram[name],
      otherTablePathOf: (name) => (name === 'bqs.addresse' ? '.erd-studio/bronze/tables/bqs/addresse.dbml' : undefined),
    });
    expect(context.offDiagram).toEqual({
      addresse: [{ otherTable: 'bqs.addresse', columns: 'id', cardinality: 'many-to-one', direction: 'out', otherTablePath: '.erd-studio/bronze/tables/bqs/addresse.dbml' }],
    });
  });
});

describe('joinColumnsText', () => {
  it('names a column once when both ends share it, else both', () => {
    expect(joinColumnsText(['store_key'], ['store_key'])).toBe('store_key');
    expect(joinColumnsText(['ship_date_key'], ['date_key'])).toBe('ship_date_key → date_key');
    expect(joinColumnsText(['a', 'b'], ['a', 'b'])).toBe('(a, b)');
  });
});
