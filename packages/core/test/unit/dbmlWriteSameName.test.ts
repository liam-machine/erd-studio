/**
 * The DBML writers on two tables of one name in different schema folders
 * (packages/core/test/fixtures/dbml/same-name-two-schemas: bqs and ccc, each with addresse and
 * kunde). A diagram member keeps its `use` line by identity, not by its bare
 * name: when a table of its name joins or leaves the diagram its reference
 * changes (`addresse` ↔ `bqs.addresse`) and its position, sticky links and
 * stub entries follow in the same edit (`rekeySubjectArea`). `erd_layout`,
 * `linked_table` and `erd_stub_columns` are written qualified only for such a
 * pair, and the diagram is marked `erd_schema_version: '8'` only while it
 * holds one (D-2). The relationships writer, given `identify`, edits one
 * twin's Refs and `use` lines and never the other's.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { parseSubjectAreaDbml } from '../../src/dbml/readDiagram';
import { editSubjectAreaDbml, renderNewSubjectAreaDbml, type SubjectAreaDbmlEdit } from '../../src/dbml/writeDiagram';
import { editDiagramLayoutDbml } from '../../src/dbml/erdLayoutDbml';
import { editRelationshipsDbml } from '../../src/dbml/writeRelationships';
import { rekeySubjectArea } from '../../src/rekeySubjectArea';
import { withMemberRefs, withMemberSpelling, type ErdLayout } from '../../src/erdLayout';
import { clone, identityLookups } from '../dbmlWriterSupport';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

const TWINS = path.resolve(__dirname, '../fixtures/dbml/same-name-two-schemas/.erd-studio');

/** The fixture's `.dbml` files, keyed relative to its semantic dir. */
function twinFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.dbml')) out[path.relative(TWINS, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(TWINS);
  return out;
}

const FILES = twinFiles();
const BQS_ADDRESSE = 'bronze/tables/bqs/addresse.dbml';
const BQS_KUNDE = 'bronze/tables/bqs/kunde.dbml';
const CCC_ADDRESSE = 'bronze/tables/ccc/addresse.dbml';
const REL = 'bronze/relationships/bronze.dbml';
const D1 = 'bronze/diagrams/d1.dbml';
const KUNDEN = 'bronze/diagrams/kunden.dbml';
const KUNDEN_BARE = 'bronze/diagrams/kunden-bare.dbml';

/** A diagram that shows only bqs's tables, as 2.0.2 writes it: bare names, version 7. */
const BQS_ONLY = `Project d1 {
  erd_schema_version: '7'
  erd_layout: '''
    addresse 10 20
    kunde 400 20
  '''
}

use { table bqs.addresse } from '../tables/bqs/addresse.dbml'
use { table bqs.kunde }    from '../tables/bqs/kunde.dbml'
use * from '../relationships/bronze.dbml'
`;

/**
 * The writer's lookups: `names` maps what the diagram calls a member to its
 * file (a host's member table), and anything else resolves as the library
 * names it (a reference, `<schema>.<name>`, or a name one table has).
 */
function lookups(files: Record<string, string>, names: Record<string, string> = {}): Pick<SubjectAreaDbmlEdit, 'resolveTable' | 'relationshipsImportsFor' | 'fileExists'> {
  return {
    resolveTable: identityLookups(files, names).resolveTable,
    relationshipsImportsFor: (_names, current) => [...current],
    fileExists: (p) => Object.prototype.hasOwnProperty.call(files, p),
  };
}

const read = (text: string, file: string): Obj => parseSubjectAreaDbml(text, file).obj as Obj;

/** Edit `text` (the diagram at `file`) with `change` applied to a copy of what it reads as. */
function edit(text: string, file: string, change: (after: Obj) => void, options: { files?: Record<string, string>; names?: Record<string, string>; extra?: Partial<SubjectAreaDbmlEdit> } = {}): string {
  const before = read(text, file);
  const after = clone(before);
  change(after);
  return editSubjectAreaDbml(text, { filePath: file, before, after, ...lookups(options.files ?? FILES, options.names), ...options.extra });
}

