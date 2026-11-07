# Medallion lakehouse (bronze, silver, gold)

The layout [Databricks describes](https://docs.databricks.com/aws/en/lakehouse/medallion) for a lakehouse, and the most common one in Databricks and Microsoft Fabric projects. Data lands in **bronze** as the source sends it, is cleaned and matched in **silver**, and is shaped for reporting in **gold**. Databricks' own example keeps each layer as a schema of one catalog (`ops.bronze`, `ops.silver`, `ops.gold`), and its [Unity Catalog guide](https://docs.databricks.com/aws/en/lakehouse-architecture/deployment-guide/unity-catalog) recommends a catalog per environment (`dev`, `prod`). This example is a small online bike shop, Harbour Cycles, with two sources: Shopify (orders) and Stripe (payments).

| In the warehouse | In `.erd-studio/` |
|---|---|
| a layer: the `bronze`, `silver` and `gold` schemas | a layer folder each, holding one schema folder of the same name: `gold/tables/gold/` |
| a table | one `.dbml` file in its schema folder |
| the `dev` and `prod` catalogs | nothing: it is one design, deployed to each environment |
| a star schema, or a source system you look at together | a diagram in `<layer>/diagrams/` |

```text
.erd-studio/
├── README.md
├── layers.json
├── bronze/
│   ├── tables/
│   │   └── bronze/
│   │       ├── shopify_customers.dbml
│   │       ├── shopify_order_line_items.dbml
│   │       ├── shopify_orders.dbml
│   │       ├── shopify_products.dbml
│   │       ├── stripe_charges.dbml
│   │       └── stripe_customers.dbml
│   ├── relationships/
│   │   └── bronze.dbml
│   └── diagrams/
│       └── sources.dbml
├── silver/
│   ├── tables/
│   │   └── silver/
│   │       ├── customers.dbml
│   │       ├── order_lines.dbml
│   │       ├── payments.dbml
│   │       ├── products.dbml
│   │       └── silver_orders.dbml
│   ├── relationships/
│   │   └── silver.dbml
│   └── diagrams/
│       └── core-entities.dbml
└── gold/
    ├── tables/
    │   └── gold/
    │       ├── dim_customer.dbml
    │       ├── dim_date.dbml
    │       ├── dim_product.dbml
    │       ├── fct_order_line.dbml
    │       ├── fct_payment.dbml
    │       └── gold_orders.dbml
    ├── relationships/
    │   ├── finance.dbml
    │   └── gold.dbml
    └── diagrams/
        ├── finance.dbml
        ├── orders-dashboard.dbml
        └── sales.dbml
```

## What to notice

- **One schema per layer is fine.** Each layer has a single schema folder named after it. The source system is in the bronze table names (`shopify_orders`, `stripe_charges`), as it is in the warehouse.
- **The same warehouse name in two layers.** Silver and gold both have a table called `orders`. A table's name is unique across the whole project, so they are `silver_orders` and `gold_orders`, each with `alias: 'orders'`, the name the warehouse uses.
- **Conformed dimensions are one file each, on several diagrams**: `dim_date` and `dim_customer` appear on both the **sales** and **finance** diagrams.
- **Relationships can be split by owner.** Gold's Refs are in `gold.dbml`, except the finance star's, which the finance team keeps in `finance.dbml`. New relationships of `fct_payment` land there too.
- **A wide reporting table needs no relationships.** `gold_orders` is pre-joined for a dashboard tool and sits on its own diagram.
- **Lineage is written down, not drawn.** Gold's `dim_customer` is built from silver's `customers`. That is a pipeline step, not a foreign key, so it goes in the table's **Decisions** rather than a Ref.

## Variations

- **A catalog per layer** (Databricks calls these lifecycle catalogs): the catalog is the layer and its schemas are schema folders, such as `silver/tables/sales/`. The [GitLab-style example](../gitlab-style/) does the same with databases.
- **Schemas prefixed with the layer** (`silver_sales`, `gold_finance`): keep the full schema name as the folder, `silver/tables/silver_sales/`. The layer folder is the stage; the schema folder is always the warehouse's own name.
