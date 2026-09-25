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
  <a href="https://open-vsx.org/extension/liamwynne/erd-studio"><img src="https://img.shields.io/open-vsx/v/liamwynne/erd-studio?label=Open%20VSX&color=a60ee5" alt="Open VSX Version" /></a>
  <a href="https://open-vsx.org/extension/liamwynne/erd-studio"><img src="https://img.shields.io/open-vsx/dt/liamwynne/erd-studio?label=Open%20VSX%20downloads&color=a60ee5" alt="Open VSX Downloads" /></a>
  <a href="https://github.com/liam-machine/erd-studio"><img src="https://img.shields.io/github/stars/liam-machine/erd-studio?style=flat&logo=github&label=Star&color=0078d4" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Shield-0078d4" alt="License: PolyForm Shield 1.0.0" /></a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><strong>Install for VS Code</strong></a> &bull; <a href="https://open-vsx.org/extension/liamwynne/erd-studio"><strong>Open VSX</strong></a> (VSCodium, Cursor, Windsurf) &bull; Free to use, source available
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/liam-machine/erd-studio/main/media/demo.gif" width="800" alt="ERD Studio open in VS Code, showing four views of the same star schema. Logical stage: dim_customer, dim_date, dim_project and dim_task around the fct_order and fct_task_event facts, each dimension showing a PK surrogate key and an NK business key. Detail panel: dim_customer's columns, role and relationships opened for editing. Physical stage: the same diagram in green, built from the dbt project with the warehouse's own column types. Discrepancy overlay: columns that exist only in the design struck through against those only in the warehouse." />
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

![Your data model lives in the repo; the canvas is a view over it. Left: the VS Code Explorer for a dbt project. Its .erd-studio folder, marked design, holds one YAML per logical model and one JSON per diagram, next to the models and target folders, marked code and warehouse, where fct_order.sql is modified. The design files render and save as the ERD Studio Logical canvas, in blue: dim_customer joined one to many to fct_order, which has order_total. The dbt project derives the read-only Physical canvas, in green, never written to disk. Comparing the two finds two differences: order_amt is highlighted as only in the warehouse and order_total struck through as logical only, because the column was renamed in the SQL but not the design. The fix is a one-line change to fct_order.yml in the same pull request.](media/readme-workflow.png)

Edit on the canvas and those same files update. Edit them yourself or with AI and the canvas updates. Models are shared across diagrams, and everything stays in Git. No ERD Studio account, database, or server required.

### Reading your dbt project

The **Physical** view, the green canvas above, has no file of its own. It reads three files, and only the first is required: your **schema YAMLs**, always on disk, so the view works before you have ever run dbt; **`manifest.json`** after a `dbt run`; and **`catalog.json`** after `dbt docs generate` — the only one of the three that has seen your warehouse.

Each model shows where its shape came from, so a `varchar` on the canvas is never a guess: types are read from the warehouse when the catalog is there, otherwise from the `data_type:` you wrote, otherwise left blank rather than invented. A greyed-out model means it is genuinely not in your dbt project, not that you have not run dbt lately. And the edges are the tests you already run — `relationships` for the links, `unique` for the cardinality — so the canvas shows what dbt enforces rather than a second copy that can drift. Nothing is ever written to disk.

