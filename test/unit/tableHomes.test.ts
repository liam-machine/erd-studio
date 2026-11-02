/**
 * Where each table lives (`tableHomesOf`), and how many of a diagram's
 * tables come from other layers (`otherLayerCounts`): what the sidebar's
 * Diagrams view says beside each diagram.
 */
import { describe, it, expect } from 'vitest';

import { otherLayerCounts, tableHomesOf } from '../../src/services/tableHomes';
import type { TableFileEntry } from '../../src/services/logicalModelService';

const dbml = (name: string, layer: string, schema: string, shadowedBy?: string): TableFileEntry => ({
  name, folder: schema, layer, storage: 'dbml', filePath: `/p/.erd-studio/${layer}/tables/${schema}/${name}.dbml`, ...(shadowedBy ? { shadowedBy } : {}),
});

describe('tableHomesOf', () => {
  it('keys each DBML table by lower-cased name, leaving out YAML tables and duplicates', () => {
    const homes = tableHomesOf([
      dbml('Fct_Order', 'gold', 'sales'),
      dbml('fct_order', 'silver', 'sales', '/p/.erd-studio/gold/tables/sales/Fct_Order.dbml'),
      { name: 'dim_old', folder: '', storage: 'yaml', filePath: '/p/.erd-studio/logical-models/dim_old.yml' },
    ]);
    expect([...homes.entries()]).toEqual([['fct_order', { layer: 'gold', schema: 'sales' }]]);
  });
});

describe('otherLayerCounts', () => {
  const homes = tableHomesOf([
    dbml('pit', 'business_vault', 'bv'), dbml('hub', 'raw_vault', 'rv'), dbml('sat', 'raw_vault', 'rv'), dbml('dim', 'marts', 'm'),
  ]);

  it('counts the tables in each other layer, in layers.json order, once per name', () => {
    expect(otherLayerCounts(['pit', 'HUB', 'sat', 'hub', 'dim', 'nowhere'], 'business_vault', homes, ['raw_vault', 'business_vault', 'marts']))
      .toEqual([{ layer: 'raw_vault', count: 2 }, { layer: 'marts', count: 1 }]);
  });

  it('is empty when every table is in the diagram\'s own layer', () => {
    expect(otherLayerCounts(['hub', 'sat'], 'raw_vault', homes, [])).toEqual([]);
  });
});
