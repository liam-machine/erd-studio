/**
 * Reading two tables of one name from different schema folders (schema-scoped
 * identity, stage 2): the diagram reader names each member by its reference
 * (its name, or `<schema>.<name>` when another member shares the name), and
 * resolves erd_layout lines, sticky links, stub entries and pending Refs to
 * those references; the relationships reader keeps a Ref between two
 * same-named tables of different schemas; the attach step resolves each Ref
 * end by the relationships file's own `use` line, then its qualifier, then a
 * unique name, and never guesses; the finder answers a stale member only
 * with its own schema's file or the one table of its name. A diagram where no
 * two members share a name reads exactly as before (the repo-wide guard,
 * test/unit/schemaIdentityGuard.test.ts, pins every existing one).
 */
import { describe, it, expect } from 'vitest';

import { diagramSummaryDbml, parseSubjectAreaDbml, subjectAreaMembersDbml } from '../../src/dbml/readDiagram';
import { readRelationshipsDbml } from '../../src/dbml/readRelationships';
import { attachRelationships, contestedUsePaths, dbmlTableLookup, type DbmlAttachReading } from '../../src/dbmlAttach';
import { erdLayoutView } from '../../src/erdLayout';
import { dbmlTableFinder } from '../../src/storage';
import { keyEvidenceOf, buildDbtKeyIndex } from '../../src/keyEvidence';
import type { DbmlAttachTable } from '../../src/types/dbmlStorage';
import { tableIdOfPath } from '../../src/tableIdentity';

const DIAGRAM = '.erd-studio/bronze/diagrams/kunden.dbml';

/** A diagram of bronze with the given Project body lines and use lines. */
const diagram = (project: string[], uses: string[], rest: string[] = []): string =>
  [`Project kunden {`, `  erd_schema_version: '8'`, ...project.map((l) => `  ${l}`), `}`, '', ...uses, ...rest, ''].join('\n');

const BOTH_USES = [
  "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
  "use { table bqs.kunde } from '../tables/bqs/kunde.dbml'",
  "use { table ccc.addresse } from '../tables/ccc/addresse.dbml'",
  "use { table ccc.kunde } from '../tables/ccc/kunde.dbml'",
];

const layoutOf = (lines: string[]): string[] => ["erd_layout: '''", ...lines.map((l) => `  ${l}`), "'''"];

