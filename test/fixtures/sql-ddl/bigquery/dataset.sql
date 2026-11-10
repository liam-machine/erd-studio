-- A BigQuery dataset's tables, as INFORMATION_SCHEMA.TABLES.ddl writes them (one statement each).
CREATE TABLE `acme-analytics.sales.dim_customer`
(
  customer_id INT64 NOT NULL OPTIONS(description="Surrogate key"),
  customer_name STRING NOT NULL,
  emails ARRAY<STRING>,
  address STRUCT<street STRING, city STRING, postcode STRING>,
  created_at TIMESTAMP,
  PRIMARY KEY (customer_id) NOT ENFORCED
)
OPTIONS(
  description="One row per customer"
);
CREATE TABLE `acme-analytics.sales.dim_product`
(
  product_id INT64 NOT NULL,
  product_name STRING(200),
  unit_price NUMERIC(10, 2),
  PRIMARY KEY (product_id) NOT ENFORCED
);
CREATE TABLE IF NOT EXISTS sales.dim_date (date_key INT64 NOT NULL, calendar_date DATE, PRIMARY KEY (date_key) NOT ENFORCED);
CREATE TABLE `acme-analytics.sales.fct_order`
(
  order_id INT64 NOT NULL,
  line_no INT64 NOT NULL,
  customer_id INT64 NOT NULL,
  product_id INT64,
  date_key INT64,
  amount NUMERIC(12, 2) OPTIONS(description='Order line amount in AUD'),
  status STRING DEFAULT "open",
  `timestamp` TIMESTAMP,
  PRIMARY KEY (order_id, line_no) NOT ENFORCED,
  FOREIGN KEY (customer_id) REFERENCES `acme-analytics.sales.dim_customer`(customer_id) NOT ENFORCED,
  FOREIGN KEY (product_id) REFERENCES `acme-analytics.sales`.dim_product(product_id) NOT ENFORCED,
  CONSTRAINT fk_date FOREIGN KEY (date_key) REFERENCES sales.dim_date(date_key) NOT ENFORCED
)
PARTITION BY DATE(_PARTITIONTIME)
CLUSTER BY customer_id
OPTIONS(
  description="One row per order line",
  labels=[("team", "sales")]
);
CREATE VIEW `acme-analytics.sales.v_orders` AS SELECT * FROM `acme-analytics.sales.fct_order`;
