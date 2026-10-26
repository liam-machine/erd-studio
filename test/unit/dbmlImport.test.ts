/**
 * The Import DBML planner (src/services/dbmlImport.ts): the mapping row by
 * row, foreign DBML (dbdiagram's syntax: inline and composite refs,
 * partials, enums, optional refs, odd and schema-qualified names, notes,
 * groups, indexes, Records), a real `dbdiagram pull`, collisions with an
 * existing Table Library, library vs subject-area relationship storage, v5
 * vs v6 naming and folder-grouped libraries.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as v11 from 'dbml-parse-v11';
import { afterEach, describe, expect, it } from 'vitest';

import { DBML_RICH_EXPORT_HEADER, detectSubjectAreaFormat, readDbdiagramLayout, validateSubjectAreaDocument } from '@erd-studio/core';
import {
  DBML_META_KEY,
  analyseDbml,
  describeDbmlImportPlan,
  planDbmlImport,
  sanitiseDbmlColumnName,
  sanitiseDbmlTableName,
  serializeDbmlImportDocument,
  suggestDbmlLayer,
  suggestDbmlSubjectAreaName,
  type DbmlImportLibrary,
  type DbmlImportPlan,
  type PlanDbmlImportInput,
} from '../../src/services/dbmlImport';
import { readDbml, type DbmlModel, type DbmlParserModule } from '../../src/services/dbmlImportParse';
import { TableLibraryService } from '../../src/services/logicalModelService';
import type { ColumnDef, Relationship, SemanticTable } from '../../src/types/semantic';

const FIXTURES = path.resolve(__dirname, '../fixtures/dbml');
const fixture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');
const LAYERS = ['bronze', 'silver', 'gold'];

function model(text: string, parser?: DbmlParserModule): DbmlModel {
  const result = readDbml(text, parser);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.model;
}

/** A Table Library of `tables`, looked up as TableLibraryService does (names ignoring case). */
function library(tables: SemanticTable[] = [], unreadable: string[] = []): DbmlImportLibrary {
  return {
    findTableName: (name) =>
      tables.find((t) => t.name.toLowerCase() === name.toLowerCase())?.name
      ?? unreadable.find((n) => n.toLowerCase() === name.toLowerCase())
      ?? null,
    getTable: (name) => tables.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null,
  };
}

function plan(text: string, extra: Partial<PlanDbmlImportInput> = {}): DbmlImportPlan {
  return planDbmlImport({
    model: model(text),
    layer: 'gold',
    subjectAreaName: 'imported',
    library: library(),
    libraryRelationships: false,
    ...extra,
  });
}

const salesLayout = () => readDbdiagramLayout(fixture('erd-studio/sales.dbdiagram'));
const salesPlan = (extra: Partial<PlanDbmlImportInput> = {}): DbmlImportPlan =>
  plan(fixture('erd-studio/sales.dbml'), { layout: salesLayout(), fileName: 'sales.dbml', ...extra });

const tableOf = (p: DbmlImportPlan, name: string): SemanticTable => {
  const t = p.newTables.find((m) => m.name === name);
  if (!t) throw new Error(`no new table ${name}: ${p.newTables.map((m) => m.name).join(', ')}`);
  return t;
};
const columnOf = (t: SemanticTable, name: string): ColumnDef => {
  const c = t.columns?.find((col) => col.name === name);
  if (!c) throw new Error(`no column ${name} in ${t.name}`);
  return c;
};
const ends = (r: Relationship): string => `${r.fromModel}.${r.fromColumn} -> ${r.toModel}.${r.toColumn} ${r.cardinality}`;

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

describe('sanitising names', () => {
  it.each([
    ['dim_customer', 'dim_customer'],
    ['DimCustomer', 'DimCustomer'],
    ['Order Items', 'Order_Items'],
    ['order-items', 'order_items'],
    ['  spaced  ', 'spaced'],
    ['2024_sales', 't_2024_sales'],
    ['_hidden', 'hidden'],
    ['ünïcode', 'n_code'],
    ['***', 'table'],
  ])('table %j → %j', (from, to) => {
    expect(sanitiseDbmlTableName(from)).toBe(to);
  });

  it.each([
    ['customer_key', 'customer_key'],
    ['2fa', '2fa'],
    ['item id', 'item_id'],
    ['unit-price', 'unit_price'],
    ['%', 'column'],
  ])('column %j → %j', (from, to) => {
    expect(sanitiseDbmlColumnName(from)).toBe(to);
  });
});

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

describe('analyseDbml', () => {
  it('suggests the Project name and the layer the export\'s TableGroup names', () => {
    const analysis = analyseDbml(model(fixture('erd-studio/sales.dbml')), { layerIds: LAYERS, fileName: '/x/y/other.dbml' });
    expect(analysis).toEqual({
      suggestedName: 'sales',
      suggestedLayer: 'gold',
      projectName: 'sales',
      tableCount: 7,
      relationshipCount: 6,
      stickyNoteCount: 2,
      erdStudioExport: true,
    });
  });

  it('falls back to the file name, then dbml-import, and avoids names in use', () => {
    const noProject = model('Table a {\n  id int\n}\n');
    expect(suggestDbmlSubjectAreaName(noProject, 'C:\\exports\\Customer 360.dbml')).toBe('customer-360');
    expect(suggestDbmlSubjectAreaName(noProject)).toBe('dbml-import');
    expect(suggestDbmlSubjectAreaName(noProject, '___.dbml')).toBe('dbml-import');
    expect(suggestDbmlSubjectAreaName(noProject, 'sales.dbml', ['sales', 'sales-2'])).toBe('sales-3');
    expect(analyseDbml(noProject, { layerIds: LAYERS, fileName: 'sales.dbml', takenSubjectAreaNames: ['Sales'] }).suggestedName).toBe('sales-2');
  });

  it('suggests a layer from the group with the most tables, else the schema most tables use, matched without case', () => {
    const groups = model([
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((t) => `Table ${t} {\n  id int\n}`),
      'TableGroup Silver {\n  a\n}', 'TableGroup GOLD {\n  b\n  c\n}', 'TableGroup other {\n  d\n  e\n  f\n}',
    ].join('\n'));
    expect(suggestDbmlLayer(groups, LAYERS)).toBe('gold');
    const schemas = model('Table silver.a {\n  id int\n}\nTable Bronze.b {\n  id int\n}\nTable bronze.c {\n  id int\n}\n');
    expect(suggestDbmlLayer(schemas, LAYERS)).toBe('bronze');
    expect(suggestDbmlLayer(model(fixture('foreign/ecommerce.dbml')), LAYERS)).toBeUndefined();
    expect(analyseDbml(model(fixture('foreign/ecommerce.dbml')), { layerIds: LAYERS })).not.toHaveProperty('suggestedLayer');
  });
});

