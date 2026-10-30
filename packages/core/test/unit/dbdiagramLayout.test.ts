/**
 * A DBML diagram's `.dbdiagram` layout file (native storage, until positions
 * move into `erd_layout`): the tolerant reader, held to junk, and the
 * text-splicing writer.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  DBDIAGRAM_LAYOUT_VERSION,
  DbdiagramLayoutRefused,
  editDiagramLayout,
  placeUnlaidNotes,
  readDbdiagramLayout,
  stickyLayoutsOf,
} from '../../src/dbdiagramLayout';

/** A layout file in the shape dbdiagram writes, with keys ERD Studio does not own. */
const pulledLayout = JSON.stringify({
  version: '3.0.0',
  darkMode: true,
  gridEnabling: false,
  currentViewName: null,
  defaultView: {
    detailLevel: 'All',
    relationshipMode: 'All',
    tablePositions: [
      { name: 'dim_task', schemaName: 'silver', x: -202.669921875, y: 159 },
      { name: 'fct_order', schemaName: 'public', x: 540.330078125, y: 557 },
    ],
    tableGroupCollapseStates: [],
    stickyNoteLayouts: [],
    referencePaths: [{ firstTableName: 'fct_order', firstSchemaName: 'public', checkPoints: [] }],
  },
  views: {},
}, null, 2) + '\n';

describe('readDbdiagramLayout', () => {
  it.each([
    ['', 'The layout file is not JSON.'],
    ['{ "version": "3.0.0", ', 'The layout file is not JSON.'],
    ['null', 'The layout file is not a JSON object.'],
    ['[]', 'The layout file is not a JSON object.'],
    ['"text"', 'The layout file is not a JSON object.'],
    ['{"version": "3.0.0"}', 'The layout file has no defaultView, so it places nothing.'],
    ['{"version": "3.0.0", "defaultView": []}', 'The layout file has no defaultView, so it places nothing.'],
  ])('reports %j as unreadable without throwing', (text, problem) => {
    const reading = readDbdiagramLayout(text);
    expect(reading.tables).toEqual([]);
    expect(reading.stickies).toEqual([]);
    expect(reading.problems).toContain(problem);
  });

  it('survives input that is not text at all', () => {
    for (const value of [undefined, null, 42, {}]) {
      expect(() => readDbdiagramLayout(value as unknown as string)).not.toThrow();
      expect(readDbdiagramLayout(value as unknown as string).problems).toEqual(['The layout file is not JSON.']);
    }
  });

  it('reads another version anyway, and says so', () => {
    const view = { tablePositions: [{ name: 'a', schemaName: 'public', x: 1, y: 2 }] };
    expect(readDbdiagramLayout(JSON.stringify({ version: '4.0.0', defaultView: view }))).toEqual({
      tables: [{ name: 'a', schemaName: 'public', x: 1, y: 2 }],
      stickies: [],
      problems: ['The layout file has version "4.0.0", not 3.x (read anyway).'],
    });
    expect(readDbdiagramLayout(JSON.stringify({ version: 3, defaultView: view })).problems).toEqual([]);
    expect(readDbdiagramLayout(JSON.stringify({ version: '3.1.4', defaultView: view })).problems).toEqual([]);
    expect(readDbdiagramLayout(JSON.stringify({ defaultView: view })).problems).toEqual(['The layout file has no version (read anyway).']);
  });

  it('skips the table positions it cannot read, keeps the first of a repeat, and defaults the schema', () => {
    const text = JSON.stringify({
      version: '3.0.0',
      defaultView: {
        tablePositions: [
          { name: 'a', schemaName: 'silver', x: 1, y: 2, extra: true },
          { name: 'a', schemaName: 'silver', x: 9, y: 9 },
          { name: 'a', x: 3, y: 4 },
          { name: 'b', schemaName: '', x: 5, y: 6 },
          { name: '', x: 1, y: 1 },
          { name: 'c', x: '1', y: 1 },
          { name: 'd', y: 1 },
          null,
          'e',
        ],
      },
    });
    expect(readDbdiagramLayout(text)).toEqual({
      tables: [
        { name: 'a', schemaName: 'silver', x: 1, y: 2 },
        { name: 'a', schemaName: 'public', x: 3, y: 4 },
        { name: 'b', schemaName: 'public', x: 5, y: 6 },
      ],
      stickies: [],
      problems: [
        '5 table positions have no name or no numeric x and y, so they were skipped.',
        '1 table is placed more than once; the first place is used.',
      ],
    });
  });

  it('says so when a list is not a list', () => {
    const reading = readDbdiagramLayout(JSON.stringify({ version: '3.0.0', defaultView: { tablePositions: {}, stickyNoteLayouts: 'x' } }));
    expect(reading.problems).toEqual([
      'Its tablePositions is not a list, so no table is placed.',
      'Its stickyNoteLayouts is not a list, so no sticky note is placed.',
    ]);
  });

  it('reads sticky-note layouts loosely', () => {
    const text = JSON.stringify({
      version: '3.0.0',
      defaultView: {
        tablePositions: [],
        stickyNoteLayouts: [
          { name: 'sticky_1', x: 10, y: 20, width: 200, height: 80, colour: 'ignored' },
          { name: 'sticky_2', x: 1, y: 2, width: -5, height: '9' },
          { name: 'sticky_1', x: 99, y: 99 },
          { id: 'no-name', x: 1, y: 1 },
        ],
      },
    });
    expect(readDbdiagramLayout(text)).toEqual({
      tables: [],
      stickies: [
        { name: 'sticky_1', x: 10, y: 20, width: 200, height: 80 },
        { name: 'sticky_2', x: 1, y: 2 },
      ],
      problems: ['1 sticky-note layout was not in a shape ERD Studio reads, so it was skipped.'],
    });
  });

  it('accepts a byte-order mark', () => {
    expect(readDbdiagramLayout('\uFEFF' + pulledLayout).problems).toEqual([]);
  });
});

