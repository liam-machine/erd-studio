# ERD Studio — YAML and JSON files (projects before 2.0)

**Read this file only when `erd-studio doctor --json` reports `erd.storage: yaml`** (or, in a `mixed` project, to edit an existing `.yml` table or `.json` diagram in place). A new project, and every new file in a `dbml` or `mixed` project, is DBML: follow `DBML.md`. **Never convert by hand: run ERD Studio: Convert Project to DBML** (the user runs it in VS Code: one undoable step that doctor's `erd.dbmlConversion` previews).

In a YAML project, model (table) definitions are YAML files in `.erd-studio/logical-models/` (at the top level, or one folder down in a per-layer folder). Domain (subject area) JSON files reference models by name and hold the layout. Relationships are defined once, in the YAML of the model holding the foreign key (the "many" side), and every domain holding both models draws them — or, in a project that still keeps them per domain, in each domain JSON (see `Where relationships live`). The rules every format shares — the team's modelling approach and metadata list, table roles, rationale fields, building from a source, naming, the physical stage and sync plans — are in `SKILL.md`.

## File naming: v5 or v6 — use the one `erd-studio doctor` reports

A project's files use one of two namings for the same format. **Before writing any `.erd-studio` file, run `erd-studio doctor --json` and read `erd.naming`**, then write every file in that naming (doctor works in a folder without dbt too, reporting `dbtProject: false`; when it finds no project at all — no `dbt_project.yml` and no `.erd-studio/` yet — the project is new, so it is DBML: follow `DBML.md`):

| What | v5 naming (`naming: v5`) | v6 naming (`naming: v6` or `mixed`, and a new project) |
|------|------|------|
| Table (model) library folder | `.erd-studio/logical-models/` | `.erd-studio/tables/` |
| Subject area (domain) file `schemaVersion` | `5` | `6` |
| Its slug key | `domain` | `subjectArea` |
| Its list of table names | `logical.models` | `logical.tables` |
| A relationship's ends (subject area JSON) | `fromModel` / `toModel` | `fromTable` / `toTable` |
| A relationship's far end (table YAML) | `toModel` | `toTable` |
| A table's role (table YAML) | `modelRole` | `tableRole` |
| An annotation's linked table | `linkedModel` | `linkedTable` |

Everything else — `layer`, `modelFolder` (the dbt `models/` path filter), `viewConfig`, `positions`, columns, keys, the subject area file's path `.erd-studio/{layer}/{name}.json` — is the same in both. **The examples below use the v5 names; in a v6 project write the v6 name from this table instead.**

- `naming: v5` → write the v5 names, and create new table files in `logical-models/`.
- `naming: v6` or `mixed` (a project half-way through the move) → write the v6 names, and create new table files in `tables/`. In a mixed project, edit an existing file in the naming it already uses.
- **Never mix the two in one file** (`schemaVersion: 6` with `domain`, or `logical.tables` beside `logical.models`): such a file does not open. A YAML file holding both `modelRole` and `tableRole` cannot be edited on the canvas; only the v6 key is read.
- **Never move files between `logical-models/` and `tables/` yourself.** The user moves a project with **ERD Studio: Migrate to the New File Naming**, one undoable step; doctor's `erd.namingMigration` previews it. ERD Studio versions before the one that wrote v6 cannot open v6 files, so the move is the user's decision, never yours.

## Architecture Overview

```
.erd-studio/
├── modelling-approach.md     ← Optional: the team's modelling rules (see `SKILL.md`)
├── logical-models/           ← Central model definitions (YAML, one per model)
│   ├── dim_project.yml       ← top level (flat libraries keep working)
│   ├── silver/               ← optional per-layer folders
│   │   └── dim_customer.yml
│   └── gold/
│       └── fct_sale.yml
├── silver/
│   ├── customer-360.json     ← Domain file (model references + layout; relationships only in per-domain projects)
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
| `schemaVersion` | Yes | `5` in the v5 naming, `6` in the v6 naming (see "File naming" above) |
| `domain` | Yes | Domain slug (matches filename without `.json`) |
| `layer` | Yes | Layer name matching parent directory (e.g. `silver`, `gold`) |
| `description` | No | Human-readable domain description |
| `modelFolder` | No | Filter for "Add Existing Model" dialog (e.g. `models/silver`) |
| `stubColumns` | No | Model names whose physical-only columns are suppressed in sync comparison. Use for conformed dimensions and reference tables included only to anchor relationships — they define a few key columns (PK/NK) but not the full physical column set. Missing-column discrepancies are hidden; extra and type-mismatch discrepancies on defined columns still surface. |
| `logical.models` | Yes | Array of model name strings (references to `logical-models/*.yml` or `logical-models/{folder}/*.yml`) |
| `logical.relationships` | Yes | Array of relationship objects — `[]` when the project keeps relationships in the model YAML (see "Where relationships live") |
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
| Change grain, modelRole, description, rationale, meta | the model's `.yml` |
| Add a model to a domain diagram | Domain `.json` → add name to `logical.models[]` AND, if no file for that name exists in any folder, create it — `logical-models/{layer}/{name}.yml` (the domain's layer) when the project uses layer folders, else `logical-models/{name}.yml` |
| Remove a model from a domain | Domain `.json` → remove name from `logical.models[]` AND remove its relationships from `logical.relationships[]` (relationships in model YAML stay — the domain just stops drawing them) |
| Add/remove/edit a relationship | The many-side (FK) model's `.yml` → `relationships:` when the project keeps relationships in the model library, else domain `.json` → `logical.relationships[]` — see "Where relationships live" |
| Change layout positions | Domain `.json` → `viewConfig.positions` |

> **Common mistake:** Editing the `.yml` file alone is sufficient for column and model property changes — the extension picks up YAML changes automatically. But adding a model to the **diagram** requires BOTH creating the `.yml` AND adding the name string to the domain `.json`. A relationship is stored in exactly one place — the FK (many-side) model's `.yml` or the domain `.json`, never both (see `Where relationships live`).

---

## Models

Model definitions live in `.erd-studio/logical-models/{model_name}.yml` or `.erd-studio/logical-models/{layer}/{model_name}.yml` (see "Model file location" above). Create/edit these YAML files to define models. Then reference them by name in domain files.

**File:** `.erd-studio/logical-models/silver/dim_customer.yml`

```yaml
name: dim_customer
schema: silver
description: "Customer master data. Status: one of active, closed"
grain: "One row per customer"
modelRole: conformed-dim
rationale:
  purpose: "Customer master data for cross-domain joins"
  roleChoice: "Conformed dimension shared across domains"
meta:
  owner: crm-team
  source_system: salesforce
columns:
  - name: customer_id
    dataType: "INT"
    description: "Surrogate key"
    isPrimaryKey: true
    scdType: 0
  - name: email
    dataType: "VARCHAR"
    description: "Email address"
    isNaturalKey: true
    scdType: 1
  - name: full_name
    dataType: "VARCHAR"
    description: |
      Customer display name.
      Built from first_name and last_name.
    scdType: 2
```

**YAML quoting — the file must parse, or ERD Studio shows the model as empty.** Wrap every `description`, `grain`, `rationale` and `dataType` value in double quotes (escape an inner `"` as `\"`), or use a `|` block for multi-line text. Always quote a value that contains `: ` or ` #`, or starts with any of `` ` @ * & ! % [ { - | > ' " ``. Indent with spaces, never tabs. Write each key once per block: before adding a `description` (or any key) to a model or column, check it is not already there, and edit the existing line instead — a key written twice makes ERD Studio refuse every change to that file until one copy is removed. One YAML document per file: no `---` separators, no markdown code fences, no `{{ doc() }}` — paste the text itself. `erd-studio doctor` and `erd-studio diff` report a file that does not parse as `fix-model-yaml` with its line — fix that before anything else, unless that file's entry in their `unreadableModelFiles` list has `mergeConflict: true` (the fix itself carries no such field): git left two versions in that file after a merge, so show the user the file and line and ask which side to keep — never pick a side yourself or run git commands. A diagram file with conflict markers gets doctor's `resolve-merge-conflicts` step instead; handle it the same way.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Model name (see "Naming Conventions" in `SKILL.md`) |
| `schema` | No | Target schema for materialization |
| `alias` | No | Warehouse table name when it differs from `name` — dbt's `alias` config. `name` stays the identity (domain files and relationships use it); the canvas shows the alias. Use it for the same table name in two layers (`silver_date` and `gold_date`, both `alias: date`). A plain identifier: letters, digits, underscores |
| `description` | No | Human-readable model description |
| `grain` | No | Grain statement — "One row per ___" |
| `modelRole` | No | Architecture role (see "Table roles" in `SKILL.md`) |
| `columns` | No | Array of column definitions |
| `rationale` | No | Design rationale object (omit if empty) |
| `meta` | No | Free-form metadata map (see "Metadata" below) |
| `relationships` | No | Relationships leaving this model (it holds the foreign key), shared by every domain (see "Where relationships live") |

### Metadata (`meta`)

Optional `meta` map on a model **and** on any column — free-form key/value metadata named after, and shaped like, dbt's `meta:` (owner, source system, lineage, classification…). Keys are strings; values may be text, numbers, booleans, `null`, lists or nested maps. Omit `meta` entirely when there is nothing to record (an empty map is removed).

```yaml
meta:
  owner: crm-team
  lineage:
    upstream: [stg_salesforce__account]
    refreshed: daily
columns:
  - name: email
    dataType: "VARCHAR"
    description: "Email address"
    meta:
      pii: true
      classification: confidential
```

- ERD Studio **never compares, diffs or syncs `meta` with dbt** — it is not part of the physical stage, discrepancy reports or sync plans, and does not need to match the dbt model's `meta:`. (Assistants may copy it from dbt by hand, only as the team's metadata list in `SKILL.md` says.)
- The canvas shows it in the Detail panel and when the user hovers a model's name or a column; top-level text values can be edited in the panel, nested maps, lists, booleans and `null` are shown read-only.
- **Keep every existing entry** when you edit a model file — including keys that are not on the team's list, values the user typed in, and values dbt no longer records — and never move keys between the model and its columns. Never invent metadata.

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
| `meta` | No | Free-form dbt-style metadata map for this column (see "Metadata" above) |

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
| `cardinality` | Yes | `many-to-one`, `one-to-one`, or `many-to-many` (`one-to-many` is still read, but never write it — see Direction) |
| `role` | No | A label for what the link means, e.g. `order date` and `ship date` for two columns pointing at the same date dimension. At most 60 characters. A label only — not part of the relationship's identity |
| `compositeKey` | No | Groups entries into one composite foreign key (see below). At most 64 characters |

**Spelling:** always spell `fromModel`, `toModel` and the columns exactly as the model and column are named. ERD Studio matches them ignoring case, but writes the real spelling the next time it changes that entry.

**Direction:** `fromModel` is always the many (FK) side, `toModel` the side it points at (PK). Never write `one-to-many`: swap the ends and write `many-to-one`, in the other model's file — it is the same relationship. `one-to-one` and `many-to-many` keep the direction they were drawn in. Keys win: the many side is never its model's whole primary or natural key while the other end is a column of a model with a different key — such a `many-to-one` is drawn backwards: ERD Studio draws it as stored but flags it (an amber ⚠ on the line with **Turn round**, a comment in the DBML / Mermaid export, a `backwardsRelationships` count in `erd-studio doctor`), **Move Relationships to Model Library** stores it the right way round, and the canvas refuses a ⇄ that would write it. Never write one; when doctor reports some (`turn-round-relationships`), offer to turn them round: a `many-to-one` from the column that is not a key to the key, in that column's model file. FK column names should match the PK column name of the referenced table.

### Where relationships live

A relationship is defined **once** for the whole project, in the YAML of its `fromModel`, the model holding the foreign key (the many side), under `relationships:` — the same fields without `fromModel`, which is the file's own model. Every domain whose `logical.models` holds both ends draws it; a domain missing either end does not. Changing it changes every diagram that shows it.

```yaml
# logical-models/gold/fct_orders.yml
name: fct_orders
columns: [...]
relationships:
  - fromColumn: customer_id
    toModel: dim_customer
    toColumn: customer_id
    cardinality: many-to-one
  - fromColumn: ship_date_key
    toModel: dim_date
    toColumn: date_key
    cardinality: many-to-one
    role: ship date
```

So adding a new fact only ever changes the fact's own file; its dimensions never list who points at them.

**Mark the keys.** Direction comes from keys: when you add a relationship, mark the referenced column with `isPrimaryKey: true` (or `isNaturalKey`) on the model it points at, unless that model already marks a key. Without a key marked, ERD Studio falls back to dbt's `unique` tests, and with neither the user has to say which side holds the foreign key.

**Self-references** (`employee.manager_id → employee.employee_id`) are stored in the model's own file with `toModel` set to the model itself. A column never points at itself.

```yaml
# logical-models/employee.yml
relationships:
  - fromColumn: manager_id
    toModel: employee
    toColumn: employee_id
    cardinality: many-to-one
    role: manager
```

**Composite foreign keys** (several columns together, e.g. a Data Vault PIT or bridge, a multi-column natural key) are one entry per column pair, all sharing the same `compositeKey` value, stored together on the FK side. Every entry points at the same `toModel` with the same cardinality (`many-to-one` or `one-to-one`, never `many-to-many`), and no column appears twice. ERD Studio draws them as one line. Name the key `fk_<toModel>` (`fk_<toModel>_2` for a second one in the same file). Never use array forms such as `fromColumns: [...]` — older ERD Studio versions would delete them.

```yaml
# logical-models/gold/pit_customer.yml
relationships:
  - fromColumn: customer_hk
    toModel: sat_customer
    toColumn: customer_hk
    cardinality: many-to-one
    compositeKey: fk_sat_customer
  - fromColumn: as_of_date
    toModel: sat_customer
    toColumn: load_date
    cardinality: many-to-one
    compositeKey: fk_sat_customer
```

**Which to use:** put new relationships in the model YAML when **any** model file already has a `relationships:` list, or **no** domain file has a `logical.relationships` entry (a new project). Otherwise the project keeps relationships per domain: add them to the domain JSON's `logical.relationships[]`, and leave that choice to the user (the **ERD Studio: Move Relationships to Model Library** command moves them). Never define the same two columns twice — not in both places, and not once in each direction; if a domain and the model YAML disagree, the model YAML wins.

<!-- erd-studio-harness: 35 -->
