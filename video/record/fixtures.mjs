// The folders the default cut is recorded in, written fresh before every take (record.mjs):
//
//   <root>/shop-analytics        a plain folder: no dbt_project.yml and no .erd-studio yet. The tour
//                                draws its diagram here with New Diagram…, New Table and New
//                                Relationship; sales.dbml is dropped in just before the import
//                                scene, so the folder first opens with nothing to import.
//   <root>/dbt/shop-analytics    the same model in a dbt project (the dbt beat). Its .erd-studio is
//                                what the plain folder's take writes for orders, and its schema yml
//                                differs on purpose (no event_date, amount NUMBER(12,2), an extra
//                                order_status) so Compare with dbt has something to mark.
//                                target/manifest.json comes from a real `dbt parse` (dbt-duckdb via
//                                uvx), so the canvas has no "dbt hasn't parsed this project" strip.
//
//   node record/fixtures.mjs [root]      (default /tmp/erd-tour)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Short and free of any home path: the Import DBML file picker shows it on screen. */
export const ROOT = '/tmp/erd-tour';
export const plainFolder = (root = ROOT) => join(root, 'shop-analytics');
export const dbtFolder = (root = ROOT) => join(root, 'dbt', 'shop-analytics');

const write = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
};

const PLAIN = {
  'README.md': '# shop-analytics\n\nOrders and customers for the shop.\n',
  '.gitignore': 'node_modules/\n',
  'docs/notes.md': '# Notes\n',
  'src/orders.sql': 'select * from orders\n',
};

/**
 * The DBML file the import scene picks: five tables, four relationships, none already in the library.
 * Its refs are optional (>?), as ERD Studio saves every relationship, so the draft carries no note
 * ("Every relationship is saved as optional…") to distract from Keep as Diagram.
 */
export const SALES_DBML = `Table dim_store {
  store_id int [pk]
  store_name varchar
  region varchar
}

Table dim_staff {
  staff_id int [pk]
  staff_name varchar
}

Table dim_calendar {
  date_day date [pk]
  month_name varchar
}

Table fct_sale {
  sale_id int [pk]
  store_id int [ref: >? dim_store.store_id]
  staff_id int [ref: >? dim_staff.staff_id]
  sale_date date [ref: >? dim_calendar.date_day]
  amount decimal(12,2)
}

Table fct_refund {
  refund_id int [pk]
  sale_id int [ref: >? fct_sale.sale_id]
  refunded decimal(12,2)
}
`;

/**
 * What ERD Studio writes for the orders diagram in the plain folder's take (New Diagram… "orders",
 * New Table dim_date from Dimension and fct_order from Fact, New Relationship), byte for byte,
 * except the diagram's erd_layout, which lays the two tables out for the dbt beat's canvas: fct_order
 * (the table with differences) on the left, dim_date a little higher on the right, so the comparison
 * panel (bottom right) opens beside fct_order rather than over it, and fct_order's compare rows
 * (Only in Physical) still fit below it.
 */
const ERD = {
  '.erd-studio/README.md': `# .erd-studio

This folder is an ERD Studio data model, stored as DBML, an open format (https://dbml.dbdiagram.io).
Edit it in VS Code with ERD Studio, or with any text editor or AI assistant.

Every file lives under a layer folder. This project's layers, in order (layers.json lists them):

    1. Main   main/

In each layer folder:

    <layer>/tables/<schema>/<table>.dbml   one table: Table <schema>.<table> { … }
    <layer>/relationships/<file>.dbml      Refs between tables, split across files however you like
    <layer>/diagrams/<diagram>.dbml        one diagram: the tables it shows (use lines), the
                                           relationships files it needs, its sticky notes, and
                                           the table positions (erd_layout in its Project)

- A table's name is unique across the whole project. Tables that share a warehouse name get
  unique names (silver_customer, gold_customer), with the warehouse name in their alias.
- Each relationship is one Ref, stored once, in any relationships file.
- Other DBML tools read a diagram as a normal DBML project: open <layer>/diagrams/<name>.dbml.

Check the files with \`erd-studio doctor\`.
`,
  '.erd-studio/layers.json': `{
  "schemaVersion": 1,
  "layers": [
    {
      "id": "main",
      "label": "Main",
      "abbreviation": "MAIN",
      "color": "#6366f1",
      "creatable": true,
      "order": 1
    }
  ]
}
`,
  '.erd-studio/main/tables/main/dim_date.dbml': `Table main.dim_date [role: 'domain-dim'] {
  date_key        INTEGER       [
    pk,
    scd_type: '0',
    note: 'Surrogate key — warehouse-generated, one per row'
  ]
  date_id         VARCHAR       [
    natural_key: 'true',
    scd_type: '0',
    note: 'Business key from the source system'
  ]
  name            VARCHAR       [scd_type: '1', note: 'Display name']
  description     VARCHAR       [scd_type: '1', note: 'Long description']
  is_active       BOOLEAN       [scd_type: '1', note: 'Active flag']
  dwh_inserted_at TIMESTAMP_NTZ [note: 'Warehouse insert timestamp']
  dwh_updated_at  TIMESTAMP_NTZ [note: 'Warehouse update timestamp']
}
`,
  '.erd-studio/main/tables/main/fct_order.dbml': `Table main.fct_order [role: 'transaction-fact'] {
  order_id        INTEGER         [
    pk,
    natural_key: 'true',
    note: 'Transaction id from the source system (degenerate dimension)'
  ]
  date_key        INTEGER         [foreign_key: 'true', note: 'FK to dim_date']
  event_date      DATE            [note: 'Business event date']
  amount          "DECIMAL(18,2)" [additive_type: 'additive', note: 'Monetary amount']
  dwh_inserted_at TIMESTAMP_NTZ   [note: 'Warehouse insert timestamp']
  dwh_updated_at  TIMESTAMP_NTZ   [note: 'Warehouse update timestamp']
}
`,
  '.erd-studio/main/relationships/main.dbml': `// ERD Studio relationships: Refs only, split across relationships/ files however you like. Every table a Ref names has a use line here.
use { table main.dim_date }  from '../tables/main/dim_date.dbml'
use { table main.fct_order } from '../tables/main/fct_order.dbml'

Ref: main.fct_order.date_key >? main.dim_date.date_key
`,
  '.erd-studio/main/diagrams/orders.dbml': `use { table main.dim_date }  from '../tables/main/dim_date.dbml'
use { table main.fct_order } from '../tables/main/fct_order.dbml'
use * from '../relationships/main.dbml'

Project orders {
  erd_schema_version: '7'
  erd_layout: '''
    dim_date 560 0
    fct_order 100 40
  '''
}
`,
};

