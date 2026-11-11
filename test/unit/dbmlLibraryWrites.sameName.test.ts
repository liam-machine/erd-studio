/**
 * The write planner and its cascades by table identity (stage 6 of
 * schema-scoped table identity), over the twin fixture
 * (`packages/core/test/fixtures/dbml/same-name-two-schemas`: `bronze/tables/{bqs,ccc}/{addresse,kunde}.dbml`,
 * one relationships file with a Ref per schema and one between the two
 * `addresse` tables, and the diagrams ccc.dbml (ccc only), kunden.dbml (all
 * four) and kunden-bare.dbml (the same, as 2.0.2 left it)).
 *
 * Under the internal option `schemaScopedNames`: a new `addresse` in ccc is
 * created beside bqs's and edits nothing (D-4); a rename, move or delete of
 * one twin leaves the other's file, Refs, `use` lines and diagrams as they
 * were; an op naming a shared name alone is refused (D-5); a create, rename
 * or move onto an identity another layer or a YAML table already has is
 * refused, naming the other file (D-7); a YAML table's relationship to a
 * shared name is refused (D-9). Without the option nothing changes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TableLibraryService } from '../../src/services/logicalModelService';
import { AmbiguousTableName } from '../../src/services/ambiguousTableName';
import { planDbmlLibraryWrites } from '../../src/services/dbmlLibraryWrites';
import { clearDiagramSummaries } from '../../src/services/dbmlDiagramSummaries';
import { planDbmlDuplicateRename, planDbmlExplorerMoves, planDbmlTableMoves } from '../../src/commands/dbmlLifecycle';
import { writeFilesWithRollback } from '../../src/services/fsFileWrites';
import type { FileWrite } from '../../src/services/fileWrites';
import { planDbmlConversion } from '../../src/services/dbmlConversion';
import { readDbmlConversionInput } from '../../src/services/dbmlConversionFiles';
import { moveRelationshipsToLibrary } from '../../src/commands/moveRelationshipsToLibrary';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import * as vscode from 'vscode';
import { vi } from 'vitest';

const FIXTURE = path.resolve(__dirname, '../../packages/core/test/fixtures/dbml/same-name-two-schemas/.erd-studio');

let root: string;
let semantic: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-same-name-writes-'));
  semantic = path.join(root, '.erd-studio');
  fs.cpSync(FIXTURE, semantic, { recursive: true });
  clearDiagramSummaries();
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
const read = (relPath: string): string => fs.readFileSync(path.join(semantic, relPath), 'utf-8');
const remove = (relPath: string): void => fs.rmSync(path.join(semantic, relPath));

const BQS_ADDRESSE = { schema: 'bqs', name: 'addresse' };
const CCC_ADDRESSE = { schema: 'ccc', name: 'addresse' };
const BQS_KUNDE = { schema: 'bqs', name: 'kunde' };

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

/** The files that differ between two snapshots: changed, created ('+') or deleted ('-'). */
function changedFiles(before: Record<string, string>, after: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [p, text] of Object.entries(after)) if (before[p] === undefined) out.push(`+${p}`); else if (before[p] !== text) out.push(p);
  for (const p of Object.keys(before)) if (after[p] === undefined) out.push(`-${p}`);
  return out.sort();
}

/** Apply a plan's writes to disk, as the commands do. */
const applyWritesToDisk = (writes: readonly FileWrite[]): void => {
  writeFilesWithRollback(writes, { semanticRoot: semantic, exclusiveCreate: false });
};

/** A diagram that shows only bqs's tables: what "the other twin's diagrams" means below. */
const BQS_DIAGRAM = [
  'Project bqs {',
  "  erd_schema_version: '7'",
  "  erd_layout: '''",
  '    addresse 10 20',
  '    kunde 300 20',
  "  '''",
  '}',
  '',
  "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
  "use { table bqs.kunde }    from '../tables/bqs/kunde.dbml'",
  "use * from '../relationships/bronze.dbml'",
  '',
].join('\n');

/** The files of bqs's tables and diagram, and bqs's own Ref line: what an edit of a ccc table must leave as it was. */
function bqsSide(files: Record<string, string>): Record<string, string | undefined> {
  return {
    'bqs/addresse': files['bronze/tables/bqs/addresse.dbml'],
    'bqs/kunde': files['bronze/tables/bqs/kunde.dbml'],
    'bqs diagram': files['bronze/diagrams/bqs.dbml'],
    'bqs Ref': (files['bronze/relationships/bronze.dbml'] ?? '').split('\n').filter((l) => l.startsWith('Ref: bqs.')).join('\n'),
  };
}

