CREATE TABLE raw_pos.transactions (
  txn_id BIGINT NOT NULL COMMENT 'Register transaction number',
  store_id INT COMMENT 'Store the register is in',
  txn_ts TIMESTAMP COMMENT 'When it was rung up',
  loyalty_no STRING COMMENT 'Loyalty card scanned, if any',
  tender STRING COMMENT 'cash, card or voucher',
  total_gross DECIMAL(12,2) COMMENT 'Amount paid, tax included',
  CONSTRAINT txn_pk PRIMARY KEY (txn_id),
  CONSTRAINT txn_store_fk FOREIGN KEY (store_id) REFERENCES ref.stores (store_id)
)
COMMENT 'One row per register transaction';
