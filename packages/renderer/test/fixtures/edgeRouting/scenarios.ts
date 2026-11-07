/**
 * Line routing scenarios — small hand-placed diagrams that expose what goes wrong
 * with the smooth-step FK lines (which ignore the cards):
 *
 *   under     lines forced to run under a card between their two ends
 *             (horizontal, vertical, and the elbow of a step)
 *   star      a sales star with 8 dims round fct_sale, plus fct_return
 *             sharing 4 of them: crossings, and lines under fct_sale
 *   tangle    12 CRM cards / 18 lines in messy positions, two cards 3 px
 *             apart, a sticky note on a line's path
 *   showcase  the dbt-project fixture's showcase diagram (incl. a self-loop)
 *   big       40 cards / 60 lines, collapsed columns — for performance
 *   overlap   two overlapping cards, a card between two related cards, a
 *             column of cards linked past each other (ends on one side is
 *             the natural route), a self-loop, cards 6 px apart
 *
 * Exports the scenarios as `DisplaySubjectArea`s (what `<ErdCanvas>` takes)
 * and `scenarioRoutingInput(name)`: the `RoutingInput` the canvas would build
 * for it (estimated card sizes, today's anchors), so router unit and perf
 * tests can run without a browser.
 */

import type { DisplayColumn, DisplayRelationship, DisplaySubjectArea, DisplayTable } from '@erd-studio/core';
import type { InternalNode, Node } from '@xyflow/react';
import { transformSubjectArea } from '../../../src/lib/graphTransformer';
import { resolveNodeDimensions } from '../../../src/lib/nodeSizing';
import { NODE_THRESHOLD } from '../../../src/hooks/useColumnExpansion';
import { buildRoutingInput, pushOut } from '../../../src/lib/edgeRouting/input';
import { PATH_GAP, type LineRouter, type RoutedLine, type RoutingInput } from '../../../src/lib/edgeRouting/types';
import type { TableFlowNode } from '../../../src/types/graph';
// Card sizes as the browser rendered them (measured once in a browser by the experiment's screenshot harness); the estimate is the fallback.
import MEASURED_SIZES from './measured-sizes.json';

export const SCENARIO_NAMES = ['under', 'star', 'tangle', 'showcase', 'big', 'overlap'] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export const SCENARIO_HINTS: Record<ScenarioName, string> = {
  under: 'Lines that must pass under a card between their ends',
  star: 'Sales star + a second fact sharing 4 dims: crossings',
  tangle: '12 cards, 18 lines, messy positions, cards nearly touching',
  showcase: "The dbt-project fixture's showcase diagram",
  big: '40 cards, 60 lines — performance',
  overlap: 'Overlapping cards, cards in the way, a column linked past itself',
};

// ---------------------------------------------------------------------------
// A tiny DSL: tables as 'name type [pk|nk]' strings, links as 'a.col > b.col'
// ---------------------------------------------------------------------------

interface TableSpec {
  name: string;
  x: number;
  y: number;
  grain?: string;
  description?: string;
  /** 'column_name TYPE [pk] [nk]' — FK flags come from the relationships. */
  cols: string[];
}

interface AnnotationSpec {
  id: string;
  text: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  color?: 'yellow' | 'blue' | 'green' | 'pink' | 'orange';
}

function column(spec: string): DisplayColumn {
  const [name, dataType = 'VARCHAR', ...flags] = spec.trim().split(/\s+/);
  return {
    name,
    dataType,
    description: '',
    isPrimaryKey: flags.includes('pk'),
    isForeignKey: false,
    isNaturalKey: flags.includes('nk'),
  };
}

/** 'fct_sale.customer_key > dim_customer.customer_key [role words…]' */
function link(spec: string): DisplayRelationship {
  const m = spec.match(/^\s*(\w+)\.(\w+)\s*([>=])\s*(\w+)\.(\w+)\s*(.*)$/);
  if (!m) throw new Error(`scenarios: bad link "${spec}"`);
  const [, fromModel, fromColumn, op, toModel, toColumn, role] = m;
  return {
    fromModel,
    fromColumn,
    toModel,
    toColumn,
    cardinality: op === '=' ? 'one-to-one' : 'many-to-one',
    ...(role.trim() ? { role: role.trim() } : {}),
  };
}

