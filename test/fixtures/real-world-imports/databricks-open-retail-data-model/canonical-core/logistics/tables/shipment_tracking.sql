-- ============================================================
-- ORDM · Canonical Core · Logistics domain
-- Table: shipment_tracking
-- Layer: canonical core (silver / conformed fact)
-- Version: 0.5
-- Generated: 2026-06-30
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-30 by @sreekanthmunigati
-- ============================================================
-- Append-only carrier tracking message fact. Each row is one raw
-- tracking checkpoint emitted by a carrier: a scan, a GPS ping,
-- a customs event, a delivery attempt.
-- High-volume, streaming-ready with event_timestamp, ingest_timestamp,
-- and latency_seconds for freshness monitoring.
--
-- This is the canonical source of carrier tracking data, reusable
-- across outcome packages (early-risk-detection, predictive-operations,
-- connected-store-signals). Outcome gold views (e.g.
-- gold_shipment_current_state) derive current state directly from
-- this raw feed.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${logistics_schema}.shipment_tracking (
  shipment_tracking_sk  BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key.',
  shipment_tracking_id  STRING NOT NULL
                          COMMENT 'Durable natural/business key for the tracking message (carrier_code|tracking_number|sequence).',

  shipment_sk           BIGINT COMMENT 'FK to shipment.shipment_sk (version-specific).',
  shipment_id           STRING NOT NULL COMMENT 'Durable shipment business key.',

  -- Carrier details
  carrier_code          STRING NOT NULL COMMENT 'Standardized carrier identifier (e.g. a SCAC or BIC code).',
  carrier_name          STRING COMMENT 'Display name of the carrier.',
  tracking_number       STRING NOT NULL COMMENT 'Carrier-assigned tracking or waybill number.',
  carrier_service_level STRING COMMENT 'Service level (e.g. express, standard, economy, ltl, ftl, ocean_fcl).',

  -- Checkpoint details
  checkpoint_type       STRING NOT NULL COMMENT 'Type of tracking checkpoint. Allowed values: pickup, hub_scan, in_transit, out_for_delivery, delivered, attempted_delivery, customs_entry, customs_release, exception, return_to_sender, info.',
  checkpoint_status_code STRING COMMENT 'Carrier-native status code (free text, carrier-specific).',
  checkpoint_message    STRING COMMENT 'Raw carrier message text describing the event.',

  -- Location
  facility_name         STRING COMMENT 'Name of the facility or hub where the scan occurred.',
  city                  STRING COMMENT 'City of the checkpoint location.',
  state_province        STRING COMMENT 'State or province of the checkpoint location.',
  country_code          STRING COMMENT 'Country of the checkpoint, ISO 3166-1 alpha-2.',
  postal_code           STRING COMMENT 'Postal/ZIP code of the checkpoint location.',
  latitude              DOUBLE COMMENT 'Latitude of the checkpoint location.',
  longitude             DOUBLE COMMENT 'Longitude of the checkpoint location.',

  -- Delivery and signature
  signed_by             STRING COMMENT 'Name of the person who signed for delivery (if delivered).',
  is_signature_required BOOLEAN COMMENT 'Whether signature was required for this shipment (shipment-level attribute, populated on delivered checkpoint only).',
  delivery_location_type STRING COMMENT 'Where delivered. Allowed values: dock, front_door, mailroom, locker, neighbor, other.',

  -- Weight and piece count at scan
  scanned_weight_kg     DECIMAL(10,3) COMMENT 'Weight recorded at this scan point, in kilograms.',
  piece_count           INT COMMENT 'Number of pieces scanned at this checkpoint.',

  -- Exception details (populated when checkpoint_type = exception)
  exception_code        STRING COMMENT 'Carrier exception code (free text, carrier-specific).',
  exception_reason      STRING COMMENT 'Reason for the exception (e.g. address_unknown, refused, damaged, weather_delay).',

  -- Revised ETA from carrier
  carrier_eta_date      DATE COMMENT 'Carrier-provided revised ETA as of this checkpoint (ISO 8601); NULL if not revised.',

  -- Real-time / streaming support
  event_timestamp       TIMESTAMP NOT NULL COMMENT 'When the tracking event occurred at the carrier (UTC, ISO 8601).',
  ingest_timestamp      TIMESTAMP NOT NULL COMMENT 'When this message was ingested into the lakehouse (UTC, ISO 8601).',
  latency_seconds       INT COMMENT 'Ingest latency = ingest_timestamp - event_timestamp, in seconds.',

  -- Audit / provenance (append-only fact block)
  record_source         STRING    COMMENT 'Originating carrier or tracking aggregator (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_shipment_tracking PRIMARY KEY (shipment_tracking_sk)
)
USING DELTA
CLUSTER BY (shipment_sk, event_timestamp)
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core carrier tracking message fact (append-only). Raw checkpoint data from carriers: scans, GPS pings, customs events, delivery confirmations.';

ALTER TABLE ${catalog}.${logistics_schema}.shipment_tracking SET TAGS ('dbx_data_type' = 'transactional');
ALTER TABLE ${catalog}.${logistics_schema}.shipment_tracking ALTER COLUMN signed_by SET TAGS ('dbx_pii_name' = 'true');

-- CHECK constraints moved from the CREATE (Databricks does not support
-- inline CHECK; ADD CONSTRAINT is the supported, idempotent form).
ALTER TABLE ${catalog}.${logistics_schema}.shipment_tracking ADD CONSTRAINT chk_st_checkpoint_type CHECK (checkpoint_type IN ('pickup', 'hub_scan', 'in_transit', 'out_for_delivery', 'delivered', 'attempted_delivery', 'customs_entry', 'customs_release', 'exception', 'return_to_sender', 'info'));
ALTER TABLE ${catalog}.${logistics_schema}.shipment_tracking ADD CONSTRAINT chk_st_delivery_location_type CHECK (delivery_location_type IS NULL OR delivery_location_type IN ('dock', 'front_door', 'mailroom', 'locker', 'neighbor', 'other'));