describe('editDiagramLayout (a DBML diagram\'s layout file)', () => {
  const positions = { fct_order: { x: 400, y: 200.123 }, dim_customer: { x: 40, y: 40 } };
  const stickies = [
    { name: '3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', x: 720, y: 40, width: 220, height: 120 },
    { name: '9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f', x: 720, y: 200 },
  ];

  it('creates a file only when there is something to place', () => {
    expect(editDiagramLayout(null, {}, [])).toBeNull();
    const created = editDiagramLayout(null, positions, stickies)!;
    expect(created.endsWith('}\n')).toBe(true);
    const parsed = JSON.parse(created);
    expect(parsed.version).toBe(DBDIAGRAM_LAYOUT_VERSION);
    expect(parsed.defaultView.tablePositions).toEqual([
      { name: 'fct_order', schemaName: 'public', x: 400, y: 200.12 },
      { name: 'dim_customer', schemaName: 'public', x: 40, y: 40 },
    ]);
    expect(parsed.defaultView.stickyNoteLayouts).toEqual(stickies);
    expect(editDiagramLayout(null, {}, [stickies[1]])).not.toBeNull();
  });

  it('returns null when both lists are unchanged, and a file it wrote round-trips byte for byte', () => {
    const created = editDiagramLayout(null, positions, stickies)!;
    expect(editDiagramLayout(created, positions, stickies)).toBeNull();
    // Reformatted by hand but the same lists: still no write.
    expect(editDiagramLayout(JSON.stringify(JSON.parse(created)), positions, stickies)).toBeNull();
    // Sub-pixel noise beyond two decimals is no change.
    expect(editDiagramLayout(created, { ...positions, fct_order: { x: 400.001, y: 200.1249 } }, stickies)).toBeNull();
    const moved = editDiagramLayout(created, { ...positions, fct_order: { x: 500, y: 200 } }, stickies)!;
    expect(JSON.parse(moved).defaultView.tablePositions[0]).toEqual({ name: 'fct_order', schemaName: 'public', x: 500, y: 200 });
    expect(editDiagramLayout(moved, { ...positions, fct_order: { x: 500, y: 200 } }, stickies)).toBeNull();
  });

  it('counts a missing list or a missing defaultView as empty, so a no-op edit writes nothing', () => {
    const noStickies = '{"version":"3.0.0","defaultView":{"tablePositions":[{"name":"a","schemaName":"public","x":1,"y":2}]}}';
    expect(editDiagramLayout(noStickies, { a: { x: 1, y: 2 } }, [])).toBeNull();
    const noPositions = '{"version":"3.0.0","defaultView":{"stickyNoteLayouts":[{"name":"n1","x":5,"y":6}]}}';
    expect(editDiagramLayout(noPositions, {}, [{ name: 'n1', x: 5, y: 6 }])).toBeNull();
    expect(editDiagramLayout('{"version":"3.0.0","defaultView":{}}', {}, [])).toBeNull();
    expect(editDiagramLayout('{"version":"3.0.0"}', {}, [])).toBeNull();
    expect(editDiagramLayout('{"version":"3.0.0","defaultView":null}', {}, [])).toBeNull();
    // A real change still writes; the missing list stays missing while it holds nothing.
    const moved = JSON.parse(editDiagramLayout(noStickies, { a: { x: 3, y: 2 } }, [])!);
    expect(moved.defaultView.tablePositions).toEqual([{ name: 'a', schemaName: 'public', x: 3, y: 2 }]);
    expect(moved.defaultView.stickyNoteLayouts).toBeUndefined();
    const placed = JSON.parse(editDiagramLayout('{"version":"3.0.0"}', { a: { x: 1, y: 2 } }, [])!);
    expect(placed.defaultView.tablePositions).toEqual([{ name: 'a', schemaName: 'public', x: 1, y: 2 }]);
  });

  it('keeps every key it does not own, as parsed', () => {
    const edited = editDiagramLayout(pulledLayout, positions, stickies)!;
    const before = JSON.parse(pulledLayout);
    const after = JSON.parse(edited);
    expect(after.defaultView.tablePositions).toHaveLength(2);
    expect(after.defaultView.stickyNoteLayouts).toEqual(stickies);
    delete before.defaultView.tablePositions;
    delete before.defaultView.stickyNoteLayouts;
    delete after.defaultView.tablePositions;
    delete after.defaultView.stickyNoteLayouts;
    expect(after).toEqual(before);
    const custom = JSON.stringify({ version: '3.0.0', team: { owner: 'x' }, defaultView: { detailLevel: 'Keys', extra: [1, 2] } });
    const out = JSON.parse(editDiagramLayout(custom, positions, [])!);
    expect(out.team).toEqual({ owner: 'x' });
    expect(out.defaultView.detailLevel).toBe('Keys');
    expect(out.defaultView.extra).toEqual([1, 2]);
    expect(out.defaultView.stickyNoteLayouts).toBeUndefined();
  });

  it('refuses a file that is not a JSON object, never regenerating it', () => {
    for (const bad of ['{not json', '[]', '"x"', '42', 'null', '']) {
      expect(() => editDiagramLayout(bad, positions, stickies)).toThrow(DbdiagramLayoutRefused);
    }
  });

  it('accepts a byte-order mark on the old text', () => {
    const created = editDiagramLayout(null, positions, stickies)!;
    expect(editDiagramLayout('﻿' + created, positions, stickies)).toBeNull();
  });

  describe('keeps the file\'s own formatting, so moving one table is a small diff', () => {
    const file = {
      version: '3.0.0',
      gridEnabling: false,
      currentViewName: null,
      defaultView: {
        detailLevel: 'All',
        relationshipMode: 'All',
        tablePositions: [
          { name: 'dim_customer', schemaName: 'public', x: 40, y: 40 },
          { name: 'fct_order', schemaName: 'public', x: 400, y: 200 },
          { name: 'dim_date', schemaName: 'public', x: 40, y: 400 },
        ],
        tableGroupCollapseStates: [],
        stickyNoteLayouts: [],
        referencePaths: [],
      },
      views: {},
    };
    const placed = { dim_customer: { x: 40, y: 40 }, fct_order: { x: 400, y: 200 }, dim_date: { x: 40, y: 400 } };
    const moved = { ...placed, fct_order: { x: 520, y: 200 } };
    const changedLines = (a: string, b: string): number => {
      const la = a.split('\n');
      const lb = b.split('\n');
      expect(lb).toHaveLength(la.length);
      return la.filter((line, i) => line !== lb[i]).length;
    };

    it('compact on one line, with no final line break: stays compact, with none', () => {
      const compact = JSON.stringify(file);
      expect(editDiagramLayout(compact, placed, [])).toBeNull();
      const out = editDiagramLayout(compact, moved, [])!;
      expect(out).toBe(compact.replace('"x":400', '"x":520'));
    });

    it('four-space and tab indents keep their indent and final line break', () => {
      for (const indent of ['    ', '\t']) {
        const text = JSON.stringify(file, null, indent) + '\n';
        expect(editDiagramLayout(text, placed, [])).toBeNull();
        const out = editDiagramLayout(text, moved, [])!;
        expect(changedLines(text, out)).toBe(1);
        expect(out).toBe(text.replace(`"x": 400`, `"x": 520`));
      }
    });

    it('no final line break stays without one; CRLF stays CRLF; a byte-order mark stays', () => {
      const bare = JSON.stringify(file, null, 2);
      expect(editDiagramLayout(bare, moved, [])).toBe(bare.replace('"x": 400', '"x": 520'));
      const crlf = '﻿' + JSON.stringify(file, null, 2).replace(/\n/g, '\r\n') + '\r\n';
      expect(editDiagramLayout(crlf, placed, [])).toBeNull();
      expect(editDiagramLayout(crlf, moved, [])).toBe(crlf.replace('"x": 400', '"x": 520'));
    });

    it('keeps the file\'s table order, its entries\' key order and keys it does not own', () => {
      const own = {
        ...file,
        defaultView: {
          ...file.defaultView,
          tablePositions: [
            { x: 40, y: 400, name: 'dim_date', schemaName: 'public', color: '#fff' },
            { schemaName: 'public', name: 'fct_order', x: 400, y: 200 },
            { name: 'dim_customer', schemaName: 'public', x: 40, y: 40 },
          ],
        },
      };
      const text = JSON.stringify(own, null, 2) + '\n';
      // Same places in another order: no write.
      expect(editDiagramLayout(text, placed, [])).toBeNull();
      const out = editDiagramLayout(text, moved, [])!;
      expect(changedLines(text, out)).toBe(1);
      // A table placed for the first time is appended; one no longer placed is dropped.
      const grown = JSON.parse(editDiagramLayout(text, { fct_order: { x: 400, y: 200 }, dim_date: { x: 40, y: 400 }, dim_store: { x: 9, y: 9 } }, [])!);
      expect(grown.defaultView.tablePositions).toEqual([
        { x: 40, y: 400, name: 'dim_date', schemaName: 'public', color: '#fff' },
        { schemaName: 'public', name: 'fct_order', x: 400, y: 200 },
        { name: 'dim_store', schemaName: 'public', x: 9, y: 9 },
      ]);
    });

    it('a sticky note that loses its size loses the size keys, and keeps the rest', () => {
      const text = JSON.stringify({ ...file, defaultView: { ...file.defaultView, stickyNoteLayouts: [{ name: 'n1', x: 1, y: 2, width: 200, height: 100, colour: 'y' }] } }, null, 2) + '\n';
      const out = JSON.parse(editDiagramLayout(text, placed, [{ name: 'n1', x: 1, y: 2 }])!);
      expect(out.defaultView.stickyNoteLayouts).toEqual([{ name: 'n1', x: 1, y: 2, colour: 'y' }]);
    });
  });

  describe('edits the text, so a file in mixed styles changes only the lines that moved', () => {
    // The repo's own native fixture: one-line entries inside an indented file (the style the harness shows assistants).
    const NATIVE = path.resolve(__dirname, '../../../../test/fixtures/dbml-native/.erd-studio/gold/sales.dbdiagram');
    const native = fs.readFileSync(NATIVE, 'utf-8');
    const reading = readDbdiagramLayout(native);
    const nativePositions = Object.fromEntries(reading.tables.map((t) => [t.name, { x: t.x, y: t.y }]));
    const diffLines = (a: string, b: string): string[] => {
      const la = a.split('\n');
      const lb = b.split('\n');
      expect(lb).toHaveLength(la.length);
      return lb.filter((line, i) => line !== la[i]);
    };

    it('moving one table in the native fixture changes exactly its one line, in its one-line style', () => {
      expect(editDiagramLayout(native, nativePositions, reading.stickies)).toBeNull();
      const out = editDiagramLayout(native, { ...nativePositions, fct_order: { x: 410, y: 200 } }, reading.stickies)!;
      expect(diffLines(native, out)).toEqual(['      { "name": "fct_order", "schemaName": "public", "x": 410, "y": 200 },']);
    });

    it('moving a sticky note changes its one line; resizing one adds its size on that line', () => {
      const [a, b] = reading.stickies;
      const out = editDiagramLayout(native, nativePositions, [a, { ...b, x: 1200, width: 100 }])!;
      expect(diffLines(native, out)).toEqual(['      { "name": "9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f", "x": 1200, "y": 200, "width": 100 }']);
    });

    it('a new table is appended in the list\'s own one-line style; a removed one takes only its line', () => {
      const grown = editDiagramLayout(native, { ...nativePositions, dim_store: { x: 9, y: 9 } }, reading.stickies)!;
      expect(grown).toBe(native.replace(
        '"x": 760, "y": 400 }\n',
        '"x": 760, "y": 400 },\n      { "name": "dim_store", "schemaName": "public", "x": 9, "y": 9 }\n',
      ));
      const { bridge_empty: _gone, ...fewer } = nativePositions;
      const shrunk = editDiagramLayout(native, fewer, reading.stickies)!;
      expect(shrunk).toBe(native.replace(
        ',\n      { "name": "bridge_empty", "schemaName": "public", "x": 760, "y": 400 }\n',
        '\n',
      ));
    });

    it('an emptied list is written [], and an empty list gains entries in the other list\'s style', () => {
      const cleared = editDiagramLayout(native, nativePositions, [])!;
      expect(JSON.parse(cleared).defaultView.stickyNoteLayouts).toEqual([]);
      expect(cleared).toContain('"stickyNoteLayouts": [],');
      const refilled = editDiagramLayout(cleared, nativePositions, reading.stickies)!;
      expect(refilled).toBe(native);
    });

    it('a missing sticky list stays missing while empty, and is added as defaultView\'s last key when needed', () => {
      const hand = '{\n  "defaultView": {\n    "tablePositions": [\n      { "name": "a", "schemaName": "public", "x": 1, "y": 2 }\n    ]\n  }\n}\n';
      expect(editDiagramLayout(hand, { a: { x: 3, y: 2 } }, [])).toBe(hand.replace('"x": 1', '"x": 3'));
      const noted = editDiagramLayout(hand, { a: { x: 1, y: 2 } }, [{ name: 'n1', x: 5, y: 6 }])!;
      expect(noted).toBe(
        '{\n  "defaultView": {\n    "tablePositions": [\n      { "name": "a", "schemaName": "public", "x": 1, "y": 2 }\n    ],\n' +
          '    "stickyNoteLayouts": [\n      { "name": "n1", "x": 5, "y": 6 }\n    ]\n  }\n}\n',
      );
    });
  });

  it('keeps an unmoved entry\'s own schema name and unrounded coordinates when another table moves', () => {
    const text = JSON.stringify({ defaultView: { tablePositions: [
      { name: 'a', schemaName: 'silver', x: 1.23456, y: 2 },
      { name: 'b', schemaName: 'public', x: 10, y: 20 },
    ], stickyNoteLayouts: [] } }, null, 2) + '\n';
    const out = JSON.parse(editDiagramLayout(text, { a: { x: 1.23456, y: 2 }, b: { x: 11, y: 20 } }, [])!);
    expect(out.defaultView.tablePositions).toEqual([
      { name: 'a', schemaName: 'silver', x: 1.23456, y: 2 },
      { name: 'b', schemaName: 'public', x: 11, y: 20 },
    ]);
  });

  it('read(edit(x)) gives back the positions and the sticky layouts', () => {
    const text = editDiagramLayout(null, positions, stickies)!;
    const reading = readDbdiagramLayout(text);
    expect(reading.problems).toEqual([]);
    expect(Object.fromEntries(reading.tables.map((t) => [t.name, { x: t.x, y: t.y }]))).toEqual({
      fct_order: { x: 400, y: 200.12 },
      dim_customer: { x: 40, y: 40 },
    });
    expect(reading.stickies).toEqual(stickies);
  });

  it('stickyLayoutsOf writes a size only when it is set and positive', () => {
    expect(stickyLayoutsOf([
      { id: 'a', x: 1.234, y: 2, width: 200, height: 0 },
      { id: 'b', x: 3, y: 4 },
      { id: 'c', x: 5, y: 6, width: -1, height: 90.555 },
    ])).toEqual([
      { name: 'a', x: 1.23, y: 2, width: 200 },
      { name: 'b', x: 3, y: 4 },
      { name: 'c', x: 5, y: 6, height: 90.56 },
    ]);
    expect(stickyLayoutsOf(undefined)).toEqual([]);
  });
});