dbt is the only stack ERD Studio can read today. If you model somewhere else, [contribute an integration or propose one](https://github.com/liam-machine/erd-studio/issues) — your logical model files stay exactly as they are as support grows.

## Get started

Requires **VS Code 1.85+** and a project containing `dbt_project.yml` (see [logical-only setup](#not-using-dbt)). The Physical view needs nothing beyond your dbt schema YAMLs, and gets richer once `manifest.json` and `catalog.json` exist.

<a href="https://cdn.jsdelivr.net/gh/liam-machine/erd-studio@main/media/onboarding/getting-started.mp4"><img src="https://raw.githubusercontent.com/liam-machine/erd-studio/main/docs/assets/getting-started-play.jpg" width="640" alt="Getting-started video: a short tour from a dbt project to a checked ERD with your AI assistant. Click to watch." /></a>

**New to ERD Studio?** [Watch the short getting-started video](https://cdn.jsdelivr.net/gh/liam-machine/erd-studio@main/media/onboarding/getting-started.mp4). After you install, ERD Studio opens a **Welcome** tab the first time you use it, with the same video and a short setup checklist. Open it again any time with **Get started** in the ERD Studio sidebar (or its ▶ button), or **ERD Studio: Watch Getting Started Video**.

**No dbt project yet?** Try the [ERD Studio sample project](https://github.com/liam-machine/erd-studio-sample): a small Kimball-style dbt project with fake coffee-shop data that runs on your computer (DuckDB, no account needed). It ships its dbt artifacts, so both the Logical and Physical views work without installing dbt. Run **ERD Studio: Try the Sample Project** (also on the Welcome tab) and VS Code clones it to a folder you choose and offers to open it, or use **Code → Download ZIP** on GitHub and open the unzipped folder.

**Quickest route, with your AI assistant:** click **Set Up My AI Helper** on the Welcome tab, or run **ERD Studio: Set Up My AI Helper**. It installs a guided setup for the AI assistants it finds on your computer, then shows exactly what to type in each. Start your assistant in your dbt project folder and:

| Assistant | Type |
|---|---|
| Claude Code | `/erd-studio-setup` |
| GitHub Copilot (Agent mode, or the Copilot CLI) | `/erd-studio-setup` |
| Codex | `$erd-studio-setup` (or pick it from `/skills`) |
| Gemini CLI | *Set up ERD Studio for this dbt project* |
| Cursor | `/erd-studio-setup` |

The guide:

- checks that dbt is installed and set up, and helps fix it if not;
- asks which part of your project to model;
- works out how your project is already modelled — a medallion or staging → marts layout, Kimball, Data Vault, One Big Table or Activity Schema tables — from its names, folders, snapshots and packages, and confirms it with you in one sentence (a plain yes is enough, or describe your own rules); it then looks up that standard, plays the rules back to you and saves them in `.erd-studio/modelling-approach.md` so later AI edits follow them too. When it can't see a particular style, it draws your model exactly as dbt has it instead of making you pick one;
- builds the logical models from your dbt project, applying those rules;
- compares them with the Physical view, and fixes the differences until the two match.

It uses a small read-only `erd-studio` helper that ERD Studio installs in `~/.erd-studio-cli`. Your assistant still asks before it edits any file.

The guide is an [Agent Skill](https://agentskills.io): Claude Code reads it from `.claude/skills/`, and GitHub Copilot, Codex, Gemini CLI and Cursor read the copy in `.agents/skills/`. It has been tested end to end with Claude Code; the other four read the same skill from the open standard's folder.

**Or step by step:**

1. [Install ERD Studio](https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio) and open your project in VS Code.
2. Click the **ERD Studio** icon in the Activity Bar, choose **Set Up ERD Studio**, and follow the prompts to create your first domain (a diagram).
3. Design models on the canvas, or add existing dbt models. If you use dbt, switch between **Logical** and **Physical** to compare your design with it.
4. To work with AI, run **ERD Studio: Install AI Coding Harness** from the Command Palette. It adds project instructions for Claude Code, the Agent Skills folder (GitHub Copilot, Codex, Gemini CLI, Cursor), GitHub Copilot's instructions file, Gemini, or Codex's `AGENTS.md`.

Then try asking your assistant:

> Read my source models and propose a star schema for orders in ERD Studio. Include grain, keys, and design rationale. Let me review the diagram before generating dbt code.

### More than one dbt project in a workspace?

A VS Code window shows one dbt project at a time. In a multi-root workspace or a monorepo, ERD Studio opens the project that already has an `.erd-studio` folder, and falls back to the first dbt project it finds. When there's more than one, the first row of the ERD Studio sidebar shows which project is open.

To choose another project, click that row, or run **ERD Studio: Select dbt Project…**. VS Code then reloads the window to open the project you picked. Your choice is saved for that workspace on your machine only, so it never ends up in a settings file your team commits. **Auto-detect**, at the top of the list, clears your choice.

To choose the project for everyone who opens the workspace, set `erdStudio.projectPath` in the workspace settings. That is the `settings` block of the `.code-workspace` file, or `.vscode/settings.json` for a single folder. Use a relative path so the setting works on every machine. ERD Studio tries it against each workspace folder in turn, so in a multi-root workspace whose folders sit side by side, `../datamodels` points at the `datamodels` folder. The setting takes priority over the picker. In a multi-root workspace ERD Studio reads it from the workspace level only: a value in one folder's own `.vscode/settings.json` is ignored.

If you open a diagram that belongs to a different dbt project than the one ERD Studio has open, ERD Studio doesn't draw it against the wrong project's data. It offers to switch projects instead.

### Not using dbt?

Use ERD Studio for your **logical models**: design tables, relationships, and business rules without installing or running dbt.

For now, add a `dbt_project.yml` file containing `name: logical_models` to your project root and reload VS Code. The extension still uses that file to recognise the project; no dbt build or warehouse connection is needed for logical modelling.

Physical comparison needs dbt, so the canvas stays on the Logical stage — everything else works unchanged.

[File format reference](docs/semantic-domain-json-reference.md) · [Release notes](CHANGELOG.md) · [Send feedback](https://github.com/liam-machine/erd-studio/issues) · [Contribute on GitHub](https://github.com/liam-machine/erd-studio)

Free to use under the [PolyForm Shield License 1.0.0](LICENSE): use it, modify it and share it, at home or at work, for any purpose except offering a product that competes with ERD Studio. The source is public; only the author may sell it or relicense it.

## Star history

<a href="https://star-history.com/#liam-machine/erd-studio&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=liam-machine/erd-studio&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=liam-machine/erd-studio&type=Date" />
    <img alt="Star history chart for liam-machine/erd-studio" src="https://api.star-history.com/svg?repos=liam-machine/erd-studio&type=Date" />
  </picture>
</a>
