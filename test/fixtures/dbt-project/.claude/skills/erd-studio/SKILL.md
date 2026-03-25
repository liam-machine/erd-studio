---
name: erd-studio
description: Data modeling guide for ERD Studio — covers logical domain JSON format, dbt YAML tests for physical model relationships and cardinality, naming conventions, and design workflow. Use when creating, editing, or validating data models, dbt schema files, or executing a .sync-plan.json reconciliation plan.
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

## Domain File Structure

**File:** `erd-studio/{layer}/{domain}.json`

```json
{
  "schemaVersion": 5,
  "domain": "customer-360",
  "layer": "silver",
  "description": "Customer domain — master data and transaction history",
  "modelFolder": "models/silver",
  "logical": {
    "models": ["dim_customer", "fct_sale", "dim_product"],
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
| `logical.models` | Yes | Array of model name strings (references to `logical-models/*.yml`) |
| `logical.relationships` | Yes | Array of relationship objects |
| `viewConfig` | Yes | Root-level view settings. The extension auto-assigns positions for new models |

**viewConfig** must be at the root level, not inside `logical`. It stores node positions keyed by model name:

```json
"viewConfig": { "positions": { "dim_customer": { "x": 100, "y": 200 } } }
```

> **WARNING — Preserve existing positions:** When adding models to an existing domain file, do NOT clear or overwrite `viewConfig.positions`. The extension automatically computes positions for any new models that lack entries. Clearing existing positions will reset the user's carefully arranged layout.

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

The physical stage has **no files on disk**. It is derived at runtime from the dbt manifest (`target/manifest.json`):

1. **Models**: Logical models that exist in the manifest appear in physical. Columns come from the manifest; PK/FK/NK flags, grain, modelRole, scdType, and additiveType carry forward from logical.
2. **Relationships**: Derived from **dbt relationship tests** — not copied from logical. Each `relationships` test becomes an edge.
3. **Cardinality**: Derived from **uniqueness tests** — no `unique` test = "many" side.
4. **Scoping**: Only relationships between models **within the same domain** appear. References to models outside the domain are silently excluded.

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

<!-- erd-studio-harness: 7 -->
