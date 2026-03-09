# ERD Studio

A VS Code extension for visually designing data warehouse models across three stages: conceptual, logical, and physical — with dbt manifest integration.

## How It Works

ERD Studio organizes your data warehouse design into three stages, each serving a distinct purpose:

```
Conceptual          Logical             Physical
(what exists?)  --> (full detail)   --> (what dbt built)
```

| Stage | Color | Purpose | Editable |
|-------|-------|---------|----------|
| **Conceptual** | Purple | High-level entity design. Models show as simplified boxes with name and description only. Define what entities exist and how they relate. | Yes |
| **Logical** | Blue | Detailed data model. Full column definitions with data types, PK/FK/NK badges, SCD types, grain, model roles, and rationale. | Yes |
| **Physical** | Green | What actually exists in dbt. Auto-derived from `manifest.json`, scoped to models in the logical domain. | Positions only |

Switch between stages using the toolbar tabs or keyboard shortcuts: `Alt+1` (Conceptual), `Alt+2` (Logical), `Alt+3` (Physical).

## Key Features

- **Three-stage design** -- Separate conceptual thinking from detailed modeling from physical reality
- **Global positioning** -- Node positions are shared across all three stages, so your layout stays consistent
- **Drag-to-relate** -- Drag from a column handle to create FK relationships with cardinality
- **Discrepancy overlay** -- Compare stages to spot differences (extra/missing columns, type mismatches, missing models shown as ghost nodes)
- **Layer organization** -- Medallion layers (bronze, silver, gold, platinum) plus custom layers
- **Model templates** -- Presets for dimension, fact, bridge, and reference models
- **ELK auto-layout** -- Automatic graph layout with manual repositioning
- **Undo/redo** -- All edits go through VS Code's WorkspaceEdit system
- **dbt manifest integration** -- Physical stage reads directly from your compiled manifest
- **AI coding harness** -- Install schema reference for Claude, Copilot, Gemini, or Codex

## Directory Structure

ERD Studio stores domain files alongside your dbt project in a unified v3 format:

```
erd-studio/
├── layers.json              ← layer configuration
├── templates/               ← model templates
├── silver/
│   ├── customer-360.json    ← unified domain (conceptual + logical)
│   └── orders.json
└── gold/
    └── reporting.json
```

Each domain is a single JSON file containing both `conceptual` and `logical` sections, with a shared `viewConfig` for node positions across all stages. The physical stage has no files on disk -- it is derived from `manifest.json` at runtime.

## Getting Started

1. **Open your dbt project** in VS Code. The extension activates when it detects `dbt_project.yml`.
2. **Click the ERD Studio icon** in the Activity Bar (sidebar).
3. **Set up the directory** -- follow the prompt to initialize the `erd-studio/` folder in your project.
4. **Create your first domain** -- use the command palette (`Cmd+Shift+P`) and run **dbt: Create Semantic Domain**, then pick a name and layer.
5. **Add models and columns** -- right-click the canvas to add models, then define columns in the detail panel.
6. **Switch stages** -- use the toolbar tabs or `Alt+1/2/3` to move between Conceptual, Logical, and Physical views.

For the Physical stage to populate, run `dbt compile` or `dbt build` so that `manifest.json` exists in your `target/` directory.

## AI Coding Harness

ERD Studio can install its domain file schema reference into your repo so AI coding assistants understand the format and can create or validate models for you.

**Command Palette** → `dbt: Install AI Coding Harness`

Or click the robot icon in the ERD Studio sidebar title bar.

| Harness | File Installed | Format |
|---------|---------------|--------|
| **Claude Code** | `.claude/skills/erd-studio/SKILL.md` | YAML frontmatter + Markdown skill |
| **GitHub Copilot** | `.github/instructions/erd-studio.instructions.md` | YAML frontmatter with `applyTo` glob |
| **Google Gemini** | `.gemini/styleguide.md` | Markdown with code review rules |
| **OpenAI Codex** | `AGENTS.md` | Appended Markdown section |

Each file contains the ERD Studio JSON schema reference — model structure, column metadata, relationships, naming conventions, and model roles — formatted for that assistant's native config format. Multi-select is supported: install to multiple harnesses in one action.

## Discrepancy Overlay

The discrepancy overlay lets you compare adjacent stages side by side:

- **Physical vs Logical** -- See which columns or models exist in dbt but are missing from your logical design, and vice versa.
- **Logical vs Conceptual** -- Check that your detailed model aligns with the conceptual plan.

Differences are highlighted directly on the graph: extra columns, missing columns, data type mismatches, and missing models (shown as ghost nodes).

## Requirements

- VS Code 1.85 or later
- A dbt project with `dbt_project.yml`
- `dbt compile` or `dbt build` to generate `manifest.json` (required for the Physical stage)

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `dbtSemantic.projectPath` | Path to dbt project root | Auto-detected |
| `dbtSemantic.semanticDir` | Relative path to ERD domain files | `erd-studio` |

## License

MIT
