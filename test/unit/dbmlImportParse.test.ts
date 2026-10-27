/**
 * readDbml — the DBML reading half of Import DBML (src/services/dbmlImportParse.ts).
 *
 * Every reading test runs with the pinned `@dbml/parse` 10.3.1 (what the
 * extension bundles) and, where the raw model differs, with 9.1.1 and 11.0.0
 * (`dbml-parse-v9`, `dbml-parse-v11`): 11.0 writes custom properties as
 * `{ value, type, token }` and the normaliser must read both shapes.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as v9 from 'dbml-parse-v9';
import * as v11 from 'dbml-parse-v11';
import { describe, expect, it } from 'vitest';

import { DBML_RICH_EXPORT_HEADER } from '@erd-studio/core';
import {
  ERD_STUDIO_DBML_HEADER_PREFIX,
  dbmlProperties,
  dbmlPropertyText,
  isErdStudioExport,
  normaliseRawDbml,
  readDbml,
  type DbmlModel,
  type DbmlParserModule,
} from '../../src/services/dbmlImportParse';

const FIXTURES = path.resolve(__dirname, '../fixtures/dbml');
const fixture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');

const PARSERS: Array<[string, DbmlParserModule | undefined]> = [
  ['@dbml/parse 10.3.1', undefined],
  ['@dbml/parse 9.1.1', v9 as unknown as DbmlParserModule],
  ['@dbml/parse 11.0.0', v11 as unknown as DbmlParserModule],
];

function read(text: string, parser?: DbmlParserModule): DbmlModel {
  const result = readDbml(text, parser);
  if (!result.ok) throw new Error(`unexpected diagnostics: ${JSON.stringify(result.diagnostics)}`);
  return result.model;
}

describe('dbmlPropertyText / dbmlProperties', () => {
  it('reads a 9.x / 10.x plain string', () => {
    expect(dbmlPropertyText('dim')).toBe('dim');
    expect(dbmlPropertyText('')).toBe('');
  });

  it('reads an 11.x { value, type, token } object, typed values as text', () => {
    expect(dbmlPropertyText({ value: 'dim', type: 'string', token: {} })).toBe('dim');
    expect(dbmlPropertyText({ value: 2, type: 'number' })).toBe('2');
    expect(dbmlPropertyText({ value: 3.5, type: 'number' })).toBe('3.5');
    expect(dbmlPropertyText({ value: true, type: 'bool' })).toBe('true');
    expect(dbmlPropertyText({ value: null, type: 'null' })).toBe('');
  });

  it('ignores what is neither', () => {
    expect(dbmlPropertyText(undefined)).toBeUndefined();
    expect(dbmlPropertyText({ type: 'string' })).toBeUndefined();
    expect(dbmlPropertyText([1])).toBeUndefined();
    expect(dbmlProperties({ a: 'x', b: { value: 'y' }, c: { nope: 1 } })).toEqual({ a: 'x', b: 'y' });
    expect(dbmlProperties(null)).toEqual({});
  });

  it('keeps a property named __proto__ as an own entry', () => {
    const read = dbmlProperties(JSON.parse('{"__proto__":"x","b":"y"}'));
    expect(Object.getOwnPropertyNames(read)).toEqual(['__proto__', 'b']);
    expect(Object.getOwnPropertyDescriptor(read, '__proto__')?.value).toBe('x');
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
  });
});

describe('readDbml: diagnostics', () => {
  it('returns 1-based diagnostics and no model for an invalid file', () => {
    const result = readDbml('Table a {\n  id int [pk\n}\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toEqual({ line: 3, column: 1, message: expect.any(String) });
  });

  it('reports a custom property 10.x refuses (an unquoted number) at its line', () => {
    const result = readDbml('Table a [n: 2] {\n  id int\n}\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0].line).toBe(1);
    expect(result.diagnostics[0].message).toMatch(/must be a string/);
  });

  it('never throws, even for a parser that does', () => {
    const broken = { ...v11, Compiler: class { constructor() { throw new Error('boom'); } } } as unknown as DbmlParserModule;
    const result = readDbml('Table a { id int }', broken);
    expect(result).toEqual({ ok: false, diagnostics: [{ line: 1, column: 1, message: 'The DBML parser stopped: boom' }] });
  });

  it('reads an empty file as an empty model', () => {
    const model = read('');
    expect(model.tables).toEqual([]);
    expect(model.refs).toEqual([]);
    expect(model.project).toBeNull();
  });
});

describe('readDbml: header', () => {
  it('knows ERD Studio\'s own export by its first line', () => {
    expect(DBML_RICH_EXPORT_HEADER.startsWith(ERD_STUDIO_DBML_HEADER_PREFIX)).toBe(true);
    expect(isErdStudioExport(`${DBML_RICH_EXPORT_HEADER}\nTable a { id int }`)).toBe(true);
    expect(isErdStudioExport(`﻿\n\n${DBML_RICH_EXPORT_HEADER}\n`)).toBe(true);
    expect(isErdStudioExport('// exported by something else\n// erd-studio dbml-export v2')).toBe(false);
    expect(read(fixture('erd-studio/sales.dbml')).erdStudioExport).toBe(true);
    expect(read(fixture('foreign/ecommerce.dbml')).erdStudioExport).toBe(false);
  });
});

describe.each(PARSERS)('readDbml with %s', (_label, parser) => {
  it('reads custom properties on tables, columns and notes as plain text', () => {
    const model = read(fixture('erd-studio/sales.dbml'), parser);
    const fact = model.tables.find((t) => t.name === 'fct_order')!;
    expect(fact.schema).toBe('gold');
    expect(fact.properties).toEqual({
      role: 'transaction-fact',
      grain: 'One row per order line',
      alias: 'orders',
      rationale_purpose: 'Order reporting',
      rationale_scd_strategy: 'Facts are never\nupdated in place',
      meta_owner: 'sales-team',
      meta_json: '{"tier":"1","pii":false,"tags":["finance","daily"],"Odd Key":null}',
    });
    expect(fact.fields.find((f) => f.name === 'amount')).toMatchObject({
      type: 'decimal(18,2)',
      properties: { additive_type: 'additive', meta_unit: 'AUD' },
    });
    expect(fact.indexes).toEqual([{ columns: [{ value: 'order_id', expression: false }, { value: 'line_no', expression: false }], pk: true, unique: false }]);
    expect(model.notes[0]).toEqual({ name: 'sticky_1', content: 'Check the grain with finance', color: '#3b82f6', properties: { linked_table: 'fct_order' } });
    expect(model.notes[1].content).toBe('Two\nlines');
  });

  it('expands table partials into each table, in file order, with the table\'s own field winning', () => {
    const text = [
      'TablePartial audit [headerColor: #ff0000] {',
      '  created_at timestamp',
      '  name text [note: \'from the partial\']',
      '  indexes { created_at }',
      '  Note: \'Audit columns\'',
      '}',
      'TablePartial audit2 {',
      '  created_at date',
      '}',
      'Table t {',
      '  id int [pk]',
      '  ~audit',
      '  name varchar [note: \'own\']',
      '  last int',
      '  ~audit2',
      '}',
    ].join('\n');
    const [t] = read(text, parser).tables;
    expect(t.fields.map((f) => [f.name, f.type, f.fromPartial ?? null])).toEqual([
      ['id', 'int', null],
      ['name', 'varchar', null],
      ['last', 'int', null],
      // audit2's created_at replaces audit's, where audit2 is injected.
      ['created_at', 'date', 'audit2'],
    ]);
    expect(t.fields.find((f) => f.name === 'name')!.note).toBe('own');
    expect(t.partials).toEqual(['audit', 'audit2']);
    expect(t.note).toBe('Audit columns');
    expect(t.headerColor).toBe('#ff0000');
    expect(t.indexes.map((i) => i.columns.map((c) => c.value))).toEqual([['created_at']]);
  });

  it('keeps a partial field\'s position when nothing overrides it', () => {
    const text = 'TablePartial p {\n  a int\n  b int\n}\nTable t {\n  id int [pk]\n  ~p\n  z int\n}\n';
    expect(read(text, parser).tables[0].fields.map((f) => f.name)).toEqual(['id', 'a', 'b', 'z']);
  });

  it('turns an inline ref in a partial into a ref from every table that injects it', () => {
    const text = [
      'TablePartial owned {',
      '  owner_id int [ref: > users.id]',
      '}',
      'Table users {',
      '  id int [pk]',
      '}',
      'Table docs {',
      '  id int [pk]',
      '  ~owned',
      '}',
      'Table notes {',
      '  id int [pk]',
      '  ~owned',
      '}',
    ].join('\n');
    const model = read(text, parser);
    expect(model.refs.map((r) => [r.ends.map((e) => `${e.table}.${e.columns.join(',')}:${e.relation}`), r.declaredAt])).toEqual([
      [['docs.owner_id:*', 'users.id:1'], 0],
      [['notes.owner_id:*', 'users.id:1'], 0],
    ]);
  });

  it('names the end an inline ref was declared at, which the raw model lists second', () => {
    const text = 'Table users as U {\n  id int [pk]\n}\nTable posts {\n  id int [pk]\n  user_id int [ref: > U.id]\n  editor_id int [ref: - users.id]\n}\n';
    const model = read(text, parser);
    expect(model.refs).toHaveLength(2);
    for (const ref of model.refs) {
      expect(ref.declaredAt).toBe(1);
      expect(ref.ends[1].table).toBe('posts');
      // The DBML alias is resolved to the table's name.
      expect(ref.ends[0].table).toBe('users');
    }
    expect(model.refs.map((r) => r.ends.map((e) => e.relation))).toEqual([['1', '*'], ['1', '1']]);
    expect(model.tables[0].alias).toBe('U');
  });

  it('reads block refs: names, composite ends, optional ends and settings', () => {
    const model = read(fixture('foreign/ecommerce.dbml'), parser);
    const composite = model.refs.find((r) => r.name === 'fk_merchant')!;
    expect(composite.declaredAt).toBeUndefined();
    expect(composite.ends).toEqual([
      { schema: 'ecommerce', table: 'products', columns: ['merchant_id', 'country_code'], relation: '*' },
      { schema: 'ecommerce', table: 'merchants', columns: ['id', 'country_code'], relation: '1' },
    ]);
    expect(composite).toMatchObject({ onDelete: 'cascade', onUpdate: 'no action', color: '#79AD51', inactive: false });
    const optional = model.refs.find((r) => r.ends[0].table === 'order_items' && r.ends[0].columns[0] === 'order_id')!;
    expect(optional.ends.map((e) => e.relation)).toEqual(['*', '0..1']);
    expect(model.refs.find((r) => r.inactive)!.ends[1].table).toBe('products');
  });

  it('reads columns: types, notes, pk, unique, not null, increment, defaults and checks', () => {
    const model = read(fixture('foreign/ecommerce.dbml'), parser);
    const users = model.tables.find((t) => t.name === 'users')!;
    const field = (name: string) => users.fields.find((f) => f.name === name)!;
    expect(field('id')).toMatchObject({ pk: true, increment: true });
    expect(field('full_name')).toMatchObject({ notNull: true, unique: false });
    expect(field('email')).toMatchObject({ unique: true, note: 'Login email' });
    expect(field('country_code').default).toEqual({ type: 'number', value: '61' });
    expect(field('age').checks).toEqual([{ expression: 'age >= 0' }]);
    expect(field('created_at')).toMatchObject({ notNull: true, default: { type: 'expression', value: 'now()' }, fromPartial: 'timestamps' });
    const products = model.tables.find((t) => t.name === 'products')!;
    expect(products.headerColor).toBe('#79AD51');
    expect(products.fields.find((f) => f.name === 'status')!.default).toEqual({ type: 'string', value: 'created' });
    expect(products.checks).toEqual([{ expression: 'price >= 0', name: 'chk_price' }]);
    expect(products.indexes).toEqual([
      { columns: [{ value: 'merchant_id', expression: false }, { value: 'status', expression: false }], pk: false, unique: false, name: 'product_status' },
      { columns: [{ value: 'id', expression: false }], pk: false, unique: true },
      { columns: [{ value: 'lower(name)', expression: true }], pk: false, unique: false, type: 'hash' },
    ]);
    // A table with no colour of its own takes its partial's; products keeps its own.
    expect(users.headerColor).toBe('#3498DB');
  });

  it('reads enums, records, the project and its settings', () => {
    const model = read(fixture('foreign/ecommerce.dbml'), parser);
    expect(model.enums).toEqual([{
      name: 'order_status',
      schema: null,
      values: [{ name: 'created', note: 'Waiting to be processed' }, { name: 'running' }, { name: 'done' }, { name: 'failure' }],
    }]);
    expect(model.records).toEqual([{ schema: null, table: 'countries', rows: 2 }]);
    expect(model.project).toEqual({
      name: 'ecommerce',
      note: 'Online shop: users, merchants, products and orders',
      properties: { database_type: 'PostgreSQL' },
    });
  });

  it('reads table groups and sticky notes', () => {
    const model = read(fixture('foreign/sticky-groups.dbml'), parser);
    expect(model.tableGroups).toEqual([{
      name: 'people',
      tables: [{ name: 'employees', schema: null }, { name: 'badges', schema: null }],
      color: '#E74C3C',
      note: 'People data',
    }]);
    expect(model.notes.map((n) => [n.name, n.color ?? null])).toEqual([['sticky_1', '#ffcc00'], ['todo', null]]);
    expect(model.notes[1].content).toContain('Multi-line note');
  });

  it('keeps quoted, odd and schema-qualified names exactly', () => {
    const model = read(fixture('foreign/odd-names.dbml'), parser);
    expect(model.tables.map((t) => [t.schema, t.name])).toEqual([
      [null, 'Order Items'],
      ['silver', 'date'],
      ['gold', 'date'],
      [null, 'Users'],
      [null, 'users'],
      [null, '2024_sales'],
    ]);
    expect(model.tables[0].fields.map((f) => f.name)).toEqual(['item id', 'unit-price', 'Unit Price']);
    expect(model.refs.find((r) => r.name === 'sale date')!.ends.map((e) => e.table)).toEqual(['2024_sales', 'date']);
  });

  it('reads the dbdiagram pull fixture', () => {
    const model = read(fixture('dbdiagram-pull/silver.dbml'), parser);
    expect(model.erdStudioExport).toBe(true);
    expect(model.tables.map((t) => `${t.schema ?? ''}.${t.name}`)).toEqual([
      'silver.fct_task_event', 'silver.dim_task', 'silver.dim_project', 'silver.dim_customer', 'silver.dim_date', '.fct_order',
    ]);
    expect(model.refs).toHaveLength(7);
    expect(model.tableGroups[0]).toMatchObject({ name: 'silver', color: '#a0a0a0', note: 'Silver layer' });
  });
});

describe('readDbml: 11.0 typed values', () => {
  it('reads unquoted numbers and booleans 11.0 allows as text', () => {
    const model = read('Table docs [n: 2, flag: true] {\n  id int [pk, weight: 3.5]\n}\n', v11 as unknown as DbmlParserModule);
    expect(model.tables[0].properties).toEqual({ n: '2', flag: 'true' });
    expect(model.tables[0].fields[0].properties).toEqual({ weight: '3.5' });
  });

  it('reads 10.x and 11.0 output of the same file into the same model', () => {
    const text = fixture('erd-studio/sales.dbml');
    expect(read(text, v11 as unknown as DbmlParserModule)).toEqual(read(text));
    const foreign = fixture('foreign/ecommerce.dbml');
    expect(read(foreign, v11 as unknown as DbmlParserModule)).toEqual(read(foreign));
  });
});

describe('normaliseRawDbml', () => {
  it('reads a raw model with missing pieces without throwing', () => {
    const model = normaliseRawDbml({ tables: [{ name: 't', fields: [{ name: 'a', type: { type_name: 'int' } }, 'junk'] }], refs: [{ endpoints: [{}] }] });
    expect(model.tables[0].fields).toEqual([expect.objectContaining({ name: 'a', type: 'int', pk: false, properties: {} })]);
    expect(model.refs).toEqual([]);
    expect(model.project).toBeNull();
  });

  it('qualifies a schema-qualified type', () => {
    const model = normaliseRawDbml({ tables: [{ name: 't', fields: [{ name: 'a', type: { schemaName: 'shop', type_name: 'status' } }] }] });
    expect(model.tables[0].fields[0].type).toBe('shop.status');
  });

  it('counts dependency arrows and diagram views', () => {
    const model = normaliseRawDbml({ deps: [{}, {}], diagramViews: [{}] });
    expect(model.dependencies).toBe(2);
    expect(model.diagramViews).toBe(1);
  });
});
