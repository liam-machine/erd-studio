/**
 * `toDbmlRich`, row by row of its mapping table: every output is read back
 * by @dbml/parse 9.1.1, 10.3.1 and 11.0.0 (`readDbmlRich`), which must agree
 * and report no error, no warning and no lint info about NULL, so each test
 * asserts what a DBML reader — ERD Studio's import among them — actually gets.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { DBML_RICH_EXPORT_HEADER, toDbmlRich } from '../../src/exportDbmlRich';
import { toDbml } from '../../src/exportDbml';
import { serializeDbdiagramLayout } from '../../src/dbdiagramLayout';
import {
  DBML_RICH_COLUMN_PROPERTIES,
  DBML_RICH_META_JSON_PROPERTY,
  DBML_RICH_NOTE_PROPERTIES,
  DBML_RICH_PLACEHOLDER_COLUMN,
  DBML_RICH_PLACEHOLDER_PROPERTY,
  DBML_RICH_STICKY_COLOURS,
  DBML_RICH_TABLE_PROPERTIES,
  rationaleKeyOf,
  rationaleProperty,
} from '../../src/dbmlRichProperties';
import { RATIONALE_KEYS } from '../../src/logicalModel';
import type { DisplayRelationship, DisplaySubjectArea } from '../../src/types/display';
import type { AnnotationColor, Meta } from '../../src/types/semantic';
import { oneLine } from '../../src/exportShared';
import { exporter as dbmlCoreExporter } from 'dbml-core-v3';
import { col, deepFreeze, parseDbmlRich, readDbmlRich, rel, subjectArea, tableDef } from '../exportParsers';
import type { RichDbmlReading } from '../exportParsers';

const GOLDEN_DIR = path.resolve(__dirname, '../fixtures/golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** The export, read back with no lint info at all unless `infos: 'model'`. */
function read(area: DisplaySubjectArea, infos: 'model' | 'none' = 'none'): RichDbmlReading {
  return readDbmlRich(toDbmlRich(area), { infos });
}

const table = (r: RichDbmlReading, name: string) => {
  const found = r.tables.find((t) => t.name === name);
  if (!found) throw new Error(`no table ${name}: ${r.tables.map((t) => t.name).join(', ')}`);
  return found;
};
const field = (r: RichDbmlReading, tableName: string, name: string) => {
  const found = table(r, tableName).fields.find((f) => f.name === name);
  if (!found) throw new Error(`no field ${tableName}.${name}`);
  return found;
};

/** `a.b_id` → `b.id` (b's key), for the Ref tests. */
function pair(cardinality: DisplayRelationship['cardinality']) {
  return subjectArea(
    [tableDef('a', [col('id', 'int', { isPrimaryKey: true }), col('b_id')]), tableDef('b', [col('id', 'int', { isPrimaryKey: true })])],
    [rel('a.b_id', 'b.id', cardinality)],
  );
}

