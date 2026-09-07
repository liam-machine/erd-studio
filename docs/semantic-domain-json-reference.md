# Semantic Domain JSON Reference

> Context document for AI agents generating ERD Studio domain files. Describes the **schemaVersion 5** format written by the current extension. The authoritative, always-current copy of this guidance is the `SCHEMA_CONTENT` string in `src/services/harnessService.ts` (installed into a project via "ERD Studio: Install AI Coding Harness").

## File Layout

ERD Studio uses a **central model store**. Model definitions are YAML files in `.erd-studio/logical-models/`; domain JSON files reference models **by name** and hold relationships and layout.

```
.erd-studio/
  layers.json                 ← layer definitions
  logical-models/             ← one YAML per model, shared across domains
    dim_customer.yml
    fct_order_line.yml
  templates/                  ← optional model templates
    dimension.json
  silver/                     ← one directory per layer id
    sales.json                ← domain file
  gold/
    reporting.json
```

There are two stages. **Logical** is the editable stage stored in the domain file and model YAMLs. **Physical** has no files — it is derived at runtime by resolving each model in `logical.models` against the dbt schema YAMLs under `model-paths` (preferred) or `{target-path}/manifest.json` (fallback), with relationships and cardinality taken from the union of the `relationships` / `unique` / `unique_combination_of_columns` tests declared in either source. Model and column names match case-insensitively. Do not create files for the physical stage; the only writes allowed while a canvas shows it are to the shared `viewConfig` (positions, annotations).

The base directory name (`.erd-studio`) is configurable via the `erdStudio.semanticDir` setting.

## Domain File (`.erd-studio/{layer}/{domain}.json`)

### Top-Level Schema

```jsonc
{
  "schemaVersion": 5,                    // REQUIRED. Must be 5.
  "domain": "sales",                     // REQUIRED. Slug; matches filename without .json.
  "layer": "silver",                     // REQUIRED. Must match a layer id from layers.json and the parent directory.
  "description": "Sales domain",         // Optional. Defaults to "".
  "modelFolder": "models/silver",        // Optional. Filters the "Add Existing Model" dialog.
  "stubColumns": ["dim_date"],           // Optional. Models whose physical-only columns are ignored in sync comparison.
  "logical": {
    "models": ["dim_customer", "fct_order_line"],   // REQUIRED. Model NAME STRINGS (refs to logical-models/*.yml).
    "relationships": []                             // REQUIRED. Array of Relationship objects.
  },
  "viewConfig": {}                       // REQUIRED. Root-level UI state (positions, annotations, layout options).
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | number | Yes | Must be `5`. |
| `domain` | string | Yes | Domain slug. Should equal the filename without `.json`. |
| `layer` | string | Yes | Must match an `id` in `layers.json` and the parent directory name. |
| `description` | string | No | Human-readable domain description. |
| `modelFolder` | string | No | Path prefix filter for the "Add Existing Model" dialog (e.g. `"models/silver"`). |
| `stubColumns` | string[] | No | Model names (typically conformed dimensions / reference tables) that define only key columns. Missing-column discrepancies for these models are hidden; extra and type-mismatch discrepancies still surface. |
| `logical.models` | string[] | Yes | Model **name strings**. Each must correspond to `.erd-studio/logical-models/{name}.yml`. |
| `logical.relationships` | array | Yes | Array of `Relationship` objects. |
| `viewConfig` | object | Yes | Persisted UI layout. Must be at the root, not inside `logical`. |

### Format detection and supported versions

The extension decides how to read a file with a single detector (`detectDomainFormat` in `src/types/semantic.ts`). Every reader and writer uses the same rules:

| Format | Shape | Behaviour |
|--------|-------|-----------|
| `v5` | `schemaVersion: 5`, `logical.models` is all strings (or empty) | Current format. Fully supported. |
| `v4` | `schemaVersion: 4`, `logical.models` is all inline model objects | Deprecated but still loads. On activation the extension prompts to run **ERD Studio: Migrate Domains to Central Model Store**, which extracts each object to `logical-models/{name}.yml` and replaces it with its name. |
| `hybrid` | `schemaVersion: 5` with inline objects, a mix of strings and objects, or entries that are neither | **Rejected** with an error pointing at the migration command. Migration repairs it (inline objects are extracted — existing YAML files are never overwritten). |
| `legacy` | `schemaVersion` below 4, and/or a top-level `models` array instead of `logical` | **Rejected** with an error. Migration lifts `models`/`relationships` under `logical`, drops `stage`, and converts to v5. |

Never produce hybrid or legacy files. When adding a model to a domain, add its **name string** to `logical.models` and create the YAML file if it does not exist.

## Model Files (`.erd-studio/logical-models/{name}.yml`)

```yaml
name: dim_customer
schema: silver
description: Customer master data for all sales channels
grain: One row per customer
modelRole: conformed-dim
rationale:
  purpose: Central customer entity shared across sales, marketing, and support
  roleChoice: Conformed dimension because customer data is referenced by multiple business areas
  scdStrategy: SCD1 for mutable attributes; customer_code and customer_id never change
