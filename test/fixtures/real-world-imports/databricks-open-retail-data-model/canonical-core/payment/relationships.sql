-- ============================================================
-- ORDM · Canonical Core · Payment domain · relationships
-- Version: 0.5 · Generated: 2026-06-10 · LLM-generated: true · Reviewed: 2026-06-10
-- ============================================================

-- Informational FK (NOT ENFORCED) to the customer dimension.
ALTER TABLE ${catalog}.${payment_schema}.payment
  ADD CONSTRAINT fk_payment_profile FOREIGN KEY (profile_sk)
  REFERENCES ${catalog}.${customer_schema}.profile (profile_sk) NOT ENFORCED;

-- ------------------------------------------------------------
-- Logical relationship on a non-PK key (NOT a declared UC FK):
--   payment.order_id -> customer_order_line.order_id
-- Join on order_id to reconcile tender/settlement against the order lines.
-- ------------------------------------------------------------

-- ENFORCED Delta CHECK constraints (always-on; enum/state + magnitude).
ALTER TABLE ${catalog}.${payment_schema}.payment
  ADD CONSTRAINT chk_payment_type
  CHECK (payment_type IN ('sale', 'refund', 'adjustment', 'chargeback'));

ALTER TABLE ${catalog}.${payment_schema}.payment
  ADD CONSTRAINT chk_payment_method
  CHECK (payment_method IS NULL OR payment_method IN ('card', 'cash', 'wallet', 'bank_transfer', 'gift_card', 'voucher'));

ALTER TABLE ${catalog}.${payment_schema}.payment
  ADD CONSTRAINT chk_payment_status
  CHECK (payment_status IS NULL OR payment_status IN ('authorized', 'captured', 'settled', 'declined', 'refunded', 'voided'));

ALTER TABLE ${catalog}.${payment_schema}.payment
  ADD CONSTRAINT chk_payment_amount_nonnegative
  CHECK (amount >= 0);