// ---------------------------------------------------------------------------
// ERD Studio's own rich export, row by row
// ---------------------------------------------------------------------------

describe('an ERD Studio rich export, row by row', () => {
  it('Project → the subject area document', () => {
    const p = salesPlan();
    expect(p.document).toMatchObject({
      schemaVersion: 5,
      domain: 'imported',
      layer: 'gold',
      description: 'Orders and the customers who place them',
    });
    expect(Object.keys(p.document)).toEqual(['schemaVersion', 'domain', 'layer', 'description', 'logical', 'viewConfig']);
    expect(p.document.logical.models).toEqual(['fct_order', 'dim_customer', 'dim_passport', 'dim_date', 'fct_shipment', 'empty_stub', 'bridge_tag']);
    expect(p.modelNames).toEqual(p.document.logical.models);
  });

  it('the layer\'s TableGroup is not reported as dropped', () => {
    expect(salesPlan().report.dropped).toEqual([]);
    expect(salesPlan({ layer: 'silver' }).report.dropped).toEqual([
      { what: 'Table group gold (7 tables)', why: 'ERD Studio has no table groups; its tables were imported.' },
    ]);
  });

  it('table, schema, Note, role, grain, alias and rationale', () => {
    const fact = tableOf(salesPlan(), 'fct_order');
    expect(fact).toMatchObject({
      name: 'fct_order',
      schema: 'gold',
      description: 'Order lines',
      modelRole: 'transaction-fact',
      grain: 'One row per order line',
      alias: 'orders',
      rationale: { purpose: 'Order reporting', scdStrategy: 'Facts are never\nupdated in place' },
    });
  });

  it('meta_<key> and meta_json → meta, exactly (numbers as their text)', () => {
    const fact = tableOf(salesPlan(), 'fct_order');
    expect(fact.meta).toEqual({ owner: 'sales-team', tier: '1', pii: false, tags: ['finance', 'daily'], 'Odd Key': null });
    expect(columnOf(fact, 'amount').meta).toEqual({ unit: 'AUD' });
    expect(columnOf(fact, 'discount').meta).toEqual({ nullable: true });
  });

  it('keeps a meta key named __proto__ as an own entry, from meta___proto__ and from meta_json', () => {
    // Plain assignment swallowed both (round-trip bug): the export writes
    // `meta___proto__` for a text value and a map under `meta_json`.
    const text = [
      'Table t [meta___proto__: \'a\', meta_json: \'{"__proto__":{"polluted":"yes"},"n":2}\'] {',
      '  c int [meta___proto__: \'b\', erd_x: \'y\']',
      '}',
      '',
    ].join('\n');
    const t = tableOf(plan(text), 't');
    // meta_json's own __proto__ (a map) wins over meta___proto__, as a later key does.
    expect(Object.getOwnPropertyNames(t.meta)).toEqual(['__proto__', 'n']);
    expect(Object.getOwnPropertyDescriptor(t.meta, '__proto__')?.value).toEqual({ polluted: 'yes' });
    expect(Object.getPrototypeOf(t.meta)).toBe(Object.prototype);
    expect(t.meta!.n).toBe('2');
    const meta = columnOf(t, 'c').meta!;
    expect(Object.getOwnPropertyDescriptor(meta, '__proto__')?.value).toBe('b');
  });

  it('reads an empty meta_json as no meta, not as text it could not read', () => {
    const p = plan("Table t [meta_json: '{}'] {\n  c int\n}\n");
    expect(tableOf(p, 't').meta).toBeUndefined();
    expect(p.report.notes).toEqual([]);
  });

  it('schema: \'public\' on a table with no schema → schema public (DBML reads public.x as x)', () => {
    // Round-trip bug: a model in the schema public came back with none.
    const text = [
      "Table public.a [schema: 'public'] {", '  id int', '}',
      "Table s.b [schema: 's'] {", '  id int', '}',
      "Table s.c [schema: 'other'] {", '  id int', '}',
      '',
    ].join('\n');
    const p = plan(text);
    expect(tableOf(p, 'a').schema).toBe('public');
    expect(tableOf(p, 'a').meta).toBeUndefined();
    expect(tableOf(p, 'b')).toEqual({ name: 'b', schema: 's', columns: [{ name: 'id', dataType: 'int', description: '' }] });
    // A schema property that disagrees with the table's own schema is kept, not applied.
    expect(tableOf(p, 'c').schema).toBe('s');
    expect(tableOf(p, 'c').meta).toEqual({ [DBML_META_KEY]: { properties: { schema: 'other' } } });
  });

  it('pk and a composite pk index → isPrimaryKey', () => {
    const p = salesPlan();
    const fact = tableOf(p, 'fct_order');
    expect(fact.columns!.filter((c) => c.isPrimaryKey).map((c) => c.name)).toEqual(['order_id', 'line_no']);
    expect(columnOf(tableOf(p, 'dim_customer'), 'customer_key').isPrimaryKey).toBe(true);
    // The pk index is the key, not an index kept in meta.
    expect(fact.meta).not.toHaveProperty(DBML_META_KEY);
  });

  it('natural_key, scd_type, additive_type and foreign_key → the column flags', () => {
    const p = salesPlan();
    const fact = tableOf(p, 'fct_order');
    const customer = tableOf(p, 'dim_customer');
    expect(columnOf(fact, 'order_id')).toEqual({ name: 'order_id', dataType: 'int', description: 'Order number', isPrimaryKey: true, isNaturalKey: true });
    expect(columnOf(fact, 'customer_key').isForeignKey).toBe(true);
    expect(columnOf(fact, 'ship_date_key').isForeignKey).toBeUndefined();
    expect(columnOf(fact, 'amount')).toMatchObject({ dataType: 'decimal(18,2)', additiveType: 'additive' });
    expect(columnOf(fact, 'discount').additiveType).toBe('non-additive');
    expect(columnOf(customer, 'customer_id')).toMatchObject({ isNaturalKey: true, scdType: 0 });
    expect(columnOf(customer, 'segment').scdType).toBe(2);
    expect(columnOf(tableOf(p, 'dim_passport'), 'country').scdType).toBe(1);
  });

  it('the placeholder column is dropped: the table has no columns', () => {
    expect(tableOf(salesPlan(), 'empty_stub')).toEqual({ name: 'empty_stub', schema: 'gold' });
  });

  it('Refs → relationships on the FK side; names → roles; one-to-one; many-to-many; composites share compositeKey', () => {
    const p = salesPlan();
    expect(p.relationships.map(ends)).toEqual([
      'fct_order.customer_key -> dim_customer.customer_key many-to-one',
      'fct_order.ship_date_key -> dim_date.date_key many-to-one',
      'fct_order.order_date_key -> dim_date.date_key many-to-one',
      'dim_customer.passport_key -> dim_passport.passport_key one-to-one',
      'fct_shipment.order_id -> fct_order.order_id many-to-one',
      'fct_shipment.line_no -> fct_order.line_no many-to-one',
      'bridge_tag.tag_id -> dim_customer.customer_key many-to-many',
    ]);
    expect(p.relationships.map((r) => r.role ?? null)).toEqual([null, 'ship date', 'order date', null, null, null, null]);
    expect(p.relationships.map((r) => r.compositeKey ?? null)).toEqual([null, null, null, null, 'fk_fct_order', 'fk_fct_order', null]);
    expect(p.document.logical.relationships).toEqual(p.relationships);
  });

  it('the unique an export adds to a one-to-one FK column is not kept', () => {
    const column = columnOf(tableOf(salesPlan(), 'dim_customer'), 'passport_key');
    expect(column.meta).toBeUndefined();
  });

  it('nor the unique index it adds over a composite one-to-one\'s FK columns; other indexes stay', () => {
    const text = [
      'Table a {',
      '  x int',
      '  y int',
      '  z int',
      '  indexes {',
      '    (x, y) [unique]',
      '    (y, z) [unique]',
      '  }',
      '}',
      'Table b {',
      '  u int',
      '  v int',
      '  indexes {',
      '    (u, v) [pk]',
      '  }',
      '}',
      'Ref: a.(x, y) -? b.(u, v)',
    ].join('\n');
    const p = plan(text);
    expect(p.relationships.map(ends)).toEqual(['a.x -> b.u one-to-one', 'a.y -> b.v one-to-one']);
    expect(tableOf(p, 'a').meta).toEqual({ dbml: { indexes: [{ columns: ['y', 'z'], unique: true }] } });
  });

  it('a table written public.name matches refs and layout entries without a schema', () => {
    const text = 'Table public.users {\n  id int [pk]\n}\nTable posts {\n  user_id int\n}\nRef: posts.user_id > users.id\n';
    const layout = { tables: [{ name: 'users', schemaName: 'public', x: 1, y: 2 }, { name: 'posts', schemaName: 'public', x: 3, y: 4 }], stickies: [], problems: [] };
    const p = plan(text, { layout });
    expect(p.relationships.map(ends)).toEqual(['posts.user_id -> users.id many-to-one']);
    // The parser reads `public` as DBML's default schema, which is no schema.
    expect(tableOf(p, 'users').schema).toBeUndefined();
    expect(p.document.viewConfig.positions).toEqual({ users: { x: 1, y: 2 }, posts: { x: 3, y: 4 } });
  });

  it('positions come from the .dbdiagram, keyed by the imported name; a table it misses gets none', () => {
    const p = salesPlan();
    expect(p.document.viewConfig.positions).toEqual({
      fct_order: { x: 400, y: 120 },
      dim_customer: { x: 0, y: 0 },
      dim_passport: { x: -320, y: 40.5 },
      dim_date: { x: 800, y: -60 },
      fct_shipment: { x: 400, y: 520 },
      empty_stub: { x: 900, y: 500 },
    });
    expect(p.report).toMatchObject({ positioned: 6, unpositioned: 1, layoutRead: true, layoutProblems: [] });
  });

  it('sticky notes → annotations: colours read back, linked_table linked, placed above the diagram when the layout has none', () => {
    const p = salesPlan();
    expect(p.document.viewConfig.annotations).toEqual([
      { id: 'dbml-sticky_1', text: 'Check the grain with finance', x: -320, y: -260, color: 'blue', linkedModel: 'fct_order' },
      { id: 'dbml-sticky_2', text: 'Two\nlines', x: -60, y: -260, color: 'yellow' },
    ]);
  });

  it('a sticky note the layout places keeps its place and size', () => {
    const layout = { ...salesLayout(), stickies: [{ name: 'sticky_2', x: 10, y: 20, width: 300, height: 120 }] };
    const notes = salesPlan({ layout }).document.viewConfig.annotations!;
    expect(notes[1]).toEqual({ id: 'dbml-sticky_2', text: 'Two\nlines', x: 10, y: 20, width: 300, height: 120, color: 'yellow' });
    expect(notes[0]).toMatchObject({ x: -320, y: -260 });
  });

  it('nothing is renamed, dropped or kept in meta.dbml', () => {
    const { report } = salesPlan();
    expect(report).toMatchObject({ renamed: [], dropped: [], notes: [], keptInMeta: 0, relationships: 7, stickyNotes: 2, erdStudioExport: true });
    expect(report.newTables).toHaveLength(7);
  });

  it('an ERD Studio export with no Project note has an empty description', () => {
    const text = fixture('erd-studio/sales.dbml').replace("  Note: 'Orders and the customers who place them'\n", '');
    expect(plan(text).document.description).toBe('');
  });

  it('also reads every property with the erd_ prefix', () => {
    const text = [
      'Table t [erd_role: \'reference\', erd_grain: \'One row per code\', erd_alias: \'codes\', erd_rationale_design: \'Small\', erd_meta_owner: \'me\', erd_meta_json: \'{"n":"1"}\'] {',
      '  code varchar [pk, erd_natural_key: \'true\', erd_scd_type: \'1\', erd_meta_json: \'{"x":true}\']',
      '  amount int [erd_additive_type: \'semi-additive\', erd_foreign_key: \'true\', erd_meta_unit: \'kg\']',
      '}',
      'Note sticky_1 [erd_linked_table: \'t\'] {',
      '  \'hi\'',
      '}',
    ].join('\n');
    const p = plan(text);
    expect(p.newTables[0]).toEqual({
      name: 't',
      modelRole: 'reference',
      grain: 'One row per code',
      alias: 'codes',
      columns: [
        { name: 'code', dataType: 'varchar', description: '', isNaturalKey: true, scdType: 1, meta: { x: true }, isPrimaryKey: true },
        { name: 'amount', dataType: 'int', description: '', additiveType: 'semi-additive', isForeignKey: true, meta: { unit: 'kg' } },
      ],
      rationale: { design: 'Small' },
      meta: { owner: 'me', n: '1' },
    });
    expect(p.document.viewConfig.annotations![0].linkedModel).toBe('t');
  });

  it('reads the same plan from 11.0\'s typed metadata', () => {
    const text = fixture('erd-studio/sales.dbml');
    const fromV11 = planDbmlImport({
      model: model(text, v11 as unknown as DbmlParserModule),
      layout: salesLayout(),
      layer: 'gold',
      subjectAreaName: 'imported',
      library: library(),
      libraryRelationships: false,
    });
    expect(fromV11).toEqual(salesPlan({ fileName: undefined }));
  });

  it('values ERD Studio does not recognise are kept in meta.dbml.properties and noted', () => {
    const text = [
      'Table t [role: \'dimension\', alias: \'not valid!\', meta_json: \'{oops\'] {',
      '  a int [scd_type: \'3\', additive_type: \'sometimes\', natural_key: \'no\']',
      '}',
    ].join('\n');
    const p = plan(text);
    const t = p.newTables[0];
    expect(t.modelRole).toBeUndefined();
    expect(t.alias).toBeUndefined();
    expect(t.meta).toEqual({ [DBML_META_KEY]: { properties: { role: 'dimension', alias: 'not valid!', meta_json: '{oops' } } });
    expect(t.columns![0]).toEqual({
      name: 'a', dataType: 'int', description: '',
      meta: { [DBML_META_KEY]: { properties: { scd_type: '3', additive_type: 'sometimes' } } },
    });
    expect(p.report.notes).toEqual([
      't: "dimension" is not an ERD Studio table role, so it was kept in meta.dbml.',
      't: "not valid!" cannot be a warehouse table name, so it was kept in meta.dbml.',
      't: meta_json is not valid JSON, so it was kept as text in meta.dbml.',
      't.a: SCD type "3" is not 0, 1 or 2, so it was kept in meta.dbml.',
      't.a: additive type "sometimes" is not additive, semi-additive or non-additive, so it was kept in meta.dbml.',
    ]);
  });

  it('a role ERD Studio wrote is kept as it is, as its table file keeps it; another tool\'s must be a known role', () => {
    const table = 'Table t [role: \'fact\'] {\n  id int\n}\n';
    expect(plan(`${DBML_RICH_EXPORT_HEADER}\n${table}`).newTables[0].modelRole).toBe('fact');
    expect(plan(table).newTables[0].modelRole).toBeUndefined();
  });

  it('meta_json that brought back meta.dbml is merged with this file\'s own DBML settings', () => {
    const text = 'Table t {\n  a int [not null, meta_json: \'{"dbml":{"default":"1"},"x":"y"}\']\n}\n';
    expect(plan(text).newTables[0].columns![0].meta).toEqual({ dbml: { default: '1', not_null: true }, x: 'y' });
  });
});

