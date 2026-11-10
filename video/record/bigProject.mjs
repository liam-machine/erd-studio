#!/usr/bin/env node
// Writes a large, realistic ERD Studio 2.0 project (native DBML storage, logical only: no
// dbt_project.yml) with ONE diagram of about 2,000 tables and 2,700 relationships, every table
// positioned, for the videos' scale scene (open/fit the diagram, lines route in the background,
// zoom into an area, hover a table for the flowing arrows).
//
//   node video/record/bigProject.mjs <outDir> [--tables 2000] [--seed 7] [--aspect 16:9 | --fit 1390x475]
//
// Deterministic: the same arguments write the same bytes. Writes only <outDir>/.erd-studio
// (replaced if it exists). The tree is the 2.0 layer-first layout (docs/semantic-domain-json-
// reference.md, "DBML project"), one layer `gold`:
//   .erd-studio/README.md, layers.json
//   gold/tables/<schema>/<name>.dbml        one Table <schema>.<name> each, a schema per business domain
//   gold/relationships/<schema>.dbml        the Refs whose foreign-key table is in that schema
//   gold/diagrams/enterprise_warehouse.dbml every table's use line, every relationships file's
//                                           use *, and the positions in the Project's erd_layout
// A warehouse of ~20 business domains (sales, finance, hr, supply_chain, ...) around a shared
// block of conformed dimensions (dim_date, dim_customer, ...): per domain a few star clusters
// (dimensions with snowflaked outriggers, transaction facts, snapshots, aggregates, bridges),
// laid out left to right [outriggers][dimensions][facts][snapshots + aggregates], clusters in a
// grid, domains in a grid with the conformed block in the middle.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAYER = 'gold';
export const DIAGRAM = 'enterprise_warehouse';
/** The canvas's least zoom (minZoom in packages/renderer/src/ErdCanvas.tsx and webview/App.tsx). */
export const MIN_ZOOM = 0.05;

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

/** The conformed dimensions every domain may point at (schema `shared`). `out` = outriggers. */
const SHARED = {
  schema: 'shared',
  dims: [
    { e: 'date', out: [] },
    { e: 'customer', out: ['segment', 'type', 'status'] },
    { e: 'product', out: ['category', 'subcategory', 'brand'] },
    { e: 'employee', out: ['grade', 'status'] },
    { e: 'currency', out: [] },
    { e: 'geography', out: ['country', 'region', 'state'] },
    { e: 'organisation_unit', out: ['type', 'hierarchy'] },
    { e: 'supplier', out: ['category', 'status'] },
    { e: 'channel', out: ['type'] },
    { e: 'business_unit', out: ['group'] },
    { e: 'unit_of_measure', out: ['class'] },
  ],
};
const CONFORMED = new Set(SHARED.dims.map((d) => d.e));

