# ERD Studio

A VS Code extension for visually designing data warehouse models across two stages: logical and physical — with dbt manifest integration.

## How It Works

ERD Studio organizes your data warehouse design into two stages, each serving a distinct purpose:

```
Logical             Physical
(model design)  --> (what dbt built)
```

| Stage | Color | Purpose | Editable |
|-------|-------|---------|----------|
| **Logical** | Blue | Detailed data model. Full column definitions with data types, PK/FK/NK badges, SCD types, grain, model roles, and rationale. | Yes |
| **Physical** | Green | What actually exists in dbt. Auto-derived from `manifest.json`, scoped to models in the logical domain. | Positions only |

Switch between stages using the toolbar tabs or keyboard shortcuts: `Alt+1` (Logical), `Alt+2` (Physical).

## Key Features

- **Two-stage design** -- Separate detailed modeling from physical reality
- **Global positioning** -- Node positions are shared across both stages, so your layout stays consistent
- **Drag-to-relate** -- Drag from a column handle to create FK relationships with cardinality
- **Discrepancy overlay** -- Compare stages to spot differences (extra/missing columns, type mismatches, missing models shown as ghost nodes)
- **Layer organization** -- Medallion layers (bronze, silver, gold, platinum) plus custom layers
- **Model templates** -- Presets for dimension, fact, bridge, and reference models
- **ELK auto-layout** -- Automatic graph layout with manual repositioning
- **Undo/redo** -- All edits go through VS Code's WorkspaceEdit system
- **dbt manifest integration** -- Physical stage reads directly from your compiled manifest
- **AI coding harness** -- Install schema reference for Claude, Copilot, Gemini, or Codex

## Directory Structure

ERD Studio stores domain files alongside your dbt project:

```
erd-studio/
├── layers.json              ← layer configuration
├── templates/               ← model templates
├── silver/
│   ├── customer-360.json    ← domain file (logical stage)
│   └── orders.json
└── gold/
    └── reporting.json
```

Each domain is a single JSON file containing the `logical` section and a `viewConfig` for node positions. The physical stage has no files on disk -- it is derived from `manifest.json` at runtime.

## Getting Started

1. **Open your dbt project** in VS Code. The extension activates when it detects `dbt_project.yml`.
2. **Click the ERD Studio icon** in the Activity Bar (sidebar).
3. **Set up the directory** -- follow the prompt to initialize the `erd-studio/` folder in your project.
4. **Create your first domain** -- use the command palette (`Cmd+Shift+P`) and run **dbt: Create Semantic Domain**, then pick a name and layer.
5. **Add models and columns** -- right-click the canvas to add models, then define columns in the detail panel.
6. **Switch stages** -- use the toolbar tabs or `Alt+1/2` to move between Logical and Physical views.

For the Physical stage to populate, run `dbt compile` or `dbt build` so that `manifest.json` exists in your `target/` directory.

## Physical Stage — How It Works

The physical stage is entirely derived from the dbt manifest at runtime. Nothing is stored on disk for the physical stage.

### Models

Physical models are the intersection of your **logical domain** and the **manifest**: only logical models that also exist in `manifest.json` appear. Columns come from the manifest (data types, descriptions), while PK/FK/NK flags, SCD types, grain, model role, and rationale are carried forward from the logical domain.

### Relationships

Physical relationships are derived from **dbt relationship tests** in the manifest — they are **not** copied from the logical stage. When you define a `relationships` test in your dbt YAML schema, it appears in the manifest as a test node. ERD Studio extracts these and renders them as edges.

This means: if a relationship exists in your logical model but has no `relationships` test in dbt, it will **not** appear in the physical stage. This is intentional — the physical stage reflects what dbt actually validates.

**Supported test types:**
- `relationships` (dbt built-in)
- `relationships_where` (dbt_utils) and other custom tests with the same kwargs signature (`column_name`, `field`, `to`)

**Example dbt YAML that produces a physical relationship:**

```yaml
models:
  - name: fct_orders
    columns:
      - name: customer_id
        tests:
          - relationships:
              to: ref('dim_customer')
              field: customer_id
```

### Cardinality

dbt's `relationships` test only validates referential integrity — it doesn't encode cardinality. ERD Studio derives cardinality from **uniqueness tests** in the manifest:

| FK column has `unique` test? | PK column has `unique` test? | Derived Cardinality |
|------------------------------|------------------------------|---------------------|
| No | Yes | `many-to-one` |
| Yes | Yes | `one-to-one` |
| Yes | No | `one-to-many` |
| No | No | `many-to-many` |

**No `unique` test = "many" side.** If you want `many-to-one` to appear on the physical model, add a `unique` test to the PK column on the referenced model:

```yaml
models:
  - name: dim_customer
    columns:
      - name: customer_id
        tests:
          - unique       # ← Makes this side "one"
          - not_null
```

**Composite keys** are also supported via `dbt_utils.unique_combination_of_columns`. If all columns in a composite unique group are covered by relationship tests between the same model pair, that side is treated as "one".

### Domain scoping

Physical relationships are scoped to models within the current domain. If `dim_customer` is a conformed dimension referenced by 50 models across your dbt project, only relationships to other models **in the same domain's logical stage** appear — preventing the graph from pulling in unrelated models.

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
