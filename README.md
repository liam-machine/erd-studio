<h1 align="center">ERD Studio</h1>

<p align="center">
  <strong>Design your data model in Git. Let your AI build from it.</strong><br />
  A logical data modeling canvas for VS Code: your model saved as DBML, an open format, in your repo, and a live comparison with your dbt project.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><img src="https://img.shields.io/badge/Install%20in%20VS%20Code-0e639c?style=for-the-badge" alt="Install in VS Code" /></a>
</p>

<p align="center">
  <strong>No dbt needed.</strong> Open any folder, then click <strong>New Diagram</strong> or <strong>Import DBML</strong>. <a href="#get-started">Get started</a><br />
  <strong>Using dbt?</strong> Open its folder to compare your design with what dbt built. <a href="#using-dbt">How it works</a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><img src="https://vsmarketplacebadges.dev/version-short/liamwynne.erd-studio.svg" alt="VS Marketplace Version" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><img src="https://vsmarketplacebadges.dev/installs-short/liamwynne.erd-studio.svg" alt="Installs" /></a>
  <a href="https://open-vsx.org/extension/liamwynne/erd-studio"><img src="https://img.shields.io/open-vsx/v/liamwynne/erd-studio?label=Open%20VSX&color=a60ee5" alt="Open VSX Version" /></a>
  <br />
  <sub>Free to use, source available under the <a href="https://github.com/liam-machine/erd-studio/blob/main/LICENSE">PolyForm Shield License</a>.</sub>
</p>

