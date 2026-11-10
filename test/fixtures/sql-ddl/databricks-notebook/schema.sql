-- A Unity Catalog schema as the import guide's notebook snippet prints it (SHOW CREATE TABLE per table).
CREATE TABLE main.sales.customers (
  customer_id BIGINT NOT NULL,
  customer_name STRING,
  emails ARRAY<STRING>,
  created_at TIMESTAMP,
  CONSTRAINT customers_pk PRIMARY KEY (customer_id))
USING delta
COMMENT 'One row per customer'
TBLPROPERTIES (
  'delta.enableDeletionVectors' = 'true',
  'delta.feature.deletionVectors' = 'supported',
  'delta.minReaderVersion' = '3',
  'delta.minWriterVersion' = '7');

CREATE TABLE main.sales.orders (
  order_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  order_date DATE,
  amount DECIMAL(12,2) COMMENT 'Order total in AUD',
  CONSTRAINT orders_pk PRIMARY KEY (order_id),
  CONSTRAINT orders_customers_fk FOREIGN KEY (customer_id) REFERENCES main.sales.customers (customer_id))
USING delta
CLUSTER BY (order_date)
TBLPROPERTIES (
  'delta.enableDeletionVectors' = 'true',
  'delta.minReaderVersion' = '3',
  'delta.minWriterVersion' = '7');

