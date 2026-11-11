/**
 * A table's identity (schema folder + name) and the reference rule that
 * names it in a scope (packages/core/src/tableIdentity.ts): the key and its
 * case rules, the references of unique, twin, repeated, layer-twin,
 * schema-less and dotted-name tables, and the order and ambiguity of the
 * resolver. Then the same rules over the fixture project
 * test/fixtures/same-name-two-schemas (bqs.addresse and ccc.addresse, with a
 * kunde in each), which sits outside packages/core/test/fixtures/dbml/ until
 * the host and core draw it alike.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  assignTableRefs,
  matchTableRef,
  qualifiedRef,
  resolveTableRef,
  resolveTableRefs,
  sameTableId,
  tableIdKey,
  tableIdOfPath,
  type TableId,
  type TableRefCandidate,
} from '../../src/tableIdentity';
import * as core from '../../src/index';
import { compileDbmlProject, parseSubjectAreaDbml, readErdLayoutDbml } from '../../src/dbml/index';
import { STORAGE_PARSERS } from '../dbmlParsers';

const id = (schema: string, name: string): TableId => ({ schema, name });

/** Candidates of one scope, each with the reference {@link assignTableRefs} gives it there. */
function scope(tables: TableId[], qualifiers: Array<readonly string[] | undefined> = []): TableRefCandidate[] {
  const refs = assignTableRefs(tables);
  return tables.map((t, i) => ({ ...t, ref: refs[i], ...(qualifiers[i] ? { qualifiers: qualifiers[i] } : {}) }));
}

describe('the identity key', () => {
  it('is the schema folder and the trimmed name, both without case', () => {
    expect(tableIdKey(id('bqs', 'addresse'))).toBe('bqs/addresse');
    expect(tableIdKey(id('Sales', ' Orders '))).toBe('sales/orders');
    expect(tableIdKey(id('SAP FI', 'afih'))).toBe('sap fi/afih');
    expect(sameTableId(id('Sales', 'Orders'), id('sales', 'orders'))).toBe(true);
    expect(sameTableId(id('bqs', 'addresse'), id('ccc', 'addresse'))).toBe(false);
  });

  it('gives a table with no schema folder (YAML, a member with no file) its name alone', () => {
    expect(tableIdKey(id('', 'dim_customer'))).toBe('/dim_customer');
    expect(sameTableId(id('', 'dim_customer'), id('public', 'dim_customer'))).toBe(false);
  });

  it('never confuses a dotted name with a schema and a name: / cannot be in either', () => {
    expect(tableIdKey(id('x', 'ccc.addresse'))).toBe('x/ccc.addresse');
    expect(tableIdKey(id('ccc', 'addresse'))).toBe('ccc/addresse');
    expect(tableIdKey(id('a.b', 'c'))).not.toBe(tableIdKey(id('a', 'b.c')));
  });

  it('is exported from the main entry, which stays parser-free', () => {
    expect(core.tableIdKey).toBe(tableIdKey);
    expect(core.assignTableRefs).toBe(assignTableRefs);
    expect(core.resolveTableRef).toBe(resolveTableRef);
  });
});