// ---------------------------------------------------------------------------
// Foreign DBML
// ---------------------------------------------------------------------------

describe('foreign DBML (dbdiagram syntax)', () => {
  const ecommerce = (extra: Partial<PlanDbmlImportInput> = {}): DbmlImportPlan =>
    plan(fixture('foreign/ecommerce.dbml'), { layer: 'silver', fileName: 'ecommerce.dbml', ...extra });

  it('columns: what ERD Studio has no field for goes to meta.dbml', () => {
    const users = tableOf(ecommerce(), 'users');
    expect(columnOf(users, 'id')).toEqual({ name: 'id', dataType: 'int', description: '', isPrimaryKey: true, meta: { dbml: { increment: true } } });
    expect(columnOf(users, 'full_name').meta).toEqual({ dbml: { not_null: true } });
    expect(columnOf(users, 'email')).toEqual({ name: 'email', dataType: 'varchar', description: 'Login email', meta: { dbml: { unique: true } } });
    expect(columnOf(users, 'country_code').meta).toEqual({ dbml: { default: '61' } });
    expect(columnOf(users, 'age').meta).toEqual({ dbml: { checks: ['age >= 0'] } });
  });

  it('partials are expanded into the tables that use them', () => {
    const p = ecommerce();
    const users = tableOf(p, 'users');
    expect(users.columns!.map((c) => c.name)).toEqual(['id', 'full_name', 'email', 'country_code', 'age', 'created_at', 'updated_at']);
    expect(columnOf(users, 'created_at').meta).toEqual({ dbml: { not_null: true, default: '`now()`' } });
    expect(users.description).toBe('Shop users');
    expect(tableOf(p, 'products').columns!.map((c) => c.name)).toContain('updated_at');
  });

  it('tables: DBML alias, header colour, non-key indexes and checks go to meta.dbml', () => {
    const p = ecommerce();
    expect(tableOf(p, 'users').meta).toEqual({ dbml: { alias: 'U', header_color: '#3498DB' } });
    expect(tableOf(p, 'products')).toMatchObject({
      schema: 'ecommerce',
      meta: {
        dbml: {
          header_color: '#79AD51',
          indexes: [
            { columns: ['merchant_id', 'status'], name: 'product_status' },
            { columns: ['id'], unique: true },
            { columns: ['`lower(name)`'], type: 'hash' },
          ],
          checks: [{ name: 'chk_price', expression: 'price >= 0' }],
        },
      },
    });
  });

  it('a composite pk index → isPrimaryKey on each column', () => {
    const merchants = tableOf(ecommerce(), 'merchants');
    expect(merchants.columns!.filter((c) => c.isPrimaryKey).map((c) => c.name)).toEqual(['id', 'country_code']);
    expect(merchants.meta).toBeUndefined();
  });

  it('enum types keep their values in meta.dbml.enum, the type name as the data type', () => {
    const p = ecommerce();
    expect(columnOf(tableOf(p, 'products'), 'status')).toEqual({
      name: 'status', dataType: 'order_status', description: '',
      meta: { dbml: { default: 'created', enum: ['created', 'running', 'done', 'failure'] } },
    });
    expect(columnOf(tableOf(p, 'orders'), 'status').meta).toEqual({ dbml: { enum: ['created', 'running', 'done', 'failure'] } });
  });

  it('inline refs, block refs, a DBML alias and a composite ref → relationships', () => {
    const p = ecommerce();
    expect(p.relationships.map(ends)).toEqual([
      'users.country_code -> countries.code many-to-one',
      'merchants.admin_id -> users.id many-to-one',
      'products.merchant_id -> merchants.id many-to-one',
      'products.country_code -> merchants.country_code many-to-one',
      'orders.user_id -> users.id many-to-one',
      'order_items.order_id -> orders.id many-to-one',
      'order_items.product_id -> products.id many-to-one',
    ]);
    const composite = p.relationships.filter((r) => r.fromModel === 'products');
    expect(composite.map((r) => [r.role, r.compositeKey])).toEqual([['fk_merchant', 'fk_merchants'], ['fk_merchant', 'fk_merchants']]);
    expect(p.report.optionalRefs).toBe(1);
  });

  it('reports what is dropped: Records, ref settings, inactive, the database type', () => {
    expect(ecommerce().report.dropped).toEqual([
      {
        what: 'Reference "fk_merchant" ecommerce.products.(merchant_id, country_code) – ecommerce.merchants.(id, country_code): delete: cascade, update: no action, color: #79AD51',
        why: 'ERD Studio does not record what a reference does on delete or update, its colour, or whether it is inactive. The relationship itself was imported.',
      },
      {
        what: 'Reference order_items.product_id – ecommerce.products.id: inactive',
        why: 'ERD Studio does not record what a reference does on delete or update, its colour, or whether it is inactive. The relationship itself was imported.',
      },
      { what: 'Records for countries (2 rows)', why: 'ERD Studio does not keep sample data.' },
      { what: 'Project setting database_type: PostgreSQL', why: 'ERD Studio does not record the database type.' },
    ]);
  });

  it('the Project note is the description; no layout means no positions', () => {
    const p = ecommerce();
    expect(p.document.description).toBe('Online shop: users, merchants, products and orders');
    expect(p.document.viewConfig).toEqual({});
    expect(p.report).toMatchObject({ positioned: 0, unpositioned: 6, layoutRead: false, erdStudioExport: false });
    expect(p.report.keptInMeta).toBeGreaterThan(0);
  });

  it('a foreign file without a Project note is described by its file name', () => {
    const p = plan('Table a {\n  id int\n}\n', { fileName: '/tmp/x/My Diagram.dbml' });
    expect(p.document.description).toBe('Imported from My Diagram.dbml.');
    expect(plan('Table a {\n  id int\n}\n').document.description).toBe('Imported from DBML.');
    expect(plan('Table a {\n  id int\n}\n', { description: 'Mine' }).document.description).toBe('Mine');
  });

  describe('odd and clashing names', () => {
    const odd = (): DbmlImportPlan => plan(fixture('foreign/odd-names.dbml'), { layer: 'silver' });

    it('renames tables to names ERD Studio can use, keeping the original', () => {
      const p = odd();
      expect(p.modelNames).toEqual(['Order_Items', 'silver_date', 'gold_date', 'Users', 'users_2', 't_2024_sales']);
      expect(tableOf(p, 'silver_date')).toMatchObject({ schema: 'silver', alias: 'date' });
      expect(tableOf(p, 'gold_date')).toMatchObject({ schema: 'gold', alias: 'date' });
      expect(tableOf(p, 'users_2').alias).toBe('users');
      expect(tableOf(p, 'Users').alias).toBeUndefined();
      // Not a valid warehouse name: kept in meta.dbml.name instead.
      expect(tableOf(p, 'Order_Items')).toMatchObject({ meta: { dbml: { name: 'Order Items' } } });
      expect(tableOf(p, 'Order_Items').alias).toBeUndefined();
      expect(tableOf(p, 't_2024_sales').meta).toEqual({ dbml: { name: '2024_sales' } });
    });

    it('renames columns, keeping the original in meta.dbml.name, and keeps them unique', () => {
      const items = tableOf(odd(), 'Order_Items');
      expect(items.columns!.map((c) => [c.name, (c.meta?.dbml as { name?: string } | undefined)?.name ?? null])).toEqual([
        ['item_id', 'item id'],
        ['unit_price', 'unit-price'],
        ['Unit_Price_2', 'Unit Price'],
      ]);
      expect(columnOf(tableOf(odd(), 'users_2'), '2fa').meta).toBeUndefined();
    });

    it('reports every rename with its reason', () => {
      expect(odd().report.renamed).toEqual([
        { kind: 'table', table: 'Order_Items', from: 'Order Items', to: 'Order_Items', reason: 'invalid-name' },
        { kind: 'table', table: 'silver_date', from: 'silver.date', to: 'silver_date', reason: 'same-name' },
        { kind: 'table', table: 'gold_date', from: 'gold.date', to: 'gold_date', reason: 'same-name' },
        { kind: 'table', table: 'users_2', from: 'users', to: 'users_2', reason: 'same-name' },
        { kind: 'table', table: 't_2024_sales', from: '2024_sales', to: 't_2024_sales', reason: 'invalid-name' },
        { kind: 'column', table: 'Order_Items', from: 'item id', to: 'item_id', reason: 'invalid-name' },
        { kind: 'column', table: 'Order_Items', from: 'unit-price', to: 'unit_price', reason: 'invalid-name' },
        { kind: 'column', table: 'Order_Items', from: 'Unit Price', to: 'Unit_Price_2', reason: 'invalid-name' },
        { kind: 'column', table: 't_2024_sales', from: 'order item', to: 'order_item', reason: 'invalid-name' },
      ]);
    });

    it('relationships use the new names; a one-to-one between two keys is stored from its first end', () => {
      expect(odd().relationships.map((r) => `${ends(r)}${r.role ? ` (${r.role})` : ''}`)).toEqual([
        't_2024_sales.order_item -> Order_Items.item_id many-to-one',
        't_2024_sales.id -> silver_date.date_key one-to-one (sale date)',
        'Users.id -> users_2.id many-to-many',
      ]);
    });
  });

  it('a one-to-one is stored from the end that is not its table\'s key, or the column that declared it', () => {
    const p = plan(fixture('foreign/sticky-groups.dbml'), { layer: 'silver' });
    expect(p.relationships.map(ends)).toEqual([
      'employees.manager_id -> employees.id many-to-one',
      'employees.badge_id -> badges.id one-to-one',
    ]);
    const reversed = plan('Table a {\n  id int [pk]\n}\nTable b {\n  id int [pk]\n  a_id int\n}\nRef: a.id - b.a_id\n');
    expect(reversed.relationships.map(ends)).toEqual(['b.a_id -> a.id one-to-one']);
    const inline = plan('Table a {\n  id int [pk]\n  b_id int [ref: - b.id]\n}\nTable b {\n  id int [pk]\n}\n');
    expect(inline.relationships.map(ends)).toEqual(['a.b_id -> b.id one-to-one']);
    const inlineManyToMany = plan('Table a {\n  id int [pk]\n}\nTable b {\n  id int [pk]\n  a_id int [ref: <> a.id]\n}\n');
    expect(inlineManyToMany.relationships.map(ends)).toEqual(['b.a_id -> a.id many-to-many']);
  });

  it('in ERD Studio\'s own export, a one-to-one is stored from its first end, whatever the keys say', () => {
    // Round-trip bug: one stored from a key to a column that is not one came
    // back turned round. The export writes every Ref from its FK end.
    const text = 'Table a {\n  id int [pk]\n}\nTable b {\n  id int [pk]\n  a_id int\n}\nRef: a.id -? b.a_id\n';
    expect(plan(`${DBML_RICH_EXPORT_HEADER}\n${text}`).relationships.map(ends)).toEqual(['a.id -> b.a_id one-to-one']);
    expect(plan(text).relationships.map(ends)).toEqual(['b.a_id -> a.id one-to-one']);
  });

  it('a one-to-many ref is stored from its many end', () => {
    const p = plan('Table a {\n  id int [pk]\n}\nTable b {\n  a_id int\n}\nRef: a.id < b.a_id\n');
    expect(p.relationships.map(ends)).toEqual(['b.a_id -> a.id many-to-one']);
  });

  it('groups other than the layer, and sticky notes without a layout or colour', () => {
    const p = plan(fixture('foreign/sticky-groups.dbml'), { layer: 'silver' });
    expect(p.report.dropped).toEqual([
      { what: 'Table group people (2 tables)', why: 'ERD Studio has no table groups; its tables were imported.' },
    ]);
    const notes = p.document.viewConfig.annotations!;
    expect(notes.map((n) => [n.id, n.x, n.y, n.color ?? null])).toEqual([
      ['dbml-sticky_1', 0, -200, 'yellow'],
      ['dbml-todo', 260, -200, null],
    ]);
    expect(notes[1].text).toContain('Multi-line note\nsecond line');
  });

  it('a sticky note\'s link to a missing table and its other properties are reported', () => {
    const p = plan('Table a {\n  id int\n}\nNote n [linked_table: \'nowhere\', owner: \'me\'] {\n  \'x\'\n}\n');
    expect(p.document.viewConfig.annotations![0]).not.toHaveProperty('linkedModel');
    expect(p.report.dropped).toEqual([
      { what: 'Sticky note n\'s link to nowhere', why: 'nowhere is not a table in the file.' },
      { what: 'Sticky note n: owner', why: 'ERD Studio sticky notes have no custom properties.' },
    ]);
  });

  it('ERD Studio\'s own export keeps a sticky note\'s link to a table not in the diagram, as the diagram had it', () => {
    // Round-trip bug: the link was dropped, so the note lost it for good.
    const p = plan(`${DBML_RICH_EXPORT_HEADER}\nTable a {\n  id int\n}\nNote sticky_1 [linked_table: 'not_here'] {\n  'x'\n}\n`);
    expect(p.document.viewConfig.annotations![0].linkedModel).toBe('not_here');
    expect(p.report.dropped).toEqual([]);
  });

  it('a sticky note links by schema-qualified or bare name, then without case', () => {
    const text = 'Table s.Alpha {\n  id int\n}\nNote a [linked_table: \'s.Alpha\'] {\n  \'1\'\n}\nNote b [linked_table: \'ALPHA\'] {\n  \'2\'\n}\n';
    expect(plan(text).document.viewConfig.annotations!.map((n) => n.linkedModel)).toEqual(['Alpha', 'Alpha']);
  });

  it('unknown custom properties are kept under meta.dbml.properties', () => {
    const p = plan('Table t [team: \'core\'] {\n  a int [pii: \'yes\']\n}\n');
    expect(p.newTables[0].meta).toEqual({ dbml: { properties: { team: 'core' } } });
    expect(p.newTables[0].columns![0].meta).toEqual({ dbml: { properties: { pii: 'yes' } } });
  });

  it('dependency arrows and diagram views are reported', () => {
    const m: DbmlModel = { ...model('Table a {\n  id int\n}\n'), dependencies: 2, diagramViews: 1 };
    const p = planDbmlImport({ model: m, layer: 'gold', subjectAreaName: 'x', library: library(), libraryRelationships: false });
    expect(p.report.dropped).toEqual([
      { what: '2 dependency arrows', why: 'ERD Studio draws relationships, not dependencies.' },
      { what: '1 diagram view', why: 'Each ERD Studio subject area is one view.' },
    ]);
  });

  it('a composite ref of more than eight pairs is imported as separate relationships', () => {
    const cols = Array.from({ length: 9 }, (_, i) => `c${i}`);
    const text = `Table a {\n${cols.map((c) => `  ${c} int`).join('\n')}\n}\nTable b {\n${cols.map((c) => `  ${c} int`).join('\n')}\n}\n`
      + `Ref: a.(${cols.join(', ')}) > b.(${cols.join(', ')})\n`;
    const p = plan(text);
    expect(p.relationships).toHaveLength(9);
    expect(p.relationships.every((r) => r.compositeKey === undefined)).toBe(true);
    expect(p.report.notes[0]).toMatch(/more than 8 column pairs/);
  });
});

