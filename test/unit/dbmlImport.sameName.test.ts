/**
 * #269: an import's table whose name the Table Library already has (from any
 * layer) is that library table only when it has the same columns, by name.
 * Otherwise the file's table is kept as its own, `{diagram}_{name}` with
 * `alias: {name}`, so the diagram shows what the file says and its
 * references come with it. `sameName: 'reuse'` keeps the old behaviour.
 */
import { describe, expect, it } from 'vitest';
import { readDbml } from '../../src/services/dbmlImportParse';
import {
  describeDbmlImportPlan,
  planDbmlImport,
  sameNameQuestion,
  summariseDbmlImportPlan,
  type DbmlImportLibrary,
  type DbmlImportSameName,
} from '../../src/services/dbmlImport';
import { buildImportReview } from '../../src/services/importReview';
import { draftFromImportPlan } from '../../src/services/draftModel';
import { convertSqlDdl } from '../../src/services/sqlDdlImport';
import { dbmlCoreSqlEngine } from '../../src/services/sqlImportEngine';
import type { SemanticTable } from '../../src/types/semantic';

const LAYERS: Record<string, { id: string; label: string }> = {
  reports: { id: 'reports', label: 'Reports' },
  warehouse: { id: 'warehouse', label: 'Warehouse' },
};

/** A library stub: each table in a layer (by its `schema`, as a DBML table's folder), aliases read from the tables. */
function libraryWith(tables: SemanticTable[], unreadable: string[] = []): DbmlImportLibrary {
  const find = (n: string) => tables.find((t) => t.name.toLowerCase() === n.toLowerCase()) ?? null;
  return {
    findTableName: (n) => find(n)?.name ?? unreadable.find((u) => u.toLowerCase() === n.toLowerCase()) ?? null,
    getTable: (n) => find(n),
    layerOf: (n) => { const t = find(n); return t?.schema ? LAYERS[t.schema] : undefined; },
    earlierCopiesOf: (name) => tables.filter((t) => [t.alias, (t.meta?.dbml as { name?: string } | undefined)?.name]
      .some((k) => k?.toLowerCase() === name.toLowerCase())).map((t) => t.name),
  };
}

const col = (name: string, dataType = 'int', isPrimaryKey = false) => ({ name, dataType, description: '', ...(isPrimaryKey ? { isPrimaryKey } : {}) });

/** Reports' customer, written by the first import of the issue's repro. */
const reportsCustomer = (): SemanticTable => ({ name: 'customer', schema: 'reports', columns: [col('customer_id', 'int', true), col('name', 'varchar')] });

const WAREHOUSE = [
  'Table customer {', '  customer_id int [pk]', '  name varchar', '  country_code varchar', '  segment varchar', '}',
  'Table country {', '  country_code varchar [pk]', '}',
  'Ref: customer.country_code > country.country_code', '',
].join('\n');

function plan(text: string, library: DbmlImportLibrary, sameName?: DbmlImportSameName, subjectAreaName = 'warehouse') {
  const read = readDbml(text);
  if (!read.ok) throw new Error('unreadable DBML');
  return planDbmlImport({
    model: read.model, layer: 'warehouse', subjectAreaName, library,
    libraryRelationships: true, diagramHoldsNoRelationships: true,
    ...(sameName ? { sameName } : {}),
  });
}

