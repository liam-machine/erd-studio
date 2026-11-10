-- A CREATE TABLE with a syntax error on line 6 (stray words after a column's REFERENCES).
CREATE TABLE dim_customer (
  customer_id INTEGER PRIMARY KEY,
  customer_name TEXT
);
CREATE TABLE fct_order (order_id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES dim_customer (customer_id) oops oops,
  amount NUMERIC(10, 2)
);
