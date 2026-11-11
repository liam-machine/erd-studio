// @vitest-environment jsdom
/**
 * The three exporters on a diagram that shows two tables of one name from
 * different schema folders (packages/core/test/fixtures/dbml/same-name-two-schemas: bqs and ccc,
 * each with addresse and kunde). Core draws them as `bqs.addresse` and
 * `ccc.addresse` with `tableName: 'addresse'` beside; the exports write every
 * table (none is left out because its written name repeats): DBML as `Table
 * bqs.addresse` and `Table ccc.addresse`, rich DBML the same with the
 * diagram's names in `erd_layout` and `linked_table`, Mermaid with the
 * diagram's names as entities, which Mermaid 10.0.0 and the current release
 * both read. Every other export golden stays byte-identical (the export
 * golden test and the identity guard pin them).
 *
 * Goldens (packages/core/test/fixtures/golden/same-name-two-schemas.kunden.*):
 * regenerate with UPDATE_GOLDEN=1 for an intended change.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { loadDisplaySubjectArea } from '../../src/loadDisplayDomain';
import { DIAGRAM_EXPORT_FORMATS, exportDiagram } from '../../src/exportDiagram';
import { toDbml } from '../../src/exportDbml';
import { toDbmlRich } from '../../src/exportDbmlRich';
import { toMermaid } from '../../src/exportMermaid';
import { dbmlStorageReader, readErdLayoutDbml } from '../../src/dbml/index';
import type { DisplayRelationship, DisplaySubjectArea } from '../../src/types/display';
import {
  MERMAID_LOAD_TIMEOUT_MS,
  col,
  deepFreeze,
  goldenFileName,
  loadMermaidParsers,
  parseMermaid,
  readDbmlEverywhere,
  readDbmlRich,
  subjectArea,
  tableDef,
} from '../exportParsers';

beforeAll(loadMermaidParsers, MERMAID_LOAD_TIMEOUT_MS);

const UPDATE = process.env.UPDATE_GOLDEN === '1';
const TWINS = path.resolve(__dirname, '../fixtures/dbml/same-name-two-schemas');
const GOLDEN_DIR = path.resolve(__dirname, '../fixtures/golden');

function load(diagram: string): Promise<DisplaySubjectArea> {
  return loadDisplaySubjectArea({
    domainPath: `.erd-studio/bronze/diagrams/${diagram}.dbml`,
    readFile: async (p) => {
      try {
        return fs.readFileSync(path.join(TWINS, p), 'utf-8');
      } catch {
        return null;
      }
    },
    readOnly: false,
    warn: () => {},
    dbml: dbmlStorageReader,
  });
}

/** A relationship between two diagram names (which may hold a dot, so never split one). */
function link(fromModel: string, fromColumn: string, toModel: string, toColumn: string): DisplayRelationship {
  return { fromModel, fromColumn, toModel, toColumn, cardinality: 'many-to-one' };
}

const tableNames = (tables: Array<{ schema: string; name: string }>): string[] => tables.map((t) => `${t.schema}.${t.name}`).sort();

