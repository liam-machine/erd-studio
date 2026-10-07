# Semantic Domain JSON Reference

> Context document for AI agents generating ERD Studio domain files. Describes the **schemaVersion 5** format written by the current extension. The authoritative, always-current copy of this guidance is the `SCHEMA_CONTENT` string in `src/services/harnessService.ts` (installed into a project via "ERD Studio: Install AI Coding Harness").

## File Layout

ERD Studio uses a **central model store**. Model definitions are YAML files in `.erd-studio/logical-models/` (at the top level or one folder down); domain JSON files reference models **by name** and hold the layout. Relationships are defined once, in the YAML of the model holding the foreign key, and drawn by every domain holding both models — or, in a project that keeps them per domain, in each domain JSON (see [Where relationships live](#where-relationships-live)).

```
.erd-studio/
  layers.json                 ← layer definitions
  modelling-approach.md       ← optional: the team's modelling rules, for AI assistants
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
- **Lookup:** the top-level file first, then each folder in alphabetical order. A second file with the same name elsewhere is *shadowed* — ignored, flagged in the Model Library view, and named in a warning when a canvas that uses the name opens. **Give Duplicate Model Its Own Name** fixes it: the ignored copy becomes `{folder}_{name}` with `alias: {name}`, and the domains of that folder's layer are repointed at it in the same edit.
- **The same table name in two layers** is two models with the same `alias`: `silver/silver_date.yml` and `gold/gold_date.yml`, both `alias: date` — the pattern a dbt project uses for two `date` tables (unique model names, `alias` + `schema` for the relation). The canvas labels each node `date`, or `silver.date` / `gold.date` when both are on one canvas.
- **Folders are opt-in per project.** A library uses layer folders once any model file sits in a folder named after a layer in `layers.json` (or while it is empty); a hand-made folder such as `Staging/` does not count. Then a new model created from a canvas is written to the folder of the layer of the domain it is added to (`gold/reporting.json` → `logical-models/gold/`). A flat library stays flat: new files go to the top level until someone runs **ERD Studio: Organise Model Library by Layer**. Opting in is a team decision — a teammate on ERD Studio before 1.2.0 only reads the top level and would see models in folders as missing. A rename keeps the file in its folder.
- **Organise Model Library by Layer** moves each file into the folder of the one layer whose domains reference it: top-level files, and files sitting in *another* layer's folder (the domains that use it moved layer). A model used by several layers, or by none, stays where it is. Folders that are not a layer in `layers.json` (a hand-made `Staging/`, or a layer id since removed) are never touched and are named in the confirmation. Re-running it is always safe.
- Hosts that cannot list directories (the `@erd-studio/core` `loadDisplayDomain` viewer) probe the top level, then every layer folder alphabetically (the extension's order), so they see only folders named after a layer.

The base directory name (`.erd-studio`) is configurable via the `erdStudio.semanticDir` setting.

### Team modelling approach (`.erd-studio/modelling-approach.md`)

An **optional**, free-form markdown file recording how the team models data: the technique (Kimball dimensional modelling, Data Vault 2.0, Inmon/3NF, One Big Table, Activity Schema, dbt's staging/intermediate/marts layering, or house rules), the user's own description in their words, the concrete rules, how each rule maps onto logical fields (`modelRole`, `grain`, `scdType`, `additiveType`, `isNaturalKey`, `rationale`), the sources consulted and the date. The `/erd-studio-setup` guide writes it after asking the user; it can also be written or edited by hand.

It is guidance for AI assistants only. **The extension never parses it**: it is not a domain, a layer or a model, the canvas and the diff ignore it, and a project without one is valid. AI assistants editing ERD Studio files should read it first when it exists and follow it (the harness skill says so); where a rule conflicts with a request, they should say so and ask which wins. An optional **Target-design backlog** section lists improvements the team wants in the dbt project; differences between logical and physical listed there are intentional, and assistants report them as backlog items instead of "fixing" them. The logical fields still describe what dbt does today — a target that no diff can show (history, keys, grain) is kept in `rationale` and the backlog, not in `scdType` / key flags, because the physical stage copies those flags from logical.

An optional **Metadata** section is the team's **metadata list**: the `meta` keys the team records, as a table of **Key**, **On** (models, columns or both), **Values** and **Source** — `dbt` (copied from the dbt model's own `meta:`, never typed in, left out when dbt has no value) or `the team` (filled in by people, never by an AI). Assistants use its key names exactly — a user's "data owner" becomes the listed `owner` — and copy the `dbt` keys whenever they create a model or add a column from dbt, including from a sync plan. The setup guide writes the section after detecting the keys dbt already records (`erd-studio inventory`'s `conventions.meta`) and one yes from the user. A file holding only a title and this section is valid: no technique agreed yet, so the guide still detects the style.

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
description: "Customer master data for all sales channels"
grain: "One row per customer"
modelRole: conformed-dim
rationale:
  purpose: "Central customer entity shared across sales, marketing, and support"
  roleChoice: "Conformed dimension because customer data is referenced by multiple business areas"
  scdStrategy: "SCD1 for mutable attributes; customer_code and customer_id never change"
meta:
  owner: crm-team
  lineage:
    upstream: [stg_salesforce__account]
    refreshed: daily
columns:
  - name: customer_id
    dataType: "INTEGER"
    description: "Surrogate key"
    isPrimaryKey: true
    scdType: 0
  - name: customer_code
    dataType: "STRING"
    description: "Business identifier from the source system"
    isNaturalKey: true
    scdType: 0
  - name: email
    dataType: "STRING"
    description: "Primary email address"
    scdType: 1
    meta:
      pii: true
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Model name. Must equal the filename without `.yml`. |
| `schema` | string | No | Target schema the model materialises in. |
| `alias` | string | No | Warehouse table name when it differs from `name` — dbt's `alias` config. A plain identifier (letters, digits, underscores; case kept). `name` stays the identity everywhere; the canvas shows the alias, qualified by `schema` when two models on one canvas share it. Set from the detail panel's **Table name** row. |
| `description` | string | No | Human-readable description. |
| `grain` | string | No | Grain statement: "One row per ___". |
| `modelRole` | string | No | Role in the warehouse architecture. See ModelRole enum. |
| `columns` | array | No | Array of `ColumnDef`. |
| `rationale` | object | No | Design rationale. Omit entirely if empty. |
| `meta` | map | No | Free-form, dbt-style metadata (owner, source system, lineage…). See [Metadata](#metadata-meta). Omit entirely if empty. |
| `relationships` | array | No | Relationships leaving this model — it holds the foreign key: `Relationship` objects without `fromModel` (it is this model). Shared by every domain holding both ends. See [Where relationships live](#where-relationships-live). Omit entirely if empty. |

Models are defined once and can be referenced from several domains. Editing a model from any domain canvas updates the shared YAML.

**YAML quoting.** A model file that does not parse loads as an empty placeholder (the canvas warns; `erd-studio doctor` and `erd-studio diff` report it as a blocking `fix-model-yaml` with the file and line). Wrap every `description`, `grain`, `rationale` and `dataType` value in double quotes (escape an inner `"` as `\"`), or use a `|` block for multi-line text. Always quote a value that contains `: ` or ` #`, or starts with any of `` ` @ * & ! % [ { - | > ' " ``. Indent with spaces, never tabs. One YAML document per file: no `---` separators, no markdown code fences, no `{{ doc() }}` — paste the text itself. (A byte-order mark and CRLF line endings are fine.)

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
| `meta` | map | No | Free-form, dbt-style metadata for this column. See [Metadata](#metadata-meta). Omit entirely if empty. |

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

### Metadata (`meta`)

Optional map on a model and on any column, named after and shaped like dbt's `meta:`. Keys are strings; values may be text, numbers, booleans, `null`, lists or nested maps (`MetaValue = string | boolean | null | MetaValue[] | { [key]: MetaValue }`; numbers are read as their source text, like every other field). A `meta` that is not a map, or is an empty map, is ignored.

- **Never compared with dbt.** `meta` is logical-only: the physical stage does not read dbt's `meta:`, and discrepancy reports, `erd-studio diff` and sync plans ignore it.
- **Canvas.** The Detail panel's **Metadata** section (for the model, and inside each expanded column row) lists every entry. Top-level text values can be added, edited and removed there; nested maps, lists, booleans and `null` are shown read-only — edit them in the file.
- **Writes are surgical.** A canvas edit rewrites only the top-level key that changed; comments, unquoted numbers, nested values and aliases elsewhere in `meta` stay byte-identical. Removing the last key removes `meta`.
- **Hover.** On the canvas, hovering a model's name lists its `meta`; hovering a column shows the column's under its description.
- **AI assistants** keep every existing entry. With a team metadata list (a `## Metadata` section in `modelling-approach.md`, above) they follow it; without one they add or change only the keys the user asks for and never copy dbt's `meta:` unasked.
- **dbt's own `meta:`** is read only by `erd-studio inventory` — `models[].meta` / `columns[].meta` (the schema yml over the manifest per key, and `config: meta:` over `meta:`, as dbt merges them) plus the project-wide `conventions.meta` summary of keys, counts, kinds and examples — so the setup guide can offer to carry it across. The physical stage still never shows or compares it.

## Relationships

A relationship is stored in exactly one place: the YAML of the model holding its foreign key (`relationships:`) or a domain JSON (`logical.relationships`). See [Where relationships live](#where-relationships-live).

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
| `cardinality` | string | Yes | One of `"many-to-one"`, `"one-to-one"`, `"one-to-many"`, `"many-to-many"`. `"one-to-many"` is still read, but ERD Studio never writes it — into a model YAML or a domain file (see the direction convention). |
| `role` | string | No | A label for what the link means, e.g. `"order date"` and `"ship date"` for two columns pointing at the same date dimension. Trimmed, at most 60 characters, drawn on the line. A label only: not part of the identity. |

**Identity:** a relationship is its two `model.column` ends, **unordered and compared without case** (`linkKey` / `sameLink` in `@erd-studio/core`, issue #133). `fct_order_line.customer_id → dim_customer.customer_id` and its reverse are one relationship; so are two entries that differ only in capital letters. `cardinality` and `role` are not part of the identity. Each identity is stored once per project in a library project, and once per domain file in a per-domain one. (The key is shaped so that composite keys can be added later without a format change.)

**Direction convention:** `fromModel` holds the FK (the "many" side), `toModel` holds the PK. A `one-to-many` is the same relationship read from the other end, so it is stored with its ends swapped as `many-to-one` (`canonicalRelationship` in `@erd-studio/core`) — in a model YAML and in a domain file. A `one-to-one` is stored from the model that holds the foreign key; a `many-to-many` keeps the direction it was drawn in. Where a relationship is stored follows from the record alone — never from the key flags. The key flags (`isPrimaryKey`, `isNaturalKey`, `isForeignKey`) and dbt's `unique` / `relationships` tests are evidence the editor uses when you *draw* a relationship (`resolveDirection`): when they settle which side is the "one" side the dialog fills it in, and when they do not it asks rather than guessing from the order you dragged.

Entries missing any of the four string endpoints are skipped on read; an unrecognised `cardinality` (e.g. `one_to_many`) or a missing one is drawn as `many-to-one`. Each skipped or defaulted entry is reported (`REL008`, below) — in a model YAML with its line, in a domain file by its position in `logical.relationships` — and so is a `relationships:` that is not a list at all. Saving the model never deletes or rewrites such an entry — model YAML `relationships:` are saved entry by entry, keeping comments, unknown keys and unreadable entries exactly as written.

**Provenance is runtime-only.** When a domain is read, every drawn relationship carries `source` (`{ kind: "library", model, index }` or `{ kind: "domain", index }`), `stored` (its four ends exactly as on disk) and `issues` (the check codes that concern it). The canvas uses them to edit the right record. They are never written to a file — do not add them by hand.

### Where relationships live

**In the model library (the default for a new project, issue #126).** A relationship is written once, into the YAML of its `fromModel` — the model holding the foreign key — with the same fields minus `fromModel`. Adding a new fact therefore only ever changes the fact's own file:

```yaml
# logical-models/gold/fct_order_line.yml
name: fct_order_line
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

Every domain whose `logical.models` holds both `fct_order_line` and `dim_customer` draws it; a domain missing either does not. Editing it on any canvas changes every diagram that shows it, and deleting it deletes it everywhere. Renaming a model or column, or removing a column, rewrites the entries in other model files that point at it. Removing a model from one domain leaves its relationships in the library.

**Per domain.** A project whose domain files already hold relationships keeps adding them there, so teammates on a version before this one go on seeing every edge. It opts in with **ERD Studio: Move Relationships to Model Library**: every v5 domain's relationships are stored once in the YAML of the model holding each one's foreign key and taken out of the domain files, writing the files directly (undo with source control). The same command moves a library entry stored on its "one" side (a `one-to-many`, written before issue #133) to the model on its many side, as `many-to-one`, keeping its role. Opening a diagram in such a project offers the move (once a session, with **Don't Ask Again**) when at least one relationship's two models sit together in more than one diagram. Before writing, the command explains why and where each relationship goes; a relationship the domains define with different cardinalities is a **conflict**, and the user picks the cardinality every diagram will use (naming the diagrams behind each) or leaves it in the domain files for a later run.

**Which one applies** is decided by what is on disk, like layer folders: the library is used once **any** model file holds a `relationships:` entry — even one that cannot be read (an entry missing an end, a mapping where a list belongs, or a file with a YAML error), though an empty `relationships: []` does not count — or when **no** domain file holds a `logical.relationships` entry.

**Reading** (`normaliseRelationships` in `@erd-studio/core`, the one read path the canvas, the CLI, the MCP server and the viewer share). Every record is put in its canonical direction, and each end is respelled to the real model and column name when it matches only without case. Records with the same identity are drawn **once**, and the winner never depends on the order of `logical.models` or of the files: a library record beats a domain record; among library records, the one stored in its canonical home, then the lowest model name, then the earliest entry; among domain records, the earliest entry. The drawn order is the domain file's own relationships in file order, then the library-only ones. Nothing is dropped silently — each duplicate, one-to-many in a model file and case-only match becomes a diagnostic.

**Editing.** Every canvas relationship edit (add, ⇄, cardinality, the edit dialog, delete) goes through one planner (`planRelationshipCommit`): it removes **every** copy of the link from the two endpoint model files and the open domain file, then writes one canonical record at its home — the many-side model's YAML in a library project, the domain file in a per-domain one — as one undo step. An edit never moves a relationship between the library and the domain files; only **Move Relationships to Model Library** and **Repair Relationships…** do that, and only after the user confirms.

### Relationship checks

`checkRelationships` in `@erd-studio/core` checks every model file and domain file a host has loaded. The codes are stable; the canvas, the **Repair Relationships…** command and the `erd-studio check` CLI all use them.

| Code | Severity | Meaning |
|------|----------|---------|
| `REL001` | error if the copies disagree (cardinality, role, or a one-to-one's direction), else warning | The same link is stored more than once — in two model files, twice in one file, or twice in one domain file. In a per-domain project, one copy in each of two domain files is **not** a duplicate |
| `REL002` | warning | A `one-to-many` stored in a model YAML (it belongs in the other model's file, as `many-to-one`) |
| `REL003` | error | An endpoint model is not in the model library (not reported for a model whose file is unreadable, or a `stubColumns` model the domain also lists in `logical.models`) — or a domain file's own relationship names a model that is not one of that domain's `logical.models` (a name only in `stubColumns` included: it excuses missing columns, never puts a model on the diagram), so the diagram has nothing to draw it between |
| `REL004` | error | An endpoint column is missing from its model (same exceptions) |
| `REL005` | warning | An endpoint matches its model or column only when case is ignored |
| `REL006` | info | The stored direction contradicts certain key evidence, e.g. the `fromColumn` is its model's whole primary key. Never fails a check run |
| `REL008` | error | A model-file or domain-file entry was skipped or defaulted on read (missing end, missing or unknown cardinality, a non-text role, a role longer than 60 characters — shown shortened, kept as written — a stray `fromModel:` in a model file — read when it names the file's own model, skipped when it names another, since the entry would otherwise be drawn as a different link), or a `relationships:` that is not a list; with its line in a model file |
| `REL009` | info | In a library project, a domain file repeats a relationship the library already holds, saying the same thing |

`erd-studio check [--strict] [--json]` runs them over the whole project: exit `0` with no errors, `1` with errors (or warnings under `--strict`) or when a file could not be checked at all — a domain file it cannot read or load, a model file whose relationships were never read (it does not parse; it holds no model — empty, not a mapping, or no `name:`; or it repeats a model name another file already has, so it is shadowed and ignored), or a `layers.json` it cannot use (a layer folder may have been skipped), each listed under `unchecked` with a `reason` that says which and what to do — and `3` when the project or the ERD Studio folder is missing. `erd-studio doctor` counts them (and suggests `fix-relationships`, or `check-relationships` when the checks could not run or skipped a file), and `erd-studio diff` lists the ones that concern each domain under `integrity` — advisory, never changing its result.

### Repair Relationships…

**ERD Studio: Repair Relationships…** (`erdStudio.repairRelationships`, also in the Model Library view's `…` menu) fixes what the checks find, with consent. It first shows every file and every change it will make; nothing is written until you confirm. Without asking it fixes the unambiguous cases: a `one-to-many` moved to its many side (`REL002`), a name respelled (`REL005`) and identical duplicates removed, keeping the copy in its home (`REL001`). Everything else is one question each — copies that disagree (`REL001`), a missing model or column (`REL003` / `REL004`: point it elsewhere, remove it, or leave it), a direction the keys contradict (`REL006`: swap, or leave it) — and every question has **Leave as is**; Esc cancels the whole repair. An entry that could not be read (`REL008`) is never touched: the command opens the file at its line instead. A diagram still in the older (v4, inline-model) format is checked but never changed by the command, which names it and points at **Migrate Domains to Central Model Store** (a copy it holds never makes the repair of the other copies roll back); the canvas banner on such a diagram does the same instead of offering the repair. A diagram file that cannot be read at all is named too (and fails `erd-studio check`), never left out of a clean result. An entry carrying keys of its own (`description`, `tests`, …) or comments is never taken out of its file by the repair: that relationship is left as it is, and the summary says why. The files are written directly, all or nothing, refusing any that has unsaved edits; afterwards every written file is read back, and the repair is rolled back unless everything outside the relationships is byte-for-byte unchanged and the planned findings are gone. Running it twice does nothing the second time. **Move Relationships to Model Library** is the same engine with the per-domain → library move switched on. Opening a diagram offers Repair (once a session, with its own **Don't Ask Again**) when `REL001`, `REL002`, `REL003`, `REL004` or `REL008` are present, and an editable logical canvas shows a banner for `REL003` / `REL004` / `REL008`.

## View Config (`viewConfig`)

Persisted UI layout state. Safe to leave as `{}` — the extension auto-positions models that lack a position entry. When **no** model in the domain has a position (a brand-new domain written with `viewConfig: {}`), the canvas instead runs its ELK auto layout the first time the domain opens and saves the result as one undoable edit; the user can re-run it any time with **Layout** / Shift+L.

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
| Change grain, modelRole, description, rationale, meta | the model's yml |
| Add a model to a domain diagram | Domain `.json` → append the name to `logical.models` **and**, if no file for the name exists in any folder, create `logical-models/{layer}/{name}.yml` for the domain's layer |
| Remove a model from a domain | Domain `.json` → remove the name from `logical.models` and its relationships from `logical.relationships` |
| Add/remove/edit a relationship | The FK model's `.yml` → `relationships:` when the project keeps relationships in the model library, else domain `.json` → `logical.relationships` |
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

All of those are looked up by the model **name** first. Only when the name finds
nothing does the model's warehouse relation — `schema` plus `alias` (or the name)
— get a second chance against the manifest's `schema` + `alias`, then the
catalog's `metadata.schema` + `metadata.name`. The pair is always matched
together, never the alias alone (a silver `date` is not a gold `date`), a model
with no `schema` never takes that route, and a relation two dbt models share is
ambiguous and matches neither. A model found this way keeps its logical name on
the canvas, and its relationship tests are drawn on it.
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
| `meta` | Not shown — logical-only, never read from dbt |

A column typed on only one stage is reported as **`undeclared`**, not as a type
mismatch; writing `data_type:` into the schema yml, or running
`dbt docs generate`, is what fills it in.

**Model-level fields.** `alias` is the manifest's `alias` when dbt builds the model
under another name, then a catalog relation named otherwise, then the logical
`alias`. `schema` is the manifest's `schema`, then the catalog's
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

**Comparing without the canvas.** Nothing in this file format changes for tooling,
but there is a headless equivalent of the canvas's **Compare**. The `erd-studio` helper
(`dist/cli.js`, installed to `~/.erd-studio-cli/bin/erd-studio` by **ERD Studio: Set Up My
AI Helper**) is read-only. `erd-studio diff --domain .erd-studio/{layer}/{domain}.json --json`,
or `--all`, builds both stages exactly as described above and runs the same comparison
as the canvas, because both call the same code. It reports each difference as a fix
that brings the logical side in line with dbt, naming the file to change: the model's
`logical-models/{name}.yml` for columns and types, and for relationships the FK model's yml or the domain file, wherever the project keeps them. A relationship matches whichever end dbt tests it from. It exits `0` when there are no blocking differences and `1` when there are.
A column that dbt has no type for yet is advisory, not blocking, unless you pass
`--strict`. `erd-studio inventory --models a,b --json` prints the physical shape of the
named models, as a starting point for new model files. The `/erd-studio-setup` Claude Code
skill uses both commands. It writes the files described in this reference with the
assistant's normal Edit/Write tools, never through the helper, and runs `diff` until it is
clean.

## Editor Support (JSON Schemas)

Each hand-editable file has a JSON Schema (draft-07) in [`schemas/`](../schemas). It gives completion, hover descriptions and warnings for undeclared properties and invalid values:

| File | Schema |
|------|--------|
| `.erd-studio/{layer}/{domain}.json` | [`domain.schema.json`](../schemas/domain.schema.json) |
| `.erd-studio/logical-models/[{folder}/]{name}.yml` | [`logical-model.schema.json`](../schemas/logical-model.schema.json) |
| `.erd-studio/layers.json` | [`layers.schema.json`](../schemas/layers.schema.json) |
| `.erd-studio/templates/{id}.json` | [`template.schema.json`](../schemas/template.schema.json) |

**In VS Code** the extension associates them by path (`contributes.jsonValidation` / `yamlValidation`), so nothing needs to be added to your files. JSON validation is built into VS Code. YAML needs Red Hat's [YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml). Domain files open in the diagram editor by default; use **Open With… → Text Editor** to edit one as JSON. Schema problems are warnings, never errors: the extension still loads what it can, as described above.

The association uses the default `.erd-studio` directory. With a custom `erdStudio.semanticDir`, or in another editor, point at the schemas yourself. Either map them in settings (`json.schemas` / `yaml.schemas` in VS Code), or add a reference to the file. ERD Studio ignores the reference. Domain files keep a `$schema` key, and model files keep the comment, when the canvas saves them. `layers.json` is rewritten whenever layers are edited from the sidebar, which drops the key, so map that one in settings:

```jsonc
// domain / layers / template JSON: a top-level key
{ "$schema": "https://raw.githubusercontent.com/liam-machine/erd-studio/main/schemas/domain.schema.json", "schemaVersion": 5, ... }
```

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/liam-machine/erd-studio/main/schemas/logical-model.schema.json
name: dim_customer
```

The schemas describe the current format (`schemaVersion` 5) and still accept a version 4 domain until it is migrated. A domain that mixes model names with inline model objects is flagged, because it does not open. The schemas are slightly stricter than the reader: a quoted `scdType: "1"` or `isPrimaryKey: yes` still loads, but is flagged, so hand edits end up in the form the canvas writes.

Red Hat YAML matches paths with dot-folders skipped, so a project inside a hidden folder (`~/.work/shop/…`) gets no model validation from the built-in association; map it in `yaml.schemas` instead.

## Validation Rules

1. `schemaVersion` must be `5`. Versions below 4 and top-level `models` arrays are rejected; version 4 is accepted only until migrated.
2. `layer` must match an `id` in `layers.json`.
3. Every entry in `logical.models` must be a string. Mixed string/object arrays are rejected.
4. Each referenced model should have a `logical-models/{name}.yml` or `logical-models/{folder}/{name}.yml`; a missing file renders as a placeholder with a warning.
5. A relationship's identity — its two `model.column` ends, either way round, ignoring case — must be unique, and both models should be in `logical.models`. `erd-studio check` reports violations with the codes above.
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
description: "Order line items capturing each product sold in a transaction"
grain: "One row per order line item"
modelRole: transaction-fact
rationale:
  purpose: "Core transactional fact for revenue, volume, and margin analysis"
  measures: "line_amount and quantity are additive; unit_price is non-additive"
columns:
  - name: order_line_id
    dataType: "INTEGER"
    description: "Surrogate key"
    isPrimaryKey: true
  - name: customer_id
    dataType: "INTEGER"
    description: "FK to dim_customer"
    isForeignKey: true
  - name: product_id
    dataType: "INTEGER"
    description: "FK to dim_product"
    isForeignKey: true
  - name: quantity
    dataType: "INTEGER"
    description: "Units ordered"
    additiveType: additive
  - name: unit_price
    dataType: "DECIMAL(18,2)"
    description: "Price per unit at time of sale"
    additiveType: non-additive
  - name: line_amount
    dataType: "DECIMAL(18,2)"
    description: "Net line total"
    additiveType: additive
```
