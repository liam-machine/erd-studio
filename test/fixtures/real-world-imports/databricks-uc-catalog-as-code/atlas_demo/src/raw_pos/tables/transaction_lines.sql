CREATE TABLE raw_pos.transaction_lines (
  txn_id BIGINT NOT NULL COMMENT 'Register transaction number',
  line_no INT NOT NULL COMMENT 'Position on the receipt',
  sku STRING COMMENT 'Product sold',
  qty INT COMMENT 'Units sold',
  unit_price DECIMAL(10,2) COMMENT 'Shelf price, before tax',
  tax DECIMAL(10,2) COMMENT 'Tax on the line',
  CONSTRAINT txn_lines_pk PRIMARY KEY (txn_id, line_no),
  CONSTRAINT txn_lines_txn_fk FOREIGN KEY (txn_id) REFERENCES raw_pos.transactions (txn_id),
  CONSTRAINT txn_lines_sku_fk FOREIGN KEY (sku) REFERENCES ref.products (sku)
)
COMMENT 'One row per item on a register receipt';