describe('placeUnlaidNotes', () => {
  const positions = { a: { x: 0, y: 100 }, b: { x: 600, y: 300 } };
  const laid = [{ name: 'n1', x: 900, y: 50, width: 200 }];

  it('places only notes without a layout, in one column right of everything, 40 px apart, in file order', () => {
    const placed = placeUnlaidNotes(['n1', 'n2', 'n3'], positions, laid);
    expect(Object.keys(placed)).toEqual(['n2', 'n3']);
    // Right edge: max(600 + 280, 900 + 200) = 1100, plus the 40 px gap.
    expect(placed.n2).toEqual({ x: 1140, y: 50 });
    expect(placed.n3).toEqual({ x: 1140, y: 50 + 80 + 40 });
  });

  it('is deterministic', () => {
    expect(placeUnlaidNotes(['x', 'y'], positions, laid)).toEqual(placeUnlaidNotes(['x', 'y'], positions, laid));
  });

  it('never overlaps a laid-out table or note', () => {
    const placed = placeUnlaidNotes(['p', 'q', 'r', 's'], positions, laid);
    const boxes = [
      ...Object.values(positions).map((p) => ({ x: p.x, y: p.y, w: 280, h: 200 })),
      ...laid.map((l) => ({ x: l.x, y: l.y, w: l.width ?? 160, h: 80 })),
    ];
    for (const note of Object.values(placed)) {
      for (const box of boxes) {
        const apart = note.x >= box.x + box.w || note.x + 160 <= box.x || note.y >= box.y + box.h || note.y + 80 <= box.y;
        expect(apart).toBe(true);
      }
    }
  });

  it('starts at the origin on an empty canvas, and places a repeated id once', () => {
    expect(placeUnlaidNotes(['a', 'a', 'b'], {}, [])).toEqual({ a: { x: 0, y: 0 }, b: { x: 0, y: 120 } });
    expect(placeUnlaidNotes([], positions, laid)).toEqual({});
  });
});