describe('parseSubjectAreaDbml: members that share a name', () => {
  it('names each by <schema>.<name> (the schema as the use path spells it), and every other member by its name', () => {
    const text = diagram([], [...BOTH_USES, "use { table ccc.region } from '../tables/CCC/region.dbml'"]);
    const reading = parseSubjectAreaDbml(text, DIAGRAM);
    expect(reading.members).toEqual(['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde', 'region']);
    expect((reading.obj.logical as { models: string[] }).models).toEqual(reading.members);
    expect(reading.uses!.map((u) => [u.name, u.ref, u.schema, u.layer, u.qualifier])).toEqual([
      ['addresse', 'bqs.addresse', 'bqs', 'bronze', 'bqs'],
      ['kunde', 'bqs.kunde', 'bqs', 'bronze', 'bqs'],
      ['addresse', 'ccc.addresse', 'ccc', 'bronze', 'ccc'],
      ['kunde', 'ccc.kunde', 'ccc', 'bronze', 'ccc'],
      ['region', 'region', 'CCC', 'bronze', 'ccc'],
    ]);
  });

  it('a schema folder spelled in another case is the same schema: the same table listed twice keeps its bare name', () => {
    const text = diagram([], [
      "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
      "use { table bqs.addresse } from '../tables/BQS/addresse.dbml'",
    ]);
    expect(parseSubjectAreaDbml(text, DIAGRAM).members).toEqual(['addresse', 'addresse']);
  });

  it('the same schema and name in two layers is one table: both lines keep its bare name', () => {
    const text = diagram([], [
      "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
      "use { table bqs.addresse } from '../../silver/tables/bqs/addresse.dbml'",
    ]);
    expect(parseSubjectAreaDbml(text, DIAGRAM).members).toEqual(['addresse', 'addresse']);
  });

  it('places qualified erd_layout lines on their own twin, and a sticky linked by reference', () => {
    const text = diagram(
      layoutOf(['bqs.addresse 40 40', 'ccc.addresse 40 360', 'bqs.kunde 400 40', 'ccc.kunde 400 360']),
      BOTH_USES,
      ['Note n1 [linked_table: \'ccc.addresse\'] {', "  'x'", '}'],
    );
    const reading = parseSubjectAreaDbml(text, DIAGRAM);
    const view = reading.obj.viewConfig as { positions: Record<string, unknown>; annotations: Array<{ linkedModel?: string }> };
    expect(view.positions).toEqual({
      'bqs.addresse': { x: 40, y: 40 },
      'ccc.addresse': { x: 40, y: 360 },
      'bqs.kunde': { x: 400, y: 40 },
      'ccc.kunde': { x: 400, y: 360 },
    });
    expect(view.annotations[0].linkedModel).toBe('ccc.addresse');
    expect(reading.layoutSharedBare).toBeUndefined();
  });

  it('a 2.0.2 diagram (one bare line per name) places the first twin, and links its sticky to it', () => {
    const text = diagram(layoutOf(['addresse 40 40', 'kunde 400 40']), BOTH_USES, ['Note n1 [linked_table: \'addresse\'] {', "  'x'", '}']);
    const reading = parseSubjectAreaDbml(text, DIAGRAM);
    const view = reading.obj.viewConfig as { positions: Record<string, unknown>; annotations: Array<{ linkedModel?: string }> };
    expect(view.positions).toEqual({ 'bqs.addresse': { x: 40, y: 40 }, 'bqs.kunde': { x: 400, y: 40 } });
    expect(view.annotations[0].linkedModel).toBe('bqs.addresse');
    expect(reading.layoutSharedBare).toEqual(['bqs.addresse', 'bqs.kunde']);
  });

  it('a stray bare line beside a qualified one never moves a table the qualified one placed', () => {
    // bqs.addresse is placed by its own line; the bare line goes to the other addresse, the only one left.
    const both = parseSubjectAreaDbml(diagram(layoutOf(['addresse 1 1', 'bqs.addresse 10 20']), BOTH_USES), DIAGRAM);
    expect((both.obj.viewConfig as { positions: unknown }).positions).toEqual({ 'ccc.addresse': { x: 1, y: 1 }, 'bqs.addresse': { x: 10, y: 20 } });
    // With one addresse left on the diagram, the stray places nothing: the qualified line wins.
    const one = parseSubjectAreaDbml(diagram(layoutOf(['addresse 1 1', 'bqs.addresse 10 20']), [BOTH_USES[0]]), DIAGRAM);
    expect(one.members).toEqual(['addresse']);
    expect((one.obj.viewConfig as { positions: unknown }).positions).toEqual({ addresse: { x: 10, y: 20 } });
  });

  it('a unique member keeps its exact spelling for every text that names it as before (stub entries, links, case variants)', () => {
    const text = diagram(
      [...layoutOf(['Addresse 5 5', 'addresse 1 1']), `erd_stub_columns: '["Addresse"]'`],
      [BOTH_USES[2]],
      ['Note n1 [linked_table: \'ADDRESSE\'] {', "  'x'", '}'],
    );
    const reading = parseSubjectAreaDbml(text, DIAGRAM);
    expect((reading.obj.viewConfig as { positions: unknown }).positions).toEqual({ Addresse: { x: 5, y: 5 }, addresse: { x: 1, y: 1 } });
    expect(reading.obj.stubColumns).toEqual(['Addresse']);
    expect((reading.obj.viewConfig as { annotations: Array<{ linkedModel?: string }> }).annotations[0].linkedModel).toBe('ADDRESSE');
  });

  it('stub entries name their twin by reference; a bare one names the first', () => {
    const text = diagram([`erd_stub_columns: '["ccc.addresse","kunde"]'`], BOTH_USES);
    expect(parseSubjectAreaDbml(text, DIAGRAM).obj.stubColumns).toEqual(['ccc.addresse', 'bqs.kunde']);
  });

  it('an unlinked member is compared with the use members by name: one called like a twin is still dropped', () => {
    const text = diagram([`erd_unlinked_tables: 'addresse, loose'`], BOTH_USES.slice(0, 3));
    const reading = parseSubjectAreaDbml(text, DIAGRAM);
    expect(reading.members).toEqual(['bqs.addresse', 'kunde', 'ccc.addresse', 'loose']);
    expect(reading.unlinked).toEqual(['loose']);
  });

  it('a pending Ref names a twin by its qualifier; an unqualified end two members share names neither', () => {
    const text = diagram([`erd_unlinked_tables: 'loose'`], BOTH_USES, [
      '// erd-studio pending: Ref: loose.addresse_id > ccc.addresse.id',
      '// erd-studio pending: Ref: loose.other_id > addresse.id',
      '// erd-studio pending: Ref: loose.stale_id > crm.kunde.id',
    ]);
    const rels = (parseSubjectAreaDbml(text, DIAGRAM).obj.logical as { relationships: Array<{ fromModel: string; toModel: string }> }).relationships;
    expect(rels.map((r) => `${r.fromModel}>${r.toModel}`)).toEqual(['loose>ccc.addresse', 'loose>addresse', 'loose>kunde']);
  });

  it('diagramSummaryDbml and subjectAreaMembersDbml return the same references', () => {
    const text = diagram([`erd_unlinked_tables: 'loose'`], BOTH_USES);
    const summary = diagramSummaryDbml(text, DIAGRAM)!;
    expect(summary.members).toEqual(['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde']);
    // Each use keeps the shape it had; its reference is `members[i]`, its schema its path's.
    expect(summary.memberUses.map((u) => tableIdOfPath(u.resolved)?.schema)).toEqual(['bqs', 'bqs', 'ccc', 'ccc']);
    expect(summary.memberUses.every((u) => u.ref === undefined)).toBe(true);
    expect(subjectAreaMembersDbml(text, DIAGRAM)).toEqual([...summary.members, 'loose']);
  });
});

