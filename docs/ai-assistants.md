# Working with your AI assistant

ERD Studio's data model is plain files in DBML, an open format, so any AI coding assistant can read and change it: one `.dbml` file per table, the relationships in their own `.dbml` files, and one `.dbml` file per diagram, under a layer folder in `.erd-studio/` (`gold/tables/`, `gold/relationships/`, `gold/diagrams/`). A project from before ERD Studio 2.0 keeps one YAML per table and one JSON per diagram, and the instructions cover both. It works the same in any folder, with or without dbt. What ERD Studio adds is the instructions that teach your assistant those files, so it writes them correctly the first time. Your assistant's changes are ordinary file edits: you see them as a diff and on the canvas before anything is committed.

## Set Up My AI Helper

Click **Set Up My AI Helper** on the ERD Studio Tour tab, or run **ERD Studio: Set Up My AI Helper**. It installs instructions for the AI assistants it finds on your computer (Claude Code, GitHub Copilot, Codex, Gemini CLI, Cursor) that teach them ERD Studio's files.

Then ask for what you want, for example:

> Propose a star schema for orders in ERD Studio. Include grain, keys, and design rationale. Let me review the diagram before generating any code.

> Add a dim_date table and link every date column in fct_order to it.

> Read the diagram in .erd-studio/silver/diagrams/orders.dbml and list any table with no grain statement.

## The guided setup

The helper also installs a guided setup, and the ERD Studio Tour tab shows exactly what to type in each assistant. Start your assistant in your project folder and type:

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

It then writes the files, checks them with the `erd-studio` helper, and tells you how to open the diagram. Want to see a finished one first? Run **ERD Studio: Open an Example…** for a small coffee-shop model.

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

## The safety check

ERD Studio's format rules only help if your assistant reads them before it writes. So for the assistants that let a project add a hook, Set Up My AI Helper adds one that pauses the **first** edit to an `.erd-studio` file in each session and tells the assistant to load the rules first. The assistant loads them and retries; every later edit goes through as normal. The hook never approves anything on its own: your assistant still asks you before each change, as it always does.

| Assistant | Where the hook is registered | Committed? |
|---|---|---|
| Claude Code | `.claude/settings.local.json` (script in `.claude/skills/erd-studio/`) | No: a local settings file |
| GitHub Copilot (the Copilot CLI, and Copilot sessions in VS Code) | `.github/copilot/settings.local.json` (script in `.github/copilot/hooks/`) | No: ERD Studio adds both to `.gitignore` |
| Codex | `.codex/hooks.json` (script in `.codex/hooks/`) | No when ERD Studio creates `.codex/hooks.json` (it adds both to `.gitignore`). If your project already has one, the entry is added to it and goes wherever that file goes |
| Gemini CLI | `.gemini/settings.json` (script in `.gemini/hooks/`) | Gemini CLI has no local settings file, so the entry sits in your project's Gemini settings. If you commit that file, commit `.gemini/hooks/erd-studio-enforce-skill.sh` too, or remove the entry |
| Cursor | Not yet supported | Cursor handles a hook's answer differently from the others, and ERD Studio hasn't checked a safe way to pause it yet. Cursor relies on the always-on skill |
| Antigravity CLI | Not yet supported | Google's newer command-line assistant. ERD Studio doesn't add a hook for it yet, so it relies on the always-on skill |

A few things to know:

- **Which assistants get it:** Set Up My AI Helper adds the hook for the assistants it finds on your computer. When it finds none, it adds Claude Code's, GitHub Copilot's and Codex's (their files stay out of git), not Gemini CLI's. Updating ERD Studio's files later keeps the hooks you have current and adds no new ones.
- **Codex asks first.** Codex runs a new project hook only after you trust it: when it starts, it says a hook needs review, and you approve it in `/hooks`.
- **Gemini CLI** shows a one-time notice the first time it runs a new project hook, and ignores project settings in a folder you haven't trusted. Google moved free-tier and Google One users from Gemini CLI to Antigravity CLI in June 2026; the Gemini CLI hook is for anyone still using Gemini CLI.
- **Copilot in VS Code** reads `.github/copilot/settings.local.json` in Copilot sessions. A chat that uses VS Code's own local agent instead may not run the hook.
- **Versions:** GitHub Copilot hooks need a recent Copilot CLI (1.0.70 or later recommended) or a VS Code with agent hooks (still in preview); Codex 0.131 or later; Gemini CLI 0.26 or later. An older version just skips the hook, which is harmless.
- **Windows:** Claude Code's check needs Git Bash. GitHub Copilot's and Codex's checks don't run on Windows at all. Gemini CLI may show a hook warning and carry on. Either way an edit is never blocked by mistake.
- **Your own settings stay.** ERD Studio adds its one entry and keeps everything else in these files, with their indentation. A settings file with comments in it, or one it can't read, is left alone, and Set Up My AI Helper tells you that assistant's check wasn't added.

## Choosing the files yourself

To choose exactly which files are added, run **ERD Studio: Install AI Helper Files…** from the Command Palette. Pick the assistants you use: it adds instructions for Claude Code, the Agent Skills folder (GitHub Copilot, Codex, Gemini CLI, Cursor), GitHub Copilot's instructions file, Gemini's style guide, or Codex's `AGENTS.md` (with the two format guides it points at, `DBML.md` and `LEGACY.md` in `.agents/skills/erd-studio/`).

## The `erd-studio` helper

The helper only ever reads and prints; it never writes a file, so every change your assistant makes is a visible edit. Its commands are `doctor` (checks the project and suggests next steps), `inventory`, `diff` (design against dbt), `export` (Mermaid or DBML, see [DBML import and export](leaving-erd-studio.md#without-vs-code)), `changes` (what changed in your model since a branch, tag or commit: `changes --base main --format markdown` prints it ready to paste into a pull request) and `version`.

It works in a folder without dbt too, as long as the folder has an `.erd-studio` folder: `doctor` checks your ERD Studio files and says it skipped the dbt checks, `inventory` lists the tables you've designed, and `export` and `changes` work as usual. Only `diff` needs a dbt project, since it compares your design with what dbt built.
