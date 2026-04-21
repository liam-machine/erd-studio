<p align="center">
  <img src="https://raw.githubusercontent.com/liam-machine/erd-studio-assets/main/icon.png" width="128" height="128" alt="ERD Studio" />
</p>

<h1 align="center">ERD Studio</h1>

<p align="center">
  <strong>AI-native data warehouse modeling for dbt.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><img src="https://vsmarketplacebadges.dev/version-short/liamwynne.erd-studio.svg" alt="VS Marketplace Version" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><img src="https://vsmarketplacebadges.dev/installs-short/liamwynne.erd-studio.svg" alt="Installs" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><img src="https://vsmarketplacebadges.dev/rating-short/liamwynne.erd-studio.svg" alt="Rating" /></a>
  <img src="https://img.shields.io/badge/license-MIT-0078d4" alt="License: MIT" />
</p>

<p align="center">
  Design your silver and gold layers on a visual canvas. Tell <a href="https://claude.ai/code">Claude Code</a> what to build.<br>
  It writes the dbt models, schema YAML, and tests — no need to touch code or the diagram manually.<br>
  Purpose-built for <strong>Claude Code + dbt</strong>. Other AI assistants supported.
</p>

<p align="center">
  <code>AI builds your models</code> &nbsp;&middot;&nbsp;
  <code>Physical stage from manifest</code> &nbsp;&middot;&nbsp;
  <code>Real-time drift detection</code> &nbsp;&middot;&nbsp;
  <code>AI sync reconciliation</code> &nbsp;&middot;&nbsp;
  <code>40MB+ manifests</code>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/liam-machine/erd-studio-assets/main/demo.gif" width="800" alt="ERD Studio demo — Logical stage, Physical stage, and Discrepancy overlay" />
</p>

---

## How It Works

> **1.** Point your AI assistant at the bronze layer. It profiles the source tables against your requirements and drafts a logical **silver** ERD on the canvas
>
> **2.** Prompt the AI to materialise the silver ERD into dbt models, schema YAML, and tests
>
> **3.** Refine your requirements and have the AI compose a logical **gold** ERD — facts, dimensions, and business-aligned grain — on top of the silver foundation
>
> **4.** Prompt the AI to generate the gold dbt code, with tests derived directly from the ERD's keys and relationships

ERD Studio ships with a baseline AI harness that teaches your assistant the domain format and sync workflow. Bring your own skills, prompts, and style guides on top so the generated dbt code reflects your team's naming conventions, modelling patterns, and review standards.

---

## Two Stages, One Truth

| Stage | Color | What It Shows | Editable? |
|-------|-------|---------------|-----------|
| **Logical** | Blue | Your design intent — full column definitions, model roles, relationships | Yes |
| **Physical** | Green | What dbt built — models, relationships, and cardinality derived from `manifest.json` tests | Read-only |

The physical stage is computed at runtime — no files on disk. Relationships come from dbt `relationships` tests, cardinality from `unique` tests.

Toggle the **Diff** button to compare stages. Discrepancies are color-coded directly on the canvas: `matched` `extra` `missing` `type-mismatch` `cardinality-mismatch`. Missing models appear as translucent ghost nodes.

---

## Reconciliation

When design and warehouse drift apart, ERD Studio generates a **sync plan** — a JSON file mapping every discrepancy to a concrete fix. Choose which side is the ground truth per item, then let your AI assistant execute the plan: adding columns to YAML, writing dbt tests, updating domain JSON, or removing stale relationships.

---

## AI Coding Harness

One command installs a schema reference that teaches your AI the domain format, naming conventions, and editing rules:

<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> &rarr; `dbt: Install AI Coding Harness`

| Assistant | What Gets Installed |
|-----------|---------------------|
| **Claude Code** | `.claude/skills/erd-studio/SKILL.md` + sync companion |
| **GitHub Copilot** | `.github/instructions/erd-studio.instructions.md` |
| **Google Gemini** | `.gemini/styleguide.md` |
| **OpenAI Codex** | `AGENTS.md` section |

Once installed, describe what you want in plain English — your AI creates models, generates dbt schema YAML with tests, executes sync plans, and validates naming conventions. No manual editing required.

---

## Features

- **Drag-to-relate** — long-press a column, drag to create FK relationships
- **ELK auto-layout** with manual repositioning (<kbd>Shift</kbd>+<kbd>L</kbd>)
- **Model templates** — dimension, fact, bridge, SCD2, or blank
- **Domain tagging** — auto-tags dbt YAML with `domain:{name}` for scoped builds
- **Medallion layers** — bronze, silver, gold, platinum, or custom
- **Central model store** — one YAML per model, referenced across domains
- **Full undo/redo** via VS Code `WorkspaceEdit`
- **Handles 40MB+ manifests** with worker-thread parsing

---

## Getting Started

**Prerequisites:** VS Code 1.85+ &bull; dbt project with `dbt_project.yml` &bull; `manifest.json` in `target/`

1. **Open your dbt project** in VS Code
2. **Click the ERD Studio icon** in the Activity Bar
3. **Initialize** — follow the prompt to create the `erd-studio/` folder
4. **Create a domain** — <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> &rarr; `dbt: Create Semantic Domain`
5. **Design** — add models, define columns, drag to relate
6. **Install the AI harness** — <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> &rarr; `dbt: Install AI Coding Harness`

---

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `dbtSemantic.projectPath` | Path to dbt project root | Auto-detected |
| `dbtSemantic.semanticDir` | Relative path to domain files | `erd-studio` |

---

## Contributors

<table>
<tr>
<td align="center"><a href="https://github.com/jkweee"><img src="https://github.com/jkweee.png" width="60" height="60" alt="Jason Kwe" /><br><sub><b>Jason Kwe</b></sub></a><br><sub>Core concept, UI/UX, testing & iteration</sub></td>
<td align="center"><a href="https://github.com/ginny-jhg"><img src="https://github.com/ginny-jhg.png" width="60" height="60" alt="Ginny" /><br><sub><b>Ginny</b></sub></a><br><sub>Sync reconciliation, auto-layout,<br>depth partitioning, testing & iteration</sub></td>
</tr>
</table>

---

<p align="center">
  <sub>MIT License &bull; Made for the dbt community</sub>
</p>