/** Add ccc.addresse to the bqs-only diagram at 40,360. */
const addCccAddresse = (a: Obj): void => {
  a.logical.models.push('ccc.addresse');
  a.viewConfig.positions['ccc.addresse'] = { x: 40, y: 360 };
};
const BQS_NAMES = { addresse: BQS_ADDRESSE, kunde: BQS_KUNDE };

describe('editSubjectAreaDbml: a second table of one name joins the diagram, and leaves it', () => {
  const both = edit(BQS_ONLY, D1, addCccAddresse, { names: BQS_NAMES });

  it('keeps every existing use line, qualifies both layout lines, adds the new use line and writes version 8', () => {
    expect(both).toBe(`Project d1 {
  erd_schema_version: '8'
  erd_layout: '''
    bqs.addresse 10 20
    ccc.addresse 40 360
    kunde 400 20
  '''
}

use { table bqs.addresse } from '../tables/bqs/addresse.dbml'
use { table bqs.kunde }    from '../tables/bqs/kunde.dbml'
use { table ccc.addresse } from '../tables/ccc/addresse.dbml'
use * from '../relationships/bronze.dbml'
`);
  });

  it('reads back as two members of their own, each at its own position', () => {
    const obj = read(both, D1);
    expect(obj.logical.models).toEqual(['bqs.addresse', 'kunde', 'ccc.addresse']);
    expect(obj.viewConfig.positions).toEqual({ 'bqs.addresse': { x: 10, y: 20 }, 'ccc.addresse': { x: 40, y: 360 }, kunde: { x: 400, y: 20 } });
    expect(parseSubjectAreaDbml(both, D1).schemaVersion).toBe(8);
  });

  it('is the same edit when the caller already re-keyed the object (renamedMembers)', () => {
    const before = read(BQS_ONLY, D1);
    const after = rekeySubjectArea(clone(before), new Map([['addresse', 'bqs.addresse']]));
    addCccAddresse(after);
    const out = editSubjectAreaDbml(BQS_ONLY, {
      filePath: D1, before, after, renamedMembers: new Map([['addresse', 'bqs.addresse']]), ...lookups(FILES, BQS_NAMES),
    });
    expect(out).toBe(both);
  });

  it('removing it gives back the file it was, byte for byte (bare line, version 7)', () => {
    const back = edit(both, D1, (a) => {
      a.logical.models = a.logical.models.filter((m: string) => m !== 'ccc.addresse');
      delete a.viewConfig.positions['ccc.addresse'];
    });
    expect(back).toBe(BQS_ONLY);
  });

  it('a bare stray line beside the qualified one never wins after the twin leaves', () => {
    const stray = both.replace('    bqs.addresse 10 20\n', '    addresse 1 1\n    bqs.addresse 10 20\n');
    expect(read(stray, D1).viewConfig.positions['bqs.addresse']).toEqual({ x: 10, y: 20 });
    const back = edit(stray, D1, (a) => {
      a.logical.models = a.logical.models.filter((m: string) => m !== 'ccc.addresse');
      delete a.viewConfig.positions['ccc.addresse'];
    });
    expect(read(back, D1).viewConfig.positions).toEqual({ addresse: { x: 10, y: 20 }, kunde: { x: 400, y: 20 } });
    expect(back).toContain("erd_schema_version: '7'");
  });

  it('a sticky note and a stub entry on the first table follow it to its qualified reference, and back', () => {
    const withNote = BQS_ONLY
      .replace("  erd_schema_version: '7'\n", "  erd_schema_version: '7'\n  erd_stub_columns: '[\"addresse\"]'\n")
      .replace('    kunde 400 20\n', '    kunde 400 20\n    note/n1 720 20\n')
      + "\nNote n1 [linked_table: 'addresse'] {\n  'Where they live'\n}\n";
    const added = edit(withNote, D1, addCccAddresse, { names: BQS_NAMES });
    expect(added).toContain("erd_stub_columns: '[\"bqs.addresse\"]'");
    expect(added).toContain("Note n1 [linked_table: 'bqs.addresse']");
    const obj = read(added, D1);
    expect(obj.stubColumns).toEqual(['bqs.addresse']);
    expect(obj.viewConfig.annotations[0].linkedModel).toBe('bqs.addresse');
    const back = edit(added, D1, (a) => {
      a.logical.models = a.logical.models.filter((m: string) => m !== 'ccc.addresse');
      delete a.viewConfig.positions['ccc.addresse'];
    });
    expect(back).toBe(withNote);
  });

  it('a no-op edit of a diagram that holds the pair is byte-identical (Law 1)', () => {
    expect(edit(both, D1, () => undefined)).toBe(both);
    for (const file of [KUNDEN, KUNDEN_BARE, 'bronze/diagrams/ccc.dbml']) expect(edit(FILES[file], file, () => undefined)).toBe(FILES[file]);
  });

  it('a caller that names a member by its new reference without renamedMembers still keeps its line (the line that imports its file)', () => {
    // A hand-spaced line with its own comment: a line written anew would lose both.
    const own = "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'";
    const spaced = "use { table bqs.addresse }  from '../tables/bqs/addresse.dbml' // home addresses";
    const start = BQS_ONLY.replace(own, spaced);
    // The twin joins, and the caller already calls the first table bqs.addresse.
    const joined = edit(start, D1, (a) => {
      a.logical.models = ['bqs.addresse', 'kunde', 'ccc.addresse'];
      a.viewConfig.positions = { 'bqs.addresse': { x: 10, y: 20 }, kunde: { x: 400, y: 20 }, 'ccc.addresse': { x: 40, y: 360 } };
    }, { names: BQS_NAMES });
    expect(joined).toBe(both.replace(own, spaced));
    // The twin leaves, and the caller already calls the one left by its bare name.
    const left = edit(joined, D1, (a) => {
      a.logical.models = ['addresse', 'kunde'];
      a.viewConfig.positions = { addresse: { x: 10, y: 20 }, kunde: { x: 400, y: 20 } };
    }, { names: { addresse: BQS_ADDRESSE } });
    expect(left).toBe(start);
  });

  it('the twin and an unlinked member leave in one edit: the member left keeps its line, never taken for a renamed unlinked one', () => {
    const withOrphan = both.replace("  erd_schema_version: '8'\n", "  erd_schema_version: '8'\n  erd_unlinked_tables: 'orphan'\n");
    // A library-wide lookup: `addresse` names two tables there, so it resolves nothing; renamedMembers says who it is.
    const out = edit(withOrphan, D1, (a) => {
      a.logical.models = ['addresse', 'kunde'];
      a.viewConfig.positions = { addresse: { x: 10, y: 20 }, kunde: { x: 400, y: 20 } };
    }, { extra: { renamedMembers: new Map([['bqs.addresse', 'addresse']]) } });
    expect(out).toBe(BQS_ONLY);
    // Without renamedMembers nothing tells which addresse is meant: refused, never written as an unlinked member.
    expect(() => edit(withOrphan, D1, (a) => {
      a.logical.models = ['addresse', 'kunde'];
      a.viewConfig.positions = { addresse: { x: 10, y: 20 }, kunde: { x: 400, y: 20 } };
    })).toThrow(/addresse cannot be added to a DBML diagram/);
  });

  it("pathChanged names references: a bare name the pair's tables share touches neither table's line", () => {
    // Neither kunde is called `kunde` on this diagram, so neither line is re-derived (each keeps its spacing).
    expect(edit(FILES[KUNDEN], KUNDEN, () => undefined, { extra: { pathChanged: new Set(['kunde']) } })).toBe(FILES[KUNDEN]);
  });
});

