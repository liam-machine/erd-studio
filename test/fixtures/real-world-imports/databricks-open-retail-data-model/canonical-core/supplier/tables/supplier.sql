-- ============================================================
-- ORDM · Canonical Core · Supplier domain
-- Table: supplier
-- Layer: canonical core (silver / conformed master)
-- Version: 0.5
-- Generated: 2026-06-09
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-09
-- ============================================================
-- Conformed supplier / vendor master (SCD2). GS1 GLN retained as the
-- location/party business key (same convention as store and account).
-- Shared by procurement and supply-chain outcome packages. No performance
-- metrics live here (those are computed in the scorecard view).
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${supplier_schema}.supplier (
  supplier_sk           BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key. Unique per SCD2 version; the join/FK target.',
  supplier_id           STRING NOT NULL
                          COMMENT 'Durable natural/business key for the supplier.',

  gln                   STRING COMMENT 'GS1 Global Location Number (13 digits) identifying the supplier party/location.',
  supplier_name         STRING COMMENT 'Registered / legal name of the supplier.',
  supplier_type         STRING COMMENT 'Type of supplier. Allowed values: manufacturer, distributor, wholesaler, importer, broker.',
  country_code          STRING COMMENT 'Country of the supplier, ISO 3166-1 alpha-2.',
  region                STRING COMMENT 'Sourcing region / area.',
  onboarding_date       DATE   COMMENT 'Date the supplier was onboarded (ISO 8601 date).',
  supplier_status       STRING COMMENT 'Lifecycle status. Allowed values: active, inactive, suspended.',

  -- SCD2 versioning (principle #8)
  effective_from_date   DATE    NOT NULL COMMENT 'SCD2: inclusive start date this version became effective.',
  effective_to_date     DATE             COMMENT 'SCD2: exclusive end date; NULL for the current version.',
  is_current          BOOLEAN NOT NULL COMMENT 'SCD2: TRUE for the currently active version.',

  -- Audit / provenance (standard block; all timestamps UTC)
  created_timestamp        TIMESTAMP COMMENT 'When the record was created in the source system (UTC, ISO 8601).',
  source_updated_timestamp TIMESTAMP COMMENT 'When the record was last modified in the source system (UTC, ISO 8601).',
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_supplier PRIMARY KEY (supplier_sk)
)
USING DELTA
CLUSTER BY (supplier_id)
-- Deletion vectors speed row-level MERGE/UPDATE (SCD2 version closes, corrections).
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core supplier/vendor master (SCD2). Conformed supplier entity shared across supply-chain outcome packages.';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${supplier_schema}.supplier SET TAGS ('dbx_data_type' = 'master');
