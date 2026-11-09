// The folders the default cut is recorded in, written fresh before each take (record.mjs):
//
//   <root>/shop-analytics        the plain take: a project folder with no dbt_project.yml and no
//                                .erd-studio yet, holding the code that loads the shop's warehouse.
//                                Its warehouse is a real PostgreSQL database, `shop` (SHOP_SQL: a
//                                `sales` schema of four tables and three foreign keys), made fresh in
//                                the local server (psql, Homebrew's PostgreSQL at /tmp:5432). The tour
//                                exports it with pg_dump in the integrated terminal (sales.sql, the
//                                whole database's DDL in one step), imports that (Import SQL DDL…, its
//                                draft, Keep as Diagram), edits the diagram by hand and with Claude
//                                Code, and its files are what the dbt take starts from.
//   <root>/dbt/shop-analytics    the dbt take: the same shop as a dbt project, whose .erd-studio is
//                                what the plain take wrote (copied from it when it ran, else
//                                DBT_ERD below, a copy of one such take). Its models differ from the
//                                design on purpose (dim_promotion is only in the design; fct_order
//                                has an order_status column the design lacks and amount is
//                                numeric(18,2)) so Compare with dbt has something to mark. It has no
//                                target/ yet: the tour clicks Run dbt parse, which runs real dbt
//                                Core (dbt-core with dbt-duckdb through uvx, record/vscode.mjs bin/dbt) against a
//                                profiles.yml in the project that never connects anywhere.
//   <root>/big/<name>            the scale take: a 2,000-table project (record/bigProject.mjs).
//
//   node record/fixtures.mjs [root]      (default /tmp/erd-tour)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBT_ERD } from './fixtures.erd.mjs';
import { warmDbt, which } from './vscode.mjs';

/** Short and free of any home path: the file dialog and Claude Code's banner show it on screen. */
export const ROOT = '/tmp/erd-tour';
export const plainFolder = (root = ROOT) => join(root, 'shop-analytics');
export const dbtFolder = (root = ROOT) => join(root, 'dbt', 'shop-analytics');
/** The scale take's folder: its name shows in the window's title bar and the side bar. */
export const bigFolder = (root = ROOT) => join(root, 'big', 'retail-warehouse');

const write = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
};

/** The local PostgreSQL the export scene dumps (Homebrew's, on its default socket; PGHOST overrides). */
export const PG = { host: process.env.PGHOST ?? '/tmp', db: 'shop' };

/**
 * The shop's warehouse: a `sales` schema in a real PostgreSQL database, with ordinary types
 * (integer, varchar, numeric, date) and declared keys; no NOT NULL but the keys' (the import would
 * carry it as a meta_json setting on each column). The export scene's `pg_dump --schema-only`
 * writes it back, unedited, as sales.sql, the file the tour imports (its header and `ALTER TABLE
 * ONLY` tell the import the dialect: PostgreSQL).
 */
export const SHOP_SQL = `CREATE SCHEMA sales;

CREATE TABLE sales.dim_store (
    store_id   integer PRIMARY KEY,
    store_name varchar(100),
    city       varchar(60),
    region     varchar(30)
);

CREATE TABLE sales.dim_product (
    product_id   integer PRIMARY KEY,
    product_name varchar(200),
    category     varchar(60),
    unit_price   numeric(10,2)
);

CREATE TABLE sales.dim_date (
    date_key      integer PRIMARY KEY,
    calendar_date date,
    month_name    varchar(10),
    fiscal_year   smallint
);

CREATE TABLE sales.fct_order (
    order_id   bigint PRIMARY KEY,
    date_key   integer REFERENCES sales.dim_date (date_key),
    store_id   integer REFERENCES sales.dim_store (store_id),
    product_id integer REFERENCES sales.dim_product (product_id),
    quantity   integer,
    amount     numeric(12,2)
);
`;

/** The command the export scene types: the whole database's DDL, in one step, into sales.sql. */
export const PG_DUMP = `pg_dump --schema-only --no-owner --no-privileges -d ${PG.db} -f sales.sql`;

/** (Re)makes the shop database in the local PostgreSQL, from SHOP_SQL. */
export function makeShopDb() {
  const psql = which('psql');
  const run = (db, sql) => execFileSync(psql, ['-h', PG.host, '-d', db, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], { stdio: ['ignore', 'ignore', 'inherit'] });
  run('postgres', `DROP DATABASE IF EXISTS ${PG.db}`);
  run('postgres', `CREATE DATABASE ${PG.db}`);
  run(PG.db, SHOP_SQL);
}

