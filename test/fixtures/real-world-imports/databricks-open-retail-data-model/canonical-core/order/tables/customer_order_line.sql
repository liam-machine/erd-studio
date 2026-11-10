-- ============================================================
-- ORDM · Canonical Core · Order domain
-- Table: customer_order_line
-- Layer: canonical core (silver / conformed fact)
-- Version: 0.5
-- Generated: 2026-06-09
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-09
-- ============================================================
-- Customer-attributed purchase fact at customer x order x product (line)
-- grain. Unlike the anonymous POS `sales` fact, this links a purchase to a
-- customer (profile), so per-customer value (CLV/RFM) can be computed.
-- Margin derives from product.unit_cost. profile_id is a pseudonymous
-- business key, not direct PII; loyalty_id / household_id stay in the
-- governed customer dimension and are never carried here.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${order_schema}.customer_order_line (
  order_line_sk         BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key.',
  order_line_id         STRING NOT NULL
                          COMMENT 'Durable natural/business key for the order line.',
  order_id              STRING NOT NULL
                          COMMENT 'Order (purchase occasion) business key; one order has several lines.',

  profile_sk            BIGINT COMMENT 'FK to profile.profile_sk (version-specific).',
  profile_id            STRING NOT NULL COMMENT 'Durable customer business key (pseudonymous; not direct PII).',
  product_sk            BIGINT COMMENT 'FK to product.product_sk (version-specific).',
  product_id            STRING NOT NULL COMMENT 'Durable product business key.',
  store_sk              BIGINT COMMENT 'FK to store.store_sk (version-specific).',
  store_id              STRING NOT NULL COMMENT 'Durable store business key.',

  order_date            DATE COMMENT 'Order date (calendar day). FK to fiscal_calendar.date_key (ISO 8601).',
  event_timestamp       TIMESTAMP COMMENT 'Instant the order line was placed (UTC, ISO 8601) — event-time, distinct from load_timestamp (processing-time).',
  units                 INT  COMMENT 'Units purchased on this line.',
  gross_amount          DECIMAL(18,2) COMMENT 'Gross line amount before discount, in the reporting/base currency.',
  net_amount            DECIMAL(18,2) COMMENT 'Net line amount after discount, in the reporting/base currency.',
  currency_code         STRING        COMMENT 'Reporting/base currency of ALL monetary columns, ISO 4217 alpha-3. Equals the deploy base_currency; the canonical core is single-currency by construction.',
  transaction_currency_code STRING    COMMENT 'Original transaction currency before normalization (lineage only), ISO 4217 alpha-3. Convert with fx_rate.',

  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'Timestamp this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_customer_order_line PRIMARY KEY (order_line_sk)
)
USING DELTA
CLUSTER BY (profile_sk, order_date)
-- Deletion vectors speed row-level MERGE/UPDATE (SCD2 version closes, corrections).
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core customer-attributed order line fact. Feeds customer lifetime value (CLV/RFM).';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${order_schema}.customer_order_line SET TAGS ('dbx_data_type' = 'transactional');
