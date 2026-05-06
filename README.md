<p align="center">
  <img src="https://raw.githubusercontent.com/liam-machine/erd-studio-assets/main/icon.png" width="128" height="128" alt="ERD Studio" />
</p>

<h1 align="center">ERD Studio</h1>

<p align="center">
  <strong>Close the context gap between your data model and your AI assistant.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><img src="https://vsmarketplacebadges.dev/version-short/liamwynne.erd-studio.svg" alt="VS Marketplace Version" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><img src="https://vsmarketplacebadges.dev/installs-short/liamwynne.erd-studio.svg" alt="Installs" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio"><img src="https://vsmarketplacebadges.dev/rating-short/liamwynne.erd-studio.svg" alt="Rating" /></a>
  <img src="https://img.shields.io/badge/license-MIT-0078d4" alt="License: MIT" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/liam-machine/erd-studio-assets/main/demo.gif" width="800" alt="ERD Studio demo — Logical stage, Physical stage, and Discrepancy overlay" />
</p>

---

## The problem

When you build a data warehouse with AI, the context lives in three places that don't talk to each other:

- **Your modelling tool** (SqlDBM, Lucidchart, dbdiagram, a wiki) holds the relationships, cardinality, grain, SCD strategy, and design rationale.
- **Your dbt repo** holds the SQL.
- **Your head** is the only thing that connects them.

So every prompt becomes a re-explanation. You describe the join keys, the cardinality, the SCD strategy — again — and hope the AI doesn't drift. When it generates output, it's a wall of markdown that's hard to scan and easy to mis-review. Errors slip through. Then they slip into the warehouse.

You *can* try to bridge it — wire your AI to your modelling tool's API, or pay for the tier that exposes one. But those integrations are fiddly to build, the licences add up, and your design context still lives behind another login.

## The solution

ERD Studio is a **free, AI-native alternative** that puts the semantic model in the **same repo as the SQL**, as a visual canvas both you and the AI can read and write.

Other ERD tools draw the boxes and arrows. ERD Studio captures the modelling decisions behind them — grain, SCD types, additivity, model roles, design rationale — as first-class fields the AI can read, not freeform notes locked behind a vendor UI.

Point the AI at your bronze layer. It profiles the sources, drafts an ERD on the canvas against your requirements and modelling style (Kimball, Inmon, etc.), and you refine it. The AI then writes the dbt models, schema YAML, and tests from the design you signed off on.

Already have dbt models? Point ERD Studio at your `manifest.json` — it reads your existing relationship and uniqueness tests to seed an ERD on day one.

<br />

<p align="center">
  <strong>No more brain-as-middleware.</strong><br />
  <em>The diagram is the prompt.</em>
</p>

<br />

> *Today: built for medallion architectures on dbt projects. More frameworks coming.*

Because the canvas lives in your repo, you also get:

<table>
<tr>
<td width="50%" valign="top">

#### Git version control on your design

Model history and warehouse history commit together and stay in lockstep by default.

</td>
<td width="50%" valign="top">

#### Schedule a whole ERD as one dbt run

ERD Studio writes a `selectors.yml` for you and auto-tags each diagram's models. Refresh every model in an ERD with a single command — no hand-managed tags, no selector config to wire up.

</td>
</tr>
<tr>
<td width="50%" valign="top">

#### Diff against reality

Compare your design to what dbt actually built (read from `manifest.json`, 40MB+ files supported). Mismatches are colour-coded on the canvas.

</td>
<td width="50%" valign="top">

#### AI sync plans for drift

When design and warehouse disagree, ERD Studio generates a JSON plan mapping every discrepancy to a concrete fix. Pick the source of truth per item; the AI executes it.

</td>
</tr>
</table>

---

## Getting started

**Prerequisites:** VS Code 1.85+ &bull; dbt project with `dbt_project.yml` &bull; `manifest.json` in `target/`

> **Quick install:** &nbsp;<kbd>Cmd</kbd>+<kbd>P</kbd> &nbsp;&rarr;&nbsp; <code>ext install liamwynne.erd-studio</code>

1. **Install** ERD Studio from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio).
2. **Open your dbt project** in VS Code and click the ERD Studio icon in the Activity Bar.
3. **Initialize** — follow the prompt to create the `erd-studio/` folder.
4. **Install the AI harness** — <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> &rarr; `dbt: Install AI Coding Harness`.
5. **Create a domain** — <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> &rarr; `dbt: Create Semantic Domain`.
6. **Tell your AI what to build** — describe the scope, point it at bronze, let it draft the ERD. Review on the canvas. Prompt it to generate the dbt code.

The harness installs the right file for your assistant:

| Assistant | Harness file |
|-----------|--------------|
| <img src="https://img.shields.io/badge/Claude_Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white" alt="Claude Code" /> | `.claude/skills/erd-studio/SKILL.md` |
| <img src="https://img.shields.io/badge/GitHub_Copilot-24292e?style=for-the-badge&logo=githubcopilot&logoColor=white" alt="GitHub Copilot" /> | `.github/instructions/erd-studio.instructions.md` |
| <img src="https://img.shields.io/badge/Google_Gemini-4285F4?style=for-the-badge&logo=googlegemini&logoColor=white" alt="Google Gemini" /> | `.gemini/styleguide.md` |
| <img src="https://img.shields.io/badge/OpenAI_Codex-412991?style=for-the-badge&logo=openai&logoColor=white" alt="OpenAI Codex" /> | `AGENTS.md` |

The baseline harness teaches your assistant the domain format and sync workflow, with a guard that blocks AI edits to `erd-studio/` until the spec is loaded. Layer your own skills, prompts, and style guides on top so the generated dbt reflects your team's conventions.

---

<p align="center">
  <sub>MIT License &bull; Made for the dbt community</sub><br />
  <sub><a href="https://github.com/liam-machine/erd-studio/issues">Report a bug</a> &bull; <a href="https://github.com/liam-machine/erd-studio/discussions">Start a discussion</a></sub>
</p>
