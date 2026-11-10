// The launch cut's one example (script.launch.yaml, scenes/launch/*): a small shop's `sales`
// schema in PostgreSQL — customers, stores, products, orders, order_items, payments, five foreign
// keys — exported with ONE command (pg_dump --schema-only, a whole schema in one .sql file) and
// brought in with Import… → SQL DDL scripts. Every excerpt is real output:
//   - SALES_SQL lines: pg_dump 14's own text for that schema (created in a local Postgres).
//   - The draft banner: src/services/draftModel.ts draftHeadline/draftDetail with the SQL import's
//     origin phrase (importSources.ts sqlOriginPhrase: `from 1 SQL file (PostgreSQL)`).
//   - ORDERS_DBML: core's renderNewTableDbml for sales.orders, then formatDbml (the aligned
//     layout Keep writes to .erd-studio/gold/tables/sales/orders.dbml).
// Not a scene module: the scenes import it.
export const S = {
  schema: 'sales', layer: 'gold', diagram: 'sales',
  customers: {
    name: 'customers',
    cols: [{ key: 'PK', name: 'customer_id', type: 'integer' }, { name: 'name', type: 'text' }, { name: 'email', type: 'text' }],
  },
  orders: {
    name: 'orders',
    cols: [{ key: 'PK', name: 'order_id', type: 'integer' }, { key: 'FK', name: 'customer_id', type: 'integer' }, { key: 'FK', name: 'store_id', type: 'integer' }, { name: 'order_date', type: 'date' }],
  },
  tables: ['customers', 'stores', 'products', 'orders', 'order_items', 'payments'],
};

export const PATHS = {
  ordersFile: 'orders.dbml',
  ordersCrumb: '.erd-studio › gold › tables › sales',
  diagram: '.erd-studio/gold/diagrams/sales.dbml',
};

/** .erd-studio/gold/tables/sales/orders.dbml, as Keep writes it. */
export const ORDERS_DBML = [
  'Table sales.orders {',
  '  order_id    integer [pk]',
  "  customer_id integer [foreign_key: 'true']",
  "  store_id    integer [foreign_key: 'true']",
  '  order_date  date',
  '  status      text',
  '}',
];

/** The start of pg_dump's sales.sql (pg_dump 14, --schema-only --no-owner --no-privileges). */
export const SALES_SQL = [
  'CREATE TABLE sales.customers (',
  '    customer_id integer NOT NULL,',
  '    name text NOT NULL,',
  '    email text',
  ');',
];

/** Snowflake's GET_DDL('SCHEMA', …) result: the schema, then every table in it. */
export const SNOWFLAKE_DDL = [
  'create or replace schema SALES;',
  '',
  'create or replace TABLE CUSTOMERS (',
  '  CUSTOMER_ID NUMBER(38,0) NOT NULL,',
  '  NAME VARCHAR(16777216) NOT NULL,',
];

/** The draft banner for that file (draftModel.ts). */
export const DRAFT = {
  headline: ['Draft from 1 SQL file (PostgreSQL)', '6 tables, 5 relationships', 'not saved'],
  detail: 'Keep saves it as sales in the Gold layer (.erd-studio/gold/diagrams/sales.dbml).',
};
