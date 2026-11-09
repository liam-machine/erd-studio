CREATE TABLE raw_web.order_items (
  order_id BIGINT NOT NULL COMMENT 'Web order number',
  item_no INT NOT NULL COMMENT 'Position on the order',
  sku STRING COMMENT 'Product ordered',
  qty INT COMMENT 'Units ordered',
  price DECIMAL(10,2) COMMENT 'Unit price charged',
  discount DECIMAL(10,2) COMMENT 'Discount on the whole line',
  CONSTRAINT web_items_pk PRIMARY KEY (order_id, item_no),
  CONSTRAINT web_items_order_fk FOREIGN KEY (order_id) REFERENCES raw_web.orders (order_id)
)
COMMENT 'One row per item on a web order';
