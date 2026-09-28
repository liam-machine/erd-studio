---
name: erd-studio
description: >-
  Schema rules for ERD Studio data model files — the .erd-studio/ directory
  uses a two-file system (YAML model definitions + JSON domain diagrams)
  with strict format rules you must read before editing. Use this skill
  whenever the task touches files in .erd-studio/ (domain JSON, logical-models
  YAML, or .sync-plan.json), asks to add/edit/remove models, columns,
  relationships, or cardinality in a data model or ERD diagram, mentions
  dim_/fct_/ref_/brg_ prefixed tables in an erd-studio context, or involves
  writing dbt schema YAML tests to match an ERD physical stage. The skill
  tells you which of the two files to edit for each operation — without it
  you will put data in the wrong file.
---

# ERD Studio — AI Data Modeling Guide

ERD Studio uses a **central model store** architecture. Model definitions are YAML files in `.erd-studio/logical-models/` (at the top level, or one folder down in a per-layer folder). Domain JSON files reference models by name and define relationships and layout.

## Architecture Overview

```
.erd-studio/
├── modelling-approach.md     ← Optional: the team's modelling rules (see below)
├── logical-models/           ← Central model definitions (YAML, one per model)
│   ├── dim_project.yml       ← top level (flat libraries keep working)
│   ├── silver/               ← optional per-layer folders
│   │   └── dim_customer.yml
│   └── gold/
│       └── fct_sale.yml
├── silver/
│   ├── customer-360.json     ← Domain file (model references + relationships + layout)
│   └── orders.json
└── gold/
    └── reporting.json
```

**Key principle:** Models are defined ONCE in `logical-models/` and referenced from multiple domain files. Editing a model from any domain updates the shared definition.

### Model file location (layer folders)

- A model file lives at `logical-models/{name}.yml` **or** exactly one folder down at `logical-models/{folder}/{name}.yml`. By convention the folder is a layer id (`bronze`, `silver`, `gold`). Deeper nesting and dot-folders are ignored.
- The folder is organisational only. Domain files reference models **by name**, never by path, and model names are **unique across all folders** (as dbt model names are across a project). Never create a second file with a name that already exists in another folder.
- **The same table name in two layers** (a silver `date` and a gold `date`) is two models with different names and the same `alias`: `logical-models/silver/silver_date.yml` (`alias: date`) and `logical-models/gold/gold_date.yml` (`alias: date`), exactly as a dbt project gets two `date` tables. Name the model `{layer}_{name}` and set `alias` to the table name; never reuse the bare name.
- **To find a model**, look at `logical-models/{name}.yml` first, then in each folder (`logical-models/*/{name}.yml`). If the same name exists twice, the top-level file wins, then folders in alphabetical order; the others are ignored.
- **Folders are opt-in per project.** Check first: if a folder named after a layer in `layers.json` (`logical-models/{layer}/`) already holds a `.yml` file (or `logical-models/` is empty), the project uses layer folders — create a new model in the folder of the layer of the domain you are adding it to (adding `fct_sale` to `gold/reporting.json` creates `logical-models/gold/fct_sale.yml`). If every model file is at the top level, the project is **flat** — create the new file at the top level too, and never start the folder layout on your own (the user opts in with **ERD Studio: Organise Model Library by Layer**). When editing or renaming an existing model, keep its file in the folder it is already in.

### Team Modelling Approach

If `.erd-studio/modelling-approach.md` exists, **read it before creating or editing models and follow it.** It records how this team models data — the technique (e.g. Kimball dimensional modelling, Data Vault 2.0), the user's own words, the concrete rules, and how each rule maps onto ERD Studio fields (`modelRole`, `grain`, `scdType`, `additiveType`, `isNaturalKey`, `rationale`). The `/erd-studio-setup` guide writes it after asking the user; it can also be written or edited by hand. It is free-form markdown: ERD Studio never parses it, and a project without one is valid. When a rule in it conflicts with a user request, say so and ask which wins. If it has a **Target-design backlog** section, the differences between logical and physical listed there are intentional: when a sync plan or diff proposes undoing one, report it as a backlog item and leave it as it is unless the user says otherwise.

### Model Library (Sidebar)

The **Model Library** panel in the ERD Studio sidebar shows all YAML files in `logical-models/`, grouped by folder. Use it to understand the difference between "model definition exists" and "model is referenced by a domain":

- **Referenced models** show how many domains use them (e.g. "2 domains")
- **Orphaned models** show a warning icon and "(unused)" — these exist as `.yml` files but are not in any domain's `logical.models[]` array

**Important for AI agents:** Before saying a model "already exists in the ERD", check whether it is referenced by the target domain's `logical.models[]` array — not just whether the `.yml` file exists. A model file in `logical-models/` may be unused (orphaned) or only referenced by other domains.

