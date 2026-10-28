# Working with your AI assistant

ERD Studio's data model is plain files in DBML, an open format, so any AI coding assistant can read and change it: one `.dbml` file per table, the relationships in `_relationships.dbml` files, and one `.dbml` file per diagram (the commands call a diagram a *subject area*), under `.erd-studio/`. A project from before ERD Studio 2.0 keeps one YAML per table and one JSON per diagram, and the instructions cover both. It works the same in any folder, with or without dbt. What ERD Studio adds is the instructions that teach your assistant those files, so it writes them correctly the first time. Your assistant's changes are ordinary file edits: you see them as a diff and on the canvas before anything is committed.

## Set Up My AI Helper

Click **Set Up My AI Helper** on the Welcome tab, or run **ERD Studio: Set Up My AI Helper**. It installs instructions for the AI assistants it finds on your computer (Claude Code, GitHub Copilot, Codex, Gemini CLI, Cursor) that teach them ERD Studio's files.

Then ask for what you want, for example:

> Propose a star schema for orders in ERD Studio. Include grain, keys, and design rationale. Let me review the diagram before generating any code.

> Add a dim_date table and link every date column in fct_order to it.

> Read the diagram in .erd-studio/silver/orders.dbml and list any table with no grain statement.

## The guided setup

The helper also installs a guided setup, and the Welcome tab shows exactly what to type in each assistant. Start your assistant in your project folder and type:

| Assistant | Type |
|---|---|
| Claude Code | `/erd-studio-setup` |
| GitHub Copilot (Agent mode, or the Copilot CLI) | `/erd-studio-setup` |
| Codex | `$erd-studio-setup` (or pick it from `/skills`) |
| Gemini CLI | *Set up ERD Studio for this project* |
| Cursor | `/erd-studio-setup` |

It looks for a `dbt_project.yml` first and takes one of two routes.

### Without dbt

In a folder with no dbt project, the guide designs a first diagram with you and never asks you to install dbt. It picks a starting point:

- **From a description:** it asks what your business does, then proposes the tables, their keys, grain and relationships, with the reasons for each. It suggests a modelling style that fits (a Kimball star schema for reporting, say) or follows the one you describe, plays the rules back to you and saves them in `.erd-studio/modelling-approach.md` so later AI edits follow them too.
- **From a DBML file:** it asks you to run **ERD Studio: Import DBML…** (no AI involved; you see what it will create before anything is written), then fills in the detail.
- **From the tables you already have:** it adds keys, grain, roles and rationale to the diagrams in `.erd-studio/` instead of rebuilding them.

It then writes the files, checks them with the `erd-studio` helper, and tells you how to open the diagram. Want to see a finished one first? Run **ERD Studio: Open Example Diagram** for a small coffee-shop model.

### With a dbt project

The guide:

- checks that dbt is installed and set up, and helps fix it if not;
- asks which part of your project to model;
- works out how your project is already modelled (a medallion or staging → marts layout, Kimball, Data Vault, One Big Table or Activity Schema tables) from its names, folders, snapshots and packages, and confirms it with you in one sentence (a plain yes is enough, or describe your own rules). It then looks up that standard, plays the rules back to you and saves them in `.erd-studio/modelling-approach.md` so later AI edits follow them too. When it can't see a particular style, it draws your data model exactly as dbt has it instead of making you pick one;
- builds the logical tables from your dbt project, applying those rules;
- compares them with the Physical stage, and fixes the differences until the two match.

Both routes use a small read-only `erd-studio` helper that ERD Studio installs in `~/.erd-studio-cli`. Your assistant still asks before it edits any file.

## Where the instructions go

The guide is an [Agent Skill](https://agentskills.io): Claude Code reads it from `.claude/skills/`, and GitHub Copilot, Codex, Gemini CLI and Cursor read the copy in `.agents/skills/`. It has been tested end to end with Claude Code; the other four read the same skill from the shared `.agents/skills/` folder.

To choose exactly which files are added, run **ERD Studio: Install AI Coding Harness** from the Command Palette, or click the robot icon in the ERD Studio sidebar's title bar. Pick the assistants you use: it adds instructions for Claude Code, the Agent Skills folder (GitHub Copilot, Codex, Gemini CLI, Cursor), GitHub Copilot's instructions file, Gemini's style guide, or Codex's `AGENTS.md`.

## The `erd-studio` helper

The helper only ever reads and prints; it never writes a file, so every change your assistant makes is a visible edit. Its commands are `doctor` (checks the project and suggests next steps), `inventory`, `diff` (design against dbt), `export` (Mermaid or DBML, see [DBML import and export](leaving-erd-studio.md#without-vs-code)) and `version`.

It works in a folder without dbt too, as long as the folder has an `.erd-studio` folder: `doctor` checks your ERD Studio files and says it skipped the dbt checks, `inventory` lists the tables you've designed, and `export` works as usual. Only `diff` needs a dbt project, since it compares your design with what dbt built.