describe('tableIdOfPath', () => {
  it('reads a table file of the layer-first tree, with its layer beside the identity', () => {
    expect(tableIdOfPath('bronze/tables/ccc/addresse.dbml')).toEqual({ layer: 'bronze', schema: 'ccc', name: 'addresse' });
    expect(tableIdOfPath('silver/tables/SAP FI/afih.dbml')).toEqual({ layer: 'silver', schema: 'SAP FI', name: 'afih' });
    // The folder as listed: its case is kept, and compares without it.
    const upper = tableIdOfPath('bronze/tables/BQS/x.dbml')!;
    expect(upper.schema).toBe('BQS');
    expect(sameTableId(upper, tableIdOfPath('bronze/tables/bqs/x.dbml')!)).toBe(true);
  });

  it('leaves the layer out of the identity: one schema and name in two layers is one table', () => {
    const silver = tableIdOfPath('silver/tables/sales/orders.dbml')!;
    const gold = tableIdOfPath('gold/tables/sales/orders.dbml')!;
    expect([silver.layer, gold.layer]).toEqual(['silver', 'gold']);
    expect(sameTableId(silver, gold)).toBe(true);
    expect(sameTableId(tableIdOfPath('silver/tables/silver/orders.dbml')!, tableIdOfPath('gold/tables/gold/orders.dbml')!)).toBe(false);
  });

  it('takes the schema from the path shape, never from the name: a folder called relationships, a dotted stem', () => {
    expect(tableIdOfPath('bronze/tables/relationships/x.dbml')).toEqual({ layer: 'bronze', schema: 'relationships', name: 'x' });
    expect(tableIdOfPath('bronze/tables/x/ccc.addresse.dbml')).toEqual({ layer: 'bronze', schema: 'x', name: 'ccc.addresse' });
    expect(tableIdOfPath('bronze/tables/bqs/ccc.dbml')).toEqual({ layer: 'bronze', schema: 'bqs', name: 'ccc' });
  });

  it('is undefined for every path that is not a table file', () => {
    for (const p of [
      'bronze/diagrams/kunden.dbml',
      'bronze/relationships/bronze.dbml',
      'logical-models/dim_customer.yml',
      'bronze/tables/addresse.dbml',
      'bronze/tables/ccc/sub/addresse.dbml',
      'bronze/tables/ccc/addresse.yml',
      'Bronze/tables/ccc/addresse.dbml',
      '../bronze/tables/ccc/addresse.dbml',
      '/abs/bronze/tables/ccc/addresse.dbml',
      'bronze\\tables\\ccc\\addresse.dbml',
      '',
    ]) {
      expect(tableIdOfPath(p), p).toBeUndefined();
    }
  });
});

describe('qualifiedRef', () => {
  it('is <schema>.<name>, or the name alone with no schema folder', () => {
    expect(qualifiedRef('ccc', 'addresse')).toBe('ccc.addresse');
    expect(qualifiedRef('SAP FI', 'afih')).toBe('SAP FI.afih');
    expect(qualifiedRef('', 'addresse')).toBe('addresse');
  });
});

