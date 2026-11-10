-- ============================================================
-- ORDM · Canonical Core · Inventory domain
-- Table: inventory_position
-- Layer: canonical core (silver / conformed fact)
-- Version: 0.5
-- Generated: 2026-06-22
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-22 by @ojasvi-goyal-03
-- ============================================================
-- Daily snapshot of inventory at the store-product grain. This is a fact
-- table, not a master, so it does not carry SCD2 columns (principle #8).
-- It is essential for elasticity and demand modeling to distinguish true
-- zero-demand from zero-sales-due-to-stockout.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${inventory_schema}.inventory_position (
  inventory_position_sk BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key for the daily position record.',
  inventory_position_id STRING NOT NULL
                          COMMENT 'Durable natural/business key (date|store|product).',

  date_key              DATE NOT NULL
                          COMMENT 'Snapshot date. Logical reference to fiscal_calendar.date_key (ISO 8601).',

  product_sk            BIGINT COMMENT 'FK to product.product_sk (version-specific).',
  product_id            STRING NOT NULL COMMENT 'Durable product business key.',
  store_sk              BIGINT COMMENT 'FK to store.store_sk (version-specific).',
  store_id              STRING NOT NULL COMMENT 'Durable store business key.',

  units_on_hand_sod     DECIMAL(12,3) COMMENT 'Units on hand at start of day.',
  units_on_hand_eod     DECIMAL(12,3) COMMENT 'Units on hand at end of day.',
  units_in_transit      DECIMAL(12,3) COMMENT 'Units in transit from DC or supplier.',
  units_on_order        DECIMAL(12,3) COMMENT 'Units ordered but not yet received.',
  units_received_today  DECIMAL(12,3) COMMENT 'Units received today.',
  is_stockout           BOOLEAN COMMENT 'Flag indicating if the product was out of stock.',
  stockout_pct_day      DECIMAL(5,4) COMMENT 'Percentage of day the product was out of stock.',
  size_availability_pct DECIMAL(5,4) COMMENT 'Availability of sizes for this style.',
  replenishment_flag    BOOLEAN COMMENT 'Flag indicating a replenishment order was triggered.',

  -- Audit / provenance (standard block; all timestamps UTC)
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'Timestamp this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_inventory_position PRIMARY KEY (inventory_position_sk)
)
USING DELTA
-- Cluster on the columns queries filter and join on: date_key, product_sk, and
-- store_sk (order-independent under Liquid Clustering).
CLUSTER BY (date_key, product_sk, store_sk)
-- Deletion vectors speed row-level MERGE/UPDATE.
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core daily inventory position fact (product x store x day).';

ALTER TABLE ${catalog}.${inventory_schema}.inventory_position SET TAGS ('dbx_data_type' = 'transactional');
