# dbt project layers (staging, intermediate, marts)

The structure dbt Labs recommends in [How we structure our dbt projects](https://docs.getdbt.com/best-practices/how-we-structure/1-guide-overview), and the default for most dbt teams. **Staging** models are one per source table, in a folder per source system, named `stg_<source>__<entity>s`. **Intermediate** models are building blocks, named for what they do (`int_<entity>s_<verb>s`), and are not for end users. **Marts** are one model per business entity, grouped by department, with plain names (`customers`, `invoices`) and no `dim_` or `fct_` prefix. This example is a subscription software company, Lumen, with Stripe and its own product database as sources.

| In the dbt project | In `.erd-studio/` |
|---|---|
| `models/staging/`, `models/intermediate/`, `models/marts/` | a layer each: `staging/`, `intermediate/`, `marts/` |
| `+schema: staging` (and `intermediate`, `marts`) | the schema folder: `staging/tables/staging/` |
| a source folder (`models/staging/stripe/`) or a department folder (`models/marts/finance/`) | a diagram: `staging/diagrams/stripe.dbml`, `marts/diagrams/finance.dbml` |
| a model | a table |

```text
.erd-studio/
├── README.md
├── layers.json
├── staging/
│   ├── tables/
│   │   └── staging/
│   │       ├── stg_app__accounts.dbml
│   │       ├── stg_app__users.dbml
│   │       ├── stg_stripe__customers.dbml
│   │       ├── stg_stripe__invoices.dbml
│   │       └── stg_stripe__subscriptions.dbml
│   ├── relationships/
│   │   └── staging.dbml
│   └── diagrams/
│       ├── app.dbml
│       └── stripe.dbml
├── intermediate/
│   ├── tables/
│   │   └── intermediate/
│   │       └── int_invoices_allocated_to_months.dbml
│   ├── relationships/
│   │   └── intermediate.dbml
│   └── diagrams/
│       └── revenue.dbml
└── marts/
    ├── tables/
    │   └── marts/
    │       ├── customers.dbml
    │       ├── invoices.dbml
    │       ├── monthly_revenue.dbml
    │       └── users.dbml
    ├── relationships/
    │   └── marts.dbml
    └── diagrams/
        ├── finance.dbml
        └── marketing.dbml
```

## What to notice

- **The schema folder is dbt's configured schema, not the folder in `models/`.** The guide's config sets `+schema: staging`, `intermediate` and `marts`, so each layer has one schema folder. dbt builds the schema as `<target schema>_<custom schema>` (for example `analytics_prod_marts`); ERD Studio uses the custom schema you configured (`marts`), the same in every environment.
- **Your `models/` folders become diagrams.** The source folders under `staging/` and the department folders under `marts/` are what people look at together, so each is a diagram. If you set `+schema` per department (`finance`, `marketing`), use those as schema folders instead: `marts/tables/finance/`.
- **Prefixes are optional.** The marts follow the guide's plain entity names and still carry a Kimball role (`customers` is a `conformed-dim`, `invoices` a `transaction-fact`), so the canvas shows what each table is without a `dim_` or `fct_` in the name.
- **A table shared by two departments is one file.** The guide warns against a copy per department (`finance_orders`, `marketing_orders`); here one `customers` file is on both the **finance** and **marketing** diagrams.
- **Intermediate models can be drawn with what they read.** The **revenue** diagram shows `int_invoices_allocated_to_months` beside the staging model it reads, across layers.
- **Using dbt?** Open its folder to compare your design with what dbt built, on the **Physical** tab and with **⊕ Diff**. **ERD Studio: Draw from dbt…** draws a first diagram from your models.

## When to choose it

You use dbt and follow its guide. Most teams model the marts in most detail, since that is what people query, and keep staging diagrams to one per source.
