/**
 * The host library keyed by table identity (stage 5 of schema-scoped table
 * identity), over the twin fixture (`test/fixtures/same-name-two-schemas`:
 * `bronze/tables/{bqs,ccc}/{addresse,kunde}.dbml` and one relationships file
 * with a Ref per schema and one between the two `addresse` tables).
 *
 * Under the internal option `schemaScopedNames` the two schema folders' tables
 * are four tables: each listed, read from its own file and given the Refs
 * that resolve to it (by the relationships file's own `use` line, then the
 * qualifier), whether the whole library is attached or only a diagram's
 * tables; addressed by a TableId everywhere; a bare name two of them share
 * still reads the first file in index order, and every write entry refuses
 * it (D-5). Without the option the fixture reads exactly as every released
 * version reads it: the second schema folder's tables are duplicates.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as dbml from '@erd-studio/core/dbml';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { AmbiguousTableName } from '../../src/services/ambiguousTableName';
import { tableHomesById, tableHomesOf } from '../../src/services/tableHomes';
import { diagramMemberIds, diagramSummaryOf } from '../../src/services/dbmlDiagramSummaries';
import { DiagramMembers } from '../../src/services/diagramMembers';
import { clearDbmlDiagramReadings, primeLayoutOnlyReading, readDbmlDiagram } from '../../src/services/dbmlDiagramReadings';
import { relationshipsImportsFor } from '../../src/services/dbmlRelationshipsIndex';
import { healthLinkKey, surveyLibrary } from '../../src/services/relationshipHealth';
import { linkKey } from '@erd-studio/core';

const FIXTURE = path.resolve(__dirname, '../fixtures/same-name-two-schemas/.erd-studio');

let root: string;
let semantic: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-same-name-library-'));
  semantic = path.join(root, '.erd-studio');
  fs.cpSync(FIXTURE, semantic, { recursive: true });
  clearDbmlDiagramReadings();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const scoped = (): TableLibraryService => new TableLibraryService(root, '.erd-studio', undefined, { schemaScopedNames: true });
const byName = (): TableLibraryService => new TableLibraryService(root, '.erd-studio');
const rel = (filePath: string): string => path.relative(semantic, filePath).split(path.sep).join('/');
const write = (relPath: string, text: string): void => {
  const file = path.join(semantic, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const BQS_ADDRESSE = { schema: 'bqs', name: 'addresse' };
const CCC_ADDRESSE = { schema: 'ccc', name: 'addresse' };
const BQS_KUNDE = { schema: 'bqs', name: 'kunde' };
const CCC_KUNDE = { schema: 'ccc', name: 'kunde' };

/** Every file's bytes under the semantic dir, by relative path. */
function snapshotFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else out[rel(p)] = fs.readFileSync(p, 'utf-8');
    }
  };
  walk(semantic);
  return out;
}

/** A relationship's ends and columns, for comparison. */
const ends = (rels: ReadonlyArray<{ fromColumn: string; toModel: string; toColumn: string }> | undefined): string[] =>
  (rels ?? []).map((r) => `${r.fromColumn} > ${r.toModel}.${r.toColumn}`);

describe('without the option, the twin fixture reads as every released version reads it', () => {
  it('the second schema folder\'s tables are duplicates, and a name reads the first file', () => {
    const lib = byName();
    expect(lib.listTableFiles().map((e) => [rel(e.filePath), e.shadowedBy ? rel(e.shadowedBy) : null])).toEqual([
      ['bronze/tables/bqs/addresse.dbml', null],
      ['bronze/tables/bqs/kunde.dbml', null],
      ['bronze/tables/ccc/addresse.dbml', 'bronze/tables/bqs/addresse.dbml'],
      ['bronze/tables/ccc/kunde.dbml', 'bronze/tables/bqs/kunde.dbml'],
    ]);
    expect(lib.getTable('addresse')?.columns.map((c) => c.name)).toEqual(['id', 'strasse', 'ort']);
    expect(lib.isAmbiguousName('addresse')).toBe(false);
    expect(lib.libraryRef(BQS_ADDRESSE)).toBe('addresse');
    expect(lib.dbmlSnapshot().schemaScopedNames).toBeUndefined();
    expect([...lib.dbmlSnapshot().tables.keys()]).toEqual(['addresse', 'kunde']);
    expect(lib.relationshipsIndex().identities).toBe(false);
  });
});