/** Business domains: entities (domain dimensions) and processes (facts). */
const DOMAINS = [
  { schema: 'sales', conf: ['customer', 'product', 'employee', 'channel', 'currency'],
    entities: ['sales_rep', 'sales_territory', 'price_list', 'promotion', 'quote', 'store', 'order_type', 'payment_term', 'sales_team', 'opportunity_stage', 'contract', 'sales_region', 'distributor', 'discount_scheme'],
    processes: ['order_line', 'invoice_line', 'return_line', 'quote_line', 'shipment_line', 'sales_target', 'commission', 'price_change', 'opportunity', 'pos_transaction', 'credit_note', 'backorder'] },
  { schema: 'finance', conf: ['currency', 'organisation_unit', 'business_unit', 'supplier'],
    entities: ['gl_account', 'cost_centre', 'profit_centre', 'legal_entity', 'fiscal_period', 'journal_type', 'ledger', 'budget_version', 'tax_code', 'bank_account', 'company_code', 'account_group', 'intercompany_partner', 'asset_class'],
    processes: ['journal_line', 'ap_invoice', 'ar_invoice', 'payment', 'budget_line', 'forecast_line', 'asset_depreciation', 'bank_statement_line', 'tax_line', 'accrual', 'cost_allocation', 'cash_receipt'] },
  { schema: 'hr', conf: ['employee', 'organisation_unit', 'geography'],
    entities: ['position', 'job_family', 'department', 'pay_grade', 'leave_type', 'contract_type', 'work_location', 'skill', 'training_course', 'benefit_plan', 'union_agreement', 'shift_pattern', 'recruiter', 'cost_allocation_rule'],
    processes: ['payroll_line', 'leave_request', 'timesheet_entry', 'hire', 'termination', 'performance_review', 'training_enrolment', 'headcount', 'overtime', 'benefit_enrolment', 'job_application', 'absence'] },
  { schema: 'supply_chain', conf: ['product', 'supplier', 'unit_of_measure', 'geography'],
    entities: ['warehouse', 'bin_location', 'item_batch', 'inventory_status', 'demand_plan', 'replenishment_rule', 'safety_stock_policy', 'supply_route', 'distribution_centre', 'lead_time_class', 'stock_category', 'planning_group', 'forecast_model', 'storage_zone'],
    processes: ['inventory_movement', 'stock_count', 'replenishment_order', 'demand_forecast', 'goods_receipt', 'transfer_order', 'stock_adjustment', 'cycle_count', 'inventory_valuation', 'pick_task', 'putaway_task', 'stock_reservation'] },
  { schema: 'marketing', conf: ['customer', 'product', 'channel'],
    entities: ['campaign', 'audience_segment', 'marketing_channel', 'creative', 'landing_page', 'utm_source', 'ad_group', 'keyword', 'email_template', 'offer', 'loyalty_tier', 'survey', 'brand', 'content_asset'],
    processes: ['campaign_response', 'ad_impression', 'ad_click', 'email_send', 'email_open', 'web_session', 'page_view', 'lead', 'conversion', 'survey_response', 'loyalty_points', 'social_engagement'] },
  { schema: 'customer', conf: ['customer', 'geography', 'employee', 'channel'],
    entities: ['customer_account', 'contact', 'household', 'account_status', 'interaction_type', 'case_category', 'service_agent', 'contact_preference', 'consent_type', 'complaint_reason', 'lifecycle_stage', 'postal_address', 'membership', 'service_queue'],
    processes: ['service_case', 'interaction', 'complaint', 'nps_response', 'account_change', 'consent_change', 'churn_event', 'inbound_call', 'chat_session', 'customer_visit', 'feedback', 'subscription'] },
  { schema: 'product', conf: ['product', 'supplier', 'unit_of_measure'],
    entities: ['product_line', 'brand_family', 'product_attribute', 'variant', 'bill_of_materials', 'packaging', 'product_lifecycle', 'colour', 'size_range', 'material', 'product_hierarchy', 'certification', 'sku', 'style'],
    processes: ['price_history', 'product_launch', 'product_review', 'product_change', 'cost_rollup', 'assortment', 'catalogue_listing', 'product_return', 'spec_change', 'warranty_claim', 'recall', 'listing_change'] },
  { schema: 'logistics', conf: ['geography', 'customer', 'supplier'],
    entities: ['carrier', 'route', 'vehicle', 'driver', 'depot', 'delivery_zone', 'freight_class', 'shipment_mode', 'incoterm', 'port', 'container_type', 'service_level', 'toll_zone', 'fuel_type'],
    processes: ['shipment', 'delivery_stop', 'freight_invoice', 'vehicle_trip', 'fuel_purchase', 'delivery_exception', 'proof_of_delivery', 'container_movement', 'customs_declaration', 'route_plan', 'driver_shift', 'carrier_rate'] },
  { schema: 'procurement', conf: ['supplier', 'product', 'employee', 'currency'],
    entities: ['vendor_site', 'purchasing_group', 'purchase_category', 'contract_agreement', 'buyer', 'approval_level', 'sourcing_event', 'catalogue_item', 'payment_method', 'vendor_rating', 'requisition_type', 'spend_category', 'delivery_term', 'procurement_plant'],
    processes: ['purchase_order_line', 'requisition_line', 'vendor_invoice', 'receipt_line', 'rfq_response', 'contract_release', 'spend', 'vendor_evaluation', 'purchase_approval', 'catalogue_order', 'vendor_onboarding', 'price_agreement'] },
  { schema: 'manufacturing', conf: ['product', 'employee', 'unit_of_measure'],
    entities: ['plant', 'work_centre', 'machine', 'production_line', 'routing', 'operation', 'shift', 'downtime_reason', 'scrap_reason', 'quality_check', 'tool', 'maintenance_plan', 'batch_recipe', 'production_version'],
    processes: ['production_order', 'operation_confirmation', 'machine_downtime', 'scrap', 'quality_inspection', 'maintenance_order', 'energy_reading', 'material_consumption', 'batch_yield', 'oee_measurement', 'tool_usage', 'sensor_reading'] },
  { schema: 'projects', conf: ['employee', 'supplier', 'geography', 'business_unit'],
    entities: ['project', 'wbs_element', 'contract_package', 'subcontractor', 'site', 'cost_code', 'project_risk', 'milestone', 'change_order_type', 'discipline', 'crew', 'equipment', 'permit', 'project_phase'],
    processes: ['project_cost', 'progress_claim', 'change_order', 'labour_hours', 'equipment_usage', 'site_inspection', 'risk_review', 'milestone_completion', 'variation', 'daily_site_report', 'material_delivery', 'earned_value'] },
  { schema: 'it_service', conf: ['employee', 'organisation_unit'],
    entities: ['application', 'server', 'service_desk_group', 'incident_category', 'priority', 'change_type', 'configuration_item', 'sla', 'software_licence', 'it_asset', 'environment', 'release', 'knowledge_article', 'support_tier'],
    processes: ['incident', 'service_request', 'change_request', 'problem', 'outage', 'licence_assignment', 'deployment', 'alert', 'asset_assignment', 'backup_job', 'access_request', 'sla_breach'] },
  { schema: 'ecommerce', conf: ['customer', 'product', 'channel', 'currency'],
    entities: ['web_store', 'cart', 'payment_provider', 'shipping_option', 'device_type', 'browser', 'coupon', 'wishlist', 'search_term', 'marketplace', 'fulfilment_method', 'return_reason', 'gift_card', 'review_rating'],
    processes: ['checkout', 'cart_event', 'payment_authorisation', 'refund', 'site_search', 'product_view', 'wishlist_add', 'coupon_redemption', 'gift_card_transaction', 'marketplace_order', 'abandoned_cart', 'delivery_slot_booking'] },
  { schema: 'risk', conf: ['organisation_unit', 'employee', 'geography'],
    entities: ['control', 'policy', 'regulation', 'audit_area', 'risk_category', 'finding_severity', 'compliance_owner', 'assessment_type', 'incident_type', 'mitigation', 'key_risk_indicator', 'jurisdiction', 'auditor', 'attestation_cycle'],
    processes: ['control_test', 'audit_finding', 'compliance_breach', 'policy_attestation', 'kri_measurement', 'regulatory_filing', 'remediation_action', 'loss_event', 'exception_request', 'sanction_screening', 'aml_alert', 'privacy_request'] },
  { schema: 'treasury', conf: ['currency', 'business_unit'],
    entities: ['counterparty', 'instrument', 'trading_book', 'portfolio', 'interest_rate_index', 'fx_rate_type', 'credit_rating', 'facility', 'collateral_type', 'settlement_instruction', 'broker', 'hedge_relationship', 'exposure_type', 'maturity_bucket'],
    processes: ['trade', 'cash_position', 'fx_deal', 'loan_drawdown', 'interest_accrual', 'collateral_movement', 'settlement', 'hedge_effectiveness', 'liquidity_forecast', 'covenant_test', 'rate_fixing', 'investment_valuation'] },
  { schema: 'property', conf: ['geography', 'organisation_unit', 'supplier'],
    entities: ['building', 'floor', 'room', 'lease', 'landlord', 'asset_category', 'space_type', 'maintenance_contractor', 'utility_meter', 'cleaning_zone', 'access_point', 'parking_bay', 'work_request_type', 'property_portfolio'],
    processes: ['work_order', 'lease_payment', 'utility_consumption', 'space_booking', 'access_event', 'cleaning_task', 'asset_inspection', 'energy_bill', 'occupancy', 'rent_review', 'parking_allocation', 'planned_maintenance'] },
  { schema: 'safety', conf: ['employee', 'geography', 'organisation_unit'],
    entities: ['hazard', 'injury_type', 'body_part', 'ppe_item', 'observation_type', 'permit_type', 'safety_training', 'contractor_company', 'risk_rating', 'investigation_status', 'corrective_action_type', 'safety_zone', 'emergency_plan', 'inspection_template'],
    processes: ['injury_report', 'near_miss', 'safety_observation', 'ppe_issue', 'permit_to_work', 'safety_audit', 'corrective_action', 'toolbox_talk', 'lost_time_injury', 'hazard_report', 'emergency_drill', 'fatigue_check'] },
  { schema: 'energy', conf: ['geography', 'customer'],
    entities: ['meter', 'tariff', 'substation', 'feeder', 'network_asset', 'service_point', 'generation_unit', 'outage_cause', 'meter_reader', 'rate_plan', 'connection_type', 'weather_station', 'energy_retailer', 'network_region'],
    processes: ['meter_reading', 'outage_event', 'generation_output', 'consumption_interval', 'network_fault', 'connection_request', 'tariff_change', 'demand_response', 'solar_export', 'weather_observation', 'asset_failure', 'billing_cycle'] },
  { schema: 'billing', conf: ['customer', 'product', 'currency'],
    entities: ['billing_account', 'plan', 'plan_feature', 'invoice_template', 'dunning_level', 'payment_gateway', 'usage_type', 'discount_code', 'tax_jurisdiction', 'billing_frequency', 'credit_reason', 'add_on', 'price_tier', 'revenue_schedule'],
    processes: ['billing_invoice_line', 'usage_record', 'subscription_change', 'payment_attempt', 'dunning_notice', 'credit_memo', 'revenue_recognition', 'plan_upgrade', 'add_on_purchase', 'refund_request', 'trial_conversion', 'mrr_movement'] },
  { schema: 'digital', conf: ['customer', 'channel'],
    entities: ['app_screen', 'feature_flag', 'experiment', 'experiment_variant', 'app_version', 'platform', 'notification_type', 'user_cohort', 'event_type', 'referral_source', 'onboarding_step', 'api_client', 'session_type', 'error_type'],
    processes: ['app_event', 'experiment_exposure', 'push_notification', 'api_call', 'onboarding_progress', 'feature_usage', 'crash_report', 'in_app_purchase', 'referral', 'daily_active_user', 'notification_click', 'app_session'] },
  { schema: 'claims', conf: ['customer', 'product', 'employee', 'geography'],
    entities: ['policy_holder', 'insurance_policy', 'coverage', 'claim_type', 'loss_cause', 'adjuster', 'repairer', 'claim_status', 'peril', 'excess_option', 'underwriter', 'policy_term', 'risk_address', 'reinsurer'],
    processes: ['claim', 'claim_payment', 'claim_reserve', 'premium', 'policy_endorsement', 'quote_request', 'renewal', 'fraud_referral', 'recovery', 'assessment', 'cancellation', 'reinsurance_recovery'] },
  { schema: 'field_service', conf: ['customer', 'employee', 'product', 'geography'],
    entities: ['technician', 'service_territory', 'work_type', 'installed_asset', 'service_contract', 'skill_level', 'spare_part', 'service_van', 'appointment_window', 'failure_code', 'resolution_code', 'dispatch_zone', 'entitlement', 'checklist'],
    processes: ['service_appointment', 'job_completion', 'parts_usage', 'travel_log', 'first_time_fix', 'service_visit', 'asset_reading', 'job_dispatch', 'customer_signoff', 'van_stock_count', 'preventive_job', 'callback'] },
];
/** Region copies of the domains, used only when --tables asks for more than the domains hold. */
const REGIONS = ['emea', 'apac', 'amer', 'latam', 'anz', 'nordics', 'dach', 'benelux'];