describe('assignTableRefs: bare unless two tables share the name', () => {
  it('names every table by its bare name, spelled as given, when every name is unique: what every existing diagram holds', () => {
    expect(assignTableRefs([id('gold', 'fct_order'), id('gold', 'dim_customer'), id('calendar', 'dim_date')]))
      .toEqual(['fct_order', 'dim_customer', 'dim_date']);
    expect(assignTableRefs([id('Gold', 'DimCustomer ')])).toEqual(['DimCustomer ']);
    expect(assignTableRefs([])).toEqual([]);
  });

  it('qualifies both twins, and only them', () => {
    expect(assignTableRefs([id('bqs', 'addresse'), id('bqs', 'kunde'), id('ccc', 'addresse'), id('ccc', 'orders')]))
      .toEqual(['bqs.addresse', 'kunde', 'ccc.addresse', 'orders']);
  });

  it('compares names without case: Addresse in ccc is a twin of addresse in bqs; the schema keeps the spelling given', () => {
    expect(assignTableRefs([id('bqs', 'addresse'), id('CCC', 'Addresse')])).toEqual(['bqs.addresse', 'CCC.Addresse']);
  });

  it('keeps a table listed twice, and a layer twin, at its bare name: one identity is no pair', () => {
    expect(assignTableRefs([id('gold', 'dim_date'), id('gold', 'dim_date')])).toEqual(['dim_date', 'dim_date']);
    // Two layers, one schema folder (and case-twin folders): the same table, as a Ref end cannot tell them apart.
    expect(assignTableRefs([id('sales', 'orders'), id('sales', 'orders'), id('Sales', 'orders')])).toEqual(['orders', 'orders', 'orders']);
  });

  it('qualifies every listing of a twin when it is listed twice beside the other', () => {
    expect(assignTableRefs([id('bqs', 'addresse'), id('ccc', 'addresse'), id('bqs', 'addresse')]))
      .toEqual(['bqs.addresse', 'ccc.addresse', 'bqs.addresse']);
  });

  it('keeps a table with no schema folder at its bare name; its schema-folder namesake is qualified', () => {
    expect(assignTableRefs([id('', 'addresse'), id('kunden', 'kunde')])).toEqual(['addresse', 'kunde']);
    expect(assignTableRefs([id('', 'addresse'), id('bqs', 'addresse')])).toEqual(['addresse', 'bqs.addresse']);
  });

  it('three schemas with one name: all three qualified', () => {
    expect(assignTableRefs([id('a', 'x'), id('b', 'x'), id('c', 'x'), id('c', 'y')])).toEqual(['a.x', 'b.x', 'c.x', 'y']);
  });

  it('a table named like a schema stays bare: nothing splits on a dot or reads a name as a schema', () => {
    expect(assignTableRefs([id('bqs', 'ccc'), id('ccc', 'addresse')])).toEqual(['ccc', 'addresse']);
    expect(assignTableRefs([id('relationships', 'x'), id('gold', 'relationships')])).toEqual(['x', 'relationships']);
  });

  it('a dotted stem keeps its bare name while no other reference has its text', () => {
    expect(assignTableRefs([id('x', 'ccc.addresse'), id('ccc', 'kunde')])).toEqual(['ccc.addresse', 'kunde']);
    // ccc.addresse beside a lone addresse in ccc: different texts, so both stay bare.
    expect(assignTableRefs([id('x', 'ccc.addresse'), id('ccc', 'addresse')])).toEqual(['ccc.addresse', 'addresse']);
  });

  it('a dotted stem whose text a twin\'s qualified reference takes is qualified too', () => {
    expect(assignTableRefs([id('x', 'ccc.addresse'), id('ccc', 'addresse'), id('bqs', 'addresse')]))
      .toEqual(['x.ccc.addresse', 'ccc.addresse', 'bqs.addresse']);
    // In any case.
    expect(assignTableRefs([id('x', 'CCC.Addresse'), id('ccc', 'addresse'), id('bqs', 'addresse')]))
      .toEqual(['x.CCC.Addresse', 'ccc.addresse', 'bqs.addresse']);
  });

  it('two tables whose qualified texts are still equal keep equal references, read as one table listed twice', () => {
    // a.b + c and a + b.c: twins only if the bare names match; here they do not, so both are bare.
    expect(assignTableRefs([id('a.b', 'c'), id('a', 'b.c')])).toEqual(['c', 'b.c']);
    // Forced to qualify by a twin each, they end up spelled alike.
    expect(assignTableRefs([id('a.b', 'c'), id('z', 'c'), id('a', 'b.c'), id('z', 'b.c')]))
      .toEqual(['a.b.c', 'z.c', 'a.b.c', 'z.b.c']);
  });

  it('is pure: the same input gives the same references, and order only moves them', () => {
    const tables = [id('ccc', 'kunde'), id('bqs', 'addresse'), id('ccc', 'addresse'), id('bqs', 'kunde')];
    expect(assignTableRefs(tables)).toEqual(assignTableRefs([...tables]));
    expect(assignTableRefs([...tables].reverse())).toEqual([...assignTableRefs(tables)].reverse());
  });
});

