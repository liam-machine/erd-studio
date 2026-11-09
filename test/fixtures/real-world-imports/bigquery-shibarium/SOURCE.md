# Shibarium blockchain ETL (BigQuery)

Import type: **SQL DDL, Google BigQuery**. Pick `shibarium/create_tables.sql` in **Import SQL DDL…**; the dialect is detected (Google BigQuery).

## What it is

The BigQuery schema K9 Finance DAO built to load the Shibarium blockchain (blocks, transactions, receipts,
function calls, logs, decoded events, errors and access lists) before exporting it to Dune. Names are quoted whole
(`` `knine-1.shibarium.blocks` ``); `CREATE TABLE IF NOT EXISTS` with `BIGNUMERIC`, `JSON`, `STRUCT<…>` and
`ARRAY<STRUCT<…>>` columns, `PARTITION BY DATE(…)` / `RANGE_BUCKET`, `CLUSTER BY` and more than 80 column
`OPTIONS(description = …)`. Then views, a query and `INSERT`s.

What it adds to the samples: BigQuery keys. The 8 primary keys (two of them two-column) and 23 foreign keys are added
afterwards, `ALTER TABLE … ADD PRIMARY KEY (…) NOT ENFORCED` and `ADD FOREIGN KEY … REFERENCES … NOT ENFORCED`, several
`ADD`s to one `ALTER`, and some pairs of tables reference each other both ways.

## Where it came from

- Project: https://github.com/K9-Finance-DAO/shibarium-bigquery-dune-etl-OSS
- Pin: commit `267d25207702a7f532d8d0ed0cbcb1f5e76929df`, as pinned by the import corpus (`scripts/corpus/manifest.json`, entry `bigquery-shibarium`, pinned 2026-11-09).
- Files (`bigquery/shibarium/` upstream, `shibarium/` here):
  - https://raw.githubusercontent.com/K9-Finance-DAO/shibarium-bigquery-dune-etl-OSS/267d25207702a7f532d8d0ed0cbcb1f5e76929df/bigquery/shibarium/create_tables.sql
- SHA-256:
  - `shibarium/create_tables.sql` (26,329 bytes): `3f11794698db2d73d1b9b4dc87704906f132f12384cbbad12b91bbf4aa401690`
- Downloaded 2026-11-09; each file's SHA-256 checked against the pinned manifest.

## Licence

CC0-1.0 (`LICENSE`: the maintainer dedicated the repository to the public domain), copied to
`UPSTREAM-LICENSE.txt`. The file is unchanged.

## What was copied

- `bigquery/shibarium/create_tables.sql`, byte for byte, as `shibarium/create_tables.sql`.
- Nothing else from the repository.

## Expected counts

BigQuery has no local engine (the open-source goccy/bigquery-emulator 0.6.6, tried in Docker, refuses `NOT ENFORCED`
primary keys and every `ALTER TABLE`, which is how this sample adds its keys), so the truth is `scripts/corpus/count_source.py`'s count (sqlglot 27.29,
BigQuery dialect), checked by reading the file: 8 `CREATE TABLE`s, the 8 `ADD PRIMARY KEY`s and the 23 `ADD FOREIGN KEY`s.
It is `NOT_ENGINE_VERIFIED` in `test/unit/realWorldEngineTruth.ts`.

- Tables: **8**
- Columns: **87**
- Primary keys: **8**
- Foreign keys / relationships: **23**
- Descriptions (tables and columns): **95**

| Schema | Table | Columns | Primary key | Foreign keys (column → target) |
|---|---|---|---|---|
| shibarium | blocks | 21 | block_hash | – |
| shibarium | transactions | 17 | transaction_hash | block_hash → blocks; transaction_hash, transaction_hash → receipts |
| shibarium | receipts | 13 | transaction_hash | block_hash → blocks; transaction_hash, transaction_hash → transactions |
| shibarium | function_calls | 8 | transaction_hash | block_hash → blocks; transaction_hash, transaction_hash → transactions |
| shibarium | logs | 10 | block_hash, log_index | block_hash → blocks; transaction_hash, transaction_hash → transactions; block_hash, log_index → decoded_events |
| shibarium | decoded_events | 9 | block_hash, log_index | block_hash → blocks; transaction_hash, transaction_hash → transactions; block_hash, log_index → logs |
| shibarium | errors | 5 | transaction_hash | block_hash → blocks; transaction_hash, transaction_hash → transactions |
| shibarium | transaction_access_lists | 4 | transaction_hash | block_hash → blocks; transaction_hash, transaction_hash → transactions |