/** The plain take's folder: the code that loads the warehouse (no DDL yet: the export scene dumps it). */
const PLAIN = {
  'README.md': '# shop-analytics\n\nLoads the shop\'s orders into its PostgreSQL warehouse.\n',
  '.gitignore': 'node_modules/\n.venv/\n',
  'pipelines/load_orders.py': 'def load_orders(conn):\n    conn.execute("insert into sales.fct_order select * from staging.orders")\n',
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
 * Code chooses them in the plain take, so they are read from its file; a quoted type such as
 * "character varying(100)" keeps its spaces), or a customer_id, name and email when there is none.
 * The comparison's differences are the ones planted on purpose, not these.
 */
export function dimCustomerYml(dbml) {
  const cols = dbml ? [...dbml.matchAll(/^ {2}(\w+) +(?:"([^"]+)"|([A-Za-z_]+(?:\(\d+(?:,\d+)?\))?))/gm)].filter(([, n]) => n !== 'Note').map(([, n, q, t]) => [n, q ?? t])
    : [['customer_id', 'integer'], ['customer_name', 'character varying(100)'], ['email', 'character varying(150)']];
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
  'profiles.yml': 'shop_analytics:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: ":memory:"\n      schema: sales\n',
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
        data_type: integer
        data_tests: [unique, not_null]
      - name: store_name
        data_type: character varying(100)
      - name: city
        data_type: character varying(60)
      - name: region
        data_type: character varying(30)

  - name: dim_product
    columns:
      - name: product_id
        data_type: integer
        data_tests: [unique, not_null]
      - name: product_name
        data_type: character varying(200)
      - name: category
        data_type: character varying(60)
      - name: unit_price
        data_type: numeric(10,2)

  - name: dim_date
    columns:
      - name: date_key
        data_type: integer
        data_tests: [unique, not_null]
      - name: calendar_date
        data_type: date
      - name: month_name
        data_type: character varying(10)
      - name: fiscal_year
        data_type: smallint

__DIM_CUSTOMER__
  - name: fct_order
    columns:
      - name: order_id
        data_type: bigint
        data_tests: [unique, not_null]
      - name: date_key
        data_type: integer
        data_tests:
          - relationships:
              arguments:
                to: ref('dim_date')
                field: date_key
      - name: store_id
        data_type: integer
        data_tests:
          - relationships:
              arguments:
                to: ref('dim_store')
                field: store_id
      - name: product_id
        data_type: integer
        data_tests:
          - relationships:
              arguments:
                to: ref('dim_product')
                field: product_id
      - name: customer_id
        data_type: integer
        data_tests:
          - relationships:
              arguments:
                to: ref('dim_customer')
                field: customer_id
      - name: quantity
        data_type: integer
      - name: amount
        data_type: numeric(18,2)
      - name: order_status
        data_type: character varying(20)
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

/** Writes the plain take's folder under `root` (replacing it), and makes the shop database it exports afresh. */
export function makePlain(root = ROOT) {
  rmSync(plainFolder(root), { recursive: true, force: true });
  write(plainFolder(root), PLAIN);
  makeShopDb();
  return plainFolder(root);
}

/**
 * The canvas the scale take fits the diagram into (CSS px: the 1440x600 window with the side bar
 * closed): bigProject.mjs --fit packs its 2,000 tables so Fit, at its least zoom (0.05), shows all of them.
 */
export const BIG_FIT = '1390x475';

/** The scale take's folder under `root` (replacing it): record/bigProject.mjs's 2,000-table project, packed for BIG_FIT. */
export function makeBig(root = ROOT) {
  rmSync(join(root, 'big'), { recursive: true, force: true });
  mkdirSync(bigFolder(root), { recursive: true });
  execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'bigProject.mjs'), bigFolder(root), '--fit', BIG_FIT], { stdio: 'inherit' });
  return bigFolder(root);
}

/** The first file named `name` under `dir` (any depth), or null. */
function findFile(dir, name) {
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) { const f = findFile(full, name); if (f) return f; }
    else if (e === name) return full;
  }
  return null;
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
  const dc = findFile(join(erd, 'main', 'tables'), 'dim_customer.dbml');
  const marts = join(dbtFolder(root), 'models', 'marts', '_marts.yml');
  writeFileSync(marts, readFileSync(marts, 'utf8').replace('__DIM_CUSTOMER__\n', dimCustomerYml(dc ? readFileSync(dc, 'utf8') : null)));
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
