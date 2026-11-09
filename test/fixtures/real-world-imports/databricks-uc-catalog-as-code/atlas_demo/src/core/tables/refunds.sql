CREATE TABLE core.refunds (
  refund_id BIGINT NOT NULL COMMENT 'Refund number',
  order_key STRING COMMENT 'The order refunded',
  refunded_at TIMESTAMP COMMENT 'When the money went back',
  amount DECIMAL(12,2) COMMENT 'Amount refunded, tax included',
  CONSTRAINT core_refunds_pk PRIMARY KEY (refund_id),
  CONSTRAINT core_refunds_order_fk FOREIGN KEY (order_key) REFERENCES core.orders (order_key)
)
COMMENT 'One row per refund';
