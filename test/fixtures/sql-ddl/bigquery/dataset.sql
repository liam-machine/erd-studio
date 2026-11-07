-- BigQuery DDL as INFORMATION_SCHEMA.TABLES.ddl writes it: the import guide lists BigQuery under Not yet.
CREATE TABLE `acme-analytics.sales.customers`
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
CREATE TABLE `acme-analytics.sales.orders`
(
  order_id INT64 NOT NULL,
  customer_id INT64 NOT NULL,
  order_date DATE,
  amount NUMERIC(12, 2),
  status STRING DEFAULT 'open',
  PRIMARY KEY (order_id) NOT ENFORCED,
  FOREIGN KEY (customer_id) REFERENCES `acme-analytics.sales.customers`(customer_id) NOT ENFORCED
)
PARTITION BY order_date
CLUSTER BY customer_id
OPTIONS(
  description="One row per order",
  labels=[("team", "sales")]
);
