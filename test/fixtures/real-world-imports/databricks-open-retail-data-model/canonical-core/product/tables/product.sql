-- ============================================================
-- ORDM · Canonical Core · Product domain
-- Table: product
-- Layer: canonical core (silver / conformed master)
-- Version: 0.5
-- Generated: 2026-06-09
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-09
-- ============================================================
-- Conformed product master (SCD2). GS1 identifiers (GTIN/SKU) retained
-- as business keys. No derived metrics (sales, margin) here — those live
-- in outcome-package views. Shared by every outcome that scopes on
-- product, including Promote with Purpose.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${product_schema}.product (
  product_sk            BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key. Unique per SCD2 version; the join/FK target.',
  product_id            STRING NOT NULL
                          COMMENT 'Durable natural/business key for the product.',

  gtin                  STRING COMMENT 'GS1 Global Trade Item Number (UPC/EAN). Not PII.',
  sku                   STRING COMMENT 'Stock keeping unit code. Not PII.',
  -- Variant hierarchy: product (this row) is a sellable SKU/GTIN; style_id groups
  -- the variants of one style/model, so SKUs roll up to a style (product -> style -> SKU).
  style_id              STRING COMMENT 'Parent style/model this SKU is a variant of. SKUs sharing a style_id are variants (e.g. colour/size). NULL for non-variant products.',
  color                 STRING COMMENT 'Variant-defining attribute: colour (free text). NULL if not applicable.',
  size                  STRING COMMENT 'Variant-defining attribute: size (free text, e.g. S/M/L, 500ml). NULL if not applicable.',
  product_name          STRING COMMENT 'Display name of the product.',
  brand                 STRING COMMENT 'Brand name (free text).',
  category              STRING COMMENT 'Merchandising category (top level).',
  subcategory           STRING COMMENT 'Merchandising subcategory.',
  department            STRING COMMENT 'Store department the product belongs to.',
  unit_of_measure       STRING COMMENT 'Selling unit of measure. Allowed values: each, kg, g, l, ml, pack.',
  list_price            DECIMAL(18,4) COMMENT 'Standard list (shelf) price, in the reporting/base currency (normalized at ingest). Unit-grain price: DECIMAL(18,4) (principle #9d).',
  unit_cost             DECIMAL(18,4) COMMENT 'Standard unit cost (COGS), in the reporting/base currency. Basis for margin = revenue - units * unit_cost. A master cost attribute, not a derived metric. Unit-grain cost: DECIMAL(18,4) (principle #9d).',
  currency_code         STRING COMMENT 'Reporting/base currency of ALL monetary columns, ISO 4217 alpha-3. Equals the deploy base_currency; the canonical core is single-currency by construction.',
  transaction_currency_code STRING COMMENT 'Original sourcing currency before normalization (lineage only), ISO 4217 alpha-3. Convert with fx_rate.',
  product_status        STRING COMMENT 'Lifecycle status. Allowed values: active, inactive, discontinued.',

  -- SCD2 versioning (principle #8)
  effective_from_date   DATE    NOT NULL COMMENT 'SCD2: inclusive start date this version became effective.',
  effective_to_date     DATE             COMMENT 'SCD2: exclusive end date; NULL for the current version.',
  is_current          BOOLEAN NOT NULL COMMENT 'SCD2: TRUE for the currently active version.',

  -- Audit / provenance (standard block; all timestamps UTC)
  created_timestamp        TIMESTAMP COMMENT 'When the record was created in the source system (UTC, ISO 8601).',
  source_updated_timestamp TIMESTAMP COMMENT 'When the record was last modified in the source system (UTC, ISO 8601).',
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_product PRIMARY KEY (product_sk)
)
USING DELTA
CLUSTER BY (product_id)
-- Deletion vectors speed row-level MERGE/UPDATE (SCD2 version closes, corrections).
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core product master (SCD2). Conformed product entity shared across outcome packages.';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${product_schema}.product SET TAGS ('dbx_data_type' = 'master');
