<h1 align="center">ERD Studio</h1>

<p align="center">
  <strong>Design your data model in Git. Let your AI build from it.</strong><br />
  A canvas for your logical data model in VS Code, saved as DBML in your repo.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><img src="https://img.shields.io/badge/Install%20in%20VS%20Code-0e639c?style=for-the-badge" alt="Install in VS Code" /></a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><img src="https://vsmarketplacebadges.dev/version-short/liamwynne.erd-studio.svg" alt="VS Marketplace Version" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><img src="https://vsmarketplacebadges.dev/installs-short/liamwynne.erd-studio.svg" alt="Installs" /></a>
  <a href="https://open-vsx.org/extension/liamwynne/erd-studio"><img src="https://img.shields.io/open-vsx/v/liamwynne/erd-studio?label=Open%20VSX&color=a60ee5" alt="Open VSX Version" /></a>
  <br />
  <sub>Free to use. Source available under the <a href="https://github.com/liam-machine/erd-studio/blob/main/LICENSE">PolyForm Shield licence</a>.</sub>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/liam-machine/erd-studio/main/media/demo.gif" width="800" alt="A screen recording of ERD Studio in VS Code&#39;s dark theme. Close up on a retail sales diagram, the pointer lands on sales.fct_retail_sales and its relationship lines light up in amber with moving arrows. Then Claude Code, in the terminal beside the diagram, is asked to add a payment method dimension: it loads the erd-studio skill, writes dim_payment_method.dbml, updates the other DBML files and the SQL, and the new table appears on the diagram with its line; the view moves in on it and a green outline labels it Added by your AI. Then the promotion_key column is dragged onto dim_promotion, the New Relationship dialog reads Many fct_retail_sales rows → one dim_promotion, and Create Relationship draws the line while the line Ref: sales.fct_retail_sales.promotion_key &gt;? sales.dim_promotion.promotion_key appears in sales.dbml beside it. Captions: Your data model, in VS Code. Ask your AI for a table. It writes plain DBML files. The new table lands on the diagram. Or drag a column to relate two tables. It is one Ref line in a DBML file. DBML, an open format · Free to use in VS Code." />
</p>

**A data model that lives apart from the code goes stale, and after three months nobody trusts it.** ERD Studio keeps yours in your repo: you draw it on a canvas in VS Code, each table is a DBML file, and a model change is reviewed in the same pull request as the SQL.

> "Amazing, great to combine with Github Copilot."
>
> "An ERD tool made for AI and dbt, so much better then paid options out there."
>
> Reviews on the Visual Studio Marketplace

## Why ERD Studio

