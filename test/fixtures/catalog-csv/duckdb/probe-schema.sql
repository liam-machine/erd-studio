CREATE SCHEMA ref;
CREATE SCHEMA sales;
CREATE TABLE ref.country (
  country_code char(2) PRIMARY KEY,
  name varchar(50) NOT NULL
);
CREATE TABLE ref.currency (
  currency_code char(3) PRIMARY KEY,
  name varchar(50) NOT NULL,
  minor_units smallint NOT NULL DEFAULT 2
);
CREATE TABLE ref.exchange_rate (
  from_currency char(3) NOT NULL,
  to_currency char(3) NOT NULL,
  rate_date date NOT NULL,
  rate numeric(18,4) NOT NULL,
  CONSTRAINT exchange_rate_pk PRIMARY KEY (from_currency, to_currency, rate_date),
  CONSTRAINT exchange_rate_from_fk FOREIGN KEY (from_currency) REFERENCES ref.currency (currency_code),
  CONSTRAINT exchange_rate_to_fk FOREIGN KEY (to_currency) REFERENCES ref.currency (currency_code)
);
CREATE TABLE sales.customer (
  customer_id integer PRIMARY KEY,
  email varchar(255) UNIQUE,
  full_name varchar(50) NOT NULL,
  country_code char(2) NOT NULL DEFAULT 'AU',
  segment varchar(20) DEFAULT 'retail, small',
  credit_limit numeric(18,4) DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  tags text[],
  profile json
);
COMMENT ON TABLE sales.customer IS 'Customers, the "golden" record.
One row per person; it''s deduplicated';
COMMENT ON COLUMN sales.customer.full_name IS 'Name, as entered; "quoted", and
a second line';
COMMENT ON COLUMN sales.customer.email IS 'Login email, lower-cased';
CREATE TABLE sales.loyalty_card (
  card_id bigint PRIMARY KEY,
  customer_id integer NOT NULL,
  issued_on date DEFAULT CURRENT_DATE,
  CONSTRAINT loyalty_card_customer_uq UNIQUE (customer_id),
  CONSTRAINT loyalty_card_customer_fk FOREIGN KEY (customer_id) REFERENCES sales.customer (customer_id)
);
CREATE TABLE sales.employee (
  employee_id integer PRIMARY KEY,
  full_name varchar(50) NOT NULL,
  manager_id integer,
  CONSTRAINT employee_manager_fk FOREIGN KEY (manager_id) REFERENCES sales.employee (employee_id)
);
CREATE TABLE sales.product (
  product_id integer PRIMARY KEY,
  sku varchar(32) NOT NULL UNIQUE,
  "order" integer,
  "Display Name" varchar(50),
  unit_price numeric(18,4) NOT NULL DEFAULT 0.0000
);
COMMENT ON COLUMN sales.product."order" IS 'Sort order (reserved word)';
CREATE TABLE sales.order_header (
  order_id bigint PRIMARY KEY,
  customer_id integer NOT NULL,
  currency_code char(3) NOT NULL,
  sold_by integer,
  order_ts timestamptz NOT NULL,
  CONSTRAINT order_header_customer_fk FOREIGN KEY (customer_id) REFERENCES sales.customer (customer_id),
  CONSTRAINT order_header_employee_fk FOREIGN KEY (sold_by) REFERENCES sales.employee (employee_id)
);
CREATE TABLE sales.order_line (
  order_id bigint NOT NULL,
  line_no smallint NOT NULL,
  product_id integer NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  amount numeric(18,4),
  CONSTRAINT order_line_pk PRIMARY KEY (order_id, line_no),
  CONSTRAINT order_line_order_fk FOREIGN KEY (order_id) REFERENCES sales.order_header (order_id),
  CONSTRAINT order_line_product_fk FOREIGN KEY (product_id) REFERENCES sales.product (product_id)
);
-- composite FK whose columns are declared in the opposite order to the key they point at
CREATE TABLE sales.shipment_line (
  shipment_id bigint PRIMARY KEY,
  ln_no smallint NOT NULL,
  ord_id bigint NOT NULL,
  shipped_at timestamptz,
  CONSTRAINT shipment_line_order_line_fk FOREIGN KEY (ord_id, ln_no) REFERENCES sales.order_line (order_id, line_no)
);
CREATE TABLE sales."OrderNote" (
  "NoteId" integer PRIMARY KEY,
  order_id bigint NOT NULL,
  "Note Text" text,
  CONSTRAINT "OrderNote_order_fk" FOREIGN KEY (order_id) REFERENCES sales.order_header (order_id)
);
CREATE TABLE sales.audit_log (
  logged_at timestamptz,
  actor varchar(50),
  payload json
);
COMMENT ON TABLE sales.audit_log IS 'No keys, append-only';
CREATE VIEW sales.v_order_totals AS
  SELECT order_id, sum(amount) AS total FROM sales.order_line GROUP BY order_id;
