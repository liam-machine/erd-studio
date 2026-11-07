-- ============================================================
-- ORDM · Canonical Core · Interaction domain · PII column masks
-- Version: 0.5 · Generated: 2026-07-28 · LLM-generated: true · Reviewed: 2026-07-28
-- ENFORCES the dbx_pii_identifier tag on the touchpoint fact: the hashed/tokenized
-- device/cookie/app identifier (device_id_hash) is masked by default; only members
-- of the `pii_readers` group see raw token values. Run AFTER the touchpoint table
-- exists (and grant the group separately). Downstream consumers read the resolved
-- profile_id, never the anonymous device key; this protects the fact itself
-- (defence in depth), matching customer/CMN masks.sql.
-- ============================================================

CREATE OR REPLACE FUNCTION ${catalog}.${interaction_schema}.mask_pii_text(val STRING)
  RETURNS STRING
  RETURN CASE WHEN is_account_group_member('pii_readers') THEN val ELSE '***' END;

ALTER TABLE ${catalog}.${interaction_schema}.touchpoint ALTER COLUMN device_id_hash SET MASK ${catalog}.${interaction_schema}.mask_pii_text;
