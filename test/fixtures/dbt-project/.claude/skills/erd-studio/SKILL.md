---
name: erd-studio
description: Data modeling guide for ERD Studio — covers logical domain JSON format, dbt YAML tests for physical model relationships and cardinality, naming conventions, and design workflow. Use when creating, editing, or validating data models or dbt schema files.
---

# ERD Studio — AI Data Modeling Guide

Design data warehouse models across two stages: logical → physical. This guide covers the domain JSON format and how to write dbt YAML that produces a correct physical model.

## Quick Reference

**File:** `erd-studio/{layer}/{domain}.json` — one file per domain containing the `logical` section.

```json
{
  "schemaVersion": 4,
  "domain": "{domain}",
  "layer": "silver",
  "description": "Domain description",
  "modelFolder": "models/silver",
  "logical": { "models": [], "relationships": [] },
  "viewConfig": {}
}
```

Required fields: `schemaVersion`, `domain`, `layer`, `logical`, `viewConfig`.

**viewConfig** lives at the root level and applies to all stages. Leave empty for new domains — the extension auto-layouts on first open.

```json
"viewConfig": { "positions": { "dim_customer": { "x": 100, "y": 200 } } }
```

---

## Stage 1: Logical Design

The `logical` section is the detailed blueprint. Models should have full columns with data types, PK/FK/NK flags, grain, model role, and rationale.

### Model

```json
{
  "name": "dim_customer",
  "schema": "silver",
  "description": "Customer master data",
  "grain": "One row per customer",
  "modelRole": "conformed-dim",
  "columns": [
    { "name": "customer_id", "dataType": "INTEGER", "description": "Surrogate key", "isPrimaryKey": true, "scdType": 0 },
    { "name": "email", "dataType": "STRING", "description": "Email address", "isNaturalKey": true, "scdType": 1 }
  ],
  "rationale": {
    "purpose": "Customer master data for cross-domain joins",
    "roleChoice": "Conformed dimension shared across domains"
  }
}
```

### Column Definition

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Column identifier |
| `dataType` | string | Logical: Yes | SQL type (STRING, INTEGER, BOOLEAN, DATE, DECIMAL(18,2), TIMESTAMP_NTZ) |
| `description` | string | Logical: Yes | Human-readable description |
| `isPrimaryKey` | boolean | No | Marks as PK. Only include when `true`. |
| `isForeignKey` | boolean | No | FK intent flag. Only include when `true`. |
| `isNaturalKey` | boolean | No | Business identifier. Only include when `true`. |
| `scdType` | `0`, `1`, `2` | No | SCD type for dimension columns |
| `additiveType` | string | No | Fact measures: `"additive"`, `"semi-additive"`, `"non-additive"` |

### Relationships

```json
{
  "fromModel": "fct_orders", "fromColumn": "customer_id",
  "toModel": "dim_customer", "toColumn": "customer_id",
  "cardinality": "many-to-one"
}
```

`fromModel` is the FK side. `toModel` is the PK side.

Cardinality values: `many-to-one` | `one-to-one` | `one-to-many` | `many-to-many`

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

Optional `rationale` object. All fields are optional strings: `purpose`, `design`, `roleChoice`, `grainChoice`, `scdStrategy`, `measures`. Omit entirely if empty.

### Naming Conventions

| Type | Prefix | PK Pattern | Example |
|------|--------|-----------|---------|
| Dimension | `dim_` | `{entity}_id` | `dim_project` → `project_id` |
| Fact | `fct_` | `{entity}_id` or composite | `fct_order` → `order_id` |
| Reference | `ref_` | `ref_{entity}_code` | `ref_country` → `ref_country_code` |
| Bridge | `brg_` | composite FK pair | `brg_project_contact` |

FK columns match the PK name of the referenced table.

---

## Stage 2: Physical Realization via dbt

The physical stage is **read-only** and has **no files on disk**. It is derived entirely from the dbt manifest (`target/manifest.json`) after running `dbt compile` or `dbt build`.

Understanding how the physical stage works is critical for AI-assisted modeling: it tells you what dbt YAML to write so the physical stage matches the logical design.

### How Physical Models Are Derived

1. **Models**: Logical models that also exist in the manifest appear in the physical stage. Columns come from the manifest; PK/FK/NK flags, grain, and model role carry forward from logical.
2. **Relationships**: Derived from **dbt relationship tests** in the manifest — NOT copied from logical. Each `relationships` test in your YAML becomes one edge.
3. **Cardinality**: Derived from **uniqueness tests** in the manifest — dbt's `relationships` test only checks referential integrity, not cardinality.

### Cardinality Rules

| FK column has `unique` test? | PK column has `unique` test? | Derived Cardinality |
|-------------------------------|-------------------------------|---------------------|
| No | Yes | `many-to-one` |
| Yes | Yes | `one-to-one` |
| Yes | No | `one-to-many` |
| No | No | `many-to-many` |

**No `unique` test = "many" side.** This is deliberate — the physical model reflects what is tested, not what is assumed.

### Writing dbt YAML for Correct Physical Relationships

To produce a `many-to-one` relationship from `fct_orders.customer_id` → `dim_customer.customer_id`, write:

```yaml
models:
  - name: dim_customer
    columns:
      - name: customer_id
        tests:
          - unique           # Makes this side "one"
          - not_null

  - name: fct_orders
    columns:
      - name: order_id
        tests:
          - unique
          - not_null
      - name: customer_id
        tests:
          - not_null
          - relationships:   # Creates the edge in the physical model
              to: ref('dim_customer')
              field: customer_id
          # No unique test on FK column → "many" side
```

### Composite Keys

For composite primary keys, use `dbt_utils.unique_combination_of_columns`:

```yaml
models:
  - name: brg_project_contact
    tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns:
            - project_id
            - contact_id
    columns:
      - name: project_id
        tests:
          - relationships:
              to: ref('dim_project')
              field: project_id
      - name: contact_id
        tests:
          - relationships:
              to: ref('dim_contact')
              field: contact_id
```

The composite unique test is recognized when **all** columns in the group are covered by relationship tests between the same model pair.

### Custom Relationship Tests

These test variants are also recognized: `relationships_where` (dbt_utils) and any custom test with the standard kwargs signature (`column_name`, `field`, `to`).

### Domain Scoping

Physical relationships are scoped to models within the current domain. If `dim_customer` is a conformed dimension referenced by many models, only relationships to other models **in the same domain** appear.

---

## Design Workflow

### From Logical to Physical — Checklist

When implementing a logical model in dbt, ensure each logical element has a corresponding dbt test:

| Logical Element | dbt YAML Required |
|----------------|-------------------|
| PK column (`isPrimaryKey: true`) | `unique` + `not_null` tests on that column |
| FK column (`isForeignKey: true`) | `relationships` test pointing to the PK model/column |
| Relationship with cardinality | `relationships` test on FK column + `unique` test on PK column |
| Composite PK | `dbt_utils.unique_combination_of_columns` model-level test |

### Discrepancy Resolution

The discrepancy overlay in ERD Studio compares stages. Common issues when comparing physical to logical:

| Discrepancy | Cause | Fix |
|------------|-------|-----|
| Missing relationship in physical | No `relationships` test in YAML | Add `relationships` test to the FK column |
| Cardinality mismatch (many-to-many vs many-to-one) | PK column missing `unique` test | Add `unique` test to the PK column |
| Missing model in physical | Model not compiled into manifest | Run `dbt compile` or check model is not disabled |
| Extra column in physical | Column in manifest but not in logical | Add the column to the logical model, or remove from dbt model |

<!-- erd-studio-harness: 3 -->