function subjectArea(
  domain: string,
  description: string,
  tables: TableSpec[],
  links: string[],
  annotations: AnnotationSpec[] = [],
): DisplaySubjectArea {
  const relationships = links.map(link);
  const models: DisplayTable[] = tables.map((t) => ({
    name: t.name,
    schema: 'analytics',
    description: t.description ?? '',
    ...(t.grain ? { grain: t.grain } : {}),
    columns: t.cols.map(column),
  }));
  const byName = new Map(models.map((m) => [m.name, m]));
  // Every link's columns must exist; the from column is the FK.
  for (const r of relationships) {
    const from = byName.get(r.fromModel);
    const to = byName.get(r.toModel);
    const fromCol = from?.columns.find((c) => c.name === r.fromColumn);
    const toCol = to?.columns.find((c) => c.name === r.toColumn);
    if (!fromCol || !toCol) {
      throw new Error(`scenarios ${domain}: ${r.fromModel}.${r.fromColumn} > ${r.toModel}.${r.toColumn} names a missing column`);
    }
    fromCol.isForeignKey = true;
  }
  return {
    schemaVersion: 5,
    domain,
    layer: 'silver',
    stage: 'logical',
    description,
    models,
    relationships,
    viewConfig: {
      positions: Object.fromEntries(tables.map((t) => [t.name, { x: t.x, y: t.y }])),
      annotations: annotations.map((a) => ({ ...a })),
    },
    readOnly: true,
    positionDraggable: true,
  };
}

// ---------------------------------------------------------------------------
// under — every problem line runs under a card between its ends
// ---------------------------------------------------------------------------

const under = subjectArea(
  'under',
  'Lines that pass under a card between their ends',
  [
    // Row: fct_payment → dim_customer runs straight through fct_order.
    { name: 'dim_customer', x: 0, y: 40, grain: 'One row per customer', cols: ['customer_key INT pk', 'customer_id VARCHAR nk', 'customer_name VARCHAR', 'email VARCHAR', 'segment VARCHAR'] },
    { name: 'fct_order', x: 320, y: 40, grain: 'One row per order', cols: ['order_key INT pk', 'order_id VARCHAR nk', 'customer_key INT', 'order_date DATE', 'order_status VARCHAR', 'order_total DECIMAL'] },
    { name: 'fct_payment', x: 640, y: 40, grain: 'One row per payment', cols: ['payment_key INT pk', 'order_key INT', 'customer_key INT', 'paid_at TIMESTAMP', 'amount DECIMAL'] },
    // Column: dim_store → dim_region runs straight down through dim_city.
    { name: 'dim_store', x: 1000, y: 0, grain: 'One row per store', cols: ['store_key INT pk', 'store_code VARCHAR nk', 'store_name VARCHAR', 'city_key INT', 'region_key INT'] },
    { name: 'dim_city', x: 1000, y: 290, grain: 'One row per city', cols: ['city_key INT pk', 'city_name VARCHAR', 'region_key INT', 'population INT'] },
    { name: 'dim_region', x: 1000, y: 560, grain: 'One row per region', cols: ['region_key INT pk', 'region_name VARCHAR', 'country_code VARCHAR'] },
    // Elbow: the step of fct_inventory → dim_warehouse turns under dim_supplier.
    { name: 'fct_inventory', x: 0, y: 420, grain: 'One row per product per day per warehouse', cols: ['inventory_key INT pk', 'snapshot_date DATE', 'product_sku VARCHAR', 'supplier_key INT', 'warehouse_key INT', 'quantity_on_hand INT', 'stock_value DECIMAL'] },
    { name: 'dim_supplier', x: 380, y: 470, grain: 'One row per supplier', cols: ['supplier_key INT pk', 'supplier_name VARCHAR', 'country_code VARCHAR', 'lead_time_days INT'] },
    { name: 'dim_warehouse', x: 700, y: 640, grain: 'One row per warehouse', cols: ['warehouse_key INT pk', 'warehouse_code VARCHAR nk', 'warehouse_name VARCHAR', 'capacity_m3 DECIMAL'] },
  ],
  [
    'fct_order.customer_key > dim_customer.customer_key',
    'fct_payment.order_key > fct_order.order_key',
    'fct_payment.customer_key > dim_customer.customer_key',
    'dim_store.city_key > dim_city.city_key',
    'dim_city.region_key > dim_region.region_key',
    'dim_store.region_key > dim_region.region_key',
    'fct_inventory.supplier_key > dim_supplier.supplier_key',
    'fct_inventory.warehouse_key > dim_warehouse.warehouse_key',
  ],
);

