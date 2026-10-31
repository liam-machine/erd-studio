/**
 * `parseSubjectAreaDbml` and `subjectAreaMembersDbml` (§2.5, §4.3 of the
 * native DBML storage spec; §1.4 of the 2.0 tree design): a
 * `<layer>/diagrams/<name>.dbml` diagram read into the v5 object the rest of
 * core reads, beside its DBML schema version; its `use` lines resolved
 * against `<layer>/diagrams` into members, relationships imports and other
 * imports; tolerant of constructs it does not read (blanked, warned about,
 * kept).
 */
import { describe, it, expect } from 'vitest';

import { parseSubjectAreaDbml, subjectAreaMembersDbml } from '../../src/dbml/readDiagram';
import { SubjectAreaFileError, SubjectAreaValidationError, validateSubjectAreaDocument } from '../../src/domain';
import { detectSubjectAreaFormat } from '../../src/types/semantic';
import { STORAGE_PARSERS } from '../dbmlParsers';

const SALES = `Project sales {
  Note: 'Sales star schema'
  erd_schema_version: '7'
  erd_show_fk_edges: 'false'
  erd_layout_options: '{"elk.direction":"RIGHT"}'
  erd_model_folder: 'models/gold'
  erd_stub_columns: '["loaded_at"]'
  database_type: 'Snowflake'
  team_owner: 'sales'
  erd_layout: '''
    dim_customer 40 40
    dim_date 40 360
    fct_order 400 200
    note/3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c 720 40 220 120
  '''
}

use { table gold.fct_order } from '../tables/gold/fct_order.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'
use * from '../relationships/gold.dbml'
use * from '../relationships/dates.dbml'
use * from '../relationships/gold.dbml'

Note "3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c" [color: #f59e0b, linked_table: 'fct_order'] {
  'Check the grain with finance'
}

Note "9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f" [color: #3b82f6] {
  ''
}
`;

const PATH = '.erd-studio/gold/diagrams/sales.dbml';

