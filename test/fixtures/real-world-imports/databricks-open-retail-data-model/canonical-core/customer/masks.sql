-- ============================================================
-- ORDM · Canonical Core · Customer domain · PII column masks
-- Version: 0.5
-- Generated: 2026-06-10
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-10
-- ============================================================
-- ENFORCES the dbx_pii_* tags with Unity Catalog column masks: PII is masked
-- by default and only members of the `pii_readers` group see raw values.
-- Run AFTER the customer tables exist (and grant the group separately). The
-- gold views never expose these columns; this protects the governed dimension
-- itself (defence in depth). One mask function per column type.
-- ============================================================

CREATE OR REPLACE FUNCTION ${catalog}.${customer_schema}.mask_pii_text(val STRING)
  RETURNS STRING
  RETURN CASE WHEN is_account_group_member('pii_readers') THEN val ELSE '***' END;

CREATE OR REPLACE FUNCTION ${catalog}.${customer_schema}.mask_pii_date(val DATE)
  RETURNS DATE
  RETURN CASE WHEN is_account_group_member('pii_readers') THEN val ELSE NULL END;

CREATE OR REPLACE FUNCTION ${catalog}.${customer_schema}.mask_pii_decimal(val DECIMAL(18,2))
  RETURNS DECIMAL(18,2)
  RETURN CASE WHEN is_account_group_member('pii_readers') THEN val ELSE NULL END;

-- profile (names, dob, loyalty / household identifiers)
ALTER TABLE ${catalog}.${customer_schema}.profile ALTER COLUMN first_name    SET MASK ${catalog}.${customer_schema}.mask_pii_text;
ALTER TABLE ${catalog}.${customer_schema}.profile ALTER COLUMN middle_name   SET MASK ${catalog}.${customer_schema}.mask_pii_text;
ALTER TABLE ${catalog}.${customer_schema}.profile ALTER COLUMN last_name     SET MASK ${catalog}.${customer_schema}.mask_pii_text;
ALTER TABLE ${catalog}.${customer_schema}.profile ALTER COLUMN date_of_birth SET MASK ${catalog}.${customer_schema}.mask_pii_date;
ALTER TABLE ${catalog}.${customer_schema}.profile ALTER COLUMN loyalty_id    SET MASK ${catalog}.${customer_schema}.mask_pii_text;
ALTER TABLE ${catalog}.${customer_schema}.profile ALTER COLUMN household_id  SET MASK ${catalog}.${customer_schema}.mask_pii_text;

-- address (postal components)
ALTER TABLE ${catalog}.${customer_schema}.address ALTER COLUMN address_line_1 SET MASK ${catalog}.${customer_schema}.mask_pii_text;
ALTER TABLE ${catalog}.${customer_schema}.address ALTER COLUMN address_line_2 SET MASK ${catalog}.${customer_schema}.mask_pii_text;
ALTER TABLE ${catalog}.${customer_schema}.address ALTER COLUMN city           SET MASK ${catalog}.${customer_schema}.mask_pii_text;
ALTER TABLE ${catalog}.${customer_schema}.address ALTER COLUMN postal_code    SET MASK ${catalog}.${customer_schema}.mask_pii_text;

-- contact (email / phone value)
ALTER TABLE ${catalog}.${customer_schema}.contact ALTER COLUMN contact_value SET MASK ${catalog}.${customer_schema}.mask_pii_text;

-- account (financial-sensitive)
ALTER TABLE ${catalog}.${customer_schema}.account ALTER COLUMN tax_id              SET MASK ${catalog}.${customer_schema}.mask_pii_text;
ALTER TABLE ${catalog}.${customer_schema}.account ALTER COLUMN credit_limit_amount SET MASK ${catalog}.${customer_schema}.mask_pii_decimal;

-- household (grouping identifier)
ALTER TABLE ${catalog}.${customer_schema}.household ALTER COLUMN household_id SET MASK ${catalog}.${customer_schema}.mask_pii_text;

-- identity_link (pseudonymized identifier value)
ALTER TABLE ${catalog}.${customer_schema}.identity_link ALTER COLUMN identifier_value_hash SET MASK ${catalog}.${customer_schema}.mask_pii_text;
