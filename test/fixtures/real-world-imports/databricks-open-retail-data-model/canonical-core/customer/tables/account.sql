-- ============================================================
-- ORDM · Canonical Core · Customer domain
-- Table: account
-- Layer: canonical core (silver / conformed master)
-- Version: 0.5
-- Generated: 2026-06-09
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-09
-- ============================================================
-- Optional B2B organization account (principle #3). Represents the
-- business entity a customer transacts on behalf of. SCD2 master.
-- Individuals are modeled in profile; an account's primary contact
-- references a profile via business key. No derived metrics here.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${customer_schema}.account (
  account_sk            BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key. Unique per SCD2 version.',
  account_id            STRING NOT NULL
                          COMMENT 'Durable natural/business key for the organization account.',

  account_name          STRING COMMENT 'Registered / legal name of the organization.',
  account_type          STRING COMMENT 'Organization type. Allowed values: business, government, education, nonprofit, reseller.',
  registration_number   STRING COMMENT 'Business registration / company number (jurisdiction-dependent).',
  tax_id                STRING COMMENT 'Tax registration identifier for the organization.',
  gln                   STRING COMMENT 'GS1 Global Location Number (13 digits) identifying the primary location of the organization.',
  industry_classification_code STRING COMMENT 'Standard industry classification code (e.g. NAICS/SIC-style); stored as code, not name.',

  parent_account_id     STRING COMMENT 'Business key of the parent organization account for hierarchies; NULL for top-level (self-FK on the business key; profile/account are SCD2 so the business key is not unique, hence no surrogate self-FK).',
  primary_contact_profile_sk BIGINT COMMENT 'FK to profile.profile_sk (foreign surrogate; nullable, not a PK). The primary-contact profile version resolved AS OF the effective_from_date of this account version (profile is SCD2 — the standard ORDM as-of surrogate resolution, matching how product_price/sales/inventory resolve their _sk FKs, and how address/contact/consent carry profile_sk). Declared as informational FK fk_account_profile in relationships.sql.',
  primary_contact_profile_id STRING COMMENT 'Durable business key of the individual (profile) who is the primary contact for the account. Retained for lineage/current-version joins alongside primary_contact_profile_sk; under SCD2 the business key is not unique, so the declared UC FK is on the surrogate.',

  account_status        STRING       COMMENT 'Lifecycle status. Allowed values: prospect, active, inactive, closed.',
  credit_limit_amount   DECIMAL(18,2) COMMENT 'Assigned credit limit for the account, in the reporting/base currency.',
  currency_code         STRING        COMMENT 'Reporting/base currency of ALL monetary columns, ISO 4217 alpha-3. Equals the deploy base_currency; the canonical core is single-currency by construction.',
  transaction_currency_code STRING    COMMENT 'Original account/billing currency before normalization (lineage only), ISO 4217 alpha-3. Convert with fx_rate.',
  enrollment_date       DATE          COMMENT 'Date the account was established (ISO 8601 date).',

  -- SCD2 versioning (principle #8)
  effective_from_date   DATE    NOT NULL COMMENT 'SCD2: inclusive start date this version became effective.',
  effective_to_date     DATE             COMMENT 'SCD2: exclusive end date; NULL for the current version.',
  is_current          BOOLEAN NOT NULL COMMENT 'SCD2: TRUE for the currently active version of this account.',

  -- Audit / provenance (standard block; all timestamps UTC)
  created_timestamp        TIMESTAMP COMMENT 'When the record was created in the source system (UTC, ISO 8601).',
  source_updated_timestamp TIMESTAMP COMMENT 'When the record was last modified in the source system (UTC, ISO 8601).',
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_account PRIMARY KEY (account_sk)
)
USING DELTA
CLUSTER BY (account_id)
-- Deletion vectors speed row-level MERGE/UPDATE (SCD2 version closes, corrections).
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core B2B organization account (SCD2). Optional; used when customers transact on behalf of a business.';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${customer_schema}.account SET TAGS ('dbx_data_type' = 'master');

-- PII / sensitive column classification (principle #11). Organization
-- name is not personal PII; tax id and credit limit are financial-sensitive.
ALTER TABLE ${catalog}.${customer_schema}.account ALTER COLUMN tax_id              SET TAGS ('dbx_pii_financial' = 'true');
ALTER TABLE ${catalog}.${customer_schema}.account ALTER COLUMN credit_limit_amount SET TAGS ('dbx_pii_financial' = 'true');