columns:
  - name: customer_id
    dataType: INTEGER
    description: Surrogate key
    isPrimaryKey: true
    scdType: 0
  - name: customer_code
    dataType: STRING
    description: Business identifier from the source system
    isNaturalKey: true
    scdType: 0
  - name: email
    dataType: STRING
    description: Primary email address
    scdType: 1
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Model name. Must equal the filename without `.yml`. |
| `schema` | string | No | Target schema the model materialises in. |
| `description` | string | No | Human-readable description. |
| `grain` | string | No | Grain statement: "One row per ___". |
| `modelRole` | string | No | Role in the warehouse architecture. See ModelRole enum. |
| `columns` | array | No | Array of `ColumnDef`. |
| `rationale` | object | No | Design rationale. Omit entirely if empty. |

Models are defined once and can be referenced from several domains. Editing a model from any domain canvas updates the shared YAML.

### Column Definition (ColumnDef)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Column identifier. |
| `dataType` | string | Yes | SQL data type: `STRING`, `INTEGER`, `INT`, `BOOLEAN`, `DATE`, `DECIMAL(18,2)`, `TIMESTAMP_NTZ`, `VARCHAR`, etc. |
| `description` | string | Yes | Human-readable column description. |
| `isPrimaryKey` | boolean | No | Primary key flag. Only include when `true`. |
| `isForeignKey` | boolean | No | Foreign key intent flag. Only include when `true`. |
| `isNaturalKey` | boolean | No | Business identifier (email, SKU, customer_code). Only include when `true`. |
| `scdType` | `0` \| `1` \| `2` | No | Dimension columns: 0 = never changes, 1 = overwrite, 2 = track history. |
| `additiveType` | string | No | Fact measures: `"additive"`, `"semi-additive"`, or `"non-additive"`. |

### ModelRole Enum

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

### Rationale

Optional object documenting the reasoning behind a model's design. All fields are optional strings. If all fields would be empty, omit `rationale` entirely. The canvas shows an "R" badge on models that have rationale.

| Field | Description |
|-------|-------------|
| `purpose` | What requirements or purpose this model fulfils |
| `design` | Why the model was designed this way — trade-offs, constraints, patterns |
| `roleChoice` | Why this model role was selected |
| `grainChoice` | Why this grain was chosen over alternatives |
| `scdStrategy` | Overall SCD strategy across dimension attributes |
| `measures` | Why measures are structured this way — additive type choices |

## Relationships (`logical.relationships`)

Relationships are stored **only** in the domain JSON, never in the YAML.

```jsonc
{
  "fromModel": "fct_order_line",
  "fromColumn": "customer_id",
  "toModel": "dim_customer",
  "toColumn": "customer_id",
  "cardinality": "many-to-one"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fromModel` | string | Yes | Model containing the FK (the "many" side for many-to-one). |