## Domain File Structure

**File:** `.erd-studio/{layer}/{domain}.json`

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
| `logical.models` | Yes | Array of model name strings (references to `logical-models/*.yml` or `logical-models/{folder}/*.yml`) |
| `logical.relationships` | Yes | Array of relationship objects |
| `viewConfig` | Yes | Root-level view settings. The extension auto-assigns positions for new models; a new domain written with `viewConfig: {}` (no positions at all) is auto-arranged with the canvas's auto layout the first time it opens |

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
| Add/remove/rename a column | the model's `.yml` (`logical-models/{name}.yml` or `logical-models/{folder}/{name}.yml`) |
| Change column type, PK/FK/NK flags, SCD type | the model's `.yml` |
| Change grain, modelRole, description, rationale | the model's `.yml` |
| Add a model to a domain diagram | Domain `.json` → add name to `logical.models[]` AND, if no file for that name exists in any folder, create it — `logical-models/{layer}/{name}.yml` (the domain's layer) when the project uses layer folders, else `logical-models/{name}.yml` |
| Remove a model from a domain | Domain `.json` → remove name from `logical.models[]` AND remove its relationships from `logical.relationships[]` |
| Add/remove/edit a relationship | Domain `.json` → `logical.relationships[]` |
| Change layout positions | Domain `.json` → `viewConfig.positions` |

> **Common mistake:** Editing the `.yml` file alone is sufficient for column and model property changes — the extension picks up YAML changes automatically. But adding a model to the **diagram** requires BOTH creating the `.yml` AND adding the name string to the domain `.json`. Similarly, relationships are ONLY stored in the domain `.json`, never in the `.yml`.

---

## Models

Model definitions live in `.erd-studio/logical-models/{model_name}.yml` or `.erd-studio/logical-models/{layer}/{model_name}.yml` (see "Model file location" above). Create/edit these YAML files to define models. Then reference them by name in domain files.

**File:** `.erd-studio/logical-models/silver/dim_customer.yml`

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
| `alias` | No | Warehouse table name when it differs from `name` — dbt's `alias` config. `name` stays the identity (domain files and relationships use it); the canvas shows the alias. Use it for the same table name in two layers (`silver_date` and `gold_date`, both `alias: date`). A plain identifier: letters, digits, underscores |
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

## Building Models from External Sources

When the user asks you to create a new model — or materially add columns to an existing one — from an external source (planning doc, DDL, staging SQL, CSV, notebook, or another YAML), follow this protocol. It exists to prevent silent column truncation.

**Does NOT apply to:** renaming a column, changing a single flag, or executing an `.erd-studio/.sync-plan.json` (see SYNC.md for that workflow).

### Step 1 — Read the source fully, then enumerate
Before listing anything, confirm you have read the source **in full**. For files longer than 2000 lines, page through with `Read` using `offset`/`limit` until you reach the end of the file. A partial read is a silent-truncation trap before you even start — the columns you never saw cannot appear in your output.

Then list every source column in order, with a total count. Do not summarise or elide:

> Source `models/staging/stg_customer.sql` has **47 columns**:
> 1. customer_id
> 2. email
> …

For wide tables (50+ columns), group the list in numbered chunks of 50 so you and the user can verify nothing was dropped mid-list. Tables over 100 columns are common in EDW staging — the chunking exists for exactly this case.

If you cannot identify a source, stop and ask which source to build from before listing.

### Step 2 — State scope
State which of those columns you intend to build, in plain English.

> Proposed scope: **all 47 columns**.
> — or —
> Proposed scope: **23 of 47 columns** (PK, NKs, and measures; excluding audit columns and deprecated fields).

Proceed straight to step 3 — do not wait for confirmation. The user will correct you if the scope is wrong.

### Step 3 — Build
Write the model's YAML file — the existing file if the model already exists (in whichever folder it is in), otherwise a new file — `.erd-studio/logical-models/{layer}/{name}.yml` for the layer of the target domain when the project uses layer folders, else `.erd-studio/logical-models/{name}.yml` (see "Model file location").

### Step 4 — Reconcile via set-difference
Re-read the YAML file you just wrote. Compute the set-difference between source columns and YAML columns — do not rely on a total count alone, because counts can coincidentally match while columns still differ.

Report in this exact form:

> Reconcile: `dim_customer.yml` has **M** columns; source has **N**.
>
> **In source but not in YAML** (K): `created_at` (audit — not modelled), `updated_at` (audit), `_dbt_source_relation` (dbt internal).
>
> **In YAML but not in source** (J): `customer_sk` (synthesised surrogate key), `loaded_at` (added for SCD2 tracking).

Every entry in "in source but not in YAML" must have a specific reason. A class-level reason already declared in Step 2 (e.g. "excluding audit columns") is sufficient — you don't need to restate it per column. But an unexplained entry, or a vague reason like "not needed", means **stop and tell the user** that a column may have been dropped unintentionally. Do not claim the task is complete.

**Rule of thumb:** if your reconcile message doesn't name specific columns on both sides, you skipped a step.

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

The physical stage has **no files on disk**. It is derived at runtime from the dbt project itself — source files, schema `.yml` files, `{target-path}/manifest.json` and `{target-path}/catalog.json`. None of those four is required, and in particular a project that has never been compiled still renders real models.

1. **Existence**: a model is real (not a ghost) when **any** of these holds:
   - a `<name>.sql`, `<name>.py` or `<name>.csv` file sits under a configured `model-paths`, `seed-paths` or `snapshot-paths` directory (so seeds and snapshots count), **and** dbt has not disabled the model;
   - a dbt schema `.yml` under `model-paths` declares it;
   - the compiled manifest carries a node for it;
   - `catalog.json` carries a relation for it.

   A model found in **none** of those is still drawn, as a **ghost** with no columns — the design references something the dbt project does not have. A model dbt has **disabled** lands in the manifest's `disabled` section and `ref()` to it fails, so a bare source file does not make it exist; with no other evidence it ghosts with a "disabled" reason. Ghosting therefore means "not in your dbt project", never "you have not run `dbt compile` lately".
2. **Columns** come from two *kinds* of source. The **declared** list is the schema `.yml` when there is one, otherwise the manifest's copy of it — one source, because the manifest's column list is a compiled copy of the same yml patch, so where they disagree the manifest is merely stale. The **observed** list is `catalog.json`, an independent look at the warehouse relation. When a catalog relation resolves, the rendered list is their **union**: catalog order first, then any declared column the catalog has not seen. With no catalog it is the declared list alone. The catalog is only as fresh as the last `dbt docs generate`, which is exactly why it never *replaces* the declared list: a column added to the SQL and the yml an hour ago would otherwise vanish from physical and be proposed for deletion. A column in both keeps the **declared** spelling (Snowflake reports UPPERCASE keys; they never win the label).
3. **Data types** are an ordered fallthrough per column: `catalog.json`, then the declared `data_type:`, then the manifest's copy of it, then blank. A column typed on only one stage is reported as **`undeclared`**, not as a type mismatch — writing `data_type:` into the schema yml (or running `dbt docs generate`) is what fills it in. Comparison understands warehouse spellings (`NUMBER`, `character varying(255)`, `timestamp without time zone`, `ARRAY<...>`), and treats a whole-number `NUMBER`/`decimal` as an integer.
4. **Descriptions**: the `.yml` description, then the manifest's, then the catalog's column `comment` — the human's words beat the warehouse's echo of them, since `persist_docs` writes the dbt description *into* that comment.
5. **Schema name**: manifest `schema`, then the catalog's `metadata.schema`, then blank. It cannot be derived from the filesystem (it needs `generate_schema_name` and `profiles.yml`), so with neither artifact the node badge falls back to the ERD **layer** abbreviation and says so — "physical works without dbt" does **not** extend to schema names.
6. **Provenance**: every real physical model records which sources contributed its columns and which one supplied its types, shown as a chip on the node (WH = warehouse catalog, YML = your dbt `.yml`, DBT = the dbt manifest, SQL = the source file only) and spelled out in the detail panel. Runtime only — never written to disk.
7. **Relationships**: derived from **dbt relationship tests** — the union of those declared in `.yml` files and those in the manifest, deduped; never copied from logical. `catalog.json` holds no constraint or foreign-key information, so it contributes no edges.
8. **Cardinality**: derived from **uniqueness tests** merged from yml and manifest — no `unique` test = "many" side.
9. **Scoping**: only relationships between models **within the same domain** appear. References to models outside the domain are silently excluded.
10. **Carried forward from logical**: PK/FK/NK flags, grain, modelRole, scdType and additiveType — dbt yml does not carry them.

A model known **only** by the file that defines it renders as a real node with **zero columns**: nothing has stated its shape, and seeding it from the logical design would invent one. Sync comparison skips such a model entirely rather than reporting every logical column as missing. That suppression is automatic and distinct from `stubColumns`, which is the user's own switch for models they know are deliberately partial.

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

When asked to execute a sync plan, or when `.erd-studio/.sync-plan.json` exists:

1. Read `SYNC.md` in the same directory as this skill file for the full action reference and execution guide
2. Read `.erd-studio/.sync-plan.json` for the specific actions to execute
3. Follow the execution steps in SYNC.md to reconcile logical and physical models

<!-- erd-studio-harness: 20 -->
