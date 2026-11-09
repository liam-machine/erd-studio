CREATE TABLE raw_pos.refunds (
  refund_id BIGINT NOT NULL COMMENT 'Refund number',
  txn_id BIGINT COMMENT 'Transaction refunded',
  refunded_at TIMESTAMP COMMENT 'When the money went back',
  amount DECIMAL(12,2) COMMENT 'Amount refunded, tax included',
  CONSTRAINT refunds_pk PRIMARY KEY (refund_id),
  CONSTRAINT refunds_txn_fk FOREIGN KEY (txn_id) REFERENCES raw_pos.transactions (txn_id)
)
COMMENT 'One row per refund given at a register';
