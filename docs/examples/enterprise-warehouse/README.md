# Enterprise warehouse: many sources, a normalised core, teams that share

Bellbird Bank (an invented bank) builds its warehouse the way Bill Inmon describes: every source system **lands** as it is, a **normalised enterprise warehouse** (third normal form, one schema per subject area) becomes the one place each fact is kept, and each department gets **star schemas** built from it. Dashboards read a **one big table** and an **activity stream**.

It is also the example of the cases where the folders alone don't decide where a relationship is saved, and what you do about each:

| Situation | Where to look | What ERD Studio does | What you do |
|---|---|---|---|
| Many small sources, a schema each | **Landing**: nine schemas | keeps all their relationships in one shared file, `landing.dbml` | nothing; a source team that wants its own file creates `landing/relationships/<schema>.dbml` |
| A subject area with a team of its own | **Enterprise warehouse**: the `party` schema | sees `party.dbml`, a file named after the schema, and saves party tables' new relationships there | create the schema's file once; that is the opt-in |
| Two teams in one schema | **Marts**: finance and marketing share `marts` | keeps a table's relationships together, in `finance.dbml` or `marketing.dbml`, but saves a brand-new table's first one in the shared `marts.dbml` | choose your team's file in **New Relationship**, once per new table |
| A join that crosses layers | **Marts → finance**: balances point at the warehouse's `account` | saves it with the table that holds the foreign key, in `finance.dbml` | find it in **Relationships**, under either table |
| Tables with no joins | **Reporting**: one big table, an activity stream | draws them with no lines | nothing: their grain and columns are the design |

| In the warehouse | In `.erd-studio/` |
|---|---|
| landing, enterprise warehouse, marts, reporting | a layer each: `landing/`, `edw/`, `marts/`, `reporting/` |
| a source system (landing) or a subject area (warehouse) | a schema folder: `landing/tables/cards/`, `edw/tables/party/` |
| who owns a table | an `owner` setting on the table, and a line in `.github/CODEOWNERS` |
| a team's joins | a relationships file: `marts/relationships/finance.dbml` |

```text
.erd-studio/
├── README.md
├── layers.json
├── landing/
│   ├── tables/
│   │   ├── branches/
│   │   │   └── branches_site.dbml
│   │   ├── call_centre/
│   │   │   └── call_centre_call.dbml
│   │   ├── campaigns/
│   │   │   └── campaigns_send.dbml
│   │   ├── cards/
│   │   │   ├── cards_account.dbml
│   │   │   └── cards_transaction.dbml
│   │   ├── core_banking/
│   │   │   ├── core_account.dbml
│   │   │   ├── core_customer.dbml
│   │   │   └── core_transaction.dbml
│   │   ├── crm/
│   │   │   └── crm_contact.dbml
│   │   ├── fraud/
│   │   │   └── fraud_alert.dbml
│   │   ├── loans/
│   │   │   └── loans_application.dbml
│   │   └── web/
│   │       └── web_session.dbml
│   ├── relationships/
│   │   └── landing.dbml
│   └── diagrams/
│       └── source-systems.dbml
├── edw/
│   ├── tables/
│   │   ├── arrangement/
│   │   │   ├── account.dbml
│   │   │   └── account_party_role.dbml
│   │   ├── event/
│   │   │   ├── interaction_event.dbml
│   │   │   └── transaction_event.dbml
│   │   ├── location/
│   │   │   └── branch.dbml
│   │   ├── party/
│   │   │   ├── organisation.dbml
│   │   │   ├── party.dbml
│   │   │   ├── party_relationship.dbml
│   │   │   └── person.dbml
│   │   └── product/
│   │       └── product.dbml
│   ├── relationships/
│   │   ├── edw.dbml
│   │   └── party.dbml
│   └── diagrams/
│       ├── events.dbml
│       └── party-and-accounts.dbml
├── marts/
│   ├── tables/
│   │   └── marts/
│   │       ├── dim_branch.dbml
│   │       ├── dim_campaign.dbml
│   │       ├── dim_customer.dbml
│   │       ├── dim_date.dbml
│   │       ├── dim_product.dbml
│   │       ├── fct_account_balance_daily.dbml
│   │       ├── fct_campaign_cost.dbml
│   │       ├── fct_campaign_response.dbml
│   │       └── fct_fee.dbml
│   ├── relationships/
│   │   ├── finance.dbml
│   │   ├── marketing.dbml
│   │   └── marts.dbml
│   └── diagrams/
│       ├── finance.dbml
│       └── marketing.dbml
└── reporting/
    ├── tables/
    │   └── reporting/
    │       ├── customer_activity.dbml
    │       └── obt_customer_360.dbml
    └── diagrams/
        └── customer-360.dbml
```

