-- ============================================================
-- ORDM · Canonical Core · Calendar domain
-- Table: fx_rate
-- Layer: canonical core (silver / conformed reference)
-- Version: 0.5
-- Generated: 2026-07-06
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-07-06
-- ============================================================
-- Daily foreign-exchange rates, the conversion reference for currency
-- normalization. The canonical core stores ALL monetary columns already in
-- the reporting/base currency (the deploy base_currency), so gold
-- aggregations are single-currency and correct by construction. This table
-- is what a source-aligned ETL joins to convert original-currency amounts to
-- base at ingest, and what auditors use to reconcile transaction_currency_code
-- lineage back to source. Type 1 (static reference; no SCD).
--   to_base(amount) = amount * rate   where from_currency_code -> to_currency_code = base
-- A self-rate row (from = to = base, rate = 1) exists for every date.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${calendar_schema}.fx_rate (
  fx_rate_sk            BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key.',
  fx_rate_id            STRING NOT NULL
                          COMMENT 'Durable business key (date_key|from|to).',

  date_key              DATE NOT NULL
                          COMMENT 'Rate date. Logical join key to fiscal_calendar.date_key (not a declared UC FK; ISO 8601).',
  from_currency_code    STRING NOT NULL COMMENT 'Source currency, ISO 4217 alpha-3.',
  to_currency_code      STRING NOT NULL COMMENT 'Target/reporting currency, ISO 4217 alpha-3 (the base_currency).',
  rate                  DECIMAL(18,8) COMMENT 'Multiply a from-currency amount by rate to get the to-currency amount. 1.0 when from = to.',

  created_timestamp        TIMESTAMP COMMENT 'When the record was created in the source system (UTC, ISO 8601). Required on reference tables (standard §8).',
  source_updated_timestamp TIMESTAMP COMMENT 'When the record was last modified in the source system (UTC, ISO 8601). Required on reference tables (standard §8).',
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'Timestamp this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_fx_rate PRIMARY KEY (fx_rate_sk)
)
USING DELTA
-- Cluster on date_key (range-pruned by the ingest join) and the source currency;
-- order-independent under Liquid Clustering.
CLUSTER BY (date_key, from_currency_code)
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core daily FX rates (from -> base). Conversion reference for single-currency normalization.';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${calendar_schema}.fx_rate SET TAGS ('dbx_data_type' = 'reference');
