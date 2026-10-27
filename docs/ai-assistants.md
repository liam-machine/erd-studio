# Working with your AI assistant

ERD Studio's data model is plain files, so any AI coding assistant can read and change it: one YAML per table and one JSON per diagram (the files and commands call a diagram a *subject area*), under `.erd-studio/`. It works the same in any folder, with or without dbt. What ERD Studio adds is the instructions that teach your assistant those files, so it writes them correctly the first time. Your assistant's changes are ordinary file edits: you see them as a diff and on the canvas before anything is committed.

## Set Up My AI Helper

Click **Set Up My AI Helper** on the Welcome tab, or run **ERD Studio: Set Up My AI Helper**. It installs instructions for the AI assistants it finds on your computer (Claude Code, GitHub Copilot, Codex, Gemini CLI, Cursor) that teach them ERD Studio's files.

Then ask for what you want, for example:

> Propose a star schema for orders in ERD Studio. Include grain, keys, and design rationale. Let me review the diagram before generating any code.

> Add a dim_date table and link every date column in fct_order to it.

> Read the diagram in .erd-studio/silver/orders.json and list any table with no grain statement.

## The guided setup for a dbt project

The helper also installs a guided setup that builds your design from dbt, and the Welcome tab shows exactly what to type in each assistant. The guided setup needs a dbt project today: in a folder without one, ask your assistant for the design directly, as in the examples above. Start your assistant in your dbt project folder and type:

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
- works out how your project is already modelled (a medallion or staging → marts layout, Kimball, Data Vault, One Big Table or Activity Schema tables) from its names, folders, snapshots and packages, and confirms it with you in one sentence (a plain yes is enough, or describe your own rules). It then looks up that standard, plays the rules back to you and saves them in `.erd-studio/modelling-approach.md` so later AI edits follow them too. When it can't see a particular style, it draws your data model exactly as dbt has it instead of making you pick one;
- builds the logical tables from your dbt project, applying those rules;
- compares them with the Physical stage, and fixes the differences until the two match.

It uses a small read-only `erd-studio` helper that ERD Studio installs in `~/.erd-studio-cli`. Your assistant still asks before it edits any file.

## Where the instructions go

The guide is an [Agent Skill](https://agentskills.io): Claude Code reads it from `.claude/skills/`, and GitHub Copilot, Codex, Gemini CLI and Cursor read the copy in `.agents/skills/`. It has been tested end to end with Claude Code; the other four read the same skill from the shared `.agents/skills/` folder.

To choose exactly which files are added, run **ERD Studio: Install AI Coding Harness** from the Command Palette, or click the robot icon in the ERD Studio sidebar's title bar. Pick the assistants you use: it adds instructions for Claude Code, the Agent Skills folder (GitHub Copilot, Codex, Gemini CLI, Cursor), GitHub Copilot's instructions file, Gemini's style guide, or Codex's `AGENTS.md`.

## The `erd-studio` helper

The helper only ever reads and prints; it never writes a file, so every change your assistant makes is a visible edit. Like the guided setup, it needs a dbt project today: it looks for a `dbt_project.yml` and stops without one. Its commands are `doctor` (checks the project and suggests next steps), `inventory`, `diff` (design against dbt), `export` (Mermaid or DBML, see [DBML import and export](leaving-erd-studio.md#without-vs-code)) and `version`.