describe('editSubjectAreaDbml on the fixture diagrams', () => {
  it('an edit of the version-8 diagram changes only what it changes', () => {
    const out = edit(FILES[KUNDEN], KUNDEN, (a) => { a.description = 'Changed'; });
    expect(out).toBe(FILES[KUNDEN].replace("Note: 'Customers and addresses from both source systems'", "Note: 'Changed'"));
  });

  it('a diagram as 2.0.2 kept it is written as version 8, each member under its own line, on its next edit', () => {
    const text = FILES[KUNDEN_BARE];
    const before = read(text, KUNDEN_BARE);
    const out = edit(text, KUNDEN_BARE, (a) => { a.description = 'Changed'; });
    expect(out).toContain("erd_schema_version: '8'");
    expect(out).toContain("    bqs.addresse 40 40\n    bqs.kunde 400 40\n    note/5d1c7e2a-3b4f-4a6e-9d8c-1f2e3a4b5c6d 760 360 220 120\n");
    expect(out).not.toMatch(/^ +addresse 40 40$/m);
    expect(out).toContain("[color: #f59e0b, linked_table: 'bqs.addresse']");
    // It reads back as it was drawn: the same members at the same places.
    const after = read(out, KUNDEN_BARE);
    expect(after.viewConfig.positions).toEqual(before.viewConfig.positions);
    expect(after.viewConfig.annotations).toEqual(before.viewConfig.annotations);
    expect(after.logical.models).toEqual(before.logical.models);
  });

  it('the 2.0.2 diagram with a merge conflict in erd_layout: an edit that moves nothing is written, the layout left for the user to resolve', () => {
    const text = FILES[KUNDEN_BARE].replace(
      '    addresse 40 40\n',
      '<<<<<<< HEAD\n    addresse 40 40\n=======\n    addresse 50 50\n>>>>>>> other\n',
    );
    expect(parseSubjectAreaDbml(text, KUNDEN_BARE).layoutSharedBare).toBeDefined();
    const out = edit(text, KUNDEN_BARE, (a) => { a.description = 'Changed'; });
    expect(out).toContain("Note: 'Changed'");
    expect(out).toContain("erd_schema_version: '8'");
    expect(out).toContain('<<<<<<< HEAD\n    addresse 40 40\n=======\n    addresse 50 50\n>>>>>>> other\n');
  });

  it('a drag on the version-8 diagram rewrites only the moved line and keeps the version', () => {
    const before = read(FILES[KUNDEN], KUNDEN);
    const positions = { ...before.viewConfig.positions, 'ccc.kunde': { x: 500, y: 500 } };
    const out = editDiagramLayoutDbml(FILES[KUNDEN], { filePath: KUNDEN, positions, annotations: before.viewConfig.annotations });
    expect(out).toBe(FILES[KUNDEN].replace('    ccc.kunde 400 360\n', '    ccc.kunde 500 500\n'));
  });

  it('a drag on the 2.0.2 diagram writes each member under its own line and no bare line', () => {
    const before = read(FILES[KUNDEN_BARE], KUNDEN_BARE);
    const positions = { ...before.viewConfig.positions, 'ccc.addresse': { x: 40, y: 360 } };
    const out = editDiagramLayoutDbml(FILES[KUNDEN_BARE], { filePath: KUNDEN_BARE, positions, annotations: before.viewConfig.annotations });
    expect(out).toContain("    bqs.addresse 40 40\n    bqs.kunde 400 40\n    ccc.addresse 40 360\n    note/");
    expect(read(out, KUNDEN_BARE).viewConfig.positions).toEqual(positions);
    // It now holds lines an older version reads as strays: it is marked as a diagram that holds a pair.
    expect(out).toContain("erd_schema_version: '8'");
    expect(out.replace("erd_schema_version: '8'", "erd_schema_version: '7'").replace(/ +erd_layout: '''[^]*?'''\n/, '')).toBe(FILES[KUNDEN_BARE].replace(/ +erd_layout: '''[^]*?'''\n/, ''));
  });

  it("a drag on a diagram with no pair leaves its version line alone, and drops a <folder>.<name> line beside the member's own", () => {
    const text = BQS_ONLY.replace('    kunde 400 20\n', '    bqs.kunde 1 1\n    kunde 400 20\n');
    // The reader prefers the qualified line, so a drag must not leave it behind.
    expect(read(text, D1).viewConfig.positions.kunde).toEqual({ x: 1, y: 1 });
    const out = editDiagramLayoutDbml(text, { filePath: D1, positions: { addresse: { x: 10, y: 20 }, kunde: { x: 9, y: 9 } }, annotations: [] });
    expect(out).toBe(BQS_ONLY.replace('    kunde 400 20\n', '    kunde 9 9\n'));
    expect(read(out, D1).viewConfig.positions.kunde).toEqual({ x: 9, y: 9 });
  });

  it('renaming one table of a pair from the library returns the diagram to bare lines and version 7 in the same edit', () => {
    const pair = BQS_ONLY
      .replace("    kunde 400 20\n", "    ccc.addresse 40 360\n")
      .replace("  erd_schema_version: '7'", "  erd_schema_version: '8'")
      .replace("    addresse 10 20\n", "    bqs.addresse 10 20\n")
      .replace("use { table bqs.kunde }    from '../tables/bqs/kunde.dbml'", "use { table ccc.addresse } from '../tables/ccc/addresse.dbml'");
    expect(read(pair, D1).logical.models).toEqual(['bqs.addresse', 'ccc.addresse']);
    // ccc/addresse.dbml is renamed ccc/adr.dbml: the library after the edit, and the diagram's members renamed.
    const files: Record<string, string> = { ...FILES, 'bronze/tables/ccc/adr.dbml': FILES[CCC_ADDRESSE].replace('Table ccc.addresse', 'Table ccc.adr') };
    delete files[CCC_ADDRESSE];
    const out = edit(pair, D1, (a) => {
      a.logical.models = ['bqs.addresse', 'adr'];
      a.viewConfig.positions = { 'bqs.addresse': a.viewConfig.positions['bqs.addresse'], adr: a.viewConfig.positions['ccc.addresse'] };
    }, { files, names: { 'bqs.addresse': BQS_ADDRESSE }, extra: { pathChanged: new Set(['ccc.addresse']), renamedMembers: new Map([['ccc.addresse', 'adr']]) } });
    expect(out).toBe(`Project d1 {
  erd_schema_version: '7'
  erd_layout: '''
    addresse 10 20
    adr 40 360
  '''
}

use { table bqs.addresse } from '../tables/bqs/addresse.dbml'
use { table ccc.adr } from '../tables/ccc/adr.dbml'
use * from '../relationships/bronze.dbml'
`);
  });

  it('deleting one table of a pair from the library cuts its line, and the one left goes back to its bare line and version 7', () => {
    const pair = BQS_ONLY
      .replace("    kunde 400 20\n", "    ccc.addresse 40 360\n")
      .replace("  erd_schema_version: '7'", "  erd_schema_version: '8'")
      .replace("    addresse 10 20\n", "    bqs.addresse 10 20\n")
      .replace("use { table bqs.kunde }    from '../tables/bqs/kunde.dbml'", "use { table ccc.addresse } from '../tables/ccc/addresse.dbml'");
    const files: Record<string, string> = { ...FILES };
    delete files[CCC_ADDRESSE];
    // The settle's edit: nothing changed in the object; the deleted table is in pathChanged and resolves to nothing.
    const out = edit(pair, D1, () => undefined, { files, names: { 'bqs.addresse': BQS_ADDRESSE }, extra: { pathChanged: new Set(['ccc.addresse']) } });
    expect(out).toBe(`Project d1 {
  erd_schema_version: '7'
  erd_layout: '''
    addresse 10 20
    ccc.addresse 40 360
  '''
}

use { table bqs.addresse } from '../tables/bqs/addresse.dbml'
use * from '../relationships/bronze.dbml'
`);
    expect(read(out, D1).logical.models).toEqual(['addresse']);
    expect(read(out, D1).viewConfig.positions.addresse).toEqual({ x: 10, y: 20 });
  });

  it('moving one twin to a free schema re-points its line in place and writes its layout line under its new reference', () => {
    const files: Record<string, string> = { ...FILES, 'bronze/tables/ddd/addresse.dbml': FILES[BQS_ADDRESSE].replace('Table bqs.addresse', 'Table ddd.addresse') };
    delete files[BQS_ADDRESSE];
    const before = read(FILES[KUNDEN], KUNDEN);
    const renames = new Map([['bqs.addresse', 'ddd.addresse']]);
    const out = editSubjectAreaDbml(FILES[KUNDEN], {
      filePath: KUNDEN, before, after: rekeySubjectArea(before, renames), renamedMembers: renames,
      pathChanged: new Set(['bqs.addresse']), ...lookups(files),
    });
    expect(out).toBe(FILES[KUNDEN]
      .replace("use { table bqs.addresse } from '../tables/bqs/addresse.dbml'", "use { table ddd.addresse } from '../tables/ddd/addresse.dbml'")
      .replace('    bqs.addresse 40 40\n    bqs.kunde 400 40\n    ccc.addresse 40 360\n    ccc.kunde 400 360\n', '    bqs.kunde 400 40\n    ccc.addresse 40 360\n    ccc.kunde 400 360\n    ddd.addresse 40 40\n'));
  });
});

