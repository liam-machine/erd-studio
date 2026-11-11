/**
 * The diagram boundary (src/services/diagramMemberTable.ts): a diagram's
 * members with their references and files, how text is resolved among them
 * (never by splitting on a dot), and which references change when a
 * namesake joins, leaves or is renamed.
 */
import { describe, it, expect } from 'vitest';

import { DiagramMemberTable, renameMemberRefs } from '../../src/services/diagramMemberTable';
import type { DbmlMemberUse } from '@erd-studio/core';

const use = (name: string, schema: string, ref = name, qualifier?: string): DbmlMemberUse => ({
  name,
  path: `../tables/${schema}/${name}.dbml`,
  resolved: `bronze/tables/${schema}/${name}.dbml`,
  line: 1,
  ref,
  schema,
  layer: 'bronze',
  ...(qualifier !== undefined ? { qualifier } : {}),
});

/** kunden: both addresse tables (qualified) and one kunde (bare). */
const KUNDEN = DiagramMemberTable.fromUses([
  use('addresse', 'bqs', 'bqs.addresse', 'bqs'),
  use('kunde', 'bqs', 'kunde', 'bqs'),
  use('addresse', 'ccc', 'ccc.addresse', 'ccc'),
], ['notes']);

describe('DiagramMemberTable', () => {
  it('lists each member with the file its use line reads, and an unlinked member by name alone', () => {
    expect(KUNDEN.refs()).toEqual(['bqs.addresse', 'kunde', 'ccc.addresse', 'notes']);
    expect(KUNDEN.rows[2]).toEqual({ ref: 'ccc.addresse', name: 'addresse', id: { layer: 'bronze', schema: 'ccc', name: 'addresse' }, path: 'bronze/tables/ccc/addresse.dbml', qualifier: 'ccc' });
    expect(KUNDEN.rows[3]).toEqual({ ref: 'notes', name: 'notes' });
  });

  it('resolves a reference, a <schema>.<name>, or a bare name only one member has; never a shared bare name', () => {
    expect(KUNDEN.resolve('ccc.addresse')?.path).toBe('bronze/tables/ccc/addresse.dbml');
    expect(KUNDEN.resolve('CCC.Addresse')?.ref).toBe('ccc.addresse');
    expect(KUNDEN.resolve('bqs.kunde')?.ref).toBe('kunde');
    expect(KUNDEN.resolve('kunde')?.ref).toBe('kunde');
    expect(KUNDEN.resolve('addresse')).toBeUndefined();
    expect(KUNDEN.resolve('ddd.addresse')).toBeUndefined();
    expect(KUNDEN.resolve('orders')).toBeUndefined();
  });

  it('finds the member a table file is, by identity (any case)', () => {
    expect(KUNDEN.memberOf({ schema: 'CCC', name: 'Addresse' })?.ref).toBe('ccc.addresse');
    expect(KUNDEN.memberOf({ schema: 'ddd', name: 'addresse' })).toBeUndefined();
  });

  it('a namesake joining qualifies both; a table of a new name stays bare', () => {
    const bqs = DiagramMemberTable.fromUses([use('addresse', 'bqs'), use('kunde', 'bqs')]);
    expect(bqs.adding([{ schema: 'ccc', name: 'addresse' }])).toEqual({ refs: ['ccc.addresse'], renames: new Map([['addresse', 'bqs.addresse']]) });
    expect(bqs.adding([{ schema: 'ccc', name: 'orte' }])).toEqual({ refs: ['orte'], renames: new Map() });
  });

  it('a namesake leaving, or renamed away, brings the other back to its bare name', () => {
    expect(KUNDEN.removing(['ccc.addresse'])).toEqual(new Map([['bqs.addresse', 'addresse']]));
    expect(KUNDEN.removing(['kunde'])).toEqual(new Map());
    expect(KUNDEN.renaming('ccc.addresse', 'adresse2')).toEqual({
      ref: 'adresse2',
      renames: new Map([['bqs.addresse', 'addresse'], ['ccc.addresse', 'adresse2']]),
    });
  });

  it('a JSON diagram names its members by name alone', () => {
    const json = DiagramMemberTable.fromNames(['fct_order', 'dim_customer']);
    expect(json.resolve('FCT_ORDER')?.ref).toBe('fct_order');
    expect(json.rows[0].id).toBeUndefined();
  });
});

describe('renameMemberRefs', () => {
  it('carries the renames through the models, ends, positions, sticky links and stub entries, in place, keeping the section object', () => {
    const logical = {
      models: ['addresse', 'kunde'],
      relationships: [{ fromModel: 'kunde', fromColumn: 'addresse_id', toModel: 'addresse', toColumn: 'id', cardinality: 'many-to-one' }],
    };
    const parsed: Record<string, unknown> = {
      logical,
      viewConfig: { positions: { addresse: { x: 10, y: 20 }, kunde: { x: 300, y: 20 } }, annotations: [{ id: 'n1', type: 'sticky', text: '', x: 0, y: 0, linkedModel: 'addresse' }] },
      stubColumns: ['addresse'],
    };
    renameMemberRefs(parsed, new Map([['addresse', 'bqs.addresse']]));
    expect(parsed.logical).toBe(logical);
    expect(logical.models).toEqual(['bqs.addresse', 'kunde']);
    expect(logical.relationships[0].toModel).toBe('bqs.addresse');
    expect((parsed.viewConfig as { positions: Record<string, unknown> }).positions).toEqual({ 'bqs.addresse': { x: 10, y: 20 }, kunde: { x: 300, y: 20 } });
    expect((parsed.viewConfig as { annotations: Array<{ linkedModel?: string }> }).annotations[0].linkedModel).toBe('bqs.addresse');
    expect(parsed.stubColumns).toEqual(['bqs.addresse']);
  });

  it('changes nothing with no renames', () => {
    const parsed = { logical: { models: ['a'] } };
    const before = structuredClone(parsed);
    renameMemberRefs(parsed, new Map());
    expect(parsed).toEqual(before);
  });
});
