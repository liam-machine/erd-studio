-- ============================================================
-- ORDM · Canonical Core · Marketing domain
-- File: relationships.sql
-- Version: 0.5
-- Generated: 2026-06-09
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-19
-- ============================================================
-- Constraints for the promotion dimension. UC foreign keys are
-- informational (NOT ENFORCED); the Delta CHECK constraints below are
-- always-on and complement the post-hoc DQ checks. Run AFTER promotion exists.
-- ------------------------------------------------------------
-- Logical relationships on non-PK keys (NOT declared as UC FKs):
--   promotion.fiscal_week_start -> fiscal_calendar.fiscal_week_id
--   promotion.fiscal_week_end   -> fiscal_calendar.fiscal_week_id
-- (fiscal_calendar PK is date_sk; fiscal_week_id is a week-level key.)
-- ------------------------------------------------------------

-- ENFORCED Delta CHECK constraints (always-on; complement the post-hoc DQ checks).
ALTER TABLE ${catalog}.${marketing_schema}.promotion
  ADD CONSTRAINT chk_promotion_supplier_share
  CHECK (supplier_share_pct IS NULL OR (supplier_share_pct >= 0 AND supplier_share_pct <= 100));

ALTER TABLE ${catalog}.${marketing_schema}.promotion
  ADD CONSTRAINT chk_promotion_spend_nonnegative
  CHECK (planned_trade_spend IS NULL OR planned_trade_spend >= 0);

-- Enum / state-domain CHECK constraints.
ALTER TABLE ${catalog}.${marketing_schema}.promotion
  ADD CONSTRAINT chk_promotion_type
  CHECK (promo_type IS NULL OR promo_type IN ('TPR', 'FEATURE', 'DISPLAY', 'FEATURE_AND_DISPLAY', 'BOGO', 'COUPON', 'BUNDLE'));
ALTER TABLE ${catalog}.${marketing_schema}.promotion
  ADD CONSTRAINT chk_promotion_funding_type
  CHECK (funding_type IS NULL OR funding_type IN ('OFF_INVOICE', 'BILL_BACK', 'SCAN_DOWN', 'LUMP_SUM'));
ALTER TABLE ${catalog}.${marketing_schema}.promotion
  ADD CONSTRAINT chk_promotion_funded_by
  CHECK (funded_by IS NULL OR funded_by IN ('SUPPLIER', 'RETAILER', 'SHARED'));

-- ------------------------------------------------------------
-- audience (segment-definition dimension; promoted from CMN gold, ADR 0022).
-- Enum / range CHECK constraints. Kept identical to the CMN definitions for
-- audience_type / audience_origin / size (so no CMN row is invalidated), plus
-- the new segment-definition attributes.
-- ------------------------------------------------------------
ALTER TABLE ${catalog}.${marketing_schema}.audience
  ADD CONSTRAINT chk_audience_type
  CHECK (audience_type IS NULL OR audience_type IN ('first_party', 'modeled', 'lookalike', 'demographic', 'behavioral', 'contextual', 'retargeting', 'custom'));
ALTER TABLE ${catalog}.${marketing_schema}.audience
  ADD CONSTRAINT chk_audience_origin
  CHECK (audience_origin IS NULL OR audience_origin IN ('crm', 'loyalty', 'modeled', 'third_party', 'platform', 'survey'));
ALTER TABLE ${catalog}.${marketing_schema}.audience
  ADD CONSTRAINT chk_audience_size_nonnegative
  CHECK (size_estimate IS NULL OR size_estimate >= 0);
ALTER TABLE ${catalog}.${marketing_schema}.audience
  ADD CONSTRAINT chk_audience_segmentation_basis
  CHECK (segmentation_basis IS NULL OR segmentation_basis IN ('behavioral', 'value_rfm', 'lifecycle', 'demographic', 'geographic', 'predictive', 'lookalike', 'contextual'));
ALTER TABLE ${catalog}.${marketing_schema}.audience
  ADD CONSTRAINT chk_audience_definition_origin
  CHECK (definition_origin IS NULL OR definition_origin IN ('canned', 'custom', 'agent_generated'));
ALTER TABLE ${catalog}.${marketing_schema}.audience
  ADD CONSTRAINT chk_audience_definition_method
  CHECK (definition_method IS NULL OR definition_method IN ('rule', 'ml_score', 'imported'));
ALTER TABLE ${catalog}.${marketing_schema}.audience
  ADD CONSTRAINT chk_audience_evaluation_mode
  CHECK (evaluation_mode IS NULL OR evaluation_mode IN ('batch', 'streaming', 'edge'));