describe('renderNewSubjectAreaDbml with two tables of one name', () => {
  const base = { filePath: D1, domain: 'd1', relationshipsFiles: [REL] };

  it('writes version 8 and each table under its reference', () => {
    const out = renderNewSubjectAreaDbml({
      ...base,
      members: [{ name: 'addresse', reference: 'bqs.addresse', path: BQS_ADDRESSE }, { name: 'addresse', reference: 'ccc.addresse', path: CCC_ADDRESSE }],
      positions: { 'bqs.addresse': { x: 1, y: 2 }, 'ccc.addresse': { x: 3, y: 4 } },
    });
    expect(out).toContain("erd_schema_version: '8'");
    expect(out).toContain("    bqs.addresse 1 2\n    ccc.addresse 3 4\n");
    expect(read(out, D1).logical.models).toEqual(['bqs.addresse', 'ccc.addresse']);
  });

  it('writes version 7, and positions as given, for a diagram with no pair', () => {
    const out = renderNewSubjectAreaDbml({ ...base, members: [{ name: 'addresse', reference: 'bqs.addresse', path: BQS_ADDRESSE }], positions: { addresse: { x: 1, y: 2 } } });
    expect(out).toContain("erd_schema_version: '7'");
    expect(out).toContain('    addresse 1 2\n');
  });
});

