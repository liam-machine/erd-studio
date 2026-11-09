-- Sales star schema for SQLite, as the sqlite3 shell's .dump prints it.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE [dim_customer] (
  [customer_id] INTEGER PRIMARY KEY AUTOINCREMENT,
  [customer_name] TEXT NOT NULL COLLATE NOCASE,
  [created_at] DATETIME DEFAULT CURRENT_TIMESTAMP,
  [extra]
);
CREATE TABLE "dim_product" (
  "product_id" INTEGER NOT NULL,
  "product_name" VARCHAR(200),
  "unit_price" NUMERIC(10,2),
  "big" UNSIGNED BIG INT,
  PRIMARY KEY ("product_id" ASC) ON CONFLICT REPLACE
) WITHOUT ROWID;
CREATE TABLE `dim_date` (`date_key` INTEGER PRIMARY KEY, `calendar_date` TEXT NOT NULL) STRICT;
CREATE TABLE fct_order_line (
  order_id INTEGER NOT NULL,
  line_number INTEGER NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES dim_customer (customer_id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES dim_product,
  order_date_key INTEGER,
  amount REAL,
  total REAL GENERATED ALWAYS AS (amount * 1.1) VIRTUAL,
  PRIMARY KEY (order_id, line_number),
  FOREIGN KEY (order_date_key) REFERENCES dim_date(date_key) DEFERRABLE INITIALLY DEFERRED
);
INSERT INTO dim_date VALUES(20240101,'2024-01-01');
CREATE UNIQUE INDEX ux_customer_name ON dim_customer (customer_name) WHERE customer_name IS NOT NULL;
CREATE INDEX ix_order_date ON fct_order_line (order_date_key);
CREATE VIEW v_orders AS SELECT * FROM fct_order_line;
CREATE VIRTUAL TABLE customer_search USING fts5(customer_name, content=dim_customer);
CREATE TRIGGER trg_customer_ai AFTER INSERT ON dim_customer BEGIN
  INSERT INTO customer_search(rowid, customer_name) VALUES (new.customer_id, new.customer_name);
END;
DELETE FROM sqlite_sequence;
COMMIT;