describe('#269 a table whose name the Table Library already has', () => {
  it('other columns (the issue\'s repro): kept as its own, {diagram}_{name} with the file\'s name as alias, every column and its reference', () => {
    const library = reportsCustomer();
    const before = structuredClone(library);
    const p = plan(WAREHOUSE, libraryWith([library]));
    expect(p.reusedTables).toEqual([]);
    expect(p.modelNames).toEqual(['warehouse_customer', 'country']);
    const own = p.newTables.find((t) => t.name === 'warehouse_customer')!;
    expect(own.alias).toBe('customer');
    expect(own.columns?.map((c) => c.name)).toEqual(['customer_id', 'name', 'country_code', 'segment']);
    expect(p.report.relationships).toBe(1);
    expect(own.relationships).toEqual([expect.objectContaining({ fromColumn: 'country_code', toModel: 'country', toColumn: 'country_code' })]);
    expect(p.report.dropped).toEqual([]);
    expect(p.changedLibraryTables).toEqual([]);
    expect(p.report.renamed).toEqual([{
      kind: 'table', table: 'warehouse_customer', from: 'customer', to: 'warehouse_customer', reason: 'in-library',
      inLibrary: { name: 'customer', layer: { id: 'reports', label: 'Reports' } },
    }]);
    // The library's table is never touched.
    expect(library).toEqual(before);
  });

  it('fewer columns than the library\'s (the other import order): kept as its own, so no other model\'s columns show', () => {
    const wide: SemanticTable = { name: 'customer', schema: 'warehouse', columns: [col('customer_id', 'int', true), col('name'), col('country_code'), col('segment')] };
    const p = plan('Table customer {\n  customer_id int [pk]\n  name varchar\n}\n', libraryWith([wide]), undefined, 'sales_report');
    expect(p.reusedTables).toEqual([]);
    expect(p.newTables.map((t) => [t.name, t.columns?.map((c) => c.name)])).toEqual([['sales_report_customer', ['customer_id', 'name']]]);
  });

  it('the same columns, by name in any case: the library\'s table, named with its layer; types, keys and notes are not compared', () => {
    const p = plan('Table Customer {\n  Customer_ID bigint\n  NAME text [not null, note: "x"]\n}\n', libraryWith([reportsCustomer()]));
    expect(p.reusedTables).toEqual(['customer']);
    expect(p.newTables).toEqual([]);
    expect(p.report.renamed).toEqual([]);
    expect(p.report.reusedTables).toEqual([{ name: 'customer', dbmlName: 'Customer', missingColumns: [], layer: { id: 'reports', label: 'Reports' } }]);
  });

  it('a schema in the file does not make it another table: sales.customer with other columns is kept as its own', () => {
    const p = plan('Table sales.customer {\n  customer_id int [pk]\n  extra int\n}\n', libraryWith([reportsCustomer()]));
    expect(p.reusedTables).toEqual([]);
    expect(p.newTables.map((t) => [t.name, t.schema, t.alias])).toEqual([['warehouse_customer', 'sales', 'customer']]);
  });

  it('an earlier import\'s own copy with the same columns is reused, never a third copy', () => {
    const earlier: SemanticTable = {
      name: 'warehouse_customer', alias: 'customer', schema: 'warehouse',
      columns: [col('customer_id', 'int', true), col('name'), col('country_code'), col('segment')],
    };
    const country: SemanticTable = { name: 'country', schema: 'warehouse', columns: [col('country_code', 'varchar', true)] };
    const p = plan(WAREHOUSE, libraryWith([reportsCustomer(), earlier, country]), undefined, 'warehouse_again');
    expect(p.reusedTables).toEqual(['warehouse_customer', 'country']);
    expect(p.newTables).toEqual([]);
    expect(p.report.renamed).toEqual([]);
    expect(p.report.dropped).toEqual([]);
  });

  it('the new name is free: one the library already has gets _2', () => {
    const taken: SemanticTable = { name: 'warehouse_customer', alias: 'someone_else', columns: [col('x')] };
    const p = plan(WAREHOUSE, libraryWith([reportsCustomer(), taken]));
    expect(p.modelNames[0]).toBe('warehouse_customer_2');
    expect(p.newTables[0].alias).toBe('customer');
  });

  it('a library table whose file cannot be read is used as it is, on trust, and a note says why', () => {
    const p = plan(WAREHOUSE, libraryWith([], ['customer']));
    expect(p.reusedTables).toEqual(['customer']);
    expect(p.report.notes).toContain('customer: your Table Library\'s customer could not be read to compare its columns, so it is used as it is.');
  });

  it('sameName: \'reuse\' keeps the library\'s table whatever its columns: the reference that needs a missing column is left out', () => {
    const p = plan(WAREHOUSE, libraryWith([reportsCustomer()]), 'reuse');
    expect(p.reusedTables).toEqual(['customer']);
    expect(p.report.reusedTables[0]).toMatchObject({ missingColumns: ['country_code', 'segment'], layer: { label: 'Reports' } });
    expect(p.report.relationships).toBe(0);
    expect(p.report.dropped.map((d) => d.kind)).toEqual(['reference']);
  });

  it('SQL DDL reaches the same rule: a script\'s customer with other columns is kept as its own', () => {
    const sql = 'CREATE TABLE customer (customer_id int PRIMARY KEY, name varchar(50), country_code varchar(2), segment varchar(10));\n'
      + 'CREATE TABLE country (country_code varchar(2) PRIMARY KEY);\n'
      + 'ALTER TABLE customer ADD CONSTRAINT fk FOREIGN KEY (country_code) REFERENCES country (country_code);\n';
    const converted = convertSqlDdl({ dialect: 'postgres', files: [{ name: 'wh.sql', text: sql }] }, dbmlCoreSqlEngine);
    const p = plan(converted.dbml!, libraryWith([reportsCustomer()]));
    expect(p.reusedTables).toEqual([]);
    expect(p.newTables.map((t) => t.name)).toContain('warehouse_customer');
    expect(p.report.relationships).toBe(1);
  });
});

