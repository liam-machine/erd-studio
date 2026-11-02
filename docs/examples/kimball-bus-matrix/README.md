# Kimball dimensional model and bus matrix

Ralph Kimball's method, the most widely taught way to model a data warehouse for reporting. Each **business process** (sales, inventory, procurement) gets a star schema: a fact table with the numbers, surrounded by dimensions. The dimensions every process shares are **conformed**: built once and used by every star, so "sales by category" and "stock by category" use the same category. The **bus matrix** is the plan: one row per process, one column per conformed dimension. This example is a grocery chain, Corner Grocer.

| Business process | dim_date | dim_product | dim_store | Own dimensions |
|---|:-:|:-:|:-:|---|
| Retail sales (transaction fact) | ✓ | ✓ | ✓ | dim_promotion |
| Inventory (periodic snapshot) | ✓ | ✓ | ✓ | |
| Procurement (accumulating snapshot) | ✓ ×3 | ✓ | ✓ | dim_supplier |

| In the warehouse | In `.erd-studio/` |
|---|---|
| the presentation area (what users query) | one layer, `presentation/` |
| the conformed dimensions | the `conformed` schema: `presentation/tables/conformed/` |
| one schema per business process | `presentation/tables/sales/`, `inventory/`, `procurement/` |
| a row of the bus matrix | a diagram per process, plus `conformed-dimensions` for the columns |

```text
.erd-studio/
├── README.md
├── layers.json
└── presentation/
    ├── tables/
    │   ├── conformed/
    │   │   ├── dim_date.dbml
    │   │   ├── dim_product.dbml
    │   │   └── dim_store.dbml
    │   ├── inventory/
    │   │   └── fct_inventory_snapshot.dbml
    │   ├── procurement/
    │   │   ├── dim_supplier.dbml
    │   │   └── fct_purchase_order_pipeline.dbml
    │   └── sales/
    │       ├── dim_promotion.dbml
    │       └── fct_retail_sales.dbml
    ├── relationships/
    │   ├── inventory.dbml
    │   ├── procurement.dbml
    │   └── sales.dbml
    └── diagrams/
        ├── conformed-dimensions.dbml
        ├── inventory.dbml
        ├── procurement.dbml
        └── retail-sales.dbml
```

## What to notice

- **A project can have a single layer.** Kimball's staging area is for the load process, not for users, so this design models only the presentation area.
- **Conformed dimensions are one file each, on many diagrams.** `dim_date`, `dim_product` and `dim_store` sit in the `conformed` schema and appear on all three process diagrams.
- **Dimensions only one process uses stay with that process** (`sales.dim_promotion`, `procurement.dim_supplier`), with the role `domain-dim`. If inventory later needs suppliers, move `dim_supplier` to `conformed` with **Move Table…** and every diagram follows.
- **The three Kimball fact types**: `fct_retail_sales` is a transaction fact, `fct_inventory_snapshot` a periodic snapshot (its quantity is semi-additive), and `fct_purchase_order_pipeline` an accumulating snapshot.
- **Role-playing dimensions**: the purchase order pipeline points at `dim_date` three times. Each Ref has a role (`ordered date`, `received date`, `invoiced date`), shown on the line.
- **One relationships file per process team** (`sales.dbml`, `inventory.dbml`, `procurement.dbml`), so each team reviews its own changes. A new relationship of a fact goes to the file that already holds that fact's relationships.

## When to choose it

You build reporting marts for analysts and BI tools and want every report to agree on its dimensions. Kimball fits inside most other patterns too: the gold layer of a medallion lakehouse, a dbt project's marts, or a Data Vault's information marts are usually Kimball stars.
