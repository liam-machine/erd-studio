/**
 * Synthetic samples for the relationship-suggestion measurement
 * (relationshipSuggestions.measure.test.ts): a deliberately messy lakehouse,
 * and a large model for timing. Deterministic.
 */
import type { ColumnDef, SemanticTable } from '../../src/types/semantic';

export interface SyntheticLink {
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
}

const col = (name: string, dataType: string): ColumnDef => ({ name, dataType, description: '' });
const table = (schema: string, name: string, columns: ColumnDef[]): SemanticTable => ({ name, schema, columns });

/**
 * A messy medallion lakehouse with no keys declared anywhere (the common Unity Catalog case):
 * - bronze: raw landing copies of every source table, every column STRING, plus ingestion columns;
 * - silver: the cleaned, normalised entities, plus the copies teams leave lying around (an SCD2
 *   snapshot, a dated backup, an "enriched" wide table, a dedup temp table), audit columns everywhere,
 *   a `tenant_id` and `source_system` on every table with no tenant table (a junk hub), and
 *   `created_by` / `updated_by` strings;
 * - gold: a star (surrogate `_sk` keys, a date dimension with `date_key`, role-playing dates), an
 *   aggregate, a customer-360 wide table and a KPI table.
 *
 * Table names are unique (as an import makes them: a name in two schemas gets its schema in front).
 * `truth` is what a modeller would draw: the silver model's foreign keys and the gold star's.
 * `plausible` is what is defensible but not modelled: a bronze copy's link to another bronze copy, or a
 * silver copy's link where the base table has the same one. Everything else suggested is wrong
 * (cross-layer lineage, junk hubs, audit columns, copies pointing at each other).
 */
