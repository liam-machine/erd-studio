-- ============================================================
-- ORDM · Canonical Core · Equipment domain
-- File: relationships.sql
-- Version: 0.5
-- Generated: 2026-07-15
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-07-15 by @sreekanthmunigati
-- ============================================================
-- Cross-schema relationships for the equipment domain. UC foreign
-- keys are informational (NOT ENFORCED) and reference the parent
-- surrogate PK. Run AFTER store exists.
-- ============================================================

-- equipment -> store
ALTER TABLE ${catalog}.${equipment_schema}.equipment
  ADD CONSTRAINT fk_equipment_store
  FOREIGN KEY (store_sk) REFERENCES ${catalog}.${store_schema}.store (store_sk);

-- equipment_reading -> equipment
ALTER TABLE ${catalog}.${equipment_schema}.equipment_reading
  ADD CONSTRAINT fk_reading_equipment
  FOREIGN KEY (equipment_sk) REFERENCES ${catalog}.${equipment_schema}.equipment (equipment_sk);

-- ENFORCED Delta CHECK constraints
ALTER TABLE ${catalog}.${equipment_schema}.equipment
  ADD CONSTRAINT chk_equipment_lifespan
  CHECK (expected_lifespan_years IS NULL OR expected_lifespan_years > 0);

ALTER TABLE ${catalog}.${equipment_schema}.equipment_reading
  ADD CONSTRAINT chk_reading_latency_nonnegative
  CHECK (latency_seconds IS NULL OR latency_seconds >= 0);