describe('a diagram with both tables of each name (kunden)', () => {
  it.each(DIAGRAM_EXPORT_FORMATS)('exports %s as its golden', async (format) => {
    const display = await load('kunden');
    const text = exportDiagram(display, format);
    const golden = path.join(GOLDEN_DIR, goldenFileName('same-name-two-schemas.kunden', format));
    if (UPDATE) fs.writeFileSync(golden, text);
    expect(text).toBe(fs.readFileSync(golden, 'utf-8'));
  });

  it('writes Table bqs.addresse and Table ccc.addresse in DBML every pinned parser reads alike, with every Ref on its own table', async () => {
    const display = await load('kunden');
    const text = toDbml(display);
    expect(text).not.toContain('is not exported');
    const read = readDbmlEverywhere(text);
    expect(tableNames(read.tables)).toEqual(['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde']);
    expect(read.tables.find((t) => t.schema === 'ccc' && t.name === 'addresse')!.fields.map((f) => f.name)).toEqual(['id', 'street', 'city', 'postcode']);
    expect(read.refs.map((r) => r.ends.map(([schema, table, columns]) => `${schema}.${table}.${columns.join(',')}`).join(' > ')).sort()).toEqual([
      'bqs.kunde.addresse_id > bqs.addresse.id',
      'ccc.addresse.id > bqs.addresse.id',
      'ccc.kunde.addresse_id > ccc.addresse.id',
    ]);
  });

  it('writes the same tables in rich DBML, placed under the names the diagram calls them', async () => {
    const display = await load('kunden');
    const text = toDbmlRich(display);
    const read = readDbmlRich(text);
    expect(tableNames(read.tables)).toEqual(['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde']);
    expect(read.groups.map((g) => g.tables)).toEqual([['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde']]);
    expect(read.refs).toHaveLength(3);
    // erd_layout, like a stored diagram's: each table under its diagram name, each of which is a table the export writes.
    const layout = readErdLayoutDbml(text)!;
    expect(layout.problemsAt).toEqual([]);
    expect(Object.keys(layout.positions).sort()).toEqual(tableNames(read.tables));
    expect(layout.positions['ccc.addresse']).toEqual(display.viewConfig.positions!['ccc.addresse']);
    expect(read.notes.map((n) => n.properties.linked_table)).toEqual(['ccc.addresse']);
  });

  it('names the Mermaid entities as the diagram does, which Mermaid 10.0.0 and the current release read', async () => {
    const display = await load('kunden');
    const parsed = await parseMermaid(toMermaid(display));
    expect(parsed.entities.map((e) => e.name).sort()).toEqual(['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde']);
    expect(parsed.relationships.map((r) => `${r.from} > ${r.to}`).sort()).toEqual([
      'bqs.kunde > bqs.addresse',
      'ccc.addresse > bqs.addresse',
      'ccc.kunde > ccc.addresse',
    ]);
  });

  it('exports the 2.0.2 copy of the diagram (bare layout lines) with every table too', async () => {
    const display = await load('kunden-bare');
    expect(tableNames(readDbmlEverywhere(toDbml(display)).tables)).toEqual(['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde']);
    expect(tableNames(readDbmlRich(toDbmlRich(display)).tables)).toEqual(['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde']);
    expect((await parseMermaid(toMermaid(display))).entities).toHaveLength(4);
  });
});

describe('a diagram with one table of each name (ccc)', () => {
  it('writes its tables under their own names, as before', async () => {
    const display = await load('ccc');
    expect(display.models.map((m) => [m.name, m.tableName])).toEqual([['addresse', undefined], ['kunde', undefined]]);
    expect(tableNames(readDbmlEverywhere(toDbml(display)).tables)).toEqual(['ccc.addresse', 'ccc.kunde']);
    expect(tableNames(readDbmlRich(toDbmlRich(display)).tables)).toEqual(['ccc.addresse', 'ccc.kunde']);
    expect((await parseMermaid(toMermaid(display))).entities.map((e) => e.name)).toEqual(['addresse', 'kunde']);
  });
});

