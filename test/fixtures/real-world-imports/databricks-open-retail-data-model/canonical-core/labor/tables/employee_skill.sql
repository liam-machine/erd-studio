-- ============================================================
-- ORDM · Canonical Core · Labor domain
-- Table: employee_skill
-- Layer: canonical core (silver / conformed transactional bridge)
-- Version: 0.5
-- Generated: 2026-08-10
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-08-10
-- ============================================================
-- Associate skill / qualification eligibility. A row asserts the
-- employee may be scheduled into roles requiring that skill_code.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${labor_schema}.employee_skill (
  employee_skill_sk     BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key.',
  employee_skill_id     STRING NOT NULL
                          COMMENT 'Durable business key (e.g. "<employee_id>|<skill_code>").',

  employee_sk           BIGINT COMMENT 'FK to employee.employee_sk (version-specific).',
  employee_id           STRING NOT NULL COMMENT 'Durable pseudonymous employee business key.',
  skill_code            STRING NOT NULL
                          COMMENT 'Skill / qualification code. Allowed values: cashier, sales_associate, fulfillment, inventory, supervisor, food_handler, pharmacy_tech.',
  proficiency_level     STRING
                          COMMENT 'Proficiency. Allowed values: trainee, qualified, expert.',
  is_active             BOOLEAN NOT NULL COMMENT 'TRUE when the skill is currently usable for scheduling.',
  effective_from_date   DATE NOT NULL COMMENT 'Inclusive date the skill became effective.',
  effective_to_date     DATE COMMENT 'Exclusive end date; NULL while active.',

  record_source         STRING    COMMENT 'Originating system of record.',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded (UTC, ISO 8601).',

  CONSTRAINT pk_employee_skill PRIMARY KEY (employee_skill_sk)
)
USING DELTA
CLUSTER BY (employee_id, skill_code)
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'Associate skill eligibility bridge. Role scheduling must not assign an employee lacking the required skill_code.';

ALTER TABLE ${catalog}.${labor_schema}.employee_skill SET TAGS ('dbx_data_type' = 'association');
ALTER TABLE ${catalog}.${labor_schema}.employee_skill ALTER COLUMN employee_id SET TAGS ('dbx_pii_identifier' = 'true');

ALTER TABLE ${catalog}.${labor_schema}.employee_skill ADD CONSTRAINT chk_emp_skill_code CHECK (skill_code IN ('cashier', 'sales_associate', 'fulfillment', 'inventory', 'supervisor', 'food_handler', 'pharmacy_tech'));
ALTER TABLE ${catalog}.${labor_schema}.employee_skill ADD CONSTRAINT chk_emp_skill_level CHECK (proficiency_level IS NULL OR proficiency_level IN ('trainee', 'qualified', 'expert'));
