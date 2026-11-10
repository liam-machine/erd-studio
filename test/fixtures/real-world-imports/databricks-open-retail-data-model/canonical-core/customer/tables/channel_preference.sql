-- ============================================================
-- ORDM · Canonical Core · Customer domain
-- Table: channel_preference
-- Layer: canonical core (silver / conformed master)
-- Version: 0.5
-- Generated: 2026-07-10
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-07-10
-- ============================================================
-- Soft communication preferences: how a customer PREFERS to be
-- contacted — preferred channel, frequency caps, topic subscriptions,
-- format. SCD2 so preference history is preserved.
--
-- Grain is preference_type-aware (all three enforced by checks in checks.sql):
--   * contact_frequency, format — per (profile, channel): one frequency cap /
--     one format per channel.
--   * topic_subscription — per (profile, channel, preference_value): multi-valued,
--     so a customer can hold several concurrent topics on one channel (e.g.
--     'recipes' AND 'deals' on email) — distinct preferences, not versions.
--   * preferred_channel — per profile (a single choice ACROSS channels): here the
--     `channel` column holds the CHOSEN channel, not a scope, and preference_value
--     is unused (NULL). At most one current row per profile.
--
-- Modeling decision (§B, EAV): the four types share ONE table as the minimum-viable
-- "how to contact" concept rather than a table per type. Justified because they are
-- one concept and the strongly-typed settings (frequency_cap_per_period /
-- frequency_period) are real columns, not stuffed into preference_value. The only
-- type-value that lives in the generic preference_value is topic_subscription's
-- topic; if topics later grow their own lifecycle/attributes, split them into a
-- focused table. See docs/design/customer-identity/consent-and-preferences-notes.md.
--
-- This is NOT consent. Legal opt-ins and processing permissions are the
-- single responsibility of the consent table (principle #5) and live
-- ONLY there. channel_preference expresses SOFT taste WITHIN what consent
-- already allows: is_subscribed is enrolment in a topic/format/channel by
-- choice (a soft narrowing of targeting), never the legal permission — a
-- frequency cap or an is_subscribed = false never grants, nor legally
-- overrides, what consent already governs. See
-- docs/design/customer-identity/consent-and-preferences-notes.md for the boundary.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${customer_schema}.channel_preference (
  channel_preference_sk BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key. Unique per SCD2 version.',
  channel_preference_id STRING NOT NULL
                          COMMENT 'Durable natural/business key for the preference record.',

  -- Owning customer
  profile_sk            BIGINT COMMENT 'FK to profile.profile_sk (the profile version this preference attaches to).',
  profile_id            STRING NOT NULL
                          COMMENT 'Durable business key of the owning customer (join on current profile version).',

  channel               STRING COMMENT 'Communication channel the preference applies to. For preference_type = preferred_channel this is the CHOSEN channel (not a scope). Allowed values: email, sms, phone, postal, push, in_app, web.',
  preference_type       STRING COMMENT 'What the preference governs. Allowed values: contact_frequency, topic_subscription, format, preferred_channel.',
  preference_value      STRING COMMENT 'The preference value, interpreted per preference_type: topic name (topic_subscription), format code (format). Unused (NULL) for preferred_channel (the chosen channel is in `channel`) and contact_frequency (see frequency_cap_per_period).',
  is_subscribed         BOOLEAN COMMENT 'Soft enrolment flag for THIS preference (topic/format/channel), by customer choice. Non-legal: a false value is a soft targeting opt-out, NOT a consent withdrawal — legal permission lives only in consent, which still governs lawful contact.',
  frequency_cap_per_period INT COMMENT 'Maximum desired contacts per frequency_period for this channel (NULL = no cap expressed).',
  frequency_period      STRING COMMENT 'Period the frequency cap applies over. Allowed values: day, week, month.',

  -- SCD2 versioning (principle #8)
  effective_from_date   DATE    NOT NULL COMMENT 'SCD2: inclusive start date this version became effective.',
  effective_to_date     DATE             COMMENT 'SCD2: exclusive end date; NULL for the current version.',
  is_current            BOOLEAN NOT NULL COMMENT 'SCD2: TRUE for the currently active version. Current-row grain by type: (profile, channel, preference_type) for contact_frequency/format; + preference_value for topic_subscription (multi-valued); (profile) alone for preferred_channel (a single cross-channel choice).',

  -- Audit / provenance (standard block; all timestamps UTC)
  created_timestamp        TIMESTAMP COMMENT 'When the record was created in the source system (UTC, ISO 8601).',
  source_updated_timestamp TIMESTAMP COMMENT 'When the record was last modified in the source system (UTC, ISO 8601).',
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_channel_preference PRIMARY KEY (channel_preference_sk)
)
USING DELTA
CLUSTER BY (profile_id)
-- Deletion vectors speed row-level MERGE/UPDATE (SCD2 version closes, corrections).
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core customer communication preferences (SCD2). Soft preferences only — legal permissions live in consent.';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${customer_schema}.channel_preference SET TAGS ('dbx_data_type' = 'master');
