-- ============================================================
-- ORDM · Canonical Core · Labor domain
-- Table: employee_availability
-- Layer: canonical core (silver / conformed transactional)
-- Version: 0.5
-- Generated: 2026-08-10
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-08-10
-- ============================================================
-- Associate availability windows (store-local civil time expressed as
-- UTC timestamps). Schedulers must not assign outside these windows
-- when availability rows exist for the date.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${labor_schema}.employee_availability (
  employee_availability_sk BIGINT GENERATED ALWAYS AS IDENTITY
                             COMMENT 'Surrogate key.',
  employee_availability_id STRING NOT NULL
                             COMMENT 'Durable business key for the availability window.',

  employee_sk           BIGINT COMMENT 'FK to employee.employee_sk (version-specific).',
  employee_id           STRING NOT NULL COMMENT 'Durable pseudonymous employee business key.',
  availability_date     DATE   NOT NULL COMMENT 'Local business date the window applies to (ISO 8601).',
  available_start_ts    TIMESTAMP NOT NULL COMMENT 'Inclusive availability start (UTC, ISO 8601).',
  available_end_ts      TIMESTAMP NOT NULL COMMENT 'Exclusive availability end (UTC, ISO 8601).',
  is_available          BOOLEAN NOT NULL COMMENT 'TRUE = can work this window; FALSE = explicitly unavailable (e.g. PTO block).',
  availability_type     STRING
                          COMMENT 'Window type. Allowed values: preferred, available, unavailable, time_off.',

  record_source         STRING    COMMENT 'Originating system of record.',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded (UTC, ISO 8601).',

  CONSTRAINT pk_employee_availability PRIMARY KEY (employee_availability_sk)
)
USING DELTA
CLUSTER BY (employee_id, availability_date)
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'Associate availability and time-off windows. end must be after start; used as hard constraints by the schedule recommender.';

ALTER TABLE ${catalog}.${labor_schema}.employee_availability SET TAGS ('dbx_data_type' = 'transactional');
ALTER TABLE ${catalog}.${labor_schema}.employee_availability ALTER COLUMN employee_id SET TAGS ('dbx_pii_identifier' = 'true');

ALTER TABLE ${catalog}.${labor_schema}.employee_availability ADD CONSTRAINT chk_emp_avail_type CHECK (availability_type IS NULL OR availability_type IN ('preferred', 'available', 'unavailable', 'time_off'));
ALTER TABLE ${catalog}.${labor_schema}.employee_availability ADD CONSTRAINT chk_emp_avail_order CHECK (available_end_ts > available_start_ts);