// ---------------------------------------------------------------------------
// star — two facts sharing dims
// ---------------------------------------------------------------------------

const star = subjectArea(
  'star',
  'A sales star, and a returns fact sharing four of its dimensions',
  [
    { name: 'fct_sale', x: 700, y: 450, grain: 'One row per sale line', cols: ['sale_line_key INT pk', 'order_date_key INT', 'ship_date_key INT', 'customer_key INT', 'product_key INT', 'store_key INT', 'promotion_key INT', 'employee_key INT', 'payment_method_key INT', 'channel_key INT', 'quantity INT', 'net_amount DECIMAL'] },
    { name: 'dim_customer', x: 700, y: 60, grain: 'One row per customer', cols: ['customer_key INT pk', 'customer_id VARCHAR nk', 'customer_name VARCHAR', 'loyalty_tier VARCHAR', 'home_postcode VARCHAR'] },
    { name: 'dim_product', x: 1180, y: 110, grain: 'One row per product version', cols: ['product_key INT pk', 'sku VARCHAR nk', 'product_name VARCHAR', 'category VARCHAR', 'brand VARCHAR', 'unit_cost DECIMAL'] },
    { name: 'dim_store', x: 1250, y: 520, grain: 'One row per store', cols: ['store_key INT pk', 'store_code VARCHAR nk', 'store_name VARCHAR', 'state VARCHAR'] },
    { name: 'dim_promotion', x: 1180, y: 900, grain: 'One row per promotion', cols: ['promotion_key INT pk', 'promotion_name VARCHAR', 'discount_pct DECIMAL', 'starts_on DATE', 'ends_on DATE'] },
    { name: 'dim_employee', x: 700, y: 960, grain: 'One row per employee', cols: ['employee_key INT pk', 'employee_id VARCHAR nk', 'full_name VARCHAR', 'role_title VARCHAR'] },
    { name: 'dim_payment_method', x: 220, y: 900, grain: 'One row per payment method', cols: ['payment_method_key INT pk', 'method_name VARCHAR', 'provider VARCHAR'] },
    { name: 'dim_date', x: 180, y: 480, grain: 'One row per calendar date', cols: ['date_key INT pk', 'calendar_date DATE nk', 'day_of_week VARCHAR', 'fiscal_week INT', 'fiscal_quarter VARCHAR', 'fiscal_year INT'] },
    { name: 'dim_channel', x: 220, y: 110, grain: 'One row per sales channel', cols: ['channel_key INT pk', 'channel_name VARCHAR', 'is_online BOOLEAN'] },
    { name: 'fct_return', x: 1780, y: 480, grain: 'One row per returned line', cols: ['return_line_key INT pk', 'return_date_key INT', 'customer_key INT', 'product_key INT', 'store_key INT', 'return_reason VARCHAR', 'refund_amount DECIMAL'] },
  ],
  [
    'fct_sale.order_date_key > dim_date.date_key order date',
    'fct_sale.ship_date_key > dim_date.date_key ship date',
    'fct_sale.customer_key > dim_customer.customer_key',
    'fct_sale.product_key > dim_product.product_key',
    'fct_sale.store_key > dim_store.store_key',
    'fct_sale.promotion_key > dim_promotion.promotion_key',
    'fct_sale.employee_key > dim_employee.employee_key',
    'fct_sale.payment_method_key > dim_payment_method.payment_method_key',
    'fct_sale.channel_key > dim_channel.channel_key',
    'fct_return.return_date_key > dim_date.date_key',
    'fct_return.customer_key > dim_customer.customer_key',
    'fct_return.product_key > dim_product.product_key',
    'fct_return.store_key > dim_store.store_key',
  ],
);

// ---------------------------------------------------------------------------
// tangle — CRM in messy positions
// ---------------------------------------------------------------------------

