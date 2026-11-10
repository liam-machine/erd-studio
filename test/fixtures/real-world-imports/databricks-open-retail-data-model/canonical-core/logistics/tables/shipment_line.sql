-- ============================================================
-- ORDM · Canonical Core · Logistics domain
-- Table: shipment_line
-- Layer: canonical core (silver / conformed fact)
-- Version: 0.5
-- Generated: 2026-06-30
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-30 by @sreekanthmunigati
-- ============================================================
-- Shipment line fact at the shipment-product grain. Each row is one
-- product line within a shipment, linking to the product dimension
-- and the parent shipment. Append-only; does not carry SCD2 columns.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${logistics_schema}.shipment_line (
  shipment_line_sk      BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key.',
  shipment_line_id      STRING NOT NULL
                          COMMENT 'Durable natural/business key for the shipment line.',

  shipment_sk           BIGINT COMMENT 'FK to shipment.shipment_sk (version-specific).',
  shipment_id           STRING NOT NULL COMMENT 'Durable shipment business key.',
  product_sk            BIGINT COMMENT 'FK to product.product_sk (version-specific).',
  product_id            STRING NOT NULL COMMENT 'Durable product business key.',
  po_line_sk            BIGINT COMMENT 'FK to purchase_order_line.po_line_sk (foreign surrogate; nullable, not a PK). The purchase-order line this shipment line fulfills. purchase_order_line is an append-only transactional fact (NOT SCD2), so this is a straight surrogate FK with no version ambiguity. Declared as informational FK fk_shipment_line_purchase_order_line in relationships.sql; the durable po_line_id business key is retained below.',
  po_line_id            STRING COMMENT 'Durable purchase-order line business key this shipment line fulfills. Retained alongside po_line_sk; the declared UC FK is on the surrogate.',

  shipped_quantity      INT NOT NULL COMMENT 'Units shipped on this line.',
  received_quantity     INT COMMENT 'Units actually received; NULL if not yet delivered.',
  damaged_quantity      INT COMMENT 'Units received damaged.',

  unit_weight_kg        DECIMAL(10,3) COMMENT 'Weight per unit in kilograms.',
  line_weight_kg        DECIMAL(12,3) COMMENT 'Total line weight in kilograms.',

  -- Audit / provenance (fact audit block)
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_shipment_line PRIMARY KEY (shipment_line_sk)
)
USING DELTA
CLUSTER BY (shipment_sk, product_sk)
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core shipment line fact (shipment x product). Item-level detail within a shipment.';

ALTER TABLE ${catalog}.${logistics_schema}.shipment_line SET TAGS ('dbx_data_type' = 'transactional');
