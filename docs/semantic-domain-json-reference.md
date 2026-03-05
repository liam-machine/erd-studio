# Semantic Domain JSON Reference

> Context document for AI agents building semantic domain JSON files for the dbt Semantic Designer VS Code extension.

## File Layout

```
erd-studio/
  layers.json                          # Layer configuration (medallion architecture)
  templates/
    dimension.json                     # Model templates (optional, preset column patterns)
    fact.json
  {layer}/
    {domain}.json                      # Semantic domain files (one per business domain)
```

## Domain File (`erd-studio/{layer}/{domain}.json`)

### Top-Level Schema

```jsonc
{
  "schemaVersion": 1,            // REQUIRED. Must be 1.
  "domain": "work-lot",          // Optional. Defaults to filename without .json.
  "layer": "silver",             // REQUIRED. Must match a layer ID from layers.json.
  "description": "Work lot domain",  // Optional. Defaults to "".
  "modelFolder": "models/silver",    // Optional. Filters "Add Existing Model" dialog.
  "models": [],                  // REQUIRED. Array of SemanticModel objects.
  "relationships": [],           // REQUIRED. Array of Relationship objects.
  "viewConfig": {}               // REQUIRED. UI state (positions, layout options).
}
```

### Models

Two model types exist based on `source`:

#### Built Model (`source: "built"`)

References an existing dbt model. Columns come from the compiled manifest at runtime.

```jsonc
{
  "name": "dim_work_lot",         // REQUIRED. Must match dbt model name.
  "source": "built",              // REQUIRED.
  "primaryKey": "work_lot_id",    // Optional. Designates PK column.
  "grain": "One row per work lot",   // Optional. Grain statement.
  "modelRole": "domain-dim",         // Optional. Model role enum.
  "approved": false,              // Optional. Default false.
  "plannedColumns": [             // Optional. Overlay columns not yet in manifest.
    {
      "name": "project_id",
      "isPrimaryKey": false,
      "isForeignKey": true
    }
  ],
  "designedColumns": ["work_lot_id", "project_id"],  // Optional. Tracks original design columns after design→built transition.
  "rationale": {                  // Optional. Design rationale.
    "purpose": "Central work lot dimension tracking lifecycle states",
    "roleChoice": "Domain-specific dimension not shared outside this domain"
  }
}
```

**plannedColumns** are displayed as orange "planned" rows. When a planned column appears in manifest, the manifest version takes precedence (overlay semantics).

#### Design Model (`source: "design"`)

A planned model not yet in dbt. Columns are defined inline.

```jsonc
{
  "name": "dim_customer",         // REQUIRED.
  "source": "design",             // REQUIRED.
  "schema": "silver",             // REQUIRED for design models.
  "description": "Customer master data",  // REQUIRED for design models.
  "grain": "One row per customer",        // Optional. Grain statement.
  "modelRole": "conformed-dim",           // Optional. Model role enum.
  "approved": false,              // Optional. Default false.
  "columns": [                    // REQUIRED for design models.
    {
      "name": "customer_id",
      "dataType": "INTEGER",
      "description": "Surrogate key",
      "isPrimaryKey": true,
      "scdType": 0
    },
    {
      "name": "email",
      "dataType": "STRING",
      "description": "Customer email address",
      "isNaturalKey": true,
      "scdType": 1
    }
  ],
  "rationale": {
    "purpose": "Customer master data for joins across sales and support domains",
    "design": "Conformed dimension to enable cross-domain analysis",
    "grainChoice": "One row per customer — no history versioning at this stage",
    "scdStrategy": "SCD1 overwrites for most attributes; email is natural key"
  }
}
```

### Model Metadata Fields

| Field | Type | Description |
|-------|------|-------------|
| `grain` | string | Grain statement — "One row per ___". The most critical design decision. |
| `modelRole` | enum | Model's role in the data warehouse architecture. See enum below. |
| `rationale` | object | Design rationale explaining architectural decisions. See section below. |

#### `modelRole` Enum

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

#### Design Rationale (`rationale`)

Optional object documenting the reasoning behind a model's design. All fields are optional — populate only where you have clear reasoning, leave blank if unsure.

| Field | Description |
|-------|-------------|
| `purpose` | What requirements or purpose this model fulfils |
| `design` | Why the model was designed this way — trade-offs, constraints, patterns |
| `roleChoice` | Why this model role was selected |
| `grainChoice` | Why this grain was chosen over alternatives |
| `scdStrategy` | Overall SCD strategy across dimension attributes |
| `measures` | Why measures are structured this way — additive type choices |

If all fields are empty, omit the `rationale` key entirely. The extension displays an "R" badge on models that have rationale.

### Column Definition (ColumnDef)

