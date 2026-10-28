# Building the logical model from the inventory

This is the recipe for Stage 4. The file formats themselves belong to ERD Studio's
**schema skill** (`/erd-studio` in Claude Code; its `SKILL.md` file for other assistants — see
"Your AI assistant" in SKILL.md) — load it first and follow it for every field. This page only
says *where each value comes from*, so the logical model starts out as a faithful copy of the dbt
project and the Stage 5 diff has as little as possible to fix.

The one rule behind everything here: **copy, never invent.** Columns, types and connections come
from `inventory --models` output. Anything you had to guess is marked "(draft)" or listed in
"types to confirm", so the user knows exactly what to check.

## Which files to write

**Format first.** Doctor's `erd.storage` says which format this project writes (the schema
skill's "What to write"): `dbml` — and a project with no `.erd-studio/` yet — writes DBML, as this
page shows first; `yaml` writes YAML tables and JSON diagrams ("Legacy" sections below, in the
naming doctor's `erd.naming` reports); `mixed` writes new files as DBML and edits an existing file
in its own format. Never convert a file between the formats yourself.

| File (DBML) | Write it when |
|---|---|
| `.erd-studio/layers.json` | It does not exist (a new project), or it lacks the chosen layer |
| `.erd-studio/tables/<layer>/<name>.dbml` (or `tables/<name>.dbml` in a flat library — see below) | Once per chosen model that is **not** in `alreadyModelled` |
| `.erd-studio/tables/<layer>/_relationships.dbml` | Once per library folder whose tables hold foreign keys: one Ref per relationship (add to it when it exists) |
| `.erd-studio/<layer>/<domain>.dbml` | Once per domain (the diagram) |

**Where a new model file goes.** Table files may sit at the top of `tables/` or one folder down
in a folder named after a layer. Use the domain's layer folder (`tables/<layer>/`) when the library
is empty or a `tables/<layer>/` folder already holds a table file; if every existing table file is
at the top level, the library is flat — write at the top level and leave the choice to organise to
the user (**ERD Studio: Organise Table Library by Layer**). Table names are unique across all
folders, and the diagram lists tables by name (its `use` lines), never by anything else.

Models in `alreadyModelled` are referenced by name in the diagram and their file is left
alone, wherever it is. Someone may have designed them by hand, and other domains may share them. If their content
disagrees with dbt, Stage 5 will say so and ask.

**Legacy (`erd.storage: yaml`).** Doctor's `erd.naming` says which names this project writes. The
Legacy sections use the v5 names (`logical-models/`, `"domain"`, `logical.models`, `fromModel` /
`toModel`, `modelRole`); when `naming` is `v6` or `mixed`, write the v6 names instead
(`tables/`, `"subjectArea"`, `logical.tables`, `fromTable` / `toTable`, `tableRole`,
`"schemaVersion": 6`), exactly as the schema skill's `LEGACY.md` "File naming" maps them. Never mix
the two in one file. The files are `.erd-studio/logical-models/<layer>/<name>.yml` per model (top
level in a flat library) and `.erd-studio/<layer>/<domain>.json` per domain.

## layers.json

A new DBML project writes `layers.json` first, with the built-ins `silver` and `gold` and any
other layer it uses. In an existing project with no `layers.json`, ERD Studio uses those two
built-in layers, so a domain in either needs no layers file. For any other layer (for example the `core` default when
`suggestedLayer` is null), write the file with the built-ins **plus** the new layer, because
writing the file replaces the built-ins:

```json
{
  "schemaVersion": 1,
  "layers": [
    { "id": "silver", "label": "Silver", "abbreviation": "SLV", "color": "#a0a0a0", "creatable": true, "order": 1 },
    { "id": "gold", "label": "Gold", "abbreviation": "GLD", "color": "#d4a800", "creatable": true, "order": 2 },
    { "id": "core", "label": "Core", "abbreviation": "COR", "color": "#60a5fa", "creatable": true, "order": 3 }
  ]
}
```

When the file exists, append one entry and keep everything else as it is. Layer ids are
lowercase letters, digits, `-` and `_`, starting with a letter; `color` is a six-digit hex.

**Bronze.** In a medallion project (`conventions.layering.style` is `medallion`) the chosen layer
can be `bronze`, which is not built in. Write the file the same way, with bronze first so the
sidebar shows the layers in pipeline order:

```json
{
  "schemaVersion": 1,
  "layers": [
    { "id": "bronze", "label": "Bronze", "abbreviation": "BRZ", "color": "#cd7f32", "creatable": true, "order": 1 },
    { "id": "silver", "label": "Silver", "abbreviation": "SLV", "color": "#a0a0a0", "creatable": true, "order": 2 },
    { "id": "gold", "label": "Gold", "abbreviation": "GLD", "color": "#d4a800", "creatable": true, "order": 3 }
  ]
}
```

If the file exists without bronze, append that one entry (keep the other entries' `order` as
they are).

## Choosing the layer

In order of preference:
1. The layer the user named.
2. The most common `suggestedLayer` among the chosen models (it maps dbt folders such as
   `staging`/`intermediate` → `silver` and `marts` → `gold`, or matches an existing layer id; in a
   medallion project it is the model's own `bronze` / `silver` / `gold` folder or schema).
3. `core`.

Layers are only folders for organising diagrams; tell the user they can move a domain later.

## Table file (DBML) — field by field

For each `InventoryModel` in the `inventory --models` output, one `tables/[<layer>/]<name>.dbml`
holding one Table named exactly `name`. **Quote every custom value**, even `'true'` and numbers
(the schema skill's `DBML.md`): an unquoted word breaks the file everywhere, an unquoted `true`
or `2` breaks it in other DBML tools.

| DBML | Comes from |
|---|---|
| `Table <name>` | `name`, exactly (double-quoted only when it is not a plain identifier) |
| `schema: '<schema>'` (table setting) | `schema`, if not empty; otherwise leave it out |
| `Note: '<text>'` (last line of the block) | `description`; if empty, a one-line plain draft ending in "(draft)" |
| column lines, in order | `columns[].name` — an all-UPPERCASE warehouse spelling in lowercase, mixed case kept |
| the column's type | `columns[].dataType`, copied exactly, double-quoted when it is not a plain identifier (`"NUMBER(38,0)"`). If it is `''`, see "When dbt has no type" |
| `note: '…'` (column setting) | `columns[].description`; if empty, a short draft ending in "(draft)" when the meaning is obvious from the name, else leave it out |
| `pk` (or `indexes { (a, b) [pk] }`) | as `isPrimaryKey` in the Legacy table below |
| `foreign_key: 'true'` | Every column listed in `foreignKeys` |
| `meta_<key>` / `meta_json` | Only with a team metadata list: its `dbt` keys — `references/metadata.md` section 5 |

The design fields (`role`, `grain`, `rationale_<field>`, `scd_type`, `additive_type`,
`natural_key`) come from the modelling approach, as the paragraph after "Quote every text value"
below says. A text with a line break is triple-quoted (`'''…'''`); escape `'` as `\'`. A
table file holds no `use`, `Ref` or `[ref: …]` — relationships go in the relationships file.

## Relationships (DBML)

The inventory's `relationships`, **copied verbatim** — including `cardinality` — each as one Ref
in the `_relationships.dbml` of the folder that holds its foreign-key (`fromModel`) table, with
a `use { table x } from './x.dbml'` (or `'../x.dbml'`) line for every table the Refs name:
`Ref: fct.fk >? dim.pk` (`many-to-one`), `Ref: dim.pk ?- fct.fk` (`one-to-one`, key end first),
`Ref: a.x <>? b.y` (`many-to-many`); a `one-to-many` is written from the other end as `>?`; a
composite key is one Ref with both column lists. Do not add connections you inferred from column
names: a connection dbt does not test would be drift. Offer those as dbt tests in Stage 6 instead.

## Diagram file (DBML)

```dbml
Project orders {
  Note: 'Orders and the customers and products they reference'
  erd_schema_version: '7'
  erd_model_folder: 'models/marts'
}

use { table fct_order } from '../tables/gold/fct_order.dbml'
use { table dim_customer } from '../tables/gold/dim_customer.dbml'
use { table dim_product } from '../tables/gold/dim_product.dbml'
use * from '../tables/gold/_relationships.dbml'
```

- The Project name matches the file name; lowercase letters, digits, `-` and `_`, starting with a
  letter. Double-quote a name with a `-` (`Project "customer-360" {`), or every DBML tool and
  ERD Studio reject the file. `erd_schema_version: '7'` always; `erd_model_folder` is optional (the common folder of
  the chosen models' files).
- One table `use` line per chosen name, including already-modelled ones, with the path from the
  diagram to the table's file; then one `use *` line per `_relationships.dbml` of those tables'
  folders.
- Write no `.dbdiagram` layout file: ERD Studio auto-arranges a new diagram the first time it opens
  and saves the result. Never write positions yourself.
- Do not set `erd_stub_columns`. It hides differences, and the point of this walkthrough is to see
  them.

If the diagram already exists (a re-run), add `use` lines for new names and new Refs where they
belong (skip any already there), and never touch its `.dbdiagram` — that is the user's layout.

## Worked example (DBML)

For the inventory in "Legacy worked example" below, with the Kimball approach, you write
`tables/gold/fct_order.dbml`:

```dbml
Table fct_order [
  role: 'transaction-fact',
  grain: 'One row per order',
  rationale_design: 'Kimball transaction fact, per .erd-studio/modelling-approach.md'
] {
  order_id INT [pk, note: 'Order identifier']
  customer_id INT [foreign_key: 'true', note: 'The customer who placed the order (draft)']
  product_id INT [foreign_key: 'true', note: 'The product ordered (draft)']
  order_total "DECIMAL(18,2)" [additive_type: 'additive', note: 'Order value (draft)']
  Note: 'One row per order (draft)'
}
```

and `tables/gold/_relationships.dbml`:

```dbml
// ERD Studio relationships. Each Ref belongs to its foreign-key table, which lives in this folder; every table a Ref names has a use line here.
use { table dim_customer } from './dim_customer.dbml'
use { table dim_product } from './dim_product.dbml'
use { table fct_order } from './fct_order.dbml'

Ref: fct_order.customer_id >? dim_customer.customer_id
Ref: fct_order.product_id >? dim_product.product_id
```

`dim_customer.dbml` gets `customer_id INT [pk, natural_key: 'true', …]`, `role: 'conformed-dim'`
and `grain: 'One row per customer'`; the other choices are as in the legacy example. Then the
diagram above.

## Legacy: model yml — field by field

For each `InventoryModel` in the `inventory --models` output:

| yml field | Comes from |
|---|---|
| `name` | `name`, exactly |
| `schema` | `schema`, if not empty; otherwise omit |
| `description` | `description`; if empty, a one-line plain draft ending in "(draft)" |
| `columns[].name` | `columns[].name`, in the same order. If a name is all UPPERCASE (a warehouse spelling), write it in lowercase — matching is case-insensitive. Mixed case the team chose (`DateKey`) is kept as written |
| `columns[].dataType` | `columns[].dataType`, copied exactly (e.g. `NUMBER(38,0)`, `varchar`). If it is `''`, see "When dbt has no type" |
| `columns[].description` | `columns[].description`; if empty, a short draft ending in "(draft)" when the meaning is obvious from the name, else `""` |
| `columns[].isPrimaryKey: true` | The column in `keyCandidates.unique` when there is exactly one. With several, prefer the one named like `<entity>_id` for the model (`order_id` for `fct_order`). With none, every column of the first `keyCandidates.compositeUnique` group |
| `columns[].isForeignKey: true` | Every column listed in `foreignKeys` |
| `meta`, `columns[].meta` | Only with a team metadata list: its `dbt` keys from `meta` / `columns[].meta` — `references/metadata.md` section 5 |

### Quote every text value

The file must be valid YAML, or ERD Studio shows the model as empty and the diff cannot compare
it. dbt descriptions often contain `: ` or start with a backtick, so copy them verbatim **inside
double quotes**:

- Wrap every `description`, `grain`, `rationale` and `dataType` value in double quotes (escape an
  inner `"` as `\"`), or use a `|` block for multi-line text.
- Always quote a value that contains `: ` or ` #`, or starts with any of
  `` ` @ * & ! % [ { - | > ' " ``.
- Indent with spaces, never tabs.
- Write each key once per block. Before adding a `description` (or any key) to a model or
  column, check it is not already there and edit that line instead: a key written twice makes
  ERD Studio refuse every change to the file until one copy is removed.
- One YAML document per file: no `---` separators, no markdown code fences, no `{{ doc() }}` —
  paste the text itself.

After writing model files, run `doctor` (or the Stage 5 `diff`): a `fix-model-yaml` entry names
the file and line that does not parse. Fix it before anything else — unless that file's entry in
`unreadableModelFiles` has `mergeConflict: true`: that file holds two versions from a git merge,
and only the user can say which to keep (troubleshooting.md → "Merge conflicts").

dbt does not know `grain`, `modelRole`, `rationale`, `scdType`, `additiveType` or `isNaturalKey`.
They come from the **modelling approach** agreed in Stage 3, applied as
`references/modelling-approaches.md` section 2 describes — and only to models created this
session. The diff never compares them, so they cannot cause drift; but the approach never changes
the fields in the table above. If no approach was agreed, or a model's role or grain is unclear,
leave the field out and put the model on the "to confirm" list.

The schema skill's "Building Models from External Sources" reconcile step is covered by
the Stage 5 diff: it is a machine set-difference against the same source, so do not print a
reconcile table of your own. Tell the user "copied 12 columns from dbt" rather than listing
every column.

### When dbt has no type

A column's `dataType` is `''` when neither the catalog nor a `data_type:` line in the yml states
it. Then:
1. If the model's SQL casts the column unambiguously in its final `SELECT` — `cast(x as date)`,
   `x::numeric(18,2)` — use that type.
2. Otherwise write `STRING`.

Either way, add the column to the **types to confirm** list you show in Stage 6. The diff reports
these as *advisory*, not blocking, because dbt has no type to compare with — an honest "we don't
know yet", not a false match.

### Thin models (no columns in dbt)

When `columnCount` is 0 and the user chose "draft from SQL" in Stage 4, read the model's `file`
and take the column names from the **final** `SELECT` (after the last CTE). Use the alias after
`as` when there is one. Skip `*` — if the final select is `select * from …`, say you cannot tell
the columns and leave the model with no columns. Write every drafted column with a description
ending in "(draft)" and add it to "types to confirm".

Only draft when dbt has **no** columns for the model. If dbt lists some columns, copy those and
nothing else — a drafted extra column would show up as drift.

## Legacy: domain JSON

```json
{
  "schemaVersion": 5,
  "domain": "orders",
  "layer": "gold",
  "description": "Orders and the customers and products they reference",
  "modelFolder": "models/marts",
  "logical": {
    "models": ["fct_order", "dim_customer", "dim_product"],
    "relationships": []
  },
  "viewConfig": {}
}
```

- `domain` matches the file name; lowercase letters, digits, `-` and `_`, starting with a letter.
- `layer` matches the parent folder.
- `modelFolder` is optional: the common folder of the chosen models' files, if there is one.
- `logical.models` is the chosen names, including already-modelled ones.
- The relationships are the inventory's `relationships` array, **copied verbatim** —
  including `cardinality`. Do not add connections you inferred from column names: a connection
  dbt does not test would be drift. Offer those as dbt tests in Stage 6 instead.
- **Where they go** follows the `/erd-studio` skill's "Where relationships live":
  - **In the model library** — when any model file already has a `relationships:` list, or no
    domain file has a `logical.relationships` entry (always true for a first diagram). Write each
    one into its `fromModel`'s yml under `relationships:` — the same fields without `fromModel`,
    as in the worked example below — and leave `"relationships": []` in the domain JSON, as
    above. The exception is a `one-to-many`: swap the ends and write it as `many-to-one` in the
    other model's yml, so every relationship sits with the model holding the foreign key. Every diagram holding both models then draws it, and it is defined once.
  - **Per domain** — otherwise: the project's diagrams already keep their own. Put each one in
    the domain JSON's `logical.relationships` with all five fields (`fromModel`, `fromColumn`,
    `toModel`, `toColumn`, `cardinality`).
  - Never write one in both places, and never move existing relationships from one place to the
    other yourself — that is the user's choice, made with **ERD Studio: Move Relationships to
    Model Library**, which explains the move and lets them settle conflicts.
  - A foreign key over several columns (a Data Vault PIT or bridge, a multi-column natural key)
    is one entry per column pair, all sharing one `compositeKey` (e.g. `fk_sat_customer`), as the
    `/erd-studio` skill's "Composite foreign keys" shows.
- `viewConfig: {}` (no positions) makes ERD Studio auto-arrange the diagram with its auto layout
  the first time the domain is opened, and save the result. Do not write positions yourself;
  the user can re-run the layout any time with **Layout** in the canvas toolbar or Shift+L.
- Do not set `stubColumns`. It hides differences, and the point of this walkthrough is to see
  them.

If the domain file already exists (a re-run), add new names to `logical.models` and new
relationships where the project keeps them (skip any already defined in the model library), and
never touch `viewConfig.positions` — that is the user's layout.

## Legacy worked example

`inventory --models fct_order,dim_customer,dim_product` returns (summarised):

- `dim_customer`: columns `customer_id` (INT), `email` (VARCHAR), `segment` (''),
  `keyCandidates.unique: ["customer_id"]`.
- `dim_product`: columns `product_id` (INT), `product_name` (VARCHAR),
  `keyCandidates.unique: ["product_id"]`.
- `fct_order`: columns `order_id` (INT), `customer_id` (INT), `product_id` (INT),
  `order_total` (DECIMAL(18,2)), `keyCandidates.unique: ["order_id"]`,
  `foreignKeys: ["customer_id", "product_id"]`.
- `relationships`: the two many-to-one links in the domain example above.

The agreed approach is Kimball. You write `logical-models/gold/fct_order.yml` (`logical-models/fct_order.yml` in a flat library):

```yaml
name: fct_order
description: "One row per order (draft)"
grain: "One row per order"
modelRole: transaction-fact
rationale:
  design: "Kimball transaction fact, per .erd-studio/modelling-approach.md"
columns:
  - name: order_id
    dataType: "INT"
    description: "Order identifier"
    isPrimaryKey: true
  - name: customer_id
    dataType: "INT"
    description: "The customer who placed the order (draft)"
    isForeignKey: true
  - name: product_id
    dataType: "INT"
    description: "The product ordered (draft)"
    isForeignKey: true
  - name: order_total
    dataType: "DECIMAL(18,2)"
    description: "Order value (draft)"
    additiveType: additive
relationships:
  - fromColumn: customer_id
    toModel: dim_customer
    toColumn: customer_id
    cardinality: many-to-one
  - fromColumn: product_id
    toModel: dim_product
    toColumn: product_id
    cardinality: many-to-one
```

The two relationships go in `fct_order.yml` because `fct_order` holds the foreign keys — this is
a first diagram, so the library is where relationships live. In a project that keeps them per
domain, leave this list out and put both in the domain JSON's `logical.relationships` instead.

`dim_customer.yml` gets `customer_id` with both `isPrimaryKey: true` and `isNaturalKey: true` —
it is the source system's business key, and doubles as the primary key because the dimension has
no surrogate key (a gap the Stage 5 review raises if the approach wants surrogate keys) —
`modelRole: conformed-dim` and `grain: "One row per customer"`. `email` is left unflagged, since the
approach does not name it a business key. `segment` is written as
`STRING` (no cast in the SQL) and added to "types to confirm". The model is not built from a dbt
snapshot and has no validity dates, so its attributes get `scdType: 1` — if the approach wants
history, that gap goes in the Stage 5 review, not into a `scdType: 2` dbt does not deliver.
`dim_product.yml` follows the same pattern, with no `relationships:` (nothing leaves it). Then the
domain JSON above, with `"relationships": []`.

## Names ERD Studio cannot use

Model names must match `^[A-Za-z][A-Za-z0-9_]*$` — letters (either case), digits and `_`, starting with a letter. The inventory
already lists dbt models that do not as `skipped` with reason `invalid-name`. Do not rename or
include them; tell the user in one line which were skipped and why.

## Shared dimensions

Lines are drawn only between models in the **same** domain. When a dimension such as
`dim_customer` belongs to several business areas, add its name to each domain's
`logical.models`. There is still only one `dim_customer.yml`, shared by all of them — editing it
from any domain changes it everywhere. The same goes for a relationship stored in a model's
yml: every domain that holds both of its models draws it, so adding `dim_customer` to a second
domain alongside `fct_order` brings the `fct_order → dim_customer` line with it — do not add it
again.