describe('D-4: a new table is told from an edit by a flag, never by a name another schema folder has', () => {
  beforeEach(() => {
    // Only bqs has addresse: ccc's addresse, its Refs and the diagrams naming it are gone.
    for (const f of ['bronze/tables/ccc/addresse.dbml', 'bronze/diagrams/kunden.dbml', 'bronze/diagrams/kunden-bare.dbml', 'bronze/diagrams/ccc.dbml']) remove(f);
    write('bronze/relationships/bronze.dbml', [
      "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
      "use { table bqs.kunde }    from '../tables/bqs/kunde.dbml'",
      '',
      'Ref: bqs.kunde.addresse_id >? bqs.addresse.id',
      '',
    ].join('\n'));
    write('bronze/diagrams/bqs.dbml', BQS_DIAGRAM);
  });
  const NEW_ADDRESSE = { name: 'addresse', schema: 'ccc', description: '', columns: [] };

  it('a save naming addresse with a home in ccc and no flag is refused, never an edit of bqs/addresse.dbml (the bug, reproduced)', () => {
    for (const lib of [scoped(), byName()]) {
      const before = snapshotFiles();
      expect(() => lib.applyDbmlBatch({ ops: { save: [{ model: NEW_ADDRESSE, home: { layer: 'bronze', schema: 'ccc' } }] } }))
        .toThrow(/bronze\/tables\/bqs\/addresse\.dbml already holds the table addresse, which is not in bronze\/tables\/ccc\//);
      expect(snapshotFiles()).toEqual(before);
    }
  });

  it('New Table addresse in ccc while only bqs.addresse exists creates ccc/addresse.dbml and changes nothing else', () => {
    const before = snapshotFiles();
    const { plan } = scoped().applyDbmlBatch({ ops: { save: [{ model: NEW_ADDRESSE, home: { layer: 'bronze', schema: 'ccc' }, create: true }] } });
    const after = snapshotFiles();
    expect(changedFiles(before, after)).toEqual(['+bronze/tables/ccc/addresse.dbml']);
    expect(after['bronze/tables/ccc/addresse.dbml']).toMatch(/^Table ccc\.addresse \{/);
    expect(plan.createdTables).toEqual(['addresse']);
    expect(plan.createdTablePaths).toEqual(['bronze/tables/ccc/addresse.dbml']);
    expect(scoped().tablesNamed('addresse').map((e) => rel(e.filePath))).toEqual(['bronze/tables/bqs/addresse.dbml', 'bronze/tables/ccc/addresse.dbml']);
  });

  it('without the option a create of a name the library has is refused, naming the file that has it (the old rule)', () => {
    const before = snapshotFiles();
    expect(() => byName().applyDbmlBatch({ ops: { save: [{ model: NEW_ADDRESSE, home: { layer: 'bronze', schema: 'ccc' }, create: true }] } }))
      .toThrow(/bronze\/tables\/bqs\/addresse\.dbml already holds a table named addresse/);
    expect(snapshotFiles()).toEqual(before);
  });

  it('an ordinary edit of bqs.addresse from a diagram whose new-table home is another schema edits bqs/addresse.dbml and creates nothing', () => {
    const lib = scoped();
    const model = { ...lib.getTable(BQS_ADDRESSE)!, description: 'Edited' };
    const before = snapshotFiles();
    lib.applyDbmlBatch({ ops: { save: [{ model }], newTableHome: { layer: 'bronze', schema: 'ccc' } } });
    expect(changedFiles(before, snapshotFiles())).toEqual(['bronze/tables/bqs/addresse.dbml']);
  });
});

describe('an edit of one twin never touches the other: rename, move, delete (with the option)', () => {
  beforeEach(() => write('bronze/diagrams/bqs.dbml', BQS_DIAGRAM));

  it('rename ccc.addresse: only ccc ends and use lines are re-spelled; bqs files, bqs Refs and bqs-only diagrams are byte-identical', () => {
    const before = snapshotFiles();
    scoped().renameTable(CCC_ADDRESSE, 'adresse2');
    const after = snapshotFiles();
    expect(changedFiles(before, after)).toEqual([
      '+bronze/tables/ccc/adresse2.dbml', '-bronze/tables/ccc/addresse.dbml',
      'bronze/diagrams/ccc.dbml', 'bronze/diagrams/kunden-bare.dbml', 'bronze/diagrams/kunden.dbml', 'bronze/relationships/bronze.dbml',
    ]);
    expect(bqsSide(after)).toEqual(bqsSide(before));
    expect(after['bronze/relationships/bronze.dbml']).toContain('Ref: ccc.kunde.addresse_id >? ccc.adresse2.id');
    expect(after['bronze/relationships/bronze.dbml']).toContain('Ref: ccc.adresse2.id >? bqs.addresse.id');
    expect(after['bronze/diagrams/ccc.dbml']).toContain("use { table ccc.adresse2 } from '../tables/ccc/adresse2.dbml'");
    // The both-diagram: the renamed member keeps its place; bqs's addresse is the only addresse left there, so its line is bare.
    expect(after['bronze/diagrams/kunden.dbml']).toMatch(/\n {4}addresse 40 40\n {4}adresse2 40 360\n/);
  });

  it('move ccc.addresse to ddd: its declaration and ccc ends follow; bqs files, bqs Refs and bqs-only diagrams are byte-identical', () => {
    const before = snapshotFiles();
    scoped().applyDbmlBatch({ ops: { move: [{ name: 'addresse', table: CCC_ADDRESSE, toSchema: 'ddd' }] } });
    const after = snapshotFiles();
    expect(after['bronze/tables/ddd/addresse.dbml']).toMatch(/^Table ddd\.addresse \{\n {2}id INT \[pk\]\n {2}street/);
    expect(after['bronze/tables/ccc/addresse.dbml']).toBeUndefined();
    expect(bqsSide(after)).toEqual(bqsSide(before));
    expect(after['bronze/relationships/bronze.dbml']).toContain('Ref: ccc.kunde.addresse_id >? ddd.addresse.id');
    expect(after['bronze/diagrams/ccc.dbml']).toContain("use { table ddd.addresse } from '../tables/ddd/addresse.dbml'");
    expect(after['bronze/diagrams/kunden.dbml']).toMatch(/\n {4}ddd\.addresse 40 360\n/);
  });

  it('Move Table (by file) moves the table whose file it holds, and names it among the re-qualified', () => {
    const lib = scoped();
    const before = snapshotFiles();
    const planned = planDbmlTableMoves({
      tableLibraryService: lib,
      moves: [{ name: 'addresse', filePath: path.join(semantic, 'bronze/tables/ccc/addresse.dbml'), toLayer: 'bronze', toSchema: 'ddd' }],
      diagrams: lib.listDbmlDiagrams(),
      readText: (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null),
    });
    expect(planned.requalified).toEqual(['addresse']);
    applyWritesToDisk(planned.writes);
    const after = snapshotFiles();
    expect(after['bronze/tables/ddd/addresse.dbml']).toContain('street');
    expect(bqsSide(after)).toEqual(bqsSide(before));
    // By name alone (Organise or Move Table without a file), a shared name is refused.
    expect(() => planDbmlTableMoves({ tableLibraryService: scoped(), moves: [{ name: 'kunde', toLayer: 'bronze', toSchema: 'eee' }], diagrams: [], readText: () => null }))
      .toThrow(AmbiguousTableName);
  });

  it('delete ccc.addresse: only Refs owned by or pointing at it are cut; diagrams lose the member only where the use path is its file', () => {
    const before = snapshotFiles();
    scoped().deleteTable(CCC_ADDRESSE);
    const after = snapshotFiles();
    expect(after['bronze/tables/ccc/addresse.dbml']).toBeUndefined();
    expect(bqsSide(after)).toEqual(bqsSide(before));
    expect(after['bronze/relationships/bronze.dbml'].split('\n').filter((l) => l.startsWith('Ref:'))).toEqual(['Ref: bqs.kunde.addresse_id >? bqs.addresse.id']);
    // The ccc-only diagram loses its addresse: never repointed at bqs's file, though addresse is now a name only bqs has.
    expect(after['bronze/diagrams/ccc.dbml']).not.toContain('bqs/addresse.dbml');
    expect(after['bronze/diagrams/ccc.dbml']).not.toContain('ccc/addresse.dbml');
    expect(after['bronze/diagrams/kunden.dbml']).not.toContain('ccc/addresse.dbml');
    expect(after['bronze/diagrams/kunden.dbml']).toContain("use { table bqs.addresse } from '../tables/bqs/addresse.dbml'");
    // bqs's addresse is the only addresse left there, so its line is bare again; the kunde pair keeps the diagram at 8.
    expect(after['bronze/diagrams/kunden.dbml']).toMatch(/\n {4}addresse 40 40\n {4}bqs\.kunde 400 40\n/);
    expect(after['bronze/diagrams/kunden.dbml']).toContain("erd_schema_version: '8'");
  });

  it('delete one of the only pair on a diagram: the other\'s line goes back to bare and the diagram back to version 7', () => {
    write('bronze/diagrams/pair.dbml', [
      'Project pair {',
      "  erd_schema_version: '8'",
      "  erd_layout: '''",
      '    bqs.addresse 10 20',
      '    ccc.addresse 300 20',
      "  '''",
      '}',
      '',
      "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
      "use { table ccc.addresse } from '../tables/ccc/addresse.dbml'",
      "use * from '../relationships/bronze.dbml'",
      '',
    ].join('\n'));
    scoped().deleteTable(CCC_ADDRESSE);
    const pair = read('bronze/diagrams/pair.dbml');
    expect(pair).toContain("erd_schema_version: '7'");
    expect(pair).toMatch(/\n {4}addresse 10 20\n/);
    expect(pair).not.toContain('bqs.addresse 10 20');
    expect(pair).not.toContain('ccc/addresse.dbml');
  });

  it('deleting a table a twin points at saves that twin by its identity: the cascade succeeds and cuts only its Ref', () => {
    write('bronze/tables/bqs/x.dbml', 'Table bqs.x {\n  id INT [pk]\n}\n');
    write('bronze/tables/bqs/kunde.dbml', 'Table bqs.kunde {\n  id INT [pk]\n  name VARCHAR\n  addresse_id INT\n  x_id INT\n}\n');
    write('bronze/relationships/x.dbml', [
      "use { table bqs.kunde } from '../tables/bqs/kunde.dbml'",
      "use { table bqs.x } from '../tables/bqs/x.dbml'",
      'Ref: bqs.kunde.x_id > bqs.x.id',
      '',
    ].join('\n'));
    const lib = scoped();
    const cascade = lib.dbmlDeleteCascadeOps(['x']);
    expect(cascade.save.map(({ model, from }) => [model.name, from])).toEqual([['kunde', BQS_KUNDE]]);
    const before = snapshotFiles();
    lib.deleteTable('x');
    const after = snapshotFiles();
    expect(after['bronze/tables/bqs/x.dbml']).toBeUndefined();
    expect(after['bronze/relationships/x.dbml'] ?? '').not.toContain('Ref:');
    expect(after['bronze/relationships/bronze.dbml']).toBe(before['bronze/relationships/bronze.dbml']);
    expect(after['bronze/tables/ccc/kunde.dbml']).toBe(before['bronze/tables/ccc/kunde.dbml']);
  });
});

describe('D-5 in the planner itself: an op naming a shared name alone is refused; a diagram reference is never a table name', () => {
  it('a save, a rename, a delete, a move or a gained file by the bare name throws AmbiguousTableName; by identity it plans', () => {
    const lib = scoped();
    const snapshot = lib.dbmlSnapshot();
    const model = { ...lib.getTable(BQS_ADDRESSE)!, description: 'x' };
    for (const ops of [
      { save: [{ model }] },
      { save: [{ model: { ...model, name: 'adr' }, fromName: 'addresse' }] },
      { delete: ['addresse'] },
      { move: [{ name: 'addresse', toSchema: 'ddd' }] },
      { gainFile: ['kunde'] },
    ]) {
      expect(() => planDbmlLibraryWrites(snapshot, ops), JSON.stringify(Object.keys(ops))).toThrow(AmbiguousTableName);
    }
    expect(planDbmlLibraryWrites(snapshot, { save: [{ model, from: BQS_ADDRESSE }] }).writes.map((w) => w.path)).toEqual(['bronze/tables/bqs/addresse.dbml']);
    // A library reference names one table too.
    expect(planDbmlLibraryWrites(snapshot, { delete: ['ccc.addresse'] }).writes.map((w) => `${w.kind} ${w.path}`)).toContain('delete bronze/tables/ccc/addresse.dbml');
  });

  it('a model that carries a tableName (a diagram\'s <schema>.<name> reference) is refused', () => {
    const lib = scoped();
    const model = { ...lib.getTable(CCC_ADDRESSE)!, name: 'ccc.addresse', tableName: 'addresse' };
    expect(() => planDbmlLibraryWrites(lib.dbmlSnapshot(), { save: [{ model, from: CCC_ADDRESSE }] })).toThrow(/named as a diagram names it/);
  });

  it('without the option nothing about a by-name plan changes', () => {
    const lib = byName();
    const plan = planDbmlLibraryWrites(lib.dbmlSnapshot(), { save: [{ model: { ...lib.getTable('addresse')!, description: 'x' } }] });
    expect(plan.writes.map((w) => w.path)).toEqual(['bronze/tables/bqs/addresse.dbml']);
    expect(plan.identities).toBeUndefined();
  });
});

describe('D-7: a create, rename or move onto an identity another layer or folder already has is refused, naming that file', () => {
  const twoLayers = (): void => {
    write('layers.json', JSON.stringify({ schemaVersion: 1, layers: [{ id: 'bronze', label: 'Bronze', creatable: true, order: 1 }, { id: 'silver', label: 'Silver', creatable: true, order: 2 }] }));
    write('silver/tables/silver/s.dbml', 'Table silver.s {\n  id INT [pk]\n}\n');
  };

  it('New Table ccc.addresse in another layer', () => {
    twoLayers();
    const before = snapshotFiles();
    expect(() => scoped().applyDbmlBatch({ ops: { save: [{ model: { name: 'addresse', schema: 'ccc', description: '', columns: [] }, home: { layer: 'silver', schema: 'ccc' }, create: true }] } }))
      .toThrow('ccc.addresse already exists in layer bronze (bronze/tables/ccc/addresse.dbml); choose another name.');
    expect(snapshotFiles()).toEqual(before);
  });

  it('a rename onto a name its own schema folder has, in any case; the same name in another schema folder is free', () => {
    const lib = scoped();
    expect(() => lib.planDbmlBatch({ ops: { save: [{ model: { ...lib.getTable(BQS_KUNDE)!, name: 'Addresse' }, from: BQS_KUNDE }] } }))
      .toThrow('bqs.Addresse already exists in layer bronze (bronze/tables/bqs/addresse.dbml); choose another name.');
    write('bronze/tables/ddd/x.dbml', 'Table ddd.x {\n  id INT [pk]\n}\n');
    const again = scoped();
    expect(() => again.planDbmlBatch({ ops: { save: [{ model: { ...again.getTable({ schema: 'ddd', name: 'x' })!, name: 'addresse' }, from: { schema: 'ddd', name: 'x' } }] } })).not.toThrow();
  });

  it('a move into a schema folder whose name another layer holds there, or into the folder that holds it (any case)', () => {
    twoLayers();
    const before = snapshotFiles();
    expect(() => scoped().applyDbmlBatch({ ops: { move: [{ name: 'addresse', table: BQS_ADDRESSE, toLayer: 'silver', toSchema: 'ccc' }] } }))
      .toThrow('ccc.addresse already exists in layer bronze (bronze/tables/ccc/addresse.dbml); nothing was moved.');
    for (const toSchema of ['ccc', 'CCC']) {
      expect(() => scoped().applyDbmlBatch({ ops: { move: [{ name: 'addresse', table: BQS_ADDRESSE, toSchema }] } })).toThrow(/already exists; nothing was moved/);
    }
    expect(snapshotFiles()).toEqual(before);
  });
});

describe('D-9: a YAML table never stores a relationship to a name DBML tables in two schema folders share', () => {
  it('its save is refused with the Convert sentence, and nothing is written', () => {
    write('logical-models/bestellung.yml', 'name: bestellung\ndescription: ""\ncolumns:\n  - name: id\n    dataType: INT\n  - name: addresse_id\n    dataType: INT\n');
    const lib = scoped();
    const rel = { fromColumn: 'addresse_id', toModel: 'addresse', toColumn: 'id', cardinality: 'many-to-one' as const };
    const model = { ...lib.getTable('bestellung')!, relationships: [rel] };
    const before = snapshotFiles();
    expect(() => lib.planTableWrites({ save: [{ model }] })).toThrow(/more than one table is named addresse \(bqs\.addresse, ccc\.addresse\).*Convert the project to DBML first/);
    expect(() => lib.planTableWrites({ save: [{ model: { ...model, relationships: [{ ...rel, toModel: 'ccc.addresse' }] } }] })).toThrow(/Convert the project to DBML first/);
    expect(() => lib.saveTable(model)).toThrow(/Convert the project to DBML first/);
    expect(snapshotFiles()).toEqual(before);
    expect(() => byName().planTableWrites({ save: [{ model }] })).not.toThrow();
  });
});

describe('Explorer moves of a twin move that twin\'s own file (the suspected overwrite)', () => {
  /** Move a file on disk, as the Explorer does before VS Code tells ERD Studio. */
  const moveOnDisk = (from: string, to: string): { from: string; to: string } => {
    const a = path.join(semantic, from);
    const b = path.join(semantic, to);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
    return { from: a, to: b };
  };
  const readText = (f: string): string | null => (fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null);

  it('dragging bronze/tables/ccc/addresse.dbml to ddd/ keeps ccc\'s own text there, leaves bqs/addresse.dbml, and re-spells only ccc ends', () => {
    write('bronze/diagrams/bqs.dbml', BQS_DIAGRAM);
    const before = snapshotFiles();
    const move = moveOnDisk('bronze/tables/ccc/addresse.dbml', 'bronze/tables/ddd/addresse.dbml');
    const plan = planDbmlExplorerMoves({ semanticRoot: semantic, tableLibraryService: scoped(), moves: [move], readText });
    expect(plan.kind).toBe('update');
    if (plan.kind !== 'update') return;
    applyWritesToDisk(plan.writes);
    const after = snapshotFiles();
    expect(after['bronze/tables/ddd/addresse.dbml']).toMatch(/^Table ddd\.addresse \{\n {2}id INT \[pk\]\n {2}street VARCHAR/);
    expect(bqsSide(after)).toEqual(bqsSide(before));
    expect(after['bronze/relationships/bronze.dbml']).toContain('Ref: ccc.kunde.addresse_id >? ddd.addresse.id');
    expect(after['bronze/relationships/bronze.dbml']).toContain('Ref: ddd.addresse.id >? bqs.addresse.id');
  });

  it('renaming the schema folder bqs to src1 (every file in it moved) re-qualifies bqs\'s tables only', () => {
    const before = snapshotFiles();
    fs.renameSync(path.join(semantic, 'bronze/tables/bqs'), path.join(semantic, 'bronze/tables/src1'));
    const moves = ['addresse', 'kunde'].map((n) => ({ from: path.join(semantic, `bronze/tables/bqs/${n}.dbml`), to: path.join(semantic, `bronze/tables/src1/${n}.dbml`) }));
    const plan = planDbmlExplorerMoves({ semanticRoot: semantic, tableLibraryService: scoped(), moves, readText });
    expect(plan.kind).toBe('update');
    if (plan.kind !== 'update') return;
    applyWritesToDisk(plan.writes);
    const after = snapshotFiles();
    expect(after['bronze/tables/src1/addresse.dbml']).toMatch(/^Table src1\.addresse \{/);
    expect(after['bronze/tables/src1/kunde.dbml']).toMatch(/^Table src1\.kunde \{/);
    expect(after['bronze/relationships/bronze.dbml']).toContain('Ref: src1.kunde.addresse_id >? src1.addresse.id');
    expect(after['bronze/relationships/bronze.dbml']).toContain('Ref: ccc.kunde.addresse_id >? ccc.addresse.id');
    expect(after['bronze/diagrams/kunden.dbml']).toMatch(/\n {4}src1\.addresse 40 40\n/);
    for (const f of ['bronze/tables/ccc/addresse.dbml', 'bronze/tables/ccc/kunde.dbml', 'bronze/diagrams/ccc.dbml']) expect(after[f], f).toBe(before[f]);
  });

  it('renaming the schema folder bqs to src1 while another layer holds src1/addresse.dbml is refused as a batch, naming that file (D-7)', () => {
    write('layers.json', JSON.stringify({ schemaVersion: 1, layers: [{ id: 'bronze', label: 'Bronze', creatable: true, order: 1 }, { id: 'silver', label: 'Silver', creatable: true, order: 2 }] }));
    write('silver/tables/src1/addresse.dbml', 'Table src1.addresse {\n  id INT [pk]\n}\n');
    fs.renameSync(path.join(semantic, 'bronze/tables/bqs'), path.join(semantic, 'bronze/tables/src1'));
    const before = snapshotFiles();
    const moves = ['addresse', 'kunde'].map((n) => ({ from: path.join(semantic, `bronze/tables/bqs/${n}.dbml`), to: path.join(semantic, `bronze/tables/src1/${n}.dbml`) }));
    expect(() => planDbmlExplorerMoves({ semanticRoot: semantic, tableLibraryService: scoped(), moves, readText }))
      .toThrow('src1.addresse already exists in layer silver (silver/tables/src1/addresse.dbml); nothing was moved.');
    // The planner is pure: nothing but the user's own move happened.
    expect(snapshotFiles()).toEqual(before);
  });

  it('the same refusal when the moved file is the one listed later (its new place is behind the other layer\'s file)', () => {
    write('layers.json', JSON.stringify({ schemaVersion: 1, layers: [{ id: 'bronze', label: 'Bronze', creatable: true, order: 1 }, { id: 'silver', label: 'Silver', creatable: true, order: 2 }] }));
    write('silver/tables/sss/addresse.dbml', 'Table sss.addresse {\n  id INT [pk]\n}\n');
    const move = moveOnDisk('silver/tables/sss/addresse.dbml', 'silver/tables/ccc/addresse.dbml');
    expect(() => planDbmlExplorerMoves({ semanticRoot: semantic, tableLibraryService: scoped(), moves: [move], readText }))
      .toThrow('ccc.addresse already exists in layer bronze (bronze/tables/ccc/addresse.dbml); nothing was moved.');
  });

  it('renaming ccc/addresse.dbml to adr.dbml renames ccc\'s table only; a name only another schema folder has is not taken', () => {
    const move = moveOnDisk('bronze/tables/ccc/addresse.dbml', 'bronze/tables/ccc/adr.dbml');
    const plan = planDbmlExplorerMoves({ semanticRoot: semantic, tableLibraryService: scoped(), moves: [move], readText });
    expect(plan.kind).toBe('update');
    if (plan.kind !== 'update') return;
    applyWritesToDisk(plan.writes);
    expect(read('bronze/tables/ccc/adr.dbml')).toMatch(/^Table ccc\.adr \{/);
    expect(read('bronze/tables/bqs/addresse.dbml')).toMatch(/^Table bqs\.addresse \{/);
    expect(read('bronze/relationships/bronze.dbml')).toContain('Ref: ccc.kunde.addresse_id >? ccc.adr.id');
    expect(read('bronze/relationships/bronze.dbml')).toContain('Ref: bqs.kunde.addresse_id >? bqs.addresse.id');
    // ccc's kunde renamed to addresse: bqs has an addresse, ccc no longer does, so the name is free in ccc.
    const kunde = moveOnDisk('bronze/tables/ccc/kunde.dbml', 'bronze/tables/ccc/addresse.dbml');
    const next = planDbmlExplorerMoves({ semanticRoot: semantic, tableLibraryService: scoped(), moves: [kunde], readText });
    expect(next.kind).toBe('update');
  });
});

describe('the settle compares a diagram\'s members by the files they read (dbmlDiagramSettle)', () => {
  it('a diagram of the other twin that does not read no longer blocks an edit; one that uses the changed file still does', () => {
    // ccc.dbml shows only ccc's addresse, and has a syntax error.
    write('bronze/diagrams/ccc.dbml', `${read('bronze/diagrams/ccc.dbml')}\nTable broken {\n`);
    const before = snapshotFiles();
    scoped().renameTable(BQS_ADDRESSE, 'adr');
    const after = snapshotFiles();
    expect(after['bronze/diagrams/ccc.dbml']).toBe(before['bronze/diagrams/ccc.dbml']);
    expect(after['bronze/tables/bqs/adr.dbml']).toMatch(/^Table bqs\.adr \{/);
    // A diagram that reads ccc's addresse and does not read refuses a rename of ccc's addresse.
    expect(() => scoped().renameTable(CCC_ADDRESSE, 'adr2')).toThrow(/bronze\/diagrams\/ccc\.dbml does not read .*keep a use line to bronze\/tables\/ccc\/addresse\.dbml/);
  });
});

describe('D-5: Convert, Import and Move Relationships to Library refuse a shared name rather than pick one', () => {
  it('Convert: a YAML table whose relationship names addresse, which two DBML schema folders hold, is refused; nothing is planned', async () => {
    write('logical-models/bestellung.yml', [
      'name: bestellung', 'columns:', '  - name: id', '    dataType: INT', '  - name: addresse_id', '    dataType: INT',
      'relationships:', '  - fromColumn: addresse_id', '    toModel: addresse', '    toColumn: id', '    cardinality: many-to-one', '',
    ].join('\n'));
    const plan = await planDbmlConversion(readDbmlConversionInput(root, '.erd-studio'));
    expect(plan.refusals.join('\n')).toContain('More than one table is named addresse (bqs.addresse, ccc.addresse)');
    expect(plan.creates).toEqual([]);
  });

  it('Convert: a YAML table that names no shared name converts, and leaves both tables of one name, their Refs and diagrams as they are', async () => {
    write('logical-models/bestellung.yml', 'name: bestellung\ncolumns:\n  - name: id\n    dataType: INT\n');
    const plan = await planDbmlConversion(readDbmlConversionInput(root, '.erd-studio'));
    expect(plan.refusals).toEqual([]);
    expect(plan.creates.map((c) => c.path)).toContain('bronze/tables/public/bestellung.dbml');
    // Nothing of the twins' files, their relationships file or the diagrams that show them is written.
    const touched = [...plan.creates, ...plan.replaces].map((w) => w.path);
    expect(touched.filter((p) => !/^(bronze\/tables\/public\/bestellung\.dbml|README\.md)$/.test(p))).toEqual([]);
    expect(plan.deletes).toEqual(['logical-models/bestellung.yml']);
  });

  it('Import: a changed library table named by a shared name is refused; a new one marked as new is planned', () => {
    const lib = scoped();
    const changed = { ...lib.getTable(BQS_ADDRESSE)!, description: 'from the import' };
    // As Import plans it: new tables marked, changed library tables by name.
    expect(() => lib.planTableWrites({ save: [{ model: changed }] }, 'bronze', { dbml: true, schemaFromSource: true })).toThrow(AmbiguousTableName);
    const fresh = { name: 'addresse', schema: 'ddd', description: '', columns: [{ name: 'id', dataType: 'INT', description: '' }] };
    const planned = lib.planTableWrites({ save: [{ model: fresh, create: true }] }, 'bronze', { dbml: true, schemaFromSource: true });
    expect(planned.plan?.createdTablePaths).toEqual(['bronze/tables/ddd/addresse.dbml']);
  });

  it('Move Relationships to Library: a diagram relationship to a shared name stops the move with a message; nothing is written', async () => {
    write('logical-models/bestellung.yml', 'name: bestellung\ncolumns:\n  - name: id\n    dataType: INT\n  - name: addresse_id\n    dataType: INT\n');
    write('bronze/orders.json', `${JSON.stringify({
      schemaVersion: 5, domain: 'orders', layer: 'bronze', description: '',
      logical: { models: ['bestellung', 'addresse'], relationships: [{ fromModel: 'bestellung', fromColumn: 'addresse_id', toModel: 'addresse', toColumn: 'id', cardinality: 'many-to-one' }] },
      viewConfig: {},
    }, null, 2)}\n`);
    const errors = vi.spyOn(vscode.window, 'showErrorMessage');
    const before = snapshotFiles();
    await moveRelationshipsToLibrary({
      workspaceRoot: root, semanticDir: '.erd-studio', subjectAreaService: new SubjectAreaService(new LayerService(root, '.erd-studio')),
      tableLibraryService: scoped(), onWritten: vi.fn(async () => undefined),
    });
    expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/orders\.json has a relationship to addresse, and more than one table has that name \(bronze\/tables\/bqs\/addresse\.dbml, bronze\/tables\/ccc\/addresse\.dbml\)/);
    expect(snapshotFiles()).toEqual(before);
    errors.mockRestore();
  });
});

describe('a rename into a name another schema folder\'s table has (a pair formed by the rename)', () => {
  const readText = (f: string): string | null => (fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null);
  /** bqs.orte (a name only bqs has) and ccc.x, which points at it; on diagrams holding both, and ccc's alone. */
  const orteProject = (): void => {
    write('bronze/tables/bqs/orte.dbml', 'Table bqs.orte {\n  id INT [pk]\n}\n');
    write('bronze/tables/bqs/z.dbml', 'Table bqs.z {\n  id INT [pk]\n  orte_id INT\n}\n');
    write('bronze/tables/ccc/x.dbml', 'Table ccc.x {\n  id INT [pk]\n  orte_id INT\n}\n');
    write('bronze/tables/ccc/y.dbml', 'Table ccc.y {\n  id INT [pk]\n  x_id INT\n}\n');
    write('bronze/relationships/o.dbml', [
      "use { table bqs.orte } from '../tables/bqs/orte.dbml'",
      "use { table bqs.z } from '../tables/bqs/z.dbml'",
      "use { table ccc.x } from '../tables/ccc/x.dbml'",
      "use { table ccc.y } from '../tables/ccc/y.dbml'",
      'Ref: ccc.x.orte_id > bqs.orte.id',
      'Ref: ccc.y.x_id > ccc.x.id',
      'Ref: bqs.z.orte_id > bqs.orte.id',
      '',
    ].join('\n'));
    const diagram = (name: string, lines: string[], uses: string[], extra: string[] = []): void => write(`bronze/diagrams/${name}.dbml`, [
      `Project ${name} {`, "  erd_schema_version: '7'", "  erd_layout: '''", ...lines, "  '''", '}', '', ...uses, "use * from '../relationships/o.dbml'", '', ...extra,
    ].join('\n'));
    diagram('both', ['    orte 10 20', '    x 300 20', '    note/n1 500 500 100 100'],
      ["use { table bqs.orte } from '../tables/bqs/orte.dbml'", "use { table ccc.x } from '../tables/ccc/x.dbml'"],
      ['Note "n1" [linked_table: \'orte\'] {', "  'hi'", '}', '']);
    diagram('cccside', ['    x 10 20', '    y 300 20'],
      ["use { table ccc.x } from '../tables/ccc/x.dbml'", "use { table ccc.y } from '../tables/ccc/y.dbml'"]);
    diagram('bqsside', ['    orte 10 20', '    z 300 20'],
      ["use { table bqs.orte } from '../tables/bqs/orte.dbml'", "use { table bqs.z } from '../tables/bqs/z.dbml'"]);
  };
  const renameX = (): void => {
    const lib = scoped();
    lib.applyDbmlBatch({ ops: { save: [{ model: { ...lib.getTable({ schema: 'ccc', name: 'x' })!, name: 'orte' }, from: { schema: 'ccc', name: 'x' } }] } });
  };

  it('a diagram holding both qualifies both lines, keeps its relationships import and its sticky\'s link, and turns version 8', () => {
    orteProject();
    renameX();
    const both = read('bronze/diagrams/both.dbml');
    expect(both).toContain("erd_schema_version: '8'");
    expect(both).toMatch(/\n {4}bqs\.orte 10 20\n {4}ccc\.orte 300 20\n/);
    expect(both).toContain("linked_table: 'bqs.orte'");
    // Its Refs are between its two members still: the import stays.
    expect(both).toContain("use * from '../relationships/o.dbml'");
    expect(read('bronze/relationships/o.dbml')).toContain('Ref: ccc.orte.orte_id > bqs.orte.id');
  });

  it('a diagram showing only the renamed table keeps the import of its own Refs; one showing only the other is untouched', () => {
    orteProject();
    const before = read('bronze/diagrams/bqsside.dbml');
    renameX();
    const ccc = read('bronze/diagrams/cccside.dbml');
    expect(ccc).toContain("use { table ccc.orte } from '../tables/ccc/orte.dbml'");
    expect(ccc).toContain("use * from '../relationships/o.dbml'");
    expect(ccc).toMatch(/\n {4}orte 10 20\n/);
    expect(read('bronze/diagrams/bqsside.dbml')).toBe(before);
  });

  it('the plan answers a diagram\'s <schema>.<name> for a table it still keys by its bare name', () => {
    orteProject();
    const lib = scoped();
    const { plan } = lib.planDbmlBatch({ ops: { save: [{ model: { ...lib.getTable({ schema: 'ccc', name: 'x' })!, name: 'orte' }, from: { schema: 'ccc', name: 'x' } }] } });
    expect(plan.resolveTable('bqs.orte')?.path).toBe('bronze/tables/bqs/orte.dbml');
    expect(plan.resolveTable('ccc.orte')?.path).toBe('bronze/tables/ccc/orte.dbml');
    expect(plan.resolveTable('orte')?.path).toBe('bronze/tables/bqs/orte.dbml');
  });

  it('an Explorer rename keeps the renamed table\'s self-reference on itself, never on the other folder\'s table of its new name', () => {
    write('bronze/tables/ccc/addresse.dbml', 'Table ccc.addresse {\n  id INT [pk]\n  parent_id INT\n  street VARCHAR\n}\n');
    write('bronze/tables/bqs/orte.dbml', 'Table bqs.orte {\n  id INT [pk]\n  parent_id INT\n}\n');
    write('bronze/relationships/bronze.dbml', `${read('bronze/relationships/bronze.dbml')}Ref: ccc.addresse.parent_id > ccc.addresse.id\n`);
    const from = path.join(semantic, 'bronze/tables/ccc/addresse.dbml');
    const to = path.join(semantic, 'bronze/tables/ccc/orte.dbml');
    fs.renameSync(from, to);
    const plan = planDbmlExplorerMoves({ semanticRoot: semantic, tableLibraryService: scoped(), moves: [{ from, to }], readText });
    expect(plan.kind).toBe('update');
    if (plan.kind !== 'update') return;
    applyWritesToDisk(plan.writes);
    const refs = read('bronze/relationships/bronze.dbml').split('\n').filter((l) => l.startsWith('Ref:'));
    expect(refs).toEqual([
      'Ref: bqs.kunde.addresse_id >? bqs.addresse.id',
      'Ref: ccc.kunde.addresse_id >? ccc.orte.id',
      'Ref: ccc.orte.id >? bqs.addresse.id',
      'Ref: ccc.orte.parent_id > ccc.orte.id',
    ]);
  });
});

describe('create and TableId deletes in a YAML project (planTableWrites)', () => {
  it('a save marked create is written as YAML where new tables are YAML; a YAML table deletes by its TableId', () => {
    const yamlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-same-name-yaml-'));
    try {
      fs.mkdirSync(path.join(yamlRoot, '.erd-studio', 'logical-models'), { recursive: true });
      fs.writeFileSync(path.join(yamlRoot, '.erd-studio', 'logical-models', 'a.yml'), 'name: a\ncolumns:\n  - name: id\n    dataType: INT\n');
      const lib = new TableLibraryService(yamlRoot, '.erd-studio');
      expect(lib.writesDbml()).toBe(false);
      const created = lib.planTableWrites({ save: [{ model: { name: 'b', description: '', columns: [] }, create: true }] });
      expect(created.writes.map((w) => `${w.kind} ${path.basename(w.path)}`)).toEqual(['create b.yml']);
      const deleted = lib.planTableWrites({ delete: [{ schema: '', name: 'a' }] });
      expect(deleted.writes.map((w) => `${w.kind} ${path.basename(w.path)}`)).toEqual(['delete a.yml']);
    } finally {
      fs.rmSync(yamlRoot, { recursive: true, force: true });
    }
  });
});

describe('Give Duplicate Table Its Own Name on a copy in another layer of one of two same-named tables', () => {
  const readText = (f: string): string | null => (fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null);
  /** silver/tables/ccc/addresse.dbml: the same identity as bronze's ccc.addresse, so a duplicate the library ignores. */
  const silverCopy = (): void => {
    write('layers.json', JSON.stringify({ schemaVersion: 1, layers: [{ id: 'bronze', label: 'Bronze', creatable: true, order: 1 }, { id: 'silver', label: 'Silver', creatable: true, order: 2 }] }));
    write('silver/tables/ccc/addresse.dbml', 'Table ccc.addresse {\n  id INT [pk]\n  zz VARCHAR\n}\n');
  };
  const giveOwnName = (): FileWrite[] => {
    const lib = scoped();
    return planDbmlDuplicateRename({
      tableLibraryService: lib, copy: { filePath: path.join(semantic, 'silver/tables/ccc/addresse.dbml'), name: 'addresse' },
      newName: 'addresse_s', alias: 'addresse', diagrams: lib.listDbmlDiagrams(), readText,
    }).writes;
  };

  it('the Refs of the table the library uses (bronze ccc.addresse, declared the same way) keep their bytes', () => {
    silverCopy();
    const before = snapshotFiles();
    applyWritesToDisk(giveOwnName());
    expect(changedFiles(before, snapshotFiles())).toEqual(['+silver/tables/ccc/addresse_s.dbml', '-silver/tables/ccc/addresse.dbml']);
  });

  it('a diagram showing the copy beside bqs.addresse is repointed by what it calls the copy (ccc.addresse), never left on the deleted file', () => {
    silverCopy();
    write('silver/diagrams/pair.dbml', [
      'Project pair {', "  erd_schema_version: '8'", "  erd_layout: '''", '    bqs.addresse 1 2', '    ccc.addresse 3 4', "  '''", '}', '',
      "use { table bqs.addresse } from '../../bronze/tables/bqs/addresse.dbml'",
      "use { table ccc.addresse } from '../tables/ccc/addresse.dbml'",
      '',
    ].join('\n'));
    applyWritesToDisk(giveOwnName());
    const pair = read('silver/diagrams/pair.dbml');
    expect(pair).toContain("use { table ccc.addresse_s } from '../tables/ccc/addresse_s.dbml'");
    expect(pair).not.toContain('ccc/addresse.dbml');
    // No pair is left: bare lines with their coordinates, and version 7.
    expect(pair).toMatch(/\n {4}addresse 1 2\n {4}addresse_s 3 4\n/);
    expect(pair).toContain("erd_schema_version: '7'");
  });
});
