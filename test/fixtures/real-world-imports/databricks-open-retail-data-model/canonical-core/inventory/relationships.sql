-- ============================================================
-- ORDM · Canonical Core · Inventory domain
-- File: relationships.sql
-- Version: 0.5
-- Generated: 2026-06-22
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-22
-- ============================================================
-- Cross-schema relationships for the inventory domain.
-- ============================================================

ALTER TABLE ${catalog}.${inventory_schema}.inventory_position
  ADD CONSTRAINT fk_inv_pos_product
  FOREIGN KEY (product_sk) REFERENCES ${catalog}.${product_schema}.product (product_sk);

ALTER TABLE ${catalog}.${inventory_schema}.inventory_position
  ADD CONSTRAINT fk_inv_pos_store
  FOREIGN KEY (store_sk) REFERENCES ${catalog}.${store_schema}.store (store_sk);
