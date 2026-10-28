/**
 * `parseTableDbml` (§2.2, §4.3 of the native DBML storage spec): one `.dbml`
 * table file, read on its own, into the `SemanticTable` a YAML model file
 * gives. Every mapping row, the 9 / 10 / 11 property shapes, the tolerant
 * cases (inline refs, `use` and `Ref` lines, a BOM) and the classified
 * failures.
 */
import { describe, it, expect } from 'vitest';

import { parseTableDbml } from '../../src/dbml/readTable';
import { VIRTUAL_PATH } from '../../src/dbml/parser';
import type { DbmlTableReading } from '../../src/types/dbmlStorage';
import { describeTableLoadError, DBML_QUOTE_HINT } from '../../src/domain';
import { PARSER_PINNED, PARSER_V10, PARSER_V9, STORAGE_PARSERS } from '../dbmlParsers';

type Ok = Extract<DbmlTableReading, { ok: true }>;
type Failed = Extract<DbmlTableReading, { ok: false }>;

function ok(reading: DbmlTableReading): Ok {
  if (!reading.ok) throw new Error(`expected a table, got ${JSON.stringify(reading.error)}`);
  return reading;
}
function failed(reading: DbmlTableReading): Failed['error'] {
  if (reading.ok) throw new Error('expected a failure');
  return reading.error;
}

const FCT_ORDER = `// Order lines from the shop. Hand-written comments like this one survive every save.
Table fct_order [
  schema: 'gold',
  role: 'transaction-fact',
  grain: 'One row per order line',
  alias: 'orders',
  rationale_purpose: 'Revenue reporting by day, customer and region',
  rationale_measures: 'amount is additive',
  meta_owner: 'sales-data',
  meta_json: '{"pii":false,"tags":["finance"]}'
] {
  order_line_id BIGINT [pk, note: 'Line id from the shop']
  customer_key INT [foreign_key: 'true']
  order_date_key INT
  ship_date_key INT
  region_code VARCHAR
  country_code VARCHAR
  amount "DECIMAL(18,2)" [additive_type: 'additive', note: 'Line total']
  order_number VARCHAR [natural_key: 'true'] // the business key
  loaded_at timestamp [not null, default: \`now()\`]   // DBML-only settings: kept, never read
  Note: 'Order lines'
}
`;

const DIM_CUSTOMER = `Table dim_customer [schema: 'gold', role: 'conformed-dim'] {
  customer_key INT [note: 'Surrogate key']
  valid_from DATE [scd_type: '2']
  customer_id VARCHAR [natural_key: 'true']
  parent_customer_key INT
  segment VARCHAR [scd_type: '1']
  indexes {
    (customer_key, valid_from) [pk]
  }
}
`;

