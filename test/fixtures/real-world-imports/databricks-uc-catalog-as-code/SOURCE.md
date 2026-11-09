# Unity Catalog as code: the atlas demo (Databricks)

Import type: **SQL DDL, Databricks / Spark SQL**. Pick the folder `atlas_demo/src` in **Import SQL DDL…**; the dialect is detected (Databricks / Spark SQL).

## What it is

The test catalog of `ucatlas`, a tool that keeps a Unity Catalog in Git one object per file:
`<schema>/schema.sql` (`CREATE SCHEMA … COMMENT`, `ALTER SCHEMA … SET TAGS`), `<schema>/tables/<table>.sql` and
`<schema>/views/<view>.sql`, over 9 schemas of a retailer (raw web, store and CRM feeds, core entities, reference
data, finance, marketing, sales and exports).

What it adds to the samples: a folder import where tables reference tables in other files and other schemas
(`core.orders` → `ref.stores`), named PRIMARY and FOREIGN KEY constraints, two tables of the same name in different
schemas (`core.orders` and `raw_web.orders`, `core.refunds` and `raw_pos.refunds`), `SET TAGS` on schemas, tables and
columns, and views beside the tables.

## Where it came from

- Project: https://github.com/taslater/databricks-catalog-as-code
- Pin: commit `6f46fd8605ca10a639dd315832c957fee735e721`, as pinned by the import corpus (`scripts/corpus/manifest.json`, entry `databricks-uc-catalog-as-code-atlas-demo`, pinned 2026-11-09).
- Files (`packages/ucatlas/tests/atlas_demo/src/` upstream, `atlas_demo/src/` here):
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/core/schema.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/core/tables/customers.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/core/tables/order_lines.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/core/tables/orders.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/core/tables/refunds.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/exports/schema.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/exports/views/finance_ledger.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/exports/views/partner_feed.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/finance/schema.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/finance/tables/monthly_close.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/finance/tables/recognized_revenue.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/marketing/schema.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/marketing/tables/campaign_attribution.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/marketing/tables/customer_list.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/marketing/views/customer_360.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/raw_crm/schema.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/raw_crm/tables/contacts.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/raw_pos/schema.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/raw_pos/tables/refunds.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/raw_pos/tables/transaction_lines.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/raw_pos/tables/transactions.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/raw_web/schema.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/raw_web/tables/accounts.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/raw_web/tables/order_items.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/raw_web/tables/orders.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/raw_web/tables/sessions.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/ref/schema.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/ref/tables/calendar.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/ref/tables/products.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/ref/tables/stores.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/sales/schema.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/sales/tables/customer_monthly.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/sales/tables/daily_sales.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/sales/tables/order_facts.sql
  - https://raw.githubusercontent.com/taslater/databricks-catalog-as-code/6f46fd8605ca10a639dd315832c957fee735e721/packages/ucatlas/tests/atlas_demo/src/sales/views/top_products.sql