describe('toDbmlRich: header and Project', () => {
  it('opens with the versioned header and names the layout file beside it', () => {
    const text = toDbmlRich(subjectArea([tableDef('a', [col('id')])], [], { domain: 'customer 360' }));
    const lines = text.split('\n');
    expect(lines[0]).toBe(DBML_RICH_EXPORT_HEADER);
    expect(DBML_RICH_EXPORT_HEADER).toBe('// erd-studio dbml-export v2 (DBML 9.1+)');
    expect(lines[1]).toBe('// Table positions: customer 360.dbdiagram, next to this file (`dbdiagram push` reads it).');
    expect(text).toMatch(/^\/\/ A \? beside a Ref operator .*ERD Studio does not record nullability/m);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('names the layout file it is given, and none when given an empty name', () => {
    const area = subjectArea([tableDef('a', [col('id')])]);
    expect(toDbmlRich(area, { layoutFileName: 'renamed.dbdiagram' })).toContain('// Table positions: renamed.dbdiagram, next to this file');
    expect(toDbmlRich(area, { layoutFileName: 'two\nlines' })).toContain('// Table positions: two lines, next to this file');
    expect(toDbmlRich(area, { layoutFileName: '' })).not.toContain('Table positions');
  });

  it('writes the subject area name and description as the Project', () => {
    const r = read(subjectArea([tableDef('a', [col('id')])], [], { domain: 'sales orders', description: "Orders — the team's view\nsecond line" }));
    expect(r.project).toEqual({ name: 'sales orders', note: "Orders — the team's view\nsecond line" });
  });

  it('writes an unnamed Project for a description alone, and none for neither', () => {
    expect(read(subjectArea([tableDef('a', [col('id')])], [], { domain: '', description: 'About' })).project).toEqual({ name: null, note: 'About' });
    expect(read(subjectArea([tableDef('a', [col('id')])], [], { domain: '  ', description: '' })).project).toBeNull();
  });
});

describe('toDbmlRich: the layer as a TableGroup', () => {
  const tables = [tableDef('a', [col('id')], { schema: 'silver' }), tableDef('b', [col('id')])];

  it('groups every exported table under the layer, with its colour and label', () => {
    const area = subjectArea(tables, [], {
      layer: 'silver',
      layerConfig: { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#A0A0A0', creatable: true, order: 1 },
    });
    expect(read(area).groups).toEqual([{ name: 'silver', color: '#a0a0a0', note: 'Layer: Silver', tables: ['silver.a', 'public.b'] }]);
  });

  it('leaves out a layer colour DBML would refuse, and names the layer by its id without a config', () => {
    for (const color of ['red', '#12345', 'rgb(1,2,3)', '', '#abcd']) {
      const area = subjectArea(tables, [], { layer: 'silver', layerConfig: { id: 'silver', label: 'Silver', abbreviation: 'S', color, creatable: true, order: 1 } });
      expect(read(area).groups[0].color, color).toBeNull();
    }
    expect(read(subjectArea(tables, [], { layer: 'gold' })).groups[0]).toMatchObject({ name: 'gold', note: 'Layer: gold' });
    const short = subjectArea(tables, [], { layer: 'x', layerConfig: { id: 'x', label: '', abbreviation: '', color: '#abc', creatable: true, order: 1 } });
    expect(read(short).groups[0]).toMatchObject({ color: '#abc', note: 'Layer: x' });
  });

  it('quotes a layer name that is not an identifier, and writes no group without a layer', () => {
    expect(read(subjectArea(tables, [], { layer: 'raw data' })).groups[0].name).toBe('raw data');
    expect(read(subjectArea(tables, [], { layer: '' })).groups).toEqual([]);
  });

  it('writes the group even when no table is exported', () => {
    expect(read(subjectArea([], [], { layer: 'silver' })).groups).toEqual([{ name: 'silver', color: null, note: 'Layer: silver', tables: [] }]);
  });
});

describe('toDbmlRich: tables', () => {
  it('writes role, grain, alias and every rationale key as table properties', () => {
    const rationale = Object.fromEntries(RATIONALE_KEYS.map((k) => [k, `why ${k}`]));
    const area = subjectArea([
      tableDef('fct_order', [col('id', 'int', { isPrimaryKey: true })], {
        schema: 'gold',
        modelRole: 'transaction-fact',
        grain: 'One row per order line',
        alias: 'orders',
        description: 'Orders',
        rationale,
      }),
    ]);
    const t = table(read(area), 'fct_order');
    expect(t.schema).toBe('gold');
    expect(t.note).toBe('Orders');
    expect(t.properties).toEqual({
      [DBML_RICH_TABLE_PROPERTIES.role]: 'transaction-fact',
      [DBML_RICH_TABLE_PROPERTIES.grain]: 'One row per order line',
      [DBML_RICH_TABLE_PROPERTIES.alias]: 'orders',
      ...Object.fromEntries(RATIONALE_KEYS.map((k) => [rationaleProperty(k), `why ${k}`])),
    });
    for (const property of Object.keys(t.properties).filter((p) => p.startsWith('rationale_'))) expect(rationaleKeyOf(property)).toBeDefined();
    // Never DBML's `as`: aliases are unique in DBML, ours are not.
    expect(toDbmlRich(area)).not.toMatch(/^Table .* as /m);
  });

  it('writes the schema public also as a property, which DBML would otherwise read as no schema', () => {
    const area = subjectArea([
      tableDef('a', [col('id')], { schema: 'public' }),
      tableDef('b', [col('id')], { schema: 'Public' }),
      tableDef('c', [col('id')]),
    ]);
    const r = read(area);
    // The reader shows "no schema" as public, for a and c alike.
    expect(table(r, 'a').schema).toBe('public');
    expect(table(r, 'c').schema).toBe('public');
    expect(table(r, 'a').properties).toEqual({ [DBML_RICH_TABLE_PROPERTIES.schema]: 'public' });
    // Any other spelling is a schema of its own to DBML, so it needs no property.
    expect(table(r, 'b').schema).toBe('Public');
    expect(table(r, 'b').properties).toEqual({});
    expect(table(r, 'c').properties).toEqual({});
  });

  it('writes a table with one property on one line, and several one per line', () => {
    const text = toDbmlRich(subjectArea([tableDef('a', [col('id')], { grain: 'g' }), tableDef('b', [col('id')], { grain: 'g', alias: 'bb' })]));
    expect(text).toContain("Table a [grain: 'g'] {");
    expect(text).toContain("Table b [\n  grain: 'g',\n  alias: 'bb'\n] {");
  });

  it('marks a single and a composite primary key', () => {
    const r = read(
      subjectArea([
        tableDef('one', [col('id', 'int', { isPrimaryKey: true }), col('x')]),
        tableDef('two', [col('a', 'int', { isPrimaryKey: true }), col('b', 'int', { isPrimaryKey: true }), col('c')]),
      ]),
    );
    expect(field(r, 'one', 'id').pk).toBe(true);
    expect(table(r, 'one').indexes).toEqual([]);
    expect(table(r, 'two').fields.map((f) => f.pk)).toEqual([false, false, false]);
    expect(table(r, 'two').indexes).toEqual([{ pk: true, unique: false, columns: ['a', 'b'] }]);
  });

  it('writes the column flags as properties', () => {
    const r = read(
      subjectArea([
        tableDef('d', [
          col('id', 'int', { isPrimaryKey: true, scdType: 0 }),
          col('code', 'varchar', { isNaturalKey: true, scdType: 2, description: 'Business key' }),
          col('amount', 'decimal', { additiveType: 'semi-additive' }),
          col('plain', 'int'),
        ]),
      ]),
    );
    expect(field(r, 'd', 'id').properties).toEqual({ [DBML_RICH_COLUMN_PROPERTIES.scdType]: '0' });
    expect(field(r, 'd', 'code')).toMatchObject({
      note: 'Business key',
      properties: { [DBML_RICH_COLUMN_PROPERTIES.naturalKey]: 'true', [DBML_RICH_COLUMN_PROPERTIES.scdType]: '2' },
    });
    expect(field(r, 'd', 'amount').properties).toEqual({ [DBML_RICH_COLUMN_PROPERTIES.additiveType]: 'semi-additive' });
    expect(field(r, 'd', 'plain').properties).toEqual({});
  });

  it('gives a table without columns one placeholder column, marked for import to drop', () => {
    const area = subjectArea([tableDef('empty', [], { description: 'Not designed yet' }), tableDef('broken', [], { loadError: { kind: 'yamlIndent', line: 5 } as never })]);
    const text = toDbmlRich(area);
    expect(text).toContain('// broken: its table file could not be read (yamlIndent, line 5); exported with no columns');
    const r = read(area);
    for (const name of ['empty', 'broken']) {
      expect(table(r, name).fields).toHaveLength(1);
      expect(field(r, name, DBML_RICH_PLACEHOLDER_COLUMN).properties).toEqual({ [DBML_RICH_PLACEHOLDER_PROPERTY]: 'true' });
    }
    expect(table(r, 'empty').note).toBe('Not designed yet');
  });

  it('exports the columns a table with a load error still shows', () => {
    const area = subjectArea([tableDef('half', [col('id')], { loadError: { kind: 'yamlIndent' } as never })]);
    expect(toDbmlRich(area)).toContain('// half: its table file could not be read (yamlIndent); only the columns shown are exported');
    expect(table(read(area), 'half').fields.map((f) => f.name)).toEqual(['id']);
  });

  it('writes tables without a schema bare, which DBML puts in public', () => {
    const r = read(subjectArea([tableDef('a', [col('id')]), tableDef('b', [col('id')], { schema: 'gold' })]));
    expect(r.tables.map((t) => `${t.schema}.${t.name}`)).toEqual(['public.a', 'gold.b']);
  });

  it('comments on the columns and tables it cannot export', () => {
    const area = subjectArea([
      tableDef('a', [col('id'), col(''), col('ID')]),
      tableDef('', [col('id')]),
      tableDef('A', [col('id')]),
    ]);
    const text = toDbmlRich(area);
    expect(text).toContain('// a: column 2 has no name; not exported');
    expect(text).toContain('// a: column ID is listed more than once; not exported');
    expect(text).toContain('// Not exported: table 2 has no name.');
    expect(text).toContain('// Not exported: A is listed more than once; exported once.');
    expect(read(area).tables.map((t) => t.name)).toEqual(['a']);
  });
});

describe('toDbmlRich: names and strings read back exactly', () => {
  const names = ['plain_name', 'with space', 'quote"inside', 'back\\slash', 'tab\there', 'line\nbreak', 'Note', 'table', 'indexes', '1starts_with_digit', 'ünïcödé — 日本', "it's"];

  it.each(names)('writes the name %j so every parser reads it back', (name) => {
    const area = subjectArea(
      [tableDef(name, [col(name, name), col('other')], { schema: name }), tableDef('t', [col('id', 'int', { isPrimaryKey: true })])],
      [{ fromModel: name, fromColumn: name, toModel: 't', toColumn: 'id', cardinality: 'many-to-one', role: name }],
      { layer: name },
    );
    const r = read(area);
    expect(r.tables[0]).toMatchObject({ schema: name, name });
    expect(r.tables[0].fields[0]).toMatchObject({ name, type: name });
    // A role is one line (`oneLine`), as on the canvas.
    expect(r.refs[0].name).toBe(oneLine(name));
    expect(r.refs[0].ends[0]).toEqual([name, name, [name], '*']);
    expect(r.groups[0].name).toBe(name);
  });

  it('quotes types that are not plain words, and writes an empty type as ""', () => {
    const r = read(subjectArea([tableDef('t', [col('a', 'decimal(10,2)'), col('b', 'timestamp with time zone'), col('c', 'array<string>'), col('d', ''), col('e', 'INT')])]));
    expect(table(r, 't').fields.map((f) => f.type)).toEqual(['decimal(10,2)', 'timestamp with time zone', 'array<string>', '', 'INT']);
  });

  const values = [
    "it's",
    'back\\slash',
    'ends with \\',
    '\\\\ two',
    "\\'",
    "'''triple'''",
    'multi\nline',
    'trailing line break\n',
    'tab\tinside',
    'cr\r\nlf',
    '  leading spaces',
    '\n  indented\n  lines',
    'nul\u0000and separator',
    '😀 emoji',
    '\\n is not a line break',
  ];

  it.each(values)('reads the property value %j back exactly', (value) => {
    const r = read(subjectArea([tableDef('t', [col('id', 'int', { meta: { note_text: value } })], { grain: value, meta: { owner: value } })]));
    expect(table(r, 't').properties.grain).toBe(value);
    expect(table(r, 't').properties.meta_owner).toBe(value);
    expect(field(r, 't', 'id').properties.meta_note_text).toBe(value);
  });

  it.each(values)('reads the note %j back with only its leading white space dropped', (value) => {
    const area = subjectArea([tableDef('t', [col('id', 'int', { description: value })], { description: value })], [], {
      description: value,
      viewConfig: { annotations: [{ id: 'n', text: value, x: 0, y: 0 }] },
    });
    const r = read(area);
    const expected = value.replace(/^\s+/, '');
    expect(table(r, 't').note).toBe(expected || null);
    expect(field(r, 't', 'id').note).toBe(expected || null);
    expect(r.project?.note ?? null).toBe(expected || null);
    expect(r.notes[0].content).toBe(expected);
  });

  it('single-quotes a one-line value and triple-quotes one with a line break', () => {
    const text = toDbmlRich(subjectArea([tableDef('t', [col('id')], { grain: "one's", alias: 'a\nb' })]));
    expect(text).toContain("grain: 'one\\'s'");
    expect(text).toContain("alias: '''a\nb'''");
  });
});

describe('toDbmlRich: meta', () => {
  it('writes text under a lower-case identifier key as meta_<key>, everything else as one meta_json', () => {
    const meta = {
      owner: 'data team',
      Owner: 'case matters',
      'source-system': 'crm',
      json: 'clashes with meta_json',
      pii: true,
      retired: false,
      deleted_at: null,
      tags: ['a', 'b'],
      lineage: { upstream: ['x'], depth: '2' },
      _private: 'ok',
    } as unknown as Meta;
    const r = read(subjectArea([tableDef('t', [col('id', 'int', { meta })], { meta })]));
    for (const properties of [table(r, 't').properties, field(r, 't', 'id').properties]) {
      expect(properties.meta_owner).toBe('data team');
      expect(properties.meta__private).toBe('ok');
      expect(Object.keys(properties).filter((k) => k.startsWith('meta_'))).toEqual(['meta_owner', 'meta__private', DBML_RICH_META_JSON_PROPERTY]);
      expect(JSON.parse(properties[DBML_RICH_META_JSON_PROPERTY])).toEqual({
        Owner: 'case matters',
        'source-system': 'crm',
        json: 'clashes with meta_json',
        pii: true,
        retired: false,
        deleted_at: null,
        tags: ['a', 'b'],
        lineage: { upstream: ['x'], depth: '2' },
      });
      // The JSON keeps the map's key order, so the entries go back in order.
      expect(Object.keys(JSON.parse(properties[DBML_RICH_META_JSON_PROPERTY]))).toEqual(['Owner', 'source-system', 'json', 'pii', 'retired', 'deleted_at', 'tags', 'lineage']);
    }
  });

  it('writes a number from an older core, an awkward key and JSON-hostile text exactly', () => {
    const meta = JSON.parse('{"tier": 1, "__proto__": "proto", "quote\'s": "it\'s \\\\ \\"q\\"\\n"}') as Meta;
    const r = read(subjectArea([tableDef('t', [col('id')], { meta })]));
    // `__proto__` is a lower-case identifier, so it is a plain property (an importer must define it, not assign it).
    expect(table(r, 't').properties.meta___proto__).toBe('proto');
    const json = JSON.parse(table(r, 't').properties.meta_json);
    expect(json).toEqual({ tier: 1, "quote's": 'it\'s \\ "q"\n' });
    expect(Object.keys(json)).toEqual(['tier', "quote's"]);
  });

  it('writes no meta property for an empty or missing meta', () => {
    const r = read(subjectArea([tableDef('t', [col('id', 'int', { meta: {} })], { meta: {} }), tableDef('u', [col('id')])]));
    expect(table(r, 't').properties).toEqual({});
    expect(field(r, 't', 'id').properties).toEqual({});
  });

  it('comments on meta it cannot write as JSON, and still exports the rest', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    const area = subjectArea([tableDef('t', [col('id', 'int', { meta: { loop: cyclic } as never })], { meta: { owner: 'me', loop: cyclic } as never })]);
    const text = toDbmlRich(area);
    expect(text).toContain('// t: meta not exported (it cannot be written as JSON): loop');
    expect(text).toContain('  // id: meta not exported (it cannot be written as JSON): loop');
    expect(table(read(area), 't').properties).toEqual({ meta_owner: 'me' });
  });
});

describe('toDbmlRich: relationships', () => {
  it('writes a many-to-one from its foreign key with >?', () => {
    const area = pair('many-to-one');
    expect(toDbmlRich(area)).toContain('Ref: a.b_id >? b.id');
    expect(read(area).refs).toEqual([{ name: null, ends: [['public', 'a', ['b_id'], '*'], ['public', 'b', ['id'], '0..1']] }]);
  });

  it('writes a one-to-many from its foreign key, the to end, so the ends swap', () => {
    const area = subjectArea(
      [tableDef('b', [col('id', 'int', { isPrimaryKey: true })]), tableDef('a', [col('id', 'int', { isPrimaryKey: true }), col('b_id')])],
      [rel('b.id', 'a.b_id', 'one-to-many')],
    );
    expect(toDbmlRich(area)).toContain('Ref: a.b_id >? b.id');
  });

  it('writes a one-to-one key end first, as ?-, and makes its foreign-key column unique', () => {
    const area = pair('one-to-one');
    expect(toDbmlRich(area)).toContain('Ref: b.id ?- a.b_id');
    const r = read(area);
    expect(field(r, 'a', 'b_id').unique).toBe(true);
    expect(field(r, 'a', 'id').unique).toBe(false);
    expect(r.refs[0].ends.map((e) => e[3])).toEqual(['0..1', '1']);
  });

  it("writes a one-to-one so DBML's SQL export puts the foreign key where ERD Studio has it", () => {
    // DBML reads a one-to-one's second end as the foreign key. @dbml/core
    // 3.13.4 predates `?`, so it reads the Refs with the marks taken out.
    const area = subjectArea(
      [
        tableDef('b', [col('id', 'int', { isPrimaryKey: true })]),
        tableDef('a', [col('id', 'int', { isPrimaryKey: true }), col('b_id')]),
        tableDef('c', [col('x'), col('y')]),
        tableDef('d', [col('u', 'int', { isPrimaryKey: true }), col('v', 'int', { isPrimaryKey: true })]),
      ],
      [
        rel('a.b_id', 'b.id', 'one-to-one'),
        rel('c.x', 'd.u', 'one-to-one', { compositeKey: 'k' }),
        rel('c.y', 'd.v', 'one-to-one', { compositeKey: 'k' }),
      ],
    );
    const refs = toDbmlRich(area)
      .split('\n')
      .filter((line) => line.startsWith('Ref'))
      .map((line) => line.replace(/\?/g, ''));
    const tables = 'Table b {\n  id int [pk]\n}\nTable a {\n  id int [pk]\n  b_id int [unique]\n}\n'
      + 'Table c {\n  x int\n  y int\n  indexes {\n    (x, y) [unique]\n  }\n}\nTable d {\n  u int\n  v int\n  indexes {\n    (u, v) [pk]\n  }\n}\n';
    const sql = dbmlCoreExporter.export(`${tables}${refs.join('\n')}\n`, 'postgres');
    expect(sql).toContain('ALTER TABLE "a" ADD FOREIGN KEY ("b_id") REFERENCES "b" ("id");');
    expect(sql).toContain('ALTER TABLE "c" ADD FOREIGN KEY ("x", "y") REFERENCES "d" ("u", "v");');
  });

  it('writes a one-to-one on a shared primary key as a bare -, adding nothing', () => {
    const area = subjectArea(
      [tableDef('a', [col('id', 'int', { isPrimaryKey: true })]), tableDef('b', [col('id', 'int', { isPrimaryKey: true })])],
      [rel('a.id', 'b.id', 'one-to-one')],
    );
    expect(toDbmlRich(area)).toContain('Ref: b.id - a.id');
    expect(field(read(area), 'a', 'id')).toMatchObject({ pk: true, unique: false });
  });

  it('gives a composite one-to-one a unique index unless it is the key', () => {
    const area = subjectArea(
      [
        tableDef('a', [col('x'), col('y'), col('z', 'int', { isPrimaryKey: true })]),
        tableDef('b', [col('u', 'int', { isPrimaryKey: true }), col('v', 'int', { isPrimaryKey: true })]),
        tableDef('c', [col('u', 'int', { isPrimaryKey: true }), col('v', 'int', { isPrimaryKey: true })]),
      ],
      [
        rel('a.x', 'b.u', 'one-to-one', { compositeKey: 'k' }),
        rel('a.y', 'b.v', 'one-to-one', { compositeKey: 'k' }),
        rel('c.u', 'b.u', 'one-to-one', { compositeKey: 'k2' }),
        rel('c.v', 'b.v', 'one-to-one', { compositeKey: 'k2' }),
      ],
    );
    const text = toDbmlRich(area);
    expect(text).toContain('Ref: b.(u, v) ?- a.(x, y)');
    expect(text).toContain('Ref: b.(u, v) - c.(u, v)');
    const r = read(area);
    expect(table(r, 'a').indexes).toEqual([{ pk: false, unique: true, columns: ['x', 'y'] }]);
    expect(table(r, 'c').indexes).toEqual([{ pk: true, unique: false, columns: ['u', 'v'] }]);
  });

  it('writes a many-to-many as <>, with ? on each end that is not a key', () => {
    const plain = subjectArea([tableDef('a', [col('x')]), tableDef('b', [col('y')])], [rel('a.x', 'b.y', 'many-to-many')]);
    expect(toDbmlRich(plain)).toContain('Ref: a.x ?<>? b.y');
    expect(read(plain).refs[0].ends.map((e) => e[3])).toEqual(['0..*', '0..*']);
    const half = subjectArea([tableDef('a', [col('x', 'int', { isPrimaryKey: true }), col('w')]), tableDef('b', [col('y')])], [rel('b.y', 'a.x', 'many-to-many')]);
    expect(toDbmlRich(half)).toContain('Ref: b.y <>? a.x');
  });

  it('writes a foreign key that is all primary-key columns without ? (DBML reads those as NOT NULL)', () => {
    const area = subjectArea(
      [
        tableDef('link', [col('a_id', 'int', { isPrimaryKey: true }), col('b_id', 'int', { isPrimaryKey: true })]),
        tableDef('a', [col('id', 'int', { isPrimaryKey: true })]),
      ],
      [rel('link.a_id', 'a.id')],
    );
    expect(toDbmlRich(area)).toContain('Ref: link.a_id > a.id');
    expect(parseDbmlRich(toDbmlRich(area)).flatMap((p) => p.diagnostics)).toEqual([]);
  });

  it('writes a composite foreign key as one Ref', () => {
    const area = subjectArea(
      [
        tableDef('pit', [col('id', 'int', { isPrimaryKey: true }), col('hk'), col('as_of')]),
        tableDef('sat', [col('hk', 'int', { isPrimaryKey: true }), col('load', 'int', { isPrimaryKey: true })]),
      ],
      [rel('pit.hk', 'sat.hk', 'many-to-one', { compositeKey: 'k', role: 'as of' }), rel('pit.as_of', 'sat.load', 'many-to-one', { compositeKey: 'k' })],
    );
    expect(toDbmlRich(area)).toContain('Ref "as of": pit.(hk, as_of) >? sat.(hk, load)');
    expect(read(area).refs).toEqual([{ name: 'as of', ends: [['public', 'pit', ['hk', 'as_of'], '*'], ['public', 'sat', ['hk', 'load'], '0..1']] }]);
  });

  it('names a Ref after its role, quoting one that is not an identifier', () => {
    const roles = ['manager', 'ship date', 'say "hi"', 'a\\b', 'note'];
    const area = subjectArea(
      [tableDef('e', [col('id', 'int', { isPrimaryKey: true }), ...roles.map((_, i) => col(`c${i}`))])],
      roles.map((role, i) => rel(`e.c${i}`, 'e.id', 'many-to-one', { role })),
    );
    expect(read(area).refs.map((r) => r.name)).toEqual(roles);
    expect(toDbmlRich(area)).toContain('Ref manager: e.c0 >? e.id');
  });

  it('writes a self-reference', () => {
    const area = subjectArea([tableDef('employee', [col('id', 'int', { isPrimaryKey: true }), col('manager_id')], { schema: 'hr' })], [rel('employee.manager_id', 'employee.id', 'many-to-one', { role: 'manager' })]);
    expect(read(area).refs).toEqual([{ name: 'manager', ends: [['hr', 'employee', ['manager_id'], '*'], ['hr', 'employee', ['id'], '0..1']] }]);
  });

  it('comments on relationships whose ends are not exported', () => {
    const area = subjectArea(
      [tableDef('a', [col('id', 'int', { isPrimaryKey: true }), col('x')]), tableDef('empty', [])],
      [rel('a.x', 'gone.id'), rel('a.x', 'empty.id'), rel('a.x', 'a.missing'), rel('a.x', 'a.x'), rel('a.x', 'a.id', 'zero-to-many' as never)],
    );
    const text = toDbmlRich(area);
    expect(text).toContain('// Not exported: a.x -> gone.id (gone is not in this diagram).');
    expect(text).toContain('// Not exported: a.x -> empty.id (empty has no column id).');
    expect(text).toContain('// Not exported: a.x -> a.missing (a has no column missing).');
    expect(text).toContain('// Not exported: a.x -> a.x (a column cannot point at itself).');
    expect(text).toContain('// Not exported: a.x -> a.id (its cardinality "zero-to-many" is not one an export can draw).');
    expect(read(area).refs).toEqual([]);
  });

  it('writes one Ref per pair of column sets, which is all DBML allows', () => {
    const area = subjectArea(
      [tableDef('a', [col('x'), col('y')]), tableDef('b', [col('u', 'int', { isPrimaryKey: true }), col('v', 'int', { isPrimaryKey: true })])],
      [
        rel('a.x', 'b.u', 'many-to-one', { compositeKey: 'one' }),
        rel('a.y', 'b.v', 'many-to-one', { compositeKey: 'one' }),
        rel('a.x', 'b.v', 'many-to-one', { compositeKey: 'two' }),
        rel('a.y', 'b.u', 'many-to-one', { compositeKey: 'two' }),
        rel('b.u', 'a.x', 'one-to-many'),
        rel('a.x', 'b.u', 'many-to-one'),
      ],
    );
    const text = toDbmlRich(area);
    expect(text).toContain('// Not exported: a.(x, y) -> b.(v, u) (another relationship already joins the same columns, and DBML allows one).');
    expect(text).toContain('// Not exported: a.x -> b.u (the same link is already exported).');
    // The single column pair is a Ref of its own: its endpoints differ from the composite's.
    expect(read(area, 'model').refs.map((r) => r.ends.map((e) => e[2].join(',')))).toEqual([['x,y', 'u,v'], ['x', 'u']]);
  });

  it('comments on a composite self-reference whose two ends are the same columns', () => {
    const area = subjectArea(
      [tableDef('t', [col('a', 'int', { isPrimaryKey: true }), col('b', 'int', { isPrimaryKey: true })])],
      [rel('t.a', 't.b', 'many-to-one', { compositeKey: 'k' }), rel('t.b', 't.a', 'many-to-one', { compositeKey: 'k' })],
    );
    expect(toDbmlRich(area)).toContain('// Not exported: t.(a, b) -> t.(b, a) (its two ends are the same columns, which DBML refuses).');
    expect(read(area).refs).toEqual([]);
  });

  it('writes a relationship drawn backwards as stored, with the canvas sentence above it', () => {
    const area = subjectArea(
      [tableDef('dim', [col('id', 'int', { isPrimaryKey: true })]), tableDef('fct', [col('dim_id')])],
      [rel('dim.id', 'fct.dim_id', 'many-to-one', { keysContradict: true })],
    );
    const text = toDbmlRich(area);
    expect(text).toContain("// This starts at dim's key (id), so it was probably drawn backwards.\nRef: dim.id ?> fct.dim_id");
    expect(read(area, 'model').refs).toHaveLength(1);
  });
});

describe('toDbmlRich: the foreign-key flag', () => {
  const area = (declared: boolean, relationships: DisplayRelationship[]) =>
    subjectArea(
      [
        tableDef('a', [
          col('id', 'int', { isPrimaryKey: true }),
          col('b_id', 'int', { isForeignKey: true, ...(declared ? { isForeignKeyDeclared: true } : {}) }),
        ]),
        tableDef('b', [col('id', 'int', { isPrimaryKey: true })]),
      ],
      relationships,
    );
  const flag = (d: DisplaySubjectArea) => field(read(d, 'model'), 'a', 'b_id').properties[DBML_RICH_COLUMN_PROPERTIES.foreignKey];

  it('leaves the flag to the Ref when the model file does not set it', () => {
    expect(flag(area(false, [rel('a.b_id', 'b.id')]))).toBeUndefined();
  });

  it('keeps the model file’s own flag, Ref or not, so it round-trips', () => {
    expect(flag(area(true, [rel('a.b_id', 'b.id')]))).toBe('true');
    expect(flag(area(true, []))).toBe('true');
  });

  it('writes the badge when no exported Ref says so: none, or a skipped one', () => {
    expect(flag(area(false, []))).toBe('true');
    expect(flag(area(false, [rel('a.b_id', 'gone.id')]))).toBe('true');
  });

  it('leaves a many-to-many’s badge to its Ref, whose first end core badges, so the flag is not invented on import', () => {
    // Core badges a many-to-many's `from` end (`foreignKeyEnd`), which the Ref
    // writes first and import stores as `from`: a `foreign_key` here would come
    // back as a flag the model file never set (round-trip bug).
    expect(flag(area(false, [rel('a.b_id', 'b.id', 'many-to-many')]))).toBeUndefined();
    expect(flag(area(true, [rel('a.b_id', 'b.id', 'many-to-many')]))).toBe('true');
  });
});

describe('toDbmlRich: sticky notes', () => {
  it.each(Object.entries(DBML_RICH_STICKY_COLOURS))('writes a %s note with its hex colour', (color, hex) => {
    const r = read(subjectArea([tableDef('a', [col('id')])], [], { viewConfig: { annotations: [{ id: 'n', text: 'Hi', x: 1, y: 2, color: color as AnnotationColor }] } }));
    expect(r.notes).toEqual([{ name: 'sticky_1', content: 'Hi', color: hex, properties: {} }]);
  });

  it('numbers the notes, names a linked table, and leaves out a colour it does not know', () => {
    const area = subjectArea([tableDef('dim_account', [col('id')])], [], {
      viewConfig: {
        annotations: [
          { id: 'a', text: 'Linked', x: 0, y: 0, linkedModel: 'dim_account' },
          { id: 'b', text: '   ', x: 0, y: 0 },
          { id: 'c', text: 'Purple\nnote', x: 0, y: 0, color: 'purple' as AnnotationColor },
          { id: 'd', text: 'Gone link', x: 0, y: 0, linkedModel: 'not_here', color: 'green' },
        ],
      },
    });
    const text = toDbmlRich(area);
    expect(text).toContain('// Sticky note 2: colour not exported (not one ERD Studio knows): purple');
    expect(read(area).notes).toEqual([
      { name: 'sticky_1', content: 'Linked', color: null, properties: { [DBML_RICH_NOTE_PROPERTIES.linkedTable]: 'dim_account' } },
      { name: 'sticky_2', content: 'Purple\nnote', color: null, properties: {} },
      { name: 'sticky_3', content: 'Gone link', color: DBML_RICH_STICKY_COLOURS.green, properties: { linked_table: 'not_here' } },
    ]);
  });

  it('leaves positions out of the DBML (they go in the .dbdiagram file)', () => {
    const area = subjectArea([tableDef('a', [col('id')])], [], {
      viewConfig: { positions: { a: { x: 123456, y: 654321 } }, annotations: [{ id: 'n', text: 'x', x: 777777, y: 888888, width: 999999 }] },
    });
    const text = toDbmlRich(area);
    for (const n of ['123456', '654321', '777777', '888888', '999999']) expect(text).not.toContain(n);
  });
});

describe('toDbmlRich: robustness', () => {
  it('never throws on a minimal, an older-core or a malformed subject area, and always parses', () => {
    const cases: unknown[] = [
      subjectArea([]),
      { schemaVersion: 4, domain: 'old', layer: 'silver', stage: 'logical', description: '', models: [{ name: 'a', schema: '', description: '', columns: [{ name: 'id', dataType: 'int', description: '' }] }], relationships: [], viewConfig: {}, readOnly: false, positionDraggable: true },
      { domain: 42, models: 'nope', relationships: [null, 1, { fromModel: 'a' }], viewConfig: { annotations: 'x' } },
      { models: [null, 1, 'x', { name: 'a', columns: [null, { name: 'id', dataType: 7, scdType: 'two', meta: [] }], rationale: 'r', meta: 'm' }], layerConfig: 'x' },
      {},
      null,
    ];
    for (const area of cases) {
      const text = toDbmlRich(area as DisplaySubjectArea);
      expect(text.startsWith(DBML_RICH_EXPORT_HEADER)).toBe(true);
      expect(() => readDbmlRich(text)).not.toThrow();
    }
  });

  it('is deterministic and leaves its input alone', () => {
    const area = deepFreeze(
      subjectArea(
        [tableDef('a', [col('id', 'int', { isPrimaryKey: true, meta: { tags: ['x'] } })], { meta: { owner: 'me', n: null } }), tableDef('b', [col('a_id')])],
        [rel('b.a_id', 'a.id', 'many-to-one', { role: 'r' })],
        { viewConfig: { annotations: [{ id: 'n', text: 'x', x: 0, y: 0, color: 'pink' }] } },
      ),
    );
    expect(toDbmlRich(area)).toBe(toDbmlRich(JSON.parse(JSON.stringify(area))));
  });

  it('does not change the portable export', () => {
    // toDbml's goldens pin it byte for byte; this pins that the rich traversal additions did not leak into it.
    const area = subjectArea([tableDef('a', [col('id', 'int', { meta: { owner: 'me', tags: ['x'] } })])]);
    expect(toDbml(area)).not.toContain('meta_');
    expect(toDbml(area)).toContain("Meta owner: me");
  });
});

/**
 * Everything the mapping table covers in one subject area, held to a golden
 * of its own (`rich-features.rich.dbml` and `.dbdiagram`), with no lint info
 * at all: every Ref here joins key columns as its cardinality says.
 */
function richFeatures(): DisplaySubjectArea {
  return subjectArea(
    [
      tableDef(
        'fct_order',
        [
          col('order_id', 'BIGINT', { isPrimaryKey: true, isNaturalKey: true, description: 'Order id from the source' }),
          col('customer_key', 'INT', { isForeignKey: true, isForeignKeyDeclared: true, description: 'FK to dim_customer' }),
          col('ship_date_key', 'INT'),
          col('amount', 'DECIMAL(18,2)', { additiveType: 'additive', meta: { unit: 'EUR', precision: { scale: '2' } } }),
          col('promo_code', ''),
        ],
        {
          schema: 'gold',
          alias: 'orders',
          modelRole: 'transaction-fact',
          grain: 'One row per order',
          description: "The team's orders\n\nSecond paragraph",
          rationale: { purpose: 'Revenue reporting', measures: 'amount is additive' },
          meta: { owner: 'sales-eng', tier: '1', pii: false, tags: ['finance', 'daily'] },
        },
      ),
      tableDef(
        'dim_customer',
        [
          col('customer_key', 'INT', { isPrimaryKey: true, scdType: 0 }),
          col('customer_id', 'VARCHAR', { isNaturalKey: true, scdType: 0 }),
          col('segment', 'VARCHAR', { scdType: 2 }),
        ],
        { schema: 'gold', modelRole: 'conformed-dim', grain: 'One row per customer version', rationale: { scdStrategy: 'Type 2 on segment' } },
      ),
      tableDef('dim_date', [col('date_key', 'INT', { isPrimaryKey: true }), col('calendar_date', 'DATE', { isNaturalKey: true })], { modelRole: 'conformed-dim' }),
      tableDef('customer_profile', [col('customer_key', 'INT', { isPrimaryKey: true }), col('bio', 'TEXT')], { schema: 'gold' }),
      tableDef('bridge_tag', [col('tag_key', 'INT', { isPrimaryKey: true }), col('order_id', 'BIGINT', { isPrimaryKey: true })], { schema: 'gold', modelRole: 'factless-fact' }),
      tableDef('dim_tag', [col('tag_key', 'INT', { isPrimaryKey: true }), col('tag_name', 'VARCHAR')], { schema: 'gold' }),
      tableDef('planned', [], { description: 'Designed later' }),
    ],
    [
      rel('fct_order.customer_key', 'dim_customer.customer_key', 'many-to-one'),
      rel('dim_date.date_key', 'fct_order.ship_date_key', 'one-to-many', { role: 'ship date' }),
      rel('customer_profile.customer_key', 'dim_customer.customer_key', 'one-to-one'),
      rel('bridge_tag.tag_key', 'dim_tag.tag_key', 'many-to-one'),
      rel('dim_customer.segment', 'dim_tag.tag_name', 'many-to-many', { role: 'segment tags' }),
    ],
    {
      domain: 'sales',
      layer: 'gold',
      description: 'Sales — orders and customers',
      layerConfig: { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 2 },
      viewConfig: {
        positions: { fct_order: { x: 400, y: 200.456 }, dim_customer: { x: 40, y: 60 }, DIM_DATE: { x: -20.5, y: 400 }, planned: { x: 900, y: 0 } },
        annotations: [
          { id: 'n1', text: 'Check the grain with finance', x: 10, y: 10, color: 'yellow', linkedModel: 'fct_order' },
          { id: 'n2', text: 'Open questions:\n- promo codes?', x: 300, y: 10, color: 'blue', width: 220, height: 90 },
        ],
      },
    },
  );
}

describe('toDbmlRich: every feature together', () => {
  it('matches the rich-features golden, with no diagnostic in any 9.1+ parser', () => {
    const area = richFeatures();
    const text = toDbmlRich(area);
    const layout = serializeDbdiagramLayout(area);
    for (const [file, content] of [['rich-features.rich.dbml', text], ['rich-features.dbdiagram', layout]] as const) {
      const golden = path.join(GOLDEN_DIR, file);
      if (UPDATE) fs.writeFileSync(golden, content);
      expect(content).toBe(fs.readFileSync(golden, 'utf-8'));
    }
    for (const parse of parseDbmlRich(text)) expect(parse.diagnostics, parse.parser).toEqual([]);

    const r = readDbmlRich(text, { infos: 'none' });
    expect(r.tables.map((t) => `${t.schema}.${t.name}`)).toEqual([
      'gold.fct_order', 'gold.dim_customer', 'public.dim_date', 'gold.customer_profile', 'gold.bridge_tag', 'gold.dim_tag', 'public.planned',
    ]);
    expect(r.refs.map((ref) => [ref.name, ...ref.ends.map((e) => `${e[0]}.${e[1]}.(${e[2].join(',')}) ${e[3]}`)])).toEqual([
      [null, 'gold.fct_order.(customer_key) *', 'gold.dim_customer.(customer_key) 0..1'],
      ['ship date', 'gold.fct_order.(ship_date_key) *', 'public.dim_date.(date_key) 0..1'],
      [null, 'gold.dim_customer.(customer_key) 1', 'gold.customer_profile.(customer_key) 1'],
      [null, 'gold.bridge_tag.(tag_key) *', 'gold.dim_tag.(tag_key) 1'],
      ['segment tags', 'gold.dim_customer.(segment) 0..*', 'gold.dim_tag.(tag_name) 0..*'],
    ]);
    expect(table(r, 'fct_order').properties).toMatchObject({
      role: 'transaction-fact',
      grain: 'One row per order',
      alias: 'orders',
      rationale_purpose: 'Revenue reporting',
      rationale_measures: 'amount is additive',
      meta_owner: 'sales-eng',
      meta_tier: '1',
    });
    expect(JSON.parse(table(r, 'fct_order').properties.meta_json)).toEqual({ pii: false, tags: ['finance', 'daily'] });
    expect(field(r, 'fct_order', 'customer_key').properties).toEqual({ foreign_key: 'true' });
    expect(field(r, 'fct_order', 'promo_code').type).toBe('');
    expect(field(r, 'planned', DBML_RICH_PLACEHOLDER_COLUMN).properties).toEqual({ erd_placeholder: 'true' });
    expect(r.groups).toEqual([{ name: 'gold', color: '#d4a800', note: 'Layer: Gold', tables: r.tables.map((t) => `${t.schema}.${t.name}`) }]);
    expect(r.notes.map((n) => [n.name, n.color, n.properties])).toEqual([
      ['sticky_1', '#f59e0b', { linked_table: 'fct_order' }],
      ['sticky_2', '#3b82f6', {}],
    ]);
  });
});