describe('editRelationshipsDbml with identify: one twin edited, the other untouched', () => {
  const text = FILES[REL];

  it('a no-op is byte-identical', () => {
    const look = identityLookups(FILES);
    expect(editRelationshipsDbml(text, { filePath: REL, owners: new Map(), resolve: look.resolve, identify: look.identify })).toBe(text);
  });

  it('renaming bqs.addresse re-spells only its ends and its use line', () => {
    const files: Record<string, string> = { ...FILES, 'bronze/tables/bqs/adresse2.dbml': FILES[BQS_ADDRESSE].replace('Table bqs.addresse', 'Table bqs.adresse2') };
    delete files[BQS_ADDRESSE];
    // The file's ends are identified as the library was before the edit; renamedOwners says what they are after it.
    const out = editRelationshipsDbml(text, {
      filePath: REL, owners: new Map(), resolve: identityLookups(files).resolve, identify: identityLookups(FILES).identify,
      renamedOwners: new Map([['bqs.addresse', 'bqs.adresse2']]), pathChanged: new Set(['bqs.addresse']),
    });
    expect(out).toBe(text
      .replace("use { table bqs.addresse } from '../tables/bqs/addresse.dbml'", "use { table bqs.adresse2 } from '../tables/bqs/adresse2.dbml'")
      .replace('Ref: bqs.kunde.addresse_id >? bqs.addresse.id', 'Ref: bqs.kunde.addresse_id >? bqs.adresse2.id')
      .replace('Ref: ccc.addresse.id >? bqs.addresse.id', 'Ref: ccc.addresse.id >? bqs.adresse2.id'));
    expect(out).toContain('Ref: ccc.kunde.addresse_id >? ccc.addresse.id');
  });

  it('moving bqs.addresse to ddd re-qualifies only its ends and its use line', () => {
    const files: Record<string, string> = { ...FILES, 'bronze/tables/ddd/addresse.dbml': FILES[BQS_ADDRESSE].replace('Table bqs.addresse', 'Table ddd.addresse') };
    delete files[BQS_ADDRESSE];
    const out = editRelationshipsDbml(text, {
      filePath: REL, owners: new Map(), resolve: identityLookups(files).resolve, identify: identityLookups(FILES).identify,
      renamedOwners: new Map([['bqs.addresse', 'ddd.addresse']]), requalified: new Set(['ddd.addresse']), pathChanged: new Set(['bqs.addresse']),
    });
    expect(out).toBe(text
      .replace("use { table bqs.addresse } from '../tables/bqs/addresse.dbml'", "use { table ddd.addresse } from '../tables/ddd/addresse.dbml'")
      .replace('Ref: bqs.kunde.addresse_id >? bqs.addresse.id', 'Ref: bqs.kunde.addresse_id >? ddd.addresse.id')
      .replace('Ref: ccc.addresse.id >? bqs.addresse.id', 'Ref: ccc.addresse.id >? ddd.addresse.id'));
  });

  it("dropping ccc.kunde's Ref cuts it alone; bqs.kunde's Ref of the same columns stays", () => {
    const look = identityLookups(FILES);
    const out = editRelationshipsDbml(text, {
      filePath: REL, owners: new Map([['ccc.kunde', null]]), resolve: look.resolve, identify: look.identify,
    });
    expect(out).toContain('Ref: bqs.kunde.addresse_id >? bqs.addresse.id');
    expect(out).not.toContain('Ref: ccc.kunde.addresse_id');
    expect(out).toContain('Ref: ccc.addresse.id >? bqs.addresse.id');
  });

  it('a Ref between the two twins on one column name is no self-join', () => {
    const look = identityLookups(FILES);
    const owners = new Map([['ccc.addresse', {
      name: 'ccc.addresse',
      relationships: [{ fromColumn: 'id', toModel: 'bqs.addresse', toColumn: 'id', cardinality: 'many-to-one' as const }],
    }]]);
    expect(editRelationshipsDbml(text, { filePath: REL, owners, resolve: look.resolve, identify: look.identify })).toBe(text);
  });
});

