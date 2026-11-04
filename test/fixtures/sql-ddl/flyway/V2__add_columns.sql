-- Flyway migration 2: columns added and renamed after the first release.
ALTER TABLE customer RENAME COLUMN email TO email_address;
ALTER TABLE customer ADD COLUMN loyalty_tier VARCHAR(20);

ALTER TABLE orders ADD COLUMN product_id INTEGER;
ALTER TABLE orders
    ADD CONSTRAINT orders_product_fk FOREIGN KEY (product_id) REFERENCES product (product_id);
