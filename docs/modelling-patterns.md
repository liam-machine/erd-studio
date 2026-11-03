# Modelling patterns: fitting your warehouse into ERD Studio

Teams lay out their warehouses in different ways: bronze, silver and gold; dbt's staging and marts; Kimball stars; Data Vault; a database per stage; a data mesh. ERD Studio's folder tree fits all of them, because each folder answers one question, and you answer it with the words your warehouse already uses.

This page explains the tree, the four rules that keep any layout tidy, and how each common pattern maps onto it. Each pattern is a small, working [example project](examples/) you can open in VS Code. (The pages here say *diagram*; ERD Studio's commands call one a *subject area*.)

## The tree in one picture

```text
.erd-studio/
├── layers.json                  the stages of your warehouse, in order
└── <layer>/                     WHAT STAGE is it?           one per table
    ├── tables/
    │   └── <schema>/            WHERE does it live?         the warehouse's own schema name
    │       └── <table>.dbml     one table, declared Table <schema>.<table>
    ├── relationships/
    │   └── <file>.dbml          WHO OWNS the joins?         one file per layer, or split however you like
    └── diagrams/
        └── <diagram>.dbml       WHO LOOKS at it together?   as many as you need, sharing tables
```

| Folder | The question it answers | One or many per table? | Comes from |
|---|---|---|---|
| **Layer** | What stage of the warehouse is this? | Exactly one | Your stage names: `bronze`, `staging`, `raw_vault`, `prod` |
| **Schema folder** | Where does it live in the warehouse? | Exactly one | The schema as the warehouse spells it (in dbt, the configured `+schema`) |
| **Diagram** | Who looks at these tables together? | Any number, or none | A business process, a department, a source system, a data product |
| **Relationships file** | Who owns and reviews these joins? | Each relationship is in one file | Your teams: one file per layer by default |

A table *belongs* to one layer and one schema: its path says so. It *appears* on as many diagrams as need it, in any layer. That difference is what lets a conformed dimension be one file, used by every star.

## Four rules that keep any layout tidy

1. **Every table has one layer and one schema, and its path says both.** `gold/tables/sales/fct_order.dbml` holds `Table sales.fct_order`, in the gold layer. To change either, use **Move Table…**, and every diagram and relationships file that uses the table follows.
2. **The schema folder is the warehouse's schema, spelled exactly.** Don't invent folders for grouping: grouping is what diagrams are for. If your warehouse has one schema per layer, each layer has one schema folder named after it (`gold/tables/gold/`), and that's fine.
3. **Table names are unique across the whole project.** When the warehouse reuses a name in two places, give each table a unique name and put the warehouse's name in `alias`. Pick one prefix rule and use it everywhere: the source (`shopify_customers`), the layer (`silver_orders`, `gold_orders`) or the schema (`atlas_live__main_v1`).
4. **A relationship is stored once, with its foreign-key table.** Any diagram that shows both tables draws it, even when the tables are in different layers. A Ref from the business vault to a raw vault hub lives in the business vault's relationships file.

Everything else is your choice: how many layers, how many diagrams, and how you split relationships files.

## Find your pattern

| Pattern | Layers | Schema folders | Diagrams | Example |
|---|---|---|---|---|
| **Medallion lakehouse** (Databricks, Fabric) | `bronze`, `silver`, `gold` | one per layer (`gold/tables/gold/`), or one per area when each layer is a catalog | a source system, a star | [medallion](examples/medallion/) |
| **dbt project layers** (dbt Labs' guide) | `staging`, `intermediate`, `marts` | the configured `+schema` (`staging`, `marts`, or one per department) | a source folder, a department | [dbt-project-layers](examples/dbt-project-layers/) |
| **Kimball bus matrix** | one, `presentation` | `conformed` for shared dimensions, one per business process | a business process (a row of the bus matrix) | [kimball-bus-matrix](examples/kimball-bus-matrix/) |
| **Data Vault 2.0** | `raw_vault`, `business_vault`, `information_mart` | the vault schemas; one per mart | hubs with their links and satellites; query helpers; marts | [data-vault](examples/data-vault/) |
| **A database per stage** (GitLab's handbook) | `raw`, `prep`, `prod` (the databases) | the schemas in each database (`raw.zuora`, `prod.common`) | a source, a star, a mart | [gitlab-style](examples/gitlab-style/) |
| **Stage in the dataset name** (Mozilla's BigQuery) | `live`, `stable`, `derived`, `views` | the full dataset name (`atlas_derived`) | a group of versioned tables or views | [bigquery-versioned](examples/bigquery-versioned/) |
| **Data mesh** | the kind of data product: `source_aligned`, `aggregate`, `consumer_aligned` | one per domain (`orders`, `shipping`) | a data product | [data-mesh](examples/data-mesh/) |
| **Inmon enterprise warehouse** (a normalised core, team-owned marts) | `landing`, `edw`, `marts`, `reporting` | one per source system (landing), one per subject area (`party`, `arrangement`), one shared by several teams (marts) | a subject area, a department's stars | [enterprise-warehouse](examples/enterprise-warehouse/) |

Patterns combine. A medallion's gold layer, a dbt project's marts and a Data Vault's information marts are usually Kimball stars. Other shapes fit the same way: a "one big table" is a wide table with no relationships, on a diagram of its own (the medallion, GitLab-style and enterprise warehouse examples each have one), and an activity schema is one stream table per entity, beside its entity table (the enterprise warehouse example has one). Anchor modelling (sixth normal form, a table per attribute) fits like the enterprise warehouse's normalised layer, with narrower tables; there is no example of it.

## Your warehouse's words, in the tree

| If your warehouse has… | …it goes here | Notes |
|---|---|---|
| a stage (bronze, staging, raw vault, PROD) | a **layer** | Ids are lower case (`raw_vault`); the `label` in `layers.json` is what the screen shows (`Raw Vault`). |
| a catalog or database per stage | a **layer** | DBML names a table `schema.table`, so the database is the layer. |
| a catalog, database or project per environment (dev, test, prod) | **nothing** | One design, deployed to each environment. Environments are not layers. |
| a schema or dataset | a **schema folder** | Spelled exactly, prefixes and suffixes included (`silver_sales`, `atlas_derived`). |
| a source system | a schema folder (`raw/tables/zuora/`) when it has its own schema, else a name prefix (`shopify_orders`) and a diagram | |
| a department, domain or team | a schema folder when it has its own schema; always a diagram, and if you like a relationships file | |
| a conformed (shared) dimension | one table, in a shared schema (`conformed`, `shared`, `common`), on every diagram that uses it | Mark it `role: 'conformed-dim'`. |
| a business process, data product or dashboard | a **diagram** | A table can be on many diagrams, or none. |
| a view over a table | its own table | Add `meta_materialized: 'view'` and say what it reads in its design rationale. |
| a versioned table (`clients_daily_v6`) | its own table, version in the name | The next version is a new file beside it. |
| the same table name in two schemas or layers | two tables with unique names, the warehouse name in `alias` | See rule 3. |
| a hub, link, satellite, PIT or bridge | a table with `meta_vault_type` | ERD Studio's roles are Kimball's; vault types go in metadata. |

## Many teams, one model

The tree is built so that teams can work side by side without stepping on each other.

- **One file per table** means two people editing different tables never conflict, and a pull request shows exactly which tables changed.
- **Ownership follows folders.** Give each team a schema folder (or several), and if it wants, its own relationships file. A `CODEOWNERS` rule then asks the right team to review:

  ```text
  /.erd-studio/*/tables/orders/                          @acme/orders-team
  /.erd-studio/source_aligned/relationships/orders.dbml  @acme/orders-team
  ```

- **New relationships go to the right file by themselves.** ERD Studio saves a new relationship in the file that already holds most of its foreign-key table's relationships, so a team's split stays split; for a table with none yet, in `<layer>/relationships/<schema>.dbml` if that file exists; otherwise in the layer's shared file. Creating a file named after a schema is how a team gives that schema its own file; ERD Studio never creates one.
- **Two teams in one schema?** Folders can't say which team a table belongs to, so a brand-new table's first relationship goes to the shared file. Choose your team's file in **New Relationship** once; the table's later relationships follow it. The [enterprise warehouse example](examples/enterprise-warehouse/) walks through this, step by step.
- **Use another team's table; don't copy it.** A diagram can show any table in the project, from any layer. The [data mesh example](examples/data-mesh/) draws the orders team's `customer_order` on the shipping and payments diagrams.
- **Diagrams are cheap.** Make one per audience: a team's working view, a dashboard's tables, a source system. Each keeps its own layout, so rearranging one never moves another.
- **Say who owns a table in the table itself**, with `meta_owner: 'orders-team'`, so people and AI assistants reading the files know who to ask.

## Agree these on day one

A short list of decisions keeps a shared project consistent. Write them in your repo's README.

1. **The layers** and their order in `layers.json`, with labels and colours.
2. **What a schema folder is:** always the warehouse's schema name, never a grouping of your own.
3. **The prefix rule** for a name the warehouse reuses: by source, by layer or by schema.
4. **Where conformed dimensions live:** usually a shared schema in your reporting layer.
5. **How relationships files split:** one per layer (the default), or one per team or process.
6. **Which layers get diagrams.** Most teams draw their reporting layer in detail and their landing layer lightly, or not at all.

## What the tree doesn't model

- **The database or project part of a name.** DBML names a table `schema.table`. When databases are stages, make them layers; when they are environments, leave them out.
- **Environments.** One design serves dev, test and prod.
- **Lineage between layers.** That gold's `dim_customer` is built from silver's `customers` is a pipeline step, not a foreign key. Write it in the table's design rationale. Using dbt? The **Physical** tab shows what dbt built.
- **One table in two layers.** No mainstream method has one: Kimball, Data Vault and medallion all build a new table at each stage. A table belongs to one layer and can appear on diagrams in any layer.
- **Relationships between repositories.** Keep the whole model, even a whole data mesh, in one repository and one `.erd-studio` folder.
- **Who owns a table, by folder alone,** when teams share a schema. Say it in the table (`meta_owner`) and list the team's files in `CODEOWNERS`, as the [enterprise warehouse example](examples/enterprise-warehouse/) does.

## Try the examples

Each folder in [`docs/examples/`](examples/) is a small project of its own, and every one ships inside ERD Studio: run **ERD Studio: Open an Example Project…** (or click **Open an example** on the Welcome tab, the walkthrough or the empty sidebar), pick one and a folder to put it in, and it opens in a window of its own with its first diagram on the canvas. From a clone of this repository, open one with **File > Open Folder…** instead, then click **ERD Studio** in the Activity Bar. None needs dbt. New to ERD Studio? The [enterprise warehouse example](examples/enterprise-warehouse/) has a ten-minute walkthrough. The [file format reference](semantic-domain-json-reference.md) describes each file.
