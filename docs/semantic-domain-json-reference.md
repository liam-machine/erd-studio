# File format reference

> On screen ERD Studio says **table**, **Table Library** and **diagram** (the commands say *subject area*). A **DBML project** (ERD Studio 2.0, the default for every new project) uses those words in its files too. A **YAML/JSON project** from before 2.0 keeps its own names (`logical-models/` or `tables/`, `logical.models` or `logical.tables`, `domain` or `subjectArea`); see [YAML/JSON projects](#yamljson-projects-schema-v4v6-still-read-and-edited) and the [glossary](glossary.md).

> Context document for AI agents writing ERD Studio files. **Run `erd-studio doctor --json` and read `erd.storage` first:** `dbml` (or no `.erd-studio` folder yet) means write DBML, as the next section says; `yaml` means follow [YAML/JSON projects](#yamljson-projects-schema-v4v6-still-read-and-edited); `mixed` means new tables and diagrams are DBML and an existing file keeps its format. Never convert a project by hand: **ERD Studio: Convert Project to DBML** does it in one undoable step. The authoritative, always-current copy of this guidance is the `SCHEMA_CONTENT` string in `src/services/harnessService.ts`, which **Set Up My AI Helper** installs (`SKILL.md`, `DBML.md` and `LEGACY.md`).

## DBML project (2.0, the default)

DBML is an open format, the schema language behind dbdiagram.io. ERD Studio stores a project as plain `.dbml` files that DBML parsers 9.1 and 11+ read as a multi-file project (10.x too, unless a folder in the project's path has a space; `doctor` warns `pathWithSpace`). The canvas edits these files in place: comments, formatting and every DBML setting ERD Studio does not use survive, and a save that changes nothing leaves a file byte for byte as it was. The table positions are not DBML: they live in a `.dbdiagram` JSON file beside each diagram.

### Layout

```
.erd-studio/
├── layers.json                     JSON, the same in both formats (see Layers File)
├── templates/*.json                JSON, optional table templates
├── modelling-approach.md           optional: the team's modelling rules, for AI assistants
├── tables/                         the Table Library (never a layer in a DBML project)
│   ├── dim_date.dbml               one Table per file, named exactly as the table
│   ├── _relationships.dbml         Refs owned by the top-level tables (only when there are any)
│   └── gold/                       optional folder, one level only (any name not starting with ".")
│       ├── dim_customer.dbml
│       ├── fct_order.dbml
│       ├── bridge_empty.dbml       a table with no columns yet (placeholder column)
│       └── _relationships.dbml     Refs owned by tables in tables/gold/
└── gold/                           a layer folder: one per id in layers.json
    ├── sales.dbml                  a diagram
    └── sales.dbdiagram             its layout (positions, sticky-note boxes); absent until something is placed
```

A new project also needs `.erd-studio/layers.json` (see [Layers File](#layers-file-erd-studiolayersjson)). Library folders work as in a YAML project (organisational only, opt-in per project; see [Table file location](#table-file-location)), with `.dbml` in place of `.yml`. A name is unique across the whole library, case-insensitively, whatever folder it is in.

### Table file (`tables/[<folder>/]<name>.dbml`)

**Exactly one `Table`**, plus optional comments and `Enum` declarations (self-contained column types). Nothing else: no `use` line, no `Ref` line and no inline `[ref: …]` setting (relationships go in the folder's `_relationships.dbml`), and no `Project`, `TableGroup`, top-level `Note`, `TablePartial`, `Records` or `DiagramView`. A table with a `use`, `Ref` or `[ref: …]` still loads, with a warning that gives the exact line to move, but ERD Studio refuses to save it until that line is moved; any other extra construct makes the file unreadable.

```dbml
// Order lines from the shop. Hand-written comments like this one survive every save.
Table fct_order [
  schema: 'gold',
  role: 'transaction-fact',
  grain: 'One row per order line',
  alias: 'orders',
  rationale_purpose: 'Revenue reporting by day, customer and region',
  rationale_measures: 'amount is additive',
  meta_owner: 'sales-data',
  meta_json: '{"pii":false,"tags":["finance"]}'
] {
  order_line_id BIGINT [pk, note: 'Line id from the shop']
  customer_key INT [foreign_key: 'true']
  amount "DECIMAL(18,2)" [additive_type: 'additive', note: 'Line total']
  order_number VARCHAR [natural_key: 'true'] // the business key
  loaded_at timestamp [not null, default: `now()`]   // DBML-only settings: kept, never read
  Note: 'Order lines'
}
```

A composite primary key is an `indexes` block, and a table with no columns yet holds ERD Studio's placeholder column (DBML needs at least one):

```dbml
Table dim_customer [schema: 'gold', role: 'conformed-dim'] {
  customer_key INT [note: 'Surrogate key']
  valid_from DATE [scd_type: '2']
  customer_id VARCHAR [natural_key: 'true']
  parent_customer_key INT [foreign_key: 'true']
  segment VARCHAR [scd_type: '1']
  indexes {
    (customer_key, valid_from) [pk]
  }
}
```

```dbml
Table bridge_empty {
  _erd_no_columns unknown [erd_placeholder: 'true', note: 'ERD Studio: this table has no columns yet, and DBML needs one']
}
```

**Quote every custom value, even `'true'` and numbers** (`natural_key: 'true'`, `scd_type: '2'`). ERD Studio reads an unquoted `true` or `2` (DBML 11), but DBML 9 and 10 tools reject the whole file and every diagram that imports it, so `doctor` warns (`unquotedValue`) with the quoted line. An unquoted word or phrase (`role: fact`, `grain: one row`) is an error in every parser, ERD Studio's included: "Quote the value, as in grain: 'One row per order line'."

**Field names** (the same names the rich export and Import DBML use; each also accepted with an `erd_` prefix on read):

| ERD Studio field | DBML |
|---|---|
| table name | `Table <name>`: unqualified, and the file stem equals it exactly. A hand-written `Table gold.x` is read with schema `gold` |
| `schema` | `schema: 'gold'` |
| description | the body's `Note: '…'` (or a header `note:` setting, edited where it is) |
| `modelRole` | `role: 'transaction-fact'` (values in [TableRole](#tablerole-enum)) |
| `grain` | `grain: '…'` |
| `alias` (warehouse table name) | `alias: 'orders'` (never DBML's own `as`, which ERD Studio reads but never writes) |
| `rationale.<key>` | `rationale_<snake_case>: '…'` (`rationale_purpose`, `rationale_measures`, …) |
| `meta` | `meta_<key>: '<text>'` for a text value under a plain lowercase key; everything else in **one** `meta_json: '<JSON>'`, in the map's key order (`meta_json` stands where its first entry is, and a text value between two of its entries goes into it) |
| column name, type | `<name> <type>`; a type that is not a plain identifier is quoted (`"DECIMAL(18,2)"`) |
| primary key | `pk` on one column; two or more as `indexes { (a, b) [pk] }` |
| column description | `note: '…'` |
| foreign key flag | `foreign_key: 'true'` (stored as the flag says, never derived from Refs) |
| natural key | `natural_key: 'true'` |
| SCD type | `scd_type: '0'` / `'1'` / `'2'` |
| additive type | `additive_type: 'additive'` / `'semi-additive'` / `'non-additive'` |
| column `meta` | as table `meta` |

Settings ERD Studio does not model (`not null`, `unique`, `increment`, `default`, `headercolor`, `check`, other `indexes`, Enums, comments, custom properties it does not know) are never read and are kept byte for byte. A `Metadata Table x { … }` / `Metadata Column x.c { … }` block (DBML 9.1+) in a table file is read like an inline setting and edited where it sets a value; ERD Studio never writes one, A block whose target the file does not declare makes the table unreadable ("A Metadata block on line N targets …"; the table shows as unreadable until you rename or remove the block); `doctor` lists it as a warning.

### Relationships file (`tables/[<folder>/]_relationships.dbml`)

One file per library folder holds **every relationship whose foreign-key table lives in that folder**, one `Ref` line each. It needs one `use { table x } from '<path>'` line for **every table its Refs name** (`use` is not transitive: without the line, other DBML tools fail the file and every diagram importing it).

```dbml
// ERD Studio relationships. Each Ref belongs to its foreign-key table, which lives in this folder; every table a Ref names has a use line here.
use { table dim_date } from '../dim_date.dbml'
use { table customer_profile } from './customer_profile.dbml'
use { table dim_customer } from './dim_customer.dbml'
use { table dim_region } from './dim_region.dbml'
use { table fct_order } from './fct_order.dbml'

Ref: dim_customer.customer_key ?- customer_profile.customer_key
Ref region: customer_profile.preferred_region_code <>? dim_region.region_code
Ref parent: dim_customer.parent_customer_key >? dim_customer.customer_key
Ref: fct_order.customer_key >? dim_customer.customer_key
Ref "order date": fct_order.order_date_key >? dim_date.date_key
Ref "ship date": fct_order.ship_date_key >? dim_date.date_key
Ref region: fct_order.(region_code, country_code) >? dim_region.(region_code, country_code)
```

| Relationship (`from` = the foreign-key side) | Written as |
|---|---|
| many-to-one | `Ref: from.fk >? to.pk` |
| one-to-one | `Ref: to.pk ?- from.fk`: **the key end first, the foreign key second**, as DBML and its SQL export read it. Writing it foreign key first (`Ref: fct.fk - dim.pk`) is read by the keys and may be misread |
| many-to-many | `Ref: from.fk <>? to.pk` |
| composite foreign key | **one** Ref: `Ref: fct.(a, b) >? dim.(a, b)` |

- The `?` marks the foreign-key end as possibly null (ERD Studio records no nullability, and DBML reads a bare `>` as NOT NULL). It never changes the cardinality; it only says which end of a one-to-one is the foreign key. ERD Studio reads every operator, including `<` and a bare `>` / `-` / `<>`.
- **Name a Ref only to give it a role; the name is shown on the line** (`Ref "order date": …`). Two Refs may share a name. A constraint name such as `fk_orders_customer` is shown too.
- Spell each end with the table's and column's real names, in their real case (DBML is case-sensitive).
- **One Ref per pair of column sets, in one file only**: the same link in two relationships files, or twice in one, is an error in every DBML tool (`duplicateRef`).
- A self-reference is an ordinary Ref (`dim_customer.parent_customer_key >? dim_customer.customer_key`); a column pointing at itself is refused.
- A Ref in another folder's file is *misplaced*: drawn, with a warning, and moved home by ERD Studio's next write to that table's relationships. A Ref whose foreign-key table has no `.dbml` file is *orphaned* and not drawn.
- Settings on a Ref (`[delete: cascade]`, `[color: …]`) are kept.
- **Pending relationships** (since 2.0): a whole-line comment `// erd-studio pending: Ref: fct_order.risk_key >? gld_fct_risk.risk_key`, after the Refs, is a relationship ERD Studio keeps and draws but cannot write as a live Ref yet: an end has no `.dbml` table file (none yet, or a table still in YAML) or no such column. A live Ref there would break the whole file in every DBML tool, so it is a comment, and other DBML tools do not show it. It belongs to its foreign-key table like a Ref. ERD Studio turns it into a live Ref, with its `use` line, on its next write to the file once both ends have table files with those columns (Add from dbt makes the table; Convert Project to DBML does it too). Keep these lines as they are; delete one to delete the relationship. `doctor`: `pendingRelationship` (a warning).
- A relationships file is never deleted automatically. Once its last Ref goes it keeps its header and no `use` lines, because diagrams `use` it.

### Diagram file (`<layer>/<name>.dbml`)

```dbml
Project sales {
  Note: 'Sales star schema'
  erd_schema_version: '7'
  erd_show_fk_edges: 'false'
  erd_layout_options: '{"elk.direction":"RIGHT"}'
}

use { table fct_order } from '../tables/gold/fct_order.dbml'
use { table dim_customer } from '../tables/gold/dim_customer.dbml'
use { table dim_date } from '../tables/dim_date.dbml'
use * from '../tables/_relationships.dbml'
use * from '../tables/gold/_relationships.dbml'

Note "3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c" [color: #f59e0b, linked_table: 'fct_order'] {
  'Check the grain with finance'
}
```

1. **`Project <name>`**: the diagram's name, its description as `Note`, and ERD Studio's keys, each a quoted string: `erd_schema_version: '7'` (always), `erd_show_fk_edges` (`'true'` / `'false'`), `erd_layout_options` (JSON), `erd_model_folder`, `erd_stub_columns` (a JSON list), `erd_unlinked_tables` (below). Other Project keys (`database_type`, a team's own) are kept. The layer is always the folder the file is in.
2. **Table `use` lines**: the diagram's tables, in order, one `use { table <name> } from '<path to the table file, relative to this diagram, with .dbml>'` each. The table is the **file name** of the path; ERD Studio finds it by name, so a wrong path draws the table anyway, with a `doctor` warning (`usePathMismatch`), and the next edit rewrites the line.
3. **Relationships `use` lines**: `use * from '…/_relationships.dbml'` for every library folder holding one of the diagram's tables. They are for other DBML tools (ERD Studio draws every relationship whose two tables are in the diagram); a missing one is a warning (`missingRelationshipsUse`).
4. **Sticky notes**: `Note "<id>" [color: <hex>, linked_table: '<table>'] { '<text>' }`, one per note.

**Tables on the diagram with no table file** (since 2.0): `erd_unlinked_tables: 'gld_fct_risk_child, gld_fct_risk_parent'` on the Project lists them, as one comma-separated string (DBML Project keys take no lists), after the `use` members. They are tables with no `.dbml` file to `use` yet: none at all (a dbt model not drawn yet), or one still stored as YAML. ERD Studio reads each by name, like any member: with no table file it is drawn as missing, at its position in the layout file, exactly as a JSON diagram draws a missing table; a YAML table is drawn from its file. When the table gets a `.dbml` file through ERD Studio (Add from dbt, New Table, Import, Convert), the name moves to a `use` line; removing the table from the diagram removes the name; the key is never written empty. Other DBML tools do not show these tables (a `use` line to a file that does not exist would break the diagram for them). `doctor`: `unlinkedTable` (a warning).

**The diagram's own pending relationships** (since 2.0): `// erd-studio pending: Ref: …` lines after the `use` lines hold relationships the diagram itself drew whose foreign-key table has no `.dbml` file, so they cannot live in the library yet. ERD Studio draws them in this diagram only, as a JSON diagram drew its own relationships, and Convert Project to DBML moves each to the library once its table has a file. Keep them as they are.

A diagram holds **no** Refs (only those pending lines) and no Tables. A Table, Ref, TableGroup, Enum or Metadata block written in a diagram is kept but not drawn (a warning). A `.dbml` in a layer folder that declares Tables and has no table `use` lines is a single-file DBML (a dbdiagram.io download or an export): the canvas offers **Import these tables…** and `doctor` raises `import-dbml-file`.

### Layout file (`<layer>/<name>.dbdiagram`)

dbdiagram's layout JSON. ERD Studio owns `defaultView.tablePositions` (`{ name, schemaName: "public", x, y }` per table) and `defaultView.stickyNoteLayouts` (`{ name: <note id>, x, y, width?, height? }`) and keeps every other key. Leave it out for an automatic layout; ERD Studio writes it when something is placed. A sticky note with no layout entry is placed to the right of the tables. It opens in VS Code as JSON.

### DBML editing quick reference

| To… | Edit |
|---|---|
| Add a table | create `tables/[<folder>/]<name>.dbml`, add its `use { table <name> } …` line to each diagram that shows it (and the relationships `use` line for its folder if the diagram has none) |
| Change columns, keys, grain, role, description, rationale, meta | the table's `.dbml`, in place |
| Add or change a relationship | a `Ref` line in the `_relationships.dbml` of the **foreign-key table's** folder, plus the `use` lines that file needs |
| Remove a table from a diagram | delete its `use` line in that diagram (the table file stays in the library) |
| Delete a table | prefer **Delete Table** in the Table Library: it removes the file, its Refs, other Refs to it and every `use` line naming it, in one undoable edit |
| Rename a table | prefer the canvas: it renames the file and rewrites every `use` line and Ref |
| Check your work | `erd-studio doctor` and `erd-studio export --domain .erd-studio/<layer>/<name>.dbml --format dbml` |

Edit in place and never reformat a file: ERD Studio keeps whatever it does not change.

### Names and case

- The file stem and the declared table name must match; ERD Studio compares them without case, so `Dim_Customer.dbml` holding `Table dim_customer` loads, with a `doctor` warning (`nameCaseDrift`: `git mv` it to match). A diagram, `use` path or Ref must spell a table as it is declared.
- `_relationships` is reserved for the relationships file: no new `.dbml` table may be called that.
- Names ERD Studio creates start with a letter and hold only letters, digits and `_`; any name dbt allows is read.

### DBML validation rules

1. **Any parser error makes that file unreadable**, and only that file: a table file renders as a placeholder ("DBML error on line N"), a diagram opens on an error page, and a relationships file's broken Ref is skipped. Other DBML tools fail the whole project, so `doctor` lists every problem with its line.
2. Quote every custom value (above).
3. Every table a relationships file's Refs name needs a `use` line in that file; every table a diagram shows needs a table `use` line there, except one with no table file, which `erd_unlinked_tables` names instead. A relationship to a table with no file is a pending line, never a live Ref.
4. A table name is unique across the library, and each link is one Ref, in one file.
5. Every table has at least one column (the placeholder for an empty one).
6. `erd_schema_version` above 7 is refused: "Please update the extension".

**Unresolved git merge conflicts.** A `.dbml` or `.dbdiagram` file that still holds git's conflict markers is reported as a merge conflict with its line (`doctor`: `mergeConflict: true`, routed to `resolve-merge-conflicts`). In a `_relationships.dbml` **keep both sides' Ref lines and both sides' `use` lines**, then run `doctor`: a Ref that now appears twice is reported (`duplicateRef`). In a table file keep one side of each conflict. When only a `.dbdiagram` conflicts, either side is safe to keep.

**Large libraries.** Every Ref of a folder lives in that folder's `_relationships.dbml`, so a flat library of thousands of tables puts every relationship in one file: merge conflicts concentrate there, and other DBML tools load every table of the folder for any diagram (one broken table there breaks those diagrams in other tools, never in ERD Studio). Use library folders to split it.

### A complete DBML example

The project in [`test/fixtures/dbml-native/`](../test/fixtures/dbml-native) is a complete, logical-only DBML project: `layers.json`, `tables/dim_date.dbml` and `tables/_relationships.dbml` (a self-reference), `tables/gold/` with five tables (a composite key, SCD types, an Enum, DBML-only settings, an empty table) and its `_relationships.dbml` (a composite, roles, a self-reference, a one-to-one and a many-to-many), `gold/sales.dbml` with its `.dbdiagram` and two sticky notes, and `silver/staging.dbml` with no layout file (automatic layout). The snippets above are taken from it.

## YAML/JSON projects (schema v4–v6, still read and edited)

A project created before ERD Studio 2.0 keeps YAML tables and JSON diagrams. Everything below describes them, and ERD Studio still reads and edits every shape listed, including the "still read" notes. Run **ERD Studio: Convert Project to DBML** to move one over (a dry run first, one undoable edit, a preview in `erd-studio doctor`); never convert by hand. Convert never guesses: a file it cannot read or write as DBML stays exactly as it is (the project is then `mixed`) and is listed with its problem; running Convert again after fixing it finishes the job. A table a diagram lists that has no table file stays on the converted diagram (`erd_unlinked_tables`), drawn as missing as before.

### File Layout

ERD Studio keeps a **central Table Library**. Each table is a YAML file in `.erd-studio/logical-models/` — `.erd-studio/tables/` in the v6 naming — (at the top level or one folder down); subject area JSON files reference tables **by name** and hold the layout. Relationships are defined once, in the YAML of the table holding the foreign key, and drawn by every subject area holding both tables — or, in a project that keeps them per subject area, in each subject area JSON (see [Where relationships live](#where-relationships-live)).

```
.erd-studio/
  layers.json                 ← layer definitions
  modelling-approach.md       ← optional: the team's modelling rules, for AI assistants
  logical-models/             ← the Table Library: one YAML per table, shared across subject areas
    dim_customer.yml          ← top level (flat libraries keep working)
    bronze/                   ← optional per-layer folders
      sap__mara.yml
    silver/
      fct_order_line.yml
  templates/                  ← optional table templates
    dimension.json
  silver/                     ← one directory per layer id
    sales.json                ← subject area file
  gold/
    reporting.json
```

There are two stages. **Logical** is the editable stage stored in the subject area file and table YAMLs. **Physical** has no files — it is derived at runtime from the dbt project (source files, schema YAMLs, `{target-path}/manifest.json`, `{target-path}/catalog.json`); see [Physical Stage](#physical-stage-derived-read-only) below for the full resolution rules. Table and column names match case-insensitively. Do not create files for the physical stage; the only writes allowed while a canvas shows it are to the shared `viewConfig` (positions, annotations).

#### Table file location

- A table file lives at `logical-models/{name}.yml` **or** exactly one folder down at `logical-models/{folder}/{name}.yml`. By convention the folder is a layer id (`bronze`, `silver`, `gold`). Deeper nesting and dot-folders are not scanned.
- The folder is organisational only: subject area files reference tables by **name**, and names are **unique across the whole library**, as dbt model names are across a project.
- **Lookup:** the top-level file first, then each folder in alphabetical order. A second file with the same name elsewhere is *shadowed* — ignored, flagged in the Table Library view, and named in a warning when a canvas that uses the name opens. **Give Duplicate Table Its Own Name** fixes it: the ignored copy becomes `{folder}_{name}` with `alias: {name}`, and the subject areas of that folder's layer are repointed at it in the same edit.
- **The same warehouse table name in two layers** is two tables with the same `alias`: `silver/silver_date.yml` and `gold/gold_date.yml`, both `alias: date` — the pattern a dbt project uses for two `date` tables (unique dbt model names, `alias` + `schema` for the relation). The canvas labels each node `date`, or `silver.date` / `gold.date` when both are on one canvas.
- **Folders are opt-in per project.** A library uses layer folders once any table file sits in a folder named after a layer in `layers.json` (or while it is empty); a hand-made folder such as `Staging/` does not count. Then a new table created from a canvas is written to the folder of the layer of the subject area it is added to (`gold/reporting.json` → `logical-models/gold/`). A flat library stays flat: new files go to the top level until someone runs **ERD Studio: Organise Table Library by Layer**. Opting in is a team decision — a teammate on ERD Studio before 1.2.0 only reads the top level and would see tables in folders as missing. A rename keeps the file in its folder.
- **Organise Table Library by Layer** moves each file into the folder of the one layer whose subject areas reference it: top-level files, and files sitting in *another* layer's folder (the subject areas that use it moved layer). A table used by several layers, or by none, stays where it is. Folders that are not a layer in `layers.json` (a hand-made `Staging/`, or a layer id since removed) are never touched and are named in the confirmation. Re-running it is always safe.
- Hosts that cannot list directories (the `@erd-studio/core` `loadDisplaySubjectArea` viewer) probe the top level, then every layer folder alphabetically (the extension's order), so they see only folders named after a layer.

The base directory name (`.erd-studio`) is configurable via the `erdStudio.semanticDir` setting.

<a id="domain-file-erd-studiolayerdomainjson"></a>

### Subject Area File (`.erd-studio/{layer}/{domain}.json`)

One JSON file per subject area. The file and its `domain` field keep the old name.

#### Top-Level Schema

```jsonc
{
  "schemaVersion": 5,                    // REQUIRED. Must be 5.
  "domain": "sales",                     // REQUIRED. Slug; matches filename without .json.
  "layer": "silver",                     // REQUIRED. Must match a layer id from layers.json and the parent directory.
  "description": "Sales subject area",   // Optional. Defaults to "".
  "modelFolder": "models/silver",        // Optional. Filters the "Add Existing Table" dialog.
  "stubColumns": ["dim_date"],           // Optional. Tables whose physical-only columns are ignored in sync comparison.
  "logical": {
    "models": ["dim_customer", "fct_order_line"],   // REQUIRED. Table NAME STRINGS (refs to logical-models/[folder/]*.yml).
    "relationships": []                             // REQUIRED. Array of Relationship objects.
  },
  "viewConfig": {}                       // REQUIRED. Root-level UI state (positions, annotations, layout options).
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | number | Yes | Must be `5`. |
| `domain` | string | Yes | The subject area's slug. Should equal the filename without `.json`. |
| `layer` | string | Yes | Must match an `id` in `layers.json` and the parent directory name. |
| `description` | string | No | Human-readable subject area description. |
| `modelFolder` | string | No | Path prefix filter for the "Add Existing Table" dialog (e.g. `"models/silver"`). |
| `stubColumns` | string[] | No | Table names (typically conformed dimensions / reference tables) that define only key columns. Missing-column discrepancies for these tables are hidden; extra and type-mismatch discrepancies still surface. |
| `logical.models` | string[] | Yes | Table **name strings**. Each must correspond to `.erd-studio/logical-models/{name}.yml` or `.erd-studio/logical-models/{folder}/{name}.yml`. |
| `logical.relationships` | array | Yes | Array of `Relationship` objects. |
| `viewConfig` | object | Yes | Persisted UI layout. Must be at the root, not inside `logical`. |

#### Format detection and supported versions

The extension decides how to read a file with a single detector (`detectSubjectAreaFormat` in `packages/core/src/types/semantic.ts`). Every reader and writer uses the same rules:

| Format | Shape | Behaviour |
|--------|-------|-----------|
| `v6` | `schemaVersion: 6`, `logical.tables` is all strings (or empty), the v6 names throughout | **Read and written** ([below](#schema-v6-the-table-naming)): the naming a new or migrated project writes. |
| `v5` | `schemaVersion: 5`, `logical.models` is all strings (or empty) | Current format, and the one ERD Studio writes. Fully supported. |
| `v4` | `schemaVersion: 4`, `logical.models` is all inline table objects | Deprecated but still loads. On activation the extension prompts to run **ERD Studio: Migrate Subject Areas to the Central Table Library**, which extracts each object to `logical-models/{layer}/{name}.yml` (the subject area's layer folder; the top level when the library already holds flat files, or when several layers inline the table) and replaces it with its name. |
| `hybrid` | `schemaVersion: 5` with inline objects, a mix of strings and objects, or entries that are neither | **Rejected** with an error pointing at the migration command. Migration repairs it (inline objects are extracted — existing YAML files are never overwritten). |
| `hybrid` (names) | v5 and v6 names in one file (`logical.models` beside `logical.tables`, or `domain` beside `subjectArea`), v6 names under `schemaVersion` 5 (an older reader would draw it empty), or v5 names under `schemaVersion` 6 | **Rejected** with an error naming the mix. The migration leaves it alone; keep one set of names. `erd-studio doctor` gives it a `fix-subject-area-naming` step. |
| `legacy` | `schemaVersion` below 4, and/or a top-level `models` array instead of `logical` | **Rejected** with an error. Migration lifts `models`/`relationships` under `logical`, drops `stage`, and converts to v5. |

Never produce hybrid or legacy files. When adding a table to a subject area, add its **name string** to `logical.models` and create the YAML file if it does not exist.

A `schemaVersion` higher than the extension reads (7 and up, today) is refused with "Please update the extension", never drawn as an empty diagram.

<a id="schema-v6-the-table-naming-read-only"></a>

#### Schema v6: the table naming

Schema v6 ([#162](https://github.com/liam-machine/erd-studio/issues/162)) renames every on-disk key that names a *model* or a *domain*. ERD Studio reads it from the release after 1.6.9 ([#181](https://github.com/liam-machine/erd-studio/issues/181)) and writes it from the release after that ([#182](https://github.com/liam-machine/erd-studio/issues/182)). **Write the naming `erd-studio doctor` reports** (`erd.naming`): a v5 project keeps writing v5 until it migrates; a v6 project, a mixed one and a new one write v6.

| v5 (still read, and written by a v5 project) | v6 |
|---|---|
| `.erd-studio/logical-models/` | `.erd-studio/tables/` (top level or one folder down, as before) |
| `logical.models` | `logical.tables` |
| `domain` (top-level field) | `subjectArea` |
| `fromModel` / `toModel` (subject area JSON; `toModel` in table YAML) | `fromTable` / `toTable` |
| `modelRole` (table YAML) | `tableRole` |
| `linkedModel` (an annotation in `viewConfig.annotations`) | `linkedTable` |
| `schemaVersion: 5` | `schemaVersion: 6` |

Unchanged: `modelFolder` (it is dbt's `models/` path filter), the `.erd-studio/{layer}/{name}.json` path, `layers.json`, templates, and every other key.

- **Reading.** A v6 file is read into exactly what its v5 twin reads into, so the canvas, `erd-studio diff` / `export` and the Confluence viewer show the same diagram. A table YAML is read by key, wherever it is: `tableRole` and `toTable` win over `modelRole` and `toModel` when a file writes both.
- **Library lookup.** `logical-models/` first (top level, then each folder alphabetically), then `tables/` in the same order. The Confluence viewer, which cannot list folders, probes the same paths.
- **Writing.** Every edit keeps the naming its file already uses: a v6 subject area is written back in v6, a v5 one in v5, and a table file in `tables/` (or one that already uses a v6 key) gets v6 keys, so a key the edit adds (a role, a relationship) is written as `tableRole` / `toTable`. New tables go to `tables/` and new subject areas are written in v6 when the project's naming is `v6` or `mixed`, or when the project has no table library yet; a v5 project's go to `logical-models/` in v5, byte for byte as before. **Move Relationships to Table Library**, **Organise Table Library by Layer** (within each folder), **Give Duplicate Table Its Own Name**, **Rename Subject Area**, **Delete Table** and **Draw from dbt** do the same.
- **The migration.** **ERD Studio: Migrate to the New File Naming** moves a v5 project to v6 in one undoable step (**Edit > Undo** straight after, while an editor is open, restores every file byte for byte; after that, use source control): every table file from `logical-models/` to `tables/` (a folder one level down moves with its files), and in each file only the renamed keys and `schemaVersion` change — comments, key order, quoting, anchors, unknown keys, number text, line endings and every relationship as stored (`one-to-many`, a backwards `many-to-one`) are kept. A second run has nothing to do. It shows the whole plan first and refuses, saying why, a project with a layer called `tables`, a table name in both folders, two files whose paths differ only in case, and a subject area file that does not load. A subject area still in v4 with inline tables goes through **Migrate Subject Areas to the Central Table Library** first, which carries straight on into the new naming (a v4 file with no inline table is renamed in place). `erd-studio doctor` previews it under `erd.namingMigration`; the CLI never runs it. Opening a canvas on a v5 or mixed project offers it once a session (**Review the Migration…**, **Not Now**, **Don't Ask Again**), before any other offer on that open; nothing is written without the user's choice.
- **Mixed projects** (both folders, or v5 and v6 subject area files side by side) read everything and write v6 for new files. A table name found in both folders (ignoring case) is a **conflict**: the `logical-models/` copy is used, the canvas warns, and `erd-studio doctor` lists it under `erd.namingConflicts` with a `resolve-naming-conflicts` step. Keep one of the two files.
- **A layer called `tables`.** A project made before v6 may already have one. `tables/` is a **layer folder**, never the library, when `layers.json` lists a layer with id `tables` or the folder holds a subject area file (`tables/*.json`), and it is never the library until it holds a table file (so an empty `tables` layer folder stays a layer); it keeps loading as before, the project stays on the v5 naming, and `erd-studio doctor` says `file naming v5 (tables/ is a layer folder)`. The migration refuses until that layer is renamed. **Add Layer** refuses the id `tables`.
- **Don't mix the names in one file.** A table YAML holding both `modelRole` and `tableRole` (or both `toModel` and `toTable` in one relationship) is read — the v6 key wins — but ERD Studio refuses to edit it until one is removed. An empty `tables/` folder does not count: `tables/` is the library once it holds a table file.
- **Case.** A name that differs only in case between the two folders is a conflict like any other, and the extension reads the `logical-models/` copy on every file system. The Confluence viewer cannot list folders, so it probes exact file names and may read the other copy on a case-sensitive host: resolve the conflict.
- **The project's naming.** `erd-studio doctor` reports `erd.naming`: `v5`, `v6` or `mixed` (core's `detectProjectNaming`), from the folders and subject area files on disk. An empty `logical-models/` keeps a project v5 unless `tables/` is the library; a project with neither folder is `v6`.
- **Older versions.** 1.6.9 and earlier refuse a v6 subject area with "Please update the extension"; they do not see a `tables/` library at all, so a table that lives only there is missing for them. Teammates need the release that reads v6 before a project migrates, so a team moves to v6 together.

<a id="model-files-erd-studiological-modelsfoldernameyml"></a>

### Table Files (`.erd-studio/logical-models/[{folder}/]{name}.yml`)

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
| `name` | string | Yes | Table name. Must equal the filename without `.yml`. |
| `schema` | string | No | Target schema the table materialises in. |
| `alias` | string | No | Warehouse table name when it differs from `name` — dbt's `alias` config. A plain identifier (letters, digits, underscores; case kept). `name` stays the identity everywhere; the canvas shows the alias, qualified by `schema` when two tables on one canvas share it. Set from the detail panel's **Warehouse name** row. |
| `description` | string | No | Human-readable description. |
| `grain` | string | No | Grain statement: "One row per ___". |
| `modelRole` | string | No | Role in the warehouse architecture. See TableRole enum. |
| `columns` | array | No | Array of `ColumnDef`. |
| `rationale` | object | No | Design rationale. Omit entirely if empty. |
| `meta` | map | No | Free-form, dbt-style metadata (owner, source system, lineage…). See [Metadata](#metadata-meta). Omit entirely if empty. |
| `relationships` | array | No | Relationships leaving this table — it holds the foreign key: `Relationship` objects without `fromModel` (it is this table). Shared by every subject area holding both ends. See [Where relationships live](#where-relationships-live). Omit entirely if empty. |

Tables are defined once and can be referenced from several subject areas. Editing a table from any subject area's canvas updates the shared YAML.

**YAML quoting.** A table file that does not parse loads as an empty placeholder (the canvas warns; `erd-studio doctor` and `erd-studio diff` report it as a blocking `fix-model-yaml` with the file and line). Write each key once per block. A key written twice is the one exception to "does not parse": the table loads with the **last** copy's value, as dbt's PyYAML reads it, and the canvas shows a warning naming the key and line. The file is still reported as `fix-model-yaml`, and ERD Studio refuses to write it until one copy is removed. (Older releases loaded such a file as the placeholder; it is still read either way.) Wrap every `description`, `grain`, `rationale` and `dataType` value in double quotes (escape an inner `"` as `\"`), or use a `|` block for multi-line text. Always quote a value that contains `: ` or ` #`, or starts with any of `` ` @ * & ! % [ { - | > ' " ``. Indent with spaces, never tabs. One YAML document per file: no `---` separators, no markdown code fences, no `{{ doc() }}` — paste the text itself. (A byte-order mark and CRLF line endings are fine.)

#### Column Definition (ColumnDef)

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

**`data_type` (still read).** A column whose type is spelled the way dbt's schema.yml spells it, `data_type:`, is read as `dataType` (#144). When a column has both keys, `dataType` wins whenever it holds a value (even `""`); `data_type` is used only when `dataType` is absent or null. ERD Studio writes `dataType` only: the next time it writes that table's file — any canvas edit to that table or to a relationship stored in it (including one Draw from dbt or Add Existing Table adds there, and a rename elsewhere that reaches it); moving nodes and **Move Relationships to Table Library** leave the file's columns as written — it renames each `data_type` the reader used to `dataType` in place (its value and comment unchanged; an empty `dataType:` beside it is dropped), and leaves a `data_type` that sits beside a `dataType` holding a value alone. When the empty `dataType` (its key or value) or the `data_type` key carries a YAML anchor (`dataType: &x`), neither key is renamed or dropped — an alias such as `*x` would lose its anchor or change meaning — and the column's type is written to `data_type`, where the reader takes it from. `erd-studio doctor` lists the files and columns that use it (`erd.dataTypeAliasFiles[].columns`), and separately the columns where `data_type` sits beside a winning `dataType` and is ignored (`.ignored`) — those stay listed until the `data_type` is deleted — and the anchored ones kept as written (`.anchored`). Write `dataType`; the JSON schema still flags `data_type` as an unknown key.

#### TableRole Enum

| Value | Use Case |
|-------|----------|
| `conformed-dim` | Shared dimension reused across subject areas |
| `domain-dim` | Dimension specific to this subject area |
| `transaction-fact` | Discrete event fact |
| `periodic-snapshot` | Recurring measurement per period |
| `accumulating-snapshot` | Lifecycle with milestones |
| `factless-fact` | M:M bridge table, FKs only |
| `reference` | Low-cardinality lookup |
| `gold-fact` | Pre-joined Gold view |
| `gold-dim` | Flattened Gold dimension view |

#### Rationale

Optional object documenting the reasoning behind a table's design. All fields are optional strings. If all fields would be empty, omit `rationale` entirely. The canvas shows an "R" badge on tables that have rationale.

| Field | Description |
|-------|-------------|
| `purpose` | What requirements or purpose this table fulfils |
| `design` | Why the table was designed this way — trade-offs, constraints, patterns |
| `roleChoice` | Why this table role (`modelRole`) was selected |
| `grainChoice` | Why this grain was chosen over alternatives |
| `scdStrategy` | Overall SCD strategy across dimension attributes |
| `measures` | Why measures are structured this way — additive type choices |

#### Metadata (`meta`)

Optional map on a table and on any column, named after and shaped like dbt's `meta:`. Keys are strings; values may be text, numbers, booleans, `null`, lists or nested maps (`MetaValue = string | boolean | null | MetaValue[] | { [key]: MetaValue }`; numbers are read as their source text, like every other field). A `meta` that is not a map, or is an empty map, is ignored.

- **Never compared with dbt.** `meta` is logical-only: the physical stage does not read dbt's `meta:`, and discrepancy reports, `erd-studio diff` and sync plans ignore it.
- **Canvas.** The Detail panel's **Metadata** section (for the table, and inside each expanded column row) lists every entry. Top-level text values can be added, edited and removed there; nested maps, lists, booleans and `null` are shown read-only — edit them in the file.
- **Writes are surgical.** A canvas edit rewrites only the top-level key that changed; comments, unquoted numbers, nested values and aliases elsewhere in `meta` stay byte-identical. Removing the last key removes `meta`.
- **Hover.** On the canvas, hovering a table's name lists its `meta`; hovering a column shows the column's under its description.
- **AI assistants** keep every existing entry. With a team metadata list (a `## Metadata` section in `modelling-approach.md`, above) they follow it; without one they add or change only the keys the user asks for and never copy dbt's `meta:` unasked.
- **dbt's own `meta:`** is read only by `erd-studio inventory` — `models[].meta` / `columns[].meta` (the schema yml over the manifest per key, and `config: meta:` over `meta:`, as dbt merges them) plus the project-wide `conventions.meta` summary of keys, counts, kinds and examples — so the setup guide can offer to carry it across. The physical stage still never shows or compares it.
- **`meta.dbml` (written by Import DBML…).** Not a new field: an ordinary `meta` entry under the key `dbml`, holding what an imported DBML file said that ERD Studio has no field for, so a later DBML export carries it back out (inside `meta_json`). On a column: `not_null`, `unique`, `increment` (each `true`), `default` (the value as text; an expression in backticks), `checks` (a list of expressions, or `{ name, expression }`), `enum` (the enum type's values), `name` (the original name, when it had to change) and `properties` (the file's own custom properties, by their original key). On a table: `indexes` (each `{ columns, unique?, name?, type?, note? }`; the primary key is `isPrimaryKey` instead), `checks`, `header_color`, `alias` (DBML's `Table x as y` alias, not the warehouse `alias`), `name` (the original name, when it had to change and could not be the warehouse `alias`) and `properties`. ERD Studio reads nothing from it: it is shown and edited like any other `meta` key, and AI assistants keep it as it is. The import writes nothing else that is new: tables, columns, relationships and the subject area file are the usual format. The DBML mapping itself is in [Leaving ERD Studio](leaving-erd-studio.md).

### Relationships

A relationship is stored in exactly one place: the YAML of the table holding its foreign key (`relationships:`) or a subject area JSON (`logical.relationships`). See [Where relationships live](#where-relationships-live).

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
| `fromModel` | string | Yes | Table containing the FK (the "many" side for many-to-one). |
| `fromColumn` | string | Yes | FK column name on the from table. |
| `toModel` | string | Yes | Referenced table (PK side). A relationship whose `toModel` has no table file is not drawn. |
| `toColumn` | string | Yes | Referenced PK column on the to table. |
| `cardinality` | string | Yes | One of `"many-to-one"`, `"one-to-one"`, `"one-to-many"`, `"many-to-many"`. `"one-to-many"` is deprecated in a table YAML: still read, but ERD Studio never writes it there (see the direction convention), and the JSON schema marks it. |
| `role` | string | No | A label for what the link means, e.g. `"order date"` and `"ship date"` for two columns pointing at the same date dimension. Trimmed, at most 60 characters, drawn on the line. A label only: not part of the identity. |
| `compositeKey` | string | No | Groups entries into one composite foreign key (see [Composite foreign keys](#composite-foreign-keys)). Trimmed, 1–64 characters, compared without case. A blank or non-string value is ignored (the entry reads as a single link and the bytes stay). Grouping only: not part of the identity. |

**Spelling:** table and column names in a relationship match the tables' and columns' real names ignoring case, and are drawn with the real spelling; ERD Studio writes the real spelling the next time it changes that entry.

**Identity key:** the composite `(fromModel, fromColumn, toModel, toColumn)` must be unique within the subject area — and the same two columns may not be joined twice in opposite directions either: that is one link, drawn once.

**Direction convention:** `fromModel` holds the FK (the "many" side), `toModel` holds the PK. A `one-to-many` is the same relationship read from the other end, so it is stored with its ends swapped as `many-to-one` (`canonicalRelationship` in `@erd-studio/core`, issue #133). `one-to-one` and `many-to-many` keep the direction they were drawn in. **Keys win:** a `many-to-one` whose `fromColumn` is its table's whole primary or natural key, pointing at a column of a table whose own whole key is a different column, contradicts the keys (that column holds each value once, so it cannot be the many side). The canvas refuses a ⇄ that would write one and the New Relationship dialog warns before creating one (**Create anyway**); the move command turns one round. One already saved — ERD Studio 1.6.7 could save it — is **never turned round on read** (a user may keep one on purpose): it is drawn as stored and flagged (`keysContradict: true` on the `DisplayRelationship`, a `one-to-many` read as the `many-to-one` it means, a composite judged on its column sets and flagged on every member, logical stage only). The canvas shows an amber ⚠ on the line and in the details panel ("This starts at dim_customer's key (customer_key), so it was probably drawn backwards.") with **Turn round** (⇄, one undo step); opening such a diagram offers to turn them all round once a session (**Turn Round**, **Review…**, **Not Now**, **Don't Ask Again**), writing nothing until a pick; the DBML and Mermaid exports carry the same sentence as a `//` / `%%` comment above the link; `erd-studio doctor` lists them (`erd.backwardsRelationships`) with a `turn-round-relationships` next step. The Confluence viewer shows no ⚠. Without a key flagged on the target (or, on the canvas, the CLI and exports, a dbt `unique` test) there is no certainty, and nothing is turned round or flagged.

**Which side holds the key** comes from evidence, never from the order a line was drawn in: first the tables' own key flags (a column set equal to a table's full `isPrimaryKey` set, or its full `isNaturalKey` set, is its whole key; in a table that flags any key, any other set is not), then — only for a table that flags no key — dbt's tests (a `unique` test, a `unique_combination_of_columns` equal to the set, a column a `relationships` test leaves). Flags always win over dbt. With neither, the New Relationship dialog asks which side holds the foreign key.[^winner]

Entries missing any of the four string endpoints are dropped on read with a console warning; an unrecognised `cardinality` falls back to `many-to-one`.

[^winner]: When the same link is stored twice, the copy drawn is chosen with the same evidence (the canvas and `erd-studio diff` pass dbt's tests; the read-only viewer cannot). The only state where they can differ is a link stored twice in the Table Library, with neither end flagged, in disagreeing directions — an ERD Studio 1.6.7 leftover that **Move Relationships to Table Library** settles.

#### Self-references

A table may point at itself, e.g. an employee's manager. It is stored in the table's own file, and a column never points at itself:

```yaml
# logical-models/employee.yml
relationships:
  - fromColumn: manager_id
    toModel: employee
    toColumn: employee_id
    cardinality: many-to-one
    role: manager
```

#### Composite foreign keys

A foreign key over several columns (a Data Vault PIT or bridge, a multi-column natural key) is one entry per column pair, all sharing one `compositeKey`, stored together on the FK side like any relationship:

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
    role: as of          # the group's role is the first entry's, and is written on every entry
```

Entries sharing a `compositeKey` (without case) form one composite — in one table file from one table, or in one subject area file from one `fromModel` — when there are 2–8 of them, all point at the same `toModel`, all have the same cardinality (`many-to-one` or `one-to-one`, never `many-to-many`), and no column is used twice at either end. A valid composite is drawn as one line listing its pairs; otherwise each entry is drawn as a single link and a warning is logged. ERD Studio names a new one `fk_<toModel>` (then `_2`, `_3`, … in that file). An edit, ⇄ or delete of the line acts on every entry; removing one of its columns removes the whole composite.

**Older versions.** ERD Studio 1.6.7 and earlier read each entry as a separate relationship, and drop `compositeKey` and `role` when they save that table — every column pair is kept. Editing one of those links and adding the other pairs back groups them again.

**dbt.** The physical stage reads a composite foreign key from a dbt ≥ 1.9 model-level `foreign_key` constraint (`columns`, `to: ref(...)`, `to_columns`) or a `dbt_constraints.foreign_key` test (`fk_column_names`, `pk_table_name`, `pk_column_names`), from schema yml and the manifest. Compare to Physical matches each pair as its own link; a composite dbt does not declare is one informational difference, and `erd-studio diff` reports it as an advisory `declare-composite-foreign-key` fix (blocking only with `--strict`).

#### Where relationships live

**In the Table Library (the default for a new project, issue #126).** A relationship is written once, into the YAML of its `fromModel` — the table holding the foreign key — with the same fields minus `fromModel`. Adding a new fact therefore only ever changes the fact's own file:

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

Every subject area whose `logical.models` holds both `fct_order_line` and `dim_customer` draws it; a subject area missing either does not. Editing it on any canvas changes every diagram that shows it, and deleting it deletes it everywhere. The same two columns stored in both tables' files (either way round, as ERD Studio 1.6.7 could leave them), or twice in one file, are drawn once, from the copy on the many side; an edit, ⇄ or delete acts on the link, folding every copy into one entry in its home with the line's role (⇄ is refused while two copies carry different roles). Deleting a link another diagram still draws from a copy of its own names that diagram; its copy is left for you. Renaming a table or column, or removing a column, rewrites the entries in other table files that point at it. Removing a table from one subject area leaves its relationships in the library.

**Per subject area.** A project whose subject area files already hold relationships keeps adding them there, so teammates on a version before this one go on seeing every edge. It opts in with **ERD Studio: Move Relationships to Table Library**: every v5 subject area's relationships are stored once in the YAML of the table holding each one's foreign key and taken out of the subject area files, writing the files directly (undo with source control). The same command moves a library entry stored on its "one" side (a `one-to-many`, written before issue #133, or a `many-to-one` ERD Studio 1.6.7 saved backwards: from its table's whole primary or natural key to a column of a table whose own whole key is a different column — see "Keys win") to the table on its many side, as `many-to-one`, keeping its role. It moves that one entry, never another copy of the link in the same file. When another copy of the link, in either file, disagrees, both are left in place and listed; a table file whose `relationships:` list has comments, YAML anchors or aliases, or entries ERD Studio cannot read is not rewritten, and is named instead. Opening a diagram in such a project offers the move (once a session, with **Don't Ask Again**) when at least one relationship's two tables sit together in more than one subject area. Before writing, the command explains why and where each relationship goes; a relationship the subject areas define with different cardinalities is a **conflict**, and the user picks the cardinality every diagram will use (naming the diagrams behind each) or leaves it in the subject area files for a later run. A definition is the cardinality, the role, and — for a `one-to-one` — which end holds the foreign key, so two diagrams labelling a link differently, or drawing a one-to-one from opposite ends, is a conflict too; a `many-to-many` drawn opposite ways round is one link, stored from its lower `table.column` end. Diagram copies the keys contradict are stored turned round, so a second run has nothing to do. A diagram copy of a link the Table Library already defines is taken out, and listed when it says something different (the library's version is the one every diagram already draws); a role only a diagram gives it moves onto the library entry. Every entry turned round is listed in the preview.

**Which one applies** is decided by what is on disk, like layer folders: the library is used once **any** table file holds a `relationships:` list, or when **no** subject area file holds a `logical.relationships` entry.

**Reading.** A subject area draws its own `logical.relationships` first, in order, then the library relationships between its tables. When both define the same endpoints (ignoring case) it is drawn once, with the library's cardinality, and a warning names the disagreement. A subject area file holding the same link twice draws it once, from the same copy whatever the entry order. When they join the same two columns in opposite directions, it is drawn once, as the library stores it.

### View Config (`viewConfig`)

Persisted UI layout state. Safe to leave as `{}` — the extension auto-positions tables that lack a position entry. When **no** table in the subject area has a position (a brand-new subject area written with `viewConfig: {}`), the canvas instead runs its ELK auto layout the first time the subject area opens and saves the result as one undoable edit; the user can re-run it any time with **Layout** / Shift+L.

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
| `positions` | Node positions keyed by table name. Each entry must have finite numeric `x` and `y`; malformed entries are ignored on read and the table is auto-positioned. |
| `annotations` | Free-form canvas post-it notes. `id`, `text`, `x`, `y` required; `color` is one of `yellow`, `blue`, `green`, `pink`, `orange`; `linkedModel` draws a dashed edge to that table. |

> **Preserve existing positions.** When adding tables to an existing subject area, do not clear or rewrite `viewConfig.positions`. The extension computes positions for new tables automatically.

### Editing Quick Reference

| To... | Edit |
|-------|------|
| Add/remove/rename a column, change type or PK/FK/NK/SCD flags | the table's yml (`logical-models/{name}.yml` or `logical-models/{folder}/{name}.yml`) |
| Change grain, modelRole, description, rationale, meta | the table's yml |
| Add a table to a subject area | Subject area `.json` → append the name to `logical.models` **and**, if no file for the name exists in any folder, create `logical-models/{layer}/{name}.yml` for the subject area's layer |
| Remove a table from a subject area | Subject area `.json` → remove the name from `logical.models` and its relationships from `logical.relationships` |
| Add/remove/edit a relationship | The FK table's `.yml` → `relationships:` when the project keeps relationships in the Table Library, else subject area `.json` → `logical.relationships` |
| Rename a subject area | Rewrite `domain` in the raw JSON and rename the file; never re-serialise a resolved subject area (that inlines table bodies and produces a hybrid file) |

### Validation Rules

1. Write `schemaVersion` `6` with the v6 names, or `5` with the v5 names, as `erd-studio doctor`'s `erd.naming` says (see [Schema v6](#schema-v6-the-table-naming)). Versions below 4 and top-level `models` arrays are rejected; version 4 is accepted only until migrated.
2. `layer` must match an `id` in `layers.json`.
3. Every entry in `logical.models` (v6: `logical.tables`) must be a string. Mixed string/object arrays are rejected.
4. Each referenced table should have a `logical-models/{name}.yml` or `logical-models/{folder}/{name}.yml`; a missing file renders as a placeholder with a warning.
5. Relationship identity `(fromModel, fromColumn, toModel, toColumn)` must be unique, in either direction, and both tables should be in `logical.models`.
6. `viewConfig` must be at the root of the document.

**Unresolved git merge conflicts.** A subject area or table file that still holds git's conflict markers — a `<<<<<<<` line, then `=======`, then `>>>>>>>` (a diff3 `|||||||` section between the first two is fine) — and so does not parse is reported as a merge conflict, with the line of the first `<<<<<<<`, rather than as invalid JSON or a YAML error: the canvas says so (and loads by itself once the file is resolved and saved), a table file's node reads "Unresolved git merge conflict on line N", `erd-studio diff` / `export` report the error code `merge-conflict`, and `erd-studio doctor` lists the file under `conflictedDomainFiles` (a table file under `unreadableModelFiles`, with `mergeConflict: true`). A file that parses is never reported, whatever its text contains. Keep one side of each conflict, save, then `git add` the file; when only `viewConfig.positions` conflicts, either side is safe to keep.

**A JSON mistake or an empty file.** A subject area file that is not valid JSON (a trailing comma, a missing comma, a file cut short) opens on a screen that names the file within the project and the line and column of the mistake, with **Open at Line N** to go straight to it; a file that stays empty says so. Both are problems in the file, not in ERD Studio: fix it and save, and the diagram reloads by itself.

### Complete Example

File: `.erd-studio/silver/sales.json`

```json
{
  "schemaVersion": 5,
  "domain": "sales",
  "layer": "silver",
  "description": "Sales subject area covering customers, products, and order transactions",
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

## Shared by both formats

`layers.json`, table templates, `modelling-approach.md`, the naming conventions and the physical stage are the same in a DBML and a YAML/JSON project.

### Team modelling approach (`.erd-studio/modelling-approach.md`)

An **optional**, free-form markdown file recording how the team models data: the technique (Kimball dimensional modelling, Data Vault 2.0, Inmon/3NF, One Big Table, Activity Schema, dbt's staging/intermediate/marts layering, or house rules), the user's own description in their words, the concrete rules, how each rule maps onto logical fields (`modelRole`, `grain`, `scdType`, `additiveType`, `isNaturalKey`, `rationale`), the sources consulted and the date. The `/erd-studio-setup` guide writes it after asking the user; it can also be written or edited by hand.

It is guidance for AI assistants only. **The extension never parses it**: it is not a subject area, a layer or a table, the canvas and the diff ignore it, and a project without one is valid. AI assistants editing ERD Studio files should read it first when it exists and follow it (the harness skill says so); where a rule conflicts with a request, they should say so and ask which wins. An optional **Target-design backlog** section lists improvements the team wants in the dbt project; differences between logical and physical listed there are intentional, and assistants report them as backlog items instead of "fixing" them. The logical fields still describe what dbt does today — a target that no diff can show (history, keys, grain) is kept in `rationale` and the backlog, not in `scdType` / key flags, because the physical stage copies those flags from logical.

An optional **Metadata** section is the team's **metadata list**: the `meta` keys the team records, as a table of **Key**, **On** (tables, columns or both), **Values** and **Source** — `dbt` (copied from the dbt model's own `meta:`, never typed in, left out when dbt has no value) or `the team` (filled in by people, never by an AI). Assistants use its key names exactly — a user's "data owner" becomes the listed `owner` — and copy the `dbt` keys whenever they create a table or add a column from dbt, including from a sync plan. The setup guide writes the section after detecting the keys dbt already records (`erd-studio inventory`'s `conventions.meta`) and one yes from the user. A file holding only a title and this section is valid: no technique agreed yet, so the guide still detects the style.

### Layers File (`.erd-studio/layers.json`)

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
| `id` | string | Yes | Lowercase identifier. Alphanumeric, hyphens, underscores. Also the directory name for that layer's subject areas. |
| `label` | string | Yes | Display name. |
| `abbreviation` | string | Yes | Short badge label. |
| `color` | string | Yes | Hex colour. |
| `creatable` | boolean | Yes | Whether new subject areas can be created in this layer. |
| `order` | number | Yes | Display order (lower first). |

Defaults if `layers.json` is missing: `bronze` (`#cd7f32`, not creatable), `silver` (`#a0a0a0`), `gold` (`#d4a800`).

<a id="model-templates-erd-studiotemplatesidjson"></a>

### Table Templates (`.erd-studio/templates/{id}.json`)

Templates provide preset columns when creating a table from the canvas.

```jsonc
{
  "id": "scd2_dimension",              // REQUIRED. Unique across all template files — a duplicate id is skipped with a warning.
  "label": "SCD2 Dimension",           // REQUIRED.
  "prefix": "dim_",                    // Optional. Table name prefix.
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

Template columns accept the full `ColumnDef` shape: `isPrimaryKey`, `isForeignKey`, `isNaturalKey`, `scdType` (0/1/2) and `additiveType` are all carried through to the created table; invalid values are dropped.

**Placeholders:** `{name}` is replaced with the table name minus its prefix (e.g. `customer` from `dim_customer`). Bridge templates also support `{left}` and `{right}`.

If no template files exist, built-in `dimension`, `fact`, `bridge`, `scd2` and `blank` templates are used.

### Naming Conventions

| Pattern | Prefix | Example | Use Case |
|---------|--------|---------|----------|
| Dimension | `dim_` | `dim_customer` | Entity/master data |
| Fact | `fct_` | `fct_order_line` | Transactional/event tables |
| Bridge | `brg_` | `brg_order_product` | Many-to-many junctions |
| Reference | `ref_` | `ref_country` | Lookup tables |

**PK naming:** `{entity}_id`. **FK naming:** matches the referenced PK name.

### Physical Stage (Derived, Read-Only)

The physical stage is not stored anywhere. Each name in `logical.models` is resolved
against the dbt project every time the stage is opened, from up to four sources:
source files under the configured `model-paths` / `seed-paths` / `snapshot-paths`,
dbt schema `.yml` files under `model-paths`, `{target-path}/manifest.json`, and
`{target-path}/catalog.json`. None of the four is required — a project that has
never been compiled still renders real tables.

**Existence.** A table is real (not a ghost) when **any** of these holds:

- a `<name>.sql`, `<name>.py` or `<name>.csv` file sits under a configured
  `model-paths`, `seed-paths` or `snapshot-paths` directory (so seeds and snapshots
  count), **and** dbt has not disabled the dbt model;
- a dbt schema `.yml` under `model-paths` declares it;
- the compiled manifest carries a node for it;
- `catalog.json` carries a relation for it.

All of those are looked up by the table **name** first. Only when the name finds
nothing does the table's warehouse relation — `schema` plus `alias` (or the name)
— get a second chance against the manifest's `schema` + `alias`, then the
catalog's `metadata.schema` + `metadata.name`. The pair is always matched
together, never the alias alone (a silver `date` is not a gold `date`), a table
with no `schema` never takes that route, and a relation two dbt models share is
ambiguous and matches neither. A table found this way keeps its logical name on
the canvas, and its relationship tests are drawn on it.
A table found in none of those is still emitted, as a **ghost** with no columns —
the design references something the dbt project does not have. A dbt model dbt has
**disabled** lands in the manifest's `disabled` section and `ref()` to it fails,
so a bare source file does not make it exist; with no other evidence it ghosts
with a "disabled" reason instead. Ghosting means "not in your dbt project", never
"you have not run `dbt compile` lately". Vendored directories (`dbt_packages`,
`dbt_modules`, virtualenvs) are excluded from the file walk.

A table known **only** by the file that defines it is a real node with **zero**
columns — nothing has stated its shape, and seeding it from the logical design
would invent one. Sync comparison skips such a table rather than reporting every
logical column as missing; that suppression is automatic and separate from
`stubColumns`, which is the user's own switch for deliberately partial tables.

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
| PK/FK/NK, `scdType`, `additiveType` | Carried forward from the logical table — dbt yml does not carry them |
| `meta` | Not shown — logical-only, never read from dbt |

A column typed on only one stage is reported as **`undeclared`**, not as a type
mismatch; writing `data_type:` into the schema yml, or running
`dbt docs generate`, is what fills it in.

**Table-level fields.** `alias` is the manifest's `alias` when dbt builds the dbt model
under another name, then a catalog relation named otherwise, then the logical
`alias`. `schema` is the manifest's `schema`, then the catalog's
`metadata.schema`, then blank — it cannot be derived from the filesystem (it needs
`generate_schema_name` and `profiles.yml`), so with neither artifact the node badge
falls back to the ERD **layer** abbreviation and says so. Every real physical table
also carries **provenance**: which sources contributed its columns, and which one
supplied its types. That is runtime state shown on the node and in the detail
panel; it is never written to disk.

**Relationships** are derived from **dbt relationship tests** — the union of those
declared in `.yml` files and those in the manifest, deduped, never copied from
logical. Cardinality comes from `unique` / `dbt_utils.unique_combination_of_columns`
tests merged from the same two sources (no `unique` test = "many" side). Only
relationships between tables **within the same subject area** appear. `catalog.json`
holds no constraint or foreign-key information, so it contributes no edges.

**Comparing without the canvas.** Nothing in this file format changes for tooling,
but there is a headless equivalent of the canvas's **Compare**. The `erd-studio` helper
(`dist/cli.js`, installed to `~/.erd-studio-cli/bin/erd-studio` by **ERD Studio: Set Up My
AI Helper**) is read-only. `erd-studio diff --domain .erd-studio/{layer}/{domain}.dbml --json` (the `.json` diagram in a YAML project),
or `--all`, builds both stages exactly as described above and runs the same comparison
as the canvas, because both call the same code. It reports each difference as a fix
that brings the logical side in line with dbt, naming the file to change: the table's
`.dbml` file (`tables/…/{name}.dbml`) or `logical-models/{name}.yml` for columns and types, and for relationships the FK table's folder's `_relationships.dbml`, the FK table's yml or the subject area file, wherever the project keeps them. A relationship matches whichever end dbt tests it from. It exits `0` when there are no blocking differences and `1` when there are.
A column that dbt has no type for yet is advisory, not blocking, unless you pass
`--strict`. `erd-studio inventory --models a,b --json` prints the physical shape of the
named dbt models, as a starting point for new table files. The `/erd-studio-setup` Claude Code
skill uses both commands. It writes the files described in this reference with the
assistant's normal Edit/Write tools, never through the helper, and runs `diff` until it is
clean.

### Editor Support (JSON Schemas)

Each hand-editable JSON or YAML file (`layers.json`, templates, and the YAML/JSON files of projects from before 2.0) has a JSON Schema (draft-07) in [`schemas/`](../schemas). It gives completion, hover descriptions and warnings for undeclared properties and invalid values. `.dbml` and `.dbdiagram` files have none: the DBML parser and `erd-studio doctor` check them instead.

| File | Schema |
|------|--------|
| `.erd-studio/{layer}/{domain}.json` | [`domain.schema.json`](../schemas/domain.schema.json) |
| `.erd-studio/logical-models/[{folder}/]{name}.yml` | [`logical-model.schema.json`](../schemas/logical-model.schema.json) |
| `.erd-studio/tables/[{folder}/]{name}.yml` | [`logical-model.schema.json`](../schemas/logical-model.schema.json) |
| `.erd-studio/layers.json` | [`layers.schema.json`](../schemas/layers.schema.json) |
| `.erd-studio/templates/{id}.json` | [`template.schema.json`](../schemas/template.schema.json) |

**In VS Code** the extension associates them by path (`contributes.jsonValidation` / `yamlValidation`), so nothing needs to be added to your files. JSON validation is built into VS Code. YAML needs Red Hat's [YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml). Subject area files open in the diagram editor by default; use **Open With… → Text Editor** to edit one as JSON. Schema problems are warnings, never errors: the extension still loads what it can, as described above.

The association uses the default `.erd-studio` directory. With a custom `erdStudio.semanticDir`, or in another editor, point at the schemas yourself. Either map them in settings (`json.schemas` / `yaml.schemas` in VS Code), or add a reference to the file. ERD Studio ignores the reference. Subject area files keep a `$schema` key, and table files keep the comment, when the canvas saves them. `layers.json` is rewritten whenever layers are edited from the sidebar, which drops the key, so map that one in settings:

```jsonc
// subject area / layers / template JSON: a top-level key
{ "$schema": "https://raw.githubusercontent.com/liam-machine/erd-studio/main/schemas/domain.schema.json", "schemaVersion": 5, ... }
```

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/liam-machine/erd-studio/main/schemas/logical-model.schema.json
name: dim_customer
```

The schemas describe both namings — `schemaVersion` 6 with the v6 keys and `tables/` YAML, and `schemaVersion` 5 with the v5 keys — and still accept a version 4 subject area until it is migrated. A file mixing the two namings is flagged, because it does not open. A subject area that mixes table names with inline table objects is flagged, because it does not open. The schemas are slightly stricter than the reader: a quoted `scdType: "1"` or `isPrimaryKey: yes` still loads, but is flagged, so hand edits end up in the form the canvas writes.

Red Hat YAML matches paths with dot-folders skipped, so a project inside a hidden folder (`~/.work/shop/…`) gets no table file validation from the built-in association; map it in `yaml.schemas` instead.