describe('parseSubjectAreaDbml: the §2.5 mapping', () => {
  it.each(STORAGE_PARSERS)('reads the Project, members, Notes and erd_layout into a v5 object (%s)', (_label, parser) => {
    const reading = parseSubjectAreaDbml(SALES, PATH, parser);
    expect(reading.schemaVersion).toBe(7);
    expect(reading.writable).toBe(true);
    expect(reading.members).toEqual(['fct_order', 'dim_customer', 'dim_date']);
    expect(reading.useTableDirs).toEqual(['gold/tables/gold', 'silver/tables/shared']);
    // Each relationships file once, in file order.
    expect(reading.relationshipsUses).toEqual(['gold/relationships/gold.dbml', 'gold/relationships/dates.dbml']);
    expect(reading.otherUses).toEqual([]);
    expect(reading.uses!.map((u) => u.resolved)).toEqual([
      'gold/tables/gold/fct_order.dbml', 'gold/tables/gold/dim_customer.dbml', 'silver/tables/shared/dim_date.dbml',
    ]);
    expect(reading.holdsOwnTables).toBe(false);
    expect(reading.warnings).toEqual([]);
    expect(reading.obj).toEqual({
      schemaVersion: 5,
      domain: 'sales',
      layer: 'gold',
      description: 'Sales star schema',
      modelFolder: 'models/gold',
      logical: { models: ['fct_order', 'dim_customer', 'dim_date'], relationships: [] },
      viewConfig: {
        showFkEdges: false,
        layoutOptions: { 'elk.direction': 'RIGHT' },
        positions: { dim_customer: { x: 40, y: 40 }, dim_date: { x: 40, y: 360 }, fct_order: { x: 400, y: 200 } },
        annotations: [
          { id: '3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', text: 'Check the grain with finance', x: 720, y: 40, width: 220, height: 120, color: 'yellow', linkedModel: 'fct_order' },
          // No layout entry: placed to the right of everything laid out, deterministically.
          { id: '9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f', text: '', x: 980, y: 40, color: 'blue' },
        ],
      },
      stubColumns: ['loaded_at'],
    });
    // The rest of core sees a plain v5 document (D8).
    expect(detectSubjectAreaFormat(reading.obj)).toBe('v5');
    expect(validateSubjectAreaDocument(reading.obj, PATH).format).toBe('v5');
  });

  it('defaults: no Project gives the stem as domain, version 7 and an empty description', () => {
    const reading = parseSubjectAreaDbml("use { table silver.a } from '../tables/silver/a.dbml'\n", '.erd-studio/silver/diagrams/orders.dbml');
    expect(reading.obj).toMatchObject({ schemaVersion: 5, domain: 'orders', layer: 'silver', description: '', viewConfig: { positions: {} } });
    expect(reading.schemaVersion).toBe(7);
  });

  it('reads members in order, a table listed twice twice, and accepts use * and a path without .dbml', () => {
    const reading = parseSubjectAreaDbml(`use * from '../tables/gold/a'
use { table b } from '../tables/gold/b.dbml'
use { table a } from '../tables/gold/a.dbml'
use { table _x } from '../../silver/tables/s/_x.dbml'
`, PATH);
    expect(reading.members).toEqual(['a', 'b', 'a', '_x']);
    expect(reading.warnings).toEqual([]);
  });

  it('a member is its path\'s stem: semantic-dir-relative and wrong-folder paths, and a specifier naming another table, warn usePathMismatch', () => {
    const reading = parseSubjectAreaDbml(`use { table fct_order } from 'tables/gold/fct_order.dbml'
use { table dim_date } from './dim_date.dbml'
use { table dim_account } from '../tables/gold/dim_customer.dbml'
use { table ok } from '../tables/gold/ok.dbml'
use { table old } from '../../tables/gold/old.dbml'
`, PATH);
    expect(reading.members).toEqual(['fct_order', 'dim_date', 'dim_customer', 'ok', 'old']);
    expect(reading.warnings.filter((w) => w.includes('usePathMismatch')).map((w) => w.slice(0, 7))).toEqual(['Line 1:', 'Line 2:', 'Line 3:', 'Line 5:']);
    expect(reading.uses!.map((u) => u.resolved)).toEqual([
      'gold/diagrams/tables/gold/fct_order.dbml', 'gold/diagrams/dim_date.dbml', 'gold/tables/gold/dim_customer.dbml', 'gold/tables/gold/ok.dbml', 'tables/gold/old.dbml',
    ]);
    // Only a table file's folder is a table folder.
    expect(reading.useTableDirs).toEqual(['gold/tables/gold']);
  });

  it('a specifier that spells the stem in another case is no mismatch (D2: the file declares Dim_Date); the stem is the member', () => {
    // A path whose case differs from the file on disk needs a directory
    // listing, so core cannot see it; the host and doctor report it (§3.4).
    const reading = parseSubjectAreaDbml(`use { table Dim_Date } from '../tables/gold/dim_date.dbml'
use { table dim_customer } from '../tables/gold/Dim_Customer.dbml'
`, PATH);
    expect(reading.members).toEqual(['dim_date', 'Dim_Customer']);
    expect(reading.warnings).toEqual([]);
  });

  it('ignores a selective use line that imports no table it can read, with a warning', () => {
    const reading = parseSubjectAreaDbml("use { table x } from '../tables/..'\nuse { enum status } from '../../shared/enums.dbml'\nuse { table a } from '../tables/gold/a.dbml'\n", PATH);
    expect(reading.members).toEqual(['a']);
    expect(reading.warnings).toEqual([
      "Line 1: the use line for '../tables/..' does not import a table ERD Studio can read; it is ignored",
      "Line 2: the use line for '../../shared/enums.dbml' does not import a table ERD Studio can read; it is ignored",
    ]);
    expect(reading.otherUses).toEqual([]);
  });

  it('every other use * line is otherUses: never a member nor a relationships import (§1.4)', () => {
    const reading = parseSubjectAreaDbml(`use * from '../../shared/enums.dbml'
use * from '../relationships/sub/old.dbml'
use * from '../tables/gold'
use * from '../tables/gold/a.dbml'
use * from '../relationships/a.dbml'
`, PATH);
    expect(reading.members).toEqual(['a']);
    expect(reading.otherUses).toEqual(['shared/enums.dbml', 'gold/relationships/sub/old.dbml', 'gold/tables/gold.dbml']);
    expect(reading.relationshipsUses).toEqual(['gold/relationships/a.dbml']);
    expect(reading.warnings).toEqual([]);
  });

  it('a relationships file named like a table is an import, never a member; a table in a schema named relationships is a member', () => {
    const reading = parseSubjectAreaDbml(`use * from '../relationships/fct_order.dbml'
use { table relationships.x } from '../tables/relationships/x.dbml'
use * from '../../relationships/relationships/relationships.dbml'
`, PATH);
    expect(reading.members).toEqual(['x']);
    expect(reading.relationshipsUses).toEqual(['gold/relationships/fct_order.dbml', 'relationships/relationships/relationships.dbml']);
  });

  it('the layer and the folder use paths resolve against come from the path, absolute or relative, either separator', () => {
    const text = "use { table silver.a } from '../tables/silver/a.dbml'\nuse * from '../relationships/silver.dbml'\n";
    for (const path of ['silver/diagrams/s.dbml', '/p/.erd-studio/silver/diagrams/s.dbml', 'C:\\p\\.erd-studio\\silver\\diagrams\\s.dbml']) {
      const reading = parseSubjectAreaDbml(text, path);
      expect(reading.obj.layer).toBe('silver');
      expect(reading.obj.domain).toBe('s');
      expect(reading.uses!.map((u) => u.resolved)).toEqual(['silver/tables/silver/a.dbml']);
      expect(reading.relationshipsUses).toEqual(['silver/relationships/silver.dbml']);
    }
  });

  it('maps any Note colour to the nearest swatch, and leaves an uncoloured Note uncoloured', () => {
    const reading = parseSubjectAreaDbml("Note a [color: #fef3c7] {\n  'x'\n}\nNote b [color: #ff0000] {\n  'y'\n}\nNote c {\n  'z'\n}\n", PATH);
    const annotations = (reading.obj.viewConfig as { annotations: Array<{ id: string; color?: string }> }).annotations;
    expect(annotations.map((a) => [a.id, a.color])).toEqual([['a', 'yellow'], ['b', 'orange'], ['c', undefined]]);
  });

  it('an erd_layout that is not a string does not read, as in every other DBML tool (the quote hint)', () => {
    expect(() => parseSubjectAreaDbml("use { table a } from '../tables/gold/a.dbml'\nProject p {\n  erd_layout: 42\n}\n", PATH))
      .toThrow(/line 3.*Quote the value/);
  });

  it('a leading byte-order mark is stripped', () => {
    expect(parseSubjectAreaDbml(`﻿${SALES}`, PATH).members).toHaveLength(3);
  });
});

