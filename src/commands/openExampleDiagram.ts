/**
 * **Open Example Diagram** (`erdStudio.openExampleDiagram`) — a ready-made
 * coffee-shop star schema for someone who has never drawn a data model: the
 * same six tables, columns and relationships as the marts layer of the sample
 * dbt project (github.com/liam-machine/erd-studio-sample), with grain, roles,
 * keys and measures filled in.
 *
 * It is Import DBML… with the file supplied: the DBML below is fed through
 * the very same flow (`importDbml`), so the user still names the diagram and
 * sees the dry-run summary with Import / Cancel before anything is written,
 * and the files land exactly as an import writes them (a plain folder gets
 * `.erd-studio/` and its `layers.json` on that confirm, never before).
 * No dbt needed, and nothing new ships in the VSIX: the DBML is inline.
 *
 * Only the file-reading half of the import UI is replaced (`exampleDbmlUi`):
 * the "file" is a name that is never opened, and its DBML has no
 * `erd_layout`, so the canvas lays the diagram out when it opens. The diagram goes
 * in the `gold` layer when the project has it (a dbt project's default layers
 * do), in the only layer of a project that has one (a new project without dbt
 * starts with `main`), else the import asks for a layer as usual. Its tables
 * are unqualified, so in a DBML project they take the layer's name as their
 * schema (`gold/tables/gold/`).
 */

import * as path from 'path';

import {
  importDbml,
  vscodeImportDbmlUi,
  type ImportDbmlDeps,
  type ImportDbmlResult,
  type ImportDbmlUi,
} from './importDbml';

export const OPEN_EXAMPLE_DIAGRAM_COMMAND = 'erdStudio.openExampleDiagram';

/** The name the import shows for the example (it is never read from disk). */
export const EXAMPLE_DBML_FILE_NAME = 'coffee-shop.dbml';

/** The layer the example goes in when the project has it. */
export const EXAMPLE_LAYER = 'gold';

/**
 * The coffee-shop star schema, in DBML with ERD Studio's custom properties
 * (`role`, `grain`, `rationale_*`, `natural_key`, `scd_type`,
 * `additive_type`; see `src/services/dbmlImport.ts`). Plain DBML apart from
 * those, so it also opens in dbdiagram.io. Kept free of settings ERD Studio
 * has no field for (`not null`, defaults, indexes), so the import keeps
 * nothing in `meta.dbml`. Tested to parse and import whole in
 * `test/unit/openExampleDiagram.test.ts`.
 */
