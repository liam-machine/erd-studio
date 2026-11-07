-- ============================================================
-- ORDM · Canonical Core · Procurement domain
-- Table: purchase_order_line
-- Layer: canonical core (silver / conformed fact)
-- Version: 0.5
-- Generated: 2026-06-09
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-09
-- ============================================================
-- Purchase-order line fact at the order-line grain. One consolidated line
-- carries the ordering, receipt/delivery and defect/return facts plus the
-- invoiced vs contract price, which is sufficient for period-grain supplier
-- KPIs (OTIF, fill rate, lead time, defect rate, price compliance). Keys are
-- conformed to the supplier, product and store dimensions; order_date joins
-- the NRF 4-5-4 fiscal calendar for the fiscal period.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${procurement_schema}.purchase_order_line (
  po_line_sk            BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key.',
  po_line_id            STRING NOT NULL
                          COMMENT 'Durable natural/business key for the purchase-order line.',
  po_id                 STRING COMMENT 'Purchase-order header business key (a PO groups several lines).',

  supplier_sk           BIGINT COMMENT 'FK to supplier.supplier_sk (version-specific).',
  supplier_id           STRING NOT NULL COMMENT 'Durable supplier business key.',
  product_sk            BIGINT COMMENT 'FK to product.product_sk (version-specific).',
  product_id            STRING NOT NULL COMMENT 'Durable product business key.',
  store_sk              BIGINT COMMENT 'FK to store.store_sk (ship-to location, version-specific).',
  store_id              STRING NOT NULL COMMENT 'Durable store business key (ship-to location).',

  order_date            DATE COMMENT 'Date the line was ordered. FK to fiscal_calendar.date_key (ISO 8601).',
  promised_date         DATE COMMENT 'Supplier-promised delivery date (ISO 8601).',
  actual_delivery_date  DATE COMMENT 'Actual delivery/receipt date (ISO 8601); NULL if not yet received.',

  ordered_qty           INT COMMENT 'Quantity ordered (units).',
  received_qty          INT COMMENT 'Quantity actually received (units).',
  defective_qty         INT COMMENT 'Units received defective.',
  returned_qty          INT COMMENT 'Units returned to the supplier.',

  unit_price            DECIMAL(18,4) COMMENT 'Invoiced unit price, in the reporting/base currency. Unit-grain price: DECIMAL(18,4) (principle #9d).',
  contract_price        DECIMAL(18,4) COMMENT 'Agreed contract unit price (basis for price compliance), in the reporting/base currency. Unit-grain price: DECIMAL(18,4) (principle #9d).',
  currency_code         STRING        COMMENT 'Reporting/base currency of ALL monetary columns, ISO 4217 alpha-3. Equals the deploy base_currency; the canonical core is single-currency by construction.',
  transaction_currency_code STRING    COMMENT 'Original purchasing currency before normalization (lineage only), ISO 4217 alpha-3. Convert with fx_rate.',
  order_status          STRING        COMMENT 'Line status. Allowed values: open, received, closed, cancelled.',

  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'Timestamp this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_purchase_order_line PRIMARY KEY (po_line_sk)
)
USING DELTA
CLUSTER BY (supplier_sk, product_sk, order_date)
-- Deletion vectors speed row-level MERGE/UPDATE (SCD2 version closes, corrections).
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core purchase-order line fact (order + receipt + defect + price). Feeds the supplier scorecard.';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${procurement_schema}.purchase_order_line SET TAGS ('dbx_data_type' = 'transactional');
