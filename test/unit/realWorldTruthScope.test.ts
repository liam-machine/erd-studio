/**
 * The truth side of the scorecards, where the importer must not decide what
 * it is scored against:
 * - the import corpus cuts a dbt project's truth to the drawn folder by the
 *   folder the source counter records (`dbtTruthInScope`), never by the
 *   importer's own model list;
 * - the engine comparison keeps two tables of the same name in different
 *   schemas apart (`compareWithEngine`).
 */
import { describe, expect, it } from 'vitest';
import { dbtTruthInScope, type TruthSample } from './realWorldScorecard';
import { compareWithEngine, type EngineReadback } from './realWorldEngineTruth';

const table = (name: string, folder?: string): TruthSample['tables'][number] =>
  ({ name, pk: ['id'], columns: [['id', 'int', 'PN']], ...(folder !== undefined ? { folder } : {}) }) as TruthSample['tables'][number];

describe('dbtTruthInScope', () => {
  const truth = {
    tables: [table('dim_a', 'marts'), table('fct_b', 'marts'), table('stg_c', 'staging'), table('top', '')],
    relationships: [
      { from: 'fct_b', fromColumn: 'a_id', to: 'dim_a', toColumn: 'id' },
      { from: 'stg_c', fromColumn: 'a_id', to: 'dim_a', toColumn: 'id' },
    ],
  };

  it('keeps the models the counter placed in the folder, whatever the import drew', () => {
    const cut = dbtTruthInScope(truth, 'folder:marts');
    expect(cut.tables.map((t) => t.name)).toEqual(['dim_a', 'fct_b']);
    expect(cut.relationships).toEqual([truth.relationships[0]]);
    expect(dbtTruthInScope(truth, 'folder:').tables.map((t) => t.name)).toEqual(['top']);
    expect(dbtTruthInScope(truth, 'folder:MARTS').tables).toHaveLength(2);
  });

  it('does not cut a scope that is not a folder', () => {
    expect(dbtTruthInScope(truth, 'cluster:dim_a')).toBe(truth);
  });

  it('refuses a truth without folders (an old count)', () => {
    expect(() => dbtTruthInScope({ tables: [table('dim_a')], relationships: [] }, 'folder:marts')).toThrow(/count_source\.py/);
  });
});

describe('compareWithEngine: same-named tables in two schemas', () => {
  const truth = {
    importer: 'sql', input: {}, counts: { tables: 2, columns: 3, primaryKeys: 2, relationships: 0 },
    tables: [
      { name: 'customer', schema: 'sales', pk: ['id'], columns: [['id', 'int', 'PN'], ['name', 'text', '']] },
      { name: 'customer', schema: 'crm', pk: ['cid'], columns: [['cid', 'int', 'PN']] },
    ],
    relationships: [], uniqueKeys: [],
  } as unknown as TruthSample;
  const engine = (crmColumns: string[]): EngineReadback => ({
    sample: 's', engine: 'test', errors: [], uniqueKeys: [], foreignKeys: [],
    tables: [
      { schema: 'crm', name: 'customer', pk: ['cid'], columns: crmColumns.map((name) => ({ name, type: 'integer', notNull: true })) },
      { schema: 'sales', name: 'customer', pk: ['id'], columns: [{ name: 'id', type: 'integer', notNull: true }, { name: 'name', type: 'text', notNull: false }] },
    ],
  });

  it('matches each truth table with the engine table in its schema', () => {
    expect(compareWithEngine('s', truth, engine(['cid']), 'postgres')).toEqual([]);
  });

  it('a difference in one of them is not hidden by the other', () => {
    expect(compareWithEngine('s', truth, engine(['cid', 'email']), 'postgres').map((d) => `${d.kind} ${d.item}`)).toEqual(['column customer.email']);
  });
});
