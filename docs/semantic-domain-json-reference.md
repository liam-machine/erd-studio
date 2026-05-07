# Semantic Domain JSON Reference

> Context document for AI agents generating semantic domain JSON files for the ERD Studio VS Code extension.

## File Layout

Domain files are organized by stage and layer under the `erd-studio/` directory:

```
erd-studio/
  conceptual/
    {layer}/
      {domain}.json
  logical/
    {layer}/
      {domain}.json
  layers.json
  templates/
    dimension.json
    fact.json
```

There are three stages: **conceptual**, **logical**, and **physical**. Conceptual and logical have persisted JSON files. Physical has no files -- it is derived at runtime by merging the logical domain with the dbt manifest.

## Domain File (`erd-studio/{stage}/{layer}/{domain}.json`)

### Top-Level Schema

```jsonc
{
  "schemaVersion": 2,              // REQUIRED. Must be 2.
  "domain": "orders",              // Optional. Defaults to filename without .json.
  "layer": "silver",               // REQUIRED. Must match a layer ID from layers.json.
  "stage": "conceptual",           // REQUIRED. "conceptual" or "logical".
  "description": "Orders domain",  // Optional. Defaults to "".
  "modelFolder": "models/silver",  // Optional. Filters "Add Existing Model" dialog.
  "models": [],                    // REQUIRED. Array of SemanticModel objects.
  "relationships": [],             // REQUIRED. Array of Relationship objects.
  "viewConfig": {}                 // REQUIRED. UI state (positions, layout options).
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | number | Yes | Must be `2`. |
| `domain` | string | No | Domain slug. Defaults to filename without `.json`. |
| `layer` | string | Yes | Must match an `id` in `layers.json`. |
| `stage` | string | Yes | `"conceptual"` or `"logical"`. Physical is never stored on disk. |
| `description` | string | No | Human-readable domain description. |
| `modelFolder` | string | No | Path prefix filter for the "Add Existing Model" dialog (e.g., `"models/silver"`). |
| `models` | array | Yes | Array of `SemanticModel` objects. |
| `relationships` | array | Yes | Array of `Relationship` objects. |
| `viewConfig` | object | Yes | Persisted UI layout state. |

### Models (SemanticModel)

Models are simple data containers. There is no `source` field -- the stage is determined by which directory the file lives in, not by a property on the model.

```jsonc
{
  "name": "dim_customer",              // REQUIRED. Model name.
  "schema": "silver",                  // Optional. Schema the model materialises in.
  "description": "Customer master",    // Optional.
  "columns": [],                       // Optional. Array of ColumnDef.
  "rationale": {},                     // Optional. Design reasoning object.
  "grain": "One row per customer",     // Optional. Grain statement.
  "modelRole": "conformed-dim"         // Optional. See ModelRole enum.
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Model identifier. Must be unique within the domain. |
| `schema` | string | No | Target schema name. |
| `description` | string | No | Human-readable description. |
| `columns` | array | No | Array of `ColumnDef`. Conceptual models can omit this entirely. |
| `rationale` | object | No | Design rationale. See Rationale section. |
| `grain` | string | No | Grain statement: "One row per ___". |
| `modelRole` | string | No | Role in the warehouse architecture. See ModelRole enum. |

The following fields from schema version 1 no longer exist: `source`, `approved`, `primaryKey`, `plannedColumns`, `designedColumns`.

### Column Definition (ColumnDef)

```jsonc
{
  "name": "customer_id",
  "dataType": "INTEGER",
  "description": "Surrogate key",
  "isPrimaryKey": true,
  "isForeignKey": false,
  "isNaturalKey": false,
  "scdType": 0,
  "additiveType": "additive"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Column identifier. |
| `dataType` | string | Yes | SQL data type: `STRING`, `INTEGER`, `BOOLEAN`, `DATE`, `DECIMAL(18,2)`, `TIMESTAMP_NTZ`, `VARCHAR`, etc. Use `""` for conceptual stage when type is unknown. |
| `description` | string | Yes | Human-readable column description. |
| `isPrimaryKey` | boolean | No | Primary key flag. Default `false`. |
| `isForeignKey` | boolean | No | Foreign key intent flag. Default `false`. |
| `isNaturalKey` | boolean | No | Business identifier (email, SKU, customer_code). Default `false`. |
| `scdType` | `0` \| `1` \| `2` | No | SCD type for dimension columns: 0 = never changes, 1 = overwrite, 2 = track history. |
| `additiveType` | string | No | Fact measure columns: `"additive"`, `"semi-additive"`, or `"non-additive"`. |

The following fields from schema version 1 no longer exist: `approved`, `expectedDataType`, `rejected`, `structuralRejected`.

### Relationships

FK relationships between models in the domain.

```jsonc
{
  "fromModel": "fct_orders",
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
| `cardinality` | string | Yes | One of: `"many-to-one"`, `"one-to-one"`, `"one-to-many"`, `"many-to-many"`. |

**Identity key:** The composite `(fromModel, fromColumn, toModel, toColumn)` must be unique within the domain.

**Direction convention:** `fromModel` holds the FK, `toModel` holds the PK. For `many-to-one`, the "many" side is always `fromModel`.

The following fields from schema version 1 no longer exist: `source`, `approved`.

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

Optional object documenting the reasoning behind a model's design. All fields are optional strings. Populate only where you have clear reasoning; leave blank or omit if unsure. If all fields would be empty, omit `rationale` entirely. The extension displays an "R" badge on models that have rationale.

| Field | Description |
|-------|-------------|
| `purpose` | What requirements or purpose this model fulfils |
| `design` | Why the model was designed this way -- trade-offs, constraints, patterns |
| `roleChoice` | Why this model role was selected |
| `grainChoice` | Why this grain was chosen over alternatives |
| `scdStrategy` | Overall SCD strategy across dimension attributes |
| `measures` | Why measures are structured this way -- additive type choices |

### View Config

Persisted UI layout state. Safe to omit inner fields or leave as an empty object -- the extension will auto-layout on first open.

```jsonc
{
  "showFkEdges": true,
  "layoutOptions": {
    "elk.algorithm": "mrtree",
    "elk.direction": "DOWN"
  },
  "positions": {
    "dim_customer": { "x": 100, "y": 200 },
    "fct_orders": { "x": 400, "y": 50 }
  }
}
```

When generating new domains, omit `positions` -- the extension auto-layouts on first open.

## Stage-Specific Guidelines

### Conceptual Stage

Conceptual domains capture high-level entity design. Files live at `erd-studio/conceptual/{layer}/{domain}.json`.

- Models can omit `columns` entirely (entity-level modelling only).
- When columns are present, `dataType` can be `""` if the type is not yet decided.
- Focus on entity names, descriptions, grain, model roles, and relationships.
- Rationale is especially valuable at this stage to capture design intent.

### Logical Stage

Logical domains capture detailed column-level design. Files live at `erd-studio/logical/{layer}/{domain}.json`.

- Models should have full `columns` arrays with `dataType` and `description` populated.
- FK relationships should specify concrete column references.
- PK, FK, and NK flags should be set accurately on columns.
- `scdType` should be set on dimension columns and `additiveType` on fact measures where applicable.

### Physical Stage

Physical has no files. It is derived at runtime by merging the logical domain with the dbt manifest. Do not create files for the physical stage.

## Layers File (`erd-studio/layers.json`)

Defines the medallion architecture layers available in the project.

```jsonc
{
  "schemaVersion": 1,
  "layers": [
    {
      "id": "silver",
      "label": "Silver",
      "abbreviation": "SLV",
      "color": "#a0a0a0",
      "creatable": true,
      "order": 1
    },
    {
      "id": "gold",
      "label": "Gold",
      "abbreviation": "GLD",
      "color": "#d4a800",
      "creatable": true,
      "order": 2
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Lowercase identifier. Alphanumeric, hyphens, and underscores. |
| `label` | string | Yes | Display name in the UI. |
| `abbreviation` | string | Yes | 3-letter compact display label. |
| `color` | string | Yes | Hex color code (e.g., `"#a0a0a0"`). |
| `creatable` | boolean | Yes | Whether new domains can be created in this layer. |
| `order` | number | Yes | Display order (lower numbers appear first). |

**Defaults if `layers.json` is missing:** Silver (`#a0a0a0`, order 1) and Gold (`#d4a800`, order 2).

**Known layer defaults:** `bronze` (`#cd7f32`, creatable: false), `silver` (`#a0a0a0`, creatable: true), `gold` (`#d4a800`, creatable: true).

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

**Placeholder syntax:** `{name}` is replaced with the model name minus its prefix (e.g., `"customer"` from `"dim_customer"`). Bridge templates also support `{left}` and `{right}` for the two joined entities.

**Common prefixes:** `dim_` (dimension), `fct_` (fact), `brg_` (bridge), `ref_` (reference).

## Naming Conventions

| Pattern | Prefix | Example | Use Case |
|---------|--------|---------|----------|
| Dimension | `dim_` | `dim_customer`, `dim_product` | Entity/master data tables |
| Fact | `fct_` | `fct_order_line`, `fct_payment` | Transactional/event tables |
| Bridge | `brg_` | `brg_order_product` | Many-to-many junction tables |
| Reference | `ref_` | `ref_country`, `ref_currency` | Lookup/reference tables |
| No prefix | -- | `customer_segment` | Domain-specific tables |

**PK naming:** `{entity}_id` (e.g., `customer_id`, `product_id`).

**FK naming:** Matches the PK name of the referenced table (e.g., `customer_id` FK on `fct_order_line` references `dim_customer.customer_id`).

## Validation Rules

1. `schemaVersion` must be `2`.
2. `layer` must match an `id` in `layers.json`.
3. `stage` must be `"conceptual"` or `"logical"`. Physical is derived at runtime, never stored.
4. Model `name` must be unique within the domain.
5. Relationship identity `(fromModel, fromColumn, toModel, toColumn)` must be unique.
6. Both `fromModel` and `toModel` in a relationship must exist in the `models` array.

## Complete Examples

### Conceptual Stage -- Sales Domain

A conceptual domain focuses on entities, relationships, and design intent. Columns are optional or minimal.

File path: `erd-studio/conceptual/silver/sales.json`

```json
{
  "schemaVersion": 2,
  "domain": "sales",
  "layer": "silver",
  "stage": "conceptual",
  "description": "Sales domain covering customers, products, and order transactions",
  "models": [
    {
      "name": "dim_customer",
      "description": "Customer master data for all sales channels",
      "grain": "One row per customer",
      "modelRole": "conformed-dim",
      "rationale": {
        "purpose": "Central customer entity shared across sales, marketing, and support domains",
        "roleChoice": "Conformed dimension because customer data is referenced by multiple business areas",
        "grainChoice": "One row per customer with SCD1 overwrites — no requirement for historical versioning at this stage"
      }
    },
    {
      "name": "dim_product",
      "description": "Product catalogue with category hierarchy",
      "grain": "One row per product SKU",
      "modelRole": "domain-dim",
      "rationale": {
        "purpose": "Product attributes for order analysis and category reporting",
        "roleChoice": "Domain-specific dimension used only within the sales domain"
      }
    },
    {
      "name": "dim_store",
      "description": "Retail store locations and attributes",
      "grain": "One row per store",
      "modelRole": "domain-dim",
      "rationale": {
        "purpose": "Store dimension for geographic and channel analysis"
      }
    },
    {
      "name": "fct_order_line",
      "description": "Order line items capturing each product sold in a transaction",
      "grain": "One row per order line item",
      "modelRole": "transaction-fact",
      "rationale": {
        "purpose": "Core transactional fact for revenue, volume, and margin analysis",
        "grainChoice": "Line item grain preserves quantity and amount detail per product within each order",
        "measures": "Revenue and quantity are fully additive; discount percentage is non-additive"
      }
    },
    {
      "name": "fct_daily_sales_snapshot",
      "description": "Daily aggregated sales metrics per store",
      "grain": "One row per store per day",
      "modelRole": "periodic-snapshot",
      "rationale": {
        "purpose": "Pre-aggregated daily metrics for store performance dashboards",
        "grainChoice": "Daily grain balances query performance with granularity — hourly was deemed unnecessary"
      }
    }
  ],
  "relationships": [
    {
      "fromModel": "fct_order_line",
      "fromColumn": "customer_id",
      "toModel": "dim_customer",
      "toColumn": "customer_id",
      "cardinality": "many-to-one"
    },
    {
      "fromModel": "fct_order_line",
      "fromColumn": "product_id",
      "toModel": "dim_product",
      "toColumn": "product_id",
      "cardinality": "many-to-one"
    },
    {
      "fromModel": "fct_order_line",
      "fromColumn": "store_id",
      "toModel": "dim_store",
      "toColumn": "store_id",
      "cardinality": "many-to-one"
    },
    {
      "fromModel": "fct_daily_sales_snapshot",
      "fromColumn": "store_id",
      "toModel": "dim_store",
      "toColumn": "store_id",
      "cardinality": "many-to-one"
    }
  ],
  "viewConfig": {}
}
```

### Logical Stage -- Sales Domain

The same sales domain at the logical stage with full column definitions, data types, and metadata flags.

File path: `erd-studio/logical/silver/sales.json`

```json
{
  "schemaVersion": 2,
  "domain": "sales",
  "layer": "silver",
  "stage": "logical",
  "description": "Sales domain covering customers, products, and order transactions",
  "modelFolder": "models/silver",
  "models": [
    {
      "name": "dim_customer",
      "schema": "silver",
      "description": "Customer master data for all sales channels",
      "grain": "One row per customer",
      "modelRole": "conformed-dim",
      "columns": [
        { "name": "customer_id", "dataType": "INTEGER", "description": "Surrogate key", "isPrimaryKey": true, "scdType": 0 },
        { "name": "customer_code", "dataType": "STRING", "description": "Business identifier from source system", "isNaturalKey": true, "scdType": 0 },
        { "name": "first_name", "dataType": "STRING", "description": "Customer first name", "scdType": 1 },
        { "name": "last_name", "dataType": "STRING", "description": "Customer last name", "scdType": 1 },
        { "name": "email", "dataType": "STRING", "description": "Primary email address", "scdType": 1 },
        { "name": "phone", "dataType": "STRING", "description": "Primary phone number", "scdType": 1 },
        { "name": "customer_segment", "dataType": "STRING", "description": "Assigned market segment (retail, wholesale, online)", "scdType": 1 },
        { "name": "is_active", "dataType": "BOOLEAN", "description": "Active customer flag", "scdType": 1 },
        { "name": "dwh_inserted_at", "dataType": "TIMESTAMP_NTZ", "description": "Warehouse insert timestamp" },
        { "name": "dwh_updated_at", "dataType": "TIMESTAMP_NTZ", "description": "Warehouse update timestamp" }
      ],
      "rationale": {
        "purpose": "Central customer entity shared across sales, marketing, and support domains",
        "roleChoice": "Conformed dimension because customer data is referenced by multiple business areas",
        "grainChoice": "One row per customer with SCD1 overwrites — no requirement for historical versioning at this stage",
        "scdStrategy": "SCD1 for all mutable attributes. customer_code and customer_id never change (SCD0). If history tracking is needed later, email and segment are candidates for SCD2."
      }
    },
    {
      "name": "dim_product",
      "schema": "silver",
      "description": "Product catalogue with category hierarchy",
      "grain": "One row per product SKU",
      "modelRole": "domain-dim",
      "columns": [
        { "name": "product_id", "dataType": "INTEGER", "description": "Surrogate key", "isPrimaryKey": true, "scdType": 0 },
        { "name": "sku", "dataType": "STRING", "description": "Stock-keeping unit code", "isNaturalKey": true, "scdType": 0 },
        { "name": "product_name", "dataType": "STRING", "description": "Product display name", "scdType": 1 },
        { "name": "category", "dataType": "STRING", "description": "Top-level product category", "scdType": 1 },
        { "name": "subcategory", "dataType": "STRING", "description": "Product subcategory", "scdType": 1 },
        { "name": "unit_cost", "dataType": "DECIMAL(18,2)", "description": "Standard unit cost", "scdType": 1 },
        { "name": "unit_price", "dataType": "DECIMAL(18,2)", "description": "Current list price", "scdType": 1 },
        { "name": "is_active", "dataType": "BOOLEAN", "description": "Currently available for sale", "scdType": 1 },
        { "name": "dwh_inserted_at", "dataType": "TIMESTAMP_NTZ", "description": "Warehouse insert timestamp" },
        { "name": "dwh_updated_at", "dataType": "TIMESTAMP_NTZ", "description": "Warehouse update timestamp" }
      ],
      "rationale": {
        "purpose": "Product attributes for order analysis and category reporting",
        "roleChoice": "Domain-specific dimension used only within the sales domain"
      }
    },
    {
      "name": "dim_store",
      "schema": "silver",
      "description": "Retail store locations and attributes",
      "grain": "One row per store",
      "modelRole": "domain-dim",
      "columns": [
        { "name": "store_id", "dataType": "INTEGER", "description": "Surrogate key", "isPrimaryKey": true, "scdType": 0 },
        { "name": "store_code", "dataType": "STRING", "description": "Source system store identifier", "isNaturalKey": true, "scdType": 0 },
        { "name": "store_name", "dataType": "STRING", "description": "Store display name", "scdType": 1 },
        { "name": "city", "dataType": "STRING", "description": "City", "scdType": 1 },
        { "name": "state", "dataType": "STRING", "description": "State or province", "scdType": 1 },
        { "name": "country", "dataType": "STRING", "description": "Country code (ISO 3166-1 alpha-2)", "scdType": 1 },
        { "name": "channel", "dataType": "STRING", "description": "Sales channel (retail, online, wholesale)", "scdType": 1 },
        { "name": "opened_date", "dataType": "DATE", "description": "Date the store opened", "scdType": 0 },
        { "name": "is_active", "dataType": "BOOLEAN", "description": "Currently operating", "scdType": 1 },
        { "name": "dwh_inserted_at", "dataType": "TIMESTAMP_NTZ", "description": "Warehouse insert timestamp" },
        { "name": "dwh_updated_at", "dataType": "TIMESTAMP_NTZ", "description": "Warehouse update timestamp" }
      ],
      "rationale": {
        "purpose": "Store dimension for geographic and channel analysis"
      }
    },
    {
      "name": "fct_order_line",
      "schema": "silver",
      "description": "Order line items capturing each product sold in a transaction",
      "grain": "One row per order line item",
      "modelRole": "transaction-fact",
      "columns": [
        { "name": "order_line_id", "dataType": "INTEGER", "description": "Surrogate key for the order line", "isPrimaryKey": true },
        { "name": "order_id", "dataType": "INTEGER", "description": "Parent order identifier" },
        { "name": "customer_id", "dataType": "INTEGER", "description": "FK to dim_customer", "isForeignKey": true },
        { "name": "product_id", "dataType": "INTEGER", "description": "FK to dim_product", "isForeignKey": true },
        { "name": "store_id", "dataType": "INTEGER", "description": "FK to dim_store", "isForeignKey": true },
        { "name": "order_date", "dataType": "DATE", "description": "Date the order was placed" },
        { "name": "quantity", "dataType": "INTEGER", "description": "Units ordered", "additiveType": "additive" },
        { "name": "unit_price", "dataType": "DECIMAL(18,2)", "description": "Price per unit at time of sale", "additiveType": "non-additive" },
        { "name": "discount_pct", "dataType": "DECIMAL(5,2)", "description": "Line-level discount percentage", "additiveType": "non-additive" },
        { "name": "line_amount", "dataType": "DECIMAL(18,2)", "description": "Net line total (quantity * unit_price * (1 - discount_pct))", "additiveType": "additive" },
        { "name": "dwh_inserted_at", "dataType": "TIMESTAMP_NTZ", "description": "Warehouse insert timestamp" }
      ],
      "rationale": {
        "purpose": "Core transactional fact for revenue, volume, and margin analysis",
        "grainChoice": "Line item grain preserves quantity and amount detail per product within each order",
        "measures": "line_amount and quantity are fully additive across all dimensions. unit_price and discount_pct are non-additive — they must not be summed."
      }
    },
    {
      "name": "fct_daily_sales_snapshot",
      "schema": "silver",
      "description": "Daily aggregated sales metrics per store",
      "grain": "One row per store per day",
      "modelRole": "periodic-snapshot",
      "columns": [
        { "name": "snapshot_id", "dataType": "INTEGER", "description": "Surrogate key", "isPrimaryKey": true },
        { "name": "store_id", "dataType": "INTEGER", "description": "FK to dim_store", "isForeignKey": true },
        { "name": "snapshot_date", "dataType": "DATE", "description": "Snapshot date" },
        { "name": "total_orders", "dataType": "INTEGER", "description": "Number of distinct orders", "additiveType": "additive" },
        { "name": "total_revenue", "dataType": "DECIMAL(18,2)", "description": "Sum of line amounts for the day", "additiveType": "additive" },
        { "name": "total_units", "dataType": "INTEGER", "description": "Sum of units sold", "additiveType": "additive" },
        { "name": "avg_order_value", "dataType": "DECIMAL(18,2)", "description": "Average order value for the day", "additiveType": "non-additive" },
        { "name": "dwh_inserted_at", "dataType": "TIMESTAMP_NTZ", "description": "Warehouse insert timestamp" }
      ],
      "rationale": {
        "purpose": "Pre-aggregated daily metrics for store performance dashboards",
        "grainChoice": "Daily grain balances query performance with granularity — hourly was deemed unnecessary",
        "measures": "total_orders, total_revenue, and total_units are additive. avg_order_value is non-additive and must be recalculated when aggregating across days."
      }
    }
  ],
  "relationships": [
    {
      "fromModel": "fct_order_line",
      "fromColumn": "customer_id",
      "toModel": "dim_customer",
      "toColumn": "customer_id",
      "cardinality": "many-to-one"
    },
    {
      "fromModel": "fct_order_line",
      "fromColumn": "product_id",
      "toModel": "dim_product",
      "toColumn": "product_id",
      "cardinality": "many-to-one"
    },
    {
      "fromModel": "fct_order_line",
      "fromColumn": "store_id",
      "toModel": "dim_store",
      "toColumn": "store_id",
      "cardinality": "many-to-one"
    },
    {
      "fromModel": "fct_daily_sales_snapshot",
      "fromColumn": "store_id",
      "toModel": "dim_store",
      "toColumn": "store_id",
      "cardinality": "many-to-one"
    }
  ],
  "viewConfig": {}
}
```