describe('readRelationshipsDbml: two tables of one name', () => {
  it('keeps a Ref between them: two qualifiers that differ name two tables', () => {
    const reading = readRelationshipsDbml('Ref: ccc.addresse.id >? bqs.addresse.id\n');
    expect(reading.refs.map((r) => [r.owner, r.ownerQualifier, r.target, r.targetQualifier])).toEqual([['addresse', 'ccc', 'addresse', 'bqs']]);
    expect(reading.problems).toEqual([]);
  });

  it.each([
    ['the same qualifier', 'Ref: bqs.addresse.id > BQS.addresse.id'],
    ['one end unqualified', 'Ref: addresse.id > bqs.addresse.id'],
    ['no qualifier', 'Ref: addresse.id > addresse.id'],
  ])('still drops a column set joined to itself with %s', (_label, line) => {
    const reading = readRelationshipsDbml(`${line}\n`);
    expect(reading.refs).toEqual([]);
    expect(reading.problems[0].message).toContain('joins a column set to itself');
  });

  it('lists the tables its selective use lines import (useTables)', () => {
    const reading = readRelationshipsDbml([
      "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
      "use { table kunde } from '../tables/ccc/kunde'",
      "use { table ccc.kunde } from '../tables/ccc/kunde.dbml'",
      "use * from './other.dbml'",
      '',
    ].join('\n'));
    expect(reading.useTables).toEqual([
      { table: 'addresse', qualifier: 'bqs', path: '../tables/bqs/addresse.dbml' },
      { table: 'kunde', path: '../tables/ccc/kunde' },
      { table: 'kunde', qualifier: 'ccc', path: '../tables/ccc/kunde.dbml' },
    ]);
    expect(readRelationshipsDbml('Ref: a.x > b.y\n').useTables).toBeUndefined();
  });
});

/** An attach entry for a table file at `path` (`<layer>/tables/<schema>/<name>.dbml`), declaring `declared` as its schema. */
function tableAt(path: string, declared?: string, ref?: string): DbmlAttachTable {
  const [, , schema, file] = path.split('/');
  const name = file.replace(/\.dbml$/, '');
  return {
    table: { name, columns: [{ name: 'id', dataType: 'int', description: '', isPrimaryKey: true }, { name: 'addresse_id', dataType: 'int', description: '' }], ...(declared !== undefined ? { schema: declared } : {}) },
    storage: 'dbml',
    path,
    schema,
    ...(ref !== undefined ? { ref } : {}),
  };
}

