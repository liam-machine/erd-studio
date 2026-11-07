-- ============================================================
-- ORDM · Canonical Core · Marketing domain
-- Table: audience
-- Layer: canonical core (silver / conformed dimension)
-- Version: 0.5
-- Generated: 2026-07-21
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-07-21
-- ============================================================
-- The conformed AUDIENCE / segment-DEFINITION dimension (SCD2). One structured
-- row per audience/segment version: what the segment is, how it is defined, how
-- it was built, and its addressability. A DEFINITION catalog only — never member
-- lists, never PII, never live membership counts (those live in the consuming
-- outcome packages; membership counts are metric views, not columns here).
--
-- Promoted to silver `marketing` (ADR 0022) now that it has a SECOND consumer:
--   * Commerce Media Networks (retail-media ad delivery) — ad_group / media_event /
--     campaign_day target an audience_sk.
--   * Actionable Customer Understanding (behavioral segmentation) — segment_membership
--     references audience_id; UCV joins it through the activation-eligibility gate.
-- Held once in the conformed core so a segment is defined once, not per package
-- (one source of truth). Was single-outcome gold in commerce-media-networks
-- (ADR 0021 amendment 2); ADR 0022 completes the promote-back path that package
-- named. Kept the name/keys stable on promotion so CMN FKs only change schema.
--
-- Grain: one current version per audience (audience_id). No metrics on the
-- dimension (principle #9): size_estimate is a point-in-time definition attribute,
-- NOT a refreshed rollup of a membership table.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${marketing_schema}.audience (
  audience_sk           BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key. Unique per SCD2 version; the join/FK target.',
  audience_id           STRING NOT NULL
                          COMMENT 'Durable natural/business key for the audience/segment. The stable key consumers reference and reverse-ETL diffs on.',

  audience_name         STRING COMMENT 'Human-readable audience/segment name.',
  audience_type         STRING COMMENT 'How the segment is defined. Allowed values: first_party, modeled, lookalike, demographic, behavioral, contextual, retargeting, custom.',
  audience_origin       STRING COMMENT 'Where the segment originates. Allowed values: crm, loyalty, modeled, third_party, platform, survey.',
  definition_description STRING COMMENT 'Vendor-neutral description of the membership criteria (no PII, no member lists).',
  size_estimate         BIGINT COMMENT 'Approximate member count as of this SCD2 version — a point-in-time snapshot attribute (>= 0), not a refreshed rollup of another table.',
  is_addressable_flag   BOOLEAN COMMENT 'TRUE if the audience can be targeted/activated for delivery.',

  -- Segment-definition attributes (ADR 0022) — additive; NULL for legacy retail-media rows.
  segmentation_basis    STRING COMMENT 'The axis the definition is built on. Allowed values: behavioral, value_rfm, lifecycle, demographic, geographic, predictive, lookalike, contextual.',
  definition_origin     STRING COMMENT 'How the definition was authored. Allowed values: canned, custom, agent_generated.',
  definition_method     STRING COMMENT 'How membership is computed. Allowed values: rule, ml_score, imported.',
  criteria_expression   STRING COMMENT 'Portable, vendor-neutral predicate/SQL text describing the membership rule. No PII, no member lists.',
  evaluation_mode       STRING COMMENT 'Refresh latency of the definition (an attribute, not a schema fork). Allowed values: batch, streaming, edge.',
  iab_taxonomy_code     STRING COMMENT 'Optional IAB Audience Taxonomy tier code for cross-platform interoperability (NULL if unmapped). Kept on the shared audience dimension (not a CMN/activation extension) because it is a standards-based interoperability attribute OF the audience concept itself — any activation consumer benefits, so it belongs with the entity, not one outcome package.',

  -- SCD2 versioning (principle #8)
  effective_from_date   DATE    NOT NULL COMMENT 'SCD2: inclusive start date this version became effective.',
  effective_to_date     DATE             COMMENT 'SCD2: exclusive end date; NULL for the current version.',
  is_current            BOOLEAN NOT NULL COMMENT 'SCD2: TRUE for the currently active version of this audience.',

  -- Audit / provenance (standard block; all timestamps UTC)
  created_timestamp        TIMESTAMP COMMENT 'When the record was created in the source system (UTC, ISO 8601).',
  source_updated_timestamp TIMESTAMP COMMENT 'When the record was last modified in the source system (UTC, ISO 8601).',
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_audience PRIMARY KEY (audience_sk)
)
USING DELTA
CLUSTER BY (audience_id)
-- Deletion vectors speed row-level MERGE/UPDATE (SCD2 version closes, corrections).
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core marketing audience/segment-definition dimension (SCD2) — the single source of truth for a segment definition, shared by retail media and customer-intelligence segmentation.';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${marketing_schema}.audience SET TAGS ('dbx_data_type' = 'master');
