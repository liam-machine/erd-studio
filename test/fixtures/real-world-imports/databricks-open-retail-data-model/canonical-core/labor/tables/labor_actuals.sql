-- ============================================================
-- ORDM · Canonical Core · Labor domain
-- Table: labor_actuals
-- Layer: canonical core (silver / conformed transactional)
-- Version: 0.5
-- Generated: 2026-08-10
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-08-10
-- ============================================================
-- Worked / timecard intervals. Used for schedule adherence and
-- historical staffing actuals feeding labor risk.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${labor_schema}.labor_actuals (
  labor_actuals_sk      BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key.',
  labor_actuals_id      STRING NOT NULL
                          COMMENT 'Durable business key for the worked interval.',

  employee_sk           BIGINT COMMENT 'FK to employee.employee_sk (version-specific).',
  employee_id           STRING NOT NULL COMMENT 'Durable pseudonymous employee business key.',
  store_sk              BIGINT COMMENT 'FK to store.store_sk (version-specific).',
  store_id              STRING NOT NULL COMMENT 'Durable store business key where time was worked.',
  labor_schedule_sk     BIGINT COMMENT 'FK to labor_schedule.labor_schedule_sk when the punch maps to a planned shift.',
  labor_schedule_id     STRING COMMENT 'Durable schedule business key when mapped.',

  role_code             STRING NOT NULL
                          COMMENT 'Role worked. Allowed values: cashier, sales_associate, fulfillment, inventory, supervisor.',
  department_or_zone    STRING COMMENT 'Department or zone worked (free STRING; common values include storewide, front_end, grocery, backroom).',
  business_date         DATE NOT NULL COMMENT 'Local business date of the worked interval (ISO 8601).',
  clock_in_ts           TIMESTAMP NOT NULL COMMENT 'Inclusive clock-in (UTC, ISO 8601).',
  clock_out_ts          TIMESTAMP NOT NULL COMMENT 'Exclusive clock-out (UTC, ISO 8601).',
  worked_hours          DECIMAL(8,2) NOT NULL COMMENT 'Paid / worked hours for the interval (non-negative).',
  actuals_status        STRING NOT NULL
                          COMMENT 'Status. Allowed values: approved, pending, rejected, adjusted.',

  record_source         STRING    COMMENT 'Originating system of record.',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded (UTC, ISO 8601).',

  CONSTRAINT pk_labor_actuals PRIMARY KEY (labor_actuals_sk)
)
USING DELTA
CLUSTER BY (store_id, business_date)
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'Worked timecard intervals for associates. end after start; feeds adherence and labor-risk actuals.';

ALTER TABLE ${catalog}.${labor_schema}.labor_actuals SET TAGS ('dbx_data_type' = 'transactional');
ALTER TABLE ${catalog}.${labor_schema}.labor_actuals ALTER COLUMN employee_id SET TAGS ('dbx_pii_identifier' = 'true');

ALTER TABLE ${catalog}.${labor_schema}.labor_actuals ADD CONSTRAINT chk_la_role CHECK (role_code IN ('cashier', 'sales_associate', 'fulfillment', 'inventory', 'supervisor'));
ALTER TABLE ${catalog}.${labor_schema}.labor_actuals ADD CONSTRAINT chk_la_status CHECK (actuals_status IN ('approved', 'pending', 'rejected', 'adjusted'));
ALTER TABLE ${catalog}.${labor_schema}.labor_actuals ADD CONSTRAINT chk_la_order CHECK (clock_out_ts > clock_in_ts);
ALTER TABLE ${catalog}.${labor_schema}.labor_actuals ADD CONSTRAINT chk_la_hours CHECK (worked_hours >= 0);