describe('parseTableDbml: the §2.2 field mapping', () => {
  it.each(STORAGE_PARSERS)('reads every table and column row of the spec example (%s)', (_label, parser) => {
    const { table, declaredName, declaredReference, schemaQualified, writable, problems } = ok(parseTableDbml(FCT_ORDER, 'fct_order', parser));
    expect({ declaredName, declaredReference, schemaQualified, writable, problems }).toEqual({
      declaredName: 'fct_order', declaredReference: 'fct_order', schemaQualified: false, writable: true, problems: [],
    });
    expect(table).toEqual({
      name: 'fct_order',
      schema: 'gold',
      alias: 'orders',
      description: 'Order lines',
      grain: 'One row per order line',
      modelRole: 'transaction-fact',
      rationale: { purpose: 'Revenue reporting by day, customer and region', measures: 'amount is additive' },
      meta: { pii: false, tags: ['finance'], owner: 'sales-data' },
      columns: [
        { name: 'order_line_id', dataType: 'BIGINT', description: 'Line id from the shop', isPrimaryKey: true },
        { name: 'customer_key', dataType: 'INT', description: '', isForeignKey: true },
        { name: 'order_date_key', dataType: 'INT', description: '' },
        { name: 'ship_date_key', dataType: 'INT', description: '' },
        { name: 'region_code', dataType: 'VARCHAR', description: '' },
        { name: 'country_code', dataType: 'VARCHAR', description: '' },
        { name: 'amount', dataType: 'DECIMAL(18,2)', description: 'Line total', additiveType: 'additive' },
        { name: 'order_number', dataType: 'VARCHAR', description: '', isNaturalKey: true },
        { name: 'loaded_at', dataType: 'timestamp', description: '' },
      ],
    });
    expect(table.relationships).toBeUndefined();
  });

  it.each(STORAGE_PARSERS)('reads a composite key from indexes, and SCD types (%s)', (_label, parser) => {
    const { table } = ok(parseTableDbml(DIM_CUSTOMER, 'dim_customer', parser));
    expect(table.columns!.map((c) => [c.name, c.isPrimaryKey === true, c.scdType, c.isNaturalKey === true])).toEqual([
      ['customer_key', true, undefined, false],
      ['valid_from', true, 2, false],
      ['customer_id', false, undefined, true],
      ['parent_customer_key', false, undefined, false],
      ['segment', false, 1, false],
    ]);
  });

  it('reads a `primary key` flag and the header note setting', () => {
    const { table } = ok(parseTableDbml("Table t [note: 'From the header'] {\n  id int [primary key]\n}\n", 't'));
    expect(table.description).toBe('From the header');
    expect(table.columns![0].isPrimaryKey).toBe(true);
  });

  it.each(STORAGE_PARSERS)('accepts the erd_ prefix on every ERD Studio property (%s)', (_label, parser) => {
    const text = `Table t [erd_role: 'fact', erd_grain: 'g', erd_alias: 'a', erd_rationale_design: 'd', erd_meta_owner: 'o'] {
  id int [pk, erd_natural_key: 'true', erd_scd_type: '1', erd_additive_type: 'semi-additive', erd_foreign_key: 'true']
}
`;
    const { table } = ok(parseTableDbml(text, 't', parser));
    expect(table).toMatchObject({ modelRole: 'fact', grain: 'g', alias: 'a', rationale: { design: 'd' }, meta: { owner: 'o' } });
    expect(table.columns![0]).toMatchObject({ isNaturalKey: true, scdType: 1, additiveType: 'semi-additive', isForeignKey: true });
  });

  it.each(STORAGE_PARSERS)('drops the placeholder column of a table with no columns (%s)', (_label, parser) => {
    const text = "Table bridge_empty {\n  _erd_no_columns unknown [erd_placeholder: 'true', note: 'ERD Studio: this table has no columns yet, and DBML needs one']\n}\n";
    expect(ok(parseTableDbml(text, 'bridge_empty', parser)).table.columns).toEqual([]);
    // Without the marker it is an ordinary column.
    expect(ok(parseTableDbml('Table b {\n  _erd_no_columns unknown\n}\n', 'b', parser)).table.columns).toHaveLength(1);
  });

  it('ignores a value outside the SCD and additive unions, as YAML does', () => {
    const { table } = ok(parseTableDbml("Table t {\n  a int [scd_type: '7', additive_type: 'sometimes']\n}\n", 't'));
    expect(table.columns![0].scdType).toBeUndefined();
    expect(table.columns![0].additiveType).toBeUndefined();
  });

  it('meta: a meta_<key> beats the same key inside meta_json; invalid JSON is kept as meta "json" with a warning', () => {
    const wins = ok(parseTableDbml(`Table t [meta_json: '{"owner":"json","n":1}', meta_owner: 'key'] {\n  id int\n}\n`, 't'));
    expect(wins.table.meta).toEqual({ owner: 'key', n: '1' }); // readMeta's rules: a number reads as its text
    const invalid = ok(parseTableDbml(`Table t [meta_json: '{not json'] {\n  id int\n}\n`, 't'));
    expect(invalid.table.meta).toEqual({ json: '{not json' });
    expect(invalid.problems.map((p) => p.code)).toEqual(['metaJson']);
  });

  it('meta: entries read in the order the properties come, meta_json entries where meta_json is', () => {
    const read = ok(parseTableDbml(`Table t [meta_owner: 'o', meta_json: '{"pii":true,"owner":"json","tags":["a"]}', meta_exposure: 'e'] {\n  id int\n}\n`, 't'));
    expect(read.table.meta).toEqual({ owner: 'o', pii: true, tags: ['a'], exposure: 'e' });
    expect(Object.keys(read.table.meta ?? {})).toEqual(['owner', 'pii', 'tags', 'exposure']);
  });
});