Used in design model `columns` array and in built model `plannedColumns`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Column identifier |
| `dataType` | string | Yes (design) | SQL type: `STRING`, `INTEGER`, `BOOLEAN`, `DATE`, `DECIMAL(18,2)`, `TIMESTAMP_NTZ`, `VARCHAR`, etc. |
| `description` | string | Yes (design) | Human-readable description |
| `isPrimaryKey` | boolean | No | Marks as primary key. Default `false`. |
| `isForeignKey` | boolean | No | FK intent flag. Default `false`. |
| `isNaturalKey` | boolean | No | Business identifier (email, SKU). Default `false`. |
| `approved` | boolean | No | Approved for build. Default `false`. |
| `scdType` | `0`, `1`, `2` | No | SCD type for dimension columns: 0=never changes, 1=overwrite, 2=track history. |
| `additiveType` | string | No | Fact measure columns: `"additive"`, `"semi-additive"`, or `"non-additive"`. |
| `expectedDataType` | string | No | Design-time type for discrepancy detection (built models only). |
| `rejected` | boolean | No | Datatype discrepancy explicitly rejected. |
| `structuralRejected` | boolean | No | Extra-column discrepancy explicitly rejected. |

**For plannedColumns on built models:** `dataType` and `description` are optional (only needed for genuinely new planned columns, not for PK/FK annotations on existing manifest columns).

**When generating models:** populate `scdType` on dimension columns and `additiveType` on fact measures if you can confidently determine them. Leave blank if unsure.

### Relationships

FK relationships between models in the domain.

```jsonc
{
  "fromModel": "fct_work_lot_lifecycle",  // REQUIRED. Model containing the FK.
  "fromColumn": "work_lot_id",            // REQUIRED. FK column name.
  "toModel": "dim_work_lot",              // REQUIRED. Referenced model (PK side).
  "toColumn": "work_lot_id",              // REQUIRED. Referenced PK column.
  "cardinality": "many-to-one",           // REQUIRED. See enum below.
  "source": "design",                     // Optional. Set to "design" for new relationships.
  "approved": false                       // Optional. Default false.
}
```

**Cardinality enum:** `"many-to-one"` | `"one-to-one"` | `"one-to-many"` | `"many-to-many"`

**Identity key:** The composite `(fromModel, fromColumn, toModel, toColumn)` must be unique.

**Direction convention:** `fromModel` holds the FK, `toModel` holds the PK. For `many-to-one`, the "many" side is `fromModel`.

### View Config

Persisted UI layout state. Safe to omit or leave empty — the extension will auto-layout.

```jsonc
{
  "showFkEdges": true,
  "layoutOptions": {
    "elk.algorithm": "mrtree",
    "elk.direction": "DOWN"
  },
  "positions": {
    "dim_work_lot": { "x": 1242, "y": 2983 },
    "fct_work_lot_lifecycle": { "x": 672, "y": 12 }
  }
}
```

When generating new domains, omit `positions` — the extension auto-layouts on first open.

## Layers File (`erd-studio/layers.json`)

```jsonc
{
  "schemaVersion": 1,
  "layers": [
    {
      "id": "silver",           // REQUIRED. Lowercase, alphanumeric + hyphens/underscores.
      "label": "Silver",        // Display name.
      "abbreviation": "SLV",    // 3-letter compact display.
      "color": "#a0a0a0",       // Hex color.
      "creatable": true,        // Whether new domains can be created in this layer.
      "order": 0                // Display order (lower = first).
    },
    {
      "id": "gold",
      "label": "Gold",
      "abbreviation": "GLD",
      "color": "#d4a800",
      "creatable": true,
      "order": 1
    }
  ]
}
```

**Defaults if missing:** Silver (`#a0a0a0`, order 1) and Gold (`#d4a800`, order 2).

**Known layers with defaults:** `bronze` (`#cd7f32`, creatable: false), `silver`, `gold`.

## Model Templates (`erd-studio/templates/{id}.json`)

Templates provide preset columns when creating new models.

```jsonc
{
  "id": "dimension",
  "label": "Dimension",
  "prefix": "dim_",
  "description": "Standard dimension table with SCD Type 1 tracking",
  "requiresLeftEntity": false,
  "requiresRightEntity": false,
  "columns": [
    { "name": "{name}_id", "dataType": "INTEGER", "description": "Surrogate key", "isPrimaryKey": true },
    { "name": "name", "dataType": "VARCHAR", "description": "Display name" },
    { "name": "is_active", "dataType": "BOOLEAN", "description": "Active flag" },
    { "name": "dwh_inserted_at", "dataType": "TIMESTAMP_NTZ", "description": "Warehouse insert timestamp" },
    { "name": "dwh_updated_at", "dataType": "TIMESTAMP_NTZ", "description": "Warehouse update timestamp" }
  ]
}
```