export function messyLakehouse(): { tables: SemanticTable[]; truth: SyntheticLink[] } {
  const audit = (): ColumnDef[] => [
    col('created_at', 'timestamp'), col('updated_at', 'timestamp'), col('created_by', 'string'), col('updated_by', 'string'),
    col('_loaded_at', 'timestamp'), col('etl_batch_id', 'bigint'), col('tenant_id', 'int'), col('source_system', 'string'),
  ];
  const ingest = (): ColumnDef[] => [col('_loaded_at', 'timestamp'), col('_source_file', 'string'), col('_ingest_batch_id', 'string'), col('_rescued_data', 'string')];

  // Silver: the source of truth for the normalised model.
  const silver: Record<string, ColumnDef[]> = {
    customers: [col('customer_id', 'bigint'), col('first_name', 'string'), col('last_name', 'string'), col('email', 'string'), col('country_code', 'string'), col('segment', 'string'), col('status', 'string'), col('is_active', 'boolean')],
    countries: [col('country_code', 'string'), col('country_name', 'string'), col('region', 'string')],
    currencies: [col('currency_code', 'string'), col('currency_name', 'string'), col('symbol', 'string')],
    products: [col('product_id', 'bigint'), col('sku', 'string'), col('product_name', 'string'), col('category_id', 'int'), col('brand', 'string'), col('list_price', 'decimal(18,2)'), col('status', 'string')],
    categories: [col('category_id', 'int'), col('category_name', 'string'), col('parent_category_id', 'int')],
    stores: [col('store_id', 'int'), col('store_name', 'string'), col('country_code', 'string'), col('manager_id', 'int'), col('opened_on', 'date')],
    employees: [col('employee_id', 'int'), col('full_name', 'string'), col('store_id', 'int'), col('manager_id', 'int'), col('hire_date', 'date'), col('status', 'string')],
    orders: [col('order_id', 'bigint'), col('customer_id', 'bigint'), col('store_id', 'int'), col('order_date', 'date'), col('ship_date', 'date'), col('currency_code', 'string'), col('total_amount', 'decimal(18,2)'), col('status', 'string'), col('type', 'string')],
    order_items: [col('order_id', 'bigint'), col('line_number', 'int'), col('product_id', 'bigint'), col('quantity', 'int'), col('unit_price', 'decimal(18,2)'), col('discount', 'decimal(5,2)')],
    payments: [col('payment_id', 'bigint'), col('order_id', 'bigint'), col('payment_method', 'string'), col('amount', 'decimal(18,2)'), col('currency_code', 'string'), col('paid_at', 'timestamp')],
    shipments: [col('shipment_id', 'bigint'), col('order_id', 'bigint'), col('from_store_id', 'int'), col('carrier', 'string'), col('tracking_no', 'string'), col('shipped_at', 'timestamp'), col('delivered_at', 'timestamp')],
    app_users: [col('user_id', 'int'), col('email', 'string'), col('display_name', 'string')],
  };
  const tables: SemanticTable[] = [];
  for (const [name, cols] of Object.entries(silver)) {
    // Bronze: every column a string, and the ingestion columns.
    tables.push(table('bronze', `raw_${name}`, [...cols.map((c) => col(c.name, 'string')), ...ingest()]));
    tables.push(table('silver', name, [...cols, ...audit()]));
  }
  // Silver copies.
  tables.push(table('silver', 'customers_snapshot', [...silver.customers, col('dbt_scd_id', 'string'), col('dbt_valid_from', 'timestamp'), col('dbt_valid_to', 'timestamp'), col('dbt_updated_at', 'timestamp')]));
  tables.push(table('silver', 'orders_bak_20240101', [...silver.orders, ...audit()]));
  tables.push(table('silver', 'orders_enriched', [...silver.orders, col('customer_name', 'string'), col('customer_email', 'string'), col('country_name', 'string'), col('item_count', 'int'), ...audit()]));
  tables.push(table('silver', 'customers_dedup_tmp', [col('customer_id', 'bigint'), col('email', 'string'), col('row_num', 'int')]));
  tables.push(table('silver', 'order_status_history', [col('order_id', 'bigint'), col('status', 'string'), col('changed_at', 'timestamp'), col('changed_by', 'string'), ...audit()]));

  // Gold: the star.
  tables.push(table('gold', 'dim_customer', [col('customer_sk', 'bigint'), col('customer_id', 'bigint'), col('full_name', 'string'), col('country_name', 'string'), col('segment', 'string'), col('is_current', 'boolean'), col('valid_from', 'timestamp'), col('valid_to', 'timestamp')]));
  tables.push(table('gold', 'dim_product', [col('product_sk', 'bigint'), col('product_id', 'bigint'), col('product_name', 'string'), col('category_name', 'string'), col('brand', 'string')]));
  tables.push(table('gold', 'dim_store', [col('store_sk', 'bigint'), col('store_id', 'int'), col('store_name', 'string'), col('country_name', 'string')]));
  tables.push(table('gold', 'dim_date', [col('date_key', 'int'), col('date', 'date'), col('year', 'int'), col('month', 'int'), col('day_of_week', 'string'), col('is_weekend', 'boolean')]));
  tables.push(table('gold', 'fct_order_lines', [col('order_id', 'bigint'), col('line_number', 'int'), col('customer_sk', 'bigint'), col('product_sk', 'bigint'), col('store_sk', 'bigint'), col('order_date_key', 'int'), col('ship_date_key', 'int'), col('quantity', 'int'), col('net_amount', 'decimal(18,2)'), col('_loaded_at', 'timestamp')]));
  tables.push(table('gold', 'fct_payments', [col('payment_id', 'bigint'), col('order_id', 'bigint'), col('customer_sk', 'bigint'), col('payment_date_key', 'int'), col('amount', 'decimal(18,2)'), col('_loaded_at', 'timestamp')]));
  tables.push(table('gold', 'agg_daily_sales', [col('date_key', 'int'), col('store_sk', 'bigint'), col('order_count', 'bigint'), col('total_amount', 'decimal(18,2)')]));
  tables.push(table('gold', 'customer_360', [col('customer_id', 'bigint'), col('lifetime_value', 'decimal(18,2)'), col('last_order_date', 'date'), col('order_count', 'bigint'), col('segment', 'string'), col('country_code', 'string')]));
  tables.push(table('gold', 'kpi_summary', [col('date', 'date'), col('store_id', 'int'), col('metric_name', 'string'), col('metric_value', 'double'), col('status', 'string')]));

  const truth: SyntheticLink[] = [
    // silver
    { from: 'orders', fromColumn: 'customer_id', to: 'customers', toColumn: 'customer_id' },
    { from: 'orders', fromColumn: 'store_id', to: 'stores', toColumn: 'store_id' },
    { from: 'orders', fromColumn: 'currency_code', to: 'currencies', toColumn: 'currency_code' },
    { from: 'order_items', fromColumn: 'order_id', to: 'orders', toColumn: 'order_id' },
    { from: 'order_items', fromColumn: 'product_id', to: 'products', toColumn: 'product_id' },
    { from: 'products', fromColumn: 'category_id', to: 'categories', toColumn: 'category_id' },
    { from: 'categories', fromColumn: 'parent_category_id', to: 'categories', toColumn: 'category_id' },
    { from: 'stores', fromColumn: 'country_code', to: 'countries', toColumn: 'country_code' },
    { from: 'stores', fromColumn: 'manager_id', to: 'employees', toColumn: 'employee_id' },
    { from: 'employees', fromColumn: 'store_id', to: 'stores', toColumn: 'store_id' },
    { from: 'employees', fromColumn: 'manager_id', to: 'employees', toColumn: 'employee_id' },
    { from: 'customers', fromColumn: 'country_code', to: 'countries', toColumn: 'country_code' },
    { from: 'payments', fromColumn: 'order_id', to: 'orders', toColumn: 'order_id' },
    { from: 'payments', fromColumn: 'currency_code', to: 'currencies', toColumn: 'currency_code' },
    { from: 'shipments', fromColumn: 'order_id', to: 'orders', toColumn: 'order_id' },
    { from: 'shipments', fromColumn: 'from_store_id', to: 'stores', toColumn: 'store_id' },
    { from: 'order_status_history', fromColumn: 'order_id', to: 'orders', toColumn: 'order_id' },
    // gold
    { from: 'fct_order_lines', fromColumn: 'customer_sk', to: 'dim_customer', toColumn: 'customer_sk' },
    { from: 'fct_order_lines', fromColumn: 'product_sk', to: 'dim_product', toColumn: 'product_sk' },
    { from: 'fct_order_lines', fromColumn: 'store_sk', to: 'dim_store', toColumn: 'store_sk' },
    { from: 'fct_order_lines', fromColumn: 'order_date_key', to: 'dim_date', toColumn: 'date_key' },
    { from: 'fct_order_lines', fromColumn: 'ship_date_key', to: 'dim_date', toColumn: 'date_key' },
    { from: 'fct_payments', fromColumn: 'customer_sk', to: 'dim_customer', toColumn: 'customer_sk' },
    { from: 'fct_payments', fromColumn: 'payment_date_key', to: 'dim_date', toColumn: 'date_key' },
    { from: 'agg_daily_sales', fromColumn: 'date_key', to: 'dim_date', toColumn: 'date_key' },
    { from: 'agg_daily_sales', fromColumn: 'store_sk', to: 'dim_store', toColumn: 'store_sk' },
  ];
  return { tables, truth };
}

