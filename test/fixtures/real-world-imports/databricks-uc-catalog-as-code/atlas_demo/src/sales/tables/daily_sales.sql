CREATE TABLE sales.daily_sales (
  sale_date DATE NOT NULL COMMENT 'Business day',
  store_id INT NOT NULL COMMENT 'Store',
  sku STRING NOT NULL COMMENT 'Product',
  units BIGINT COMMENT 'Units sold',
  revenue DECIMAL(14,2) COMMENT 'Sales, tax included',
  CONSTRAINT daily_sales_pk PRIMARY KEY (sale_date, store_id, sku),
  CONSTRAINT daily_sales_store_fk FOREIGN KEY (store_id) REFERENCES ref.stores (store_id),
  CONSTRAINT daily_sales_sku_fk FOREIGN KEY (sku) REFERENCES ref.products (sku)
)
COMMENT 'One row per store, product and day';
