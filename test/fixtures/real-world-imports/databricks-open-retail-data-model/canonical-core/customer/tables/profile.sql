-- ============================================================
-- ORDM · Canonical Core · Customer domain
-- Table: profile
-- Layer: canonical core (silver / conformed master)
-- Version: 0.5
-- Generated: 2026-06-09
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-09
-- ============================================================
-- Conformed individual-customer master. One logical person; SCD2
-- so identity attributes are versioned over time. No derived
-- metrics (lifetime value, order counts, scores) live here — those
-- belong in outcome-package metric views (principle #4).
--
-- Catalog/schema are injected at deploy time (${catalog}.${customer_schema});
-- never hardcode. For canonical-core, ${customer_schema} = the domain name.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${customer_schema}.profile (
  profile_sk            BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key. Unique per SCD2 version. Used as the join/FK target for downstream dimensional models.',
  profile_id            STRING NOT NULL
                          COMMENT 'Durable natural/business key for the individual customer. Stable across SCD2 versions; pseudonymous identifier, not a name.',

  -- Identity (PII)
  name_prefix           STRING COMMENT 'Honorific prefix. Common values include mr, mrs, ms, mx, dr.',
  first_name            STRING COMMENT 'Given name.',
  middle_name           STRING COMMENT 'Middle name(s) or initial.',
  last_name             STRING COMMENT 'Family / surname.',
  name_suffix           STRING COMMENT 'Generational/qualification suffix. Common values include jr, sr, ii, iii.',
  date_of_birth         DATE   COMMENT 'Date of birth (ISO 8601 date).',
  gender                STRING COMMENT 'Self-described gender. Free text; common values include female, male, non_binary, prefer_not_to_say.',

  -- Locale / nationality
  preferred_language_code   STRING COMMENT 'Preferred communication language, ISO 639-1 alpha-2 (e.g. en, fr, es).',
  nationality_country_code  STRING COMMENT 'Nationality, ISO 3166-1 alpha-2 country code.',

  -- Retail identifiers (PII per ORDM/RSK calibration)
  loyalty_id            STRING COMMENT 'Loyalty/membership program identifier for the individual. Treated as PII.',
  household_sk          BIGINT COMMENT 'FK to household.household_sk (the household version this profile is a member of). Resolved as-of the profile version.',
  household_id          STRING COMMENT 'Durable household grouping key linking related individuals; joins household.household_id (current version). Treated as PII.',

  -- Lifecycle (factual, not aggregated)
  customer_status       STRING COMMENT 'Lifecycle status. Allowed values: prospect, active, inactive, closed.',
  enrollment_date       DATE   COMMENT 'Date the individual first became a known customer (ISO 8601 date).',

  -- SCD2 versioning (principle #8)
  effective_from_date   DATE    NOT NULL COMMENT 'SCD2: inclusive start date this version became effective.',
  effective_to_date     DATE             COMMENT 'SCD2: exclusive end date this version stopped being effective; NULL for the current version.',
  is_current          BOOLEAN NOT NULL COMMENT 'SCD2: TRUE for the currently active version of this profile.',

  -- Audit / provenance (standard block; all timestamps UTC)
  created_timestamp        TIMESTAMP COMMENT 'When the record was created in the source system (UTC, ISO 8601).',
  source_updated_timestamp TIMESTAMP COMMENT 'When the record was last modified in the source system (UTC, ISO 8601).',
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_profile PRIMARY KEY (profile_sk)
)
USING DELTA
CLUSTER BY (profile_id)
-- Deletion vectors speed row-level MERGE/UPDATE (SCD2 version closes, corrections).
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core individual-customer master (SCD2). Conformed identity shared by all outcome packages.';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${customer_schema}.profile SET TAGS ('dbx_data_type' = 'master');

-- PII column classification (principle #11; consumed by dbxmetagen / governance).
ALTER TABLE ${catalog}.${customer_schema}.profile ALTER COLUMN first_name   SET TAGS ('dbx_pii_name' = 'true');
ALTER TABLE ${catalog}.${customer_schema}.profile ALTER COLUMN middle_name  SET TAGS ('dbx_pii_name' = 'true');
ALTER TABLE ${catalog}.${customer_schema}.profile ALTER COLUMN last_name    SET TAGS ('dbx_pii_name' = 'true');
ALTER TABLE ${catalog}.${customer_schema}.profile ALTER COLUMN date_of_birth SET TAGS ('dbx_pii_dob' = 'true');
ALTER TABLE ${catalog}.${customer_schema}.profile ALTER COLUMN loyalty_id   SET TAGS ('dbx_pii_identifier' = 'true');
ALTER TABLE ${catalog}.${customer_schema}.profile ALTER COLUMN household_id SET TAGS ('dbx_pii_identifier' = 'true');
