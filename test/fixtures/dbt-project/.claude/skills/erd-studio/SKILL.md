---
name: erd-studio
description: >-
  Schema rules for ERD Studio data model files — the erd-studio/ directory
  uses a two-file system (YAML model definitions + JSON domain diagrams)
  with strict format rules you must read before editing. Use this skill
  whenever the task touches files in erd-studio/ (domain JSON, logical-models
  YAML, or .sync-plan.json), asks to add/edit/remove models, columns,
  relationships, or cardinality in a data model or ERD diagram, mentions
  dim_/fct_/ref_/brg_ prefixed tables in an erd-studio context, or involves
  writing dbt schema YAML tests to match an ERD physical stage. The skill
  tells you which of the two files to edit for each operation — without it
  you will put data in the wrong file.
---

# ERD Studio — AI Data Modeling Guide

ERD Studio uses a **central model store** architecture. Model definitions are YAML files in `erd-studio/logical-models/`. Domain JSON files reference models by name and define relationships and layout.

## Architecture Overview

```
erd-studio/
├── logical-models/           ← Central model definitions (YAML, one per model)
│   ├── dim_customer.yml
│   ├── dim_project.yml
│   └── fct_sale.yml
├── silver/
│   ├── customer-360.json     ← Domain file (model references + relationships + layout)
│   └── orders.json
└── gold/
    └── reporting.json
```

**Key principle:** Models are defined ONCE in `logical-models/` and referenced from multiple domain files. Editing a model from any domain updates the shared definition.

### Model Library (Sidebar)

The **Model Library** panel in the ERD Studio sidebar shows all YAML files in `logical-models/`. Use it to understand the difference between "model definition exists" and "model is referenced by a domain":

- **Referenced models** show how many domains use them (e.g. "2 domains")
- **Orphaned models** show a warning icon and "(unused)" — these exist as `.yml` files but are not in any domain's `logical.models[]` array

**Important for AI agents:** Before saying a model "already exists in the ERD", check whether it is referenced by the target domain's `logical.models[]` array — not just whether the `.yml` file exists. A model file in `logical-models/` may be unused (orphaned) or only referenced by other domains.

## Domain File Structure

**File:** `erd-studio/{layer}/{domain}.json`

