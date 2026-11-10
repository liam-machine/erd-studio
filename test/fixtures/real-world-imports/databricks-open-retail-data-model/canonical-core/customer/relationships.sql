-- ============================================================
-- ORDM · Canonical Core · Customer domain
-- File: relationships.sql
-- Version: 0.5
-- Generated: 2026-06-09
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-09
-- ============================================================
-- Cross-table relationships for the customer domain. Run AFTER the
-- tables in tables/ exist. Unity Catalog foreign keys are informational
-- (NOT ENFORCED) — they document the model and feed BI/Genie, they do
-- not validate data.
--
-- A UC FK must reference the parent's declared PRIMARY KEY, which here
-- is the surrogate _sk. So declared FKs below reference profile_sk (the
-- version-specific parent reference). Each child also carries the
-- durable profile_id for version-independent ("current") joins.
-- ============================================================

-- profile (1) ──< (N) address / contact / consent
ALTER TABLE ${catalog}.${customer_schema}.address
  ADD CONSTRAINT fk_address_profile
  FOREIGN KEY (profile_sk) REFERENCES ${catalog}.${customer_schema}.profile (profile_sk);

ALTER TABLE ${catalog}.${customer_schema}.contact
  ADD CONSTRAINT fk_contact_profile
  FOREIGN KEY (profile_sk) REFERENCES ${catalog}.${customer_schema}.profile (profile_sk);

ALTER TABLE ${catalog}.${customer_schema}.consent
  ADD CONSTRAINT fk_consent_profile
  FOREIGN KEY (profile_sk) REFERENCES ${catalog}.${customer_schema}.profile (profile_sk);

-- account (primary contact) ──> profile
-- The primary-contact profile version is resolved AS OF the account version's
-- effective_from_date (profile is SCD2 — the standard as-of surrogate resolution).
-- The durable primary_contact_profile_id is retained on account for current-version
-- joins, but under SCD2 it is not unique, so the declared FK is on the surrogate.
ALTER TABLE ${catalog}.${customer_schema}.account
  ADD CONSTRAINT fk_account_profile
  FOREIGN KEY (primary_contact_profile_sk) REFERENCES ${catalog}.${customer_schema}.profile (profile_sk);

-- profile (member) ──> household
-- A profile is a member of a household; the version-specific household_sk is
-- resolved AS OF the profile version (both are SCD2 — standard as-of resolution).
-- The durable household_id is retained on profile for current-version joins.
ALTER TABLE ${catalog}.${customer_schema}.profile
  ADD CONSTRAINT fk_profile_household
  FOREIGN KEY (household_sk) REFERENCES ${catalog}.${customer_schema}.household (household_sk);

-- profile (1) ──< (N) identity_link / channel_preference
ALTER TABLE ${catalog}.${customer_schema}.identity_link
  ADD CONSTRAINT fk_identity_link_profile
  FOREIGN KEY (profile_sk) REFERENCES ${catalog}.${customer_schema}.profile (profile_sk);

ALTER TABLE ${catalog}.${customer_schema}.channel_preference
  ADD CONSTRAINT fk_channel_preference_profile
  FOREIGN KEY (profile_sk) REFERENCES ${catalog}.${customer_schema}.profile (profile_sk);

-- ------------------------------------------------------------
-- Logical relationships on business keys (NOT declared as UC FKs).
-- Under SCD2 the business key is not unique, so it cannot be a UC FK
-- target. These are documented here for modelers and downstream tools;
-- enforce in ETL / quality checks instead.
--
--   account.parent_account_id           ->  account.account_id   (self, org hierarchy)
--   address.profile_id                  ->  profile.profile_id   (durable join, is_current = TRUE)
--   contact.profile_id                  ->  profile.profile_id   (durable join, is_current = TRUE)
--   consent.profile_id                  ->  profile.profile_id   (durable join, is_current = TRUE)
--   profile.household_id                ->  household.household_id      (durable join, is_current = TRUE)
--   identity_link.profile_id            ->  profile.profile_id   (durable join, is_current = TRUE)
--   channel_preference.profile_id       ->  profile.profile_id   (durable join, is_current = TRUE)
-- ------------------------------------------------------------

-- ============================================================
-- Enum / state-domain CHECK constraints (H-10; always-on enforcement).
-- Lists match the "Allowed values" in each table's column comments.
-- ============================================================
ALTER TABLE ${catalog}.${customer_schema}.profile
  ADD CONSTRAINT chk_profile_customer_status
  CHECK (customer_status IS NULL OR customer_status IN ('prospect', 'active', 'inactive', 'closed'));

