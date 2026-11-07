-- ============================================================
-- ORDM · Canonical Core · Labor domain
-- Table: employee_store_eligibility
-- Layer: canonical core (silver / conformed transactional bridge)
-- Version: 0.5
-- Generated: 2026-08-10
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-08-10
-- ============================================================
-- Optional multi-store eligibility. When rows exist for an employee,
-- scheduling may only assign that employee to listed stores. When no
-- rows exist, the home store on employee is the sole eligible location.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${labor_schema}.employee_store_eligibility (
  employee_store_eligibility_sk BIGINT GENERATED ALWAYS AS IDENTITY
                                  COMMENT 'Surrogate key.',
  employee_store_eligibility_id STRING NOT NULL
                                  COMMENT 'Durable business key (e.g. "<employee_id>|<store_id>").',

  employee_sk           BIGINT COMMENT 'FK to employee.employee_sk (version-specific).',
  employee_id           STRING NOT NULL COMMENT 'Durable pseudonymous employee business key.',
  store_sk              BIGINT COMMENT 'FK to store.store_sk (version-specific).',
  store_id              STRING NOT NULL COMMENT 'Durable store business key the associate may work.',
  is_primary            BOOLEAN NOT NULL COMMENT 'TRUE when this is the primary / home eligibility row.',
  is_active             BOOLEAN NOT NULL COMMENT 'TRUE when the eligibility is currently usable.',
  effective_from_date   DATE NOT NULL COMMENT 'Inclusive eligibility start date.',
  effective_to_date     DATE COMMENT 'Exclusive eligibility end date; NULL while active.',

  record_source         STRING    COMMENT 'Originating system of record.',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded (UTC, ISO 8601).',

  CONSTRAINT pk_employee_store_eligibility PRIMARY KEY (employee_store_eligibility_sk)
)
USING DELTA
CLUSTER BY (employee_id, store_id)
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'Employee × store eligibility bridge for multi-location associates.';

ALTER TABLE ${catalog}.${labor_schema}.employee_store_eligibility SET TAGS ('dbx_data_type' = 'association');
ALTER TABLE ${catalog}.${labor_schema}.employee_store_eligibility ALTER COLUMN employee_id SET TAGS ('dbx_pii_identifier' = 'true');
