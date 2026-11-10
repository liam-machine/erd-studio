-- ============================================================
-- ORDM · Canonical Core · Order domain
-- File: relationships.sql
-- Version: 0.5
-- Generated: 2026-06-09
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-09
-- ============================================================
-- Cross-schema relationships for the customer order-line fact. UC foreign
-- keys are informational (NOT ENFORCED) and reference the parent surrogate
-- PK. Run AFTER profile, product and store exist.
-- ============================================================

ALTER TABLE ${catalog}.${order_schema}.customer_order_line
  ADD CONSTRAINT fk_col_profile
  FOREIGN KEY (profile_sk) REFERENCES ${catalog}.${customer_schema}.profile (profile_sk);

ALTER TABLE ${catalog}.${order_schema}.customer_order_line
  ADD CONSTRAINT fk_col_product
  FOREIGN KEY (product_sk) REFERENCES ${catalog}.${product_schema}.product (product_sk);

ALTER TABLE ${catalog}.${order_schema}.customer_order_line
  ADD CONSTRAINT fk_col_store
  FOREIGN KEY (store_sk) REFERENCES ${catalog}.${store_schema}.store (store_sk);

-- ------------------------------------------------------------
-- Logical relationship on a non-PK key (NOT a declared UC FK):
--   customer_order_line.order_date -> fiscal_calendar.date_key
-- Join on order_date for the fiscal period (NRF 4-5-4).
-- ------------------------------------------------------------
