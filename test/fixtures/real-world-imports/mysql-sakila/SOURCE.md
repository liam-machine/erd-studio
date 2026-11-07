# Sakila (MySQL)

Sakila is the official MySQL sample database. It models a DVD rental shop: films, actors, stores, staff, customers, rentals and payments. Oracle publishes it with the MySQL documentation.

## Where it came from

- Page: https://dev.mysql.com/doc/index-other.html (Example Databases, "sakila database")
- Download: https://downloads.mysql.com/docs/sakila-db.tar.gz
- Pin: Sakila **version 1.5** (stated in the file header). The download URL is not versioned, so the bytes are pinned by hash:
  - archive `sakila-db.tar.gz`: 732,425 bytes, Last-Modified `Sat, 31 Oct 2026 23:05:29 GMT`, SHA-256 `d8e848e1c7530d6f246684bdfdaeab12f744011df513bb210df0e898788af193`
  - `sakila-schema.sql`: 24,269 bytes, SHA-256 `b32170e1e2ad5828749b61a5ec896155bcd143104b076e5ee8a3a3b013f44915`
- Downloaded 2026-11-07.

## Licence

BSD 3-Clause ("New BSD"), Copyright (c) 2006, 2026, Oracle and/or its affiliates. Redistribution is allowed if the notice is kept. The notice is in the header of `sakila-schema.sql` (unchanged) and copied to `UPSTREAM-LICENSE.txt`.

## What was copied

- `sakila-schema.sql`, byte for byte (same hash as above).
- Not copied: `sakila-data.sql` (3.3 MB of INSERT data) and `sakila.mwb` (a binary MySQL Workbench model).

## Expected counts

Counted by reading the file and checking with `grep` / `awk` over each `CREATE TABLE` block: one column per line that is not a `PRIMARY KEY`, `KEY`, `UNIQUE KEY`, `FULLTEXT KEY`, `SPATIAL KEY` or `CONSTRAINT` line. Foreign keys are the `CONSTRAINT ... FOREIGN KEY` clauses (all single-column). ERD Studio was not run.

- Tables: **16**
- Columns: **90** (89 if the importer drops `address.location`, see below)
- Primary keys: **16** (2 of them composite)
- Foreign keys: **22**

| Table | Columns | Primary key | Foreign keys (column → target) |
|---|---|---|---|
| actor | 4 | actor_id | – |
| address | 9 | address_id | city_id → city |
| category | 3 | category_id | – |
| city | 4 | city_id | country_id → country |
| country | 3 | country_id | – |
| customer | 9 | customer_id | address_id → address; store_id → store |
| film | 13 | film_id | language_id → language; original_language_id → language |
| film_actor | 3 | (actor_id, film_id) | actor_id → actor; film_id → film |
| film_category | 3 | (film_id, category_id) | film_id → film; category_id → category |
| film_text | 3 | film_id | – (no FK; filled by triggers) |
| inventory | 4 | inventory_id | store_id → store; film_id → film |
| language | 3 | language_id | – |
| payment | 7 | payment_id | rental_id → rental; customer_id → customer; staff_id → staff |
| rental | 7 | rental_id | staff_id → staff; inventory_id → inventory; customer_id → customer |
| staff | 11 | staff_id | store_id → store; address_id → address |
| store | 4 | store_id | manager_staff_id → staff; address_id → address |

## Notable features

- **Conditional (versioned) comments.** `address.location` is declared only inside MySQL executable comments: `/*!50705 location GEOMETRY */ /*!80003 SRID 0 */ /*!50705 NOT NULL,*/`. A parser that strips comments will lose this column and may also lose the comma. The `SPATIAL KEY idx_location` is also inside one.
- **Circular foreign keys.** `store.manager_staff_id → staff` and `staff.store_id → store`. Many tables reference tables created later in the file (FKs are switched off at the top).
- **Two FKs to the same table**: `film.language_id` and `film.original_language_id` both point at `language`.
- **Many-to-many bridge tables** with composite primary keys: `film_actor`, `film_category`.
- **Nullable FKs**: `film.original_language_id`, `payment.rental_id` (`ON DELETE SET NULL`). The others are NOT NULL. All FKs carry `ON DELETE` / `ON UPDATE` actions.
- **MySQL-specific types**: `ENUM` (`film.rating`), `SET` (`film.special_features`), `YEAR` (`film.release_year`), `GEOMETRY`, `BLOB` (`staff.picture`), `TEXT`, `BOOLEAN`, `TINYINT`/`SMALLINT`/`MEDIUMINT UNSIGNED`, `DECIMAL(p,s)`, `CHAR(20)`.
- **Column options**: `AUTO_INCREMENT`, `DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`, numeric and string defaults, and a column-level `CHARACTER SET utf8mb4 COLLATE utf8mb4_bin` (`staff.password`).
- **Unique keys**: `store.manager_staff_id` (makes store → staff one-to-one) and an unnamed three-column `UNIQUE KEY (rental_date, inventory_id, customer_id)` on `rental`.
- **Indexes**: many `KEY` lines, a `FULLTEXT KEY` on `film_text`, a `SPATIAL KEY` on `address`.
- **Table options**: `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`; `film_text` has no `ENGINE`.
- **Mixed quoting**: most names are bare, some use backticks (`` `fk_address_city` ``, `` `film_id` ``). No mixed-case table names.
- **Non-table statements the importer should skip**: `SET` session variables, `DROP SCHEMA` / `CREATE SCHEMA sakila` / `USE sakila`, 7 views (`customer_list`, `film_list`, `nicer_but_slower_film_list`, `staff_list`, `sales_by_store`, `sales_by_film_category`, `actor_info`, the last with `DEFINER` / `SQL SECURITY`), 3 triggers, 3 stored procedures and 3 functions. These use `DELIMITER ;;`, `//` and `$$` blocks with `BEGIN ... END` bodies, `#` line comments, and one `CREATE TEMPORARY TABLE tmpCustomer` inside a procedure body that must not become a table.
- **No column comments** (`COMMENT '...'` appears only on the `rewards_report` procedure).