/** A deterministic pseudo-random sequence (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `tableCount` tables of `columnsPerTable` columns: a tenth are dimensions (`dim_entity_<n>` keyed
 * `entity_<n>_id`), the rest facts with references to random dimensions (some with a role in front),
 * measures and audit columns. No keys are declared (the inference has to run on every table).
 */
export function largeModel(tableCount = 2000, columnsPerTable = 40): SemanticTable[] {
  const rand = rng(42);
  const dims = Math.max(1, Math.floor(tableCount / 10));
  const out: SemanticTable[] = [];
  for (let i = 0; i < tableCount; i++) {
    const isDim = i < dims;
    const name = isDim ? `dim_entity_${i}` : `fct_event_${i}`;
    const columns: ColumnDef[] = [col(isDim ? `entity_${i}_id` : `event_${i}_id`, 'bigint')];
    while (columns.length < columnsPerTable) {
      const r = rand();
      const n = columns.length;
      if (!isDim && r < 0.25) {
        const d = Math.floor(rand() * dims);
        columns.push(col(rand() < 0.2 ? `role${n}_entity_${d}_id` : `entity_${d}_id`, 'bigint'));
      } else if (r < 0.35) {
        columns.push(col(['created_at', 'updated_at', '_loaded_at', 'status', 'is_active', 'tenant_id'][n % 6] + (n > 6 ? `_${n}` : ''), 'string'));
      } else {
        columns.push(col(`attribute_${n}`, r < 0.7 ? 'string' : 'decimal(18,2)'));
      }
    }
    // Unique column names within a table.
    const seen = new Set<string>();
    out.push({ name, schema: 'main', columns: columns.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true))) });
  }
  return out;
}

