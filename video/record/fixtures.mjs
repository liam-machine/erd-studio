// The folders the default cut is recorded in, written fresh before each take (record.mjs):
//
//   <root>/shop-analytics        the plain take: a project folder with no dbt_project.yml and no
//                                .erd-studio yet, holding the code that loads the shop's warehouse
//                                and sales.sql, the CREATE TABLE script Snowflake's GET_DDL exported
//                                for its SALES schema (four tables, three foreign keys). The tour
//                                imports it (Import… → SQL DDL scripts), edits the diagram by hand
//                                and with Claude Code, and its files are what the dbt take starts from.
//   <root>/dbt/shop-analytics    the dbt take: the same shop as a dbt project, whose .erd-studio is
//                                what the plain take wrote (copied from it when it ran, else
//                                DBT_ERD below, a copy of one such take). Its models differ from the
//                                design on purpose (dim_promotion is only in the design; fct_order
//                                has an order_status column the design lacks and amount is
//                                NUMBER(18,2)) so Compare with dbt has something to mark. It has no
//                                target/ yet: the tour clicks Run dbt parse, which runs real dbt
//                                Core (dbt-core with dbt-duckdb through uvx, record/vscode.mjs bin/dbt) against a
//                                profiles.yml in the project that never connects anywhere.
//
//   node record/fixtures.mjs [root]      (default /tmp/erd-tour)
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBT_ERD } from './fixtures.erd.mjs';
import { warmDbt } from './vscode.mjs';

/** Short and free of any home path: the file dialog and Claude Code's banner show it on screen. */
export const ROOT = '/tmp/erd-tour';
export const plainFolder = (root = ROOT) => join(root, 'shop-analytics');
export const dbtFolder = (root = ROOT) => join(root, 'dbt', 'shop-analytics');

const write = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
};

/**
 * What Snowflake's `SELECT GET_DDL('SCHEMA', 'SHOP.SALES');` returns for the shop's sales schema
 * (the export the import guide's Snowflake card names), saved as sales.sql. Lower-case names, so
 * the diagram reads as the dbt models later do; the foreign keys are Snowflake's declared
 * (unenforced) constraints, which the import turns into relationships.
 */
export const SALES_SQL = `create or replace TABLE dim_store (
	store_id NUMBER(38,0) NOT NULL,
	store_name VARCHAR(100),
	city VARCHAR(60),
	region VARCHAR(30),
	primary key (store_id)
);

create or replace TABLE dim_product (
	product_id NUMBER(38,0) NOT NULL,
	product_name VARCHAR(200),
	category VARCHAR(60),
	unit_price NUMBER(10,2),
	primary key (product_id)
);

create or replace TABLE dim_date (
	date_key NUMBER(38,0) NOT NULL,
	calendar_date DATE,
	month_name VARCHAR(10),
	fiscal_year NUMBER(4,0),
	primary key (date_key)
);

create or replace TABLE fct_order (
	order_id NUMBER(38,0) NOT NULL,
	date_key NUMBER(38,0),
	store_id NUMBER(38,0),
	product_id NUMBER(38,0),
	quantity NUMBER(10,0),
	amount NUMBER(12,2),
	primary key (order_id),
	foreign key (date_key) references dim_date(date_key),
	foreign key (store_id) references dim_store(store_id),
	foreign key (product_id) references dim_product(product_id)
);
`;

/** The plain take's folder: the code that loads the warehouse, and the exported DDL. */
const PLAIN = {
  'README.md': '# shop-analytics\n\nLoads the shop\'s orders into Snowflake.\n',
  '.gitignore': 'node_modules/\n.venv/\n',
  'pipelines/load_orders.py': 'def load_orders(conn):\n    conn.execute("copy into fct_order from @orders_stage")\n',
  'sales.sql': SALES_SQL,
};

/**
 * The dbt take's .erd-studio when there is no plain take to copy it from (`--take dbt` on its own):
 * a copy of what one plain take wrote, the imported sales diagram with the table added by hand
 * (dim_promotion) and the one Claude Code added (dim_customer). Regenerate it after a plain take
 * with `node record/fixtures.mjs --capture`.
 */
export { DBT_ERD };

/**
 * dim_customer's model in the dbt project: the columns the design's dim_customer.dbml has (Claude
 * Code chooses them in the plain take, so they are read from its file), or a customer_id, name and
 * email when there is none. The comparison's differences are the ones planted on purpose, not these.
 */
export function dimCustomerYml(dbml) {
  const cols = dbml ? [...dbml.matchAll(/^ {2}(\w+) +"?([A-Za-z_]+(?:\(\d+(?:,\d+)?\))?)"?/gm)].filter(([, n]) => n !== 'Note').map(([, n, t]) => [n, t])
    : [['customer_id', 'NUMBER(38,0)'], ['customer_name', 'VARCHAR(200)'], ['email', 'VARCHAR(200)']];
  const lines = cols.map(([n, t], i) => `      - name: ${n}\n        data_type: ${t}${i === 0 ? '\n        data_tests: [unique, not_null]' : ''}`);
  return `  - name: dim_customer\n    columns:\n${lines.join('\n')}\n`;
}

