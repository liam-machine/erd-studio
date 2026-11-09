-- ============================================================
-- ORDM · Canonical Core · Customer domain
-- Table: consent
-- Layer: canonical core (silver / conformed)
-- Version: 0.5
-- Generated: 2026-06-09
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-07-27
-- ============================================================
-- The single source of truth for customer consent (principle #5).
-- Marketing opt-ins, data-processing permissions, etc. live ONLY here
-- — never as flags on profile/account/contact. Temporal: SCD2, date-grained
-- like every other master (effective_from_date/effective_to_date/is_current);
-- decision_timestamp keeps the legal-grade instant the decision was recorded.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${customer_schema}.consent (
  consent_sk            BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key. Unique per consent version.',
  consent_id            STRING NOT NULL
                          COMMENT 'Durable natural/business key for the consent record.',

  -- Owning customer
  profile_sk            BIGINT COMMENT 'FK to profile.profile_sk.',
  profile_id            STRING NOT NULL
                          COMMENT 'Durable business key of the customer giving/withholding consent.',

  consent_type          STRING COMMENT 'What the consent governs. third_party_sharing = disclosure of personal information for cross-context behavioral advertising (CCPA/CPRA do-not-SHARE); data_sale = disclosure for monetary or other valuable consideration (CCPA/CPRA do-not-SELL) - the two are legally distinct opt-outs (the mandated link reads Do Not Sell or Share), so they are separate types, not one. Allowed values: marketing_email, marketing_sms, marketing_phone, marketing_postal, data_processing, third_party_sharing, data_sale, profiling, cookies.',
  consent_status        STRING COMMENT 'Current decision. Allowed values: granted, withdrawn, pending, expired.',
  legal_basis           STRING COMMENT 'Lawful basis for processing. Allowed values: consent, contract, legitimate_interest, legal_obligation, vital_interest, public_task.',
  capture_channel       STRING COMMENT 'Channel where consent was captured (vendor-neutral). Allowed values: web, mobile_app, store, call_center, email.',
  disclosure_version    STRING COMMENT 'Identifier/version of the consent statement or privacy notice presented at capture.',
  jurisdiction_code     STRING COMMENT 'Region/law scope this decision applies under. May be an ISO 3166-1 country (GB), an ISO 3166-2 subdivision (US-CA), or a reserved regional code (EU) — not alpha-2-only, since regulatory scope does not map cleanly to countries. Lets one customer hold different consent per jurisdiction (GDPR vs CCPA/CPRA). NULL = global/unspecified.',

  -- Suppression overlay (a fourth governed state; principle #5 — do NOT collapse into
  -- consent_status). A suppression is an operational/legal do-not-contact signal that
  -- OVERRIDES granted consent. ICO guidance treats do-not-contact as a signal to retain for
  -- screening future contact; ORDM v1 overlay is a warehouse-native approximation of that.
  -- A fully erasure-surviving, identifier-hash-keyed store is the deferred promote target
  -- per ADR 0027 section 5 / ADR 0028; this attribute does not itself guarantee survival of
  -- a hard erasure.
  suppression_indicator   BOOLEAN COMMENT 'Operational do-not-activate overlay for this consent scope. TRUE = suppress activation on this purpose x channel even when consent_status is granted (suppression OVERRIDES consent). Distinct from withdrawal (consent_status=withdrawn is the customer revoking permission; suppression is an operational/legal do-not-contact signal, e.g. hard bounce or a direct-marketing objection). NULL/FALSE = not suppressed.',
  suppression_reason_code STRING COMMENT 'Why this scope is suppressed (set only when suppression_indicator is TRUE). Two scopes: CHANNEL-level reasons block only this consent scope (unsubscribe, hard_bounce, spam_complaint, list_hygiene); PERSON-level reasons block every plane for the profile (deceased, fraud, do_not_contact, legal_objection) via the shared UCV gold_person_do_not_target_current view, which both the owned activation gate and any paid/non-owned plane consult (ADR 0028). Allowed values: unsubscribe, hard_bounce, spam_complaint, legal_objection, deceased, fraud, do_not_contact, list_hygiene.',

  -- SCD2 versioning (principle #8) — date-grained, conformed to every other master.
  effective_from_date   DATE      NOT NULL COMMENT 'SCD2: inclusive start date this consent version became effective.',
  effective_to_date     DATE               COMMENT 'SCD2: exclusive end date; NULL while still in effect.',
  is_current            BOOLEAN   NOT NULL COMMENT 'SCD2: TRUE for the currently effective consent record per (profile, consent_type, jurisdiction_code).',
  decision_timestamp    TIMESTAMP COMMENT 'Legal-grade instant the consent decision was given/withdrawn (UTC, ISO 8601).',

  -- Audit / provenance (standard block; all timestamps UTC)
  created_timestamp        TIMESTAMP COMMENT 'When the record was created in the source system (UTC, ISO 8601).',
  source_updated_timestamp TIMESTAMP COMMENT 'When the record was last modified in the source system (UTC, ISO 8601).',
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_consent PRIMARY KEY (consent_sk)
)
USING DELTA
CLUSTER BY (profile_id)
-- Deletion vectors speed row-level MERGE/UPDATE (SCD2 version closes, corrections).
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core customer consent — the single source of truth for opt-ins and processing permissions.';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${customer_schema}.consent SET TAGS ('dbx_data_type' = 'master');
