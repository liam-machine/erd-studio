/**
 * dbtTestsOnTables: dbt's relationship tests restated over library tables
 * for a table added by its file (two schema folders may each hold a table
 * of one name). A dbt model is matched to a table of a shared name by its
 * schema, never by its name alone, and a test it cannot place gives nothing.
 */
import { describe, expect, it } from 'vitest';

import { dbtTestsOnTables, type DbtMatchTable, type DbtTestIndex } from '../../src/services/dbtDraft';
import type { YmlData } from '../../src/types/ymlData';

function yml(models: Array<{ name: string; configSchema?: string }>): YmlData {
  return {
    models: new Map(models.map((m) => [m.name, { name: m.name, description: '', columns: [], filePath: 'models/schema.yml', tags: [], ...(m.configSchema ? { configSchema: m.configSchema } : {}) }])),
    relationshipTests: [],
    uniqueColumns: new Map(),
    compositeUniqueGroups: new Map(),
  } as unknown as YmlData;
}

const TESTS: DbtTestIndex = {
  relationshipTests: [{ fromModel: 'kunde', fromColumn: 'addresse_id', toModel: 'addresse', toColumn: 'id' }],
  unique: { uniqueColumns: new Map([['addresse', new Set(['id'])]]), compositeUniqueGroups: new Map() },
};

const table = (ref: string, name: string, schema: string, shared: boolean): DbtMatchTable => ({ ref, name, schemas: [schema], shared });

describe('dbtTestsOnTables', () => {
  it('lands a test of a shared name on the table whose schema dbt builds the model in', () => {
    const out = dbtTestsOnTables(
      [table('kunde', 'kunde', 'ccc', false), table('bqs.addresse', 'addresse', 'bqs', true), table('ccc.addresse', 'addresse', 'ccc', true)],
      TESTS, yml([{ name: 'kunde', configSchema: 'ccc' }, { name: 'addresse', configSchema: 'ccc' }]),
    );
    expect(out.relationshipTests.map((t) => `${t.fromModel}>${t.toModel}`)).toEqual(['kunde>ccc.addresse']);
    expect([...out.unique.uniqueColumns.keys()]).toEqual(['ccc.addresse']);
  });

  it('gives nothing for a shared name dbt builds in neither schema', () => {
    const out = dbtTestsOnTables(
      [table('kunde', 'kunde', 'ccc', false), table('bqs.addresse', 'addresse', 'bqs', true), table('ccc.addresse', 'addresse', 'ccc', true)],
      TESTS, yml([{ name: 'kunde', configSchema: 'ccc' }, { name: 'addresse', configSchema: 'ddd' }]),
    );
    expect(out.relationshipTests).toEqual([]);
  });

  it('a table listed twice (a member listed twice on its diagram) is one table, and keeps its tests', () => {
    const out = dbtTestsOnTables(
      [table('kunde', 'kunde', 'ccc', false), table('addresse', 'addresse', 'ccc', false), table('addresse', 'addresse', 'ccc', false)],
      TESTS, yml([{ name: 'kunde' }, { name: 'addresse' }]),
    );
    expect(out.relationshipTests.map((t) => `${t.fromModel}>${t.toModel}`)).toEqual(['kunde>addresse']);
  });
});
