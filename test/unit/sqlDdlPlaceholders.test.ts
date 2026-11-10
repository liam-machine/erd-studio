/**
 * Template placeholders (`sqlDdlPlaceholders.ts`): every syntax, in every
 * position a name can take, neutralised length-preservingly before the
 * converter (and the start screen's count) reads the text; strings and
 * comments never touched.
 */
import { describe, expect, it } from 'vitest';

import { neutralisePlaceholders } from '../../src/services/sqlDdlPlaceholders';
import { countCreateTablesWithColumns, type SqlDialect } from '../../src/services/sqlDdlImport';
import { sqlDdlToDbml } from '../../src/services/sqlImportEngine';

const SYNTAXES: ReadonlyArray<[label: string, written: (name: string) => string]> = [
  ['${x}', (n) => `\${${n}}`],
  ['${x:-default}', (n) => `\${${n}:-prod}`],
  ['{{ x }}', (n) => `{{ ${n} }}`],
  ["{{ var('x') }}", (n) => `{{ var('${n}') }}`],
  ['$(x)', (n) => `$(${n})`],
  ['@x@', (n) => `@${n}@`],
  ['<%= x %>', (n) => `<%= ${n} %>`],
  ['%(x)s', (n) => `%(${n})s`],
  ['&x.', (n) => `&${n}`], // followed by the qualifier dot below
];

/** What the neutralised text reads as, spaces collapsed. */
const reads = (text: string, dialect: SqlDialect = 'postgres'): string => neutralisePlaceholders(text, dialect).text.replace(/\s+/g, ' ').trim();

describe('neutralisePlaceholders', () => {
  it.each(SYNTAXES)('%s as a schema becomes its name, keeping the length and every line break', (_label, written) => {
    const text = `CREATE TABLE ${written('sales')}.orders (\n  id int\n);`;
    const pass = neutralisePlaceholders(text, 'postgres');
    expect(pass.text).toHaveLength(text.length);
    expect(pass.text.split('\n')).toHaveLength(text.split('\n').length);
    expect(reads(text)).toBe('CREATE TABLE sales.orders ( id int );');
    expect(pass.count).toBe(1);
    expect(pass.example?.line).toBe(1);
  });

  it.each(SYNTAXES.filter(([label]) => label !== '&x.'))('%s as the whole catalog is dropped with its dot', (_label, written) => {
    expect(reads(`CREATE TABLE ${written('catalog')}.${written('sales')}.orders (id int);`)).toBe('CREATE TABLE sales.orders (id int);');
    expect(reads(`ALTER TABLE ${written('cat')}.sales.orders ADD FOREIGN KEY (c) REFERENCES ${written('cat')}.${written('crm')}.customer (id);`))
      .toBe('ALTER TABLE sales.orders ADD FOREIGN KEY (c) REFERENCES crm.customer (id);');
  });

  it.each(SYNTAXES.filter(([label]) => label !== '&x.'))('%s as the table, or part of a name', (_label, written) => {
    expect(reads(`CREATE TABLE ${written('orders')} (id int);`)).toBe('CREATE TABLE orders (id int);');
    expect(reads(`CREATE TABLE stg_${written('env')}_orders (id int);`)).toBe('CREATE TABLE stg_env_orders (id int);');
  });

  it('SQL*Plus `&x.` keeps its dot as the qualifier; in `&&x..t` the first dot ends the variable (x.t)', () => {
    expect(reads('CREATE TABLE &schema.orders (id int);')).toBe('CREATE TABLE schema.orders (id int);');
    expect(reads('CREATE TABLE &&schema..orders (id int);')).toBe('CREATE TABLE schema.orders (id int);');
    // `a & b.c` (bitwise and) is not a placeholder.
    expect(reads('CHECK (flags & mask.bit > 0)')).toBe('CHECK (flags & mask.bit > 0)');
  });

  it('never touches strings, quoted names or comments', () => {
    const text = "-- ${commented}\nCREATE TABLE \"${quoted}\" (\n  a text DEFAULT '${kept}', /* {{ also }} */\n  b text COMMENT '@x@'\n) LOCATION '${path}';";
    expect(neutralisePlaceholders(text, 'databricks').text).toBe(text);
    expect(neutralisePlaceholders(text, 'databricks').count).toBe(0);
  });

  it('Jinja statements, comments and calls that are not names read as spaces; `{{ source() }}` and `{{ ref() }}` as their table', () => {
    expect(reads("{{ config(materialized='table') }}\n{% if true %}CREATE TABLE {{ source('raw', 'orders') }} (id int);{% endif %}{# note #}"))
      .toBe('CREATE TABLE orders (id int);');
    expect(reads("CREATE TABLE {{ ref('dim_customer') }} (id int);")).toBe('CREATE TABLE dim_customer (id int);');
    expect(reads('CREATE TABLE {{ target.schema }}.orders (id int);')).toBe('CREATE TABLE schema.orders (id int);');
  });

  it('a Jinja block over several lines keeps its line breaks where they were', () => {
    const text = 'CREATE TABLE a (id int);\n{% if x %}\n\n{% endif %}\nCREATE TABLE b (id int);';
    const out = neutralisePlaceholders(text, 'postgres').text;
    expect(out).toHaveLength(text.length);
    expect(out.split('\n').map((l) => l.trim())).toEqual(['CREATE TABLE a (id int);', '', '', '', 'CREATE TABLE b (id int);']);
  });

  it('SQL Server variables and MySQL user variables are not placeholders', () => {
    expect(reads('DECLARE @x int; SET @@session.sql_mode = 1;', 'sqlserver')).toBe('DECLARE @x int; SET @@session.sql_mode = 1;');
  });
});