```json
{
  "schemaVersion": 5,
  "domain": "customer-360",
  "layer": "silver",
  "description": "Customer domain — master data and transaction history",
  "modelFolder": "models/silver",
  "stubColumns": ["dim_project"],
  "logical": {
    "models": ["dim_customer", "fct_sale", "dim_product", "dim_project"],
    "relationships": []
  },
  "viewConfig": {}
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `schemaVersion` | Yes | Must be `5` |
| `domain` | Yes | Domain slug (matches filename without `.json`) |
| `layer` | Yes | Layer name matching parent directory (e.g. `silver`, `gold`) |
| `description` | No | Human-readable domain description |
| `modelFolder` | No | Filter for "Add Existing Model" dialog (e.g. `models/silver`) |
| `stubColumns` | No | Model names whose physical-only columns are suppressed in sync comparison. Use for conformed dimensions and reference tables included only to anchor relationships — they define a few key columns (PK/NK) but not the full physical column set. Missing-column discrepancies are hidden; extra and type-mismatch discrepancies on defined columns still surface. |
| `logical.models` | Yes | Array of model name strings (references to `logical-models/*.yml`) |
| `logical.relationships` | Yes | Array of relationship objects |
| `viewConfig` | Yes | Root-level view settings. The extension auto-assigns positions for new models |

**viewConfig** must be at the root level, not inside `logical`. It stores node positions keyed by model name, and optional canvas annotations (build notes):

```json
"viewConfig": {
  "positions": { "dim_customer": { "x": 100, "y": 200 } },
  "annotations": [
    { "id": "uuid", "text": "Build note text", "x": 300, "y": 50, "color": "yellow", "linkedModel": "dim_customer" }
  ]
}
```

Annotations are temporary build notes — visible on the canvas while constructing models. They are view-layer data, not semantic data. Valid colours: `yellow`, `blue`, `green`, `pink`, `orange`. The `linkedModel` field is optional and draws a dashed edge to the named model.

> **WARNING — Preserve existing positions:** When adding models to an existing domain file, do NOT clear or overwrite `viewConfig.positions`. The extension automatically computes positions for any new models that lack entries. Clearing existing positions will reset the user's carefully arranged layout.

---

## Editing Quick Reference

**CRITICAL — Two files control the diagram.** Column data lives in the YAML; structural data lives in the JSON. You must edit the correct file for each operation.

| User asks to... | Edit this file |
|-----------------|---------------|
| Add/remove/rename a column | `logical-models/{name}.yml` |
| Change column type, PK/FK/NK flags, SCD type | `logical-models/{name}.yml` |
| Change grain, modelRole, description, rationale | `logical-models/{name}.yml` |
| Add a model to a domain diagram | Domain `.json` → add name to `logical.models[]` AND create `logical-models/{name}.yml` if it doesn't exist |
| Remove a model from a domain | Domain `.json` → remove name from `logical.models[]` AND remove its relationships from `logical.relationships[]` |
| Add/remove/edit a relationship | Domain `.json` → `logical.relationships[]` |
| Change layout positions | Domain `.json` → `viewConfig.positions` |

> **Common mistake:** Editing the `.yml` file alone is sufficient for column and model property changes — the extension picks up YAML changes automatically. But adding a model to the **diagram** requires BOTH creating the `.yml` AND adding the name string to the domain `.json`. Similarly, relationships are ONLY stored in the domain `.json`, never in the `.yml`.

---

## Models

Model definitions live in `erd-studio/logical-models/{model_name}.yml`. Create/edit these YAML files to define models. Then reference them by name in domain files.

**File:** `erd-studio/logical-models/dim_customer.yml`

```yaml
name: dim_customer
schema: silver
description: Customer master data
grain: One row per customer
modelRole: conformed-dim
rationale:
  purpose: Customer master data for cross-domain joins
  roleChoice: Conformed dimension shared across domains
columns:
  - name: customer_id
    dataType: INT
    description: Surrogate key
    isPrimaryKey: true
    scdType: 0
  - name: email
    dataType: VARCHAR
    description: Email address
    isNaturalKey: true
    scdType: 1
  - name: full_name
    dataType: VARCHAR
    description: Customer display name
    scdType: 2
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Model name (see naming conventions below) |
| `schema` | No | Target schema for materialization |
| `description` | No | Human-readable model description |
| `grain` | No | Grain statement — "One row per ___" |
| `modelRole` | No | Architecture role (see values below) |
| `columns` | No | Array of column definitions |
| `rationale` | No | Design rationale object (omit if empty) |

### modelRole Values

| Value | Use Case |
|-------|----------|
| `conformed-dim` | Shared dimension reused across domains |
| `domain-dim` | Dimension specific to this domain |
| `transaction-fact` | Discrete event fact |
| `periodic-snapshot` | Recurring measurement per period |
| `accumulating-snapshot` | Lifecycle with milestones |
| `factless-fact` | M:M bridge table, FKs only |
| `reference` | Low-cardinality lookup |
| `gold-fact` | Pre-joined Gold view |
| `gold-dim` | Flattened Gold dimension view |

### Design Rationale

Optional `rationale` object — all fields are optional strings. Omit the entire object if no rationale is needed.

| Field | Purpose |
|-------|---------|
| `purpose` | What requirements this model fulfils |
| `design` | Why it was designed this way |
| `grainChoice` | Why this grain was chosen over alternatives |
| `roleChoice` | Why this model role was selected |
| `scdStrategy` | Overall SCD strategy across dimension attributes |
| `measures` | Why measures are structured this way |

---

## Columns

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Column identifier |
| `dataType` | Yes | SQL type: `INT`, `INTEGER`, `VARCHAR`, `STRING`, `FLOAT`, `BOOLEAN`, `DATE`, `DECIMAL(18,2)`, `TIMESTAMP_NTZ`, etc. |
| `description` | Yes | Human-readable description |
| `isPrimaryKey` | No | Primary key. Only include when `true`. |
| `isForeignKey` | No | Foreign key intent. Only include when `true`. |
| `isNaturalKey` | No | Business identifier (email, SKU, etc.). Only include when `true`. |
| `scdType` | No | SCD type for dimensions: `0` = fixed/never changes, `1` = overwrite, `2` = track history |
| `additiveType` | No | Fact measures: `"additive"`, `"semi-additive"`, `"non-additive"` |

**Boolean flags** (`isPrimaryKey`, `isForeignKey`, `isNaturalKey`): omit rather than setting to `false`.

---

## Relationships

```json
{
  "fromModel": "fct_orders",
  "fromColumn": "customer_id",
  "toModel": "dim_customer",
  "toColumn": "customer_id",
  "cardinality": "many-to-one"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `fromModel` | Yes | FK side model name |
| `fromColumn` | Yes | FK column name |
| `toModel` | Yes | PK side model name |
| `toColumn` | Yes | PK column name |
| `cardinality` | Yes | `many-to-one`, `one-to-one`, `one-to-many`, or `many-to-many` |

**Direction:** `fromModel` is always the FK side, `toModel` is the PK side. FK column names should match the PK column name of the referenced table.

---

## Naming Conventions

| Type | Prefix | PK Pattern | Example |
|------|--------|-----------|---------|
| Dimension | `dim_` | `{entity}_id` | `dim_customer` → PK `customer_id` |
| Fact | `fct_` | `{entity}_id` or composite | `fct_order` → PK `order_id` |
| Reference | `ref_` | `ref_{entity}_code` | `ref_country` → PK `ref_country_code` |
| Bridge | `brg_` | composite FK pair | `brg_project_contact` |

---

## Physical Stage (Read-Only)

The physical stage has **no files on disk**. It is derived at runtime primarily from dbt `.yml` schema files, with optional enrichment from `target/manifest.json`:

1. **Models**: Logical models that have a corresponding `.yml` schema file appear in physical. Columns come from the `.yml` file; `data_type` is enriched from the manifest when available. PK/FK/NK flags, grain, modelRole, scdType, and additiveType carry forward from logical.
2. **Relationships**: Derived from **dbt relationship tests declared in `.yml` files** — not copied from logical. Each `relationships` test becomes an edge.
3. **Cardinality**: Derived from **uniqueness tests** in `.yml` files (and manifest when available) — no `unique` test = "many" side.
4. **Scoping**: Only relationships between models **within the same domain** appear. References to models outside the domain are silently excluded.
5. **Fallback**: If no `.yml` files are found, the physical stage falls back to deriving entirely from `target/manifest.json`.

### Cardinality Derivation

| FK has `unique` test? | PK has `unique` test? | Result |
|------------------------|------------------------|--------|
| No | Yes | `many-to-one` |
| Yes | Yes | `one-to-one` |
| Yes | No | `one-to-many` |
| No | No | `many-to-many` |

For composite keys, `dbt_utils.unique_combination_of_columns` is recognized when **all** columns in the group are covered by relationship tests between the same model pair.

Recognized test types: `relationships`, `relationships_where`, and any test whose name starts with `relationships`.

### Implementing Logical → Physical

| Logical Element | dbt YAML Required |
|----------------|-------------------|
| PK column | `unique` + `not_null` tests |
| FK column | `relationships` test to PK model/column |
| Cardinality | `unique` test on PK column + `relationships` test on FK column |
| Composite PK | `dbt_utils.unique_combination_of_columns` model-level test |

---

## Sync Reconciliation

When asked to execute a sync plan, or when `erd-studio/.sync-plan.json` exists:

1. Read `SYNC.md` in the same directory as this skill file for the full action reference and execution guide
2. Read `erd-studio/.sync-plan.json` for the specific actions to execute
3. Follow the execution steps in SYNC.md to reconcile logical and physical models

<!-- erd-studio-harness: 13 -->
