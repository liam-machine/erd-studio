# Data Vault 2.0 (raw vault, business vault, information marts)

Dan Linstedt's method, common in banking, insurance and government, where the warehouse must keep every change from every source and be auditable. The **raw vault** stores data as it arrived: **hubs** (one row per business key), **links** (relationships between keys) and **satellites** (the descriptive history, one per source). The **business vault** adds business rules and query helpers: computed satellites, **point-in-time (PIT)** and **bridge** tables. **Information marts** are the star schemas users query. This example is an insurer, Meridian Insurance, with a CRM and a policy administration system. The names follow AutomateDV, the dbt package for Data Vault (`hub_`, `link_`, `sat_`, `pit_`, `bridge_`, `_hk` hash keys).

| In the warehouse | In `.erd-studio/` |
|---|---|
| raw vault, business vault, information marts | a layer each: `raw_vault/`, `business_vault/`, `information_mart/` |
| the vault schemas | `raw_vault/tables/raw_vault/`, `business_vault/tables/business_vault/` |
| a mart's schema | `information_mart/tables/underwriting/` (and `shared/` for the calendar) |
| hub, link, satellite, PIT, bridge | a table, with `meta_vault_type` saying which |

```text
.erd-studio/
├── README.md
├── layers.json
├── raw_vault/
│   ├── tables/
│   │   └── raw_vault/
│   │       ├── hub_customer.dbml
│   │       ├── hub_policy.dbml
│   │       ├── link_customer_policy.dbml
│   │       ├── sat_customer_crm.dbml
│   │       ├── sat_customer_policy_admin.dbml
│   │       ├── sat_customer_policy_effectivity.dbml
│   │       └── sat_policy_policy_admin.dbml
│   ├── relationships/
│   │   └── raw_vault.dbml
│   └── diagrams/
│       └── customer-and-policy.dbml
├── business_vault/
│   ├── tables/
│   │   └── business_vault/
│   │       ├── bridge_customer_policy.dbml
│   │       ├── pit_customer.dbml
│   │       └── sat_customer_risk_score.dbml
│   ├── relationships/
│   │   └── business_vault.dbml
│   └── diagrams/
│       └── query-helpers.dbml
└── information_mart/
    ├── tables/
    │   ├── shared/
    │   │   └── dim_date.dbml
    │   └── underwriting/
    │       ├── dim_customer.dbml
    │       ├── dim_policy.dbml
    │       └── fct_policy_month.dbml
    ├── relationships/
    │   └── information_mart.dbml
    └── diagrams/
        └── underwriting.dbml
```

## What to notice

- **Vault object types are metadata.** ERD Studio's table roles are Kimball's (`conformed-dim`, `transaction-fact`, …), so the vault tables leave `role` empty and say what they are in `meta_vault_type: 'hub'`. The marts use the Kimball roles as usual.
- **Satellites have two-column keys** (`customer_hk`, `load_datetime`), written as an `indexes { (customer_hk, load_datetime) [pk] }` block.
- **The PIT table points at satellites with composite relationships**: `pit_customer.(customer_hk, sat_customer_crm_ldts)` points at `sat_customer_crm.(customer_hk, load_datetime)`, one Ref with both columns. Each has a role (`crm`, `policy admin`, `risk score`).
- **Relationships cross layers.** The business vault's computed satellite, PIT and bridge point at the raw vault's hubs and satellites. A Ref lives with its foreign-key table, so those Refs are in `business_vault/relationships/business_vault.dbml`, with `use` lines reaching into `../../raw_vault/tables/`.
- **A diagram can draw tables from another layer.** The business vault's **query-helpers** diagram shows its own tables beside the raw vault tables they point at, so it imports both layers' relationships files.
- **Marts are built from the vault, not joined to it.** `dim_customer` reuses the hub's hash key as its surrogate key, but the information mart has no foreign keys into the vault: that is lineage, written in the design rationale.

## When to choose it

Many sources describe the same business keys, history and audit matter, and the sources change often. Users never query the vault directly; give them Kimball information marts.
