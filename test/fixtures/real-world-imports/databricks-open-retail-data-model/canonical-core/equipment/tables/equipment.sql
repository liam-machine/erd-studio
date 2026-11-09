-- ============================================================
-- ORDM · Canonical Core · Equipment domain
-- Table: equipment
-- Layer: canonical core (silver / conformed dimension)
-- Version: 0.5
-- Generated: 2026-07-15
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-07-15 by @sreekanthmunigati
-- ============================================================
-- In-store equipment master dimension (SCD2). Tracks refrigeration
-- units, HVAC systems, POS terminals, self-checkout kiosks, bakery
-- ovens, and other store-level assets that require maintenance and
-- affect product availability when they fail.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${equipment_schema}.equipment (
  equipment_sk          BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key. Unique per SCD2 version; the join/FK target.',
  equipment_id          STRING NOT NULL
                          COMMENT 'Durable natural/business key for the equipment asset.',

  equipment_name        STRING NOT NULL COMMENT 'Display name of the equipment (e.g. "Walk-in Cooler A", "POS Terminal 3").',
  equipment_type        STRING NOT NULL COMMENT 'Category of equipment. Allowed values: refrigeration, hvac, pos_terminal, self_checkout, oven, lighting, shelving, security, other.',
  manufacturer          STRING COMMENT 'Equipment manufacturer or brand.',
  model_number          STRING COMMENT 'Manufacturer model number.',
  serial_number         STRING COMMENT 'Unique serial number from the manufacturer.',

  store_sk              BIGINT COMMENT 'FK to store.store_sk (version-specific).',
  store_id              STRING NOT NULL COMMENT 'Durable business key of the store where this equipment is installed.',
  installation_zone     STRING COMMENT 'Zone or area within the store. Allowed values: sales_floor, backroom, exterior, loading_dock, office, kitchen, pharmacy.',

  install_date          DATE COMMENT 'Date the equipment was installed or placed in service (ISO 8601).',
  warranty_expiry_date  DATE COMMENT 'Date the manufacturer warranty expires (ISO 8601).',
  expected_lifespan_years INT COMMENT 'Expected useful life of the equipment in years.',
  equipment_status      STRING NOT NULL COMMENT 'Current operational status. Allowed values: operational, degraded, out_of_service, decommissioned.',

  criticality           STRING NOT NULL COMMENT 'Impact level if the equipment fails. Allowed values: critical, high, medium, low.',
  asset_tag             STRING COMMENT 'Internal asset tag or barcode identifier.',

  -- SCD2 versioning (standard A.8)
  effective_from_date   DATE    NOT NULL COMMENT 'SCD2: inclusive start date this version became effective.',
  effective_to_date     DATE             COMMENT 'SCD2: exclusive end date; NULL for the current version.',
  is_current            BOOLEAN NOT NULL COMMENT 'SCD2: TRUE for the currently active version.',

  -- Audit / provenance (master audit block)
  created_timestamp        TIMESTAMP COMMENT 'When the record was created in the source system (UTC, ISO 8601).',
  source_updated_timestamp TIMESTAMP COMMENT 'When the record was last modified in the source system (UTC, ISO 8601).',
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_equipment PRIMARY KEY (equipment_sk)
)
USING DELTA
CLUSTER BY (equipment_id)
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core in-store equipment master dimension (SCD2). Store-level assets requiring maintenance: refrigeration, HVAC, POS, ovens, etc.';

ALTER TABLE ${catalog}.${equipment_schema}.equipment SET TAGS ('dbx_data_type' = 'master');

-- CHECK constraints moved from the CREATE (Databricks does not support
-- inline CHECK; ADD CONSTRAINT is the supported, idempotent form).
ALTER TABLE ${catalog}.${equipment_schema}.equipment ADD CONSTRAINT chk_equipment_type CHECK (equipment_type IN ('refrigeration', 'hvac', 'pos_terminal', 'self_checkout', 'oven', 'lighting', 'shelving', 'security', 'other'));
ALTER TABLE ${catalog}.${equipment_schema}.equipment ADD CONSTRAINT chk_equipment_status CHECK (equipment_status IN ('operational', 'degraded', 'out_of_service', 'decommissioned'));
ALTER TABLE ${catalog}.${equipment_schema}.equipment ADD CONSTRAINT chk_equipment_criticality CHECK (criticality IN ('critical', 'high', 'medium', 'low'));
ALTER TABLE ${catalog}.${equipment_schema}.equipment ADD CONSTRAINT chk_equipment_zone CHECK (installation_zone IS NULL OR installation_zone IN ('sales_floor', 'backroom', 'exterior', 'loading_dock', 'office', 'kitchen', 'pharmacy'));
