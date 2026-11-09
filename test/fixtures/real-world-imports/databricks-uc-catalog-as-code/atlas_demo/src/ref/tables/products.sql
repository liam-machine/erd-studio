CREATE TABLE ref.products (
  sku STRING NOT NULL COMMENT 'Stock keeping unit',
  product_name STRING COMMENT 'Name on the label',
  category STRING COMMENT 'Merchandising category',
  list_price DECIMAL(10,2) COMMENT 'Price before any discount',
  CONSTRAINT products_pk PRIMARY KEY (sku)
)
COMMENT 'One row per product';
