# Semantic Domain JSON Reference

> Context document for AI agents generating ERD Studio domain files. Describes the **schemaVersion 5** format written by the current extension. The authoritative, always-current copy of this guidance is the `SCHEMA_CONTENT` string in `src/services/harnessService.ts` (installed into a project via "ERD Studio: Install AI Coding Harness").

## File Layout

ERD Studio uses a **central model store**. Model definitions are YAML files in `.erd-studio/logical-models/` (at the top level or one folder down); domain JSON files reference models **by name** and hold relationships and layout.

```
.erd-studio/
  layers.json                 ← layer definitions
  logical-models/             ← one YAML per model, shared across domains
    dim_customer.yml          ← top level (flat libraries keep working)
    bronze/                   ← optional per-layer folders
      sap__mara.yml
    silver/
      fct_order_line.yml
  templates/                  ← optional model templates
    dimension.json
  silver/                     ← one directory per layer id
    sales.json                ← domain file
  gold/
    reporting.json
```

There are two stages. **Logical** is the editable stage stored in the domain file and model YAMLs. **Physical** has no files — it is derived at runtime from the dbt project (source files, schema YAMLs, `{target-path}/manifest.json`, `{target-path}/catalog.json`); see [Physical Stage](#physical-stage-derived-read-only) below for the full resolution rules. Model and column names match case-insensitively. Do not create files for the physical stage; the only writes allowed while a canvas shows it are to the shared `viewConfig` (positions, annotations).

### Model file location

- A model file lives at `logical-models/{name}.yml` **or** exactly one folder down at `logical-models/{folder}/{name}.yml`. By convention the folder is a layer id (`bronze`, `silver`, `gold`). Deeper nesting and dot-folders are not scanned.
- The folder is organisational only: domain files reference models by **name**, and names are **unique across the whole library**, as dbt model names are across a project.
- **Lookup:** the top-level file first, then each folder in alphabetical order. A second file with the same name elsewhere is *shadowed* — ignored, and flagged in the Model Library view.
- **Folders are opt-in per project.** A library uses layer folders once any model file sits in a folder named after a layer in `layers.json` (or while it is empty); a hand-made folder such as `Staging/` does not count. Then a new model created from a canvas is written to the folder of the layer of the domain it is added to (`gold/reporting.json` → `logical-models/gold/`). A flat library stays flat: new files go to the top level until someone runs **ERD Studio: Organise Model Library by Layer**. Opting in is a team decision — a teammate on ERD Studio 1.0.x only reads the top level and would see models in folders as missing. A rename keeps the file in its folder.
- **Organise Model Library by Layer** moves each file into the folder of the one layer whose domains reference it: top-level files, and files sitting in *another* layer's folder (the domains that use it moved layer). A model used by several layers, or by none, stays where it is. Folders that are not a layer in `layers.json` (a hand-made `Staging/`, or a layer id since removed) are never touched and are named in the confirmation. Re-running it is always safe.
- Hosts that cannot list directories (the `@erd-studio/core` `loadDisplayDomain` viewer) probe the top level, then every layer folder alphabetically (the extension's order), so they see only folders named after a layer.

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
    "models": ["dim_customer", "fct_order_line"],   // REQUIRED. Model NAME STRINGS (refs to logical-models/[folder/]*.yml).
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
| `logical.models` | string[] | Yes | Model **name strings**. Each must correspond to `.erd-studio/logical-models/{name}.yml` or `.erd-studio/logical-models/{folder}/{name}.yml`. |
| `logical.relationships` | array | Yes | Array of `Relationship` objects. |
| `viewConfig` | object | Yes | Persisted UI layout. Must be at the root, not inside `logical`. |

### Format detection and supported versions

The extension decides how to read a file with a single detector (`detectDomainFormat` in `packages/core/src/types/semantic.ts`). Every reader and writer uses the same rules:

| Format | Shape | Behaviour |
|--------|-------|-----------|
| `v5` | `schemaVersion: 5`, `logical.models` is all strings (or empty) | Current format. Fully supported. |
| `v4` | `schemaVersion: 4`, `logical.models` is all inline model objects | Deprecated but still loads. On activation the extension prompts to run **ERD Studio: Migrate Domains to Central Model Store**, which extracts each object to `logical-models/{layer}/{name}.yml` (the domain's layer folder; the top level when the library already holds flat files, or when several layers inline the model) and replaces it with its name. |
| `hybrid` | `schemaVersion: 5` with inline objects, a mix of strings and objects, or entries that are neither | **Rejected** with an error pointing at the migration command. Migration repairs it (inline objects are extracted — existing YAML files are never overwritten). |
| `legacy` | `schemaVersion` below 4, and/or a top-level `models` array instead of `logical` | **Rejected** with an error. Migration lifts `models`/`relationships` under `logical`, drops `stage`, and converts to v5. |

Never produce hybrid or legacy files. When adding a model to a domain, add its **name string** to `logical.models` and create the YAML file if it does not exist.

## Model Files (`.erd-studio/logical-models/[{folder}/]{name}.yml`)

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
| Add/remove/rename a column, change type or PK/FK/NK/SCD flags | the model's yml (`logical-models/{name}.yml` or `logical-models/{folder}/{name}.yml`) |
| Change grain, modelRole, description, rationale | the model's yml |
| Add a model to a domain diagram | Domain `.json` → append the name to `logical.models` **and**, if no file for the name exists in any folder, create `logical-models/{layer}/{name}.yml` for the domain's layer |
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

## Physical Stage (Derived, Read-Only)

The physical stage is not stored anywhere. Each name in `logical.models` is resolved
against the dbt project every time the stage is opened, from up to four sources:
source files under the configured `model-paths` / `seed-paths` / `snapshot-paths`,
dbt schema `.yml` files under `model-paths`, `{target-path}/manifest.json`, and
`{target-path}/catalog.json`. None of the four is required — a project that has
never been compiled still renders real models.

**Existence.** A model is real (not a ghost) when **any** of these holds:

- a `<name>.sql`, `<name>.py` or `<name>.csv` file sits under a configured
  `model-paths`, `seed-paths` or `snapshot-paths` directory (so seeds and snapshots
  count), **and** dbt has not disabled the model;
- a dbt schema `.yml` under `model-paths` declares it;
- the compiled manifest carries a node for it;
- `catalog.json` carries a relation for it.

A model found in none of those is still emitted, as a **ghost** with no columns —
the design references something the dbt project does not have. A model dbt has
**disabled** lands in the manifest's `disabled` section and `ref()` to it fails,
so a bare source file does not make it exist; with no other evidence it ghosts
with a "disabled" reason instead. Ghosting means "not in your dbt project", never
"you have not run `dbt compile` lately". Vendored directories (`dbt_packages`,
`dbt_modules`, virtualenvs) are excluded from the file walk.

A model known **only** by the file that defines it is a real node with **zero**
columns — nothing has stated its shape, and seeding it from the logical design
would invent one. Sync comparison skips such a model rather than reporting every
logical column as missing; that suppression is automatic and separate from
`stubColumns`, which is the user's own switch for deliberately partial models.

**Columns** come from two *kinds* of source:

| | Source | Role |
|---|--------|------|
| Declared | schema `.yml` when present, otherwise the manifest's copy of it | One source — the manifest's column list is a compiled copy of the same yml patch, so where they disagree the manifest is merely stale. |
| Observed | `catalog.json` | An independent look at the warehouse relation, so where it disagrees with the yml that is information. |

When a catalog relation resolves, the rendered list is their **union**: catalog
order first, then any declared column the catalog has not seen. With no catalog it
is the declared list alone. A column present in both keeps the **declared**
spelling — Snowflake reports UPPERCASE column keys and they never win the label.

The catalog is only as fresh as the last `dbt docs generate`, which is exactly why
it never *replaces* the declared list: a column added to the SQL and the yml an
hour ago would otherwise vanish from physical and be proposed for deletion by a
sync plan. The union's opposite cost is milder — a yml documenting a column the
warehouse does not have renders a physical column nothing has verified.

**Per-column fields.**

| Field | Precedence |
|-------|-----------|
| `dataType` | `catalog.json` → declared `data_type:` → the manifest's copy of it → blank |
| `description` | `.yml` description → manifest description → catalog column `comment` (`persist_docs` writes the dbt description *into* that comment, so it ranks last) |
| PK/FK/NK, `scdType`, `additiveType` | Carried forward from the logical model — dbt yml does not carry them |

A column typed on only one stage is reported as **`undeclared`**, not as a type
mismatch; writing `data_type:` into the schema yml, or running
`dbt docs generate`, is what fills it in.

**Model-level fields.** `schema` is the manifest's `schema`, then the catalog's
`metadata.schema`, then blank — it cannot be derived from the filesystem (it needs
`generate_schema_name` and `profiles.yml`), so with neither artifact the node badge
falls back to the ERD **layer** abbreviation and says so. Every real physical model
also carries **provenance**: which sources contributed its columns, and which one
supplied its types. That is runtime state shown on the node and in the detail
panel; it is never written to disk.

**Relationships** are derived from **dbt relationship tests** — the union of those
declared in `.yml` files and those in the manifest, deduped, never copied from
logical. Cardinality comes from `unique` / `dbt_utils.unique_combination_of_columns`
tests merged from the same two sources (no `unique` test = "many" side). Only
relationships between models **within the same domain** appear. `catalog.json`
holds no constraint or foreign-key information, so it contributes no edges.

## Validation Rules

1. `schemaVersion` must be `5`. Versions below 4 and top-level `models` arrays are rejected; version 4 is accepted only until migrated.
2. `layer` must match an `id` in `layers.json`.
3. Every entry in `logical.models` must be a string. Mixed string/object arrays are rejected.
4. Each referenced model should have a `logical-models/{name}.yml` or `logical-models/{folder}/{name}.yml`; a missing file renders as a placeholder with a warning.
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

File: `.erd-studio/logical-models/silver/fct_order_line.yml`

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
