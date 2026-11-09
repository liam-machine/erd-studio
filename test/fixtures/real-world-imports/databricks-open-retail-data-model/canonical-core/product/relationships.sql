-- ============================================================
-- ORDM · Canonical Core · Product domain · relationships
-- Version: 0.5 · Generated: 2026-06-10 · LLM-generated: true · Reviewed: 2026-06-10
-- ============================================================

-- ------------------------------------------------------------
-- Informational foreign key (NOT ENFORCED, NORELY). UC foreign keys are
-- informational and reference the parent surrogate PK. Read price AS OF a
-- date from product_price; the product dim carries the current list/cost
-- snapshot.
--   product_price.product_sk -> product.product_sk
-- product_sk is the product SCD2 version in effect AS OF the price's
-- effective_from_date (ORDM's standard surrogate resolution, matching how
-- sales/inventory/shipment resolve their _sk FKs). The durable product_id
-- business key is retained on product_price for lineage, but under SCD2 it is
-- not unique, so the declared FK is on the surrogate, not the business key.
-- ------------------------------------------------------------
ALTER TABLE ${catalog}.${product_schema}.product_price
  ADD CONSTRAINT fk_product_price_product
  FOREIGN KEY (product_sk) REFERENCES ${catalog}.${product_schema}.product (product_sk);

-- Enum / state-domain CHECK constraints (H-10; lists match the column comments).
ALTER TABLE ${catalog}.${product_schema}.product
  ADD CONSTRAINT chk_product_status
  CHECK (product_status IS NULL OR product_status IN ('active', 'inactive', 'discontinued'));
ALTER TABLE ${catalog}.${product_schema}.product
  ADD CONSTRAINT chk_product_unit_of_measure
  CHECK (unit_of_measure IS NULL OR unit_of_measure IN ('each', 'kg', 'g', 'l', 'ml', 'pack'));

ALTER TABLE ${catalog}.${product_schema}.product_price
  ADD CONSTRAINT chk_product_price_type
  CHECK (price_type IN ('list', 'cost', 'promotional', 'contract'));
ALTER TABLE ${catalog}.${product_schema}.product_price
  ADD CONSTRAINT chk_product_price_amount_nonnegative
  CHECK (amount IS NULL OR amount >= 0);
