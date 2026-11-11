CREATE DATABASE ref;
CREATE DATABASE sales;
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
  rate decimal(18,4) NOT NULL,
  CONSTRAINT exchange_rate_pk PRIMARY KEY (from_currency, to_currency, rate_date),
  CONSTRAINT exchange_rate_from_fk FOREIGN KEY (from_currency) REFERENCES ref.currency (currency_code),
  CONSTRAINT exchange_rate_to_fk FOREIGN KEY (to_currency) REFERENCES ref.currency (currency_code)
);
CREATE TABLE sales.customer (
  customer_id integer AUTO_INCREMENT PRIMARY KEY,
  email varchar(255) UNIQUE COMMENT 'Login email, lower-cased',
  full_name varchar(50) NOT NULL COMMENT 'Name, as entered; "quoted", and\na second line',
  country_code char(2) NOT NULL DEFAULT 'AU',
  segment varchar(20) DEFAULT 'retail, small',
  credit_limit decimal(18,4) DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  tags json,
  profile json,
  CONSTRAINT customer_country_fk FOREIGN KEY (country_code) REFERENCES ref.country (country_code)
) COMMENT = 'Customers, the "golden" record.\nOne row per person; it''s deduplicated';
CREATE TABLE sales.loyalty_card (
  card_id bigint PRIMARY KEY,
  customer_id integer NOT NULL,
  issued_on date DEFAULT (CURRENT_DATE),
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
  `order` integer COMMENT 'Sort order (reserved word)',
  `Display Name` varchar(50),
  unit_price decimal(18,4) NOT NULL DEFAULT 0.0000
);
CREATE TABLE sales.order_header (
  order_id bigint PRIMARY KEY,
  customer_id integer NOT NULL,
  currency_code char(3) NOT NULL,
  sold_by integer,
  order_ts timestamp NOT NULL,
  CONSTRAINT order_header_customer_fk FOREIGN KEY (customer_id) REFERENCES sales.customer (customer_id),
  CONSTRAINT order_header_currency_fk FOREIGN KEY (currency_code) REFERENCES ref.currency (currency_code),
  CONSTRAINT order_header_employee_fk FOREIGN KEY (sold_by) REFERENCES sales.employee (employee_id)
);
CREATE TABLE sales.order_line (
  order_id bigint NOT NULL,
  line_no smallint NOT NULL,
  product_id integer NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  amount decimal(18,4),
  CONSTRAINT order_line_pk PRIMARY KEY (order_id, line_no),
  CONSTRAINT order_line_order_fk FOREIGN KEY (order_id) REFERENCES sales.order_header (order_id),
  CONSTRAINT order_line_product_fk FOREIGN KEY (product_id) REFERENCES sales.product (product_id)
);
CREATE TABLE sales.shipment_line (
  shipment_id bigint PRIMARY KEY,
  ln_no smallint NOT NULL,
  ord_id bigint NOT NULL,
  shipped_at timestamp NULL,
  CONSTRAINT shipment_line_order_line_fk FOREIGN KEY (ord_id, ln_no) REFERENCES sales.order_line (order_id, line_no)
);
CREATE TABLE sales.`OrderNote` (
  `NoteId` integer PRIMARY KEY,
  order_id bigint NOT NULL,
  `Note Text` text,
  CONSTRAINT `OrderNote_order_fk` FOREIGN KEY (order_id) REFERENCES sales.order_header (order_id)
);
CREATE TABLE sales.audit_log (
  logged_at timestamp NULL,
  actor varchar(50),
  payload json
) COMMENT = 'No keys, append-only';
CREATE VIEW sales.v_order_totals AS
  SELECT order_id, sum(amount) AS total FROM sales.order_line GROUP BY order_id;