ALTER TABLE ${catalog}.${customer_schema}.address
  ADD CONSTRAINT chk_address_type
  CHECK (address_type IS NULL OR address_type IN ('billing', 'shipping', 'home', 'work', 'other'));
ALTER TABLE ${catalog}.${customer_schema}.address
  ADD CONSTRAINT chk_address_status
  CHECK (address_status IS NULL OR address_status IN ('active', 'inactive'));

ALTER TABLE ${catalog}.${customer_schema}.contact
  ADD CONSTRAINT chk_contact_status
  CHECK (contact_status IS NULL OR contact_status IN ('active', 'inactive', 'bounced', 'opted_out'));

ALTER TABLE ${catalog}.${customer_schema}.consent
  ADD CONSTRAINT chk_consent_status
  CHECK (consent_status IS NULL OR consent_status IN ('granted', 'withdrawn', 'pending', 'expired'));

ALTER TABLE ${catalog}.${customer_schema}.consent
  ADD CONSTRAINT chk_consent_type
  CHECK (consent_type IS NULL OR consent_type IN ('marketing_email', 'marketing_sms', 'marketing_phone', 'marketing_postal', 'data_processing', 'third_party_sharing', 'data_sale', 'profiling', 'cookies'));

ALTER TABLE ${catalog}.${customer_schema}.consent
  ADD CONSTRAINT chk_consent_suppression_reason
  CHECK (suppression_reason_code IS NULL OR suppression_reason_code IN ('unsubscribe', 'hard_bounce', 'spam_complaint', 'legal_objection', 'deceased', 'fraud', 'do_not_contact', 'list_hygiene'));

ALTER TABLE ${catalog}.${customer_schema}.account
  ADD CONSTRAINT chk_account_type
  CHECK (account_type IS NULL OR account_type IN ('business', 'government', 'education', 'nonprofit', 'reseller'));
ALTER TABLE ${catalog}.${customer_schema}.account
  ADD CONSTRAINT chk_account_status
  CHECK (account_status IS NULL OR account_status IN ('prospect', 'active', 'inactive', 'closed'));

ALTER TABLE ${catalog}.${customer_schema}.household
  ADD CONSTRAINT chk_household_type
  CHECK (household_type IS NULL OR household_type IN ('family', 'single', 'shared', 'business', 'other'));
ALTER TABLE ${catalog}.${customer_schema}.household
  ADD CONSTRAINT chk_household_status
  CHECK (household_status IS NULL OR household_status IN ('active', 'inactive'));

ALTER TABLE ${catalog}.${customer_schema}.identity_link
  ADD CONSTRAINT chk_identity_link_identifier_type
  CHECK (identifier_type IS NULL OR identifier_type IN ('email_hash', 'phone_hash', 'device_id', 'cookie_id', 'maid', 'loyalty_id', 'login_id', 'customer_id'));
ALTER TABLE ${catalog}.${customer_schema}.identity_link
  ADD CONSTRAINT chk_identity_link_match_method
  CHECK (match_method IS NULL OR match_method IN ('deterministic', 'probabilistic', 'declared', 'manual'));
ALTER TABLE ${catalog}.${customer_schema}.identity_link
  ADD CONSTRAINT chk_identity_link_status
  CHECK (link_status IS NULL OR link_status IN ('active', 'superseded', 'suppressed'));
ALTER TABLE ${catalog}.${customer_schema}.identity_link
  ADD CONSTRAINT chk_identity_link_confidence
  CHECK (match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 1));

ALTER TABLE ${catalog}.${customer_schema}.channel_preference
  ADD CONSTRAINT chk_channel_preference_channel
  CHECK (channel IS NULL OR channel IN ('email', 'sms', 'phone', 'postal', 'push', 'in_app', 'web'));
ALTER TABLE ${catalog}.${customer_schema}.channel_preference
  ADD CONSTRAINT chk_channel_preference_type
  CHECK (preference_type IS NULL OR preference_type IN ('contact_frequency', 'topic_subscription', 'format', 'preferred_channel'));
ALTER TABLE ${catalog}.${customer_schema}.channel_preference
  ADD CONSTRAINT chk_channel_preference_frequency_period
  CHECK (frequency_period IS NULL OR frequency_period IN ('day', 'week', 'month'));
ALTER TABLE ${catalog}.${customer_schema}.channel_preference
  ADD CONSTRAINT chk_channel_preference_frequency_cap_nonneg
  CHECK (frequency_cap_per_period IS NULL OR frequency_cap_per_period >= 0);