const REL_FILE = 'bronze/relationships/bronze.dbml';
const reading = (text: string): DbmlAttachReading => ({ path: REL_FILE, semanticPath: REL_FILE, reading: readRelationshipsDbml(text) });
const linksOf = (result: ReturnType<typeof attachRelationships>): string[] =>
  [...result.byOwner].flatMap(([owner, rels]) => rels.map((r) => `${owner}.${r.fromColumn}>${r.toModel}.${r.toColumn}`));

describe('attachRelationships: resolving an end among tables of one name (rule 2)', () => {
  const bqs = tableAt('bronze/tables/bqs/addresse.dbml', 'bqs', 'bqs.addresse');
  const ccc = tableAt('bronze/tables/ccc/addresse.dbml', 'ccc', 'ccc.addresse');
  const kundeBqs = tableAt('bronze/tables/bqs/kunde.dbml', 'bqs', 'bqs.kunde');
  const kundeCcc = tableAt('bronze/tables/ccc/kunde.dbml', 'ccc', 'ccc.kunde');
  const all = [bqs, kundeBqs, ccc, kundeCcc];

  it('(a) by the file\'s own use line for the end\'s spelling, whatever the qualifier says', () => {
    // The use line for `x.addresse` names ccc's file: that is the table, though `x` is no schema.
    const text = [
      "use { table x.addresse } from '../tables/ccc/addresse.dbml'",
      "use { table bqs.kunde } from '../tables/bqs/kunde.dbml'",
      'Ref: bqs.kunde.addresse_id > x.addresse.id', '',
    ].join('\n');
    const result = attachRelationships([reading(text)], dbmlTableLookup(all));
    expect(linksOf(result)).toEqual(['bqs.kunde.addresse_id>ccc.addresse.id']);
    expect(result.locations!.get('bqs.kunde.addresse_id->ccc.addresse.id') ?? [...result.locations!.values()][0]).toMatchObject({
      ownerPath: 'bronze/tables/bqs/kunde.dbml', targetPath: 'bronze/tables/ccc/addresse.dbml',
    });
  });

  it('(b) by the qualifier: the schema folder first, then the schema the file declares', () => {
    const moved = tableAt('bronze/tables/ddd/addresse.dbml', 'ccc', 'ddd.addresse');
    const text = 'Ref: bqs.kunde.addresse_id > bqs.addresse.id\nRef: ccc.kunde.addresse_id > ccc.addresse.id\n';
    expect(linksOf(attachRelationships([reading(text)], dbmlTableLookup(all)))).toEqual([
      'bqs.kunde.addresse_id>bqs.addresse.id', 'ccc.kunde.addresse_id>ccc.addresse.id',
    ]);
    // ccc.addresse now lives in ddd/ but still declares `Table ccc.addresse`.
    expect(linksOf(attachRelationships([reading(text)], dbmlTableLookup([bqs, kundeBqs, moved, kundeCcc])))).toEqual([
      'bqs.kunde.addresse_id>bqs.addresse.id', 'ccc.kunde.addresse_id>ddd.addresse.id',
    ]);
  });

  it('(c) an unqualified end, or one of a table with no schema folder, lands on the one table of its name', () => {
    const text = 'Ref: kunde.addresse_id > addresse.id\n';
    expect(linksOf(attachRelationships([reading(text)], dbmlTableLookup([kundeCcc, ccc])))).toEqual(['ccc.kunde.addresse_id>ccc.addresse.id']);
    const yaml: DbmlAttachTable = { table: { name: 'addresse', columns: [] }, storage: 'yaml' };
    expect(dbmlTableLookup([yaml])('addresse', { qualifier: 'anything' })).toBe(yaml);
  });

  it('(d) a qualifier that names no table still lands on the one table of its name, unless its use line names another file that exists', () => {
    const text = [
      "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
      'Ref: ccc.kunde.addresse_id > bqs.addresse.id', '',
    ].join('\n');
    const only = [kundeCcc, ccc];
    expect(contestedUsePaths([reading(text)], only)).toEqual(['bronze/tables/bqs/addresse.dbml']);
    // Nobody knows whether the file exists (a host with no way to tell): lenient, as 2.0 drew it.
    expect(linksOf(attachRelationships([reading(text)], dbmlTableLookup(only)))).toEqual(['ccc.kunde.addresse_id>ccc.addresse.id']);
    // The file is gone: the stale qualifier still lands on the one addresse.
    expect(linksOf(attachRelationships([reading(text)], dbmlTableLookup(only, { exists: () => false })))).toEqual(['ccc.kunde.addresse_id>ccc.addresse.id']);
    // The file exists: the end is that table, which is not here; it is spelled so it can never be drawn on ccc's.
    const elsewhere = attachRelationships([reading(text)], dbmlTableLookup(only, { exists: (p) => p === 'bronze/tables/bqs/addresse.dbml' }));
    expect(linksOf(elsewhere)).toEqual(['ccc.kunde.addresse_id>bqs.addresse.id']);
    // With no use line for the end there is nothing to contest.
    expect(contestedUsePaths([reading('Ref: ccc.kunde.addresse_id > bqs.addresse.id\n')], only)).toEqual([]);
  });

  it('(d\') with no use line for the end, a reader that sees only some of the library (tableDirs) asks whether another table has the name', () => {
    const text = "use { table ccc.kunde } from '../tables/ccc/kunde.dbml'\nRef: ccc.kunde.addresse_id > zzz.addresse.id\n";
    const only = [kundeCcc, ccc];
    const tableDirs = ['bronze/tables/bqs', 'bronze/tables/ccc'];
    // Its name in each folder the scope's files name, and in the qualifier's own.
    expect(contestedUsePaths([reading(text)], only, { tableDirs })).toEqual(['bronze/tables/bqs/addresse.dbml', 'bronze/tables/zzz/addresse.dbml']);
    // Neither exists: one table has the name, and the stale qualifier still lands on it (rule 4).
    expect(linksOf(attachRelationships([reading(text)], dbmlTableLookup(only, { tableDirs, exists: () => false })))).toEqual(['ccc.kunde.addresse_id>ccc.addresse.id']);
    // bqs has an addresse too: zzz names neither, so nothing says this one is meant.
    const shared = attachRelationships([reading(text)], dbmlTableLookup(only, { tableDirs, exists: (p) => p === 'bronze/tables/bqs/addresse.dbml' }));
    expect(linksOf(shared)).toEqual(['ccc.kunde.addresse_id>zzz.addresse.id']);
    // A lookup over the whole library (no tableDirs: the host's) is as it was.
    expect(contestedUsePaths([reading(text)], only)).toEqual([]);
    expect(linksOf(attachRelationships([reading(text)], dbmlTableLookup(only, { exists: () => true })))).toEqual(['ccc.kunde.addresse_id>ccc.addresse.id']);
  });

  it('(e) several tables and nothing decides: not attached, reported, never the first', () => {
    const text = 'Ref: ccc.kunde.addresse_id > addresse.id\nRef: kunde.addresse_id > ccc.addresse.id\n';
    const result = attachRelationships([reading(text)], dbmlTableLookup(all));
    // The first Ref's owner resolved; its other end names both addresse tables: kept dangling, as written.
    expect(linksOf(result)).toEqual(['ccc.kunde.addresse_id>addresse.id']);
    expect(result.orphaned.map((o) => o.owner)).toEqual(['kunde']);
    expect(result.warnings.filter((w) => w.includes('more than one schema folder'))).toHaveLength(2);
    expect(result.warnings[0]).toContain('(bqs, ccc)');
  });

  it('(e) an unqualified end whose file imports its name from two schema folders is reported with both, also where only one is in scope', () => {
    const text = [
      "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
      "use { table ccc.addresse } from '../tables/ccc/addresse.dbml'",
      'Ref: ccc.kunde.addresse_id > addresse.id', '',
    ].join('\n');
    const result = attachRelationships([reading(text)], dbmlTableLookup([kundeCcc, ccc]), { partial: true });
    expect(result.warnings.filter((w) => w.includes('more than one schema folder'))).toEqual([expect.stringContaining('(bqs, ccc)')]);
    expect(result.unresolved).toEqual([expect.objectContaining({ kind: 'ambiguous', table: 'addresse', schemas: ['bqs', 'ccc'] })]);
  });

  it('(d) an unqualified end the file says is another schema folder\'s table (its own use line, or its use lines only from there) is contested, never drawn on a namesake whose file exists elsewhere', () => {
    const own = [
      "use { table addresse } from '../tables/bqs/addresse.dbml'",
      'Ref: ccc.kunde.addresse_id > addresse.id', '',
    ].join('\n');
    const onlyFrom = [
      "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
      'Ref: ccc.kunde.addresse_id > addresse.id', '',
    ].join('\n');
    const only = [kundeCcc, ccc];
    const exists = (p: string): boolean => p === 'bronze/tables/bqs/addresse.dbml';
    for (const text of [own, onlyFrom]) {
      expect(contestedUsePaths([reading(text)], only)).toEqual(['bronze/tables/bqs/addresse.dbml']);
      expect(linksOf(attachRelationships([reading(text)], dbmlTableLookup(only, { exists })))).toEqual(['ccc.kunde.addresse_id>addresse.id']);
      // The file is gone (the table moved): the end still lands on the one addresse, as it always did.
      expect(linksOf(attachRelationships([reading(text)], dbmlTableLookup(only, { exists: () => false })))).toEqual(['ccc.kunde.addresse_id>ccc.addresse.id']);
    }
    // A use line naming the same table in another layer (one identity) contests nothing.
    expect(contestedUsePaths([reading("use { table addresse } from '../../silver/tables/ccc/addresse.dbml'\nRef: ccc.kunde.addresse_id > addresse.id\n")], only)).toEqual([]);
  });

  it('(e) an unqualified end with several tables goes to the one in tables/public/, where unqualified tables live', () => {
    const pub = tableAt('bronze/tables/public/addresse.dbml', undefined);
    const text = 'Ref: kunde.addresse_id > addresse.id\n';
    const result = attachRelationships([reading(text)], dbmlTableLookup([kundeCcc, pub, ccc]));
    expect(linksOf(result)).toEqual(['ccc.kunde.addresse_id>addresse.id']);
    expect(result.locations!.size).toBe(1);
    expect([...result.locations!.values()][0].targetPath).toBe('bronze/tables/public/addresse.dbml');
  });

  it('one link per pair of tables: the same columns in two schemas are two links, never "stored twice"', () => {
    const text = [
      'Ref: bqs.kunde.addresse_id >? bqs.addresse.id',
      'Ref: ccc.kunde.addresse_id >? ccc.addresse.id',
      'Ref: ccc.addresse.id >? bqs.addresse.id', '',
    ].join('\n');
    const result = attachRelationships([reading(text)], dbmlTableLookup(all));
    expect(linksOf(result).sort()).toEqual([
      'bqs.kunde.addresse_id>bqs.addresse.id', 'ccc.addresse.id>bqs.addresse.id', 'ccc.kunde.addresse_id>ccc.addresse.id',
    ]);
    expect(result.duplicates).toEqual([]);
  });

  it('a bare one-to-one turned round by its keys swaps what each end says too', () => {
    // Read with the second end (ccc.kunde) as the foreign key; ccc.addresse.id alone is its whole key, so it is turned round.
    const text = 'Ref: ccc.kunde.addresse_id - ccc.addresse.id\n';
    const result = attachRelationships([reading(text)], dbmlTableLookup(all));
    expect(linksOf(result)).toEqual(['ccc.kunde.addresse_id>ccc.addresse.id']);
  });

  it('two qualifiers that land on one table (a stale one) join a column set to itself: not drawn, as 2.0.2 dropped it', () => {
    // The reader keeps the Ref (its qualifiers differ); the one addresse has no twin here, so both ends are it.
    const text = 'Ref: crm.addresse.id > ccc.addresse.id\nRef: ccc.addresse.id >? bqs.addresse.id\n';
    const alone = attachRelationships([reading(text)], dbmlTableLookup([ccc]));
    expect(linksOf(alone)).toEqual([]);
    expect(alone.warnings.filter((w) => w.includes('joins a column set to itself'))).toHaveLength(2);
    // A host that matches by name alone (no schema folders) drops it the same way.
    const byName: DbmlAttachTable = { table: ccc.table, storage: 'dbml' };
    expect(linksOf(attachRelationships([reading(text)], dbmlTableLookup([byName])))).toEqual([]);
    // With both twins the second Ref joins two tables and is drawn; the first still lands on ccc alone.
    const twins = attachRelationships([reading(text)], dbmlTableLookup(all));
    expect(linksOf(twins)).toEqual(['ccc.addresse.id>bqs.addresse.id']);
  });

  it('tables that carry no schema folder keep the rule from before identities: the first of the name', () => {
    const first: DbmlAttachTable = { table: { name: 'dim', columns: [], schema: 'b' }, storage: 'dbml' };
    const second: DbmlAttachTable = { table: { name: 'dim', columns: [], schema: 'a' }, storage: 'dbml' };
    expect(dbmlTableLookup([first, second])('dim', { qualifier: 'a' })).toBe(first);
  });
});