const OUTRIGGER_SUFFIXES = ['type', 'category', 'status', 'group', 'class', 'tier', 'hierarchy', 'segment'];
const DIM_ATTRS = [
  ['description', '"VARCHAR(255)"'], ['status_code', '"VARCHAR(10)"'], ['is_active', 'BOOLEAN'],
  ['effective_date', 'DATE'], ['source_system', '"VARCHAR(30)"'], ['owner_name', '"VARCHAR(100)"'],
  ['sort_order', 'INT'], ['country_code', '"CHAR(2)"'], ['created_at', 'TIMESTAMP'], ['external_ref', '"VARCHAR(50)"'],
];
const MEASURES = [
  ['amount', '"DECIMAL(18,2)"', 'additive'], ['quantity', '"DECIMAL(18,4)"', 'additive'],
  ['unit_price', '"DECIMAL(18,4)"', 'non-additive'], ['cost_amount', '"DECIMAL(18,2)"', 'additive'],
  ['discount_amount', '"DECIMAL(18,2)"', 'additive'], ['tax_amount', '"DECIMAL(18,2)"', 'additive'],
  ['net_amount', '"DECIMAL(18,2)"', 'additive'], ['duration_minutes', 'INT', 'additive'],
  ['hours', '"DECIMAL(9,2)"', 'additive'], ['weight_kg', '"DECIMAL(12,3)"', 'additive'],
  ['score', '"DECIMAL(5,2)"', 'non-additive'], ['line_count', 'INT', 'additive'],
];
const SNAPSHOT_MEASURES = [
  ['balance_amount', '"DECIMAL(18,2)"', 'semi-additive'], ['open_count', 'INT', 'semi-additive'],
  ['on_hand_quantity', '"DECIMAL(18,4)"', 'semi-additive'], ['days_open', 'INT', 'non-additive'],
];

// Tuning: about 1.35 relationships per table (the 2,700 / 2,000 of the performance claim).
const KNOBS = {
  groupsPerDomain: 3,
  outriggersPerDim: [1, 2, 2, 3], // picked per dimension
  factDims: [2, 3, 3, 4],         // domain dimensions per transaction fact
  factOtherGroup: 0.3,            // chance of one more dimension from another cluster of the domain
  factConformed: 0.4,            // chance of a conformed dimension
  factDate: 0.25,                 // chance of a Ref to shared.dim_date
  snapshotDims: [1, 1, 2],
  aggDims: [0, 1, 1, 2],
  bridgesPerGroup: 3,
};

