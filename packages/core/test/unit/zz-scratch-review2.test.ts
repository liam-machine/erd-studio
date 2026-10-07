import { it } from 'vitest';
import { normaliseRelationships } from '../../src/normaliseRelationships';
import type { SemanticModel, Relationship } from '../../src/types/semantic';

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const names = ['Dd', 'DD', 'ee', 'Ff'];
const cols = ['id', 'ID', 'x', 'X', 'y'];
const cards = ['many-to-one', 'one-to-many', 'one-to-one', 'many-to-many'] as const;

it('fuzz order independence', () => {
  let bad = 0;
  for (let t = 0; t < 3000; t++) {
    const models: SemanticModel[] = names.filter(() => rnd() < 0.8).map((n) => ({
      name: n,
      columns: [...new Set(cols.filter(() => rnd() < 0.6))].map((c) => ({ name: c, dataType: 'int', description: '', ...(rnd()<0.3?{isPrimaryKey:true}:{}), ...(rnd()<0.2?{isForeignKey:true}:{}) })),
      relationships: Array.from({ length: Math.floor(rnd() * 3) }, () => ({ fromColumn: pick(cols), toModel: pick(names), toColumn: pick(cols), cardinality: pick([...cards]), ...(rnd()<0.2?{role:'r'}:{}) })),
    } as any));
    const own: Relationship[] = Array.from({ length: Math.floor(rnd() * 3) }, () => ({ fromModel: pick(names), fromColumn: pick(cols), toModel: pick(names), toColumn: pick(cols), cardinality: pick([...cards]) }));
    const a = normaliseRelationships({ models, own });
    const shuffled = [...models].reverse();
    const b = normaliseRelationships({ models: shuffled, own });
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) { bad++; if (bad < 3) { console.log('DIFF', JSON.stringify(models.map(m=>m.name)), JSON.stringify(own)); console.log(sa); console.log(sb); } }
  }
  console.log('bad', bad);
});