describe('parseSubjectAreaDbml: constructs it does not read (D6)', () => {
  it.each(STORAGE_PARSERS)('a declared Table, Ref and TableGroup are blanked and warned about; the file stays writable (%s)', (_label, parser) => {
    const text = `Project p {
  erd_schema_version: '7'
}
use { table a } from '../tables/gold/a.dbml'
Table local {
  id int
}
Ref: local.id > a.id
TableGroup g {
  local
}
`;
    const reading = parseSubjectAreaDbml(text, PATH, parser);
    expect(reading.members).toEqual(['a']);
    expect(reading.writable).toBe(true);
    expect(reading.warnings.map((w) => w.slice(0, 7))).toEqual(['Line 5:', 'Line 8:', 'Line 9:']);
    expect(reading.holdsOwnTables).toBe(false);
  });

  it.each(STORAGE_PARSERS)('a repeated Note name and a second Project read with a warning, and make the file unwritable (%s)', (_label, parser) => {
    const text = `Project p {
  Note: 'first'
}
Project q {
  Note: 'second'
}
Note n {
  'one'
}
Note N {
  'two'
}
`;
    const reading = parseSubjectAreaDbml(text, PATH, parser);
    expect(reading.writable).toBe(false);
    expect(reading.obj.domain).toBe('p');
    expect(reading.obj.description).toBe('first');
    expect((reading.obj.viewConfig as { annotations: Array<{ text: string }> }).annotations.map((a) => a.text)).toEqual(['one']);
    expect(reading.warnings).toHaveLength(2);
  });

  it.each(STORAGE_PARSERS)('a Metadata block (D25) is blanked, warned about and kept; the diagram still reads (%s)', (_label, parser) => {
    // Valid DBML when other tools compile the project (its target is the
    // imported table), but a [4000] once the use lines are blanked.
    const text = `Project d {
  Note: 'with metadata'
  erd_schema_version: '7'
}
use { table fct } from '../tables/gold/fct.dbml'
Metadata Table fct {
  note: 'set in the diagram'
}
Metadata Column fct.id {
  note: 'the key'
}
Note n {
  'kept'
}
`;
    const reading = parseSubjectAreaDbml(text, PATH, parser);
    expect(reading.members).toEqual(['fct']);
    expect(reading.writable).toBe(true);
    expect(reading.obj.description).toBe('with metadata');
    expect((reading.obj.viewConfig as { annotations: Array<{ text: string }> }).annotations.map((a) => a.text)).toEqual(['kept']);
    expect(reading.warnings).toEqual([
      'Line 6: a Metadata block is declared in the diagram file; ERD Studio reads table properties only from the table file, and keeps it as written',
      'Line 9: a Metadata block is declared in the diagram file; ERD Studio reads table properties only from the table file, and keeps it as written',
    ]);
  });

  it('Tables declared and no table use lines: holdsOwnTables, the import-banner condition', () => {
    const reading = parseSubjectAreaDbml('Table a {\n  id int\n}\nTable b {\n  id int\n}\nRef: a.id > b.id\n', PATH);
    expect(reading.holdsOwnTables).toBe(true);
    expect(reading.members).toEqual([]);
  });
});

