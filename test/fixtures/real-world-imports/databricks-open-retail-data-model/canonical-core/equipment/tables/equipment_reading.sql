-- ============================================================
-- ORDM · Canonical Core · Equipment domain
-- Table: equipment_reading
-- Layer: canonical core (silver / conformed fact)
-- Version: 0.5
-- Generated: 2026-07-15
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-07-15 by @sreekanthmunigati
-- ============================================================
-- Append-only telemetry/sensor reading fact. Each row is one
-- reading from an equipment sensor: temperature, power draw,
-- vibration, error code, or runtime hours. High-volume,
-- streaming-ready with event_timestamp, ingest_timestamp,
-- and latency_seconds for freshness monitoring.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${equipment_schema}.equipment_reading (
  equipment_reading_sk  BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key.',
  equipment_reading_id  STRING NOT NULL
                          COMMENT 'Durable natural/business key (equipment_id|reading_type|sequence). Row grain is one sensor reading; sequence disambiguates successive readings of the same (equipment_id, reading_type).',

  equipment_sk          BIGINT COMMENT 'FK to equipment.equipment_sk (version-specific).',
  equipment_id          STRING NOT NULL COMMENT 'Durable equipment business key.',

  reading_type          STRING NOT NULL COMMENT 'Type of sensor reading. Allowed values: temperature, humidity, power_kw, vibration, runtime_hours, error_code, door_open_count, pressure.',
  reading_value         DOUBLE COMMENT 'Numeric value of the reading (units depend on reading_type).',
  reading_unit          STRING COMMENT 'Unit of measure (e.g. celsius, fahrenheit, kw, mm_s, hours, count, psi).',
  error_code            STRING COMMENT 'Equipment error or fault code (populated when reading_type = error_code).',
  error_message         STRING COMMENT 'Human-readable description of the error code.',

  is_anomaly            BOOLEAN COMMENT 'Whether this reading was flagged as anomalous by the ingestion pipeline.',
  threshold_breached    STRING COMMENT 'Which threshold was breached, if any. Allowed values: low, high, critical_low, critical_high.',

  -- Timestamps (append-only streaming audit block)
  event_timestamp       TIMESTAMP NOT NULL COMMENT 'When the reading was captured at the sensor (UTC, ISO 8601).',
  ingest_timestamp      TIMESTAMP COMMENT 'When this reading was ingested into the lakehouse (UTC, ISO 8601).',
  latency_seconds       INT COMMENT 'Seconds between event_timestamp and ingest_timestamp.',

  -- Audit / provenance
  record_source         STRING    COMMENT 'Originating system or IoT platform.',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded (UTC, ISO 8601).',

  CONSTRAINT pk_equipment_reading PRIMARY KEY (equipment_reading_sk)
)
USING DELTA
CLUSTER BY (equipment_id, reading_type)
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core equipment sensor readings (append-only). Telemetry from in-store assets: temperature, power, vibration, error codes.';

ALTER TABLE ${catalog}.${equipment_schema}.equipment_reading SET TAGS ('dbx_data_type' = 'transactional');

ALTER TABLE ${catalog}.${equipment_schema}.equipment_reading ADD CONSTRAINT chk_reading_type CHECK (reading_type IN ('temperature', 'humidity', 'power_kw', 'vibration', 'runtime_hours', 'error_code', 'door_open_count', 'pressure'));
ALTER TABLE ${catalog}.${equipment_schema}.equipment_reading ADD CONSTRAINT chk_threshold_breached CHECK (threshold_breached IS NULL OR threshold_breached IN ('low', 'high', 'critical_low', 'critical_high'));
