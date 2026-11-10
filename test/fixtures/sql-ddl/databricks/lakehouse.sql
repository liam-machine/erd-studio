-- Lakehouse star schema (Databricks / Unity Catalog), as SHOW CREATE TABLE writes it.
CREATE CATALOG IF NOT EXISTS main;
USE CATALOG main;

CREATE TABLE IF NOT EXISTS main.gold.dim_customer (
  customer_id BIGINT NOT NULL GENERATED ALWAYS AS IDENTITY COMMENT 'Surrogate key',
  customer_name STRING NOT NULL,
  emails ARRAY<STRING>,
  address STRUCT<street: STRING, city: STRING, postcode: STRING>,
  updated_at TIMESTAMP_NTZ,
  CONSTRAINT dim_customer_pk PRIMARY KEY (customer_id)
)
USING DELTA
COMMENT 'One row per customer'
TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true');

CREATE OR REPLACE TABLE `main`.`gold`.`dim_product` (
  `product_id` BIGINT NOT NULL,
  `product_name` STRING,
  `attributes` MAP<STRING, STRING>,
  CONSTRAINT `dim_product_pk` PRIMARY KEY (`product_id`) RELY
)
USING DELTA
CLUSTER BY (`product_id`)
LOCATION 's3://lake/gold/dim_product';

CREATE TABLE main.gold.dim_date (
  date_key INT NOT NULL,
  calendar_date DATE,
  CONSTRAINT dim_date_pk PRIMARY KEY (date_key)
) USING DELTA;

CREATE TABLE main.gold.fct_order (
  order_id BIGINT NOT NULL,
  line_no INT NOT NULL,
  customer_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  date_key INT,
  amount DECIMAL(12,2) COMMENT 'Order line amount in AUD',
  order_month DATE GENERATED ALWAYS AS (CAST(date_trunc('MONTH', calendar_ts) AS DATE)),
  calendar_ts TIMESTAMP,
  CONSTRAINT fct_order_pk PRIMARY KEY (order_id, line_no),
  CONSTRAINT fct_order_customer_fk FOREIGN KEY (customer_id) REFERENCES main.gold.dim_customer (customer_id) NOT ENFORCED,
  CONSTRAINT fct_order_product_fk FOREIGN KEY (product_id) REFERENCES main.gold.dim_product
)
USING DELTA
PARTITIONED BY (order_month)
OPTIONS ('compression' = 'zstd')
COMMENT 'One row per order line'
TBLPROPERTIES ('delta.autoOptimize.optimizeWrite' = 'true');

ALTER TABLE main.gold.fct_order ADD CONSTRAINT fct_order_date_fk FOREIGN KEY (date_key) REFERENCES main.gold.dim_date (date_key);

CREATE OR REPLACE VIEW main.gold.v_orders AS SELECT * FROM main.gold.fct_order;
OPTIMIZE main.gold.fct_order ZORDER BY (customer_id);
