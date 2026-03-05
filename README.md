# ERD Studio

Visual ERD studio for data warehouse projects. Design, approve, and track models, columns, and FK relationships through a full design-to-built lifecycle. Works with dbt manifests.

## Features

- **Visual Domain Diagrams** — See your dbt models and their relationships in an interactive graph
- **Design Mode** — Plan new models, columns, and relationships before building them
- **Built vs Design States** — Built models (from manifest) shown in blue, design models in orange
- **Relationship Cardinality** — Visualize 1:1, 1:N, and N:M relationships with crow's foot notation
- **Layer Organization** — Organize models by medallion layers (bronze, silver, gold, platinum)
- **Auto-Reconciliation** — Automatically detect when design models are built and update their status

## Getting Started

1. Open a dbt project in VS Code
2. Click the **Semantic Domains** icon in the Activity Bar
3. Click **Get Started** to create your first domain
4. Add models from your manifest or design new ones

## Requirements

- A valid dbt project with `dbt_project.yml`
- Run `dbt compile` or `dbt build` to generate `manifest.json` for built model detection

## Usage

### Creating a Domain

1. Open the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Run **dbt: Create Semantic Domain**
3. Enter a domain name and select a layer

### Adding Models

- **From Manifest**: Right-click in the diagram → Add Built Model
- **Design New**: Right-click in the diagram → Add Design Model

### Creating Relationships

1. Click and drag from a column handle on one model
2. Drop onto a column handle on another model
3. Configure the relationship cardinality

## Extension Settings

- `dbtSemantic.projectPath`: Path to dbt project root (auto-detected)
- `dbtSemantic.semanticDir`: Relative path to semantic domain files (default: `erd-studio`)
- `dbtSemantic.autoReconcile`: Auto-transition design models to built when detected

## License

MIT