describe('parseTableDbml: names', () => {
  it('reads a stem that differs from the declared name only in case, with the declared spelling', () => {
    const reading = ok(parseTableDbml('Table Dim_Date {\n  id int\n}\n', 'dim_date'));
    expect(reading.table.name).toBe('Dim_Date');
    expect(reading.declaredName).toBe('Dim_Date');
  });

  it('refuses a stem that differs otherwise (nameMismatch)', () => {
    const error = failed(parseTableDbml('Table dim_day {\n  id int\n}\n', 'dim_date'));
    expect(error).toMatchObject({ kind: 'dbmlStructure', code: 'structure:nameMismatch', line: 1 });
  });

  it('reads a schema-qualified name: schema from the qualifier, the declared reference keeps it', () => {
    const reading = ok(parseTableDbml('Table gold.fct_order {\n  id int\n}\n', 'fct_order'));
    expect(reading.table.schema).toBe('gold');
    expect(reading.schemaQualified).toBe(true);
    expect(reading.declaredReference).toBe('gold.fct_order');
    // A schema property beats the qualifier.
    expect(ok(parseTableDbml("Table gold.x [schema: 'silver'] {\n  id int\n}\n", 'x')).table.schema).toBe('silver');
  });

  it('reads a DBML alias (`as FO`) and quoted names', () => {
    const reading = ok(parseTableDbml('Table fct_order as FO {\n  id int\n}\n', 'fct_order'));
    expect(reading.alias).toBe('FO');
    expect(reading.table.alias).toBeUndefined();
    const quoted = ok(parseTableDbml('Table "order line" {\n  "line id" int [pk]\n}\n', 'order line'));
    expect(quoted.declaredReference).toBe('"order line"');
    expect(quoted.table.columns![0].name).toBe('line id');
  });
});

describe('parseTableDbml: readable with a warning, writes refused until fixed', () => {
  it.each(STORAGE_PARSERS)('an inline [ref: …] is blanked and reported with the Ref line to add (%s)', (_label, parser) => {
    const text = `Table fct_order {
  id int [pk]
  customer_key int [ref: > dim_customer.customer_key, note: 'FK']
  region_code text [ref: - dim_region.region_code]
}
`;
    const reading = ok(parseTableDbml(text, 'fct_order', parser));
    expect(reading.writable).toBe(false);
    expect(reading.table.relationships).toBeUndefined();
    expect(reading.table.columns!.map((c) => [c.name, c.description])).toEqual([['id', ''], ['customer_key', 'FK'], ['region_code', '']]);
    expect(reading.problems.map((p) => [p.code, p.line])).toEqual([['inlineRefInTableFile', 3], ['inlineRefInTableFile', 4]]);
    expect(reading.problems[0].message).toContain('`Ref: fct_order.customer_key >? dim_customer.customer_key`');
    expect(reading.problems[1].message).toContain('`Ref: dim_region.region_code ?- fct_order.region_code`');
  });

  it.each(STORAGE_PARSERS)('a use line and a Ref line are blanked and reported (%s)', (_label, parser) => {
    const text = `use { table dim_customer } from './dim_customer.dbml'
Table fct_order {
  id int [pk]
  customer_key int
}
Ref: fct_order.customer_key > dim_customer.customer_key
`;
    const reading = ok(parseTableDbml(text, 'fct_order', parser));
    expect(reading.writable).toBe(false);
    expect(reading.problems.map((p) => [p.code, p.line])).toEqual([['useInTableFile', 1], ['refInTableFile', 6]]);
    expect(reading.problems[1].message).toContain('Ref: fct_order.customer_key > dim_customer.customer_key');
  });

  it.each(STORAGE_PARSERS)('a leading byte-order mark is stripped (%s)', (_label, parser) => {
    expect(ok(parseTableDbml('﻿Table t {\n  id int\n}\n', 't', parser)).table.name).toBe('t');
  });

  it('every read compiles under the fixed, space-free virtual path, never the file\'s own path', () => {
    // parseTableDbml takes no path; the multi-file case (a library folder
    // whose name holds a space) is in dbmlCompileProject.test.ts.
    expect(VIRTUAL_PATH).toBe('/erd-studio/file.dbml');
    for (const parser of [PARSER_V10, PARSER_PINNED]) {
      expect(ok(parseTableDbml('Table t {\n  id int\n}\n', 't', parser)).table.columns).toHaveLength(1);
    }
  });
});

describe('parseTableDbml: typed (unquoted) values, DBML 11 only', () => {
  const TYPED = `Table t [meta_owner: 007] {
  a int [natural_key: true]
  b int [natural_key: TRUE]
  c int [natural_key: false]
  d int [scd_type: 2]
  e int [meta_w: 1.50]
}
`;

  it('the pin reads each literal by its text, with an unquotedValue warning', () => {
    const reading = ok(parseTableDbml(TYPED, 't', PARSER_PINNED));
    expect(reading.table.meta).toEqual({ owner: '007' });
    const [a, b, c, d, e] = reading.table.columns!;
    expect([a.isNaturalKey, b.isNaturalKey, c.isNaturalKey, d.scdType, e.meta]).toEqual([true, true, undefined, 2, { w: '1.50' }]);
    expect(reading.problems.map((p) => p.code)).toEqual(Array(6).fill('unquotedValue'));
    expect(reading.problems.find((p) => p.message.includes('natural_key: true'))?.message)
      .toContain("quote it, as in `natural_key: 'true'`");
    expect(reading.writable).toBe(true);
  });

  it.each([['9.1.1', PARSER_V9], ['10.3.1', PARSER_V10]] as const)('%s refuses the same file as invalid DBML', (_label, parser) => {
    expect(failed(parseTableDbml(TYPED, 't', parser)).kind).toBe('dbmlInvalid');
  });
});

