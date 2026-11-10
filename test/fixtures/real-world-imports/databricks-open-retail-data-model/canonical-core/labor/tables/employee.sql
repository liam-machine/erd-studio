-- ============================================================
-- ORDM · Canonical Core · Labor domain
-- Table: employee
-- Layer: canonical core (silver / conformed master)
-- Version: 0.5
-- Generated: 2026-08-10
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-08-10
-- ============================================================
-- Pseudonymous in-store associate master (SCD2). No personal names,
-- contact, or date of birth — only durable IDs and workforce attributes
-- needed for scheduling and labor analytics. Shared by Predictive
-- Operations (Workforce Optimization) and planned AI-Assisted Store
-- Associates. See ADR 0043.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${labor_schema}.employee (
  employee_sk           BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key. Unique per SCD2 version; the join/FK target.',
  employee_id           STRING NOT NULL
                          COMMENT 'Durable pseudonymous business key for the associate. Not a legal name or government ID.',

  home_store_sk         BIGINT COMMENT 'FK to store.store_sk for the associate home store (version-specific).',
  home_store_id         STRING NOT NULL COMMENT 'Durable business key of the home store.',

  primary_role_code     STRING NOT NULL
                          COMMENT 'Primary role. Allowed values: cashier, sales_associate, fulfillment, inventory, supervisor.',
  employment_status     STRING NOT NULL
                          COMMENT 'Employment status. Allowed values: active, leave, terminated.',
  employment_type       STRING
                          COMMENT 'Engagement type. Allowed values: full_time, part_time, seasonal, contractor.',

  hourly_labor_cost     DECIMAL(18,4) COMMENT 'Fully-loaded hourly labor cost in base currency (unit-grain rate; DECIMAL scale 4).',
  currency_code         STRING COMMENT 'ISO 4217 alpha-3 for hourly_labor_cost; constant base_currency (USD) per single-reporting-currency rule.',

  max_daily_hours       DECIMAL(6,2) NOT NULL COMMENT 'Maximum scheduled hours in a single calendar day.',
  max_weekly_hours      DECIMAL(6,2) NOT NULL COMMENT 'Maximum scheduled hours in a calendar week (Mon-Sun UTC).',
  min_rest_hours        DECIMAL(6,2) NOT NULL COMMENT 'Minimum rest hours required between the end of one shift and the start of the next.',

  preferred_shift_start_local STRING COMMENT 'Preferred local shift start as HH:mm (store-local); advisory only.',
  preferred_shift_end_local   STRING COMMENT 'Preferred local shift end as HH:mm (store-local); advisory only.',

  hire_date             DATE COMMENT 'Date employment began (ISO 8601).',
  termination_date      DATE COMMENT 'Date employment ended; NULL while active (ISO 8601).',

  -- SCD2 versioning (standard A.8)
  effective_from_date   DATE    NOT NULL COMMENT 'SCD2: inclusive start date this version became effective.',
  effective_to_date     DATE             COMMENT 'SCD2: exclusive end date; NULL for the current version.',
  is_current            BOOLEAN NOT NULL COMMENT 'SCD2: TRUE for the currently active version.',

  -- Audit / provenance (master audit block)
  created_timestamp        TIMESTAMP COMMENT 'When the record was created in the source system (UTC, ISO 8601).',
  source_updated_timestamp TIMESTAMP COMMENT 'When the record was last modified in the source system (UTC, ISO 8601).',
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_employee PRIMARY KEY (employee_sk)
)
USING DELTA
CLUSTER BY (employee_id)
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core pseudonymous associate master (SCD2). Workforce supply attributes for scheduling; no personal names or contact PII.';

ALTER TABLE ${catalog}.${labor_schema}.employee SET TAGS ('dbx_data_type' = 'master');

ALTER TABLE ${catalog}.${labor_schema}.employee ALTER COLUMN employee_id SET TAGS ('dbx_pii_identifier' = 'true');

-- Hourly labor cost is compensation data: tag it financial-PII so ABAC masking and
-- the governed-tag overlay treat it like account.tax_id / account.credit_limit_amount.
ALTER TABLE ${catalog}.${labor_schema}.employee ALTER COLUMN hourly_labor_cost SET TAGS ('dbx_pii_financial' = 'true');

ALTER TABLE ${catalog}.${labor_schema}.employee ADD CONSTRAINT chk_employee_role CHECK (primary_role_code IN ('cashier', 'sales_associate', 'fulfillment', 'inventory', 'supervisor'));
ALTER TABLE ${catalog}.${labor_schema}.employee ADD CONSTRAINT chk_employee_status CHECK (employment_status IN ('active', 'leave', 'terminated'));
ALTER TABLE ${catalog}.${labor_schema}.employee ADD CONSTRAINT chk_employee_type CHECK (employment_type IS NULL OR employment_type IN ('full_time', 'part_time', 'seasonal', 'contractor'));
ALTER TABLE ${catalog}.${labor_schema}.employee ADD CONSTRAINT chk_employee_max_daily CHECK (max_daily_hours > 0);
ALTER TABLE ${catalog}.${labor_schema}.employee ADD CONSTRAINT chk_employee_max_weekly CHECK (max_weekly_hours > 0);
ALTER TABLE ${catalog}.${labor_schema}.employee ADD CONSTRAINT chk_employee_min_rest CHECK (min_rest_hours >= 0);
ALTER TABLE ${catalog}.${labor_schema}.employee ADD CONSTRAINT chk_employee_cost CHECK (hourly_labor_cost IS NULL OR hourly_labor_cost >= 0);
ALTER TABLE ${catalog}.${labor_schema}.employee ADD CONSTRAINT chk_employee_currency CHECK (currency_code IS NULL OR length(currency_code) = 3);
