-- ============================================================
-- ORDM · Canonical Core · Customer domain
-- Table: address
-- Layer: canonical core (silver / conformed master)
-- Version: 0.5
-- Generated: 2026-06-09
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-09
-- ============================================================
-- Postal addresses associated with a customer profile. SCD2 so
-- address history is preserved. One profile may have many addresses
-- (billing, shipping, etc.). profile_sk is the version-specific FK
-- target; profile_id is the durable join key.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${customer_schema}.address (
  address_sk            BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key. Unique per SCD2 version.',
  address_id            STRING NOT NULL
                          COMMENT 'Durable natural/business key for the address.',

  -- Owning customer
  profile_sk            BIGINT COMMENT 'FK to profile.profile_sk (the profile version this address attaches to).',
  profile_id            STRING NOT NULL
                          COMMENT 'Durable business key of the owning customer (join on current profile version).',

  address_type          STRING COMMENT 'Role of this address. Allowed values: billing, shipping, home, work, other.',

  -- Postal components (PII)
  address_line_1        STRING COMMENT 'Primary street address line.',
  address_line_2        STRING COMMENT 'Secondary address line (unit, suite, floor).',
  city                  STRING COMMENT 'City / locality.',
  state_province        STRING COMMENT 'State, province, or region.',
  postal_code           STRING COMMENT 'Postal or ZIP code.',
  country_code          STRING COMMENT 'Country, ISO 3166-1 alpha-2 code.',

  -- Optional geocode
  latitude              DECIMAL(9,6) COMMENT 'Geocoded latitude (decimal degrees, WGS84).',
  longitude             DECIMAL(9,6) COMMENT 'Geocoded longitude (decimal degrees, WGS84).',

  is_primary            BOOLEAN COMMENT 'TRUE if this is the primary address of its type for the customer.',
  address_status        STRING  COMMENT 'Status of the address. Allowed values: active, inactive.',

  -- SCD2 versioning (principle #8)
  effective_from_date   DATE    NOT NULL COMMENT 'SCD2: inclusive start date this version became effective.',
  effective_to_date     DATE             COMMENT 'SCD2: exclusive end date; NULL for the current version.',
  is_current          BOOLEAN NOT NULL COMMENT 'SCD2: TRUE for the currently active version of this address.',

  -- Audit / provenance (standard block; all timestamps UTC)
  created_timestamp        TIMESTAMP COMMENT 'When the record was created in the source system (UTC, ISO 8601).',
  source_updated_timestamp TIMESTAMP COMMENT 'When the record was last modified in the source system (UTC, ISO 8601).',
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_address PRIMARY KEY (address_sk)
)
USING DELTA
CLUSTER BY (profile_id)
-- Deletion vectors speed row-level MERGE/UPDATE (SCD2 version closes, corrections).
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core customer postal addresses (SCD2).';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${customer_schema}.address SET TAGS ('dbx_data_type' = 'master');

-- PII column classification (principle #11).
ALTER TABLE ${catalog}.${customer_schema}.address ALTER COLUMN address_line_1 SET TAGS ('dbx_pii_address' = 'true');
ALTER TABLE ${catalog}.${customer_schema}.address ALTER COLUMN address_line_2 SET TAGS ('dbx_pii_address' = 'true');
ALTER TABLE ${catalog}.${customer_schema}.address ALTER COLUMN city           SET TAGS ('dbx_pii_address' = 'true');
ALTER TABLE ${catalog}.${customer_schema}.address ALTER COLUMN postal_code    SET TAGS ('dbx_pii_address' = 'true');
