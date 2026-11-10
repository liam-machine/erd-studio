-- ============================================================
-- ORDM · Canonical Core · Labor domain
-- Table: labor_schedule
-- Layer: canonical core (silver / conformed transactional)
-- Version: 0.5
-- Generated: 2026-08-10
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-08-10
-- ============================================================
-- Planned / published shift schedule. Existing scheduled shifts are
-- hard constraints for the recommender (do not double-book). Timestamps
-- are UTC; store-local interpretation uses store timezone outside ORDM.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${labor_schema}.labor_schedule (
  labor_schedule_sk     BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key.',
  labor_schedule_id     STRING NOT NULL
                          COMMENT 'Durable business key for the scheduled shift.',

  employee_sk           BIGINT COMMENT 'FK to employee.employee_sk (version-specific).',
  employee_id           STRING NOT NULL COMMENT 'Durable pseudonymous employee business key.',
  store_sk              BIGINT COMMENT 'FK to store.store_sk (version-specific).',
  store_id              STRING NOT NULL COMMENT 'Durable store business key where the shift is worked.',

  role_code             STRING NOT NULL
                          COMMENT 'Role for the shift. Allowed values: cashier, sales_associate, fulfillment, inventory, supervisor.',
  department_or_zone    STRING
                          COMMENT 'Department or zone label (e.g. front_end, grocery, backroom, storewide). Free STRING; common values include storewide, front_end, grocery, general_merchandise, backroom.',
  business_date         DATE NOT NULL COMMENT 'Local business date of the shift (ISO 8601).',
  shift_start_ts        TIMESTAMP NOT NULL COMMENT 'Inclusive shift start (UTC, ISO 8601).',
  shift_end_ts          TIMESTAMP NOT NULL COMMENT 'Exclusive shift end (UTC, ISO 8601).',
  scheduled_hours       DECIMAL(8,2) NOT NULL COMMENT 'Scheduled duration in hours (must be non-negative).',
  schedule_status       STRING NOT NULL
                          COMMENT 'Status. Allowed values: draft, published, cancelled.',
  schedule_source       STRING
                          COMMENT 'Origin. Allowed values: workforce_system, manager, recommendation_accepted, other.',

  record_source         STRING    COMMENT 'Originating system of record.',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded (UTC, ISO 8601).',

  CONSTRAINT pk_labor_schedule PRIMARY KEY (labor_schedule_sk)
)
USING DELTA
CLUSTER BY (store_id, business_date)
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'Planned associate shifts. end after start; used as supply baseline and double-booking constraint.';

ALTER TABLE ${catalog}.${labor_schema}.labor_schedule SET TAGS ('dbx_data_type' = 'transactional');
ALTER TABLE ${catalog}.${labor_schema}.labor_schedule ALTER COLUMN employee_id SET TAGS ('dbx_pii_identifier' = 'true');

ALTER TABLE ${catalog}.${labor_schema}.labor_schedule ADD CONSTRAINT chk_ls_role CHECK (role_code IN ('cashier', 'sales_associate', 'fulfillment', 'inventory', 'supervisor'));
ALTER TABLE ${catalog}.${labor_schema}.labor_schedule ADD CONSTRAINT chk_ls_status CHECK (schedule_status IN ('draft', 'published', 'cancelled'));
ALTER TABLE ${catalog}.${labor_schema}.labor_schedule ADD CONSTRAINT chk_ls_source CHECK (schedule_source IS NULL OR schedule_source IN ('workforce_system', 'manager', 'recommendation_accepted', 'other'));
ALTER TABLE ${catalog}.${labor_schema}.labor_schedule ADD CONSTRAINT chk_ls_order CHECK (shift_end_ts > shift_start_ts);
ALTER TABLE ${catalog}.${labor_schema}.labor_schedule ADD CONSTRAINT chk_ls_hours CHECK (scheduled_hours >= 0);