/**
 * A second messy lakehouse, written after the rules were frozen and never tuned on (the holdout): a different
 * house style from `messyLakehouse` — two source systems landing the same entity (`crm_customer`,
 * `erp_customer`), abbreviations (`cust_no`, `prod_cd`), `<entity>_dim` / `<entity>_fact` suffixes, `id` keys,
 * Delta change-feed and SAP-style bookkeeping columns, an analysts' sandbox schema full of copies, and
 * descriptive text columns (`region`, `country`, `currency`) shared by everything. No keys declared.
 */
export function messyLakehouseHoldout(): { tables: SemanticTable[]; truth: SyntheticLink[] } {
  const cdf = (): ColumnDef[] => [col('_change_type', 'string'), col('_commit_version', 'bigint'), col('_commit_timestamp', 'timestamp')];
  const sap = (): ColumnDef[] => [col('src_sys_cd', 'string'), col('rec_eff_dt', 'date'), col('rec_exp_dt', 'date'), col('curr_flag', 'string'), col('ingest_ts', 'timestamp'), col('load_user', 'string')];
  const t: SemanticTable[] = [];
  // Bronze, per source system.
  t.push(table('crm_bronze', 'crm_customer_raw', [col('CustomerId', 'string'), col('Name', 'string'), col('Region', 'string'), col('Country', 'string'), col('__index_level_0__', 'bigint'), ...cdf()]));
  t.push(table('crm_bronze', 'crm_order_raw', [col('OrderId', 'string'), col('CustomerId', 'string'), col('OrderDate', 'string'), col('Amount', 'string'), col('Currency', 'string'), ...cdf()]));
  t.push(table('erp_bronze', 'erp_kna1', [col('kunnr', 'string'), col('name1', 'string'), col('land1', 'string'), col('bukrs', 'string'), ...cdf()]));
  t.push(table('erp_bronze', 'erp_vbrk', [col('vbeln', 'string'), col('kunrg', 'string'), col('fkdat', 'string'), col('netwr', 'string'), col('waerk', 'string'), col('bukrs', 'string'), ...cdf()]));
  // Silver.
  t.push(table('silver', 'crm_customer', [col('customer_id', 'bigint'), col('name', 'string'), col('region', 'string'), col('country', 'string'), col('segment', 'string'), ...sap()]));
  t.push(table('silver', 'crm_order', [col('order_id', 'bigint'), col('customer_id', 'bigint'), col('order_date', 'date'), col('amount', 'decimal(18,2)'), col('currency', 'string'), col('region', 'string'), ...sap()]));
  t.push(table('silver', 'erp_customer', [col('cust_no', 'string'), col('customer_name', 'string'), col('country', 'string'), col('company_code', 'string'), ...sap()]));
  t.push(table('silver', 'erp_invoice', [col('id', 'bigint'), col('invoice_no', 'string'), col('cust_no', 'string'), col('plant_code', 'string'), col('company_code', 'string'), col('invoice_date', 'date'), col('net_value', 'decimal(18,2)'), col('currency', 'string'), ...sap()]));
  t.push(table('silver', 'erp_invoice_line', [col('id', 'bigint'), col('invoice_id', 'bigint'), col('line_no', 'int'), col('prod_cd', 'string'), col('qty', 'decimal(18,3)'), col('net_value', 'decimal(18,2)'), ...sap()]));
  t.push(table('silver', 'product', [col('product_code', 'string'), col('description', 'string'), col('product_group', 'string'), col('company_code', 'string'), col('unit', 'string'), ...sap()]));
  t.push(table('silver', 'company', [col('company_code', 'string'), col('company_name', 'string'), col('country', 'string'), col('currency', 'string')]));
  t.push(table('silver', 'plant', [col('plant_code', 'string'), col('plant_name', 'string'), col('company_code', 'string'), col('region', 'string'), col('country', 'string')]));
  t.push(table('silver', 'customer_master', [col('customer_id', 'bigint'), col('crm_customer_id', 'bigint'), col('erp_customer_id', 'string'), col('golden_name', 'string'), col('country', 'string'), col('match_score', 'double'), ...sap()]));
  t.push(table('silver', 'region', [col('region', 'string'), col('region_name', 'string'), col('country', 'string')]));
  // Gold.
  t.push(table('gold', 'customer_dim', [col('customer_key', 'bigint'), col('customer_id', 'bigint'), col('customer_name', 'string'), col('region', 'string'), col('country', 'string'), col('curr_flag', 'string')]));
  t.push(table('gold', 'product_dim', [col('product_key', 'bigint'), col('product_code', 'string'), col('description', 'string'), col('product_group', 'string')]));
  t.push(table('gold', 'plant_dim', [col('plant_key', 'bigint'), col('plant_code', 'string'), col('plant_name', 'string'), col('region', 'string')]));
  t.push(table('gold', 'date_dim', [col('date_key', 'int'), col('calendar_date', 'date'), col('fiscal_period', 'string'), col('fiscal_year', 'int')]));
  t.push(table('gold', 'sales_fact', [col('customer_key', 'bigint'), col('product_key', 'bigint'), col('date_key', 'int'), col('ship_date_key', 'int'), col('order_no', 'string'), col('company_code', 'string'), col('currency', 'string'), col('quantity', 'decimal(18,3)'), col('net_value', 'decimal(18,2)')]));
  t.push(table('gold', 'inventory_snapshot_fact', [col('product_key', 'bigint'), col('plant_key', 'bigint'), col('date_key', 'int'), col('on_hand_qty', 'decimal(18,3)')]));
  t.push(table('gold', 'region_sales_agg', [col('region', 'string'), col('country', 'string'), col('date_key', 'int'), col('net_value', 'decimal(18,2)')]));
  // An analysts' sandbox: copies and experiments.
  t.push(table('sandbox', 'jsmith_sales_fact_copy', [col('customer_key', 'bigint'), col('product_key', 'bigint'), col('date_key', 'int'), col('net_value', 'decimal(18,2)')]));
  t.push(table('sandbox', 'tmp_customer_dim', [col('customer_key', 'bigint'), col('customer_id', 'bigint'), col('customer_name', 'string')]));
  t.push(table('sandbox', 'sales_fact_v2', [col('customer_key', 'bigint'), col('product_key', 'bigint'), col('date_key', 'int'), col('promo_id', 'bigint'), col('net_value', 'decimal(18,2)')]));

  const truth: SyntheticLink[] = [
    { from: 'crm_order', fromColumn: 'customer_id', to: 'crm_customer', toColumn: 'customer_id' },
    { from: 'erp_invoice', fromColumn: 'cust_no', to: 'erp_customer', toColumn: 'cust_no' },
    { from: 'erp_invoice', fromColumn: 'plant_code', to: 'plant', toColumn: 'plant_code' },
    { from: 'erp_invoice', fromColumn: 'company_code', to: 'company', toColumn: 'company_code' },
    { from: 'erp_invoice_line', fromColumn: 'invoice_id', to: 'erp_invoice', toColumn: 'id' },
    { from: 'erp_invoice_line', fromColumn: 'prod_cd', to: 'product', toColumn: 'product_code' },
    { from: 'erp_customer', fromColumn: 'company_code', to: 'company', toColumn: 'company_code' },
    { from: 'product', fromColumn: 'company_code', to: 'company', toColumn: 'company_code' },
    { from: 'plant', fromColumn: 'company_code', to: 'company', toColumn: 'company_code' },
    { from: 'customer_master', fromColumn: 'crm_customer_id', to: 'crm_customer', toColumn: 'customer_id' },
    { from: 'customer_master', fromColumn: 'erp_customer_id', to: 'erp_customer', toColumn: 'cust_no' },
    { from: 'sales_fact', fromColumn: 'customer_key', to: 'customer_dim', toColumn: 'customer_key' },
    { from: 'sales_fact', fromColumn: 'product_key', to: 'product_dim', toColumn: 'product_key' },
    { from: 'sales_fact', fromColumn: 'date_key', to: 'date_dim', toColumn: 'date_key' },
    { from: 'sales_fact', fromColumn: 'ship_date_key', to: 'date_dim', toColumn: 'date_key' },
    { from: 'inventory_snapshot_fact', fromColumn: 'product_key', to: 'product_dim', toColumn: 'product_key' },
    { from: 'inventory_snapshot_fact', fromColumn: 'plant_key', to: 'plant_dim', toColumn: 'plant_key' },
    { from: 'inventory_snapshot_fact', fromColumn: 'date_key', to: 'date_dim', toColumn: 'date_key' },
    { from: 'region_sales_agg', fromColumn: 'date_key', to: 'date_dim', toColumn: 'date_key' },
  ];
  return { tables: t, truth };
}
