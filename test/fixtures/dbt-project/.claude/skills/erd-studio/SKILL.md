---
name: erd-studio
description: >-
  Schema rules for ERD Studio data model files — the .erd-studio/ directory
  holds DBML tables, relationships and diagrams (YAML/JSON for older
  projects) with strict format rules you must read before editing. Use this
  skill whenever the task touches files in .erd-studio/ (.dbml tables,
  _relationships.dbml, .dbml diagrams, older .yml tables and .json diagrams,
  or .sync-plan.json), asks to add/edit/remove tables, columns,
  relationships, or cardinality in a data model or ERD diagram, mentions
  dim_/fct_/ref_/brg_ prefixed tables in an erd-studio context, or involves
  writing dbt schema YAML tests to match an ERD physical stage. The skill
  tells you which format and which file to edit for each operation —
  without it you will put data in the wrong file.
---

# ERD Studio — AI Data Modeling Guide

ERD Studio keeps a project's logical data model in `.erd-studio/` as plain text files you read and write: **tables**, the **relationships** between them, and **diagrams** (subject areas) that each show a set of tables. Since ERD Studio 2.0 a project stores them as **DBML**, an open format that other DBML tools (dbdiagram.io, dbdocs, the DBML CLI) read too; a project from before 2.0 keeps **YAML** tables and **JSON** diagrams, which stay readable and editable. This file says which format to write and holds the rules every format shares; the formats themselves are in `DBML.md` and `LEGACY.md`, both in the same folder as this file.

## What to write: read `erd.storage` first

**Before writing any `.erd-studio` file, run `erd-studio doctor --json` and read `erd.storage`** (doctor works in a folder without dbt too, reporting `dbtProject: false`):

