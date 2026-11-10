-- ============================================================
-- ORDM · Canonical Core · Logistics domain
-- Table: shipment
-- Layer: canonical core (silver / conformed fact)
-- Version: 0.5
-- Generated: 2026-06-30
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-30 by @sreekanthmunigati
-- ============================================================
-- Shipment / ASN transactional header. One record per shipment,
-- linking a purchase order to a lane and carrier. Shared across
-- early-risk-detection and predictive-operations. The shipment_line
-- child carries item-level detail.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${logistics_schema}.shipment (
  shipment_sk           BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key.',
  shipment_id           STRING NOT NULL
                          COMMENT 'Durable natural/business key for the shipment (ASN number or shipment reference).',

  po_id                 STRING COMMENT 'Purchase-order header business key this shipment fulfills.',
  supplier_sk           BIGINT COMMENT 'FK to supplier.supplier_sk (version-specific).',
  supplier_id           STRING NOT NULL COMMENT 'Durable supplier business key.',
  lane_sk               BIGINT COMMENT 'FK to lane.lane_sk (version-specific).',
  lane_id               STRING COMMENT 'Durable lane business key.',
  destination_store_sk  BIGINT COMMENT 'FK to store.store_sk for the ship-to location (version-specific).',
  destination_store_id  STRING COMMENT 'Durable store business key for the ship-to location.',

  carrier_name          STRING COMMENT 'Carrier or logistics provider name (free text, vendor-neutral).',
  transport_mode        STRING COMMENT 'Transport mode for this shipment. Allowed values: road, rail, ocean, air, intermodal.',
  shipment_status       STRING COMMENT 'Current lifecycle status. Allowed values: planned, in_transit, delivered, cancelled.',

  ship_date             DATE COMMENT 'Date the shipment departed origin (ISO 8601).',
  estimated_arrival_date DATE COMMENT 'Estimated arrival date at destination, set at load time (ISO 8601). Real-time ETA revisions are tracked via shipment_tracking.carrier_eta_date.',
  original_eta_date     DATE COMMENT 'Original ETA at time of dispatch, before any revisions (ISO 8601).',
  actual_arrival_date   DATE COMMENT 'Actual arrival date; NULL if not yet delivered (ISO 8601).',

  -- Audit / provenance (fact audit block)
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_shipment PRIMARY KEY (shipment_sk)
)
USING DELTA
CLUSTER BY (shipment_id, supplier_sk)
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core shipment/ASN transactional header. Links a purchase order to a lane and carrier.';

ALTER TABLE ${catalog}.${logistics_schema}.shipment SET TAGS ('dbx_data_type' = 'transactional');

-- CHECK constraints moved from the CREATE (Databricks does not support
-- inline CHECK; ADD CONSTRAINT is the supported, idempotent form).
ALTER TABLE ${catalog}.${logistics_schema}.shipment ADD CONSTRAINT chk_shipment_transport_mode CHECK (transport_mode IS NULL OR transport_mode IN ('road', 'rail', 'ocean', 'air', 'intermodal'));
ALTER TABLE ${catalog}.${logistics_schema}.shipment ADD CONSTRAINT chk_shipment_status CHECK (shipment_status IS NULL OR shipment_status IN ('planned', 'in_transit', 'delivered', 'cancelled'));