describe('placeholders through the converter', () => {
  it.each(SYNTAXES)('%s: a templated schema imports whole, references and ALTER TABLE too, with the line numbers of the file', (_label, written) => {
    const q = (schema: string): string => `${written(schema)}.`;
    const text = [
      `CREATE TABLE ${q('sales')}customer (id int PRIMARY KEY);`,
      `CREATE TABLE ${q('sales')}orders (`,
      '  id int PRIMARY KEY,',
      `  customer_id int REFERENCES ${q('sales')}customer (id)`,
      ');',
      `ALTER TABLE ${q('sales')}orders ADD COLUMN total numeric(10,2);`,
    ].join('\n');
    const result = sqlDdlToDbml({ dialect: 'postgres', files: [{ name: 'a.sql', text }] });
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(result.tableCount).toBe(2);
    expect(result.refCount).toBe(1);
    expect(result.dbml).toContain('Table "sales"."orders"');
    expect(result.dbml).toMatch(/"total" numeric\(10,2\)/);
    // One repaired entry per file: how many statements held one, the first as an example, its line.
    expect(result.ledger).toContainEqual(expect.objectContaining({
      outcome: 'repaired', unit: 'statement', cause: 'templatePlaceholder', count: 3, where: expect.objectContaining({ file: 'a.sql', line: 1 }),
    }));
  });

  it('Databricks: ${catalog}.${schema}.table reads as schema.table in every file (the open retail data model)', () => {
    const table = 'CREATE TABLE IF NOT EXISTS ${catalog}.${store_schema}.store (\n  store_sk BIGINT NOT NULL COMMENT \'Key.\',\n  CONSTRAINT pk_store PRIMARY KEY (store_sk)\n) USING DELTA;';
    const fk = 'ALTER TABLE ${catalog}.${order_schema}.line\n  ADD CONSTRAINT fk FOREIGN KEY (store_sk) REFERENCES ${catalog}.${store_schema}.store (store_sk);';
    const line = 'CREATE TABLE ${catalog}.${order_schema}.line (line_sk BIGINT, store_sk BIGINT) USING DELTA;';
    const result = sqlDdlToDbml({ dialect: 'databricks', files: [{ name: 'store.sql', text: table }, { name: 'line.sql', text: line }, { name: 'fk.sql', text: fk }] });
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(result.tableCount).toBe(2);
    expect(result.refCount).toBe(1);
    expect(result.dbml).toContain('Table "store_schema"."store"');
  });

  it('the start screen counts templated CREATE TABLEs (they were invisible to it before)', () => {
    expect(countCreateTablesWithColumns('CREATE TABLE ${catalog}.${s}.a (id int);\nCREATE TABLE {{ schema }}.b (id int);')).toBe(2);
    // A dbt macro's `create table {{ relation }} as (…)` still is not one.
    expect(countCreateTablesWithColumns('create table {{ relation }} as (\n  select 1\n);')).toBe(0);
  });
});