describe('erdLayoutView: the two-step match', () => {
  const candidates = [
    { schema: 'bqs', name: 'addresse', ref: 'bqs.addresse' },
    { schema: 'ccc', name: 'addresse', ref: 'ccc.addresse' },
  ];
  const members = candidates.map((c) => c.ref);
  it('qualified lines claim their tables, whatever their order; a bare line takes only an unclaimed one', () => {
    const view = erdLayoutView({ positions: { addresse: { x: 1, y: 1 }, 'ccc.addresse': { x: 2, y: 2 } }, stickies: [] }, members, [], candidates);
    expect(view.positions).toEqual({ 'bqs.addresse': { x: 1, y: 1 }, 'ccc.addresse': { x: 2, y: 2 } });
    expect(view.sharedBare).toEqual(['bqs.addresse']);
  });
  it('without identities, every member is matched by its reference alone, as before', () => {
    const view = erdLayoutView({ positions: { Dim: { x: 1, y: 1 }, dim: { x: 2, y: 2 }, stray: { x: 3, y: 3 } }, stickies: [] }, ['dim'], []);
    expect(view.positions).toEqual({ Dim: { x: 1, y: 1 }, dim: { x: 2, y: 2 }, stray: { x: 3, y: 3 } });
  });
});

describe('dbmlTableFinder with what the stale line said', () => {
  const find = dbmlTableFinder([
    'bronze/tables/bqs/addresse.dbml',
    'silver/tables/bqs/addresse.dbml',
    'bronze/tables/ccc/addresse.dbml',
    'gold/tables/finance/dim_region.dbml',
  ]);
  it('answers the hinted schema\'s file, the hinted layer\'s first', () => {
    expect(find('addresse', { schema: 'CCC' })).toBe('bronze/tables/ccc/addresse.dbml');
    expect(find('addresse', { schema: 'bqs', layer: 'silver' })).toBe('silver/tables/bqs/addresse.dbml');
    expect(find('addresse', { schema: 'bqs', layer: 'gold' })).toBe('bronze/tables/bqs/addresse.dbml');
  });
  it('answers another schema\'s file only when it is the one table of the name', () => {
    expect(find('addresse', { schema: 'ddd' })).toBeNull();
    expect(find('dim_region', { schema: 'crm', stalePath: 'silver/tables/crm/dim_region.dbml' })).toBe('gold/tables/finance/dim_region.dbml');
  });
  it('without a hint, answers as before: the index order', () => {
    expect(find('addresse')).toBe('bronze/tables/bqs/addresse.dbml');
  });
});

describe('key evidence looks dbt up by the table\'s own name', () => {
  it('a table the diagram calls ccc.addresse is addresse to dbt', () => {
    const dbt = buildDbtKeyIndex([{ uniqueColumns: [['addresse', ['id']]] }]);
    expect(keyEvidenceOf({ name: 'ccc.addresse', tableName: 'addresse', columns: [{ name: 'id' }] }, ['id'], dbt)).toBe('whole-key');
    expect(keyEvidenceOf({ name: 'ccc.addresse', columns: [{ name: 'id' }] }, ['id'], dbt)).toBe('unknown');
  });
});
