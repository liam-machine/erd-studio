-- A synthetic probe schema for the SQL Server catalog query (made up for the test: no real names or data).
-- Run in an empty database. sqlcmd splits batches on GO.
-- sqlcmd starts with QUOTED_IDENTIFIER OFF (SSMS and the VS Code extension start with it ON); a filtered index needs it ON.
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO
CREATE SCHEMA ref;
GO
CREATE SCHEMA sales;
GO
CREATE TYPE dbo.Phone FROM varchar(20) NULL;
GO
CREATE TABLE ref.country (
  country_code char(2) NOT NULL CONSTRAINT country_pk PRIMARY KEY,
  name nvarchar(50) NOT NULL
);
CREATE TABLE ref.currency (
  currency_code char(3) NOT NULL CONSTRAINT currency_pk PRIMARY KEY,
  name varchar(50) NOT NULL,
  minor_units smallint NOT NULL CONSTRAINT currency_minor_units_df DEFAULT 2
);
-- A plain unique index (not a constraint): a unique key over name.
CREATE UNIQUE NONCLUSTERED INDEX currency_name_ux ON ref.currency (name);
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
  customer_id int IDENTITY(1,1) NOT NULL CONSTRAINT customer_pk PRIMARY KEY,
  email nvarchar(255) NULL CONSTRAINT customer_email_uq UNIQUE,
  full_name nvarchar(50) NOT NULL,
  country_code char(2) NOT NULL CONSTRAINT customer_country_df DEFAULT 'AU',
  segment varchar(20) NULL CONSTRAINT customer_segment_df DEFAULT 'retail, small',
  credit_limit decimal(18,4) NULL CONSTRAINT customer_credit_df DEFAULT 0,
  created_at datetime2(6) NOT NULL CONSTRAINT customer_created_df DEFAULT sysutcdatetime(),
  phone dbo.Phone,
  external_id uniqueidentifier NOT NULL CONSTRAINT customer_external_df DEFAULT newid(),
  notes nvarchar(max) NULL,
  CONSTRAINT customer_country_fk FOREIGN KEY (country_code) REFERENCES ref.country (country_code)
);
CREATE TABLE sales.loyalty_card (
  card_id bigint NOT NULL CONSTRAINT loyalty_card_pk PRIMARY KEY,
  customer_id int NOT NULL,
  issued_on date NULL CONSTRAINT loyalty_card_issued_df DEFAULT CONVERT(date, getdate()),
  CONSTRAINT loyalty_card_customer_uq UNIQUE (customer_id),
  CONSTRAINT loyalty_card_customer_fk FOREIGN KEY (customer_id) REFERENCES sales.customer (customer_id)
);
CREATE TABLE sales.employee (
  employee_id int NOT NULL CONSTRAINT employee_pk PRIMARY KEY,
  full_name nvarchar(50) NOT NULL,
  manager_id int NULL,
  CONSTRAINT employee_manager_fk FOREIGN KEY (manager_id) REFERENCES sales.employee (employee_id)
);
CREATE TABLE sales.product (
  product_id int NOT NULL CONSTRAINT product_pk PRIMARY KEY,
  sku varchar(32) NOT NULL CONSTRAINT product_sku_uq UNIQUE,
  [order] int NULL,
  [Display Name] nvarchar(50) NULL,
  unit_price decimal(18,4) NOT NULL CONSTRAINT product_price_df DEFAULT 0.0000,
  legacy_code varchar(10) NULL,
  barcode varchar(20) NULL
);
-- A filtered unique index: unique only where legacy_code is set, so never a unique key of the table.
CREATE UNIQUE NONCLUSTERED INDEX product_legacy_code_ux ON sales.product (legacy_code) WHERE legacy_code IS NOT NULL;
-- A unique index with an included column: a unique key over barcode only, never over unit_price.
CREATE UNIQUE NONCLUSTERED INDEX product_barcode_ux ON sales.product (barcode) INCLUDE (unit_price);
CREATE TABLE sales.order_header (
  order_id bigint NOT NULL CONSTRAINT order_header_pk PRIMARY KEY,
  customer_id int NOT NULL,
  currency_code char(3) NOT NULL,
  sold_by int NULL,
  approved_by int NULL,
  order_ts datetime2(6) NOT NULL,
  pickup_time time(0) NULL,
  CONSTRAINT order_header_customer_ts_uq UNIQUE (customer_id, order_ts),
  CONSTRAINT order_header_customer_fk FOREIGN KEY (customer_id) REFERENCES sales.customer (customer_id),
  CONSTRAINT order_header_currency_fk FOREIGN KEY (currency_code) REFERENCES ref.currency (currency_code),
  CONSTRAINT order_header_sold_by_fk FOREIGN KEY (sold_by) REFERENCES sales.employee (employee_id),
  CONSTRAINT order_header_approved_by_fk FOREIGN KEY (approved_by) REFERENCES sales.employee (employee_id)
);
CREATE TABLE sales.order_line (
  order_id bigint NOT NULL,
  line_no smallint NOT NULL,
  product_id int NOT NULL,
  quantity int NOT NULL CONSTRAINT order_line_quantity_df DEFAULT 1 CONSTRAINT order_line_quantity_ck CHECK (quantity > 0),
  amount decimal(18,4) NULL,
  line_total AS (quantity * amount),
  CONSTRAINT order_line_pk PRIMARY KEY (order_id, line_no),
  CONSTRAINT order_line_order_fk FOREIGN KEY (order_id) REFERENCES sales.order_header (order_id),
  CONSTRAINT order_line_product_fk FOREIGN KEY (product_id) REFERENCES sales.product (product_id)
);
-- A composite foreign key whose columns sit in this table in the opposite order to the key it references
-- (ln_no before ord_id; the key is order_id, line_no). Pairing by column position would cross them.
-- SQL Server will not let the REFERENCES list itself be reordered (Msg 1776: it must match a key's order).
CREATE TABLE sales.shipment_line (
  shipment_id bigint NOT NULL CONSTRAINT shipment_line_pk PRIMARY KEY,
  ln_no smallint NOT NULL,
  ord_id bigint NOT NULL,
  shipped_at datetime2(6) NULL,
  CONSTRAINT shipment_line_order_line_fk FOREIGN KEY (ord_id, ln_no) REFERENCES sales.order_line (order_id, line_no),
  -- ord_id is in two foreign keys: two rows for one column.
  CONSTRAINT shipment_line_order_fk FOREIGN KEY (ord_id) REFERENCES sales.order_header (order_id)
);
CREATE TABLE sales.[OrderNote] (
  [NoteId] int NOT NULL CONSTRAINT [OrderNote_pk] PRIMARY KEY,
  order_id bigint NOT NULL,
  [Note Text] nvarchar(max) NULL,
  attachment varbinary(max) NULL,
  checksum varbinary(32) NULL,
  CONSTRAINT [OrderNote_order_fk] FOREIGN KEY (order_id) REFERENCES sales.order_header (order_id)
);
CREATE TABLE sales.audit_log (
  logged_at datetime2(3) NULL,
  actor varchar(50) NULL,
  payload nvarchar(max) NULL,
  is_system bit NULL,
  at_time time(7) NULL,
  context xml NULL
);
-- What SSMS's database diagrams create (in dbo): the catalog query leaves it out.
CREATE TABLE dbo.sysdiagrams (
  name sysname NOT NULL,
  principal_id int NOT NULL,
  diagram_id int IDENTITY(1,1) NOT NULL PRIMARY KEY,
  version int NULL,
  definition varbinary(max) NULL,
  CONSTRAINT UK_principal_name UNIQUE (principal_id, name)
);
GO
CREATE VIEW sales.v_order_totals AS
  SELECT order_id, sum(amount) AS total FROM sales.order_line GROUP BY order_id;
GO
-- Descriptions: commas, double quotes, an apostrophe, a backslash and real line breaks.
DECLARE @v sql_variant;
SET @v = N'Customers, the "golden" record.' + NCHAR(10) + N'One row per person; it''s deduplicated';
EXEC sp_addextendedproperty @name = N'MS_Description', @value = @v, @level0type = N'SCHEMA', @level0name = N'sales', @level1type = N'TABLE', @level1name = N'customer';
SET @v = N'Name, as entered; "quoted", and' + NCHAR(10) + N'a second line';
EXEC sp_addextendedproperty @name = N'MS_Description', @value = @v, @level0type = N'SCHEMA', @level0name = N'sales', @level1type = N'TABLE', @level1name = N'customer', @level2type = N'COLUMN', @level2name = N'full_name';
SET @v = N'Login email, lower-cased';
EXEC sp_addextendedproperty @name = N'MS_Description', @value = @v, @level0type = N'SCHEMA', @level0name = N'sales', @level1type = N'TABLE', @level1name = N'customer', @level2type = N'COLUMN', @level2name = N'email';
SET @v = N'Free text \ a back\slash, C:\temp' + NCHAR(13) + NCHAR(10) + N'and a CRLF line';
EXEC sp_addextendedproperty @name = N'MS_Description', @value = @v, @level0type = N'SCHEMA', @level0name = N'sales', @level1type = N'TABLE', @level1name = N'customer', @level2type = N'COLUMN', @level2name = N'notes';
SET @v = N'Sort order (reserved word)';
EXEC sp_addextendedproperty @name = N'MS_Description', @value = @v, @level0type = N'SCHEMA', @level0name = N'sales', @level1type = N'TABLE', @level1name = N'product', @level2type = N'COLUMN', @level2name = N'order';
SET @v = N'No keys, append-only';
EXEC sp_addextendedproperty @name = N'MS_Description', @value = @v, @level0type = N'SCHEMA', @level0name = N'sales', @level1type = N'TABLE', @level1name = N'audit_log';
GO
