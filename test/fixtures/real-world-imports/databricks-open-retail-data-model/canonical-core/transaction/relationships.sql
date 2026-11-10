-- ============================================================
-- ORDM · Canonical Core · Transaction domain
-- File: relationships.sql
-- Version: 0.5
-- Generated: 2026-06-09
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-09
-- ============================================================
-- Cross-table / cross-schema relationships for the sales fact. UC foreign
-- keys are informational (NOT ENFORCED) and reference the parent's declared
-- PRIMARY KEY (the surrogate _sk). Run AFTER all referenced tables exist.
-- ============================================================

-- sales -> product / store / promotion (version-specific surrogate FKs)
ALTER TABLE ${catalog}.${transaction_schema}.sales
  ADD CONSTRAINT fk_sales_product
  FOREIGN KEY (product_sk) REFERENCES ${catalog}.${product_schema}.product (product_sk);

ALTER TABLE ${catalog}.${transaction_schema}.sales
  ADD CONSTRAINT fk_sales_store
  FOREIGN KEY (store_sk) REFERENCES ${catalog}.${store_schema}.store (store_sk);

ALTER TABLE ${catalog}.${transaction_schema}.sales
  ADD CONSTRAINT fk_sales_promotion
  FOREIGN KEY (promo_sk) REFERENCES ${catalog}.${marketing_schema}.promotion (promo_sk);

-- ------------------------------------------------------------
-- Logical relationships on non-PK keys (NOT declared as UC FKs):
--   sales.date_key -> fiscal_calendar.date_key  (calendar PK is date_sk)
-- Join sales to the fiscal calendar on date_key for all retail-week logic.
-- ------------------------------------------------------------

-- ENFORCED Delta CHECK constraints (always-on; complement the post-hoc DQ checks).
ALTER TABLE ${catalog}.${transaction_schema}.sales
  ADD CONSTRAINT chk_sales_nonnegative
  CHECK (units >= 0 AND gross_revenue >= 0 AND net_revenue >= 0);
