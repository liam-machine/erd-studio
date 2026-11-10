-- ============================================================
-- ORDM · Canonical Core · Logistics domain
-- File: relationships.sql
-- Version: 0.5
-- Generated: 2026-06-30
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-30 by @sreekanthmunigati
-- ============================================================
-- Cross-schema relationships for the logistics domain. UC foreign
-- keys are informational (NOT ENFORCED) and reference the parent
-- surrogate PK. Run AFTER supplier, product, store, and lane exist.
-- ============================================================

-- shipment -> supplier
ALTER TABLE ${catalog}.${logistics_schema}.shipment
  ADD CONSTRAINT fk_shipment_supplier
  FOREIGN KEY (supplier_sk) REFERENCES ${catalog}.${supplier_schema}.supplier (supplier_sk);

-- shipment -> lane
ALTER TABLE ${catalog}.${logistics_schema}.shipment
  ADD CONSTRAINT fk_shipment_lane
  FOREIGN KEY (lane_sk) REFERENCES ${catalog}.${logistics_schema}.lane (lane_sk);

-- shipment -> store (destination)
ALTER TABLE ${catalog}.${logistics_schema}.shipment
  ADD CONSTRAINT fk_shipment_store
  FOREIGN KEY (destination_store_sk) REFERENCES ${catalog}.${store_schema}.store (store_sk);

-- shipment_line -> shipment
ALTER TABLE ${catalog}.${logistics_schema}.shipment_line
  ADD CONSTRAINT fk_shipment_line_shipment
  FOREIGN KEY (shipment_sk) REFERENCES ${catalog}.${logistics_schema}.shipment (shipment_sk);

-- shipment_line -> product
ALTER TABLE ${catalog}.${logistics_schema}.shipment_line
  ADD CONSTRAINT fk_shipment_line_product
  FOREIGN KEY (product_sk) REFERENCES ${catalog}.${product_schema}.product (product_sk);

-- shipment_line -> purchase_order_line (the PO line this shipment line fulfills).
-- purchase_order_line is an append-only transactional fact (NOT SCD2), so this is
-- a straight surrogate FK with no version ambiguity; po_line_id is retained on the
-- child for the durable business-key join.
ALTER TABLE ${catalog}.${logistics_schema}.shipment_line
  ADD CONSTRAINT fk_shipment_line_purchase_order_line
  FOREIGN KEY (po_line_sk) REFERENCES ${catalog}.${procurement_schema}.purchase_order_line (po_line_sk);

-- shipment_tracking -> shipment
ALTER TABLE ${catalog}.${logistics_schema}.shipment_tracking
  ADD CONSTRAINT fk_shipment_tracking_shipment
  FOREIGN KEY (shipment_sk) REFERENCES ${catalog}.${logistics_schema}.shipment (shipment_sk);

-- ENFORCED Delta CHECK constraints
ALTER TABLE ${catalog}.${logistics_schema}.shipment_line
  ADD CONSTRAINT chk_shipment_line_quantities
  CHECK (shipped_quantity >= 0
     AND (received_quantity IS NULL OR received_quantity >= 0)
     AND (damaged_quantity IS NULL OR damaged_quantity >= 0));

ALTER TABLE ${catalog}.${logistics_schema}.lane
  ADD CONSTRAINT chk_lane_transit_days
  CHECK (planned_transit_days IS NULL OR planned_transit_days >= 0);
