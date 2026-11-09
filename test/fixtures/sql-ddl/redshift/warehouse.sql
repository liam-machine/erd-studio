-- Sales star schema for Amazon Redshift.
CREATE SCHEMA IF NOT EXISTS sales;

CREATE TABLE IF NOT EXISTS sales.dim_customer (
  customer_id BIGINT IDENTITY(1, 1) ENCODE az64,
  customer_name VARCHAR(200) NOT NULL ENCODE zstd,
  attributes SUPER,
  created_at TIMESTAMPTZ DEFAULT GETDATE() ENCODE az64,
  PRIMARY KEY (customer_id)
)
DISTSTYLE ALL
SORTKEY (customer_id);

CREATE TABLE sales.dim_product (
  product_id INTEGER NOT NULL DISTKEY SORTKEY PRIMARY KEY,
  product_name VARCHAR(MAX),
  unit_price DECIMAL(10,2) ENCODE raw
) BACKUP NO;

CREATE TABLE sales.dim_date (
  date_key INTEGER NOT NULL ENCODE raw,
  calendar_date DATE NOT NULL,
  Primary Key(DATE_KEY)
) DISTSTYLE AUTO;

CREATE TABLE sales.fct_order_line (
  order_id BIGINT NOT NULL ENCODE az64,
  line_number SMALLINT NOT NULL,
  customer_id BIGINT NOT NULL REFERENCES sales.dim_customer(customer_id),
  product_id INTEGER NOT NULL,
  order_date_key INTEGER,
  amount DOUBLE PRECISION ENCODE zstd,
  Primary Key(ORDER_ID, LINE_NUMBER),
  FOREIGN KEY (product_id) REFERENCES sales.dim_product (product_id)
)
DISTSTYLE KEY
DISTKEY (order_id)
COMPOUND SORTKEY (order_date_key, order_id);

ALTER TABLE sales.fct_order_line ADD CONSTRAINT fk_date FOREIGN KEY (order_date_key) REFERENCES sales.dim_date (date_key);

COMMENT ON TABLE sales.dim_customer IS 'One row per customer';
COMMENT ON COLUMN sales.fct_order_line.amount IS 'Line amount in AUD, after discounts';

CREATE VIEW sales.v_orders AS SELECT * FROM sales.fct_order_line WITH NO SCHEMA BINDING;

COPY sales.fct_order_line FROM 's3://acme/orders/' IAM_ROLE 'arn:aws:iam::123456789012:role/load' FORMAT AS PARQUET;
ANALYZE sales.fct_order_line;
VACUUM sales.fct_order_line;