describe('#269 the words', () => {
  const kept = () => plan(WAREHOUSE, libraryWith([reportsCustomer()]));

  it('the dry run and its summary say the table was kept as its own, beside which table in which layer, not "renamed to names ERD Studio can use"', () => {
    const text = describeDbmlImportPlan(kept());
    expect(text).toContain('• Kept as its own table, beside a same-named table in your project: customer → warehouse_customer: the project\'s customer (Reports layer) has other columns.');
    expect(text).not.toContain('Renamed to names ERD Studio can use');
    expect(summariseDbmlImportPlan(kept()).detail.join('\n')).toContain('1 table kept as its own beside a same-named table with other columns: customer → warehouse_customer');
  });

  it('a reused table is named with its layer', () => {
    const p = plan('Table customer {\n  customer_id int\n  name varchar\n}\n', libraryWith([reportsCustomer()]));
    expect(describeDbmlImportPlan(p)).toContain('• Already in your Table Library, used as they are: customer (Reports layer).');
    expect(summariseDbmlImportPlan(p).detail.join('\n')).toContain('1 table already in your Table Library (from the Reports layer), used as it is');
  });

  it('the review drawer has a "Kept as their own tables" section; Change options is offered only when it exists', () => {
    const sections = buildImportReview(kept(), { changeOptions: true }).sections;
    const section = sections.find((s) => s.id === 'kept-own');
    expect(section?.items.map((i) => i.text)).toEqual(['customer → warehouse_customer: the project\'s customer (Reports layer) has other columns']);
    expect(section?.hint).toContain('To use the project\'s instead, choose Change options… and answer its question.');
    expect(buildImportReview(kept()).sections.find((s) => s.id === 'kept-own')?.hint).not.toContain('Change options');
    expect(sections.some((s) => s.id === 'renamed')).toBe(false);
  });

  it('the step-by-step question names the layer, the new name, and what using the project\'s table would leave out', () => {
    const library = libraryWith([reportsCustomer()]);
    const q = sameNameQuestion(plan(WAREHOUSE, library), plan(WAREHOUSE, library, 'reuse'));
    expect(q).toEqual({
      placeHolder: 'customer is already in your project (Reports layer) with other columns. Import the file\'s table as its own, or use the project\'s?',
      separate: {
        label: 'Keep it as its own table',
        detail: 'Imported as warehouse_customer, so the diagram shows what the file says. The project\'s table is not changed.',
      },
      reuse: { label: 'Use the project\'s table as it is', detail: '2 columns and 1 relationship from the file are not imported.' },
    });
  });

  it('no question when nothing was kept as its own', () => {
    const library = libraryWith([reportsCustomer()]);
    const same = 'Table customer {\n  customer_id int\n  name varchar\n}\n';
    expect(sameNameQuestion(plan(same, library), plan(same, library, 'reuse'))).toBeNull();
  });
});

