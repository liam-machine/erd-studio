-- ============================================================
-- ORDM · Canonical Core · Transaction domain
-- Table: sales
-- Layer: canonical core (silver / conformed fact)
-- Version: 0.5
-- Generated: 2026-06-09
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-09
-- ============================================================
-- POS sales fact at product x store x day grain. Conformed fact shared by
-- outcome packages. Each row is attributed to a promotion via promo_sk:
-- non-promoted sales carry the dedicated "no promotion" member of the
-- promotion dimension (promo_id = 'NO_PROMO'), so promoted vs non-promoted
-- sales are both first-class for downstream ROI work.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${transaction_schema}.sales (
  sales_sk              BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key.',
  sales_id              STRING NOT NULL
                          COMMENT 'Durable natural/business key for the daily sales record.',

  date_key              DATE NOT NULL
                          COMMENT 'Selling date. FK to fiscal_calendar.date_key (ISO 8601).',

  product_sk            BIGINT COMMENT 'FK to product.product_sk (version-specific).',
  product_id            STRING NOT NULL COMMENT 'Durable product business key.',
  store_sk              BIGINT COMMENT 'FK to store.store_sk (version-specific).',
  store_id              STRING NOT NULL COMMENT 'Durable store business key.',

  -- Promotion attribution (nullable per spec; populated with the NO_PROMO
  -- member surrogate for non-promoted sales, so it is effectively never NULL).
  promo_sk              BIGINT COMMENT 'FK to promotion.promo_sk. Non-promoted rows carry the NO_PROMO member surrogate.',
  promo_id              STRING COMMENT 'Durable promotion business key; equals NO_PROMO when the sale was not on promotion.',

  units                 INT           COMMENT 'Units sold (count).',
  gross_revenue         DECIMAL(18,2) COMMENT 'Gross sales amount before promotional discount, in the reporting/base currency.',
  discount_amount       DECIMAL(18,2) COMMENT 'Promotional discount amount applied, in the reporting/base currency.',
  net_revenue           DECIMAL(18,2) COMMENT 'Net sales amount after discount (gross_revenue - discount_amount), in the reporting/base currency.',
  currency_code         STRING        COMMENT 'Reporting/base currency of ALL monetary columns, ISO 4217 alpha-3. Equals the deploy base_currency; the canonical core is single-currency by construction.',
  transaction_currency_code STRING    COMMENT 'Original transaction currency before normalization (lineage only), ISO 4217 alpha-3. Convert with fx_rate.',

  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'Timestamp this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_sales PRIMARY KEY (sales_sk)
)
USING DELTA
-- Cluster on the columns queries filter and join on: date_key (period-grain gold
-- views join sales to the fiscal calendar and aggregate by time, so date-range
-- pruning matters) plus product_sk/store_sk (the main join keys). Liquid
-- Clustering is order-independent, so these are unordered. promo_sk is left out
-- because it is near-constant (almost every row carries the single NO_PROMO
-- member), so it earns no data-skipping even under order-independent clustering --
-- it is queried as a predicate instead. (This is a selectivity/skew reason, not the
-- retired "lead with the high-cardinality key" ordering folklore.)
CLUSTER BY (date_key, product_sk, store_sk)
-- Deletion vectors speed row-level MERGE/UPDATE (SCD2 version closes, corrections).
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core POS sales fact (product x store x day). Carries promo_sk for promotion attribution.';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${transaction_schema}.sales SET TAGS ('dbx_data_type' = 'transactional');