export const EXAMPLE_DBML = `Project "coffee-shop" {
  Note: 'Example diagram: a small coffee-and-toastie chain modelled as a Kimball star schema. Dimensions describe who, what, where and when; facts record orders and hold the numbers you add up.'
}

Table dim_customers [role: 'conformed-dim', grain: 'One row per customer', rationale_scd_strategy: 'Type 1: each customer as they are today. Keep history in a separate snapshot table if you need it.'] {
  Note: 'Customer dimension, with lifetime order totals.'
  customer_id varchar [pk, natural_key: 'true', note: 'Natural key from the source system. It never changes, so it is used directly.']
  customer_name varchar [scd_type: '1', note: 'The full name of the customer.']
  customer_type varchar [scd_type: '1', note: 'new for one order, returning for more than one.']
  first_order_date date [note: 'Date of the first order.']
  last_order_date date [note: 'Date of the most recent order.']
  count_lifetime_orders bigint [note: 'Number of orders ever placed.']
  lifetime_spend_pretax decimal(38,2) [note: 'Total spent across all orders, before tax, in dollars.']
  lifetime_spend decimal(38,2) [note: 'Total spent across all orders, including tax, in dollars.']
}

Table dim_products [role: 'conformed-dim', grain: 'One row per product on the menu', rationale_design: 'Supply details are folded in so the star stays one hop deep.'] {
  Note: 'Product dimension: what is on the menu.'
  product_id varchar [pk, natural_key: 'true', note: 'The product SKU, for example JAF-001.']
  product_name varchar [note: 'Menu name of the product.']
  product_type varchar [note: 'Either jaffle (food) or beverage.']
  product_description varchar [note: 'Menu description of the product.']
  product_price decimal(16,2) [note: 'Menu price in dollars.']
  is_food_item boolean [note: 'True when the product is a jaffle.']
  is_drink_item boolean [note: 'True when the product is a beverage.']
  count_supplies bigint [note: 'How many supplies go into one of this product.']
  supply_cost decimal(38,2) [note: 'Cost of the supplies used to make one, in dollars.']
  has_perishable_supplies boolean [note: 'True when any supply for this product spoils.']
}

Table dim_locations [role: 'conformed-dim', grain: 'One row per shop'] {
  Note: 'Location dimension: the shops.'
  location_id varchar [pk, natural_key: 'true', note: 'Natural key from the source system.']
  location_name varchar [note: 'City the shop is in.']
  tax_rate decimal(6,4) [note: 'Sales tax rate charged at this shop.']
  opened_date date [note: 'Date the shop opened.']
}

Table dim_dates [role: 'conformed-dim', grain: 'One row per calendar day'] {
  Note: 'Date dimension, so reports can group by year, month or weekday without recomputing them.'
  date_day date [pk, note: 'The calendar date.']
  year_number bigint [note: 'Calendar year.']
  quarter_number bigint [note: 'Calendar quarter, 1 to 4.']
  month_number bigint [note: 'Month of the year, 1 to 12.']
  month_name varchar [note: 'Month name, for example January.']
  day_of_month bigint [note: 'Day of the month, 1 to 31.']
  day_of_week_number bigint [note: 'ISO day of week, 1 = Monday to 7 = Sunday.']
  day_of_week_name varchar [note: 'Weekday name, for example Monday.']
  is_weekend boolean [note: 'True on Saturday and Sunday.']
}

Table fct_orders [role: 'transaction-fact', grain: 'One row per order', rationale_measures: 'Amounts and counts are additive: they can be summed across customers, shops and dates.'] {
  Note: 'Order fact: one business event per row.'
  order_id varchar [pk, natural_key: 'true', note: 'Natural key for the order from the source system.']
  customer_id varchar [ref: > dim_customers.customer_id, note: 'Who placed the order.']
  location_id varchar [ref: > dim_locations.location_id, note: 'Which shop took the order.']
  order_date date [ref: > dim_dates.date_day, note: 'The day the order was placed.']
  ordered_at timestamp [note: 'Exact time the order was placed.']
  subtotal decimal(16,2) [additive_type: 'additive', note: 'Order amount before tax, in dollars.']
  tax_paid decimal(16,2) [additive_type: 'additive', note: 'Tax charged on the order, in dollars.']
  order_total decimal(16,2) [additive_type: 'additive', note: 'Order amount including tax, in dollars.']
  order_cost decimal(38,2) [additive_type: 'additive', note: 'Cost of the supplies used to make the order, in dollars.']
  count_order_items bigint [additive_type: 'additive', note: 'Number of items on the order.']
  count_food_items bigint [additive_type: 'additive', note: 'Number of food items on the order.']
  count_drink_items bigint [additive_type: 'additive', note: 'Number of drink items on the order.']
  is_food_order boolean [note: 'True when the order contains at least one food item.']
  is_drink_order boolean [note: 'True when the order contains at least one drink item.']
  customer_order_number bigint [additive_type: 'non-additive', note: '1 for the first order of a customer, 2 for the second, and so on.']
}

Table fct_order_items [role: 'transaction-fact', grain: 'One row per item on an order', rationale_grain_choice: 'The finest grain in the star, so product-level questions need no join back to the order.'] {
  Note: 'Order item fact. order_id links each line back to its order.'
  order_item_id varchar [pk, natural_key: 'true', note: 'Natural key for the order line from the source system.']
  order_id varchar [ref: > fct_orders.order_id, note: 'The order this line belongs to.']
  customer_id varchar [ref: > dim_customers.customer_id, note: 'Who placed the order.']
  location_id varchar [ref: > dim_locations.location_id, note: 'Which shop took the order.']
  product_id varchar [ref: > dim_products.product_id, note: 'What was ordered.']
  order_date date [ref: > dim_dates.date_day, note: 'The day the order was placed.']
  product_price decimal(16,2) [additive_type: 'additive', note: 'Price charged for this item, in dollars.']
  supply_cost decimal(38,2) [additive_type: 'additive', note: 'Cost of the supplies used for this item, in dollars.']
}
`;

/**
 * The import UI with the file supplied: `examplePath` reads as
 * `EXAMPLE_DBML`. Everything else (the pickers, the dry run, opening the
 * diagram) is `base`'s.
 */
export function exampleDbmlUi(base: ImportDbmlUi, examplePath: string): ImportDbmlUi {
  return {
    ...base,
    pickFile: async () => examplePath,
    readFile: async (filePath) => (filePath === examplePath ? EXAMPLE_DBML : base.readFile(filePath)),
  };
}

/**
 * Run the example import. Resolves what `importDbml` resolves: undefined when
 * the user cancels (or a write fails, already reported). The flow counts
 * `exampleDiagram` (never `importDbml`) once the diagram is written, a retry
 * included; a cancelled example counts nothing.
 */
export async function openExampleDiagram(deps: ImportDbmlDeps): Promise<ImportDbmlResult | undefined> {
  const examplePath = path.join(deps.workspaceRoot, EXAMPLE_DBML_FILE_NAME);
  const ui = exampleDbmlUi(deps.ui ?? vscodeImportDbmlUi(), examplePath);
  const hasExampleLayer = deps.layerService.getCreatableLayers().some((l) => l.id === EXAMPLE_LAYER);
  return importDbml(
    { ...deps, ui, source: 'example' },
    { filePath: examplePath, ...(hasExampleLayer ? { layer: EXAMPLE_LAYER } : {}) },
  );
}