const tangle = subjectArea(
  'tangle',
  'A CRM model in a messy layout',
  [
    { name: 'account', x: 0, y: 0, cols: ['account_id INT pk', 'account_name VARCHAR', 'industry VARCHAR', 'owner_user_id INT', 'created_at TIMESTAMP'] },
    { name: 'contact', x: 280, y: 40, grain: 'One row per contact', cols: ['contact_id INT pk', 'account_id INT', 'lead_id INT', 'full_name VARCHAR', 'email VARCHAR', 'phone VARCHAR'] },
    { name: 'opportunity', x: 570, y: -20, grain: 'One row per opportunity', cols: ['opportunity_id INT pk', 'account_id INT', 'campaign_id INT', 'owner_user_id INT', 'stage VARCHAR', 'amount DECIMAL', 'close_date DATE'] },
    { name: 'lead', x: 880, y: 60, cols: ['lead_id INT pk', 'campaign_id INT', 'owner_user_id INT', 'source VARCHAR', 'score INT'] },
    { name: 'campaign', x: 30, y: 300, cols: ['campaign_id INT pk', 'campaign_name VARCHAR', 'owner_user_id INT', 'budget DECIMAL'] },
    // 3 px under contact's bottom edge (contact renders 239 px tall).
    { name: 'activity', x: 300, y: 282, cols: ['activity_id INT pk', 'contact_id INT', 'opportunity_id INT', 'user_id INT', 'activity_type VARCHAR', 'occurred_at TIMESTAMP'] },
    { name: 'quote', x: 600, y: 330, cols: ['quote_id INT pk', 'opportunity_id INT', 'product_id INT', 'quoted_amount DECIMAL', 'valid_until DATE'] },
    { name: 'product', x: 890, y: 320, cols: ['product_id INT pk', 'sku VARCHAR nk', 'product_name VARCHAR', 'list_price DECIMAL'] },
    { name: 'sales_order', x: -10, y: 600, cols: ['order_id INT pk', 'quote_id INT', 'account_id INT', 'ordered_at TIMESTAMP', 'order_total DECIMAL'] },
    { name: 'invoice', x: 300, y: 560, cols: ['invoice_id INT pk', 'order_id INT', 'invoice_number VARCHAR nk', 'due_date DATE', 'invoice_total DECIMAL'] },
    { name: 'payment', x: 590, y: 590, cols: ['payment_id INT pk', 'invoice_id INT', 'account_id INT', 'paid_at TIMESTAMP', 'amount DECIMAL'] },
    { name: 'app_user', x: 880, y: 610, cols: ['user_id INT pk', 'user_name VARCHAR', 'email VARCHAR', 'team VARCHAR'] },
  ],
  [
    'contact.account_id > account.account_id',
    'opportunity.account_id > account.account_id',
    'opportunity.owner_user_id > app_user.user_id',
    'lead.campaign_id > campaign.campaign_id',
    'lead.owner_user_id > app_user.user_id',
    'activity.contact_id > contact.contact_id',
    'activity.opportunity_id > opportunity.opportunity_id',
    'activity.user_id > app_user.user_id',
    'campaign.owner_user_id > app_user.user_id',
    'quote.opportunity_id > opportunity.opportunity_id',
    'quote.product_id > product.product_id',
    'sales_order.quote_id > quote.quote_id',
    'sales_order.account_id > account.account_id',
    'invoice.order_id > sales_order.order_id',
    'payment.invoice_id > invoice.invoice_id',
    'payment.account_id > account.account_id',
    'opportunity.campaign_id > campaign.campaign_id',
    'contact.lead_id > lead.lead_id',
  ],
  [{ id: 'tangle-note', text: 'Who owns a payment? Ask finance.', x: 820, y: 500, width: 170, height: 80, color: 'yellow' }],
);

// ---------------------------------------------------------------------------
// showcase — mirror of test/fixtures/dbt-project/.erd-studio/silver/showcase.json
// ---------------------------------------------------------------------------