- SHA-256:
  - `atlas_demo/src/core/schema.sql` (144 bytes): `aea634e5514fd022dcd82abef7fd46631f86cb2afc5fac8efb9ccb0de84a8701`
  - `atlas_demo/src/core/tables/customers.sql` (535 bytes): `5ec59b870c27f3a276f06a9cdf869bce5bfff99bcdae46c7ab16701c15328efb`
  - `atlas_demo/src/core/tables/order_lines.sql` (659 bytes): `43268ea5bce4e45b8b398a14f410535d2f38f45b21edecbeec53557b062801c0`
  - `atlas_demo/src/core/tables/orders.sql` (714 bytes): `16ea9353c63dc97e6176f8f8c8087696d81f112fa96b5fb4380a66782459e031`
  - `atlas_demo/src/core/tables/refunds.sql` (434 bytes): `c136f46ad21e281a44235112633bb1b379e6c45b12e7897d878a5eda65846f69`
  - `atlas_demo/src/exports/schema.sql` (117 bytes): `5907142549693bb329b548479a6d1d719ba40a46afe7643e844c9920da47afdb`
  - `atlas_demo/src/exports/views/finance_ledger.sql` (182 bytes): `550dba67c81f0056eda5700a9ac61ce7a87994057c0b38aabfd0b91f306841fc`
  - `atlas_demo/src/exports/views/partner_feed.sql` (382 bytes): `44043ceddcc954752babbb75abbd0fa02d5c5dfe7fe63eba452b7f100212a8f9`
  - `atlas_demo/src/finance/schema.sql` (129 bytes): `794640dd0fd2c24c69b057fafe422c881fb3e8bf91585e5c60fa56996acd38af`
  - `atlas_demo/src/finance/tables/monthly_close.sql` (326 bytes): `daaafedc9343c5c7c948001c8414cdad168015b6c8cd477b6655f504652f0dba`
  - `atlas_demo/src/finance/tables/recognized_revenue.sql` (610 bytes): `ffb54e61ae65ddc52e80eaf5999a2065f96ba170d9eee74e4b0e24d3960bfa2f`
  - `atlas_demo/src/marketing/schema.sql` (117 bytes): `c542e7c3cde53cac4b7ef73561ef36793446ece65e5e7a5020ae757058161011`
  - `atlas_demo/src/marketing/tables/campaign_attribution.sql` (368 bytes): `96c3e682df06665fd292fe48104f05b8d0391c30faf737dd6aaa3c7be815c884`
  - `atlas_demo/src/marketing/tables/customer_list.sql` (436 bytes): `f0794acc65a32df49b9822231d789a179f479f676a1586ee6a1ec9945467b636`
  - `atlas_demo/src/marketing/views/customer_360.sql` (379 bytes): `a853380f5c08817e7e456ae9653d5fa066b975680d92bcfea9f1c3513f530934`
  - `atlas_demo/src/raw_crm/schema.sql` (121 bytes): `29738f103108f3df6ea600430eb7ed1d769f99c6d24d28052d65026ed2d8e31a`
  - `atlas_demo/src/raw_crm/tables/contacts.sql` (668 bytes): `5877519e5d980d04eb1a76ef029fbcaadb767515d1a6c404fdb8e27314cb694c`
  - `atlas_demo/src/raw_pos/schema.sql` (122 bytes): `2ad3f2861f83efd204f38a80cde7331e5680e0ccbb49e0aeba8f57b30b8ad450`
  - `atlas_demo/src/raw_pos/tables/refunds.sql` (447 bytes): `b3c0ddbf3b7098cfac4f2058f378c5eaf91f7a23d1871c720b76fe47db7223ab`
  - `atlas_demo/src/raw_pos/tables/transaction_lines.sql` (621 bytes): `e946fb9f87a5dad6737a557fb69d5e312097999632dc34a9f13cdd7e21ae7c94`
  - `atlas_demo/src/raw_pos/tables/transactions.sql` (545 bytes): `1297d1bf896bc4db36a17aeec6fe32756df6cf895a9431b50c46dcab5ff82a24`
  - `atlas_demo/src/raw_web/schema.sql` (116 bytes): `9dff332ce3201130a7717031768f7f01ca0d693a9a3c68c2ed8b549660598b36`
  - `atlas_demo/src/raw_web/tables/accounts.sql` (437 bytes): `5e878a57248c8fa174401924b9f3014ff30ae7597d3d91b02259b93bd3beda58`
  - `atlas_demo/src/raw_web/tables/order_items.sql` (532 bytes): `4e6f857b169b4564e1460f8e2958f8e3720c6ae557c55c819d7f1fa5d03567f3`
  - `atlas_demo/src/raw_web/tables/orders.sql` (478 bytes): `a9e4ac0dcf9d24bedc5b924c9c28afad96a38bdf06746bc5f8ab3fa6abbc12a3`
  - `atlas_demo/src/raw_web/tables/sessions.sql` (410 bytes): `554ef6445986fbf2e9d5f4229f7f4463904b503785fb1f37a37a2e11cc7c131b`
  - `atlas_demo/src/ref/schema.sql` (121 bytes): `7991fa7a37f2dc39af08b04eabcd509b057badc0a9bbb723813771f76e2f17cf`
  - `atlas_demo/src/ref/tables/calendar.sql` (300 bytes): `981690d736e3d693038433a91cdc9845cbfa359f18fc444e8f0cf516c2cab5e2`
  - `atlas_demo/src/ref/tables/products.sql` (323 bytes): `68eca8094974c703a9036b32412e2df30abba05f2112884123550be47f039331`
  - `atlas_demo/src/ref/tables/stores.sql` (306 bytes): `0a1a0991965a42061d9b74f83cf2a8e249e8e1ec90c421d82cef445df6366515`
  - `atlas_demo/src/sales/schema.sql` (110 bytes): `a4c1a3390e60438e17bd4d1f0156087ce21b579bbd95cfd65b6b2c33407ba474`
  - `atlas_demo/src/sales/tables/customer_monthly.sql` (478 bytes): `f4cd7d029bcc09c4e85e95996587bbeceef7c6b709f8f0dc699b91faea42b46d`
  - `atlas_demo/src/sales/tables/daily_sales.sql` (544 bytes): `0c2192303a88d605dbd64b2d63e426f1ce8dd3aa66da5fdcb274938f2420e7e4`
  - `atlas_demo/src/sales/tables/order_facts.sql` (1,052 bytes): `54ff0bd7d2140e2c863fca180b7b4fbfd38bed6c8bcb831842cbffde164b311f`
  - `atlas_demo/src/sales/views/top_products.sql` (304 bytes): `00b34de941f733dc807862dbc654cd2b56c48610cfb150125fb95c1b6f7fb550`
