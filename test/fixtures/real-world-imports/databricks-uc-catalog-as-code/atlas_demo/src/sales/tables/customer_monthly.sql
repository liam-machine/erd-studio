CREATE TABLE sales.customer_monthly (
  customer_id BIGINT NOT NULL COMMENT 'Customer',
  month_start DATE NOT NULL COMMENT 'First day of the month',
  orders BIGINT COMMENT 'Orders placed',
  revenue DECIMAL(14,2) COMMENT 'Net amount of those orders',
  CONSTRAINT customer_monthly_pk PRIMARY KEY (customer_id, month_start),
  CONSTRAINT customer_monthly_customer_fk FOREIGN KEY (customer_id) REFERENCES core.customers (customer_id)
)
COMMENT 'One row per customer and month';