const showcase = subjectArea(
  'showcase',
  'Project task management — tracks projects, tasks, events, and customers',
  [
    { name: 'dim_customer', x: 40, y: 60, grain: 'One row per customer', cols: ['customer_key INT pk', 'customer_id VARCHAR', 'customer_name VARCHAR', 'email VARCHAR'] },
    { name: 'dim_project', x: 980, y: 60, grain: 'One row per project', cols: ['project_key INT pk', 'project_code VARCHAR', 'project_name VARCHAR', 'parent_project_key INT'] },
    { name: 'fct_order', x: 500, y: 250, cols: ['order_id INT pk nk', 'customer_key INT', 'order_date DATE', 'project_key INT', 'amount DECIMAL'] },
    { name: 'dim_date', x: 40, y: 520, grain: 'One row per calendar date', cols: ['date_key INT pk', 'calendar_date DATE', 'fiscal_year INT', 'fiscal_quarter VARCHAR'] },
    { name: 'dim_task', x: 1026, y: 586, grain: 'One row per task version', cols: ['task_key INT pk', 'task_id VARCHAR', 'project_key INT', 'name VARCHAR', 'status STRING'] },
    { name: 'fct_task_event', x: 438, y: 544, grain: 'One row per task event', cols: ['event_id INT pk', 'task_key INT', 'project_key INT', 'customer_key INT', 'event_date DATE', 'event_type VARCHAR', 'amount DECIMAL', 'duration_hours DECIMAL'] },
  ],
  [
    'fct_task_event.task_key > dim_task.task_key',
    'dim_task.project_key > dim_project.project_key',
    'fct_task_event.project_key > dim_project.project_key',
    'dim_project.parent_project_key > dim_project.project_key',
    'fct_order.project_key > dim_project.project_key',
    'fct_task_event.customer_key > dim_customer.customer_key',
    'fct_order.customer_key > dim_customer.customer_key',
  ],
);

// ---------------------------------------------------------------------------
// big — 40 cards / 60 lines, deterministic
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BIG_NOUNS = [
  'customer', 'account', 'product', 'store', 'region', 'supplier', 'warehouse', 'employee',
  'department', 'project', 'task', 'contract', 'invoice', 'payment', 'shipment', 'carrier',
  'route', 'vehicle', 'driver', 'asset', 'site', 'equipment', 'work_order', 'inspection',
  'defect', 'material', 'vendor', 'purchase_order', 'receipt', 'budget', 'cost_centre', 'ledger',
  'currency', 'calendar', 'channel', 'campaign', 'promotion', 'segment', 'territory', 'policy',
];
const BIG_FACTS = new Set(['invoice', 'payment', 'shipment', 'work_order', 'inspection', 'defect', 'purchase_order', 'receipt', 'ledger', 'task', 'contract', 'budget', 'promotion']);
const BIG_ATTRS = ['name VARCHAR', 'code VARCHAR', 'status VARCHAR', 'created_at TIMESTAMP', 'updated_at TIMESTAMP', 'amount DECIMAL', 'is_active BOOLEAN', 'description VARCHAR'];

function buildBig(): DisplaySubjectArea {
  const rand = mulberry32(20261107);
  const cols = 8;
  const rows = 5;
  const tables: (TableSpec & { links: string[] })[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const noun = BIG_NOUNS[i];
      tables.push({
        name: `${BIG_FACTS.has(noun) ? 'fct' : 'dim'}_${noun}`,
        x: Math.round(c * 360 + (rand() - 0.5) * 80),
        y: Math.round(r * 320 + (rand() - 0.5) * 80),
        cols: [`${noun}_key INT pk`],
        links: [],
      });
    }
  }
  const linkSpecs: string[] = [];
  const seen = new Set<string>();
  let guard = 0;
  while (linkSpecs.length < 60 && guard++ < 5000) {
    const i = Math.floor(rand() * tables.length);
    const ri = Math.floor(i / cols);
    const ci = i % cols;
    let j: number;
    if (rand() < 0.2) {
      j = Math.floor(rand() * tables.length); // long range
    } else {
      const dr = Math.floor(rand() * 5) - 2;
      const dc = Math.floor(rand() * 5) - 2;
      const r2 = ri + dr;
      const c2 = ci + dc;
      if (r2 < 0 || r2 >= rows || c2 < 0 || c2 >= cols) continue;
      j = r2 * cols + c2;
    }
    if (j === i) continue;
    const key = `${i}>${j}`;
    if (seen.has(key) || seen.has(`${j}>${i}`)) continue;
    seen.add(key);
    const from = tables[i];
    const to = tables[j];
    const targetNoun = BIG_NOUNS[j];
    const fkName = `${targetNoun}_key`;
    if (!from.cols.some((c) => c.startsWith(`${fkName} `))) from.cols.push(`${fkName} INT`);
    linkSpecs.push(`${from.name}.${fkName} > ${to.name}.${targetNoun}_key`);
  }
  for (const [i, t] of tables.entries()) {
    const extra = 2 + (i % 3);
    for (let k = 0; k < extra; k++) {
      const attr = BIG_ATTRS[(i + k) % BIG_ATTRS.length];
      t.cols.push(`${BIG_NOUNS[i]}_${attr}`);
    }
  }
  return subjectArea('big', '40 cards, 60 lines', tables, linkSpecs);
}