const DBT = {
  'README.md': PLAIN['README.md'],
  '.gitignore': 'target/\nlogs/\n',
  'dbt_project.yml': `name: shop_analytics
version: '1.0.0'
profile: shop_analytics
model-paths: ["models"]
models:
  shop_analytics:
    marts:
      +materialized: table
`,
  'models/marts/_sources.yml': `version: 2

sources:
  - name: shop
    tables:
      - name: calendar
      - name: orders
`,
  'models/marts/dim_date.sql': "select * from {{ source('shop', 'calendar') }}\n",
  'models/marts/fct_order.sql': "select * from {{ source('shop', 'orders') }}\n",
  'models/marts/_marts.yml': `version: 2

models:
  - name: dim_date
    columns:
      - name: date_key
        data_type: INTEGER
        data_tests: [unique, not_null]
      - name: date_id
        data_type: VARCHAR
      - name: name
        data_type: VARCHAR
      - name: description
        data_type: VARCHAR
      - name: is_active
        data_type: BOOLEAN
      - name: dwh_inserted_at
        data_type: TIMESTAMP_NTZ
      - name: dwh_updated_at
        data_type: TIMESTAMP_NTZ

  - name: fct_order
    columns:
      - name: order_id
        data_type: INTEGER
        data_tests: [unique, not_null]
      - name: date_key
        data_type: INTEGER
        data_tests:
          - relationships:
              arguments:
                to: ref('dim_date')
                field: date_key
      - name: amount
        data_type: NUMBER(12,2)
      - name: order_status
        data_type: VARCHAR
      - name: dwh_inserted_at
        data_type: TIMESTAMP_NTZ
      - name: dwh_updated_at
        data_type: TIMESTAMP_NTZ
`,
  ...ERD,
};

/** Writes both folders under `root` (replacing them) and runs `dbt parse` in the dbt one. */
export function makeFixtures(root = ROOT) {
  rmSync(plainFolder(root), { recursive: true, force: true });
  rmSync(join(root, 'dbt'), { recursive: true, force: true });
  write(plainFolder(root), PLAIN);
  write(dbtFolder(root), DBT);
  // A throwaway DuckDB profile outside the project: dbt parse reads it but never connects.
  const profiles = mkdtempSync(join(tmpdir(), 'erd-tour-profiles-'));
  writeFileSync(join(profiles, 'profiles.yml'), 'shop_analytics:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: ":memory:"\n');
  try {
    execFileSync('uvx', ['--quiet', '--from', 'dbt-duckdb==1.9.4', 'dbt', 'parse', '--quiet', '--profiles-dir', profiles], { cwd: dbtFolder(root), stdio: 'inherit' });
  } finally {
    rmSync(profiles, { recursive: true, force: true });
  }
  for (const f of ['logs', '.user.yml']) rmSync(join(dbtFolder(root), f), { recursive: true, force: true });
  return { plain: plainFolder(root), dbt: dbtFolder(root) };
}

/** The import scene's file, dropped into the plain folder just before that scene. */
export function addSalesDbml(root = ROOT) {
  writeFileSync(join(plainFolder(root), 'sales.dbml'), SALES_DBML);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(makeFixtures(process.argv[2] ?? ROOT));
