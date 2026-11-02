# Data mesh: domain teams in one repository

In a data mesh (Zhamak Dehghani's term), each business domain owns and publishes its own data as **data products**, instead of one central team owning the warehouse. Dehghani sorts domain data into three kinds: **source-aligned** (what a domain's own systems produce), **aggregate** (built from several domains), and **consumer-aligned** (shaped for one use). This example is a parcel delivery company, Parcelpoint, with accounts, orders, shipping and payments domains.

| In the mesh | In `.erd-studio/` |
|---|---|
| the kind of data product | a layer: `source_aligned/`, `aggregate/`, `consumer_aligned/` |
| a domain (and its schema) | a schema folder: `source_aligned/tables/orders/`, `…/shipping/` |
| a domain team's relationships | its own relationships file: `source_aligned/relationships/orders.dbml` |
| a data product | a diagram |
| the owning team | `meta_owner` on each table, and a `CODEOWNERS` rule on its folders |

```text
.erd-studio/
├── README.md
├── layers.json
├── source_aligned/
│   ├── tables/
│   │   ├── accounts/
│   │   │   └── account.dbml
│   │   ├── orders/
│   │   │   └── customer_order.dbml
│   │   ├── payments/
│   │   │   └── payment.dbml
│   │   └── shipping/
│   │       ├── carrier.dbml
│   │       ├── shipment.dbml
│   │       └── tracking_event.dbml
│   ├── relationships/
│   │   ├── orders.dbml
│   │   ├── payments.dbml
│   │   └── shipping.dbml
│   └── diagrams/
│       ├── orders.dbml
│       ├── payments.dbml
│       └── shipping.dbml
├── aggregate/
│   ├── tables/
│   │   └── customer/
│   │       └── customer_profile.dbml
│   ├── relationships/
│   │   └── customer.dbml
│   └── diagrams/
│       └── customer-360.dbml
└── consumer_aligned/
    ├── tables/
    │   └── delivery_insights/
    │       └── fct_shipment_delivery.dbml
    ├── relationships/
    │   └── delivery_insights.dbml
    └── diagrams/
        └── delivery-performance.dbml
```

## What to notice

- **The layer says what kind of data product it is; the schema says which domain owns it.** That keeps a domain's tables together in one folder per layer, ready for an ownership rule.
- **Each domain has its own relationships file**, so a domain team's pull requests touch only its own files. A Ref that crosses domains lives with its foreign-key table: `shipment.order_id` points into the orders domain, and that Ref is in `shipping.dbml`.
- **A diagram can show another domain's table** (`customer_order` on the **shipping** and **payments** diagrams) without copying it. It is one file, owned by the orders team.
- **Ownership is visible in two places**: `meta_owner` on every table, for people and AI assistants reading the files, and a `CODEOWNERS` file so GitHub asks the right team to review:

  ```text
  # .github/CODEOWNERS
  /.erd-studio/*/tables/orders/                    @parcelpoint/orders-team
  /.erd-studio/source_aligned/relationships/orders.dbml  @parcelpoint/orders-team
  /.erd-studio/*/tables/shipping/                  @parcelpoint/shipping-team
  /.erd-studio/source_aligned/relationships/shipping.dbml  @parcelpoint/shipping-team
  /.erd-studio/aggregate/                          @parcelpoint/customer-team
  ```

## When to choose it

Several teams each own a part of the data and want to review only their own changes, while still seeing how their data connects to everyone else's. Keep one repository (and one `.erd-studio` folder) for the whole mesh: ERD Studio does not follow relationships between repositories.