describe('matchTableRef: reference, folder, qualifier, unique bare name', () => {
  const twins = scope([id('bqs', 'addresse'), id('bqs', 'kunde'), id('ccc', 'addresse'), id('ccc', 'orders')]);

  it('finds a table by its reference first, without case', () => {
    expect(matchTableRef('ccc.addresse', twins)).toEqual({ kind: 'found', index: 2, step: 'reference' });
    expect(matchTableRef('CCC.Addresse', twins)).toEqual({ kind: 'found', index: 2, step: 'reference' });
    expect(matchTableRef('kunde', twins)).toEqual({ kind: 'found', index: 1, step: 'reference' });
    expect(matchTableRef(' kunde ', twins)).toEqual({ kind: 'found', index: 1, step: 'reference' });
  });

  it('finds a table whose reference is bare by its <folder>.<name> too', () => {
    expect(matchTableRef('bqs.kunde', twins)).toEqual({ kind: 'found', index: 1, step: 'folder' });
    expect(matchTableRef('BQS.KUNDE', twins)).toEqual({ kind: 'found', index: 1, step: 'folder' });
  });

  it('finds a table by a qualifier other than its folder (its declared schema, a use specifier\'s)', () => {
    const mismatched = scope([id('bqs', 'addresse'), id('legacy', 'kunde')], [undefined, ['crm']]);
    expect(matchTableRef('crm.kunde', mismatched)).toEqual({ kind: 'found', index: 1, step: 'qualifier' });
    expect(matchTableRef('legacy.kunde', mismatched)).toEqual({ kind: 'found', index: 1, step: 'folder' });
  });

  it('the folder decides before a declared qualifier: identity is the folder', () => {
    // bqs/addresse.dbml declares `Table ccc.addresse` (schemaFolderMismatch); ccc/addresse.dbml is the real ccc table.
    const candidates = scope([id('bqs', 'addresse'), id('ccc', 'addresse')], [['ccc'], undefined]);
    expect(candidates.map((c) => c.ref)).toEqual(['bqs.addresse', 'ccc.addresse']);
    expect(matchTableRef('ccc.addresse', candidates)).toEqual({ kind: 'found', index: 1, step: 'reference' });
    const one = scope([id('bqs', 'kunde'), id('ccc', 'kunde')], [['crm'], undefined]);
    expect(matchTableRef('crm.kunde', one)).toEqual({ kind: 'found', index: 0, step: 'qualifier' });
  });

  it('finds a table by its bare name only when no other table has it', () => {
    const lone = scope([id('ccc', 'addresse'), id('ccc', 'kunde')]);
    expect(matchTableRef('addresse', lone)).toEqual({ kind: 'found', index: 0, step: 'reference' });
    // A twin's bare name names two tables: ambiguous, never a guess.
    expect(matchTableRef('addresse', twins)).toEqual({ kind: 'ambiguous', candidates: [0, 2] });
    expect(resolveTableRef('addresse', twins)).toBeUndefined();
    // Only where placing a table is all it does: the first, in the scope's order.
    expect(matchTableRef('addresse', twins, { onAmbiguous: 'first' })).toEqual({ kind: 'found', index: 0, step: 'bareName' });
    expect(resolveTableRef('Addresse', twins, { onAmbiguous: 'first' })).toBe(0);
  });

  it('is missing for text that names no table, and for anything that is not text', () => {
    expect(matchTableRef('ddd.addresse', twins)).toEqual({ kind: 'missing' });
    expect(matchTableRef('nothing', twins)).toEqual({ kind: 'missing' });
    expect(matchTableRef('', twins)).toEqual({ kind: 'missing' });
    expect(matchTableRef(undefined as unknown as string, twins)).toEqual({ kind: 'missing' });
    expect(matchTableRef('addresse', [])).toEqual({ kind: 'missing' });
  });

  it('a table listed twice answers its first listing, never ambiguous', () => {
    const repeated = scope([id('gold', 'dim_date'), id('gold', 'fct_order'), id('gold', 'dim_date')]);
    expect(matchTableRef('dim_date', repeated)).toEqual({ kind: 'found', index: 0, step: 'reference' });
    expect(matchTableRef('gold.dim_date', repeated)).toEqual({ kind: 'found', index: 0, step: 'folder' });
    // Layer twins are one identity too.
    const layers = scope([id('sales', 'orders'), id('sales', 'orders')]);
    expect(matchTableRef('orders', layers)).toEqual({ kind: 'found', index: 0, step: 'reference' });
  });

  it('a table named like a schema, and dotted stems, each resolve to themselves', () => {
    // A table called ccc in bqs, a stem ccc.addresse in x, and addresse in ccc and bqs.
    const tables = scope([id('bqs', 'ccc'), id('x', 'ccc.addresse'), id('ccc', 'addresse'), id('bqs', 'addresse')]);
    expect(tables.map((t) => t.ref)).toEqual(['ccc', 'x.ccc.addresse', 'ccc.addresse', 'bqs.addresse']);
    expect(resolveTableRef('ccc', tables)).toBe(0);
    expect(resolveTableRef('bqs.ccc', tables)).toBe(0);
    expect(resolveTableRef('x.ccc.addresse', tables)).toBe(1);
    expect(resolveTableRef('ccc.addresse', tables)).toBe(2);
    expect(resolveTableRef('bqs.addresse', tables)).toBe(3);
    // Without the bqs twin, the stem keeps its bare name and its exact text wins over the ccc folder's qualified form.
    const two = scope([id('x', 'ccc.addresse'), id('ccc', 'addresse')]);
    expect(two.map((t) => t.ref)).toEqual(['ccc.addresse', 'addresse']);
    expect(matchTableRef('ccc.addresse', two)).toEqual({ kind: 'found', index: 0, step: 'reference' });
    expect(matchTableRef('addresse', two)).toEqual({ kind: 'found', index: 1, step: 'reference' });
  });

  it('two tables whose qualified texts are equal answer the first, as one table listed twice did', () => {
    const tables = scope([id('a.b', 'c'), id('z', 'c'), id('a', 'b.c'), id('z', 'b.c')]);
    expect(matchTableRef('a.b.c', tables)).toEqual({ kind: 'found', index: 0, step: 'reference' });
  });

  it('a table with no schema folder is found by its name; a folder step never matches it', () => {
    const mixed = scope([id('', 'dim_customer'), id('gold', 'fct_order')]);
    expect(matchTableRef('dim_customer', mixed)).toEqual({ kind: 'found', index: 0, step: 'reference' });
    expect(matchTableRef('.dim_customer', mixed)).toEqual({ kind: 'missing' });
  });

  describe('claimed: a bare text never takes a table a more specific text placed', () => {
    it('skips a claimed table for a bare text, at the reference and bare-name steps', () => {
      const lone = scope([id('bqs', 'addresse'), id('bqs', 'kunde')]);
      expect(matchTableRef('addresse', lone, { claimed: new Set([0]) })).toEqual({ kind: 'missing' });
      expect(matchTableRef('addresse', twins, { onAmbiguous: 'first', claimed: new Set([0]) })).toEqual({ kind: 'found', index: 2, step: 'bareName' });
      expect(matchTableRef('addresse', twins, { claimed: new Set([0]) })).toEqual({ kind: 'found', index: 2, step: 'bareName' });
      expect(matchTableRef('addresse', twins, { onAmbiguous: 'first', claimed: new Set([0, 2]) })).toEqual({ kind: 'missing' });
    });

    it('still lets a qualified text take a claimed table', () => {
      expect(matchTableRef('bqs.addresse', twins, { claimed: new Set([0]) })).toEqual({ kind: 'found', index: 0, step: 'reference' });
      expect(matchTableRef('bqs.kunde', twins, { claimed: new Set([1]) })).toEqual({ kind: 'found', index: 1, step: 'folder' });
    });
  });
});

