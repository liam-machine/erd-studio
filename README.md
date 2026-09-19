<p align="center">
  <img src="https://raw.githubusercontent.com/liam-machine/erd-studio/main/media/icon.png" width="128" height="128" alt="ERD Studio" />
</p>

<h1 align="center">ERD Studio</h1>

<p align="center">
  <strong>Your data model, in your repo.</strong><br />
  Design visually. Build with AI. Review alongside your code.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><img src="https://vsmarketplacebadges.dev/version-short/liamwynne.erd-studio.svg" alt="VS Marketplace Version" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><img src="https://vsmarketplacebadges.dev/installs-short/liamwynne.erd-studio.svg" alt="Installs" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><img src="https://vsmarketplacebadges.dev/rating-short/liamwynne.erd-studio.svg" alt="Rating" /></a>
  <a href="https://github.com/liam-machine/erd-studio"><img src="https://img.shields.io/github/stars/liam-machine/erd-studio?style=flat&logo=github&label=Star&color=0078d4" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Shield-0078d4" alt="License: PolyForm Shield 1.0.0" /></a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><strong>Install for VS Code</strong></a> &bull; Free to use, source available
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/liam-machine/erd-studio/main/media/demo.gif" width="800" alt="ERD Studio demo — Logical stage, Physical stage, and Discrepancy overlay" />
</p>

ERD Studio brings visual data modelling into VS Code. Keep your diagrams and design decisions in your code repo, give your AI assistant the context to build from them, and review design changes alongside the SQL.

## Why use ERD Studio?

- **Give AI a design to build from.** Capture grain, keys, relationships, and the reasoning behind them. Your assistant can use that context to draft dbt models and tests.
- **Review the model before the SQL.** Design on the canvas or ask your AI to propose a schema, then inspect and refine it visually.
- **See where design and dbt disagree.** Compare your logical model with your dbt schema and manifest. Missing columns, type differences, and relationship mismatches appear on the canvas. Generate a sync plan for your assistant to apply the changes you choose.
- **Keep design and code in one review.** Commit both in the same pull request, with readable diffs and a shared history.
- **Run a whole domain together.** Automatically generated dbt selectors let you build the models in a diagram with one command.

Traditional ERD tools such as [erwin](https://bookshelf.erwin.com/bookshelf/public_html/2019R2/Content/User%20Guides/Navigator%20Edition%20Online%20Help/Open_a_model_or_submodel_from_the_mart.html) store models in application-specific files or a separate modelling repository. ERD Studio's plain files fit directly into your branches, pull requests, and AI workflow. **Less setup, fewer handoffs, and no export step to give your AI the design.**

## How it works

The whole logical model is just two kinds of file: **one YAML per model, one JSON per diagram.** ERD Studio reads them and renders the canvas.

![Top half: a model YAML file and a diagram JSON file in your repo render together as the logical canvas, where dim_customer and fct_order are joined one to many, and canvas edits save back to the same files. Bottom half, in a dashed box marked optional and only if you use dbt: your dbt project derives a physical view of the same diagram with the real columns and data types, its edges and cardinality taken from your dbt tests and never written to disk. The two views can be compared.](media/readme-workflow.png)

Edit on the canvas and those same files update. Edit them yourself or with AI and the canvas updates. Models are shared across diagrams, and everything stays in Git. No ERD Studio account, database, or server required.

### Reading your dbt project

The **Physical** view is the lower half of the diagram, and it has no file of its own. It reads three files, and only the first is required: your **schema YAMLs**, always on disk, so the view works before you have ever run dbt; **`manifest.json`** after a `dbt run`; and **`catalog.json`** after `dbt docs generate` — the only one of the three that has seen your warehouse.

Each model shows where its shape came from, so a `varchar` on the canvas is never a guess: types are read from the warehouse when the catalog is there, otherwise from the `data_type:` you wrote, otherwise left blank rather than invented. A greyed-out model means it is genuinely not in your dbt project, not that you have not run dbt lately. And the edges are the tests you already run — `relationships` for the links, `unique` for the cardinality — so the canvas shows what dbt enforces rather than a second copy that can drift. Nothing is ever written to disk.

dbt is the only stack ERD Studio can read today. If you model somewhere else, [contribute an integration or propose one](https://github.com/liam-machine/erd-studio/issues) — your logical model files stay exactly as they are as support grows.

## Get started

Requires **VS Code 1.85+** and a project containing `dbt_project.yml` (see [logical-only setup](#not-using-dbt)). The Physical view needs nothing beyond your dbt schema YAMLs, and gets richer once `manifest.json` and `catalog.json` exist.

1. [Install ERD Studio](https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio) and open your project in VS Code.
2. Click the **ERD Studio** icon in the Activity Bar, choose **Set Up ERD Studio**, and follow the prompts to create your first domain (a diagram).
3. Design models on the canvas, or add existing dbt models. If you use dbt, switch between **Logical** and **Physical** to compare your design with it.
4. To work with AI, run **ERD Studio: Install AI Coding Harness** from the Command Palette. It adds project instructions for Claude Code, GitHub Copilot, Gemini, or Codex.

Then try asking your assistant:

> Read my source models and propose a star schema for orders in ERD Studio. Include grain, keys, and design rationale. Let me review the diagram before generating dbt code.

### Not using dbt?

Use ERD Studio for your **logical models**: design tables, relationships, and business rules without installing or running dbt.

For now, add a `dbt_project.yml` file containing `name: logical_models` to your project root and reload VS Code. The extension still uses that file to recognise the project; no dbt build or warehouse connection is needed for logical modelling.

Physical comparison needs dbt, so the canvas stays on the Logical stage — everything else works unchanged.

[File format reference](docs/semantic-domain-json-reference.md) · [Release notes](CHANGELOG.md) · [Send feedback](https://github.com/liam-machine/erd-studio/issues) · [Contribute on GitHub](https://github.com/liam-machine/erd-studio)

Free to use under the [PolyForm Shield License 1.0.0](LICENSE): use it, modify it and share it, at home or at work, for any purpose except offering a product that competes with ERD Studio. The source is public; only the author may sell it or relicense it.
