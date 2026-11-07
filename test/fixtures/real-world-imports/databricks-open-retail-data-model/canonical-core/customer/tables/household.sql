-- ============================================================
-- ORDM · Canonical Core · Customer domain
-- Table: household
-- Layer: canonical core (silver / conformed master)
-- Version: 0.5
-- Generated: 2026-07-10
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-07-10
-- ============================================================
-- Conformed household master: a grouping of related individuals
-- (family, shared address, business account). SCD2 so household
-- composition history is preserved. One logical household; keyed on
-- household_id, which profile.household_id references (profile carries
-- the version-specific household_sk FK — a profile is a member of a
-- household, so the reference points from member to group).
--
-- No derived metrics live here (principle #4): householding confidence,
-- member/device counts, and anchor-store rollups are outcome-layer
-- concerns — see docs/design/customer-identity/identity-resolution-notes.md.
-- Household MEMBERSHIP with roles (primary shopper, probable member) is
-- likewise deferred to an outcome-package bridge, not modeled on the
-- master, to keep the core thin.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${customer_schema}.household (
  household_sk          BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key. Unique per SCD2 version. FK target for profile.household_sk.',
  household_id          STRING NOT NULL
                          COMMENT 'Durable natural/business key for the household. Referenced by profile.household_id. Treated as PII.',

  household_type        STRING COMMENT 'Nature of the household grouping. Allowed values: family, single, shared, business, other.',
  formation_date        DATE   COMMENT 'Date the household grouping was first established/observed (ISO 8601 date).',
  household_status      STRING COMMENT 'Lifecycle status. Allowed values: active, inactive.',

  -- SCD2 versioning (principle #8)
  effective_from_date   DATE    NOT NULL COMMENT 'SCD2: inclusive start date this version became effective.',
  effective_to_date     DATE             COMMENT 'SCD2: exclusive end date; NULL for the current version.',
  is_current            BOOLEAN NOT NULL COMMENT 'SCD2: TRUE for the currently active version of this household.',

  -- Audit / provenance (standard block; all timestamps UTC)
  created_timestamp        TIMESTAMP COMMENT 'When the record was created in the source system (UTC, ISO 8601).',
  source_updated_timestamp TIMESTAMP COMMENT 'When the record was last modified in the source system (UTC, ISO 8601).',
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_household PRIMARY KEY (household_sk)
)
USING DELTA
CLUSTER BY (household_id)
-- Deletion vectors speed row-level MERGE/UPDATE (SCD2 version closes, corrections).
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core household master (SCD2). Conformed household grouping shared by all outcome packages.';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${customer_schema}.household SET TAGS ('dbx_data_type' = 'master');

-- PII column classification (principle #11). Household grouping id is PII.
-- Specific governed-tag (not bare dbx_pii) so household_id routes to the identifier
-- ABAC policy and matches the dbx_pii_* vocabulary (standard §11). (AI review M2)
ALTER TABLE ${catalog}.${customer_schema}.household ALTER COLUMN household_id SET TAGS ('dbx_pii_identifier' = 'true');