describe('with schemaScopedNames, two tables of one name in two schema folders are two tables', () => {
  it('lists all four, each with its identity and library reference', () => {
    const lib = scoped();
    expect(lib.listTableFiles().map((e) => [rel(e.filePath), e.shadowedBy ?? null, e.id])).toEqual([
      ['bronze/tables/bqs/addresse.dbml', null, BQS_ADDRESSE],
      ['bronze/tables/bqs/kunde.dbml', null, BQS_KUNDE],
      ['bronze/tables/ccc/addresse.dbml', null, CCC_ADDRESSE],
      ['bronze/tables/ccc/kunde.dbml', null, CCC_KUNDE],
    ]);
    expect([BQS_ADDRESSE, CCC_ADDRESSE, BQS_KUNDE, CCC_KUNDE].map((id) => lib.libraryRef(id))).toEqual(['bqs.addresse', 'ccc.addresse', 'bqs.kunde', 'ccc.kunde']);
    expect(lib.tableIdOf('addresse')).toEqual(BQS_ADDRESSE);
    expect(lib.tableIdOf(CCC_ADDRESSE)).toEqual(CCC_ADDRESSE);
  });

  it('reads each from its own file, with the Refs that resolve to it', () => {
    const lib = scoped();
    expect(lib.getTable(BQS_ADDRESSE)?.columns.map((c) => c.name)).toEqual(['id', 'strasse', 'ort']);
    expect(lib.getTable(CCC_ADDRESSE)?.columns.map((c) => c.name)).toEqual(['id', 'street', 'city', 'postcode']);
    expect(ends(lib.getTable(BQS_KUNDE)?.relationships)).toEqual(['addresse_id > bqs.addresse.id']);
    expect(ends(lib.getTable(CCC_KUNDE)?.relationships)).toEqual(['addresse_id > ccc.addresse.id']);
    // `ccc.addresse.id >? bqs.addresse.id` joins two tables: it is no self-join.
    expect(ends(lib.getTable(CCC_ADDRESSE)?.relationships)).toEqual(['id > bqs.addresse.id']);
    expect(lib.getTable(BQS_ADDRESSE)?.relationships ?? []).toEqual([]);
    // A table read by its file gets the same.
    expect(ends(lib.getTableAt(path.join(semantic, 'bronze/tables/ccc/kunde.dbml'), 'kunde')?.relationships)).toEqual(['addresse_id > ccc.addresse.id']);
  });

  it('a bare name two tables share reads the first file in index order, with that file\'s own Refs', () => {
    const lib = scoped();
    expect(lib.isAmbiguousName('addresse')).toBe(true);
    expect(lib.getTable('addresse')?.columns.map((c) => c.name)).toEqual(['id', 'strasse', 'ort']);
    expect(ends(lib.getTable('kunde')?.relationships)).toEqual(['addresse_id > bqs.addresse.id']);
    expect(rel(lib.findTableFile('kunde')!)).toBe('bronze/tables/bqs/kunde.dbml');
  });

  it('listTables reads all four with their own Refs, and a diagram\'s tables get what the whole library gives them', () => {
    const lib = scoped();
    const listed = lib.listTables();
    expect(listed.map((m) => `${m.schema}.${m.name}: ${ends(m.relationships).join(', ')}`)).toEqual([
      'bqs.addresse: ',
      'bqs.kunde: addresse_id > bqs.addresse.id',
      'ccc.addresse: id > bqs.addresse.id',
      'ccc.kunde: addresse_id > ccc.addresse.id',
    ]);
    const whole = Object.fromEntries([BQS_ADDRESSE, CCC_ADDRESSE, BQS_KUNDE, CCC_KUNDE].map((id) => [`${id.schema}.${id.name}`, scoped().getTable(id)?.relationships ?? null]));
    for (const members of [['addresse'], ['kunde'], ['addresse', 'kunde']]) {
      const fresh = scoped();
      const read = fresh.readingTables(members, () => Object.fromEntries([BQS_ADDRESSE, CCC_ADDRESSE, BQS_KUNDE, CCC_KUNDE]
        .filter((id) => members.includes(id.name))
        .map((id) => [`${id.schema}.${id.name}`, fresh.getTable(id)?.relationships ?? null])));
      expect(read, members.join(',')).toEqual(Object.fromEntries(Object.entries(whole).filter(([k]) => members.includes(k.split('.')[1]))));
    }
  });

  it('a Ref end whose use line names a file is never attached to its namesake in another schema folder', () => {
    // ccc's Ref is written with stale bqs qualifiers but its own use lines name ccc's files.
    write('bronze/relationships/bronze.dbml', [
      "use { table bqs.addresse } from '../tables/ccc/addresse.dbml'",
      "use { table bqs.kunde } from '../tables/ccc/kunde.dbml'",
      'Ref: bqs.kunde.addresse_id > bqs.addresse.id',
      '',
    ].join('\n'));
    const lib = scoped();
    expect(ends(lib.getTable(CCC_KUNDE)?.relationships)).toEqual(['addresse_id > ccc.addresse.id']);
    expect(lib.getTable(BQS_KUNDE)?.relationships ?? []).toEqual([]);
  });

  it('every per-table API answers for a TableId\'s own file', () => {
    const lib = scoped();
    write('bronze/tables/ccc/addresse.dbml', 'Table ccc.addresse {\n  id INT [pk\n}\n');
    expect(lib.getTableFileError(CCC_ADDRESSE)?.filePath).toBe(path.join(semantic, 'bronze/tables/ccc/addresse.dbml'));
    expect(lib.getTableFileError(BQS_ADDRESSE)).toBeNull();
    expect(lib.peekTableFileError(CCC_ADDRESSE)).not.toBeNull();
    expect(lib.tableStorage(CCC_KUNDE)).toBe('dbml');
    expect(lib.tableStorage({ schema: 'ddd', name: 'kunde' })).toBeUndefined();
    expect(lib.tableFolder(CCC_KUNDE)).toBe('ccc');
    expect(lib.tableLibraryFile(CCC_KUNDE)).toBe('bronze/tables/ccc/kunde.dbml');
    expect(lib.dbmlTableProblems(BQS_KUNDE)?.filePath).toBe(path.join(semantic, 'bronze/tables/bqs/kunde.dbml'));
    expect(lib.dataTypeAliasColumns(CCC_KUNDE)).toEqual({ columns: [], ignored: [], anchored: [] });
    lib.getTable(CCC_KUNDE);
    expect(lib.peekTableSearchFacts(CCC_KUNDE)?.columns).toEqual(['id', 'full_name', 'addresse_id']);
    expect(lib.peekTableSummary(CCC_KUNDE)).toEqual({});
  });

  it('where a relationship is stored, and which files hold it, by library reference or TableId', () => {
    const lib = scoped();
    const ccc = { fromModel: CCC_KUNDE, fromColumn: 'addresse_id', toModel: CCC_ADDRESSE, toColumn: 'id' };
    expect(lib.relationshipLocation(ccc)).toEqual({ filePath: path.join(semantic, 'bronze/relationships/bronze.dbml'), line: 8 });
    expect(lib.relationshipLocation({ ...ccc, fromModel: 'ccc.kunde', toModel: 'ccc.addresse' })?.line).toBe(8);
    expect(lib.relationshipLocation({ ...ccc, fromModel: BQS_KUNDE, toModel: BQS_ADDRESSE })?.line).toBe(7);
    expect(lib.relationshipHolders(CCC_KUNDE, { fromColumn: 'addresse_id', toModel: CCC_ADDRESSE, toColumn: 'id' }))
      .toEqual([{ path: 'bronze/relationships/bronze.dbml', pending: false }]);
  });

  it('a diagram\'s files signature checks each member against its own file', () => {
    const lib = scoped();
    const ccc = path.join(semantic, 'bronze/tables/ccc/addresse.dbml');
    const before = lib.filesSignature([CCC_ADDRESSE, { filePath: ccc }]);
    const bqsBefore = lib.filesSignature([BQS_ADDRESSE]);
    fs.appendFileSync(ccc, '\n');
    fs.utimesSync(ccc, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    expect(lib.filesSignature([CCC_ADDRESSE, { filePath: ccc }])).not.toBe(before);
    expect(lib.filesSignature([BQS_ADDRESSE])).toBe(bqsBefore);
  });

  it('a watcher batch drops each changed file by its own path, not only the first file of its name', () => {
    const lib = scoped();
    lib.getTable(BQS_ADDRESSE);
    lib.getTable(CCC_ADDRESSE);
    const cached = (): string[] => [...(lib as unknown as { dbmlCache: Map<string, unknown> }).dbmlCache.keys()].map(rel).filter((p) => p.endsWith('/addresse.dbml')).sort();
    expect(cached()).toEqual(['bronze/tables/bqs/addresse.dbml', 'bronze/tables/ccc/addresse.dbml']);
    lib.invalidateTables(['addresse'], [path.join(semantic, 'bronze/tables/ccc/addresse.dbml')]);
    expect(cached()).toEqual([]);
  });

  it('the write snapshot lists every table under its library reference', () => {
    const snapshot = scoped().dbmlSnapshot();
    expect(snapshot.schemaScopedNames).toBe(true);
    expect([...snapshot.tables.entries()].map(([key, t]) => [key, t.path, t.ref])).toEqual([
      ['bqs.addresse', 'bronze/tables/bqs/addresse.dbml', 'bqs.addresse'],
      ['bqs.kunde', 'bronze/tables/bqs/kunde.dbml', 'bqs.kunde'],
      ['ccc.addresse', 'bronze/tables/ccc/addresse.dbml', 'ccc.addresse'],
      ['ccc.kunde', 'bronze/tables/ccc/kunde.dbml', 'ccc.kunde'],
    ]);
  });

  it('table homes: each identity has its own; a name two schema folders share names no one home', () => {
    write('bronze/tables/bqs/only_bqs.dbml', 'Table bqs.only_bqs {\n  id INT [pk]\n}\n');
    const entries = scoped().listTableFiles();
    expect([...tableHomesById(entries).entries()]).toEqual([
      ['bqs/addresse', { layer: 'bronze', schema: 'bqs' }],
      ['bqs/kunde', { layer: 'bronze', schema: 'bqs' }],
      ['bqs/only_bqs', { layer: 'bronze', schema: 'bqs' }],
      ['ccc/addresse', { layer: 'bronze', schema: 'ccc' }],
      ['ccc/kunde', { layer: 'bronze', schema: 'ccc' }],
    ]);
    expect([...tableHomesOf(entries).entries()]).toEqual([['only_bqs', { layer: 'bronze', schema: 'bqs' }]]);
    // Under the old rule every name has its one home, as before.
    expect([...tableHomesOf(byName().listTableFiles()).keys()]).toEqual(['addresse', 'kunde', 'only_bqs']);
  });

  it('a diagram\'s members with their identities (the Table Library\'s usage counts), by absolute path, cached', () => {
    const members = new DiagramMembers();
    const kunden = path.join(semantic, 'bronze/diagrams/kunden.dbml');
    expect(members.idsOf(kunden)).toEqual([
      { ref: 'bqs.addresse', id: { layer: 'bronze', ...BQS_ADDRESSE } },
      { ref: 'bqs.kunde', id: { layer: 'bronze', ...BQS_KUNDE } },
      { ref: 'ccc.addresse', id: { layer: 'bronze', ...CCC_ADDRESSE } },
      { ref: 'ccc.kunde', id: { layer: 'bronze', ...CCC_KUNDE } },
    ]);
    expect(members.idsOf(path.join(semantic, 'bronze/diagrams/ccc.dbml'))).toEqual([
      { ref: 'addresse', id: { layer: 'bronze', ...CCC_ADDRESSE } },
      { ref: 'kunde', id: { layer: 'bronze', ...CCC_KUNDE } },
    ]);
    expect(members.of(kunden)).toEqual(['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde']);
    // A JSON diagram names its members by name alone.
    write('bronze/old.json', JSON.stringify({ schemaVersion: 5, domain: 'old', layer: 'bronze', logical: { models: ['addresse'] } }));
    expect(members.idsOf(path.join(semantic, 'bronze/old.json'))).toEqual([{ ref: 'addresse' }]);
  });

  it('a diagram summary gives each member\'s identity from its use path', () => {
    const text = fs.readFileSync(path.join(semantic, 'bronze/diagrams/kunden.dbml'), 'utf-8');
    const summary = diagramSummaryOf('bronze/diagrams/kunden.dbml', text)!;
    expect(summary.members).toEqual(['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde']);
    expect(diagramMemberIds(summary)).toEqual([
      { layer: 'bronze', ...BQS_ADDRESSE }, { layer: 'bronze', ...BQS_KUNDE }, { layer: 'bronze', ...CCC_ADDRESSE }, { layer: 'bronze', ...CCC_KUNDE },
    ]);
  });
});

describe('the relationships index by identity', () => {
  /** Two stars, one per schema folder, of the same table names, each schema's Refs in its own relationships file. */
  function twoStars(): void {
    fs.rmSync(path.join(semantic, 'bronze/relationships/bronze.dbml'));
    for (const schema of ['bqs', 'ccc']) {
      write(`bronze/tables/${schema}/fct_sale.dbml`, `Table ${schema}.fct_sale {\n  id INT [pk]\n  kunde_id INT\n  addresse_id INT\n}\n`);
      write(`bronze/relationships/${schema}.dbml`, [
        `use { table ${schema}.fct_sale } from '../tables/${schema}/fct_sale.dbml'`,
        `use { table ${schema}.kunde } from '../tables/${schema}/kunde.dbml'`,
        `use { table ${schema}.addresse } from '../tables/${schema}/addresse.dbml'`,
        `Ref: ${schema}.fct_sale.kunde_id > ${schema}.kunde.id`,
        `Ref: ${schema}.fct_sale.addresse_id > ${schema}.addresse.id`,
        `Ref: ${schema}.kunde.addresse_id > ${schema}.addresse.id`,
        '',
      ].join('\n'));
    }
  }

  it('two stars in two schema folders are two sets of owners, each counted in its own file', () => {
    twoStars();
    const index = scoped().relationshipsIndex();
    expect(index.identities).toBe(true);
    expect(index.refs.map((r) => `${r.file}: ${r.ownerId} > ${r.targetId} (${r.owner} > ${r.target})`)).toEqual([
      'bronze/relationships/bqs.dbml: bqs/fct_sale > bqs/kunde (bqs.fct_sale > bqs.kunde)',
      'bronze/relationships/bqs.dbml: bqs/fct_sale > bqs/addresse (bqs.fct_sale > bqs.addresse)',
      'bronze/relationships/bqs.dbml: bqs/kunde > bqs/addresse (bqs.kunde > bqs.addresse)',
      'bronze/relationships/ccc.dbml: ccc/fct_sale > ccc/kunde (ccc.fct_sale > ccc.kunde)',
      'bronze/relationships/ccc.dbml: ccc/fct_sale > ccc/addresse (ccc.fct_sale > ccc.addresse)',
      'bronze/relationships/ccc.dbml: ccc/kunde > ccc/addresse (ccc.kunde > ccc.addresse)',
    ]);
    expect([...index.ownerCounts({ schema: 'ccc', name: 'fct_sale' })]).toEqual([['bronze/relationships/ccc.dbml', 2]]);
    expect([...index.ownerCounts({ schema: 'bqs', name: 'fct_sale' })]).toEqual([['bronze/relationships/bqs.dbml', 2]]);
    // By its library reference too.
    expect([...index.ownerCounts('ccc.kunde')]).toEqual([['bronze/relationships/ccc.dbml', 1]]);
    expect(index.filesHoldingPair(CCC_KUNDE, CCC_ADDRESSE)).toEqual(['bronze/relationships/ccc.dbml']);
    expect(index.filesHoldingPair(BQS_KUNDE, CCC_ADDRESSE)).toEqual([]);
    // A new Ref of ccc.kunde goes where ccc.kunde's Refs are (rule 1, by identity).
    const placed = scoped().newRelationshipPlacements([CCC_KUNDE, BQS_KUNDE]);
    expect(placed.get('ccc/kunde')?.file).toBe(path.join(semantic, 'bronze/relationships/ccc.dbml'));
    expect(placed.get('bqs/kunde')?.file).toBe(path.join(semantic, 'bronze/relationships/bqs.dbml'));
  });

  it('a ccc-only diagram imports no file that holds only bqs Refs', () => {
    twoStars();
    const index = scoped().relationshipsIndex();
    const ccc = [{ schema: 'ccc', name: 'fct_sale' }, CCC_KUNDE, CCC_ADDRESSE];
    expect(relationshipsImportsFor(ccc, index)).toEqual(['bronze/relationships/ccc.dbml']);
    expect(relationshipsImportsFor([BQS_KUNDE, BQS_ADDRESSE], index)).toEqual(['bronze/relationships/bqs.dbml']);
    // Named by bare names, as a caller not yet identity-aware does, nothing matches a twin's label.
    expect(relationshipsImportsFor(['fct_sale', 'kunde', 'addresse'], index)).toEqual([]);
    // Under the old rule the bqs tables win the names: a TableId is matched by its name, as a string is.
    const old = byName().relationshipsIndex();
    expect(old.identities).toBe(false);
    expect(relationshipsImportsFor(ccc, old)).toEqual(relationshipsImportsFor(['fct_sale', 'kunde', 'addresse'], old));
  });

  it('the Ref between the two addresse tables is indexed between them; a stale qualifier on one table is no Ref of it', () => {
    write('bronze/relationships/bronze.dbml', [
      "use { table bqs.kunde } from '../tables/bqs/kunde.dbml'",
      "use { table ccc.addresse } from '../tables/ccc/addresse.dbml'",
      "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
      'Ref: ccc.addresse.id >? bqs.addresse.id',
      // Written stale: bqs.kunde is the one kunde whose file the use line names on both ends.
      'Ref: bqs.kunde.id > xyz.kunde.id',
      '',
    ].join('\n'));
    fs.rmSync(path.join(semantic, 'bronze/tables/ccc/kunde.dbml'));
    const index = scoped().relationshipsIndex();
    expect(index.refs.map((r) => `${r.ownerId} > ${r.targetId}`)).toEqual(['ccc/addresse > bqs/addresse']);
  });
});

describe('relationship health needs no identity of its own: it keys links by the names it is given (D-15)', () => {
  it('named by library references, the two schema folders\' Refs are two links, none stored twice, none dangling', () => {
    const lib = scoped();
    // As the planner and the canvas name tables in the library: each model under its library reference.
    const models = [BQS_ADDRESSE, BQS_KUNDE, CCC_ADDRESSE, CCC_KUNDE].map((id) => ({ ...lib.getTable(id)!, name: lib.libraryRef(id)! }));
    const links = models.flatMap((m) => (m.relationships ?? []).map((r) => ({ fromModel: m.name, ...r })));
    expect(links.map((l) => healthLinkKey(l))).toEqual(links.map((l) => linkKey(l)));
    expect(new Set(links.map((l) => healthLinkKey(l))).size).toBe(3);
    const survey = surveyLibrary(models, []);
    expect(survey.storedTwice).toBe(0);
    expect(survey.danglingModel).toBe(0);
    expect(survey.danglingColumn).toBe(0);
  });
});

describe('the fail-closed guard: every library write entry refuses a bare name two schema folders share (D-5)', () => {
  it('planTableWrites, saveTable, renameTable, deleteTable and the delete cascade refuse, and write nothing', () => {
    const lib = scoped();
    const before = snapshotFiles();
    const model = { ...lib.getTable(BQS_ADDRESSE)!, description: 'changed' };
    expect(() => lib.planTableWrites({ delete: ['addresse'] })).toThrow(AmbiguousTableName);
    expect(() => lib.planTableWrites({ save: [{ model }] })).toThrow(AmbiguousTableName);
    expect(() => lib.planTableWrites({ save: [{ model: { ...model, name: 'adr' }, fromName: 'Addresse' }] })).toThrow(AmbiguousTableName);
    expect(() => lib.saveTable(model)).toThrow(AmbiguousTableName);
    expect(() => lib.renameTable('addresse', 'adr')).toThrow(AmbiguousTableName);
    expect(() => lib.deleteTable('addresse')).toThrow(AmbiguousTableName);
    expect(() => lib.dbmlDeleteCascadeOps(['kunde'])).toThrow(AmbiguousTableName);
    expect(snapshotFiles()).toEqual(before);
  });

  it('a name one table has is never refused, and nothing is refused without the option', () => {
    write('bronze/tables/bqs/only_bqs.dbml', 'Table bqs.only_bqs {\n  id INT [pk]\n}\n');
    const lib = scoped();
    expect(() => lib.planTableWrites({ save: [{ model: { ...lib.getTable('only_bqs')!, description: 'x' } }] })).not.toThrow();
    const old = byName();
    expect(() => old.planTableWrites({ save: [{ model: { ...old.getTable('addresse')!, description: 'x' } }] })).not.toThrow();
  });
});

describe('a drag\'s remembered reading equals a fresh read of what it wrote, on twin diagrams', () => {
  // A 2.0.2 diagram holding both tables (kunden-bare, at '7') is lifted to '8' by its first drag: not layout-only, so not remembered.
  for (const [diagram, remembered] of [['kunden', true], ['kunden-bare', false], ['ccc', true]] as const) {
    it(`${diagram}.dbml (${remembered ? 'remembered: the next read compiles nothing' : 'read afresh'})`, () => {
      const filePath = path.join(semantic, `bronze/diagrams/${diagram}.dbml`);
      const text = fs.readFileSync(filePath, 'utf-8');
      const before = readDbmlDiagram(text, filePath);
      const after = structuredClone(before.obj) as { viewConfig: { positions: Record<string, { x: number; y: number }>; annotations?: never[] }; logical: { models: string[] } };
      // The canvas holds a position for every member (auto-placed ones too); one is dragged.
      after.logical.models.forEach((m, i) => { after.viewConfig.positions[m] ??= { x: 1000 + i, y: 1000 }; });
      after.viewConfig.positions[after.logical.models[0]] = { x: 7, y: 8 };
      const written = dbml.editDiagramLayoutDbml(text, { filePath: `bronze/diagrams/${diagram}.dbml`, positions: after.viewConfig.positions, annotations: after.viewConfig.annotations ?? [] });
      primeLayoutOnlyReading(text, written, filePath, after);
      const compiles = vi.spyOn(dbml, 'parseSubjectAreaDbml');
      const read = readDbmlDiagram(written, filePath);
      expect(compiles).toHaveBeenCalledTimes(remembered ? 0 : 1);
      compiles.mockRestore();
      expect(read).toEqual(dbml.parseSubjectAreaDbml(written, filePath));
    });
  }
});