const DBT = {
  'README.md': '# shop-analytics\n\nThe shop\'s warehouse models, built with dbt.\n',
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
  // dbt parse reads a profile but never connects: an in-memory DuckDB, inside the project
  'profiles.yml': 'shop_analytics:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: ":memory:"\n',
  'models/marts/_sources.yml': `version: 2

sources:
  - name: shop
    tables:
      - name: stores
      - name: products
      - name: calendar
      - name: orders
      - name: customers
`,
  'models/marts/dim_store.sql': "select * from {{ source('shop', 'stores') }}\n",
  'models/marts/dim_product.sql': "select * from {{ source('shop', 'products') }}\n",
  'models/marts/dim_date.sql': "select * from {{ source('shop', 'calendar') }}\n",
  'models/marts/dim_customer.sql': "select * from {{ source('shop', 'customers') }}\n",
  'models/marts/fct_order.sql': "select * from {{ source('shop', 'orders') }}\n",
  'models/marts/_marts.yml': `version: 2

models:
  - name: dim_store
    columns:
      - name: store_id
        data_type: NUMBER(38,0)
        data_tests: [unique, not_null]
      - name: store_name
        data_type: VARCHAR(100)
      - name: city
        data_type: VARCHAR(60)
      - name: region
        data_type: VARCHAR(30)

  - name: dim_product
    columns:
      - name: product_id
        data_type: NUMBER(38,0)
        data_tests: [unique, not_null]
      - name: product_name
        data_type: VARCHAR(200)
      - name: category
        data_type: VARCHAR(60)
      - name: unit_price
        data_type: NUMBER(10,2)

  - name: dim_date
    columns:
      - name: date_key
        data_type: NUMBER(38,0)
        data_tests: [unique, not_null]
      - name: calendar_date
        data_type: DATE
      - name: month_name
        data_type: VARCHAR(10)
      - name: fiscal_year
        data_type: NUMBER(4,0)

__DIM_CUSTOMER__
  - name: fct_order
    columns:
      - name: order_id
        data_type: NUMBER(38,0)
        data_tests: [unique, not_null]
      - name: date_key
        data_type: NUMBER(38,0)
        data_tests:
          - relationships:
              arguments:
                to: ref('dim_date')
                field: date_key
      - name: store_id
        data_type: NUMBER(38,0)
        data_tests:
          - relationships:
              arguments:
                to: ref('dim_store')
                field: store_id
      - name: product_id
        data_type: NUMBER(38,0)
        data_tests:
          - relationships:
              arguments:
                to: ref('dim_product')
                field: product_id
      - name: customer_id
        data_type: NUMBER(38,0)
        data_tests:
          - relationships:
              arguments:
                to: ref('dim_customer')
                field: customer_id
      - name: quantity
        data_type: NUMBER(10,0)
      - name: amount
        data_type: NUMBER(18,2)
      - name: order_status
        data_type: VARCHAR(20)
`,
};

/** Every file under `dir` (relative path → text). */
function readTree(dir, base = dir, out = {}) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) readTree(full, base, out);
    else out[relative(base, full)] = readFileSync(full, 'utf8');
  }
  return out;
}

/** Writes the plain take's folder under `root` (replacing it). */
export function makePlain(root = ROOT) {
  rmSync(plainFolder(root), { recursive: true, force: true });
  write(plainFolder(root), PLAIN);
  return plainFolder(root);
}

/**
 * Writes the dbt take's folder under `root` (replacing it): the project, and the plain take's
 * .erd-studio when that folder holds one (the take just filmed), else DBT_ERD. Warms uvx's cache for
 * bin/dbt, so Run dbt parse on camera does not wait for a download.
 */
export function makeDbt(root = ROOT) {
  rmSync(join(root, 'dbt'), { recursive: true, force: true });
  write(dbtFolder(root), DBT);
  const fromPlain = join(plainFolder(root), '.erd-studio');
  const erd = join(dbtFolder(root), '.erd-studio');
  if (existsSync(fromPlain)) cpSync(fromPlain, erd, { recursive: true });
  else write(erd, DBT_ERD);
  const dc = join(erd, 'main', 'tables', 'main', 'dim_customer.dbml');
  const marts = join(dbtFolder(root), 'models', 'marts', '_marts.yml');
  writeFileSync(marts, readFileSync(marts, 'utf8').replace('__DIM_CUSTOMER__\n', dimCustomerYml(existsSync(dc) ? readFileSync(dc, 'utf8') : null)));
  warmDbt();
  return dbtFolder(root);
}

/** Both folders, fresh (the dbt one from DBT_ERD: the plain folder has no .erd-studio yet). */
export function makeFixtures(root = ROOT) {
  makePlain(root);
  const dbt = makeDbt(root);
  return { plain: plainFolder(root), dbt };
}

/** Writes record/fixtures.erd.mjs from the plain take's .erd-studio (after a plain take). */
export function capture(root = ROOT) {
  const tree = readTree(join(plainFolder(root), '.erd-studio'));
  const file = join(dirname(fileURLToPath(import.meta.url)), 'fixtures.erd.mjs');
  writeFileSync(file, `// GENERATED by \`node record/fixtures.mjs --capture\` from a plain take's .erd-studio (see fixtures.mjs DBT_ERD).\nexport const DBT_ERD = ${JSON.stringify(tree, null, 1)};\n`);
  return file;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--capture')) console.log(capture());
  else console.log(makeFixtures(process.argv[2] ?? ROOT));
}