describe('parseSubjectAreaDbml: refusals', () => {
  const thrown = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (err) {
      return err;
    }
    throw new Error('expected a throw');
  };

  it('an empty file is SubjectAreaFileError(empty)', () => {
    const err = thrown(() => parseSubjectAreaDbml('\n  \n', PATH)) as SubjectAreaFileError;
    expect(err).toBeInstanceOf(SubjectAreaFileError);
    expect(err.reason).toBe('empty');
  });

  it.each(STORAGE_PARSERS)('a syntax error is invalid-dbml, transient, at its line and column (%s)', (_label, parser) => {
    const err = thrown(() => parseSubjectAreaDbml("Project p {\n  Note: 'cut off'\n", PATH, parser)) as SubjectAreaFileError;
    expect(err).toBeInstanceOf(SubjectAreaFileError);
    expect(err).toMatchObject({ reason: 'invalid-dbml', transient: true, mergeConflict: false, line: 3, column: 1 });
    expect(err.message).toMatch(/^Invalid DBML in subject area file \.erd-studio\/gold\/diagrams\/sales\.dbml at line 3, column 1: /);
  });

  it('git conflict markers are invalid-dbml with mergeConflict, not transient', () => {
    const text = "Project p {\n  Note: 'x'\n}\n<<<<<<< HEAD\nuse { table a } from '../tables/gold/a.dbml'\n=======\nuse { table b } from '../tables/gold/b.dbml'\n>>>>>>> other\n";
    const err = thrown(() => parseSubjectAreaDbml(text, PATH)) as SubjectAreaFileError;
    expect(err).toMatchObject({ reason: 'invalid-dbml', mergeConflict: true, transient: false, line: 4 });
  });

  it('an unquoted Project key is invalid-dbml with the quote hint (every parser rejects it)', () => {
    const err = thrown(() => parseSubjectAreaDbml('Project p {\n  erd_schema_version: 7\n}\n', PATH)) as SubjectAreaFileError;
    expect(err.reason).toBe('invalid-dbml');
    expect(err.message).toContain("Quote the value, as in erd_schema_version: '7'.");
  });

  it('a path that is not <layer>/diagrams/<name>.dbml is refused with the §1.8 message, after the empty and syntax checks', () => {
    const notADiagram = (path: string): Error => thrown(() => parseSubjectAreaDbml(SALES, path)) as Error;
    for (const path of ['gold/sales.dbml', 'tables/gold/fct_order.dbml']) {
      expect(notADiagram(path)).toBeInstanceOf(SubjectAreaValidationError);
      expect(notADiagram(path).message).toBe(`${path} was written by an ERD Studio 1.9 pre-release, whose folder layout 2.0 does not read. Run erd-studio doctor in the project for the steps to convert it again.`);
    }
    expect(notADiagram('gold/tables/gold/x.dbml').message).toBe('gold/tables/gold/x.dbml is a DBML table or relationships file, not a diagram. Open a diagram in gold/diagrams/.');
    expect(notADiagram('gold/relationships/gold.dbml').message).toBe('gold/relationships/gold.dbml is a DBML table or relationships file, not a diagram. Open a diagram in gold/diagrams/.');
    for (const path of ['gold/Diagrams/sales.dbml', 'Gold/diagrams/sales.dbml', 'tables/diagrams/sales.dbml.bak']) {
      expect(notADiagram(path).message).toMatch(/is not a DBML diagram\. ERD Studio diagrams live in <layer>\/diagrams\/<name>\.dbml \(the folder names are lower-case\)\.$/);
    }
    // The empty and syntax checks come first.
    expect((thrown(() => parseSubjectAreaDbml('  \n', 'gold/sales.dbml')) as SubjectAreaFileError).reason).toBe('empty');
    expect((thrown(() => parseSubjectAreaDbml('Project p {\n', 'gold/sales.dbml')) as SubjectAreaFileError).reason).toBe('invalid-dbml');
  });

  it('a newer erd_schema_version is refused; one that is not a whole number too', () => {
    const future = thrown(() => parseSubjectAreaDbml("Project p {\n  erd_schema_version: '8'\n}\n", PATH));
    expect(future).toBeInstanceOf(SubjectAreaValidationError);
    expect((future as Error).message).toBe(`${PATH} has erd_schema_version 8 but this extension only supports up to version 7. Please update the extension.`);
    expect(thrown(() => parseSubjectAreaDbml("Project p {\n  erd_schema_version: 'seven'\n}\n", PATH))).toBeInstanceOf(SubjectAreaValidationError);
  });
});

