-- ============================================================
-- ORDM · Canonical Core · Customer domain
-- Table: identity_link
-- Layer: canonical core (silver / conformed)
-- Version: 0.5
-- Generated: 2026-07-10
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-07-10
-- ============================================================
-- The thin conformed identity primitive: one source-system identifier
-- assertion resolved to a profile, per SCD2 version. This is the
-- "resolved key + match confidence" surface that outcome packages
-- (Unified Customer View, CDP activation, media measurement) depend on.
--
-- Grain: one row per (source_system, identifier_type, identifier_value_hash)
-- assertion of an identifier, per SCD2 version. That triple is what one
-- "assertion" is; identity_link_id is its durable key. A given current, active
-- identifier resolves to exactly one profile (enforced by the
-- identity_link_single_active_profile_per_identifier check).
--
-- Only pseudonymized identifiers live here — identifier_value_hash holds
-- a hashed/tokenized value, never a raw email/phone/device id (data
-- minimization; ICO: pseudonymized data is still personal data).
--
-- Deliberately NOT modeled in the core: the full identity graph
-- (nodes/edges), merge/split event log, graph snapshots, and the
-- match-rule catalog. Those are design-only until a dedicated
-- identity-resolution outcome package needs them (ADR 0044) — see
-- docs/design/customer-identity/identity-resolution-notes.md.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${customer_schema}.identity_link (
  identity_link_sk      BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key. Unique per SCD2 version.',
  identity_link_id      STRING NOT NULL
                          COMMENT 'Durable natural/business key for the assertion, stable per (source_system, identifier_type, identifier_value_hash) across SCD2 versions.',

  -- Resolved customer (the golden profile this identifier maps to)
  profile_sk            BIGINT COMMENT 'FK to profile.profile_sk (the profile version this identifier resolves to).',
  profile_id            STRING NOT NULL
                          COMMENT 'Durable business key of the resolved customer (join on current profile version).',

  -- The asserted identifier (pseudonymized)
  source_system         STRING COMMENT 'Originating system that asserted the identifier (vendor-neutral label).',
  identifier_type       STRING COMMENT 'Type of identifier. Allowed values: email_hash, phone_hash, device_id, cookie_id, maid, loyalty_id, login_id, customer_id.',
  identifier_value_hash STRING COMMENT 'Canonical hashed/tokenized identifier value. Never a raw email/phone/device id (PII, pseudonymized).',

  -- Resolution provenance
  match_method          STRING COMMENT 'How the link was established. Allowed values: deterministic, probabilistic, declared, manual.',
  match_confidence      DECIMAL(5,4) COMMENT 'Resolution confidence in [0,1]. 1.0000 = asserted/deterministic.',
  link_status           STRING COMMENT 'Lifecycle of the link. Allowed values: active, superseded, suppressed.',

  -- SCD2 versioning (principle #8) — date-grained, conformed to every other master.
  effective_from_date   DATE      NOT NULL COMMENT 'SCD2: inclusive start date this link version became effective.',
  effective_to_date     DATE               COMMENT 'SCD2: exclusive end date; NULL while still in effect.',
  is_current            BOOLEAN   NOT NULL COMMENT 'SCD2: TRUE for the currently effective version of this identity link.',

  -- Audit / provenance (standard block; all timestamps UTC)
  created_timestamp        TIMESTAMP COMMENT 'When the record was created in the source system (UTC, ISO 8601).',
  source_updated_timestamp TIMESTAMP COMMENT 'When the record was last modified in the source system (UTC, ISO 8601).',
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_identity_link PRIMARY KEY (identity_link_sk)
)
USING DELTA
-- Cluster on the identifier value (the primary lookup, "what profile does this
-- identifier resolve to?") and profile_id (the reverse profile->links direction);
-- order-independent under Liquid Clustering (standard §B).
CLUSTER BY (identifier_value_hash, profile_id)
-- Deletion vectors speed row-level MERGE/UPDATE (SCD2 version closes, corrections, RTBF).
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core resolved identity links — pseudonymized identifier→profile assertions with match confidence.';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${customer_schema}.identity_link SET TAGS ('dbx_data_type' = 'association');

-- PII column classification (principle #11). A hashed identifier is the identifier
-- PII subtype (§11) — the specific tag improves ABAC / governed-tag routing.
ALTER TABLE ${catalog}.${customer_schema}.identity_link ALTER COLUMN identifier_value_hash SET TAGS ('dbx_pii_identifier' = 'true');