- Downloaded 2026-11-09; each file's SHA-256 checked against the pinned manifest.

## Licence

MIT (`LICENSE`, "Copyright (c) 2026 Thomas Slater"), copied to `UPSTREAM-LICENSE.txt`. The files are
unchanged.

## What was copied

- Every file under `packages/ucatlas/tests/atlas_demo/src/` (35 `.sql` files), byte for byte, as `atlas_demo/src/`.
- Nothing else from the repository.

## Expected counts

Read back with Apache Spark 4.3's SQL parser (`spark_readback.py`; open-source Spark's catalog cannot hold
constraints, which are Unity Catalog's), every file in path order, the CREATE TABLE plans replayed. Spark marks a
primary key's columns NOT NULL, as Databricks does. `SET TAGS` is Databricks SQL that open-source Spark does not parse
(16 statements, governance metadata: `loadErrors`). Cross-checked against `scripts/corpus/count_source.py`: the same
22 tables, 118 columns, 21 keys and 16 foreign keys. Because `orders` and `refunds` are each two tables, their
relationship ends name the schema (`toSchema`) and the scorecard compares them as `core_orders`, `raw_web_orders`,
`core_refunds` and `raw_pos_refunds`, the names the import gives them.

- Tables: **22**
- Columns: **118**
- Primary keys: **21**
- Foreign keys / relationships: **16**
- Descriptions (tables and columns): **140**

| Schema | Table | Columns | Primary key | Foreign keys (column → target) |
|---|---|---|---|---|
| core | customers | 6 | customer_id | – |
| core | order_lines | 7 | order_key, line_no | order_key → core.orders; sku → products |
| core | orders | 7 | order_key | customer_id → customers; store_id → stores |
| core | refunds | 4 | refund_id | order_key → core.orders |
| finance | monthly_close | 3 | month_start, channel | – |
| finance | recognized_revenue | 7 | order_ref | – |
| marketing | campaign_attribution | 3 | campaign_code, order_key | – |
| marketing | customer_list | 5 | – | – |
| raw_crm | contacts | 7 | contact_id | – |
| raw_pos | refunds | 4 | refund_id | txn_id → transactions |
| raw_pos | transaction_lines | 6 | txn_id, line_no | sku → products; txn_id → transactions |
| raw_pos | transactions | 6 | txn_id | store_id → stores |
| raw_web | accounts | 4 | account_id | – |
| raw_web | order_items | 6 | order_id, item_no | order_id → raw_web.orders |
| raw_web | orders | 6 | order_id | – |
| raw_web | sessions | 5 | session_id | – |
| ref | calendar | 4 | day | – |
| ref | products | 4 | sku | – |
| ref | stores | 4 | store_id | – |
| sales | customer_monthly | 4 | customer_id, month_start | customer_id → customers |
| sales | daily_sales | 5 | sale_date, store_id, sku | sku → products; store_id → stores |
| sales | order_facts | 11 | order_key, line_no | customer_id → customers; sku → products; store_id → stores |