describe('subjectAreaMembersDbml', () => {
  it('reads the members from the use lines alone, as the full reader reads them', () => {
    expect(subjectAreaMembersDbml(SALES, PATH)).toEqual(['fct_order', 'dim_customer', 'dim_date']);
    expect(subjectAreaMembersDbml(SALES, PATH)).toEqual(parseSubjectAreaDbml(SALES, PATH).members);
  });

  it('is null for text that does not parse, and for a path that is not a diagram\'s', () => {
    expect(subjectAreaMembersDbml("Project p {\nuse { table a } from '../tables/gold/a.dbml'\n", PATH)).toBeNull();
    expect(subjectAreaMembersDbml(SALES, 'gold/sales.dbml')).toBeNull();
  });
});

describe('members with no table file (erd_unlinked_tables, D26) and pending relationships (D27)', () => {
  const MISSING = `Project commercial {
  erd_schema_version: '7'
  erd_unlinked_tables: 'gld_fct_risk_child, gld_fct_risk_parent,,  fct_order , ../escape'
}

use { table fct_order } from '../tables/gold/fct_order.dbml'
use { table gld_dim_project } from '../tables/gold/gld_dim_project.dbml'

Note "n1" {
  '// erd-studio pending: Ref: never.read >? from.a_note'
}

// erd-studio pending: Ref: gld_fct_risk_child.project_id >? gld_dim_project.project_id
//   erd-studio pending: Ref "as of": gld_fct_risk_parent.(a, b) >? gld_dim_project.(a, b)
// erd-studio pending: not a Ref
`;

  it.each(STORAGE_PARSERS)('%s: reads the unlinked members after the use members, and the pending lines as the diagram\'s own relationships', (_label, parser) => {
    const reading = parseSubjectAreaDbml(MISSING, 'gold/diagrams/commercial.dbml', parser);
    expect(reading.members).toEqual(['fct_order', 'gld_dim_project', 'gld_fct_risk_child', 'gld_fct_risk_parent']);
    expect(reading.unlinked).toEqual(['gld_fct_risk_child', 'gld_fct_risk_parent']);
    expect((reading.obj.logical as { models: string[] }).models).toEqual(reading.members);
    expect(reading.uses?.map((u) => u.name)).toEqual(['fct_order', 'gld_dim_project']);
    expect((reading.obj.logical as { relationships: unknown[] }).relationships).toEqual([
      { fromModel: 'gld_fct_risk_child', fromColumn: 'project_id', toModel: 'gld_dim_project', toColumn: 'project_id', cardinality: 'many-to-one' },
      { fromModel: 'gld_fct_risk_parent', fromColumn: 'a', toModel: 'gld_dim_project', toColumn: 'a', cardinality: 'many-to-one', role: 'as of', compositeKey: 'fk_gld_dim_project' },
      { fromModel: 'gld_fct_risk_parent', fromColumn: 'b', toModel: 'gld_dim_project', toColumn: 'b', cardinality: 'many-to-one', role: 'as of', compositeKey: 'fk_gld_dim_project' },
    ]);
    expect(reading.pending?.map((p) => p.line)).toEqual([13, 14]);
    // Not a table name, a member already listed, and a pending line that is not a Ref: warned about, never read.
    expect(reading.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/erd_unlinked_tables names fct_order, which the diagram already lists/),
      expect.stringMatching(/erd_unlinked_tables names '\.\.\/escape', which is not a table name/),
      expect.stringMatching(/^Line 15: the pending relationship `not a Ref`/),
    ]));
    // The diagram still validates as a v5 document, with its own relationships.
    expect(detectSubjectAreaFormat(reading.obj)).toBe('v5');
    expect(() => validateSubjectAreaDocument(reading.obj, 'gold/diagrams/commercial.dbml')).not.toThrow();
  });

  it('subjectAreaMembersDbml lists the unlinked members too, from the AST alone', () => {
    expect(subjectAreaMembersDbml(MISSING, 'gold/diagrams/commercial.dbml')).toEqual(['fct_order', 'gld_dim_project', 'gld_fct_risk_child', 'gld_fct_risk_parent']);
  });

  it.each(STORAGE_PARSERS)('%s: both readers read a double-quoted value and a repeated key alike, and the canvas reader warns about the repeat', (_label, parser) => {
    const use = "use { table a } from '../tables/gold/a.dbml'\n";
    const quoted = `Project p {\n  erd_unlinked_tables: "x, y"\n}\n${use}`;
    expect(parseSubjectAreaDbml(quoted, 'gold/diagrams/p.dbml', parser).members).toEqual(['a', 'x', 'y']);
    expect(subjectAreaMembersDbml(quoted, 'gold/diagrams/p.dbml', parser)).toEqual(['a', 'x', 'y']);
    const twice = `Project p {\n  erd_unlinked_tables: 'x'\n  erd_unlinked_tables: 'y'\n}\n${use}`;
    const reading = parseSubjectAreaDbml(twice, 'gold/diagrams/p.dbml', parser);
    expect(reading.members).toEqual(['a', 'y']);
    expect(subjectAreaMembersDbml(twice, 'gold/diagrams/p.dbml', parser)).toEqual(['a', 'y']);
    expect(reading.warnings).toContainEqual(expect.stringMatching(/names erd_unlinked_tables 2 times; only the last is read/));
  });

  it('a diagram whose members all have no table file is not a dropped-in single-file DBML', () => {
    const reading = parseSubjectAreaDbml("Project p {\n  erd_unlinked_tables: 'a'\n}\n", 'gold/diagrams/p.dbml');
    expect(reading.members).toEqual(['a']);
    expect(reading.holdsOwnTables).toBe(false);
  });
});

