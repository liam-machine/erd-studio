-- ============================================================
-- ORDM · Canonical Core · Calendar domain
-- File: relationships.sql
-- Version: 0.5
-- Generated: 2026-07-06
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-07-06
-- ============================================================
-- Run AFTER the tables in tables/ exist. ALTER ... ADD CONSTRAINT.
--
-- The Calendar domain declares NO foreign keys: fiscal_calendar and fx_rate
-- are parent reference dimensions that facts join TO on date_key (a logical,
-- non-PK join key), so there is no outbound FK to declare here. What this file
-- carries is the domain's enum / bounded-range CHECK constraints — engine-
-- enforced integrity that column comments and DQ checks alone do not give
-- (data-model-standards.md: "Type categories use enforced Delta CHECK
-- constraints, not just comments"). Bounds match the "Allowed values" /
-- comment ranges in each table's DDL and the calendar_fiscal_ranges DQ check.
-- Every CHECK guards NULL (IS NULL OR ...) so it never rejects an optional
-- attribute, matching the enum-CHECK idiom used across the other core domains.
-- ============================================================

-- ------------------------------------------------------------
-- fiscal_calendar — bounded calendar/NRF-4-5-4 ranges + day-name domain
-- ------------------------------------------------------------
ALTER TABLE ${catalog}.${calendar_schema}.fiscal_calendar
  ADD CONSTRAINT chk_fiscal_calendar_month
  CHECK (calendar_month IS NULL OR calendar_month BETWEEN 1 AND 12);
ALTER TABLE ${catalog}.${calendar_schema}.fiscal_calendar
  ADD CONSTRAINT chk_fiscal_calendar_day
  CHECK (calendar_day IS NULL OR calendar_day BETWEEN 1 AND 31);
ALTER TABLE ${catalog}.${calendar_schema}.fiscal_calendar
  ADD CONSTRAINT chk_fiscal_calendar_day_of_week
  CHECK (day_of_week IS NULL OR day_of_week BETWEEN 1 AND 7);
ALTER TABLE ${catalog}.${calendar_schema}.fiscal_calendar
  ADD CONSTRAINT chk_fiscal_calendar_day_name
  CHECK (day_name IS NULL OR day_name IN
    ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'));
ALTER TABLE ${catalog}.${calendar_schema}.fiscal_calendar
  ADD CONSTRAINT chk_fiscal_calendar_quarter
  CHECK (fiscal_quarter IS NULL OR fiscal_quarter BETWEEN 1 AND 4);
ALTER TABLE ${catalog}.${calendar_schema}.fiscal_calendar
  ADD CONSTRAINT chk_fiscal_calendar_period
  CHECK (fiscal_period IS NULL OR fiscal_period BETWEEN 1 AND 12);
ALTER TABLE ${catalog}.${calendar_schema}.fiscal_calendar
  ADD CONSTRAINT chk_fiscal_calendar_season
  CHECK (fiscal_season IS NULL OR fiscal_season IN ('spring', 'fall'));
ALTER TABLE ${catalog}.${calendar_schema}.fiscal_calendar
  ADD CONSTRAINT chk_fiscal_calendar_week
  CHECK (fiscal_week IS NULL OR fiscal_week BETWEEN 1 AND 53);

-- ------------------------------------------------------------
-- fx_rate — positive rate + ISO 4217 alpha-3 currency codes
-- ------------------------------------------------------------
ALTER TABLE ${catalog}.${calendar_schema}.fx_rate
  ADD CONSTRAINT chk_fx_rate_positive
  CHECK (rate IS NULL OR rate > 0);
ALTER TABLE ${catalog}.${calendar_schema}.fx_rate
  ADD CONSTRAINT chk_fx_rate_from_ccy_iso
  CHECK (from_currency_code IS NULL OR char_length(from_currency_code) = 3);
ALTER TABLE ${catalog}.${calendar_schema}.fx_rate
  ADD CONSTRAINT chk_fx_rate_to_ccy_iso
  CHECK (to_currency_code IS NULL OR char_length(to_currency_code) = 3);