describe('rekeySubjectArea', () => {
  const obj = (): Obj => ({
    schemaVersion: 5,
    domain: 'd',
    logical: {
      models: ['addresse', 'kunde'],
      relationships: [{ fromModel: 'dim_missing', fromColumn: 'a', toModel: 'addresse', toColumn: 'id', cardinality: 'many-to-one' }],
    },
    viewConfig: {
      positions: { addresse: { x: 1, y: 2 }, kunde: { x: 3, y: 4 }, stray: { x: 5, y: 6 } },
      annotations: [{ id: 'n', text: '', x: 0, y: 0, linkedModel: 'addresse' }, { id: 'm', text: '', x: 0, y: 0 }],
    },
    stubColumns: ['addresse', 'kunde'],
  });

  it('renames every place a reference is stored, and leaves the object it was given alone', () => {
    const given = obj();
    const out = rekeySubjectArea(given, new Map([['ADDRESSE', 'bqs.addresse']]));
    expect(out.logical.models).toEqual(['bqs.addresse', 'kunde']);
    expect(out.logical.relationships[0].toModel).toBe('bqs.addresse');
    expect(out.viewConfig.positions).toEqual({ 'bqs.addresse': { x: 1, y: 2 }, kunde: { x: 3, y: 4 }, stray: { x: 5, y: 6 } });
    expect(out.viewConfig.annotations[0].linkedModel).toBe('bqs.addresse');
    expect(out.viewConfig.annotations[1]).toEqual({ id: 'm', text: '', x: 0, y: 0 });
    expect(out.stubColumns).toEqual(['bqs.addresse', 'kunde']);
    expect(given).toEqual(obj());
  });

  it('round trip: renaming back with the inverse map gives the object again', () => {
    const forward = new Map([['addresse', 'bqs.addresse'], ['kunde', 'bqs.kunde']]);
    const inverse = new Map([...forward].map(([a, b]) => [b, a]));
    expect(rekeySubjectArea(rekeySubjectArea(obj(), forward), inverse)).toEqual(obj());
    // A swap is a rename too.
    const swap = new Map([['addresse', 'kunde'], ['kunde', 'addresse']]);
    expect(rekeySubjectArea(rekeySubjectArea(obj(), swap), swap)).toEqual(obj());
  });

  it("a renamed position takes the place of a stray of its new name; nothing to rename returns the object", () => {
    const o = obj();
    o.viewConfig.positions['bqs.addresse'] = { x: 9, y: 9 };
    expect(rekeySubjectArea(o, new Map([['addresse', 'bqs.addresse']])).viewConfig.positions['bqs.addresse']).toEqual({ x: 1, y: 2 });
    expect(rekeySubjectArea(o, new Map())).toBe(o);
    expect(rekeySubjectArea(o, new Map([['x', 'x']]))).toBe(o);
  });
});