describe('parseSubjectAreaDbml: erd_layout (§1.6)', () => {
  const USES = "use { table dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table Fct_Order } from '../tables/gold/Fct_Order.dbml'\n";
  const project = (lines: string[]): string => `Project p {\n  erd_schema_version: '7'\n  erd_layout: '''\n${lines.map((l) => `    ${l}\n`).join('')}  '''\n}\n`;
  const positionsOf = (text: string): Record<string, unknown> => (parseSubjectAreaDbml(text, PATH).obj.viewConfig as { positions: Record<string, unknown> }).positions;

  it('maps lines to members exact first, then case-insensitively; an exact line wins and a variant or unknown name is a stray, kept', () => {
    expect(positionsOf(`${USES}\n${project(['DIM_CUSTOMER 1 2', 'fct_order 3 4'])}`)).toEqual({ dim_customer: { x: 1, y: 2 }, Fct_Order: { x: 3, y: 4 } });
    expect(positionsOf(`${USES}\n${project(['Dim_Customer 9 9', 'dim_customer 1 2', 'gone 5 6'])}`))
      .toEqual({ Dim_Customer: { x: 9, y: 9 }, dim_customer: { x: 1, y: 2 }, gone: { x: 5, y: 6 } });
  });

  it('reads a sticky note\'s box from its note/ line; a note it does not place is placed beside the rest', () => {
    const text = `${USES}\nNote a {\n  'x'\n}\nNote b {\n  'y'\n}\n\n${project(['dim_customer 0 0', 'note/a 400 10 200 100'])}`;
    const annotations = (parseSubjectAreaDbml(text, PATH).obj.viewConfig as { annotations: Array<Record<string, unknown>> }).annotations;
    expect(annotations[0]).toMatchObject({ id: 'a', x: 400, y: 10, width: 200, height: 100 });
    expect(annotations[1]).toMatchObject({ id: 'b', x: 640, y: 0 });
    expect(annotations[1].width).toBeUndefined();
  });

  it('reports a bad line and a repeated key as warnings, at their file lines', () => {
    const text = `${USES}\nProject p {\n  erd_layout: '''\n    dim_customer 1 2\n    not a line\n  '''\n  ERD_LAYOUT: '''\n    dim_customer 9 9\n  '''\n}\n`;
    const reading = parseSubjectAreaDbml(text, PATH);
    expect(reading.layoutProblems?.map((p) => [p.code, p.severity, p.line])).toEqual([
      ['layoutDuplicateKey', 'warning', 9],
      ['layoutBadLine', 'warning', 7],
    ]);
    expect((reading.obj.viewConfig as { positions: unknown }).positions).toEqual({ dim_customer: { x: 1, y: 2 } });
    expect(reading.layoutConflictLine).toBeUndefined();
  });

  it('a git conflict inside erd_layout still reads (best effort): layoutConflictLine and a layoutMergeConflict error', () => {
    const text = `${USES}\nProject p {\n  erd_schema_version: '7'\n  erd_layout: '''\n<<<<<<< HEAD\n    dim_customer 1 2\n=======\n    dim_customer 5 6\n>>>>>>> theirs\n  '''\n}\n`;
    const reading = parseSubjectAreaDbml(text, PATH);
    expect((reading.obj.viewConfig as { positions: unknown }).positions).toEqual({ dim_customer: { x: 1, y: 2 } });
    expect(reading.layoutConflictLine).toBe(7);
    expect(reading.layoutProblems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'layoutMergeConflict', severity: 'error', mergeConflict: true, line: 7 })]));
  });

  it('a conflict where both sides added erd_layout is a merge conflict, not a syntax error', () => {
    const text = `${USES}\nProject p {\n  erd_schema_version: '7'\n<<<<<<< HEAD\n  erd_layout: '''\n    dim_customer 1 2\n  '''\n=======\n  erd_layout: '''\n    dim_customer 3 4\n  '''\n>>>>>>> theirs\n}\n`;
    let err: unknown;
    try { parseSubjectAreaDbml(text, PATH); } catch (e) { err = e; }
    expect(err).toMatchObject({ reason: 'invalid-dbml', mergeConflict: true, transient: false, line: 6 });
  });

  it('a conflict hunk spanning the closing quote of erd_layout (Project first) is a merge conflict', () => {
    const text = `Project p {\n  erd_schema_version: '7'\n  erd_layout: '''\n    dim_customer 1 2\n<<<<<<< HEAD\n  '''\n}\n=======\n    Fct_Order 3 4\n  '''\n}\n>>>>>>> theirs\n${USES}`;
    let err: unknown;
    try { parseSubjectAreaDbml(text, PATH); } catch (e) { err = e; }
    expect(err).toMatchObject({ reason: 'invalid-dbml', mergeConflict: true, transient: false });
  });

  it.each(STORAGE_PARSERS)('a Project first or last reads the same (§1.4) (%s)', (_label, parser) => {
    const notes = "Note n1 {\n  'hello'\n}\n";
    const block = project(['dim_customer 1 2', 'Fct_Order 3 4', 'note/n1 5 6']);
    const last = parseSubjectAreaDbml(`${USES}\n${notes}\n${block}`, PATH, parser);
    const first = parseSubjectAreaDbml(`${block}\n${USES}\n${notes}`, PATH, parser);
    expect(first.obj).toEqual(last.obj);
    expect(first.members).toEqual(last.members);
    expect(last.warnings).toEqual([]);
  });
});
