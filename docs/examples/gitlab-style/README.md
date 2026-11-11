# A database per stage (RAW, PREP, PROD), GitLab style

GitLab's data team publishes its whole warehouse layout in its [handbook](https://handbook.gitlab.com/handbook/enterprise-data/platform/). It uses **three databases**: **RAW** (data as extracted, one schema per source), **PREP** (source models, still one schema per source, named `<source>_<table>_source`) and **PROD**, which holds the [Enterprise Dimensional Model](https://handbook.gitlab.com/handbook/enterprise-data/platform/edw/) in schema `common` (`dim_`, `fct_` and `bdg_` tables), its building blocks in `common_prep` (`prep_`), mappings in `common_mapping` (`map_`), marts in `common_mart` schemas (`mart_`), older work in `legacy` and team areas in `workspace_<team>`. Splitting stages by database is a common Snowflake setup too. This example is a software company with Salesforce (`sfdc`) for sales and Zuora for billing, laid out the way the handbook describes.

| In the warehouse | In `.erd-studio/` |
|---|---|
| a database: RAW, PREP, PROD | a layer: `raw/`, `prep/`, `prod/` |
| a schema in it: `raw.zuora`, `prod.common`, `prod.common_mart` | a schema folder: `raw/tables/zuora/`, `prod/tables/common/` |
| `database.schema.table` | `<layer>/tables/<schema>/<table>.dbml`, declared `Table <schema>.<table>` |

```text
.erd-studio/
├── README.md
├── layers.json
├── raw/
│   ├── tables/
│   │   ├── sfdc/
│   │   │   └── sfdc_account.dbml
│   │   └── zuora/
│   │       ├── zuora_account.dbml
│   │       └── zuora_subscription.dbml
│   ├── relationships/
│   │   └── raw.dbml
│   └── diagrams/
│       └── sources.dbml
├── prep/
│   ├── tables/
│   │   ├── sfdc/
│   │   │   └── sfdc_account_source.dbml
│   │   └── zuora/
│   │       ├── zuora_account_source.dbml
│   │       └── zuora_subscription_source.dbml
│   ├── relationships/
│   │   └── prep.dbml
│   └── diagrams/
│       └── source-models.dbml
└── prod/
    ├── tables/
    │   ├── common/
    │   │   ├── dim_billing_account.dbml
    │   │   ├── dim_crm_account.dbml
    │   │   ├── dim_date.dbml
    │   │   ├── dim_subscription.dbml
    │   │   └── fct_mrr.dbml
    │   ├── common_mart/
    │   │   └── mart_arr.dbml
    │   └── common_prep/
    │       └── prep_subscription.dbml
    ├── relationships/
    │   └── prod.dbml
    └── diagrams/
        ├── arr-mart.dbml
        └── arr.dbml
```

## What to notice

- **The database is the layer.** DBML names a table `schema.table` and has no database part, so the third part of the name is the layer folder. Several schemas sit in each layer.
- **The same source schema in two layers.** `sfdc` and `zuora` are schemas in both RAW and PREP, so `raw/tables/zuora/` and `prep/tables/zuora/` both exist. That is fine: a schema folder belongs to its layer.
- **The same warehouse name in two schemas.** RAW has `sfdc.account` and `zuora.account`. Two schemas may each hold a table of one name, so both could be `account`; this example names them `sfdc_account` and `zuora_account`, each with `alias: 'account'`, as earlier ERD Studio versions required.
- **A model's name doesn't decide its layer; where it builds does.** `prep_subscription` builds into PROD's `common_prep` schema, so it is in `prod/tables/common_prep/`, not in the PREP layer.
- **Marts are wide tables with no relationships**: `mart_arr` is `fct_mrr` already joined to its dimensions.
- **A table needn't be on a diagram.** `prep_subscription` is a building block nobody needs to look at; it is in the Table Library and on no diagram.
- **Leave out what isn't design.** Per-developer databases (GitLab gives each developer their own `<name>_PROD` and `<name>_PREP`) are environments, not layers. A `workspace_<team>` schema is a schema folder like any other if a team wants its tables in the design.

## When to choose it

Your warehouse separates stages by database (Snowflake, SQL Server, Redshift), or your team follows GitLab's published layout.
