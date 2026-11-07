-- ============================================================
-- ORDM · Canonical Core · Logistics domain
-- Table: lane
-- Layer: canonical core (silver / conformed dimension)
-- Version: 0.5
-- Generated: 2026-06-30
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-30 by @sreekanthmunigati
-- ============================================================
-- Origin-to-destination lane dimension (SCD2). A lane is a directed
-- route between two locations (supplier site, DC, store, port) used
-- for shipment planning and transit-time benchmarking. Shared across
-- early-risk-detection, predictive-operations, and smarter-demand
-- outcome packages.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${logistics_schema}.lane (
  lane_sk               BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key. Unique per SCD2 version; the join/FK target.',
  lane_id               STRING NOT NULL
                          COMMENT 'Durable natural/business key for the lane (origin|destination|mode).',

  origin_location_id    STRING NOT NULL COMMENT 'Business key of the origin location (store, DC, supplier site).',
  origin_location_name  STRING COMMENT 'Display name of the origin.',
  origin_country_code   STRING COMMENT 'Origin country, ISO 3166-1 alpha-2.',
  origin_location_type  STRING COMMENT 'Type of origin. Allowed values: supplier_site, distribution_center, port, store, warehouse.',

  destination_location_id   STRING NOT NULL COMMENT 'Business key of the destination location.',
  destination_location_name STRING COMMENT 'Display name of the destination.',
  destination_country_code  STRING COMMENT 'Destination country, ISO 3166-1 alpha-2.',
  destination_location_type STRING COMMENT 'Type of destination. Allowed values: distribution_center, store, port, warehouse, customer.',

  transport_mode        STRING COMMENT 'Primary transport mode. Allowed values: road, rail, ocean, air, intermodal.',
  planned_transit_days  INT COMMENT 'Standard planned transit time for this lane (calendar days).',
  distance_km           DECIMAL(10,2) COMMENT 'Approximate distance in kilometers.',
  is_active             BOOLEAN COMMENT 'Whether the lane is actively used for shipment planning.',

  -- SCD2 versioning (standard A.8)
  effective_from_date   DATE    NOT NULL COMMENT 'SCD2: inclusive start date this version became effective.',
  effective_to_date     DATE             COMMENT 'SCD2: exclusive end date; NULL for the current version.',
  is_current            BOOLEAN NOT NULL COMMENT 'SCD2: TRUE for the currently active version.',

  -- Audit / provenance (master audit block)
  created_timestamp        TIMESTAMP COMMENT 'When the record was created in the source system (UTC, ISO 8601).',
  source_updated_timestamp TIMESTAMP COMMENT 'When the record was last modified in the source system (UTC, ISO 8601).',
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_lane PRIMARY KEY (lane_sk)
)
USING DELTA
CLUSTER BY (lane_id)
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core origin-to-destination lane dimension (SCD2). Directed route used for shipment planning and transit-time benchmarking.';

ALTER TABLE ${catalog}.${logistics_schema}.lane SET TAGS ('dbx_data_type' = 'master');

-- CHECK constraints moved from the CREATE (Databricks does not support
-- inline CHECK; ADD CONSTRAINT is the supported, idempotent form).
ALTER TABLE ${catalog}.${logistics_schema}.lane ADD CONSTRAINT chk_lane_origin_type CHECK (origin_location_type IS NULL OR origin_location_type IN ('supplier_site', 'distribution_center', 'port', 'store', 'warehouse'));
ALTER TABLE ${catalog}.${logistics_schema}.lane ADD CONSTRAINT chk_lane_destination_type CHECK (destination_location_type IS NULL OR destination_location_type IN ('distribution_center', 'store', 'port', 'warehouse', 'customer'));
ALTER TABLE ${catalog}.${logistics_schema}.lane ADD CONSTRAINT chk_lane_transport_mode CHECK (transport_mode IS NULL OR transport_mode IN ('road', 'rail', 'ocean', 'air', 'intermodal'));