## Walk through it (about ten minutes)

Open this folder in VS Code: **File > Open Folder…**, choose `enterprise-warehouse`, then click **ERD Studio** in the Activity Bar. You need nothing else: no dbt, no database.

1. **See the layers.** The **Diagrams** section lists four layers in the order data flows through them: Landing, Enterprise warehouse, Marts, Reporting. The **Table Library** shows each layer's schemas, and **Relationships** each layer's joins. Every layer row has the same icon, in the layer's colour.

2. **Many sources, one file.** Open **Landing → source-systems**: nine schemas, one per system the bank runs, and four relationships: three inside a source (an account belongs to a customer in `core_banking`), and one between two (a fraud alert points at a card transaction). In **Relationships**, choose **Group by Relationships File** in its title bar: all four are in `landing.dbml`. Many small schemas don't need many files.

3. **A normalised core.** Open **Enterprise warehouse → party-and-accounts**. Four things a star schema doesn't have:
   - `person` and `organisation` are **one-to-one** with `party`: every person is a party, with the same id.
   - `party_relationship` joins `party` to **itself**, twice: who is a director of which company.
   - `account_party_role` is **many-to-many**: an account can have joint owners, and a person can hold many accounts.
   - `product` points at **itself**: a product's family.

4. **Who owns what.** In the **Table Library**, click the filter icon (or press Cmd+F / Ctrl+F) and type `owner:customer-data`: the four party tables. Click `party` on the canvas: its panel shows **Reviewed by @bellbird-bank/customer-data**, read from this folder's `.github/CODEOWNERS`, and **owner** `customer-data` among its fields, under **Not in your list** (this project has no `fields.yml`).

5. **A schema with its own file.** With **Relationships** grouped by file, the warehouse has two: `edw.dbml` (the data architecture team's) and `party.dbml` (the Customer Data team's). Because a file named after the `party` schema exists, a party table's next new relationship is saved there. `account_party_role` points at `party` too, but its relationships are in `edw.dbml`: a relationship lives with the table that holds the foreign key, and that table is in `arrangement`.

6. **Two teams in one schema.** Open **Marts → marketing**. `fct_campaign_cost` has no relationships yet, so add one: **+ Add → New Relationship**, from `fct_campaign_cost.campaign_key` to `dim_campaign.campaign_key`. **Stored in** shows `.erd-studio/marts/relationships/marts.dbml (default)`, the shared file, because nothing in the folders says this table is marketing's. Choose `.erd-studio/marts/relationships/marketing.dbml`, then **Create Relationship**. Now add `fct_campaign_cost.date_key` → `dim_date.date_key`: it goes to `marketing.dbml` by itself, because a table's relationships stay together. **Cmd+Z** (Ctrl+Z) twice puts the example back.

7. **A join across layers.** Open **Marts → finance**. In the **Diagrams** section the finance row says one table is from the Enterprise warehouse: `account`, which `fct_account_balance_daily` points at so finance can drill through to the account of record. That relationship is saved in `marts/relationships/finance.dbml`, with the table that holds the foreign key, so the warehouse team won't find it in their files. In **Relationships**, choose **Group by Table** in its title bar (the view's default): it's listed under both tables.

8. **No joins at all.** Open **Reporting → customer-360**: one big table and an activity stream, side by side with no lines. Click either one: its **grain** (one row per customer; one row per thing a customer did) and its columns are the design.

## How ERD Studio chooses a relationship's file

When you add a relationship, ERD Studio saves it in:

1. the relationships file that already holds the most of that table's relationships (a table's relationships stay together); else
2. `<layer>/relationships/<schema>.dbml`, if that file exists; else
3. the layer's shared file, `<layer>/relationships/<layer>.dbml`.

The table that counts is the one holding the foreign key. ERD Studio never creates a schema's file, and never moves a relationship you already have. **New Relationship** shows the file before it saves, and lets you choose another of the layer's files.

## When to choose it

You are a large organisation with many source systems, a central team that owns an integrated, normalised model, and departments that build their own reporting on it. If you don't need the normalised layer, [medallion](../medallion/) or [dbt-project-layers](../dbt-project-layers/) are simpler; if each department owns its own data end to end, see [data-mesh](../data-mesh/).