describe('resolveTableRefs: qualified texts first, then the bare ones', () => {
  const both = scope([id('bqs', 'addresse'), id('bqs', 'kunde'), id('ccc', 'addresse'), id('ccc', 'kunde')]);

  it('places every member of a diagram written with qualified lines', () => {
    expect(resolveTableRefs(['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde'], both)).toEqual([0, 1, 2, 3]);
  });

  it('a 2.0.2 diagram\'s bare lines go to the first twin in use order for layout, and to nothing for meaning', () => {
    expect(resolveTableRefs(['addresse', 'kunde'], both, { onAmbiguous: 'first' })).toEqual([0, 1]);
    expect(resolveTableRefs(['addresse', 'kunde'], both)).toEqual([undefined, undefined]);
  });

  it('a bare line beside a qualified one places the other twin, whatever line comes first', () => {
    expect(resolveTableRefs(['addresse', 'bqs.addresse'], both, { onAmbiguous: 'first' })).toEqual([2, 0]);
    expect(resolveTableRefs(['bqs.addresse', 'addresse'], both, { onAmbiguous: 'first' })).toEqual([0, 2]);
    // Every twin placed by its own line: the bare one is a stray and places nothing.
    expect(resolveTableRefs(['addresse', 'ccc.addresse', 'bqs.addresse'], both, { onAmbiguous: 'first' })).toEqual([undefined, 2, 0]);
  });

  it('a stray bare line never moves a table its qualified line placed, after the twin has left the diagram', () => {
    const lone = scope([id('bqs', 'addresse'), id('bqs', 'kunde')]);
    expect(lone[0].ref).toBe('addresse');
    expect(resolveTableRefs(['addresse', 'bqs.addresse'], lone, { onAmbiguous: 'first' })).toEqual([undefined, 0]);
    expect(resolveTableRefs(['addresse', 'kunde'], lone, { onAmbiguous: 'first' })).toEqual([0, 1]);
  });

  it('a diagram with no shared name places every bare line as it always did', () => {
    const plain = scope([id('gold', 'fct_order'), id('gold', 'dim_customer')]);
    expect(resolveTableRefs(['dim_customer', 'fct_order', 'missing'], plain)).toEqual([1, 0, undefined]);
  });
});