describe('payloads built by hand', () => {
  const twins = (extra: { schema?: string } = {}): DisplaySubjectArea => deepFreeze(subjectArea(
    [
      tableDef('bqs.addresse', [col('id', 'int', { isPrimaryKey: true })], { tableName: 'addresse', schema: extra.schema ?? 'bqs' }),
      tableDef('ccc.addresse', [col('id', 'int', { isPrimaryKey: true }), col('city', 'text')], { tableName: 'addresse', schema: extra.schema ?? 'ccc' }),
    ],
    [link('ccc.addresse', 'id', 'bqs.addresse', 'id')],
    { viewConfig: { positions: { 'bqs.addresse': { x: 1, y: 2 }, 'ccc.addresse': { x: 3, y: 4 } } } },
  ));

  it('a Ref between the two tables of one name joins two tables, not a column to itself', () => {
    const area = twins();
    for (const text of [toDbml(area), toDbmlRich(area)]) {
      expect(text).toContain('Ref: ccc.addresse.id > bqs.addresse.id');
      expect(text).not.toMatch(/Not exported: .*addresse/);
    }
  });

  it('two tables of one name whose files name no schema are written under the names the diagram calls them, both read', async () => {
    // An unqualified `Table addresse` in tables/bqs/ and tables/ccc/: the diagram names are the only unique ones.
    const area = twins({ schema: '' });
    const dbml = toDbml(area);
    expect(dbml).toContain('Table "bqs.addresse" {');
    expect(dbml).toContain('Ref: "ccc.addresse".id > "bqs.addresse".id');
    expect(readDbmlEverywhere(dbml).tables.map((t) => t.name).sort()).toEqual(['bqs.addresse', 'ccc.addresse']);
    expect(readDbmlRich(toDbmlRich(area)).tables.map((t) => t.name).sort()).toEqual(['bqs.addresse', 'ccc.addresse']);
    expect((await parseMermaid(toMermaid(area))).entities).toHaveLength(2);
  });

  it('two tables of one name whose files declare one schema (a copied schema folder) are both written, and every parser reads them', async () => {
    // tables/bqs/addresse.dbml and tables/bqs_backup/addresse.dbml both declare `Table bqs.addresse`.
    const area = deepFreeze(subjectArea(
      [
        tableDef('bqs.addresse', [col('id', 'int', { isPrimaryKey: true })], { tableName: 'addresse', schema: 'bqs' }),
        tableDef('bqs_backup.addresse', [col('id', 'int', { isPrimaryKey: true })], { tableName: 'addresse', schema: 'bqs' }),
      ],
      [link('bqs_backup.addresse', 'id', 'bqs.addresse', 'id')],
    ));
    const dbml = toDbml(area);
    expect(dbml).toContain('Table bqs.addresse {');
    expect(dbml).toContain('Table bqs."bqs_backup.addresse" {');
    expect(dbml).not.toContain('is not exported');
    expect(dbml).toContain('Ref: bqs."bqs_backup.addresse".id > bqs.addresse.id');
    expect(tableNames(readDbmlEverywhere(dbml).tables)).toEqual(['bqs.addresse', 'bqs.bqs_backup.addresse']);
    const rich = readDbmlRich(toDbmlRich(area));
    expect(tableNames(rich.tables)).toEqual(['bqs.addresse', 'bqs.bqs_backup.addresse']);
    expect(rich.refs).toHaveLength(1);
    expect((await parseMermaid(toMermaid(area))).entities).toHaveLength(2);
  });

  it('what an older core gives a diagram with both (two tables with one name, no tableName) is still a repeat, exported once', () => {
    const area = deepFreeze(subjectArea([
      tableDef('addresse', [col('id')], { schema: 'bqs' }),
      tableDef('addresse', [col('id')], { schema: 'ccc' }),
    ]));
    expect(toDbml(area)).toContain('// Not exported: addresse is listed more than once; exported once.');
    expect(toDbmlRich(area)).toContain('// Not exported: addresse is listed more than once; exported once.');
    expect(toMermaid(area)).toContain('%% Not exported: addresse is listed more than once; exported once.');
  });

  it('a tableName equal to the name, or blank, changes nothing', () => {
    const plain = subjectArea([tableDef('orders', [col('id')], { schema: 'sales' })]);
    const same = subjectArea([tableDef('orders', [col('id')], { schema: 'sales', tableName: 'orders' })]);
    const blank = subjectArea([tableDef('orders', [col('id')], { schema: 'sales', tableName: ' ' })]);
    for (const format of DIAGRAM_EXPORT_FORMATS) {
      expect(exportDiagram(same, format)).toBe(exportDiagram(plain, format));
      expect(exportDiagram(blank, format)).toBe(exportDiagram(plain, format));
    }
  });
});