- **`dbml`, or no `.erd-studio/` folder yet** (a new project) → write DBML: follow `DBML.md`.
- **`yaml`** → write YAML tables and JSON diagrams: follow `LEGACY.md`, in the file naming doctor's `erd.naming` reports.
- **`mixed`** (a project half-way to DBML) → new tables and new diagrams are DBML; an existing file keeps its format (edit a `.yml` table as YAML and a `.json` diagram as JSON, by `LEGACY.md`). A JSON diagram may list DBML tables; a DBML diagram may list only DBML tables, and a DBML table's Refs may name only DBML tables. A relationship between a DBML table and a YAML table cannot be stored yet: leave it out, and tell the user it needs **ERD Studio: Convert Project to DBML** first. Suggest **ERD Studio: Convert Project to DBML** to the user rather than converting anything yourself.
- **The doctor result has no `erd.storage` field** (an ERD Studio CLI older than 2.0, perhaps a teammate's) → write what the files already are: if `.erd-studio/tables/` holds `.dbml` table files, DBML; otherwise follow `LEGACY.md`. Tell the user their ERD Studio is older than these instructions.
- **No CLI** (the command is not found, exit 127) → the same rule from the files: any `.erd-studio/**/*.dbml`, or no `.erd-studio/` folder at all, means DBML; only `.yml` tables and `.json` diagrams means `LEGACY.md`.

**Never convert files between the formats by hand**, and never write a `.yml` table or a `.json` diagram into a DBML project. The user converts a project with **ERD Studio: Convert Project to DBML**, one undoable step that doctor's `erd.dbmlConversion` previews. ERD Studio versions before 2.0 cannot read DBML, so converting is the user's decision, never yours.

## Layout (DBML)

```
.erd-studio/
├── layers.json                     ← the layers (JSON); write it first in a new project
├── modelling-approach.md           ← optional: the team's modelling rules (see below)
├── tables/                         ← the table library: one Table per file
│   ├── dim_date.dbml
│   ├── _relationships.dbml         ← Refs owned by the top-level tables
│   └── gold/                       ← optional folder, one level only
│       ├── dim_customer.dbml
│       ├── fct_order.dbml
│       └── _relationships.dbml     ← Refs owned by the tables in tables/gold/
└── gold/                           ← a layer folder
    ├── sales.dbml                  ← a diagram: its tables by use lines, sticky notes
    └── sales.dbdiagram             ← its layout (positions); omit it for auto layout
```

A new project also needs `.erd-studio/layers.json`, which lists the layer folders. Write it first, with every field of each layer (ids are lowercase letters, digits, `-` and `_`; `color` is a six-digit hex):

```json
{
  "schemaVersion": 1,
  "layers": [
    { "id": "silver", "label": "Silver", "abbreviation": "SLV", "color": "#a0a0a0", "creatable": true, "order": 1 },
    { "id": "gold", "label": "Gold", "abbreviation": "GLD", "color": "#d4a800", "creatable": true, "order": 2 }
  ]
}
```

- A table's **name is its identity everywhere** and is unique across the whole library, ignoring case: never create a second file with a name that exists in another folder. Folders are organisational only. `tables/` is never a layer.
- **To find a table**, look at `tables/{name}.dbml` first, then in each folder (`tables/*/{name}.dbml`).
- **Folders are opt-in per project.** If a folder named after a layer in `layers.json` (`tables/{layer}/`) already holds a table file (or `tables/` is empty), create a new table in the folder of the layer of the diagram you are adding it to (adding `fct_sale` to `gold/reporting.dbml` creates `tables/gold/fct_sale.dbml`). If every table file is at the top level, create the new file at the top level too. Keep an existing table's file in the folder it is in.

## Edit rules

- **Edit in place and never reformat.** Change only the lines you mean to change; keep comments, order, spacing and every setting you do not understand exactly as they are. ERD Studio does the same.
- **Add a table to a diagram** = a new table file (when no file has that name) + a table `use` line in the diagram (+ the `use` line of that table's folder's `_relationships.dbml`, when the diagram does not import it yet).
- **Add a relationship** = one `Ref` line in the `_relationships.dbml` of the foreign-key table's folder, + a `use` line there for every table the Ref names that the file does not import yet.
- **Remove a table from a diagram** = delete its `use` line there (and its position in the layout file). The table file and its Refs stay: the diagram just stops showing them.
- **Never hand-merge a conflicted file.** When a file holds git conflict markers (`<<<<<<<` … `>>>>>>>`), show the user the file and line and ask which side to keep; never pick a side yourself or run git commands.
- **Check your work** with `erd-studio doctor` (its `erd.dbmlProblems` names every problem with its file, line and the exact line to write) and `erd-studio export --domain .erd-studio/<layer>/<name>.dbml --format dbml` (the diagram's path from the project folder, `.erd-studio/` included). Fix every `fix-dbml-file` error before anything else. Then fix every `missingUse`, `missingRelationshipsUse`, `unquotedValue` and `usePathMismatch` warning in a file you wrote (the message gives the exact line): ERD Studio reads on without the fix, but other DBML tools reject the file and every diagram that imports it. Fix a `foreignMetadata` warning too: a Metadata block outside the table's own file, whose values the canvas never shows while other DBML tools apply them; move its properties into the table file as inline settings and remove the block. Other warnings are information.

## Team Modelling Approach

If `.erd-studio/modelling-approach.md` exists, **read it before creating or editing models and follow it.** It records how this team models data — the technique (e.g. Kimball dimensional modelling, Data Vault 2.0), the user's own words, the concrete rules, and how each rule maps onto ERD Studio fields (the table's role, grain, SCD and additive types, natural keys and rationale, whatever the file format). The `/erd-studio-setup` guide writes it after asking the user; it can also be written or edited by hand. It is free-form markdown: ERD Studio never parses it, and a project without one is valid. When a rule in it conflicts with a user request, say so and ask which wins. If it has a **Target-design backlog** section, the differences between logical and physical listed there are intentional: when a sync plan or diff proposes undoing one, report it as a backlog item and leave it as it is unless the user says otherwise. If it has a **Metadata** section, that is the team's metadata list — follow it as "The team's metadata list" below says. A file holding only a title and a Metadata section is valid: no modelling technique has been agreed yet.

### The team's metadata list

If `.erd-studio/modelling-approach.md` has a `## Metadata` section, it lists the `meta` keys this team records, as a table: **Key**, **On** (models, columns or both), **Values**, and **Source** (`dbt` or `the team`). Read it before creating or editing a model, and follow it:

- **Use its key names exactly.** When the user describes a key in other words ("data owner", "does it hold personal data?"), use the listed key (`owner`, `pii`), never a new spelling, and put it where **On** says. When **Values** names a fixed set, use one of those values; an example in **Values** is never a default. Keep the kind of value (text, `true` / `false`, a list).
- **Source `dbt`: copy it; never make it up.** The value comes from the dbt model's own `meta:` — best from `~/.erd-studio-cli/bin/erd-studio inventory --models <name> --json` (`models[].meta`, `columns[].meta`, already merged as dbt merges them, including project-wide `+meta` from `dbt_project.yml`) when that helper is installed, else from the model's schema `.yml` (`meta:` and `config: meta:`, the `config` one winning per key; a column's are under that column) and the `+meta` entries in `dbt_project.yml`. Copy it whenever you create a logical model or add a column from dbt, including from a sync plan. Keep the kind of value: in a DBML table a text value is one `meta_<key>: '<text>'` setting and anything else (`true` / `false`, a number, a list) goes into the one `meta_json` setting as JSON (`DBML.md`); in YAML, `true` / `false` stay unquoted and a list stays a list, and numbers may be written quoted or not (ERD Studio reads `24` and `"24"` the same), but keep the quotes when leaving them off would change the digits (`"1.10"`, `"007"`). When dbt has no value (or `null`), leave the key out: never guess and never write a placeholder.
  - When you are already reading that dbt model and the model file's value for a listed `dbt` key differs from dbt's, say so in one line and ask before changing it — the difference may be deliberate.
  - When the user gives a value for a `dbt` key ("its owner is finance-team"), write it, say that dbt does not record it, and offer to add it to the dbt model's `meta:` too so the two agree — never edit dbt files unasked. When they ask for a `dbt` key that dbt has no value for and give none, say so and ask for the value.
- **Source `the team`: leave it to people.** Never fill it in yourself unless the user gives you the value. After creating models, say in one line which of them still lack these keys (one line for a whole batch or sync plan).
- **A key that is not on the list:** add it when the user asks, then offer once to add it to the list (Source `the team`, or `dbt` when dbt records it). Keys the list names under **Left out** (another tool's settings) are never copied from dbt.

Without that section, add or change only the keys the user asks for, and never copy dbt's `meta:` unasked. Ask for a value you were not given; never make one up.

## Table roles

A table's role is `role` in a DBML table file and `modelRole` (`tableRole` in the v6 naming) in a YAML one. Use one of these values:

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


## Design rationale

Optional, and every field is optional text: in DBML each is a table setting `rationale_<field in snake_case>` (`rationale_purpose`, `rationale_grain_choice`, …); in YAML they are keys of one `rationale:` map. Write only the fields there is something to say about.

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

**Does NOT apply to:** renaming a column, changing a single flag, or executing an `.erd-studio/.sync-plan.json` (see SYNC.md for that workflow). A **DBML file** (`.dbml`) from another tool has its own command — see "DBML: import and export" in `DBML.md`.

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
Write the table's file — the existing file if the table already exists (in whichever folder it is in), otherwise a new file: in a DBML project `.erd-studio/tables/{layer}/{name}.dbml` for the layer of the target diagram when the project uses layer folders, else `.erd-studio/tables/{name}.dbml` (see "Layout" above); in a YAML project the `.yml` path `LEGACY.md` gives. When the source is a dbt model and the team's metadata list has `dbt` keys, copy those too (see "The team's metadata list").

### Step 4 — Reconcile via set-difference
Re-read the table file you just wrote. Compute the set-difference between source columns and the file's columns — do not rely on a total count alone, because counts can coincidentally match while columns still differ.

Report in this exact form:

> Reconcile: `dim_customer.dbml` has **M** columns; source has **N**.
>
> **In source but not in the file** (K): `created_at` (audit — not modelled), `updated_at` (audit), `_dbt_source_relation` (dbt internal).
>
> **In the file but not in source** (J): `customer_sk` (synthesised surrogate key), `loaded_at` (added for SCD2 tracking).

Every entry in "in source but not in the file" must have a specific reason. A class-level reason already declared in Step 2 (e.g. "excluding audit columns") is sufficient — you don't need to restate it per column. But an unexplained entry, or a vague reason like "not needed", means **stop and tell the user** that a column may have been dropped unintentionally. Do not claim the task is complete.

**Rule of thumb:** if your reconcile message doesn't name specific columns on both sides, you skipped a step.

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

**A folder without `dbt_project.yml` is logical-only.** ERD Studio works there as a logical data modelling tool: the canvas shows no Physical tab and no ⊕ Diff, there is no sync plan, and `erd-studio diff` exits with `not-dbt-project` (`doctor` and `export` still work). The `.erd-studio` files are the whole model. Never tell the user they need dbt, and never run dbt there; if they use dbt elsewhere, opening that folder adds the Physical view.

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
10. **Carried forward from logical**: PK/FK/NK flags, grain, the table role, SCD type and additive type — dbt yml does not carry them. `meta` is logical-only and is never read from, or compared with, dbt.

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
4. Write each logical-side change in the project's format: SYNC.md gives the DBML lines (a column line in the Table block, a Ref line in `relationshipsPath`) and the YAML ones (legacy)

<!-- erd-studio-harness: 35 -->
