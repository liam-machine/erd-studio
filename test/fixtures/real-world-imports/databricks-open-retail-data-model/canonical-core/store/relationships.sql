-- ============================================================
-- ORDM · Canonical Core · Store domain · relationships
-- Version: 0.5 · Generated: 2026-06-10 · LLM-generated: true · Reviewed: 2026-06-10
-- ============================================================

-- Enum / state-domain CHECK constraints (H-10; lists match the column comments).
ALTER TABLE ${catalog}.${store_schema}.store
  ADD CONSTRAINT chk_store_status
  CHECK (store_status IS NULL OR store_status IN ('active', 'inactive', 'closed'));
ALTER TABLE ${catalog}.${store_schema}.store
  ADD CONSTRAINT chk_store_format
  CHECK (store_format IS NULL OR store_format IN ('hypermarket', 'supermarket', 'convenience', 'drugstore', 'online'));