const big = buildBig();

// ---------------------------------------------------------------------------
// overlap — cards on top of and in the way of each other
// ---------------------------------------------------------------------------

const overlap = subjectArea(
  'overlap',
  'Overlapping cards, cards in the way, a column of cards linked past itself',
  [
    // Two overlapping cards; fct_order → dim_customer runs under the address card.
    { name: 'dim_customer', x: 0, y: 0, grain: 'One row per customer', cols: ['customer_key INT pk', 'customer_name VARCHAR', 'email VARCHAR', 'segment VARCHAR'] },
    { name: 'dim_customer_address', x: 150, y: 80, grain: 'One row per address', cols: ['address_key INT pk', 'customer_key INT', 'line_1 VARCHAR', 'postcode_key INT', 'is_billing BOOLEAN'] },
    { name: 'fct_order', x: 720, y: 0, grain: 'One row per order', cols: ['order_key INT pk', 'customer_key INT', 'employee_key INT', 'order_date DATE', 'order_total DECIMAL'] },
    // A card between two related cards, and two cards 6 px apart (dim_carrier renders 150 px tall).
    { name: 'fct_shipment', x: 0, y: 440, grain: 'One row per shipment', cols: ['shipment_key INT pk', 'order_key INT', 'carrier_key INT', 'ship_mode_key INT', 'service_level_key INT', 'shipped_at TIMESTAMP', 'weight_kg DECIMAL'] },
    { name: 'dim_ship_mode', x: 440, y: 440, cols: ['ship_mode_key INT pk', 'ship_mode_name VARCHAR', 'is_express BOOLEAN'] },
    { name: 'dim_carrier', x: 860, y: 420, cols: ['carrier_key INT pk', 'carrier_name VARCHAR', 'scac_code VARCHAR nk', 'country_code VARCHAR'] },
    { name: 'dim_service_level', x: 860, y: 576, cols: ['service_level_key INT pk', 'service_level_name VARCHAR', 'sla_hours INT'] },
    // A column linked past itself: postcode → country skips city and state.
    { name: 'dim_geo_country', x: 1400, y: 0, cols: ['country_key INT pk', 'country_code VARCHAR nk', 'country_name VARCHAR'] },
    { name: 'dim_geo_state', x: 1400, y: 250, cols: ['state_key INT pk', 'country_key INT', 'state_code VARCHAR', 'state_name VARCHAR'] },
    { name: 'dim_geo_city', x: 1400, y: 520, cols: ['city_key INT pk', 'state_key INT', 'country_key INT', 'city_name VARCHAR'] },
    { name: 'dim_geo_postcode', x: 1400, y: 790, cols: ['postcode_key INT pk', 'city_key INT', 'country_key INT', 'postcode VARCHAR nk'] },
    // A self-loop (manager), next to the order fact.
    { name: 'dim_employee', x: 720, y: 880, grain: 'One row per employee', cols: ['employee_key INT pk', 'manager_employee_key INT', 'full_name VARCHAR', 'role_title VARCHAR'] },
  ],
  [
    'dim_customer_address.customer_key > dim_customer.customer_key',
    'dim_customer_address.postcode_key > dim_geo_postcode.postcode_key',
    'fct_order.customer_key > dim_customer.customer_key',
    'fct_order.employee_key > dim_employee.employee_key',
    'fct_shipment.order_key > fct_order.order_key',
    'fct_shipment.carrier_key > dim_carrier.carrier_key',
    'fct_shipment.ship_mode_key > dim_ship_mode.ship_mode_key',
    'fct_shipment.service_level_key > dim_service_level.service_level_key',
    'dim_geo_state.country_key > dim_geo_country.country_key',
    'dim_geo_city.state_key > dim_geo_state.state_key',
    'dim_geo_city.country_key > dim_geo_country.country_key',
    'dim_geo_postcode.city_key > dim_geo_city.city_key',
    'dim_geo_postcode.country_key > dim_geo_country.country_key',
    'dim_employee.manager_employee_key > dim_employee.employee_key manager',
  ],
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const SCENARIOS: Record<ScenarioName, DisplaySubjectArea> = { under, star, tangle, showcase, big, overlap };

export function isScenarioName(name: string): name is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(name);
}