describe('#269 the break audit\'s cases', () => {
  const warehouseCopy = (): SemanticTable => ({
    name: 'warehouse_customer', alias: 'customer', schema: 'warehouse',
    columns: [col('customer_id', 'int', true), col('name'), col('country_code'), col('segment')],
  });

  it('"use the project\'s table" still takes an earlier copy with the same columns, which loses nothing', () => {
    const p = plan(WAREHOUSE, libraryWith([reportsCustomer(), warehouseCopy()]), 'reuse', 'warehouse_again');
    expect(p.reusedTables).toContain('warehouse_customer');
    expect(p.report.relationships).toBe(1);
    expect(p.report.dropped).toEqual([]);
  });

  it('a file table with an alias of its own finds its earlier copy by the original name kept in meta.dbml.name', () => {
    const aliased = WAREHOUSE.replace('Table customer {', 'Table customer [erd_alias: \'cust\'] {');
    const copy: SemanticTable = { ...warehouseCopy(), alias: 'cust', meta: { dbml: { name: 'customer' } } };
    const p = plan(aliased, libraryWith([reportsCustomer(), copy]), undefined, 'warehouse_again');
    expect(p.reusedTables).toContain('warehouse_customer');
    expect(p.newTables.map((t) => t.name)).not.toContain('warehouse_again_customer');
  });

  it('a first import of such a table keeps its own alias and records the original name, so a re-import can find it', () => {
    const aliased = WAREHOUSE.replace('Table customer {', 'Table customer [erd_alias: \'cust\'] {');
    const p = plan(aliased, libraryWith([reportsCustomer()]));
    const own = p.newTables.find((t) => t.name === 'warehouse_customer')!;
    expect(own.alias).toBe('cust');
    expect(own.meta).toMatchObject({ dbml: { name: 'customer' } });
  });

  it('two file tables never share one earlier copy: the second is its own', () => {
    const text = `${WAREHOUSE}Table warehouse_customer {\n  customer_id int [pk]\n  name varchar\n  country_code varchar\n  segment varchar\n}\n`;
    const p = plan(text, libraryWith([reportsCustomer(), warehouseCopy()]));
    expect(new Set(p.modelNames).size).toBe(p.modelNames.length);
  });

  it('columns are compared under the import\'s own renames: Amount and amount (amount_2) match their earlier import', () => {
    const text = 'Table fact {\n  Amount int\n  amount int\n}\n';
    const stored: SemanticTable = { name: 'fact', columns: [col('Amount'), col('amount_2')] };
    expect(plan(text, libraryWith([stored])).reusedTables).toEqual(['fact']);
  });

  it('the question says what using a wider project table would add to the diagram', () => {
    const wide: SemanticTable = { name: 'customer', schema: 'reports', columns: [col('customer_id', 'int', true), col('name'), col('email'), col('phone')] };
    const library = libraryWith([wide]);
    const text = 'Table customer {\n  customer_id int [pk]\n  name varchar\n}\n';
    expect(sameNameQuestion(plan(text, library), plan(text, library, 'reuse'))?.reuse.detail)
      .toBe('The diagram shows 2 columns the file does not have.');
  });

  it('a reused table that gains a relationship names its layer in the drawer', () => {
    const sale: SemanticTable = { name: 'sale', schema: 'reports', columns: [col('sale_id', 'int', true), col('customer_id')] };
    const text = `${WAREHOUSE}Table sale {\n  sale_id int [pk]\n  customer_id int\n}\nRef: sale.customer_id > customer.customer_id\n`;
    const p = plan(text, libraryWith([reportsCustomer(), sale]));
    expect(p.changedLibraryTables.map((t) => t.name)).toEqual(['sale']);
    const library = buildImportReview(p).sections.find((s) => s.id === 'library')!;
    expect(library.items.find((i) => i.tag === 'gains relationships')?.text).toBe('Its table file, in the Reports layer, gets the new relationships.');
  });
});

describe('#269 the draft', () => {
  const input = (changeOptions: boolean) => ({
    plan: plan(WAREHOUSE, libraryWith([reportsCustomer()])),
    importSource: 'file' as const,
    trigger: 'palette' as const,
    target: { layer: 'warehouse', layerLabel: 'Warehouse', name: 'warehouse', diagramFile: '.erd-studio/warehouse/diagrams/warehouse.dbml' },
    fileName: 'warehouse.dbml',
    describe: { layerLabel: 'Warehouse' },
    libraryTable: () => undefined,
    layers: [],
    logicalOnly: true,
    hasFolder: true,
    changeOptions,
  });

  it('the banner says a table was kept as its own; the drawer points at Change options… only when the banner has it', () => {
    const shown = draftFromImportPlan(input(true));
    expect(shown.banner.detail).toContain('1 table has the name of one in your project but other columns, so it is kept as its own.');
    expect(shown.details.find((d) => d.id === 'kept-own')?.hint).toContain('choose Change options…');
    expect(draftFromImportPlan(input(false)).details.find((d) => d.id === 'kept-own')?.hint).not.toContain('Change options');
  });
});
