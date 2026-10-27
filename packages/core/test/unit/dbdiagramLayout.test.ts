/**
 * The `.dbdiagram` layout file beside a rich DBML export: the shape written,
 * its table names (they must match `toDbmlRich`'s, schema-less tables as
 * `public`), and the tolerant reader — held to the file `dbdiagram pull`
 * wrote from Liam's own diagram (test/dbdiagram-pull/, the showcase fixture
 * pushed to dbdiagram.io) and to junk.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  DBDIAGRAM_LAYOUT_VERSION,
  dbdiagramLayoutFileName,
  readDbdiagramLayout,
  serializeDbdiagramLayout,
  toDbdiagramLayout,
} from '../../src/dbdiagramLayout';
import { toDbmlRich } from '../../src/exportDbmlRich';
import { loadDisplaySubjectArea } from '../../src/loadDisplayDomain';
import type { DisplaySubjectArea } from '../../src/types/display';
import { col, deepFreeze, readDbmlRich, subjectArea, tableDef } from '../exportParsers';

const PULL = path.resolve(__dirname, '../dbdiagram-pull');
const pulledLayout = fs.readFileSync(path.join(PULL, 'silver.dbdiagram'), 'utf-8');
const pulled = JSON.parse(pulledLayout);

async function showcase(): Promise<DisplaySubjectArea> {
  const root = path.resolve(__dirname, '../fixtures/showcase');
  return loadDisplaySubjectArea({
    domainPath: '.erd-studio/silver/showcase.json',
    readFile: async (p) => {
      try {
        return fs.readFileSync(path.join(root, p), 'utf-8');
      } catch {
        return null;
      }
    },
    readOnly: false,
    warn: () => {},
  });
}

describe('toDbdiagramLayout', () => {
  it('writes the shape dbdiagram pull writes, without its own view settings', () => {
    const layout = toDbdiagramLayout(subjectArea([tableDef('a', [col('id')])], [], { viewConfig: { positions: { a: { x: 1, y: 2 } } } }));
    expect(layout).toEqual({
      version: '3.0.0',
      gridEnabling: false,
      currentViewName: null,
      defaultView: {
        detailLevel: 'All',
        relationshipMode: 'All',
        tablePositions: [{ name: 'a', schemaName: 'public', x: 1, y: 2 }],
        tableGroupCollapseStates: [],
        stickyNoteLayouts: [],
        referencePaths: [],
      },
      views: {},
    });
    expect(DBDIAGRAM_LAYOUT_VERSION).toBe(pulled.version);
    // The same keys, in the same order, as the pulled file, less its dark-mode switch.
    expect(Object.keys(layout)).toEqual(Object.keys(pulled).filter((k) => k !== 'darkMode'));
    expect(Object.keys(layout.defaultView)).toEqual(Object.keys(pulled.defaultView));
  });

  it('lists only tables the export writes and the canvas placed, in export order', () => {
    const area = subjectArea([tableDef('b', [col('id')], { schema: 'gold' }), tableDef('a', []), tableDef('c', [col('id')]), tableDef('', [col('id')])], [], {
      viewConfig: { positions: { a: { x: 10, y: 20 }, b: { x: 30, y: 40 }, gone: { x: 0, y: 0 }, '': { x: 5, y: 5 } } },
    });
    expect(toDbdiagramLayout(area).defaultView.tablePositions).toEqual([
      { name: 'b', schemaName: 'gold', x: 30, y: 40 },
      { name: 'a', schemaName: 'public', x: 10, y: 20 },
    ]);
  });

  it('finds a position spelled in another case, prefers the exact one, and skips a malformed one', () => {
    const area = subjectArea([tableDef('Dim', [col('id')]), tableDef('fct', [col('id')]), tableDef('bad', [col('id')]), tableDef('worse', [col('id')])], [], {
      viewConfig: {
        positions: { dim: { x: 1, y: 1 }, Dim: { x: 2, y: 2 }, FCT: { x: 3, y: 3 }, bad: { x: '4', y: 4 }, worse: null } as never,
      },
    });
    expect(toDbdiagramLayout(area).defaultView.tablePositions.map((p) => [p.name, p.x])).toEqual([
      ['Dim', 2],
      ['fct', 3],
    ]);
  });

  it('rounds coordinates to two decimals and keeps them numbers', () => {
    const area = subjectArea([tableDef('a', [col('id')]), tableDef('b', [col('id')])], [], {
      viewConfig: { positions: { a: { x: 540.330078125, y: -202.669921875 }, b: { x: -0.001, y: 1e-9 } } },
    });
    const [a, b] = toDbdiagramLayout(area).defaultView.tablePositions;
    expect([a.x, a.y]).toEqual([540.33, -202.67]);
    expect(Object.is(b.x, 0) && Object.is(b.y, 0)).toBe(true);
    expect(serializeDbdiagramLayout(area)).not.toContain('-0');
  });

  it('never throws, and gives an empty layout for anything it cannot read', () => {
    for (const area of [null, {}, { models: 'x', viewConfig: { positions: [] } }, { models: [{ name: 'a' }], viewConfig: 'x' }]) {
      expect(toDbdiagramLayout(area as unknown as DisplaySubjectArea).defaultView.tablePositions).toEqual([]);
    }
  });

  it('serialises as two-space JSON with a final line break, deterministically and without touching its input', () => {
    const area = deepFreeze(subjectArea([tableDef('a', [col('id')])], [], { viewConfig: { positions: { a: { x: 1.5, y: 2 } } } }));
    const text = serializeDbdiagramLayout(area);
    expect(text).toBe(JSON.stringify(toDbdiagramLayout(area), null, 2) + '\n');
    expect(serializeDbdiagramLayout(JSON.parse(JSON.stringify(area)))).toBe(text);
  });

  it('names the layout file after the rich export it sits beside', () => {
    expect(dbdiagramLayoutFileName({ domain: 'silver' })).toBe('silver.dbdiagram');
    expect(dbdiagramLayoutFileName({ domain: 'a/b' })).toBe('a-b.dbdiagram');
    expect(dbdiagramLayoutFileName({ domain: '' })).toBe('diagram.dbdiagram');
  });
});

describe('the layout against the file dbdiagram pull wrote', () => {
  it('names the showcase tables exactly as the pulled file does, given the pulled positions', async () => {
    const area = await showcase();
    const positions = Object.fromEntries(pulled.defaultView.tablePositions.map((p: { name: string; x: number; y: number }) => [p.name, { x: p.x, y: p.y }]));
    const ours = toDbdiagramLayout({ ...area, viewConfig: { ...area.viewConfig, positions } }).defaultView.tablePositions;
    const key = (p: { name: string; schemaName: string }) => `${p.schemaName}.${p.name}`;
    expect(ours.map(key)).toEqual(pulled.defaultView.tablePositions.map(key));
    ours.forEach((p, i) => {
      expect(p.x).toBeCloseTo(pulled.defaultView.tablePositions[i].x, 1);
      expect(p.y).toBeCloseTo(pulled.defaultView.tablePositions[i].y, 1);
    });
  });

  it('writes Refs whose tables and schemas are those of the pulled reference paths', async () => {
    const read = readDbmlRich(toDbmlRich(await showcase()));
    const refs = read.refs.map((r) => r.ends.map((e) => `${e[0]}.${e[1]}.${e[2].join(',')}`).join(' -> ')).sort();
    const paths = pulled.defaultView.referencePaths
      .map(
        (p: { firstSchemaName: string; firstTableName: string; firstFieldNames: string[]; secondSchemaName: string; secondTableName: string; secondFieldNames: string[] }) =>
          `${p.firstSchemaName}.${p.firstTableName}.${p.firstFieldNames.join(',')} -> ${p.secondSchemaName}.${p.secondTableName}.${p.secondFieldNames.join(',')}`,
      )
      .sort();
    expect(refs).toEqual(paths);
    // And every table it positions is a table the export writes.
    const tables = new Set(read.tables.map((t) => `${t.schema}.${t.name}`));
    for (const p of pulled.defaultView.tablePositions) expect(tables.has(`${p.schemaName}.${p.name}`)).toBe(true);
  });
});

describe('readDbdiagramLayout', () => {
  it('reads the pulled file whole', () => {
    expect(readDbdiagramLayout(pulledLayout)).toEqual({ tables: pulled.defaultView.tablePositions, stickies: [], problems: [] });
  });

  it('reads back what serializeDbdiagramLayout writes', () => {
    const area = subjectArea([tableDef('a', [col('id')], { schema: 'gold' }), tableDef('b', [col('id')])], [], {
      viewConfig: { positions: { a: { x: 1, y: 2 }, b: { x: 3.25, y: -4 } } },
    });
    expect(readDbdiagramLayout(serializeDbdiagramLayout(area))).toEqual({
      tables: toDbdiagramLayout(area).defaultView.tablePositions,
      stickies: [],
      problems: [],
    });
  });

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
