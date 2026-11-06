---
name: erd-studio
description: >-
  Schema rules for ERD Studio data model files — the .erd-studio/ directory
  holds DBML tables, relationships and diagrams (YAML/JSON for older
  projects) with strict format rules you must read before editing. Use this
  skill whenever the task touches files in .erd-studio/ (.dbml tables,
  relationships .dbml files, .dbml diagrams, older .yml tables and .json diagrams,
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
- **The doctor result has no `erd.storage` field** (an ERD Studio CLI older than 2.0, perhaps a teammate's) → write what the files already are: if a layer folder holds `.dbml` files in `<layer>/tables/`, `<layer>/relationships/` or `<layer>/diagrams/`, DBML; otherwise follow `LEGACY.md`. Tell the user their ERD Studio is older than these instructions.
- **No CLI** (the command is not found, exit 127) → the same rule from the files: any `.erd-studio/**/*.dbml`, or no `.erd-studio/` folder at all, means DBML; only `.yml` tables and `.json` diagrams means `LEGACY.md`.

**Never convert files between the formats by hand**, and never write a `.yml` table or a `.json` diagram into a DBML project. The user converts a project with **ERD Studio: Convert Project to DBML**, one undoable step that doctor's `erd.dbmlConversion` previews. ERD Studio versions before 2.0 cannot read DBML, so converting is the user's decision, never yours.

## Layout (DBML)

```
.erd-studio/
├── README.md                       ← explains the folders; ERD Studio writes it once, leave it
├── layers.json                     ← the layers (JSON); write it first in a new project
├── modelling-approach.md           ← optional: the team's modelling rules (see below)
├── fields.yml                      ← optional: the fields the team records (see "Fields")
└── gold/                         ← a layer folder (bronze, silver, gold, …), named by its id
    ├── tables/                     ← the layer's tables: one Table per file
    │   └── sales/                  ← a schema folder
    │       ├── dim_customer.dbml   ← Table sales.dim_customer
    │       └── fct_order.dbml      ← Table sales.fct_order
    ├── relationships/              ← Refs only, split across files however the team likes
    │   └── gold.dbml               ← the layer's default relationships file
    └── diagrams/
        └── sales.dbml              ← a diagram: use lines, sticky notes, then its Project (positions in erd_layout)
```

Every DBML file sits at one of three depths: `<layer>/tables/<schema>/<name>.dbml`, `<layer>/relationships/<file>.dbml` or `<layer>/diagrams/<name>.dbml`, with `tables`, `relationships` and `diagrams` spelled in lower case. A `.dbml` anywhere else is not read (doctor: `dbmlOutsideKnownFolders`, naming where it belongs).

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

- **Schema folders.** Each table file is `<layer>/tables/<schema>/<name>.dbml` and declares `Table <schema>.<name>`, the qualifier spelled exactly as its folder (case included). The schema is free: a source system, a domain or the warehouse schema.
- A table's **name is its identity everywhere** and is unique across the whole project, every layer and schema, ignoring case: never create a second file with a name that exists in another folder. Tables that share a warehouse name get unique names (`silver_customer`, `gold_customer`), with the warehouse name in `alias`.
- **To find a table**, look for `*/tables/*/{name}.dbml`.
- **Where a new table goes.** In the layer of the diagram you are adding it to. Its schema folder, the rule the canvas's **New Table** follows: the schema the user names; else, for a dbt model with a custom schema, dbt's configured schema (`+schema` / `config.schema`; for a source, its `schema:`), never the built schema in `manifest.json`; else the schema folder most of the diagram's tables in that layer already use; else the layer's name. So adding `fct_sale` to `gold/diagrams/reporting.dbml`, whose gold tables are mostly in `gold/tables/sales/`, creates `gold/tables/sales/fct_sale.dbml` holding `Table sales.fct_sale`; with no gold table in the diagram yet, `gold/tables/gold/fct_sale.dbml` holding `Table gold.fct_sale`. When the layer already has a schema folder spelled differently in case, use its spelling. Keep an existing table's file where it is.
- `tables`, `templates` and `logical-models` are never layer names; `layers.json` ids are lower-case, and the display name is the layer's `label`.

## Edit rules

- **Edit in place and never reformat.** Change only the lines you mean to change; keep comments, order, spacing and every setting you do not understand exactly as they are. ERD Studio does the same.
- **Add a table to a diagram** = a new table file (when no file has that name) + a `use { table <schema>.<name> } from '…'` line in the diagram + a `use * from '…'` line for every relationships file holding a Ref between that table and another table of the diagram, when the diagram does not import it yet.
- **Add a relationship.** First make sure no relationships file already holds a Ref between the same columns of the same two tables: if one does, change it there. Otherwise write one `Ref` line in the relationships file that already holds the most Refs of the foreign-key table (any layer; ties go to the first path); if none does, in `<layer>/relationships/<schema>.dbml` when that file already exists (the table's own schema; never create it), otherwise in the layer's default file `<layer>/relationships/<layer>.dbml` (create it when missing), + a `use` line there for every table the Ref names that the file does not import yet. Then add `use * from '…'` for that file to every diagram that shows both tables and does not import it yet.
- **Change a relationship** (columns, cardinality, role) in the file that holds it. Never move a Ref to another file.
- **Remove a table from a diagram** = delete its `use` line there and its line in the diagram's `erd_layout`. The table file and its Refs stay: the diagram just stops showing them.
- **Rename, move or delete a table**: prefer the canvas or the Table Library (one undoable step). By hand, update every file that points at it in the same change: the table file's path and `Table` line, the `use` lines in relationships files and diagrams, every Ref end, the `erd_layout` lines and sticky notes' `linked_table`.
- **Never hand-merge a conflicted file.** When a file holds git conflict markers (`<<<<<<<` … `>>>>>>>`), show the user the file and line and ask which side to keep; never pick a side yourself or run git commands. A conflict inside a diagram's `erd_layout` only differs in positions: keep either side whole, never a mix of lines.
- **Check your work** with `erd-studio doctor` (its `erd.dbmlProblems` names every problem with its file, line and the exact line to write) and `erd-studio export --domain .erd-studio/<layer>/diagrams/<name>.dbml --format dbml` (the diagram's path from the project folder, `.erd-studio/` included). Fix every `fix-dbml-file` and `fix-fields-file` error before anything else (`erd.fields` gives each fields.yml problem with its line). Then fix every `missingUse`, `missingRelationshipsUse`, `unquotedValue` and `usePathMismatch` warning in a file you wrote (the message gives the exact line): ERD Studio reads on without the fix, but other DBML tools reject the file and every diagram that imports it. Fix a `foreignMetadata` warning too: a Metadata block outside the table's own file, whose values the canvas never shows while other DBML tools apply them; do what its message says: move its properties into the table file (as inline settings in a `.dbml` one) and remove the block. Other warnings are information.
- **Summarise a pull request's model changes** with `erd-studio changes --base <git-ref> --format markdown` (for example `--base origin/main`): the tables, columns, keys, relationships and diagrams changed since that ref, ready to paste as a review comment (`--json` for the same as data). It reads the ref from git and changes nothing.

## Team Modelling Approach

If `.erd-studio/modelling-approach.md` exists, **read it before creating or editing models and follow it.** It records how this team models data — the technique (e.g. Kimball dimensional modelling, Data Vault 2.0), the user's own words, the concrete rules, and how each rule maps onto ERD Studio fields (the table's role, grain, SCD and additive types, natural keys and the other fields, whatever the file format). The `/erd-studio-setup` guide writes it after asking the user; it can also be written or edited by hand. It is free-form markdown: ERD Studio never parses it, and a project without one is valid. When a rule in it conflicts with a user request, say so and ask which wins. If it has a **Target-design backlog** section, the differences between logical and physical listed there are intentional: when a sync plan or diff proposes undoing one, report it as a backlog item and leave it as it is unless the user says otherwise. Which fields a table records is `.erd-studio/fields.yml`'s job; an old **Metadata** section is followed as "Fields" says. A file holding only a title and a Metadata section is valid: no modelling technique has been agreed yet.

## Fields

Read `.erd-studio/fields.yml` before creating or editing a table. It lists every field this project records on tables and on columns, in order (its format: "fields.yml" in `DBML.md`). Without the file, use the starting set: grain, purpose, decisions, open_questions, role, scd_strategy, measures; on columns natural_key, scd_type, additive_type. Fill only listed fields; another key only when the user asks, then offer once to add it to the list.

- Each field is one setting, `<key>: '<value>'`: on the Table line for a table field, on the column for a column field. Quote every value. (A YAML table keeps them in its `rationale:` and `meta:` maps: `LEGACY.md`.)
- type text: what the guidance asks for, in a sentence or two. type value: one short value. type choice: exactly one of its values. type yes-no: 'true' or 'false'.
- filled_by people: write only a value the user gives you; after a batch, say in one line which tables still lack one. filled_by dbt: copy it exactly from the dbt model's meta: `~/.erd-studio-cli/bin/erd-studio inventory --models <name> --json` (`models[].meta`, `columns[].meta`, merged as dbt merges them: `config: meta:` wins, project `+meta` included), else the schema `.yml` (`meta:`, `config: meta:`) and `+meta` in `dbt_project.yml`. Never type one in; no value, no setting. When the file's value differs from dbt's, say so and ask; when the user gives a value, write it and offer to add it to dbt's `meta:` too (never edit dbt unasked). Never copy a key listed under left_out. A list or map in dbt's meta is never a listed field: copy it only when asked.
- show_for dimensions / facts: only on tables with that role.
- Leave a field out when you have nothing true to say. Never write a placeholder.
- open_questions: when you meet a choice you cannot make, write the question there and ask the user. When they answer, move the answer into decisions and remove the question.
- Keep every setting the list does not name exactly as it is.
- Old spellings (`rationale_<key>`, `meta_<key>`, an entry in `meta_json`) are the same field: change it where it is, never add a second copy. Rename only what doctor's `erd.fields` lists as old spellings (`fieldOldSpellings`), and only when the user agrees; never a `meta_json` entry, nor a `meta_<key>` whose key is reserved or a built-in (metadata of its own). Retired fields (design, role_choice, grain_choice): keep them; offer once to move the text into decisions, showing the result first.
- An old `## Metadata` table in `modelling-approach.md` names the team fields while fields.yml has none: Key is the key, On the list (tables, columns), Values a choice or yes-no, Source `dbt` is filled_by dbt, `the team` is people, Left out is left_out. Offer once to move it into fields.yml: show the result, and remove the old section on a yes.
- doctor's `erd.fields` also reports `fieldValueOutsideChoices` (use a listed value, or ask) and `fieldSpelledTwice` (the used spelling stays; offer to remove the other).

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
Write the table's file — the existing file if the table already exists (in whichever folder it is in), otherwise a new file: in a DBML project `.erd-studio/{layer}/tables/{schema}/{name}.dbml` for the layer of the target diagram (see "Where a new table goes" above); in a YAML project the `.yml` path `LEGACY.md` gives. When the source is a dbt model, copy the fields `filled_by: dbt` too (see "Fields").

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

**A folder without `dbt_project.yml` is logical-only.** ERD Studio works there as a logical data modelling tool: the canvas shows no Physical tab and no Compare with dbt button, there is no sync plan, and `erd-studio diff` exits with `not-dbt-project` (`doctor` and `export` still work). The `.erd-studio` files are the whole model. Never tell the user they need dbt, and never run dbt there; if they use dbt elsewhere, opening that folder adds the Physical view.

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
10. **Carried forward from logical**: PK/FK/NK flags, grain, the table role, SCD type and additive type — dbt yml does not carry them. Every other field (and `meta`) is logical-only: ERD Studio never reads it from, or compares it with, dbt.

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
4. Write each logical-side change in the project's format: SYNC.md gives the DBML lines (a column line in the Table block, a new Ref line in `relationshipsPath`, a change to an existing Ref in `storedIn`) and the YAML ones (legacy)

<!-- erd-studio-harness: 46 -->