<!-- TODO: re-shoot as a logical-only hero: a folder with no dbt_project.yml, no Physical tab, the Explorer showing .erd-studio/gold/tables/gold/*.dbml beside the canvas, ideally one frame of the Import DBML summary. The current GIF is a dbt project and cycles to the Physical stage and the discrepancy overlay, which a reader without dbt will never see. Rewrite the alt text with it. -->
<p align="center">
  <img src="https://raw.githubusercontent.com/liam-machine/erd-studio/main/media/demo.gif" width="800" alt="ERD Studio open in VS Code, showing four views of the same star schema. Logical stage: dim_customer, dim_date, dim_project and dim_task around the fct_order and fct_task_event facts, each dimension showing a PK surrogate key and an NK business key. Detail panel: dim_customer's columns, role and relationships opened for editing. Physical stage: the same diagram in green, built from the dbt project with the warehouse's own column types. Discrepancy overlay: columns that exist only in the design struck through against those only in the warehouse." />
</p>

## Why ERD Studio

- **In your repo.** Plain DBML files, reviewed in the same pull request as your code. No account, server or database.
- **Works with the AI you already use.** Claude Code, GitHub Copilot, Codex, Gemini CLI and Cursor read and write the same files. Review their proposals on the canvas before anyone writes SQL.
- **No lock-in.** Your files are [DBML](https://dbml.dbdiagram.io/docs), the open-source schema language behind dbdiagram.io; DBML parsers read your files as a multi-file project (the versions are in [Leaving ERD Studio](docs/leaving-erd-studio.md)). Import DBML from any DBML tool, and export a single file for dbdiagram.io (keys, grain and notes) or Mermaid any time.
- **Checked against dbt.** A read-only **Physical** view shows what your dbt project has; **⊕ Diff** highlights every difference from your design and makes a sync plan your AI applies. More stacks later.

## Get started

1. [Install ERD Studio](https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio) (VS Code 1.85+, or [Open VSX](https://open-vsx.org/extension/liamwynne/erd-studio) for VSCodium, Cursor and Windsurf). Open any folder and click **ERD Studio** in the Activity Bar.
2. Make your first diagram:
   - **From scratch:** click **New Diagram** in the ERD Studio sidebar, choose a layer and a name, then use **+ Add → New Design Table** and **+ Add → New Relationship** on the canvas. (The commands call a diagram a *subject area*, so in the Command Palette it is **ERD Studio: New Subject Area**.)
   - **From DBML:** click **Import DBML** in the sidebar (or run **ERD Studio: Import DBML…**) and pick a `.dbml` file. You see what it will create before anything is written. Positions an ERD Studio export saved in the file keep your tables in place.
   - **From an example:** run **ERD Studio: Open Example Diagram** for a coffee-shop model.
3. Commit the `.erd-studio/` folder. That's your data model.

To export, click **⤓** on the canvas toolbar or run **ERD Studio: Export All Diagrams…** ([what each format carries](docs/leaving-erd-studio.md)).

## What's in your repo

```text
.erd-studio/
├── README.md                       ← what the folders are
├── layers.json
└── gold/                           ← a layer (bronze, silver, gold, …)
    ├── tables/
    │   └── sales/                  ← a schema
    │       ├── dim_customer.dbml   ← one DBML file per table, shared by every diagram
    │       └── fct_order.dbml
    ├── relationships/
    │   └── gold.dbml               ← the relationships, one Ref line each
    └── diagrams/
        └── orders.dbml             ← one file per diagram: the tables it shows and where they sit
```

```dbml
// .erd-studio/gold/tables/sales/fct_order.dbml
Table sales.fct_order [grain: 'One row per order'] {
  order_id    INTEGER [pk]
  customer_id INTEGER [foreign_key: 'true']
}
```

Edit on the canvas or in the files, by hand or with AI, and the other follows: ERD Studio edits the files in place, so your comments and hand edits stay ([file format reference](docs/semantic-domain-json-reference.md)). A project from before ERD Studio 2.0 keeps its YAML and JSON files and works as before; run **ERD Studio: Convert Project to DBML** to move it over.

### Common questions

**Do I have to convert my project to DBML?** No. A YAML/JSON project from before 2.0 keeps working, and its new tables and diagrams are still written as YAML and JSON. Only a new project starts as DBML. **ERD Studio: Convert Project to DBML** is up to you: it shows every change before it writes anything.

**How do I go back?** Straight after converting, **Edit > Undo** (with the diagram Convert opens in front) puts every file back. After that, use Git: commit before you convert, and revert that commit to return. A converted project needs ERD Studio 2.0 or later.

**Can teammates on an older ERD Studio open it?** A YAML/JSON project, yes, as long as nobody converts it. A DBML project (a converted one, or a new one) needs ERD Studio 2.0 or later: an older version (the 1.9 pre-releases included) shows no diagrams and an empty Table Library. Agree on the version before you convert, and run **Set Up My AI Helper** again afterwards so your AI assistant writes DBML too.

**How do I move a table to another schema or layer?** In a DBML project, right-click it in the Table Library, or its file in the Explorer, and choose **Move Table…**. Every diagram and relationships file that uses it follows in the same step, and **Edit > Undo** puts it all back. **Move Diagram to Layer…** does the same for a diagram. A YAML/JSON project has neither command: **Organise Table Library by Layer** moves each table file into the folder of the layer that uses it, and **Convert Project to DBML** brings both. In a DBML project you can also drag the file in the Explorer, or rename it there: ERD Studio offers to update every file that points at it (renaming a table file renames the table, since its file name is its name).

**Something is slow or not working. Where do I look?** Run **ERD Studio: Show Logs**. The **ERD Studio** channel in the Output view says what ERD Studio did and how long it took: opening each diagram, saving a moved table, each step of a conversion, and any file it could not read, with its line. **Send Feedback** can add the recent lines to your report if you tick **Include the recent ERD Studio log**; check them first, as they can name your tables.

## Work with your AI assistant

Run **ERD Studio: Set Up My AI Helper** (also on the Welcome tab). It finds the assistants on your computer and teaches them ERD Studio's files. Then ask:

> Propose a star schema for orders in ERD Studio, with grain, keys and design rationale. Let me review the diagram before we write any SQL.

Its changes are file edits you review like any other. The helper also adds a guided setup (`/erd-studio-setup`) that designs a first diagram with you, or builds one from dbt. See [AI assistants](docs/ai-assistants.md).

## Using dbt?

Open the folder that holds your `dbt_project.yml` and ERD Studio also reads dbt. The canvas gets two tabs, **Logical** (your design) · **Physical** (read from dbt):

- **ERD Studio: Draw from dbt…** turns your dbt models into a first diagram in under a minute, no AI needed.
- The read-only **Physical** tab shows what dbt has, from your schema YAMLs (plus `manifest.json` and `catalog.json` when present). **⊕ Diff** highlights missing columns, type differences and relationship mismatches.

<table align="center"><tr>
<td width="300"><a href="https://cdn.jsdelivr.net/gh/liam-machine/erd-studio@main/docs/assets/getting-started.mp4"><img src="https://raw.githubusercontent.com/liam-machine/erd-studio/main/docs/assets/getting-started-play.jpg" width="300" alt="Play the getting-started video (1:00): install ERD Studio, open your dbt project, click Draw from dbt and get a laid-out diagram of your models, no AI needed. Click to watch." /></a></td>
<td><strong>dbt project to diagram in a minute (1:00).</strong> Draw from dbt, then compare Logical with Physical.</td>
</tr></table>

No dbt project to hand? Run **ERD Studio: Try the Sample Project** ([on GitHub](https://github.com/liam-machine/erd-studio-sample)). [Using ERD Studio with dbt](docs/dbt.md) covers the rest. Another stack? [Propose an integration](https://github.com/liam-machine/erd-studio/issues).

## Learn more

- [Using ERD Studio with dbt](docs/dbt.md)
- [AI assistants](docs/ai-assistants.md)
- [DBML import and export](docs/leaving-erd-studio.md)
- [Choosing the project folder](docs/project-folder.md)
- [File format reference](docs/semantic-domain-json-reference.md) and [glossary](docs/glossary.md)
- Bug or idea? Run **ERD Studio: Send Feedback**, or [open an issue](https://github.com/liam-machine/erd-studio/issues).

## Star history

<a href="https://star-history.com/#liam-machine/erd-studio&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=liam-machine/erd-studio&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=liam-machine/erd-studio&type=Date" />
    <img alt="Star history chart for liam-machine/erd-studio" src="https://api.star-history.com/svg?repos=liam-machine/erd-studio&type=Date" />
  </picture>
</a>
