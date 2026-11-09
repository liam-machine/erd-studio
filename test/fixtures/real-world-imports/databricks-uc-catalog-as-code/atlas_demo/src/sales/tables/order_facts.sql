CREATE TABLE sales.order_facts (
  order_key STRING NOT NULL COMMENT 'The order',
  line_no INT NOT NULL COMMENT 'Position on the order',
  ordered_at TIMESTAMP COMMENT 'When it was placed or rung up',
  order_date DATE COMMENT 'Day of ordered_at',
  channel STRING COMMENT 'web or store',
  customer_id BIGINT COMMENT 'Customer, when known',
  store_id INT COMMENT 'Store; 0 for the web store',
  sku STRING COMMENT 'Product',
  category STRING COMMENT 'Product category',
  quantity INT COMMENT 'Units',
  net_amount DECIMAL(12,2) COMMENT 'Quantity times price, less discount',
  CONSTRAINT order_facts_pk PRIMARY KEY (order_key, line_no),
  CONSTRAINT order_facts_customer_fk FOREIGN KEY (customer_id) REFERENCES core.customers (customer_id),
  CONSTRAINT order_facts_store_fk FOREIGN KEY (store_id) REFERENCES ref.stores (store_id),
  CONSTRAINT order_facts_sku_fk FOREIGN KEY (sku) REFERENCES ref.products (sku)
)
COMMENT 'One row per item on an order, with its product and channel';
ALTER TABLE sales.order_facts SET TAGS ('certified' = 'true');