// ---------------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------------

function rng(seed) {
  let s = (seed >>> 0) % 2147483647 || 1;
  const next = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return {
    next,
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
    sample(list, k) {
      const copy = [...list];
      const out = [];
      while (out.length < k && copy.length) out.push(copy.splice(Math.floor(next() * copy.length), 1)[0]);
      return out;
    },
  };
}

const words = (s) => s.replace(/_/g, ' ');

/** Every domain (and region copy) a project may use, in order. */
const DOMAIN_SPECS = [];
for (let round = 0; round <= REGIONS.length; round++) for (const d of DOMAINS) DOMAIN_SPECS.push({ ...d, round });

/** The conformed block and the first `domainCount` domains, every table. */
function generatePool(seed, domainCount) {
  const r = rng(seed);
  const rb = rng(seed * 31 + 17);
  const taken = new Set();
  const all = [];

  const uniqueName = (base, schema) => {
    let name = base;
    if (taken.has(name.toLowerCase())) name = base.replace(/^([a-z]+)_/, `$1_${schema}_`);
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}_${i}`;
    taken.add(name.toLowerCase());
    return name;
  };
  const add = (t) => { all.push(t); return t; };
  const col = (name, type, extra = {}) => ({ name, type, ...extra });
  const ref = (t, column, to, toColumn, name) => t.refs.push({ column, to, toColumn, ...(name ? { name } : {}) });

  /** A dimension (+ its outriggers) in `schema`, cluster `group`. Returns the dimension. */
  const makeDim = (e, schema, domain, group, outSuffixes, role, suffix = '') => {
    const name = uniqueName(`dim_${e}${suffix}`, schema);
    const key = `${e}_key`;
    const dim = add({ name, schema, domain, group, kind: 'dim', role, key, refs: [],
      grain: e === 'date' ? 'One row per calendar day' : `One row per ${words(e)} version`, columns: [] });
    dim.columns.push(col(key, 'INT', { pk: true, note: 'Surrogate key' }));
    if (e === 'date') {
      dim.columns.push(col('calendar_date', 'DATE', { nk: true }), col('day_of_week', '"VARCHAR(10)"'),
        col('week_of_year', 'INT'), col('month_name', '"VARCHAR(10)"'), col('quarter', 'INT'), col('year', 'INT'),
        col('fiscal_period', '"VARCHAR(7)"'), col('is_business_day', 'BOOLEAN'));
      return dim;
    }
    dim.columns.push(col(`${e}_id`, '"VARCHAR(20)"', { nk: true }));
    for (const s of outSuffixes) {
      const o = add({ name: uniqueName(`dim_${e}_${s}${suffix}`, schema), schema, domain, group, kind: 'outrigger', role: 'reference',
        key: `${e}_${s}_key`, parent: dim, refs: [], grain: `One row per ${words(e)} ${s}`, columns: [] });
      o.columns.push(col(o.key, 'INT', { pk: true }), col(`${e}_${s}_code`, '"VARCHAR(20)"', { nk: true }),
        col(`${e}_${s}_name`, '"VARCHAR(100)"'), col('description', '"VARCHAR(255)"'));
      dim.columns.push(col(o.key, 'INT', { fk: true }));
      ref(dim, o.key, o, o.key);
    }
    dim.columns.push(col(`${e}_name`, '"VARCHAR(100)"', { scd: '1' }));
    for (const [n, t] of r.sample(DIM_ATTRS, 2 + Math.floor(r.next() * 3))) dim.columns.push(col(n, t));
    dim.columns.push(col('valid_from', 'DATE', { scd: '2' }), col('valid_to', 'DATE'), col('is_current', 'BOOLEAN'));
    return dim;
  };

  // The conformed block.
  const shared = new Map();
  for (const { e, out } of SHARED.dims) shared.set(e, makeDim(e, SHARED.schema, 0, 0, out, 'conformed-dim'));

  /** Facts and friends reference dimensions; a FK column per reference. */
  const fkTo = (t, dim, colName = dim.key, refName) => {
    if (t.columns.some((c) => c.name === colName)) return;
    t.columns.push(col(colName, dim.key === 'date_key' ? 'INT' : 'INT', { fk: true }));
    ref(t, colName, dim, dim.key, refName);
  };
  const firstWord = (p) => p.split('_')[0];

  let domainNo = 0;
  for (const spec of DOMAIN_SPECS.slice(0, domainCount)) {
    domainNo++;
    const region = spec.round ? REGIONS[spec.round - 1] : '';
    const suffix = region ? `_${region}` : '';
    const schema = spec.schema + suffix;
    const G = KNOBS.groupsPerDomain;
    const ents = spec.entities;
    const procs = spec.processes;
    const groupDims = Array.from({ length: G }, () => []);
    ents.forEach((e, i) => {
      const g = Math.floor((i * G) / ents.length);
      // No `dim_order_type_type`: a suffix the entity already ends with is skipped.
      const outs = r.sample(OUTRIGGER_SUFFIXES.filter((s) => !e.split('_').includes(s)), r.pick(KNOBS.outriggersPerDim));
      groupDims[g].push(makeDim(e, schema, domainNo, g, outs, 'domain-dim', suffix));
    });
    procs.forEach((p, i) => {
      const g = Math.floor((i * G) / procs.length);
      const local = groupDims[g];
      const pw = words(p);
      const fct = add({ name: uniqueName(`fct_${p}${suffix}`, schema), schema, domain: domainNo, group: g, kind: 'fact',
        role: 'transaction-fact', grain: `One row per ${pw}`, refs: [], columns: [] });
      fct.columns.push(col(`${p}_key`, 'BIGINT', { pk: true }));
      for (const dim of r.sample(local, r.pick(KNOBS.factDims))) fkTo(fct, dim);
      if (G > 1 && r.chance(KNOBS.factOtherGroup)) {
        const other = groupDims[(g + 1 + Math.floor(r.next() * (G - 1))) % G];
        fkTo(fct, r.pick(other));
      }
      if (r.chance(KNOBS.factConformed)) fkTo(fct, shared.get(r.pick(spec.conf)));
      const dateName = `${firstWord(p)}_date_key`;
      if (r.chance(KNOBS.factDate)) fkTo(fct, shared.get('date'), dateName);
      else fct.columns.push(col(`${firstWord(p)}_date`, 'DATE'));
      fct.columns.push(col(`${p}_number`, '"VARCHAR(30)"', { nk: true }));
      for (const [n, t, a] of r.sample(MEASURES, 2 + Math.floor(r.next() * 3))) fct.columns.push(col(n, t, { additive: a }));
      fct.columns.push(col('loaded_at', 'TIMESTAMP'));

      // A periodic snapshot or an accumulating one, and one or two aggregates.
      const periodic = r.chance(0.6);
      const snap = add({ name: uniqueName(periodic ? `fct_${p}_snapshot${suffix}` : `fct_${p}_lifecycle${suffix}`, schema),
        schema, domain: domainNo, group: g, kind: 'snapshot', role: periodic ? 'periodic-snapshot' : 'accumulating-snapshot',
        grain: periodic ? `One row per open ${pw} per day` : `One row per ${pw}, updated at each milestone`, refs: [], columns: [] });
      snap.columns.push(col('snapshot_date', 'DATE', { pk: true }), col(`${p}_key`, 'BIGINT', { pk: true }));
      for (const dim of r.sample(fct.refs.map((x) => x.to).filter((t) => t.kind === 'dim' && t.domain === domainNo), r.pick(KNOBS.snapshotDims))) fkTo(snap, dim);
      for (const [n, t, a] of r.sample(SNAPSHOT_MEASURES, 2)) snap.columns.push(col(n, t, { additive: a }));
      snap.columns.push(col('loaded_at', 'TIMESTAMP'));

      const grains = r.chance(0.5) ? ['monthly', 'weekly'] : ['monthly'];
      for (const period of grains) {
        const agg = add({ name: uniqueName(`agg_${p}_${period}${suffix}`, schema), schema, domain: domainNo, group: g, kind: 'agg',
          role: 'gold-fact', grain: `One row per ${period === 'monthly' ? 'month' : 'week'} and ${words(local[0]?.name.replace(/^dim_/, '') ?? 'segment')}`,
          refs: [], columns: [] });
        agg.columns.push(col(period === 'monthly' ? 'month_start_date' : 'week_start_date', 'DATE', { pk: true }));
        const aggDims = r.sample(fct.refs.map((x) => x.to).filter((t) => t.kind === 'dim' && t.domain === domainNo), r.pick(KNOBS.aggDims));
        for (const dim of aggDims) fkTo(agg, dim);
        for (const [n, t, a] of r.sample(MEASURES.filter((m) => m[2] === 'additive'), 3)) agg.columns.push(col(`total_${n}`, t, { additive: a }));
        agg.columns.push(col(`${firstWord(p)}_count`, 'INT', { additive: 'additive' }));
      }
    });
    groupDims.forEach((dims, g) => {
      const pairs = new Set();
      const bridged = new Set();
      for (let b = 0, tries = 0; b < KNOBS.bridgesPerGroup && dims.length >= 2 && tries < 20; tries++) {
        let [a, c] = r.sample(dims, 2);
        const pair = [a.name, c.name].sort().join('|');
        if (pairs.has(pair)) continue;
        pairs.add(pair);
        // A long bridge name widens its whole column of cards, so a long pair is redrawn, from a
        // second generator: the main one draws exactly as it would anyway, keeping every other table.
        const key = (x, y) => [x.name, y.name].sort().join('|');
        for (let k = 0; k < 12 && (a.key.length + c.key.length > 32 || bridged.has(key(a, c))); k++) {
          const [a2, c2] = rb.sample(dims, 2);
          if (!bridged.has(key(a2, c2))) [a, c] = [a2, c2];
        }
        if (bridged.has(key(a, c))) { b++; continue; }
        bridged.add(key(a, c));
        b++;
        const ea = a.key.replace(/_key$/, '');
        const ec = c.key.replace(/_key$/, '');
        const br = add({ name: uniqueName(`bridge_${ea}_${ec}${suffix}`, schema), schema, domain: domainNo, group: g, kind: 'bridge',
          role: 'factless-fact', grain: `One row per ${words(ea)} and ${words(ec)}`, refs: [], columns: [] });
        fkTo(br, a); fkTo(br, c);
        br.columns.push(col('weighting_factor', '"DECIMAL(9,6)"', { additive: 'non-additive' }), col('valid_from', 'DATE'), col('valid_to', 'DATE'));
      }
    });
  }
  return all;
}

/** Builds the tables and relationships (no layout). Each table: { name, schema, kind, refs, ... }. */
export function buildModel({ tables: target = 2000, seed = 7 } = {}) {
  if (!Number.isInteger(target) || target < 40) throw new Error('--tables must be a whole number of at least 40');
  if (target > 40000) throw new Error('--tables is at most 40000');
  // The fewest whole domains that hold `target` tables (region copies only past the 22 domains);
  // the trim below then removes the few extra.
  let all = [];
  for (let k = 1; k <= DOMAIN_SPECS.length && all.length < target; k++) all = generatePool(seed, k);
  // Trim to exactly `target`: drop tables nothing points at (aggregates, then snapshots, then
  // bridges, then facts; dimensions only for a tiny --tables) from the largest domains first.
  const incoming = new Map(all.map((t) => [t, 0]));
  for (const t of all) for (const x of t.refs) incoming.set(x.to, incoming.get(x.to) + 1);
  const ORDER = ['agg', 'snapshot', 'bridge', 'fact', 'outrigger', 'dim'];
  const removed = new Set();
  const perDomain = new Map();
  for (const t of all) perDomain.set(t.domain, (perDomain.get(t.domain) ?? 0) + 1);
  let excess = all.length - target;
  for (let progress = true; excess > 0 && progress;) {
    progress = false;
    for (const kind of ORDER) {
      while (excess > 0) {
        const candidates = all.filter((t) => !removed.has(t) && t.kind === kind && t.domain !== 0 && incoming.get(t) === 0);
        if (!candidates.length) break;
        candidates.sort((a, b) => (perDomain.get(b.domain) - perDomain.get(a.domain)) || (b.domain - a.domain) || b.group - a.group);
        const t = candidates[0];
        removed.add(t);
        perDomain.set(t.domain, perDomain.get(t.domain) - 1);
        for (const x of t.refs) incoming.set(x.to, incoming.get(x.to) - 1);
        excess--;
        progress = true;
      }
    }
  }
  if (excess > 0) throw new Error(`could not trim to ${target} tables`);
  const tables = all.filter((t) => !removed.has(t));
  return { tables, relationships: tables.reduce((n, t) => n + t.refs.length, 0) };
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

// Card size as the canvas draws it, so the layout can pack cards close without overlaps. A diagram
// of 30+ tables shows at most 5 columns plus a "more" row (packages/renderer/src/lib/nodeSizing.ts);
// one layer, so no layer badge; the schema prefix shows because each schema differs from the layer.
// The width is fitted to the cards Chromium rendered for the default project (the renderer's own
// estimate is ~85 px wider on average): on average 37 px over the drawn width, at most 15 px under,
// which the column gap absorbs.
const visibleRows = (t) => Math.min(t.columns.length, 5) + (t.columns.length > 5 ? 1 : 0);
export const cardHeight = (t) => 4 + 29 + (t.grain ? 15 : 0) + 4 + visibleRows(t) * 25 + 25;
export function cardWidth(t) {
  const header = 80 + (t.schema.length + 1 + t.name.length) * 5.6;
  let widest = 0;
  for (const c of t.columns.slice(0, 5)) {
    const badges = (c.pk ? 1 : 0) + (c.fk ? 1 : 0) + (c.nk ? 1 : 0);
    const extra = (c.scd ? 1 : 0) + (c.additive ? 1 : 0);
    widest = Math.max(widest, 34 + badges * 20 + c.name.length * 7 + c.type.replace(/"/g, '').length * 7 + extra * 14);
  }
  return Math.round(Math.max(200, header, widest) + 8);
}

/** The default spacing: room for the lines between cards and between clusters. */
export const SPACE = { colGap: 150, rowGap: 48, columnHeight: 1150, groupGapX: 220, groupGapY: 220 };
/**
 * The tight spacing of --fit, for a canvas that must show every table at once at the canvas's
 * least zoom (0.05). Columns sit close (about 80 px apart once the cards' drawn widths are
 * counted) but cards in a column keep 56 px between them: the lines leave a card sideways and run
 * between the cards stacked above and below, and a narrower gap there slowed the routing by half.
 */
export const COMPACT_SPACE = { colGap: 44, rowGap: 56, columnHeight: 1200, groupGapX: 80, groupGapY: 60 };

/** A cluster's columns, left to right: outriggers, dimensions, facts + bridges, snapshots + aggregates. */
function layoutGroup(group, space) {
  const dims = group.filter((t) => t.kind === 'dim');
  const dimIndex = new Map(dims.map((d, i) => [d, i]));
  const bary = (t) => {
    const ix = t.refs.map((x) => dimIndex.get(x.to)).filter((i) => i !== undefined);
    return ix.length ? ix.reduce((a, b) => a + b, 0) / ix.length : dims.length / 2;
  };
  const byBary = (list) => list.map((t, i) => [t, bary(t), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map((x) => x[0]);
  const outriggers = group.filter((t) => t.kind === 'outrigger')
    .map((t, i) => [t, dimIndex.get(t.parent) ?? 0, i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map((x) => x[0]);
  const facts = byBary(group.filter((t) => t.kind === 'fact' || t.kind === 'bridge'));
  const later = byBary(group.filter((t) => t.kind === 'snapshot' || t.kind === 'agg'));
  // Columns no taller than space.columnHeight, so every cluster comes out about as tall and the
  // rows of clusters pack tightly.
  const chunk = (list) => {
    const out = [];
    let col = [];
    let h = 0;
    for (const t of list) {
      const add = cardHeight(t) + (col.length ? space.rowGap : 0);
      if (col.length && h + add > space.columnHeight) { out.push(col); col = []; h = 0; }
      h += cardHeight(t) + (col.length ? space.rowGap : 0);
      col.push(t);
    }
    if (col.length) out.push(col);
    return out;
  };
  // Outrigger columns mirror so the first (top) ones sit next to the dimensions.
  const columns = [...chunk(outriggers).reverse(), ...chunk(dims), ...chunk(facts), ...chunk(later)];
  const heights = columns.map((c) => c.reduce((h, t) => h + cardHeight(t), 0) + (c.length - 1) * space.rowGap);
  const height = Math.max(...heights);
  const pos = new Map();
  let x = 0;
  columns.forEach((c, i) => {
    const w = Math.max(...c.map(cardWidth));
    // Spread a short column over the cluster's height, so the cluster reads as a block.
    const gap = c.length > 1 ? Math.min(space.rowGap * 3, (height - (heights[i] - (c.length - 1) * space.rowGap)) / (c.length - 1)) : 0;
    const used = c.reduce((h, t) => h + cardHeight(t), 0) + (c.length - 1) * gap;
    let y = (height - used) / 2;
    for (const t of c) { pos.set(t, { x: x + Math.round((w - cardWidth(t)) / 2), y: Math.round(y) }); y += cardHeight(t) + gap; }
    x += w + space.colGap;
  });
  return { pos, width: x - space.colGap, height };
}

/**
 * Packs blocks ({ width, height, place(dx, dy) }) in rows (shelves) about `rowWidth` wide, each
 * block centred in its row's height and each row centred on the widest; returns the size.
 */
function shelves(blocks, rowWidth, gapX, gapY) {
  const rows = [];
  for (const b of blocks) {
    const row = rows.at(-1);
    if (row && row.width + gapX + b.width <= rowWidth * 1.08) { row.items.push(b); row.width += gapX + b.width; row.height = Math.max(row.height, b.height); }
    else rows.push({ items: [b], width: b.width, height: b.height });
  }
  const width = Math.max(...rows.map((r) => r.width));
  let y = 0;
  for (const row of rows) {
    let x = (width - row.width) / 2;
    for (const b of row.items) { b.place(Math.round(x), Math.round(y + (row.height - b.height) / 2)); x += b.width + gapX; }
    y += row.height + gapY;
  }
  return { width, height: y - gapY, rows: rows.map((r) => r.items) };
}

/** The row width that packs `blocks` into the smallest box of that `aspect`, by trying widths. */
function shelvesFor(blocks, aspect, gapX, gapY) {
  const noop = blocks.map((b) => ({ ...b, place() {} }));
  const minW = Math.max(...blocks.map((b) => b.width));
  const total = blocks.reduce((a, b) => a + b.width + gapX, 0);
  let best = null;
  for (let w = minW; w <= total; w += Math.max(50, (total - minW) / 400)) {
    const size = shelves(noop, w, gapX, gapY);
    // The size of the smallest `aspect` box the canvas fits in: what Fit has to show.
    const score = Math.max(size.width / aspect, size.height) + (size.width * size.height) / 1e12;
    if (!best || score < best.score) best = { score, w };
  }
  return best.w;
}

/** Positions for every table: Map(name -> { x, y }), and the canvas size. */
export function layoutModel(tables, aspect = 16 / 9, space = SPACE) {
  const positions = new Map();
  const clusters = new Map();
  for (const t of tables) {
    const key = `${t.domain}/${t.group}`;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(t);
  }
  // Clusters packed in rows, a domain's clusters next to each other (they come in domain order).
  const blocks = [...clusters.values()].map((g) => {
    const { pos, width, height } = layoutGroup(g, space);
    return { domain: g[0].domain, width, height, place(dx, dy) { for (const [t, p] of pos) positions.set(t.name, { x: p.x + dx, y: p.y + dy }); } };
  });
  // The conformed block (domain 0) goes in the middle of the middle row.
  const shared = blocks.find((b) => b.domain === 0);
  const rest = blocks.filter((b) => b !== shared);
  const rowWidth = shelvesFor(blocks, aspect, space.groupGapX, space.groupGapY);
  const probe = shelves(blocks.map((b) => ({ ...b, place() {} })), rowWidth, space.groupGapX, space.groupGapY).rows;
  const midRow = Math.floor((probe.length - 1) / 2);
  const before = probe.slice(0, midRow).reduce((n, r) => n + r.length, 0);
  const ordered = [...rest];
  if (shared) ordered.splice(Math.min(rest.length, before + Math.floor(probe[midRow].length / 2)), 0, shared);
  const size = shelves(ordered, rowWidth, space.groupGapX, space.groupGapY);
  return { positions, width: Math.round(size.width), height: Math.round(size.height) };
}

// ---------------------------------------------------------------------------------------------
// DBML
// ---------------------------------------------------------------------------------------------

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const tablePath = (t) => `${LAYER}/tables/${t.schema}/${t.name}.dbml`;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));

/** One table file, in ERD Studio's own layout (aligned columns, settings in its order). */
export function tableDbml(t) {
  const header = [`role: ${q(t.role)}`, `grain: ${q(t.grain)}`];
  const settings = (c) => {
    const s = [];
    if (c.pk && !t.compositePk) s.push('pk');
    if (c.nk) s.push("natural_key: 'true'");
    if (c.scd) s.push(`scd_type: ${q(c.scd)}`);
    if (c.additive) s.push(`additive_type: ${q(c.additive)}`);
    if (c.fk) s.push("foreign_key: 'true'");
    if (c.note) s.push(`note: ${q(c.note)}`);
    return s;
  };
  const pks = t.columns.filter((c) => c.pk);
  t.compositePk = pks.length > 1;
  const nameW = Math.max(...t.columns.map((c) => (c.name.length <= 32 ? c.name.length : 0)));
  const typeW = Math.max(0, ...t.columns.filter((c) => settings(c).length && c.type.length <= 24).map((c) => c.type.length));
  const lines = [`Table ${t.schema}.${t.name} [`, ...header.map((h, i) => `  ${h}${i < header.length - 1 ? ',' : ''}`), '] {'];
  for (const c of t.columns) {
    const s = settings(c);
    lines.push(s.length ? `  ${pad(c.name, nameW)} ${pad(c.type, typeW)} [${s.join(', ')}]` : `  ${pad(c.name, nameW)} ${c.type}`.trimEnd());
  }
  if (t.compositePk) lines.push('  indexes {', `    (${pks.map((c) => c.name).join(', ')}) [pk]`, '  }');
  lines.push('}');
  delete t.compositePk;
  return lines.join('\n') + '\n';
}

const useLines = (entries) => {
  // entries: [specifier, path]; consecutive use lines aligned (a part over 48 chars not widening it).
  const w = Math.max(...entries.map(([s]) => (s.length <= 48 ? s.length : 0)));
  return entries.map(([s, p]) => `${pad(s, w)} from '${p}'`);
};

/** The relationships files: one per schema, holding the Refs of that schema's foreign-key tables. */
export function relationshipsFiles(tables) {
  const files = new Map();
  for (const t of tables) {
    if (!t.refs.length) continue;
    if (!files.has(t.schema)) files.set(t.schema, []);
    files.get(t.schema).push(t);
  }
  const out = {};
  for (const [schema, owners] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const named = new Set();
    for (const t of owners) { named.add(t); for (const x of t.refs) named.add(x.to); }
    const uses = [...named].map((t) => [`use { table ${t.schema}.${t.name} }`, `../tables/${t.schema}/${t.name}.dbml`])
      .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    const blocks = owners.map((t) => t.refs.map((x) => `Ref${x.name ? ` ${JSON.stringify(x.name)}` : ''}: ${t.schema}.${t.name}.${x.column} >? ${x.to.schema}.${x.to.name}.${x.toColumn}`).join('\n'));
    out[`${LAYER}/relationships/${schema}.dbml`] = [
      '// ERD Studio relationships: Refs only, split across relationships/ files however you like. Every table a Ref names has a use line here.',
      ...useLines(uses), '', blocks.join('\n\n'), '',
    ].join('\n');
  }
  return out;
}

export function diagramDbml(tables, positions, relFiles) {
  const uses = tables.map((t) => [`use { table ${t.schema}.${t.name} }`, `../tables/${t.schema}/${t.name}.dbml`]);
  const relUses = Object.keys(relFiles).sort().map((p) => `use * from '../relationships/${p.split('/').pop()}'`);
  const layout = tables.map((t) => t.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => `    ${name} ${positions.get(name).x} ${positions.get(name).y}`);
  const domains = new Set(tables.map((t) => t.schema)).size;
  return [
    ...useLines(uses), ...relUses, '',
    `Project ${DIAGRAM} {`,
    `  Note: ${q(`The whole warehouse: ${tables.length} tables across ${domains} schemas, conformed dimensions in the middle.`)}`,
    "  erd_schema_version: '7'",
    "  erd_layout: '''",
    ...layout,
    "  '''",
    '}', '',
  ].join('\n');
}

const README = `# .erd-studio

This folder is an ERD Studio data model, stored as DBML, an open format (https://dbml.dbdiagram.io).
Edit it in VS Code with ERD Studio, or with any text editor or AI assistant.

Every file lives under a layer folder. This project's layers, in order (layers.json lists them):

    1. Gold   gold/

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
`;

const LAYERS = `${JSON.stringify({ schemaVersion: 1, layers: [
  { id: LAYER, label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 1 },
] }, null, 2)}\n`;

/** The whole project as { '<path under .erd-studio>': text }, plus counts. */
/**
 * `fit: { width, height }` (CSS px): lay the diagram out, tightly, to show whole in a canvas of that
 * size at the canvas's least zoom (0.05), as Fit does; `aspect` is then ignored.
 */
export function generateBigProject({ tables: target = 2000, seed = 7, aspect = 16 / 9, fit } = {}) {
  const { tables, relationships } = buildModel({ tables: target, seed });
  const { positions, width, height } = fit
    ? layoutModel(tables, fit.width / fit.height, COMPACT_SPACE)
    : layoutModel(tables, aspect);
  // A table worth zooming into and hovering on camera: the transaction fact nearest the middle of
  // the canvas with five lines or more (four when none has five).
  const lines = new Map(tables.map((t) => [t, t.refs.length]));
  for (const t of tables) for (const x of t.refs) lines.set(x.to, lines.get(x.to) + 1);
  const centreOf = (t) => ({ x: positions.get(t.name).x + cardWidth(t) / 2, y: positions.get(t.name).y + cardHeight(t) / 2 });
  const facts = tables.filter((t) => t.kind === 'fact');
  const most = facts.some((t) => lines.get(t) >= 5) ? 5 : 4;
  const focus = facts.filter((t) => lines.get(t) >= most)
    .map((t) => ({ t, d: Math.hypot(centreOf(t).x - width / 2, centreOf(t).y - height / 2) }))
    .sort((a, b) => a.d - b.d)[0]?.t;
  const files = { 'README.md': README, 'layers.json': LAYERS };
  for (const t of tables) files[tablePath(t)] = tableDbml(t);
  const relFiles = relationshipsFiles(tables);
  Object.assign(files, relFiles);
  files[`${LAYER}/diagrams/${DIAGRAM}.dbml`] = diagramDbml(tables, positions, relFiles);
  return {
    files,
    stats: { tables: tables.length, relationships, schemas: new Set(tables.map((t) => t.schema)).size,
      relationshipsFiles: Object.keys(relFiles).length, extent: { width, height },
      ...(fit ? { fit: { ...fit, fits: width * MIN_ZOOM <= fit.width && height * MIN_ZOOM <= fit.height } } : {}),
      ...(focus ? { focus: { table: focus.name, lines: lines.get(focus), ...centreOf(focus) } } : {}),
      diagram: `.erd-studio/${LAYER}/diagrams/${DIAGRAM}.dbml` },
  };
}

export function writeBigProject(outDir, opts) {
  const { files, stats } = generateBigProject(opts);
  const root = join(resolve(outDir), '.erd-studio');
  rmSync(root, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return { root, stats };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf(name);
    if (i < 0) return dflt;
    const v = Number(args.splice(i, 2)[1]);
    if (!Number.isInteger(v)) { console.error(`${name} needs a whole number`); process.exit(2); }
    return v;
  };
  const tables = flag('--tables', 2000);
  const seed = flag('--seed', 7);
  // --aspect W:H shapes the canvas for the window that films it (default 16:9); --fit WxH (CSS px
  // of canvas) packs it tightly so Fit shows every table at the least zoom, as in --fit 1390x475.
  const ai = args.indexOf('--aspect');
  const [aw, ah] = ai < 0 ? [16, 9] : args.splice(ai, 2)[1].split(':').map(Number);
  if (!(aw > 0 && ah > 0)) { console.error('--aspect needs W:H, as in 16:9'); process.exit(2); }
  const fi = args.indexOf('--fit');
  const [fw, fh] = fi < 0 ? [] : args.splice(fi, 2)[1].split('x').map(Number);
  if (fi >= 0 && !(fw > 0 && fh > 0)) { console.error('--fit needs WxH in CSS px, as in 1390x475'); process.exit(2); }
  const outDir = args[0];
  if (!outDir || args.length > 1) {
    console.error('usage: node video/record/bigProject.mjs <outDir> [--tables 2000] [--seed 7] [--aspect 16:9 | --fit 1390x475]');
    process.exit(2);
  }
  const { root, stats } = writeBigProject(outDir, { tables, seed, aspect: aw / ah, ...(fw ? { fit: { width: fw, height: fh } } : {}) });
  console.log(`bigProject: ${root}\n  ${stats.tables} tables, ${stats.relationships} relationships, ${stats.schemas} schemas, ` +
    `${stats.relationshipsFiles} relationships files\n  canvas ${stats.extent.width} x ${stats.extent.height} ` +
    `(${Math.ceil(stats.extent.width * MIN_ZOOM)} x ${Math.ceil(stats.extent.height * MIN_ZOOM)} CSS px at the least zoom, 0.05` +
    (stats.fit ? (stats.fit.fits ? `: fits the ${stats.fit.width} x ${stats.fit.height} canvas)\n` : `: does NOT fit the ${stats.fit.width} x ${stats.fit.height} canvas)\n`) : ')\n') +
    (stats.focus ? `  focus ${stats.focus.table} (${stats.focus.lines} lines) at ${Math.round(stats.focus.x)}, ${Math.round(stats.focus.y)}\n` : '') +
    `  open ${stats.diagram}`);
}
