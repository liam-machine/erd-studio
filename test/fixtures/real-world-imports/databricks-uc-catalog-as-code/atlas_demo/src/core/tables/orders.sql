CREATE TABLE core.orders (
  order_key STRING NOT NULL COMMENT 'web-<order id> or pos-<transaction id>',
  channel STRING COMMENT 'web or store',
  source_id BIGINT COMMENT 'The id in the source system',
  customer_id BIGINT COMMENT 'Customer, when known',
  store_id INT COMMENT 'Store; 0 for the web store',
  ordered_at TIMESTAMP COMMENT 'When it was placed or rung up',
  currency STRING COMMENT 'ISO currency code',
  CONSTRAINT core_orders_pk PRIMARY KEY (order_key),
  CONSTRAINT core_orders_customer_fk FOREIGN KEY (customer_id) REFERENCES core.customers (customer_id),
  CONSTRAINT core_orders_store_fk FOREIGN KEY (store_id) REFERENCES ref.stores (store_id)
)
COMMENT 'One row per order, web and store';
