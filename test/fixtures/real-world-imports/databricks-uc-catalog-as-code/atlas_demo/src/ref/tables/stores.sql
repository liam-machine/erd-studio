CREATE TABLE ref.stores (
  store_id INT NOT NULL COMMENT 'Store number; 0 is the web store',
  store_name STRING COMMENT 'Store name as signed',
  region STRING COMMENT 'Sales region',
  opened_on DATE COMMENT 'First day open',
  CONSTRAINT stores_pk PRIMARY KEY (store_id)
)
COMMENT 'One row per store';
