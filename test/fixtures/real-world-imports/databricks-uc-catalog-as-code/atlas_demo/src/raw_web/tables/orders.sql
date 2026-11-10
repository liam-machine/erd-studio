CREATE TABLE raw_web.orders (
  order_id BIGINT NOT NULL COMMENT 'Web order number',
  account_id BIGINT COMMENT 'Web account that placed it',
  placed_at TIMESTAMP COMMENT 'When the order was placed',
  currency STRING COMMENT 'ISO currency code',
  status STRING COMMENT 'placed, paid, shipped or canceled',
  payload STRING COMMENT 'The order as the storefront sent it, JSON',
  CONSTRAINT web_orders_pk PRIMARY KEY (order_id)
)
COMMENT 'One row per web order, as received';