// ---------------------------------------------------------------------------
// The fixture project: two schemas, two tables of each name
// ---------------------------------------------------------------------------

const TWINS = path.resolve(__dirname, '../../../../test/fixtures/same-name-two-schemas/.erd-studio');

function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.dbml')) out[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf-8');
    }
  };
  walk(dir);
  return out;
}

describe('the same-name-two-schemas fixture', () => {
  const files = filesOf(TWINS);
  const diagram = (name: string) => `bronze/diagrams/${name}.dbml`;
  /** A diagram's members as identities, from its use lines' resolved paths. */
  const membersOf = (name: string): TableId[] => {
    const reading = parseSubjectAreaDbml(files[diagram(name)], `.erd-studio/${diagram(name)}`);
    return reading.uses!.map((u) => tableIdOfPath(u.resolved)!);
  };

  it('holds four table files with four identities and two shared names', () => {
    const tables = Object.keys(files).map(tableIdOfPath).filter((t): t is NonNullable<typeof t> => t !== undefined);
    expect(tables.map(tableIdKey).sort()).toEqual(['bqs/addresse', 'bqs/kunde', 'ccc/addresse', 'ccc/kunde']);
    expect(assignTableRefs(tables).sort()).toEqual(['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde']);
  });

  it.each(STORAGE_PARSERS)('compiles clean as a multi-file project in DBML %s: every pinned parser reads the shape', (_label, parser) => {
    const entries = Object.keys(files).filter((p) => p.split('/')[1] === 'diagrams');
    expect(entries.sort()).toEqual([diagram('ccc'), diagram('kunden-bare'), diagram('kunden')]);
    const result = compileDbmlProject(files, entries, parser);
    for (const [file, diagnostics] of Object.entries(result)) expect({ file, diagnostics }).toEqual({ file, diagnostics: [] });
  });

  it('the ccc-only diagram names its members bare, as its erd_layout does', () => {
    const refs = assignTableRefs(membersOf('ccc'));
    expect(refs).toEqual(['addresse', 'kunde']);
    expect(Object.keys(readErdLayoutDbml(files[diagram('ccc')])!.positions).sort()).toEqual([...refs].sort());
  });

  it('the diagram with all four is version 8 (it holds a pair) and its erd_layout lines and sticky link are its members\' references', () => {
    const members = membersOf('kunden');
    const refs = assignTableRefs(members);
    expect(refs).toEqual(['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde']);
    const layout = readErdLayoutDbml(files[diagram('kunden')])!;
    const candidates = members.map((m, i) => ({ ...m, ref: refs[i] }));
    expect(resolveTableRefs(Object.keys(layout.positions), candidates)).toEqual([0, 1, 2, 3]);
    // Core reads version 8 (nothing writes it yet).
    const reading = parseSubjectAreaDbml(files[diagram('kunden')], `.erd-studio/${diagram('kunden')}`);
    expect(reading.schemaVersion).toBe(8);
    const linked = (reading.obj.viewConfig as { annotations: Array<{ linkedModel?: string }> }).annotations[0].linkedModel!;
    expect(resolveTableRef(linked, candidates)).toBe(2);
  });

  it('the same diagram as 2.0.2 kept it (one bare line per name) is version 7, and its bare lines and link place the first twin', () => {
    const members = membersOf('kunden-bare');
    const refs = assignTableRefs(members);
    const candidates = members.map((m, i) => ({ ...m, ref: refs[i] }));
    const reading = parseSubjectAreaDbml(files[diagram('kunden-bare')], `.erd-studio/${diagram('kunden-bare')}`);
    expect(reading.schemaVersion).toBe(7);
    const layout = readErdLayoutDbml(files[diagram('kunden-bare')])!;
    expect(Object.keys(layout.positions)).toEqual(['addresse', 'kunde']);
    expect(resolveTableRefs(Object.keys(layout.positions), candidates, { onAmbiguous: 'first' })).toEqual([0, 1]);
    const linked = (reading.obj.viewConfig as { annotations: Array<{ linkedModel?: string }> }).annotations[0].linkedModel!;
    expect(resolveTableRef(linked, candidates, { onAmbiguous: 'first' })).toBe(0);
    expect(resolveTableRef(linked, candidates)).toBeUndefined();
  });
});