**Placeholder syntax:** `{name}` = model name minus prefix (e.g., `"customer"` from `"dim_customer"`). Bridge templates also support `{left}` and `{right}`.

**Common prefixes:** `dim_` (dimension), `fct_` (fact), `brg_` (bridge), `ref_` (reference).

## Naming Conventions

| Pattern | Prefix | Example | Use Case |
|---------|--------|---------|----------|
| Dimension | `dim_` | `dim_project`, `dim_work_lot` | Entity/master data tables |
| Fact | `fct_` | `fct_work_lot_lifecycle` | Transactional/event tables |
| Bridge | `brg_` | `brg_project_contact` | Many-to-many junction tables |
| Reference | `ref_` | `ref_country`, `ref_region` | Lookup/reference tables |
| No prefix | — | `work_lot_action_tag` | Domain-specific tables |

**PK naming:** `{entity}_id` (e.g., `work_lot_id`, `project_id`).

**FK naming:** Matches the PK name of the referenced table (e.g., `work_lot_id` FK references `dim_work_lot.work_lot_id`).

## Validation Rules

1. `schemaVersion` must be `1`
2. `layer` must match an `id` in `layers.json`
3. Model `name` must be unique within the domain
4. Design models require `schema`, `description`, and `columns`
5. Relationship identity `(fromModel, fromColumn, toModel, toColumn)` must be unique
6. Both `fromModel` and `toModel` in a relationship must exist in the `models` array
7. Relationship approval requires both connected models to be `built` or `approved`
8. Unapproving a model cascades: unapproves all its columns and connected relationships

## Complete Example

A minimal but realistic domain with built and design models:

```json
{
  "schemaVersion": 1,
  "domain": "sales",
  "layer": "silver",
  "description": "Sales domain covering orders and customers",
  "modelFolder": "models/silver",
  "models": [
    {
      "name": "dim_customer",
      "source": "design",
      "schema": "silver",
      "description": "Customer master data",
      "grain": "One row per customer",
      "modelRole": "conformed-dim",
      "columns": [
        { "name": "customer_id", "dataType": "INTEGER", "description": "Surrogate key", "isPrimaryKey": true, "scdType": 0 },
        { "name": "customer_code", "dataType": "STRING", "description": "Business identifier", "isNaturalKey": true, "scdType": 1 },
        { "name": "name", "dataType": "STRING", "description": "Customer name", "scdType": 1 },
        { "name": "email", "dataType": "STRING", "description": "Email address", "scdType": 1 },
        { "name": "is_active", "dataType": "BOOLEAN", "description": "Active flag", "scdType": 1 },
        { "name": "dwh_inserted_at", "dataType": "TIMESTAMP_NTZ", "description": "Warehouse insert timestamp" },
        { "name": "dwh_updated_at", "dataType": "TIMESTAMP_NTZ", "description": "Warehouse update timestamp" }
      ],
      "rationale": {
        "purpose": "Customer master data for joins across sales and support domains",
        "design": "Conformed dimension to enable cross-domain analysis",
        "roleChoice": "Conformed dimension because customer data is shared across sales, support, and marketing domains",
        "grainChoice": "One row per customer — no SCD2 history needed at this stage"
      }
    },
    {
      "name": "dim_product",
      "source": "built",
      "grain": "One row per product",
      "modelRole": "domain-dim",
      "plannedColumns": [
        { "name": "product_id", "isPrimaryKey": true },
        { "name": "category_id", "isForeignKey": true }
      ]
    },
    {
      "name": "fct_order",
      "source": "built",
      "grain": "One row per order line item",
      "modelRole": "transaction-fact",
      "plannedColumns": [
        { "name": "order_id", "isPrimaryKey": true },
        { "name": "customer_id", "isForeignKey": true },
        { "name": "product_id", "isForeignKey": true },
        { "name": "project_id", "isForeignKey": true }
      ],
      "rationale": {
        "purpose": "Core order fact for revenue analysis",
        "grainChoice": "Line item grain to preserve quantity and amount detail per product",
        "measures": "amount is fully additive; quantity is additive"
      }
    }
  ],
  "relationships": [
    {
      "fromModel": "fct_order",
      "fromColumn": "customer_id",
      "toModel": "dim_customer",
      "toColumn": "customer_id",
      "cardinality": "many-to-one",
      "source": "design"
    },
    {
      "fromModel": "fct_order",
      "fromColumn": "product_id",
      "toModel": "dim_product",
      "toColumn": "product_id",
      "cardinality": "many-to-one"
    }
  ],
  "viewConfig": {}
}
```
