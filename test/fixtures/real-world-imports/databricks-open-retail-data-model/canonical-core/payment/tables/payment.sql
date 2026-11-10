-- ============================================================
-- ORDM · Canonical Core · Payment domain
-- Table: payment
-- Layer: canonical core (silver / conformed fact)
-- Version: 0.5
-- Generated: 2026-06-10
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-10
-- ============================================================
-- Payment-event fact at transaction grain — the tender/settlement side of a
-- customer order, plus refunds, adjustments and chargebacks. One conformed
-- fact covers all four via payment_type, so the financial lifecycle of an
-- order is first-class without a table per event. Keyed to the order
-- (order_id) and the customer (profile). Append-only event log: each row
-- carries its own event_timestamp (the intraday instant, UTC) — there is no
-- SCD2 here. amount is the magnitude in the reporting/base currency;
-- payment_type carries the direction (sale = inflow, refund/chargeback = outflow).
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${payment_schema}.payment (
  payment_sk            BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key.',
  payment_id            STRING NOT NULL
                          COMMENT 'Durable natural/business key for the payment event.',
  order_id              STRING COMMENT 'FK to customer_order_line.order_id (the order this payment settles).',

  profile_sk            BIGINT COMMENT 'FK to profile.profile_sk (version-specific).',
  profile_id            STRING NOT NULL COMMENT 'Durable customer business key (pseudonymous; not direct PII).',

  payment_type          STRING COMMENT 'Direction/kind of the event. Allowed values: sale, refund, adjustment, chargeback.',
  payment_method        STRING COMMENT 'Tender used. Allowed values: card, cash, wallet, bank_transfer, gift_card, voucher.',
  payment_status        STRING COMMENT 'Settlement status. Allowed values: authorized, captured, settled, declined, refunded, voided.',

  amount                DECIMAL(18,2) COMMENT 'Event amount (magnitude, >= 0), in the reporting/base currency. payment_type carries the direction.',
  currency_code         STRING        COMMENT 'Reporting/base currency of ALL monetary columns, ISO 4217 alpha-3. Equals the deploy base_currency; single-currency by construction.',
  transaction_currency_code STRING    COMMENT 'Original tender currency before normalization (lineage only), ISO 4217 alpha-3. Convert with fx_rate.',

  event_timestamp       TIMESTAMP COMMENT 'Instant the payment event occurred (UTC, ISO 8601) — the event-time, distinct from load_timestamp (processing-time).',

  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_payment PRIMARY KEY (payment_sk)
)
USING DELTA
-- Cluster on profile_sk (per-customer payment history) and event time (range
-- pruning); order-independent under Liquid Clustering.
CLUSTER BY (profile_sk, event_timestamp)
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core payment fact (sale / refund / adjustment / chargeback). Tender + settlement side of customer orders.';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${payment_schema}.payment SET TAGS ('dbx_data_type' = 'transactional');
