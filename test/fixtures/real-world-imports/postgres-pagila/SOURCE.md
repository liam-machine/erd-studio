# Pagila (PostgreSQL)

Import type: **SQL DDL, PostgreSQL**.

## What it is

Pagila is the PostgreSQL port of MySQL's Sakila sample database: a DVD rental
shop with films, actors, stores, staff, customers, rentals and payments.
`pagila-schema.sql` is a real `pg_dump` output (dumped from PostgreSQL 12.11 by
pg_dump 15beta2, then edited upstream for PostgreSQL 18 features). It holds the
schema only. There is no data in it.

## Where it came from

- Project: https://github.com/devrimgunduz/pagila
- File: https://raw.githubusercontent.com/devrimgunduz/pagila/6ea53f812254c91a602f61c0ef62beca3fa676b1/pagila-schema.sql
- Pin: commit `6ea53f812254c91a602f61c0ef62beca3fa676b1` on `master` (2026-11-01).
  The file itself last changed in `85bf46a5` (2026-08-01, "Add virtual generated
  column example (film.length_hours) for PostgreSQL 18"). The newest tag,
  `v2.1.0`, is older than these PostgreSQL 18 changes, so the commit is the pin.
- SHA-256 of the file: `071ee940a73c8f4fad2997185788065291607e2c55559e3747959e8275391536`

## Licence

PostgreSQL License, Copyright (c) 2015-2026 Devrim Gündüz. It allows
redistribution as long as the notice is kept, so the upstream `LICENSE.txt` is
copied here as `UPSTREAM-LICENSE.txt`.

## What was copied

- `pagila-schema.sql`, byte for byte, unchanged.
- `LICENSE.txt` as `UPSTREAM-LICENSE.txt`.

Left out: the data files (`pagila-data.sql`, `pagila-insert-data.sql`, the
`.backup` files), the JSONB schema variant, the diagram PNG, Docker files and
the pg_partman / temporal setup scripts.

## Expected counts

Counted by reading the file, not by running ERD Studio. A small regex script
matched every top-level `CREATE TABLE public.<name> (...)` block and counted one
column per line, skipping the inline `PRIMARY KEY (...)` line. Primary keys are
the `ALTER TABLE ONLY ... ADD CONSTRAINT ... PRIMARY KEY` statements plus the
inline key on `payment`. Foreign keys are the `ADD CONSTRAINT ... FOREIGN KEY`
statements. The `CREATE TEMPORARY TABLE tmpCustomer` inside the
`rewards_report` function body is not a table and is not counted. Each result
was checked again with `grep -c`.

| What | Count |
|---|---|
| Tables (all `CREATE TABLE`) | **71** = 16 base tables + 55 monthly `payment` partitions |
| Columns | **479** = 94 in base tables + 55 × 7 in partitions |
| Primary keys | **16** (all on base tables; 3 are composite, each counted once; partitions declare none). Read back from PostgreSQL 18, each partition has `payment`'s key too: PostgreSQL creates it, and the `(uuid, payment_date)` unique index, on every partition it attaches. So with partitions kept as tables, `expected.json` counts **71** (`test/real-world-truth/`, `docs/dev/real-world-truth.md`). |
| Foreign keys | **37** = 19 on base tables + 18 on 6 partitions (`payment_p2022_01`..`06`, 3 each) |
| Views | 7 views + 1 materialized view (not tables) |

If an importer folds the partitions into `payment`, the expected logical model
is 16 tables, 94 columns, 16 primary keys and 22 distinct relationships (the 19
base-table FKs plus `payment` to `customer`, `rental` and `staff`, which are only
declared on the partitions).

### Per base table

| Table | Columns | Primary key | Foreign keys |
|---|---|---|---|
| actor | 4 | actor_id | none |
| address | 8 | address_id | city_id → city |
| category | 3 | category_id | none |
| city | 4 | city_id | country_id → country |
| country | 3 | country_id | none |
| customer | 11 | customer_id | address_id → address, store_id → store |
| film | 15 | film_id | language_id → language, original_language_id → language |
| film_actor | 3 | (actor_id, film_id) | actor_id → actor, film_id → film |
| film_category | 3 | (film_id, category_id) | film_id → film, category_id → category |
| film_embedding | 3 | film_id | film_id → film (ON DELETE CASCADE) |
| inventory | 4 | inventory_id | film_id → film, store_id → store |
| language | 3 | language_id | none |
| payment | 7 | (payment_date, payment_id) | none on the parent |
| rental | 8 | rental_id | customer_id → customer, inventory_id → inventory, staff_id → staff |
| staff | 11 | staff_id | address_id → address, store_id → store |
| store | 4 | store_id | address_id → address |

Each of the 55 partitions `payment_p2022_01` .. `payment_p2026_07` has the same 7
columns as `payment` and no primary key. Only the first six have foreign keys:
customer_id → customer, rental_id → rental, staff_id → staff.

## Notable features an importer might drop or mangle

- **Every key is declared after the tables** with `ALTER TABLE ONLY ... ADD
  CONSTRAINT`. No table has an inline FK.
- **Partitioned table**: `payment` is `PARTITION BY RANGE (payment_date)`, with 55
  partitions created as plain `CREATE TABLE` and joined later by `ALTER TABLE
  ONLY ... ATTACH PARTITION`. An importer may show 55 near-identical tables.
- **FKs only on some partitions**: the parent `payment` has no FKs, partitions
  2022_01..06 have 3 each, the other 49 have none.
- **Composite PKs**: `film_actor`, `film_category` and `payment` (its key leads
  with `payment_date`, not the id). `payment`'s key is inline, the rest are ALTERs.
- **Many-to-many**: `film_actor` (film ↔ actor) and `film_category`
  (film ↔ category) are bridge tables.
- **Two FKs to the same table**: `film.language_id` and
  `film.original_language_id` both point at `language`.
- **One-to-one**: `film_embedding.film_id` is both its PK and an FK to `film`.
- **Missing FK**: `store.manager_staff_id` has a unique index but no foreign key
  to `staff`, so no store → staff relationship should appear.
- **Domains**: `public.year` (integer with a CHECK) is used by
  `film.release_year`. `public."bıgınt"` (bigint) has a quoted non-ASCII name
  (Turkish dotless ı) and is not used by any column.
- **Enum**: `public.mpaa_rating` ('G', 'PG', 'PG-13', 'R', 'NC-17') used by
  `film.rating`, with default `'G'::public.mpaa_rating`.
- **Generated column**: `film.length_hours numeric(4,2) GENERATED ALWAYS AS
  (round(length / 60.0, 2)) VIRTUAL` (PostgreSQL 18 syntax).
- **Unusual types**: `text[]` array (`film.special_features`), `tsvector`
  (`film.fulltext`), `bytea` (`staff.picture`), `uuid`, `numeric(p,s)`,
  `smallint`, `timestamp with time zone`, and the pgvector type
  `public.vector(20)` (`film_embedding.embedding`), which needs `CREATE
  EXTENSION vector` part-way through the file.
- **Defaults**: `nextval('public.<seq>'::regclass)` on every id, `now()`,
  `CURRENT_DATE`, `true`, numeric literals and `uuidv7()`.
- **Schema-qualified names everywhere** (`public.`), and `search_path` is cleared
  at the top of the dump.
- **Reserved-ish column names**: `name`, `length`, `password`, `language` (as a
  table name).
- **Other objects that are not tables**: 7 views and 1 materialized view
  (`rental_by_category`, `WITH NO DATA`, with a unique index), 13 sequences, 9
  functions (SQL and PL/pgSQL with `$_$` dollar-quoted bodies), 1 aggregate, 16
  triggers, 38 indexes (6 unique, among them a natural key on `rental
  (rental_date, inventory_id, customer_id)`, plus a GiST full-text index and an
  HNSW vector index), `OWNER TO`, `GRANT` / `REVOKE` and `COMMENT ON EXTENSION`.
- **No column or table comments**: the only `COMMENT ON` is for the extension,
  so no descriptions should come in.
