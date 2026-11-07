-- ============================================================
-- ORDM · Canonical Core · Procurement domain
-- File: relationships.sql
-- Version: 0.5
-- Generated: 2026-06-09
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-09
-- ============================================================
-- Cross-schema relationships for the purchase-order line fact. UC foreign
-- keys are informational (NOT ENFORCED) and reference the parent surrogate
-- PK. Run AFTER supplier, product and store exist.
-- ============================================================

ALTER TABLE ${catalog}.${procurement_schema}.purchase_order_line
  ADD CONSTRAINT fk_pol_supplier
  FOREIGN KEY (supplier_sk) REFERENCES ${catalog}.${supplier_schema}.supplier (supplier_sk);

ALTER TABLE ${catalog}.${procurement_schema}.purchase_order_line
  ADD CONSTRAINT fk_pol_product
  FOREIGN KEY (product_sk) REFERENCES ${catalog}.${product_schema}.product (product_sk);

ALTER TABLE ${catalog}.${procurement_schema}.purchase_order_line
  ADD CONSTRAINT fk_pol_store
  FOREIGN KEY (store_sk) REFERENCES ${catalog}.${store_schema}.store (store_sk);

-- ------------------------------------------------------------
-- Logical relationship on a non-PK key (NOT a declared UC FK):
--   purchase_order_line.order_date -> fiscal_calendar.date_key
-- Join on order_date for the fiscal period (NRF 4-5-4).
-- ------------------------------------------------------------

-- ENFORCED Delta CHECK constraints (always-on; complement the post-hoc DQ checks).
ALTER TABLE ${catalog}.${procurement_schema}.purchase_order_line
  ADD CONSTRAINT chk_pol_quantities
  CHECK (ordered_qty >= 0 AND received_qty >= 0 AND defective_qty >= 0
         AND received_qty <= ordered_qty);

-- Enum / state-domain CHECK constraint (H-10).
ALTER TABLE ${catalog}.${procurement_schema}.purchase_order_line
  ADD CONSTRAINT chk_pol_order_status
  CHECK (order_status IS NULL OR order_status IN ('open', 'received', 'closed', 'cancelled'));
