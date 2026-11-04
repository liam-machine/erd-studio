-- Sales star schema (PostgreSQL), the shape pg_dump --schema-only writes.
SET statement_timeout = 0;
SET client_encoding = 'UTF8';

CREATE SCHEMA IF NOT EXISTS sales;

CREATE TYPE sales.order_status AS ENUM ('placed', 'shipped', 'returned');

CREATE TABLE sales.dim_customer (
    customer_id   SERIAL PRIMARY KEY,
    customer_name TEXT NOT NULL,
    email         VARCHAR(255) UNIQUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE sales.dim_customer IS 'One row per customer';
COMMENT ON COLUMN sales.dim_customer.customer_name IS 'Name as the customer entered it';

CREATE TABLE sales.dim_product (
    product_id  INTEGER GENERATED ALWAYS AS IDENTITY,
    sku         VARCHAR(32) NOT NULL,
    unit_price  NUMERIC(10, 2) CHECK (unit_price >= 0),
    tags        TEXT[],
    CONSTRAINT dim_product_pkey PRIMARY KEY (product_id)
);

CREATE TABLE sales.dim_date (
    date_key    INTEGER PRIMARY KEY,
    full_date   DATE NOT NULL,
    is_weekend  BOOLEAN DEFAULT false
);

CREATE TABLE sales.fct_order_line (
    order_id     BIGINT NOT NULL,
    line_number  SMALLINT NOT NULL,
    customer_id  INTEGER NOT NULL REFERENCES sales.dim_customer (customer_id),
    product_id   INTEGER NOT NULL,
    order_date_key INTEGER NOT NULL,
    status       sales.order_status NOT NULL DEFAULT 'placed',
    quantity     INTEGER NOT NULL DEFAULT 1,
    amount       DOUBLE PRECISION,
    PRIMARY KEY (order_id, line_number)
);

COMMENT ON COLUMN sales.fct_order_line.amount IS 'Line amount in AUD, after discounts';

CREATE INDEX fct_order_line_customer_idx ON sales.fct_order_line (customer_id);

CREATE VIEW sales.v_order_totals AS
SELECT order_id, sum(amount) AS total
FROM sales.fct_order_line
GROUP BY order_id;

INSERT INTO sales.dim_date (date_key, full_date, is_weekend) VALUES (20240101, '2024-01-01', false);

GRANT SELECT ON ALL TABLES IN SCHEMA sales TO reporting;

CREATE OR REPLACE FUNCTION sales.touch() RETURNS trigger AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