describe('withMemberRefs (the writer\'s line rule for members with identities)', () => {
  const twins = [
    { schema: 'bqs', name: 'addresse', ref: 'bqs.addresse' },
    { schema: 'ccc', name: 'addresse', ref: 'ccc.addresse' },
    { schema: 'bqs', name: 'kunde', ref: 'kunde' },
  ];

  it('writes each member under its reference and drops a bare line both twins have their own lines beside', () => {
    const layout: ErdLayout = { positions: { addresse: { x: 1, y: 1 }, 'bqs.addresse': { x: 2, y: 2 }, 'CCC.addresse': { x: 3, y: 3 }, kunde: { x: 4, y: 4 }, other: { x: 5, y: 5 } }, stickies: [] };
    expect(withMemberRefs(layout, twins).positions).toEqual({ 'bqs.addresse': { x: 2, y: 2 }, 'ccc.addresse': { x: 3, y: 3 }, kunde: { x: 4, y: 4 }, other: { x: 5, y: 5 } });
  });

  it('drops a <folder>.<name> line beside a unique member\'s own line, so a drag on it sticks', () => {
    const layout: ErdLayout = { positions: { 'bqs.kunde': { x: 1, y: 1 }, kunde: { x: 4, y: 4 } }, stickies: [] };
    expect(withMemberRefs(layout, twins).positions).toEqual({ kunde: { x: 4, y: 4 } });
    expect(withMemberRefs({ positions: { 'bqs.kunde': { x: 1, y: 1 } }, stickies: [] }, twins).positions).toEqual({ kunde: { x: 1, y: 1 } });
  });

  it('is withMemberSpelling for members with no identities', () => {
    const layout: ErdLayout = { positions: { Dim_Customer: { x: 1, y: 2 }, dim_customer: { x: 10, y: 20 }, DIM_DATE: { x: 3, y: 4 }, stray: { x: 5, y: 5 } }, stickies: [{ id: 'n', x: 1, y: 1 }] };
    const members = ['dim_customer', 'fct_order', 'dim_date'];
    expect(withMemberRefs(layout, members.map((m) => ({ schema: '', name: m, ref: m })))).toEqual(withMemberSpelling(layout, members));
  });
});