// ---------------------------------------------------------------------------
// A real dbdiagram pull
// ---------------------------------------------------------------------------

describe('the dbdiagram pull fixture', () => {
  const pulled = (): DbmlImportPlan => plan(fixture('dbdiagram-pull/silver.dbml'), {
    layer: 'silver',
    layout: readDbdiagramLayout(fixture('dbdiagram-pull/silver.dbdiagram')),
  });

  it('places every table, a table without a schema matching schemaName "public"', () => {
    const p = pulled();
    expect(p.document.viewConfig.positions).toEqual({
      fct_task_event: { x: 1015.04296875, y: 278 },
      dim_task: { x: -202.669921875, y: 159 },
      dim_project: { x: -657, y: 340 },
      dim_customer: { x: -381, y: 659 },
      dim_date: { x: -310, y: -101 },
      fct_order: { x: 540.330078125, y: 557 },
    });
    expect(p.report).toMatchObject({ positioned: 6, unpositioned: 0, layoutProblems: [] });
  });

  it('reads its tables, fields and refs', () => {
    const p = pulled();
    expect(tableOf(p, 'dim_task')).toMatchObject({ schema: 'silver', modelRole: 'domain-dim', grain: 'One row per task version' });
    expect(tableOf(p, 'fct_order').schema).toBeUndefined();
    expect(columnOf(tableOf(p, 'dim_customer'), 'customer_name').scdType).toBe(2);
    expect(p.relationships).toHaveLength(7);
    expect(p.relationships.find((r) => r.fromColumn === 'parent_project_key')).toMatchObject({
      fromModel: 'dim_project', toModel: 'dim_project', toColumn: 'project_key', cardinality: 'many-to-one',
    });
    expect(p.report.dropped).toEqual([]);
    expect(analyseDbml(model(fixture('dbdiagram-pull/silver.dbml')), { layerIds: LAYERS })).toMatchObject({ suggestedName: 'showcase', suggestedLayer: 'silver' });
  });

  it('reports a layout\'s problems', () => {
    const layout = readDbdiagramLayout('{"version":"4.0.0","defaultView":{"tablePositions":[{"name":"dim_task","schemaName":"silver","x":1,"y":2},{"x":1}]}}');
    const p = plan(fixture('dbdiagram-pull/silver.dbml'), { layer: 'silver', layout });
    expect(p.report.positioned).toBe(1);
    expect(p.report.layoutProblems).toEqual(layout.problems);
    expect(p.report.layoutProblems.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The Table Library
// ---------------------------------------------------------------------------

describe('collisions with an existing Table Library', () => {
  const libraryCustomer = (): SemanticTable => ({
    name: 'DIM_CUSTOMER',
    description: 'From the library',
    columns: [
      { name: 'Customer_Key', dataType: 'bigint', description: '', isPrimaryKey: true },
      { name: 'customer_id', dataType: 'varchar', description: '' },
    ],
  });

  it('a name the library has in another case is reused in the library\'s spelling, never overwritten', () => {
    const lib = libraryCustomer();
    const before = structuredClone(lib);
    const p = salesPlan({ library: library([lib]) });
    expect(p.reusedTables).toEqual(['DIM_CUSTOMER']);
    expect(p.newTables.map((t) => t.name)).not.toContain('dim_customer');
    expect(p.modelNames).toContain('DIM_CUSTOMER');
    expect(p.document.viewConfig.positions).toHaveProperty('DIM_CUSTOMER', { x: 0, y: 0 });
    expect(p.report.reusedTables).toEqual([{ name: 'DIM_CUSTOMER', dbmlName: 'gold.dim_customer', missingColumns: ['segment', 'passport_key'] }]);
    expect(lib).toEqual(before);
  });

  it('relationships use the library\'s spelling; one to a column the library lacks is dropped', () => {
    const p = salesPlan({ library: library([libraryCustomer()]) });
    expect(p.relationships.map(ends)).toContain('fct_order.customer_key -> DIM_CUSTOMER.Customer_Key many-to-one');
    expect(p.relationships.map(ends)).toContain('bridge_tag.tag_id -> DIM_CUSTOMER.Customer_Key many-to-many');
    expect(p.relationships.some((r) => r.fromColumn === 'passport_key')).toBe(false);
    expect(p.report.dropped).toEqual([{
      what: 'Reference gold.dim_customer.passport_key – gold.dim_passport.passport_key',
      why: 'DIM_CUSTOMER is already in your Table Library and has no column passport_key; the library\'s table is used as it is.',
    }]);
  });

  it('a library table whose file cannot be read is still reused; its columns are taken on trust', () => {
    const p = salesPlan({ library: library([], ['dim_customer']) });
    expect(p.reusedTables).toEqual(['dim_customer']);
    expect(p.relationships.filter((r) => r.toModel === 'dim_customer' || r.fromModel === 'dim_customer')).toHaveLength(3);
    expect(p.report.reusedTables[0].missingColumns).toEqual([]);
  });

  it('a library grouped into layer folders is matched by name alone', () => {
    // TableLibraryService finds `gold/dim_date.yml` by its name; no folder ever reaches a name.
    const p = salesPlan({ library: library([{ name: 'dim_date', columns: [{ name: 'date_key', dataType: 'int', description: '' }] }]) });
    expect(p.reusedTables).toEqual(['dim_date']);
    expect([...p.modelNames, ...p.relationships.flatMap((r) => [r.fromModel, r.toModel])].every((n) => !n.includes('/'))).toBe(true);
  });

  it('two DBML tables matching one library table: the one renamed to stay unique is new', () => {
    const p = plan('Table Users {\n  id int\n}\nTable users {\n  id int\n}\n', { library: library([{ name: 'users', columns: [] }]) });
    expect(p.modelNames).toEqual(['users', 'users_2']);
    expect(p.reusedTables).toEqual(['users']);
    expect(p.newTables.map((t) => t.name)).toEqual(['users_2']);
  });
});

describe('where relationships are stored', () => {
  it('subject-area storage: every relationship in logical.relationships, no library table changed', () => {
    const p = salesPlan({ libraryRelationships: false });
    expect(p.document.logical.relationships).toHaveLength(7);
    expect(p.newTables.every((t) => t.relationships === undefined)).toBe(true);
    expect(p.changedLibraryTables).toEqual([]);
    expect(p.report.relationshipsInLibrary).toBe(0);
  });

  it('library storage: each new FK table carries its relationships, the subject area none', () => {
    const p = salesPlan({ libraryRelationships: true });
    expect(p.document.logical.relationships).toEqual([]);
    expect(tableOf(p, 'fct_order').relationships).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
      { fromColumn: 'ship_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', role: 'ship date' },
      { fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', role: 'order date' },
    ]);
    expect(tableOf(p, 'fct_shipment').relationships).toEqual([
      { fromColumn: 'order_id', toModel: 'fct_order', toColumn: 'order_id', cardinality: 'many-to-one', compositeKey: 'fk_fct_order' },
      { fromColumn: 'line_no', toModel: 'fct_order', toColumn: 'line_no', cardinality: 'many-to-one', compositeKey: 'fk_fct_order' },
    ]);
    expect(tableOf(p, 'dim_date').relationships).toBeUndefined();
    expect(p.changedLibraryTables).toEqual([]);
    expect(p.report).toMatchObject({ relationships: 7, relationshipsInLibrary: 7, relationshipsAlreadyInLibrary: 0 });
  });

  it('library storage: an existing FK table gains its relationships on a copy; a compositeKey it uses is not reused', () => {
    const shipment: SemanticTable = {
      name: 'fct_shipment',
      columns: [
        { name: 'order_id', dataType: 'int', description: '' },
        { name: 'line_no', dataType: 'int', description: '' },
        { name: 'other_a', dataType: 'int', description: '' },
        { name: 'other_b', dataType: 'int', description: '' },
      ],
      relationships: [
        { fromColumn: 'other_a', toModel: 'fct_order', toColumn: 'x', cardinality: 'many-to-one', compositeKey: 'fk_fct_order' },
        { fromColumn: 'other_b', toModel: 'fct_order', toColumn: 'y', cardinality: 'many-to-one', compositeKey: 'fk_fct_order' },
      ],
    };
    const before = structuredClone(shipment);
    const p = salesPlan({ libraryRelationships: true, library: library([shipment]) });
    expect(p.changedLibraryTables).toHaveLength(1);
    const changed = p.changedLibraryTables[0];
    expect(changed).not.toBe(shipment);
    expect(changed.relationships!.slice(2)).toEqual([
      { fromColumn: 'order_id', toModel: 'fct_order', toColumn: 'order_id', cardinality: 'many-to-one', compositeKey: 'fk_fct_order_2' },
      { fromColumn: 'line_no', toModel: 'fct_order', toColumn: 'line_no', cardinality: 'many-to-one', compositeKey: 'fk_fct_order_2' },
    ]);
    expect(shipment).toEqual(before);
  });

  it('library storage: a link the library already stores is left as it is', () => {
    const customer: SemanticTable = {
      name: 'dim_customer',
      columns: [{ name: 'customer_key', dataType: 'int', description: '', isPrimaryKey: true }, { name: 'passport_key', dataType: 'int', description: '' }],
      relationships: [{ fromColumn: 'passport_key', toModel: 'dim_passport', toColumn: 'passport_key', cardinality: 'many-to-one' }],
    };
    const p = salesPlan({ libraryRelationships: true, library: library([customer]) });
    expect(p.changedLibraryTables).toEqual([]);
    expect(p.report).toMatchObject({ relationships: 7, relationshipsAlreadyInLibrary: 1, relationshipsInLibrary: 6 });
    // bridge_tag <> dim_customer is stored on the new bridge_tag; dim_customer is untouched.
    expect(tableOf(p, 'bridge_tag').relationships).toHaveLength(1);
    expect(describeDbmlImportPlan(p)).toContain('1 is already in your Table Library and kept as it has them.');
  });

  it('library storage: a link another diagram draws from its own copy stays in this subject area', () => {
    const copy: Relationship = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = salesPlan({ libraryRelationships: true, diagramCopies: [copy] });
    expect(p.document.logical.relationships.map(ends)).toEqual(['fct_order.customer_key -> dim_customer.customer_key many-to-one']);
    expect(tableOf(p, 'fct_order').relationships).toHaveLength(2);
    expect(p.report.relationshipsInLibrary).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// The subject area file: v5 and v6 naming, and a real save
// ---------------------------------------------------------------------------

describe('serializeDbmlImportDocument', () => {
  it('writes the v5 keys', () => {
    const text = serializeDbmlImportDocument(salesPlan().document);
    const doc = JSON.parse(text);
    expect(text.endsWith('}\n')).toBe(true);
    expect(detectSubjectAreaFormat(doc)).toBe('v5');
    expect(doc).toMatchObject({ schemaVersion: 5, domain: 'imported', logical: { models: expect.any(Array) } });
    expect(doc.viewConfig.annotations[0].linkedModel).toBe('fct_order');
  });

  it('writes the v6 naming for a project that writes it', () => {
    const doc = JSON.parse(serializeDbmlImportDocument(salesPlan().document, true));
    expect(detectSubjectAreaFormat(doc)).toBe('v6');
    expect(doc).toMatchObject({ schemaVersion: 6, subjectArea: 'imported', logical: { tables: expect.any(Array) } });
    expect(doc).not.toHaveProperty('domain');
    expect(doc.logical.relationships[0]).toHaveProperty('fromTable', 'fct_order');
    expect(doc.viewConfig.annotations[0]).toHaveProperty('linkedTable', 'fct_order');
  });

  it('is a document core validates, in either naming', () => {
    for (const naming of [false, true]) {
      const doc = JSON.parse(serializeDbmlImportDocument(salesPlan().document, naming));
      expect(() => validateSubjectAreaDocument(doc, 'x.json')).not.toThrow();
    }
  });
});

describe('saving the planned tables with TableLibraryService', () => {
  let ws: string | undefined;
  afterEach(() => {
    if (ws) fs.rmSync(ws, { recursive: true, force: true });
    ws = undefined;
  });

  it.each([
    ['v5', 'logical-models', false],
    ['v6', 'tables', true],
  ] as const)('a %s library reads back every table as planned', (_naming, dir, v6) => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dbml-import-'));
    fs.mkdirSync(path.join(ws, '.erd-studio', dir), { recursive: true });
    if (v6) fs.writeFileSync(path.join(ws, '.erd-studio', dir, 'seed.yml'), 'name: seed\ncolumns: []\n');
    const service = new TableLibraryService(ws);
    expect(service.writesTableNaming()).toBe(v6);
    const lib: DbmlImportLibrary = {
      findTableName: (n) => service.findTableNameIgnoringCase(n),
      getTable: (n) => service.getTable(n),
    };
    for (const text of [fixture('erd-studio/sales.dbml'), fixture('foreign/ecommerce.dbml')]) {
      const p = plan(text, { library: lib, libraryRelationships: true, layout: salesLayout() });
      for (const table of p.newTables) service.saveTable(table);
      for (const table of p.newTables) {
        service.invalidateCache(table.name);
        expect(service.getTable(table.name)).toEqual(table);
      }
      const written = fs.readFileSync(service.tablePath('fct_order'), 'utf-8');
      expect(written).toContain(v6 ? 'tableRole: transaction-fact' : 'modelRole: transaction-fact');
    }
  });
});

// ---------------------------------------------------------------------------
// The dry-run summary
// ---------------------------------------------------------------------------

describe('describeDbmlImportPlan', () => {
  it('summarises an ERD Studio export', () => {
    expect(describeDbmlImportPlan(salesPlan(), { layerLabel: 'Gold', layoutFileName: 'sales.dbdiagram' })).toBe([
      'Import 7 tables into a new diagram "imported" in the Gold layer.',
      '• New: fct_order, dim_customer, dim_passport, dim_date and 3 more.',
      '• 7 relationships.',
      '• Layout: 6 of 7 tables placed from sales.dbdiagram; the rest are placed when it opens.',
      '• 2 sticky notes.',
    ].join('\n'));
  });

  it('says where relationships go and what is reused', () => {
    const text = describeDbmlImportPlan(salesPlan({ libraryRelationships: true, library: library([{ name: 'dim_date', columns: [] }]) }));
    expect(text).toContain('• Already in your Table Library, used as they are: dim_date. 1 of them has columns the file has and the library does not; those are not added.');
    expect(text).toContain('saved in the tables\' files');
  });

  it('summarises a foreign file: optional refs, meta, renames and what is left out', () => {
    const text = describeDbmlImportPlan(plan(fixture('foreign/ecommerce.dbml'), { layer: 'silver' }));
    expect(text).toContain('• 1 reference is optional (?). ERD Studio doesn\'t record that, so they are imported as plain relationships.');
    expect(text).toContain('• No layout file: the diagram is laid out automatically when it opens.');
    expect(text).toMatch(/• DBML settings ERD Studio has no field for \(not null, defaults, indexes, …\) are kept in the meta of \d+ tables and columns, under "dbml"\./);
    expect(text).toContain('Left out:\n• Reference "fk_merchant"');
    expect(text).toContain('• Records for countries (2 rows): ERD Studio does not keep sample data.');
    const odd = describeDbmlImportPlan(plan(fixture('foreign/odd-names.dbml'), { layer: 'silver' }));
    expect(odd).toContain('• Renamed to names ERD Studio can use: Order Items → Order_Items, silver.date → silver_date, gold.date → gold_date, users → users_2 and 5 more.');
  });

  it('says when a layout places nothing, and its problems', () => {
    const layout = readDbdiagramLayout('not json');
    const text = describeDbmlImportPlan(salesPlan({ layout }), { layoutFileName: 'sales.dbdiagram' });
    expect(text).toContain('• sales.dbdiagram has no positions for these tables: the diagram is laid out automatically when it opens.');
    expect(text).toContain(`• sales.dbdiagram: ${layout.problems[0]}`);
  });

  it('caps long lists', () => {
    const tables = Array.from({ length: 8 }, (_, i) => `Table t${i} {\n  id int\n}\nRecords t${i}(id) {\n  1\n}`).join('\n');
    const text = describeDbmlImportPlan(plan(tables));
    expect(text).toContain('• And 3 more things.');
    expect(text.split('\n').filter((l) => l.startsWith('• Records')).length).toBe(5);
  });
});
