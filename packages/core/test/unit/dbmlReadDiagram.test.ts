/**
 * `parseSubjectAreaDbml` and `subjectAreaMembersDbml` (§2.5, §4.3 of the
 * native DBML storage spec): a `.dbml` diagram read into the v5 object the
 * rest of core reads, beside its DBML schema version; tolerant of
 * constructs it does not read (blanked, warned about, kept).
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
}

use { table fct_order } from '../tables/gold/fct_order.dbml'
use { table dim_customer } from '../tables/gold/dim_customer.dbml'
use { table dim_date } from '../tables/dim_date.dbml'
use * from '../tables/_relationships.dbml'
use * from '../tables/gold/_relationships.dbml'

Note "3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c" [color: #f59e0b, linked_table: 'fct_order'] {
  'Check the grain with finance'
}

Note "9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f" [color: #3b82f6] {
  ''
}
`;

const LAYOUT = JSON.stringify({
  version: '3.0.0',
  defaultView: {
    tablePositions: [
      { name: 'fct_order', schemaName: 'public', x: 400, y: 200 },
      { name: 'dim_customer', schemaName: 'public', x: 40, y: 40 },
      { name: 'dim_date', schemaName: 'public', x: 40, y: 360 },
    ],
    stickyNoteLayouts: [{ name: '3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', x: 720, y: 40, width: 220, height: 120 }],
  },
});

const PATH = '.erd-studio/gold/sales.dbml';

describe('parseSubjectAreaDbml: the §2.5 mapping', () => {
  it.each(STORAGE_PARSERS)('reads the Project, members, Notes and layout into a v5 object (%s)', (_label, parser) => {
    const reading = parseSubjectAreaDbml(SALES, PATH, LAYOUT, parser);
    expect(reading.schemaVersion).toBe(7);
    expect(reading.writable).toBe(true);
    expect(reading.members).toEqual(['fct_order', 'dim_customer', 'dim_date']);
    expect(reading.useFolders).toEqual(['', 'gold']);
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
        positions: { fct_order: { x: 400, y: 200 }, dim_customer: { x: 40, y: 40 }, dim_date: { x: 40, y: 360 } },
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
    const reading = parseSubjectAreaDbml("use { table a } from '../tables/a.dbml'\n", '.erd-studio/silver/orders.dbml', null);
    expect(reading.obj).toMatchObject({ schemaVersion: 5, domain: 'orders', layer: 'silver', description: '', viewConfig: { positions: {} } });
    expect(reading.schemaVersion).toBe(7);
  });

  it('reads members in order, a table listed twice twice, and accepts use * and a path without .dbml', () => {
    const reading = parseSubjectAreaDbml(`use * from '../tables/a'
use { table b } from '../tables/b.dbml'
use { table a } from '../tables/a.dbml'
use { table _x } from '../tables/_x.dbml'
`, PATH, null);
    expect(reading.members).toEqual(['a', 'b', 'a', '_x']);
    expect(reading.warnings).toEqual([]);
  });

  it('a member is its path\'s stem: semantic-dir-relative and wrong-folder paths, and a specifier naming another table, warn usePathMismatch', () => {
    const reading = parseSubjectAreaDbml(`use { table fct_order } from 'tables/gold/fct_order.dbml'
use { table dim_date } from './dim_date.dbml'
use { table dim_account } from '../tables/gold/dim_customer.dbml'
use { table ok } from '../tables/gold/ok.dbml'
`, PATH, null);
    expect(reading.members).toEqual(['fct_order', 'dim_date', 'dim_customer', 'ok']);
    expect(reading.warnings.filter((w) => w.includes('usePathMismatch')).map((w) => w.slice(0, 7))).toEqual(['Line 1:', 'Line 2:', 'Line 3:']);
    expect(reading.uses!.map((u) => u.resolved)).toEqual(['gold/tables/gold/fct_order.dbml', 'gold/dim_date.dbml', 'tables/gold/dim_customer.dbml', 'tables/gold/ok.dbml']);
  });

  it('a specifier that spells the stem in another case is no mismatch (D2: the file declares Dim_Date); the stem is the member', () => {
    // A path whose case differs from the file on disk needs a directory
    // listing, so core cannot see it; the host and doctor report it (§3.4).
    const reading = parseSubjectAreaDbml(`use { table Dim_Date } from '../tables/dim_date.dbml'
use { table dim_customer } from '../tables/gold/Dim_Customer.dbml'
`, PATH, null);
    expect(reading.members).toEqual(['dim_date', 'Dim_Customer']);
    expect(reading.warnings).toEqual([]);
  });

  it('ignores a use line whose stem is not a safe table name, with a warning', () => {
    const reading = parseSubjectAreaDbml("use * from '../tables/..'\nuse { table a } from '../tables/a.dbml'\n", PATH, null);
    expect(reading.members).toEqual(['a']);
    expect(reading.warnings).toHaveLength(1);
  });

  it('maps any Note colour to the nearest swatch, and leaves an uncoloured Note uncoloured', () => {
    const reading = parseSubjectAreaDbml("Note a [color: #fef3c7] {\n  'x'\n}\nNote b [color: #ff0000] {\n  'y'\n}\nNote c {\n  'z'\n}\n", PATH, null);
    const annotations = (reading.obj.viewConfig as { annotations: Array<{ id: string; color?: string }> }).annotations;
    expect(annotations.map((a) => [a.id, a.color])).toEqual([['a', 'yellow'], ['b', 'orange'], ['c', undefined]]);
  });

  it('a layout file that is not JSON is ignored with a warning', () => {
    const reading = parseSubjectAreaDbml("use { table a } from '../tables/a.dbml'\n", PATH, '{ not json');
    expect(reading.obj.viewConfig).toEqual({ positions: {} });
    expect(reading.warnings.some((w) => w.startsWith('Layout file:'))).toBe(true);
  });

  it('a leading byte-order mark is stripped', () => {
    expect(parseSubjectAreaDbml(`﻿${SALES}`, PATH, null).members).toHaveLength(3);
  });
});

describe('parseSubjectAreaDbml: constructs it does not read (D6)', () => {
  it.each(STORAGE_PARSERS)('a declared Table, Ref and TableGroup are blanked and warned about; the file stays writable (%s)', (_label, parser) => {
    const text = `Project p {
  erd_schema_version: '7'
}
use { table a } from '../tables/a.dbml'
Table local {
  id int
}
Ref: local.id > a.id
TableGroup g {
  local
}
`;
    const reading = parseSubjectAreaDbml(text, PATH, null, parser);
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
    const reading = parseSubjectAreaDbml(text, PATH, null, parser);
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
use { table fct } from '../tables/fct.dbml'
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
    const reading = parseSubjectAreaDbml(text, PATH, null, parser);
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
    const reading = parseSubjectAreaDbml('Table a {\n  id int\n}\nTable b {\n  id int\n}\nRef: a.id > b.id\n', PATH, null);
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
    const err = thrown(() => parseSubjectAreaDbml('\n  \n', PATH, null)) as SubjectAreaFileError;
    expect(err).toBeInstanceOf(SubjectAreaFileError);
    expect(err.reason).toBe('empty');
  });

  it.each(STORAGE_PARSERS)('a syntax error is invalid-dbml, transient, at its line and column (%s)', (_label, parser) => {
    const err = thrown(() => parseSubjectAreaDbml("Project p {\n  Note: 'cut off'\n", PATH, null, parser)) as SubjectAreaFileError;
    expect(err).toBeInstanceOf(SubjectAreaFileError);
    expect(err).toMatchObject({ reason: 'invalid-dbml', transient: true, mergeConflict: false, line: 3, column: 1 });
    expect(err.message).toMatch(/^Invalid DBML in subject area file \.erd-studio\/gold\/sales\.dbml at line 3, column 1: /);
  });

  it('git conflict markers are invalid-dbml with mergeConflict, not transient', () => {
    const text = "Project p {\n  Note: 'x'\n}\n<<<<<<< HEAD\nuse { table a } from '../tables/a.dbml'\n=======\nuse { table b } from '../tables/b.dbml'\n>>>>>>> other\n";
    const err = thrown(() => parseSubjectAreaDbml(text, PATH, null)) as SubjectAreaFileError;
    expect(err).toMatchObject({ reason: 'invalid-dbml', mergeConflict: true, transient: false, line: 4 });
  });

  it('an unquoted Project key is invalid-dbml with the quote hint (every parser rejects it)', () => {
    const err = thrown(() => parseSubjectAreaDbml('Project p {\n  erd_schema_version: 7\n}\n', PATH, null)) as SubjectAreaFileError;
    expect(err.reason).toBe('invalid-dbml');
    expect(err.message).toContain("Quote the value, as in erd_schema_version: '7'.");
  });

  it('a newer erd_schema_version is refused; one that is not a whole number too', () => {
    const future = thrown(() => parseSubjectAreaDbml("Project p {\n  erd_schema_version: '8'\n}\n", PATH, null));
    expect(future).toBeInstanceOf(SubjectAreaValidationError);
    expect((future as Error).message).toBe(`${PATH} has erd_schema_version 8 but this extension only supports up to version 7. Please update the extension.`);
    expect(thrown(() => parseSubjectAreaDbml("Project p {\n  erd_schema_version: 'seven'\n}\n", PATH, null))).toBeInstanceOf(SubjectAreaValidationError);
  });
});

describe('subjectAreaMembersDbml', () => {
  it('reads the members from the use lines alone', () => {
    expect(subjectAreaMembersDbml(SALES)).toEqual(['fct_order', 'dim_customer', 'dim_date']);
  });

  it('is null for text that does not parse', () => {
    expect(subjectAreaMembersDbml("Project p {\nuse { table a } from '../tables/a.dbml'\n")).toBeNull();
  });
});
