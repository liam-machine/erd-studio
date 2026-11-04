-- Flyway migration 1: the first tables (PostgreSQL).
CREATE TABLE customer (
    customer_id  SERIAL PRIMARY KEY,
    email        TEXT NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE product (
    product_id   SERIAL PRIMARY KEY,
    sku          VARCHAR(40) NOT NULL,
    name         TEXT NOT NULL
);

CREATE TABLE orders (
    order_id     BIGSERIAL PRIMARY KEY,
    customer_id  INTEGER NOT NULL REFERENCES customer (customer_id),
    total        NUMERIC(12, 2)
);
