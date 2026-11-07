-- ============================================================
-- ORDM · Canonical Core · Supplier domain · relationships
-- Version: 0.5 · Generated: 2026-06-10 · LLM-generated: true · Reviewed: 2026-06-10
-- ============================================================

-- Enum / state-domain CHECK constraints (H-10; lists match the column comments).
ALTER TABLE ${catalog}.${supplier_schema}.supplier
  ADD CONSTRAINT chk_supplier_type
  CHECK (supplier_type IS NULL OR supplier_type IN ('manufacturer', 'distributor', 'wholesaler', 'importer', 'broker'));

ALTER TABLE ${catalog}.${supplier_schema}.supplier
  ADD CONSTRAINT chk_supplier_status
  CHECK (supplier_status IS NULL OR supplier_status IN ('active', 'inactive', 'suspended'));