| `fromColumn` | string | Yes | FK column name on the from model. |
| `toModel` | string | Yes | Referenced model (PK side). |
| `toColumn` | string | Yes | Referenced PK column on the to model. |
| `cardinality` | string | Yes | One of `"many-to-one"`, `"one-to-one"`, `"one-to-many"`, `"many-to-many"`. |

**Identity key:** the composite `(fromModel, fromColumn, toModel, toColumn)` must be unique within the domain.

**Direction convention:** `fromModel` holds the FK, `toModel` holds the PK.

Entries missing any of the four string endpoints are dropped on read with a console warning; an unrecognised `cardinality` falls back to `many-to-one`.

## View Config (`viewConfig`)

Persisted UI layout state. Safe to leave as `{}` — the extension auto-positions models that lack a position entry.

```jsonc
{
  "showFkEdges": true,
  "layoutOptions": { "elk.algorithm": "mrtree", "elk.direction": "DOWN" },
  "positions": {
    "dim_customer": { "x": 100, "y": 200 },
    "fct_order_line": { "x": 400, "y": 50 }
  },
  "annotations": [
    { "id": "uuid", "text": "Build note", "x": 300, "y": 50, "color": "yellow", "linkedModel": "dim_customer" }
  ]
}
```

| Field | Description |
|-------|-------------|
| `showFkEdges` | Whether FK edges are drawn. |
| `layoutOptions` | ELK layout options as string key/value pairs. |
| `positions` | Node positions keyed by model name. Each entry must have finite numeric `x` and `y`; malformed entries are ignored on read and the model is auto-positioned. |
| `annotations` | Free-form canvas post-it notes. `id`, `text`, `x`, `y` required; `color` is one of `yellow`, `blue`, `green`, `pink`, `orange`; `linkedModel` draws a dashed edge to that model. |

> **Preserve existing positions.** When adding models to an existing domain, do not clear or rewrite `viewConfig.positions`. The extension computes positions for new models automatically.

## Editing Quick Reference

| To... | Edit |
|-------|------|
| Add/remove/rename a column, change type or PK/FK/NK/SCD flags | `logical-models/{name}.yml` |
| Change grain, modelRole, description, rationale | `logical-models/{name}.yml` |
| Add a model to a domain diagram | Domain `.json` → append the name to `logical.models` **and** create `logical-models/{name}.yml` if missing |
| Remove a model from a domain | Domain `.json` → remove the name from `logical.models` and its relationships from `logical.relationships` |
| Add/remove/edit a relationship | Domain `.json` → `logical.relationships` |
| Rename a domain | Rewrite `domain` in the raw JSON and rename the file; never re-serialise a resolved domain (that inlines model bodies and produces a hybrid file) |

## Layers File (`.erd-studio/layers.json`)

```jsonc
{
  "schemaVersion": 1,
  "layers": [
    { "id": "silver", "label": "Silver", "abbreviation": "SLV", "color": "#a0a0a0", "creatable": true, "order": 1 },
    { "id": "gold",   "label": "Gold",   "abbreviation": "GLD", "color": "#d4a800", "creatable": true, "order": 2 }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Lowercase identifier. Alphanumeric, hyphens, underscores. Also the directory name for that layer's domains. |
| `label` | string | Yes | Display name. |
| `abbreviation` | string | Yes | Short badge label. |
| `color` | string | Yes | Hex colour. |
| `creatable` | boolean | Yes | Whether new domains can be created in this layer. |
| `order` | number | Yes | Display order (lower first). |

Defaults if `layers.json` is missing: `bronze` (`#cd7f32`, not creatable), `silver` (`#a0a0a0`), `gold` (`#d4a800`).

## Model Templates (`.erd-studio/templates/{id}.json`)

Templates provide preset columns when creating a model from the canvas.

