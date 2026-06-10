# erd-studio-mcp

[![npm version](https://img.shields.io/npm/v/erd-studio-mcp.svg)](https://www.npmjs.com/package/erd-studio-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**MCP server for [ERD Studio](https://github.com/liam-machine/erd-studio)** — gives Claude, Cursor, Continue, Zed, or any [Model Context Protocol](https://modelcontextprotocol.io) client **read-only** access to your dbt project's semantic ERD model.

Once installed, your AI assistant can answer questions like:
- *"What domains exist in this dbt project?"*
- *"Show me every model in the `customer-360` domain and how they relate."*
- *"What's the grain of `dim_customer`? What's the design rationale?"*
- *"Which dbt models have `unique` tests but aren't in any ERD?"*

…without you re-explaining your data model in every prompt.

## Read-only by design — for edits, use the VS Code extension

This MCP server is intentionally read-only. For **designing new ERDs, adding models, drawing relationships, generating dbt SQL + schema YAML**, install the [ERD Studio VS Code extension](https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio). The extension ships with an AI coding skill (`.claude/skills/erd-studio/SKILL.md` for Claude Code, equivalents for Copilot / Gemini / Codex) that gives your assistant **full read+write access** via its native file-editing tools — multi-file edits, refactor-style changes, complete schema authoring.

**Pick the right tool for the job:**

| Workflow | Tool |
|---|---|
| Inspect an existing model from any MCP client (Claude Desktop, Cursor, Continue, Zed, …) | **This MCP server** |
| Design / edit / build (in Claude Code, Copilot, Gemini, Codex) | **Extension + its skill** |
| Visual canvas editing | **Extension** |

The MCP and the skill are complementary, not redundant. If you're in Claude Code already, the skill does more. If you're not, the MCP at least gets you read access.

If the user asks the AI to design or modify anything, the AI will (via the `get_editor_setup` tool) point them at the extension's install path.

## Install

### Claude Code

```bash
claude mcp add erd-studio -- npx -y erd-studio-mcp
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "erd-studio": {
      "command": "npx",
      "args": ["-y", "erd-studio-mcp"]
    }
  }
}
```

### Cursor / Continue / Zed

These editors support MCP via their respective config files. Use the same `command`/`args` shape — see your editor's MCP docs.

## Tools

All tools take a `project_path` argument: the **absolute path** to the dbt project root (the directory containing `dbt_project.yml`). The project should also contain a `.erd-studio/` directory created by the [ERD Studio VS Code extension](https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio).

| Tool | Returns |
|---|---|
| `list_domains` | All ERDs grouped by layer. Filter optional by `layer`. |
| `read_domain` | Full domain: models + columns + relationships + cardinality + rationale. |
| `list_models` | All logical model definitions from `.erd-studio/logical-models/*.yml`. |
| `read_model` | Single logical model with column-level metadata, grain, SCD types, rationale. |
| `list_manifest_models` | Models from `target/manifest.json` (what dbt actually built), with unique/relationship test coverage. Filter optional by `name_contains`. |
| `get_editor_setup` | Returns install instructions for the ERD Studio VS Code extension. Use this when the user wants to edit, design, or build (this MCP server is read-only). |

All tools are read-only. If the project hasn't been initialized with a `.erd-studio/` directory yet, list-tools return empty results with a `tip` field pointing to the install path; read-tools throw a friendly error doing the same. Either way the AI naturally surfaces the extension install path to the user.

## What the AI gets

Unlike most ERD tools where the model is locked behind a vendor UI, ERD Studio stores the semantic model as **plain YAML + JSON in your dbt repo**. This MCP server exposes that model structurally:

- **Grain** as a first-class field — *"one row per customer (current + history)"*
- **Model role** — `conformed-dim`, `transaction-fact`, `bridge`, etc.
- **SCD type per column** — `0` fixed, `1` overwrite, `2` track history
- **Design rationale** — *why* the model was designed this way
- **Cross-stage drift** — manifest test coverage compared to design intent

So when you ask the AI *"propose a column to add to `dim_customer`"*, it sees not just the column list but the design intent — and produces proposals that align with your modelling style.

## Requirements

- **Node.js ≥ 18**
- A dbt project (containing `dbt_project.yml`)
- *(Optional but recommended)* The [ERD Studio VS Code extension](https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio) for creating and editing ERDs visually. The MCP server reads the same files the extension writes.

## Without ERD Studio yet

If your dbt project doesn't have a `.erd-studio/` directory yet:

1. Install the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio)
2. In VS Code: Command Palette → `dbt: Set Up Semantic Domains Directory`
3. Optionally: Command Palette → `dbt: Install AI Coding Harness` to get the bundled skill

The MCP server still works on uninitialized projects — `list_manifest_models` reads `target/manifest.json` directly, and the other tools return graceful "install the extension to start designing" tips. So you can install this MCP first to inspect what dbt has, then move to the extension for the design work.

## Source

- Main repo: https://github.com/liam-machine/erd-studio
- Server source: [`mcp-server/`](https://github.com/liam-machine/erd-studio/tree/main/mcp-server)
- Issues: https://github.com/liam-machine/erd-studio/issues

## License

MIT — see [LICENSE](https://github.com/liam-machine/erd-studio/blob/main/LICENSE) at the repo root.
