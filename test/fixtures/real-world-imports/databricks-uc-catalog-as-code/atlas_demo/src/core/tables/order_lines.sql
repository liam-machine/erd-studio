CREATE TABLE core.order_lines (
  order_key STRING NOT NULL COMMENT 'The order',
  line_no INT NOT NULL COMMENT 'Position on the order',
  sku STRING COMMENT 'Product',
  quantity INT COMMENT 'Units',
  unit_price DECIMAL(10,2) COMMENT 'Unit price, before tax',
  discount DECIMAL(10,2) COMMENT 'Discount on the line',
  tax DECIMAL(10,2) COMMENT 'Tax on the line; 0 for web orders',
  CONSTRAINT core_lines_pk PRIMARY KEY (order_key, line_no),
  CONSTRAINT core_lines_order_fk FOREIGN KEY (order_key) REFERENCES core.orders (order_key),
  CONSTRAINT core_lines_sku_fk FOREIGN KEY (sku) REFERENCES ref.products (sku)
)
COMMENT 'One row per item on an order';