```jsonc
{
  "id": "scd2_dimension",              // REQUIRED. Unique across all template files — a duplicate id is skipped with a warning.
  "label": "SCD2 Dimension",           // REQUIRED.
  "prefix": "dim_",                    // Optional. Model name prefix.
  "description": "History-tracked dimension",
  "requiresLeftEntity": false,         // Optional. Bridge templates only.
  "requiresRightEntity": false,        // Optional. Bridge templates only.
  "columns": [
    { "name": "{name}_id", "dataType": "INTEGER", "description": "Surrogate key", "isPrimaryKey": true, "scdType": 0 },
    { "name": "{name}_code", "dataType": "VARCHAR", "description": "Business key", "isNaturalKey": true, "scdType": 0 },
    { "name": "name", "dataType": "VARCHAR", "description": "Display name", "scdType": 2 }
  ]
}
```

Template columns accept the full `ColumnDef` shape: `isPrimaryKey`, `isForeignKey`, `isNaturalKey`, `scdType` (0/1/2) and `additiveType` are all carried through to the created model; invalid values are dropped.

**Placeholders:** `{name}` is replaced with the model name minus its prefix (e.g. `customer` from `dim_customer`). Bridge templates also support `{left}` and `{right}`.

If no template files exist, built-in `dimension`, `fact`, `bridge`, `scd2` and `blank` templates are used.

## Naming Conventions

| Pattern | Prefix | Example | Use Case |
|---------|--------|---------|----------|
| Dimension | `dim_` | `dim_customer` | Entity/master data |
| Fact | `fct_` | `fct_order_line` | Transactional/event tables |
| Bridge | `brg_` | `brg_order_product` | Many-to-many junctions |
| Reference | `ref_` | `ref_country` | Lookup tables |

**PK naming:** `{entity}_id`. **FK naming:** matches the referenced PK name.

## Validation Rules

1. `schemaVersion` must be `5`. Versions below 4 and top-level `models` arrays are rejected; version 4 is accepted only until migrated.
2. `layer` must match an `id` in `layers.json`.
3. Every entry in `logical.models` must be a string. Mixed string/object arrays are rejected.
4. Each referenced model should have a `logical-models/{name}.yml`; a missing file renders as a placeholder with a warning.
5. Relationship identity `(fromModel, fromColumn, toModel, toColumn)` must be unique, and both models should be in `logical.models`.
6. `viewConfig` must be at the root of the document.

## Complete Example

File: `.erd-studio/silver/sales.json`

```json
{
  "schemaVersion": 5,
  "domain": "sales",
  "layer": "silver",
  "description": "Sales domain covering customers, products, and order transactions",
  "modelFolder": "models/silver",
  "logical": {
    "models": ["dim_customer", "dim_product", "fct_order_line"],
    "relationships": [
      { "fromModel": "fct_order_line", "fromColumn": "customer_id", "toModel": "dim_customer", "toColumn": "customer_id", "cardinality": "many-to-one" },
      { "fromModel": "fct_order_line", "fromColumn": "product_id",  "toModel": "dim_product",  "toColumn": "product_id",  "cardinality": "many-to-one" }
    ]
  },
  "viewConfig": {}
}
```

File: `.erd-studio/logical-models/fct_order_line.yml`

```yaml
name: fct_order_line
schema: silver
description: Order line items capturing each product sold in a transaction
grain: One row per order line item
modelRole: transaction-fact
rationale:
  purpose: Core transactional fact for revenue, volume, and margin analysis
  measures: line_amount and quantity are additive; unit_price is non-additive
columns:
  - name: order_line_id
    dataType: INTEGER
    description: Surrogate key
    isPrimaryKey: true
  - name: customer_id
    dataType: INTEGER
    description: FK to dim_customer
    isForeignKey: true
  - name: product_id
    dataType: INTEGER
    description: FK to dim_product
    isForeignKey: true
  - name: quantity
    dataType: INTEGER
    description: Units ordered
    additiveType: additive
  - name: unit_price
    dataType: DECIMAL(18,2)
    description: Price per unit at time of sale
    additiveType: non-additive
  - name: line_amount
    dataType: DECIMAL(18,2)
    description: Net line total
    additiveType: additive
```
