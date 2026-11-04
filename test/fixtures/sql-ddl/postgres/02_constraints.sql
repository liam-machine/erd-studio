-- Foreign keys added after the tables, in a separate file.
ALTER TABLE ONLY sales.fct_order_line
    ADD CONSTRAINT fct_order_line_product_fk FOREIGN KEY (product_id) REFERENCES sales.dim_product (product_id);

ALTER TABLE ONLY sales.fct_order_line
    ADD CONSTRAINT fct_order_line_date_fk FOREIGN KEY (order_date_key) REFERENCES sales.dim_date (date_key) ON DELETE RESTRICT;

-- Repeats the inline REFERENCES on customer_id: imported once.
ALTER TABLE sales.fct_order_line
    ADD CONSTRAINT fct_order_line_customer_fk FOREIGN KEY (customer_id) REFERENCES sales.dim_customer (customer_id);

ALTER TABLE sales.dim_customer OWNER TO etl;