- **A diagram of your DBML.** [DBML](https://dbml.dbdiagram.io/docs) is the open-source schema language behind dbdiagram.io: an open format, so there is no lock-in. ERD Studio draws it, and writes it back as you edit.
- **A logical model, not only boxes and lines.** Grain, primary, foreign and natural keys, SCD types, table roles and design rationale.
- **In your repo.** One file per table, reviewed like code. No account, server or database.
- **Made for your AI.** Claude Code, GitHub Copilot, Codex, Gemini CLI and Cursor read and write the same files; you review their changes on the canvas.

## On the canvas

<p align="center">
  <img src="https://raw.githubusercontent.com/liam-machine/erd-studio/main/media/screenshot-canvas-light.png" width="800" alt="A screenshot of the ERD Studio canvas in VS Code's light theme: a retail sales star schema of five tables, each with its grain, keys and column types. The pointer rests on sales.fct_retail_sales, and its four relationships to dim_date, dim_store, dim_product and dim_promotion light up in amber with arrows. The toolbar, the table count and the minimap float over the canvas as rounded, see-through panels. On the left, the ERD Studio side panel searches and lists the diagrams, the Table Library by layer and schema, the relationships, and Help &amp; Feedback." /><br /><br />
  <sub>Light theme: hover a table and its relationships light up.</sub>
</p>

- **Relate by dragging.** Drag a column onto another table's column: it is one `Ref` line in a file.
- **One table, many diagrams.** Every diagram draws from one Table Library.
- **The detail behind each table.** Click a table for its columns, relationships, grain, purpose and the decisions behind it.
- **Relationships nobody declared.** From your column names and keys, **Suggest Relationships…** proposes them; you choose which to add.
- **Room for a warehouse.** Layers, schemas, search and a minimap; the tour shows a 2,000-table diagram.

## Get started

1. [Install ERD Studio](https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio) (VS Code 1.85+, or [Open VSX](https://open-vsx.org/extension/liamwynne/erd-studio) for VSCodium, Cursor and Windsurf).
2. Open any folder and click **ERD Studio** in the Activity Bar.
3. Click **Import Your Data Model…**: it looks at the folder, on your machine only, and puts the import that fits first. Or click **New Diagram…** for an empty canvas.

**Import from:** Databricks · Snowflake · Power BI · Microsoft Fabric · SQL Server and Azure SQL · PostgreSQL · MySQL and MariaDB · Oracle · BigQuery · Redshift · SQLite · DuckDB · dbdiagram.io and other DBML tools · modelling tools that export SQL or DBML.

Each arrives as a file you export, never a live connection: **Import your Power BI semantic model**, **Import your SQL scripts** or **Import your DBML file**. [The guide](docs/import-existing-models.md) has the export step for each. Every import opens as a draft; nothing is written until you press **Keep as Diagram**. With nothing to import, **Open an Example…** is a finished coffee-shop model.

<table align="center"><tr>
<td width="300"><a href="https://cdn.jsdelivr.net/gh/liam-machine/erd-studio@main/docs/assets/getting-started.mp4"><img src="https://raw.githubusercontent.com/liam-machine/erd-studio/main/docs/assets/getting-started-play.jpg" width="300" alt="Play Watch the Tour (2:48): ERD Studio recorded in VS Code's light theme. It shows the tools it imports from, imports a PostgreSQL schema exported with one pg_dump command, shows its DBML files next to the code and a 2,000-table diagram, edits it by hand and with an AI assistant, reviews the DBML and SQL in one pull request, compares the design with what the code builds, and shows ERD Studio for Confluence drawing it from GitHub." /></a></td>
<td><strong>Watch the Tour (2:48).</strong> Import a model, edit it by hand or with your AI assistant, and review it in one pull request.</td>
</tr></table>

## What's in your repo

Commit the `.erd-studio/` folder: that's your data model.

```text
.erd-studio/
├── README.md                     ← what the folders are
├── layers.json                   ← your layers, in order
└── gold/                         ← a layer (silver, gold, …)
    ├── tables/
    │   └── sales/                ← a schema
    │       ├── dim_customer.dbml ← one file per table, shared by every diagram
    │       └── fct_order.dbml
    ├── relationships/
    │   └── gold.dbml             ← one Ref line per relationship
    └── diagrams/
        └── orders.dbml           ← the tables a diagram shows, and where they sit
```

```dbml
// .erd-studio/gold/tables/sales/fct_order.dbml
Table sales.fct_order [
  role: 'transaction-fact',
  grain: 'One row per order'
] {
  Note: 'Customer orders from the shop and the app.'

  order_id    BIGINT          [pk]
  customer_id BIGINT          [foreign_key: 'true']
  order_total "DECIMAL(12,2)" [additive_type: 'additive']
}
```

Edit on the canvas or in the files and the other follows; your comments and hand edits stay ([file format reference](docs/semantic-domain-json-reference.md)). [Modelling patterns](docs/modelling-patterns.md) maps eight warehouse layouts, from medallion to data mesh, each with an [example project](docs/examples/).

Have a YAML/JSON project from before 2.0? It keeps working. [Common questions](docs/faq.md) covers converting it to DBML.

## Work with your AI assistant

In the ERD Studio sidebar, under **Help & Feedback**, click **Set Up My AI Helper**. It teaches the assistants on your computer ERD Studio's files. Then ask:

> Propose a star schema for orders in ERD Studio, with grain, keys and design rationale. Let me review the diagram before we write any SQL.

Its changes are file edits you review like any other. The helper also adds a guided setup (`/erd-studio-setup`) that designs a first diagram with you. See [AI assistants](docs/ai-assistants.md).

## Share it

**Export Diagram…** writes a single file for dbdiagram.io, or Mermaid ([DBML import and export](docs/leaving-erd-studio.md)). For people outside VS Code, [ERD Studio for Confluence](https://marketplace.atlassian.com/apps/4177786702/erd-studio-for-confluence), a separate paid app, draws the diagrams in your GitHub repo on a Confluence page, read-only.

## Using dbt?

dbt is optional. Open the folder that holds your `dbt_project.yml` and the start screen leads with **Import from dbt**, which drafts a first diagram from your dbt models to refine by hand or with your AI assistant. The canvas gets two tabs, **Logical** (your design) · **Physical** (read from dbt), and **Compare with dbt** highlights missing columns, type differences and relationship mismatches. [Using ERD Studio with dbt](docs/dbt.md) covers the rest.

## Learn more

- [Common questions](docs/faq.md): upgrading to 2.0 and everyday tasks
- [Choosing the project folder](docs/project-folder.md) · [Glossary](docs/glossary.md)
- Bug or idea? Run **ERD Studio: Send Feedback**, or [open an issue](https://github.com/liam-machine/erd-studio/issues).

Built by a data engineer who wanted the model reviewed with the code: [liam-machine on GitHub](https://github.com/liam-machine).