describe('parseTableDbml: failures', () => {
  it('empty text is a read failure', () => {
    expect(failed(parseTableDbml('  \n', 't')).kind).toBe('read');
  });

  it.each(STORAGE_PARSERS)('a syntax error is dbmlSyntax at its line (%s)', (_label, parser) => {
    const error = failed(parseTableDbml("Table t {\n  id int\n  name text [note: 'open'\n}\n", 't', parser));
    expect(error.kind).toBe('dbmlSyntax');
    expect(error.line).toBe(4);
  });

  it.each([
    ['role: fact', "Table t [role: fact] {\n  id int\n}\n", '3075'],
    ['grain: one row', "Table t [grain: one row] {\n  id int\n}\n", '3075'],
    ['k: null', 'Table t {\n  id int [k: null]\n}\n', '3025'],
  ])('an unquoted word (%s) is dbmlInvalid with the quote hint, under the pin', (_label, text, code) => {
    const reading = parseTableDbml(text, 't', PARSER_PINNED);
    const error = failed(reading);
    expect(error).toMatchObject({ kind: 'dbmlInvalid', code });
    expect(error.message).toContain(DBML_QUOTE_HINT);
    expect(describeTableLoadError(error)).toContain("quote it, as in grain: 'One row per order line'");
  });

  it('a binding error (a TablePartial that is not there) is dbmlStructure, without the hint', () => {
    const error = failed(parseTableDbml('Table t {\n  id int\n  ~missing_partial\n}\n', 't'));
    expect(error).toMatchObject({ kind: 'dbmlStructure', code: '4000', line: 3 });
    expect(error.message).not.toContain(DBML_QUOTE_HINT);
  });

  it.each([
    ['a Project', "Project p {\n  database_type: 'x'\n}\nTable t {\n  id int\n}\n", 'structure:unsupportedElement'],
    ['a TableGroup', 'Table t {\n  id int\n}\nTableGroup g {\n  t\n}\n', 'structure:unsupportedElement'],
    ['a top-level Note', "Table t {\n  id int\n}\nNote n {\n  'x'\n}\n", 'structure:unsupportedElement'],
    ['no Table', 'Enum e {\n  a\n}\n', 'structure:notOneTable'],
    ['two Tables', 'Table t {\n  id int\n}\nTable u {\n  id int\n}\n', 'structure:notOneTable'],
  ])('%s is a dbmlStructure error', (_label, text, code) => {
    expect(failed(parseTableDbml(text, 't'))).toMatchObject({ kind: 'dbmlStructure', code });
  });

  it('an Enum beside the Table is allowed, and the column type reads as its name', () => {
    const { table } = ok(parseTableDbml('Enum status {\n  open\n  closed\n}\nTable t {\n  s status\n}\n', 't'));
    expect(table.columns![0].dataType).toBe('status');
  });

  it('a Metadata block whose target is missing is the precise D25 error', () => {
    const text = "Table t {\n  id int\n}\nMetadata Column t.gone {\n  owner: 'x'\n}\n";
    const error = failed(parseTableDbml(text, 't'));
    expect(error).toMatchObject({ kind: 'dbmlStructure', code: 'structure:metadataTarget', line: 4, target: { element: 'column', name: 'gone' } });
    expect(describeTableLoadError(error)).toContain("targets column 'gone', which this table does not have");
  });

  it('a Metadata block that matches is read over the inline value (D25)', () => {
    const text = "Table t [grain: 'inline'] {\n  id int\n}\nMetadata Table t {\n  grain: 'from the block'\n}\n";
    expect(ok(parseTableDbml(text, 't')).table.grain).toBe('from the block');
  });

  it.each(STORAGE_PARSERS)('git conflict markers are dbmlSyntax with mergeConflict (%s)', (_label, parser) => {
    const text = 'Table t {\n<<<<<<< HEAD\n  id int\n=======\n  id bigint\n>>>>>>> branch\n}\n';
    expect(failed(parseTableDbml(text, 't', parser))).toMatchObject({ kind: 'dbmlSyntax', mergeConflict: true, line: 2 });
  });
});