export function scenario(name: string): DisplaySubjectArea {
  if (!isScenarioName(name)) throw new Error(`scenarios: unknown scenario "${name}" (one of ${SCENARIO_NAMES.join(', ')})`);
  return SCENARIOS[name];
}

/** Default size of a sticky note when the annotation gives none (AnnotationNode min size, roughly). */
const ANNOTATION_SIZE = { width: 200, height: 100 };

/**
 * The routing input the canvas would build for a scenario: card boxes as the
 * browser rendered them (measured-sizes.json, measured once in a browser),
 * else the renderer's own size estimate (columns expanded below the
 * auto-collapse threshold, as `<ErdCanvas>` does); today's handle sides and
 * slots, picked from those sizes.
 */
export function scenarioRoutingInput(name: string): RoutingInput {
  const domain = scenario(name);
  const expanded = domain.models.length < NODE_THRESHOLD;
  const measured = (MEASURED_SIZES as unknown as Record<string, Record<string, [number, number]>>)[name] ?? {};
  const nodeDimensions = new Map(Object.entries(measured).map(([id, [width, height]]) => [id, { width, height }]));
  const { nodes, edges } = transformSubjectArea(domain, { isExpanded: () => expanded, nodeDimensions });
  const lookup = new Map<string, InternalNode<Node>>();
  for (const node of nodes) {
    let size: { width: number; height: number };
    const known = nodeDimensions.get(node.id);
    if (known) {
      size = known;
    } else if (node.type === 'annotation') {
      const ann = domain.viewConfig.annotations?.find((a) => `annotation-${a.id}` === node.id);
      size = { width: ann?.width ?? ANNOTATION_SIZE.width, height: ann?.height ?? ANNOTATION_SIZE.height };
    } else {
      const table = node as TableFlowNode;
      size = resolveNodeDimensions({ data: { ...table.data, isExpanded: expanded }, measured: undefined });
    }
    lookup.set(node.id, {
      ...node,
      measured: size,
      internals: { positionAbsolute: node.position, z: 0, userNode: node },
    } as unknown as InternalNode<Node>);
  }
  return buildRoutingInput(lookup, edges as never);
}

/**
 * Z-shaped routes between each line's stubs (its pushed-out anchors) that
 * ignore the cards, as the smooth-step fallback does: lines that pass under
 * cards, for the x-ray and renderer tests.
 */
export function zRoutesOf(input: RoutingInput): Map<string, RoutedLine> {
  const out = new Map<string, RoutedLine>();
  for (const e of input.edges) {
    if (e.isSelfLoop) continue;
    const a = pushOut(e.sourceAnchor, e.sourceAnchor.side, PATH_GAP);
    const b = pushOut(e.targetAnchor, e.targetAnchor.side, PATH_GAP);
    const horizontal = e.sourceAnchor.side === 'left' || e.sourceAnchor.side === 'right';
    const points = horizontal
      ? [a, { x: (a.x + b.x) / 2, y: a.y }, { x: (a.x + b.x) / 2, y: b.y }, b]
      : [a, { x: a.x, y: (a.y + b.y) / 2 }, { x: b.x, y: (a.y + b.y) / 2 }, b];
    out.set(e.id, { sourceAnchor: e.sourceAnchor, targetAnchor: e.targetAnchor, points });
  }
  return out;
}

/** A router that draws `zRoutesOf`: lines straight through the cards. */
export const zRouter: LineRouter = { route: (input) => ({ lines: zRoutesOf(input) }), reset: () => {} };
