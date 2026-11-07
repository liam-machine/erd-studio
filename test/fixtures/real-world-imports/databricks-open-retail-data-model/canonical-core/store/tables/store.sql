-- ============================================================
-- ORDM · Canonical Core · Store domain
-- Table: store
-- Layer: canonical core (silver / conformed master)
-- Version: 0.5
-- Generated: 2026-06-09
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-09
-- ============================================================
-- Conformed store / location master (SCD2). GS1 GLN retained as the
-- location business key. Shared by every outcome that scopes on store,
-- including Promote with Purpose.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${store_schema}.store (
  store_sk              BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key. Unique per SCD2 version; the join/FK target.',
  store_id              STRING NOT NULL
                          COMMENT 'Durable natural/business key for the store.',

  gln                   STRING COMMENT 'GS1 Global Location Number (13 digits) for the store location.',
  store_name            STRING COMMENT 'Display name of the store.',
  store_format          STRING COMMENT 'Format. Allowed values: hypermarket, supermarket, convenience, drugstore, online.',
  region                STRING COMMENT 'Sales region / area.',
  district              STRING COMMENT 'District within the region.',
  city                  STRING COMMENT 'City / locality of the store.',
  state_province        STRING COMMENT 'State, province, or region code.',
  country_code          STRING COMMENT 'Country, ISO 3166-1 alpha-2 code.',
  open_date             DATE   COMMENT 'Date the store opened (ISO 8601 date).',
  store_status          STRING COMMENT 'Lifecycle status. Allowed values: active, inactive, closed.',

  -- SCD2 versioning (principle #8)
  effective_from_date   DATE    NOT NULL COMMENT 'SCD2: inclusive start date this version became effective.',
  effective_to_date     DATE             COMMENT 'SCD2: exclusive end date; NULL for the current version.',
  is_current          BOOLEAN NOT NULL COMMENT 'SCD2: TRUE for the currently active version.',

  -- Audit / provenance (standard block; all timestamps UTC)
  created_timestamp        TIMESTAMP COMMENT 'When the record was created in the source system (UTC, ISO 8601).',
  source_updated_timestamp TIMESTAMP COMMENT 'When the record was last modified in the source system (UTC, ISO 8601).',
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_store PRIMARY KEY (store_sk)
)
USING DELTA
CLUSTER BY (store_id)
-- Deletion vectors speed row-level MERGE/UPDATE (SCD2 version closes, corrections).
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core store/location master (SCD2). Conformed store entity shared across outcome packages.';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${store_schema}.store SET TAGS ('dbx_data_type' = 'master');
