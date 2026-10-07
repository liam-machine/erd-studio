import { it } from 'vitest';
import { normaliseRelationships } from '../../src/normaliseRelationships';
import { checkRelationships } from '../../src/relationshipChecks';
import type { SemanticModel } from '../../src/types/semantic';

const m = (name: string, cols: string[], rels: any[] = []): SemanticModel => ({ name, columns: cols.map((c) => { const [n, f=''] = c.split(':'); return { name: n, dataType: 'int', description: '', ...(f.includes('P')?{isPrimaryKey:true}:{}) , ...(f.includes('F')?{isForeignKey:true}:{})}; }), relationships: rels } as any);

it('scenario: v4-like duplicate inline names order', () => {
  const a1 = m('A', ['id:P', 'b_id']);
  const a2 = m('A', ['id', 'b_id:P']);
  const b = m('B', ['id:P']);
  const own = [{ fromModel: 'A', fromColumn: 'b_id', toModel: 'B', toColumn: 'id', cardinality: 'many-to-one' as const }];
  const r1 = normaliseRelationships({ models: [a1, a2, b], own });
  const r2 = normaliseRelationships({ models: [a2, a1, b], own });
  console.log('dup-inline', JSON.stringify(r1.diagnostics.map(d=>d.code)), JSON.stringify(r2.diagnostics.map(d=>d.code)));
});

it('scenario: library one-to-one both directions + domain copy', () => {
  const a = m('A', ['id:P', 'b_id'], [{ fromColumn: 'b_id', toModel: 'B', toColumn: 'id', cardinality: 'one-to-one' }]);
  const b = m('B', ['id:P'], [{ fromColumn: 'id', toModel: 'A', toColumn: 'b_id', cardinality: 'one-to-many' }]);
  const r = normaliseRelationships({ models: [a, b], own: [] });
  console.log('1to1', JSON.stringify(r.relationships), JSON.stringify(r.diagnostics.map(d=>[d.code,d.severity,d.message])));
});

it('scenario: check domain record outside but library holds link', () => {
  const a = m('A', ['id:P', 'b_id:F'], [{ fromColumn: 'b_id', toModel: 'B', toColumn: 'id', cardinality: 'many-to-one' }]);
  const b = m('B', ['id:P']);
  const f = checkRelationships({ libraryModels: [{ model: a, file: 'a.yml' }, { model: b, file: 'b.yml' }], domains: [
    { label: 'x', filePath: 'x.json', models: ['A'], relationships: [{ fromModel: 'A', fromColumn: 'b_id', toModel: 'B', toColumn: 'id', cardinality: 'one-to-one' }], mode: 'library' },
  ] });
  console.log('outside', JSON.stringify(f.map(x=>[x.code,x.severity,x.message])));
});
