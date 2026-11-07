-- ============================================================
-- ORDM · Canonical Core · Labor domain
-- File: relationships.sql
-- Version: 0.5
-- Generated: 2026-08-10
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-08-10
-- ============================================================
-- Cross-schema relationships for the labor domain. UC foreign keys
-- are informational (NOT ENFORCED). Run AFTER store exists.
-- ============================================================

-- employee -> store (home store)
ALTER TABLE ${catalog}.${labor_schema}.employee
  ADD CONSTRAINT fk_employee_home_store
  FOREIGN KEY (home_store_sk) REFERENCES ${catalog}.${store_schema}.store (store_sk);

-- employee_skill -> employee
ALTER TABLE ${catalog}.${labor_schema}.employee_skill
  ADD CONSTRAINT fk_emp_skill_employee
  FOREIGN KEY (employee_sk) REFERENCES ${catalog}.${labor_schema}.employee (employee_sk);

-- employee_availability -> employee
ALTER TABLE ${catalog}.${labor_schema}.employee_availability
  ADD CONSTRAINT fk_emp_avail_employee
  FOREIGN KEY (employee_sk) REFERENCES ${catalog}.${labor_schema}.employee (employee_sk);

-- employee_store_eligibility -> employee
ALTER TABLE ${catalog}.${labor_schema}.employee_store_eligibility
  ADD CONSTRAINT fk_emp_store_elig_employee
  FOREIGN KEY (employee_sk) REFERENCES ${catalog}.${labor_schema}.employee (employee_sk);

-- employee_store_eligibility -> store
ALTER TABLE ${catalog}.${labor_schema}.employee_store_eligibility
  ADD CONSTRAINT fk_emp_store_elig_store
  FOREIGN KEY (store_sk) REFERENCES ${catalog}.${store_schema}.store (store_sk);

-- labor_schedule -> employee
ALTER TABLE ${catalog}.${labor_schema}.labor_schedule
  ADD CONSTRAINT fk_ls_employee
  FOREIGN KEY (employee_sk) REFERENCES ${catalog}.${labor_schema}.employee (employee_sk);

-- labor_schedule -> store
ALTER TABLE ${catalog}.${labor_schema}.labor_schedule
  ADD CONSTRAINT fk_ls_store
  FOREIGN KEY (store_sk) REFERENCES ${catalog}.${store_schema}.store (store_sk);

-- labor_actuals -> employee
ALTER TABLE ${catalog}.${labor_schema}.labor_actuals
  ADD CONSTRAINT fk_la_employee
  FOREIGN KEY (employee_sk) REFERENCES ${catalog}.${labor_schema}.employee (employee_sk);

-- labor_actuals -> store
ALTER TABLE ${catalog}.${labor_schema}.labor_actuals
  ADD CONSTRAINT fk_la_store
  FOREIGN KEY (store_sk) REFERENCES ${catalog}.${store_schema}.store (store_sk);

-- labor_actuals -> labor_schedule
ALTER TABLE ${catalog}.${labor_schema}.labor_actuals
  ADD CONSTRAINT fk_la_schedule
  FOREIGN KEY (labor_schedule_sk) REFERENCES ${catalog}.${labor_schema}.labor_schedule (labor_schedule_sk);
