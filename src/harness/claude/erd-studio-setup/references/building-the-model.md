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

| File | Write it when |
|---|---|
| `.erd-studio/layers.json` | It does not exist and the chosen layer is not `silver` or `gold` (e.g. `bronze` or `core`), or it exists and lacks the chosen layer |
| `.erd-studio/logical-models/<layer>/<name>.yml` (or `logical-models/<name>.yml` in a flat library — see below) | Once per chosen model that is **not** in `alreadyModelled` |
| `.erd-studio/<layer>/<domain>.json` | Once per domain |

**Where a new model file goes.** Model files may sit at the top of `logical-models/` or one folder
down in a folder named after a layer. Use the domain's layer folder (`logical-models/<layer>/`)
when the library is empty or a `logical-models/<layer>/` folder already holds a `.yml` file; if every
existing model file is at the top level, the library is flat — write at the top level and leave
the choice to organise to the user (**ERD Studio: Organise Model Library by Layer**). Model names
are unique across all folders, and the domain file lists models by name, never by path.

Models in `alreadyModelled` are referenced by name in the domain file and their yml is left
alone, wherever it is. Someone may have designed them by hand, and other domains may share them. If their content
disagrees with dbt, Stage 5 will say so and ask.

## layers.json

With no `layers.json`, ERD Studio uses two built-in layers, `silver` and `gold`, so a domain in
either needs no layers file. For any other layer (for example the `core` default when
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

## Model yml — field by field

For each `InventoryModel` in the `inventory --models` output:

| yml field | Comes from |
|---|---|
| `name` | `name`, exactly |
| `schema` | `schema`, if not empty; otherwise omit |
| `description` | `description`; if empty, a one-line plain draft ending in "(draft)" |
| `columns[].name` | `columns[].name`, in the same order. If a name is all UPPERCASE (a warehouse spelling), write it in lowercase — matching is case-insensitive, and ERD Studio's naming is lowercase |
| `columns[].dataType` | `columns[].dataType`, copied exactly (e.g. `NUMBER(38,0)`, `varchar`). If it is `''`, see "When dbt has no type" |
| `columns[].description` | `columns[].description`; if empty, a short draft ending in "(draft)" when the meaning is obvious from the name, else `""` |
| `columns[].isPrimaryKey: true` | The column in `keyCandidates.unique` when there is exactly one. With several, prefer the one named like `<entity>_id` for the model (`order_id` for `fct_order`). With none, every column of the first `keyCandidates.compositeUnique` group |
| `columns[].isForeignKey: true` | Every column listed in `foreignKeys` |

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

## Domain JSON

```json
{
  "schemaVersion": 5,
  "domain": "orders",
  "layer": "gold",
  "description": "Orders and the customers and products they reference",
  "modelFolder": "models/marts",
  "logical": {
    "models": ["fct_order", "dim_customer", "dim_product"],
    "relationships": [
      { "fromModel": "fct_order", "fromColumn": "customer_id", "toModel": "dim_customer", "toColumn": "customer_id", "cardinality": "many-to-one" },
      { "fromModel": "fct_order", "fromColumn": "product_id", "toModel": "dim_product", "toColumn": "product_id", "cardinality": "many-to-one" }
    ]
  },
  "viewConfig": {}
}
```

- `domain` matches the file name; lowercase letters, digits, `-` and `_`, starting with a letter.
- `layer` matches the parent folder.
- `modelFolder` is optional: the common folder of the chosen models' files, if there is one.
- `logical.models` is the chosen names, including already-modelled ones.
- `logical.relationships` is the inventory's `relationships` array, **copied verbatim** —
  including `cardinality`. Do not add connections you inferred from column names: a connection
  dbt does not test would be drift. Offer those as dbt tests in Stage 6 instead.
- `viewConfig: {}` (no positions) makes ERD Studio auto-arrange the diagram with its auto layout
  the first time the domain is opened, and save the result. Do not write positions yourself;
  the user can re-run the layout any time with **Layout** in the canvas toolbar or Shift+L.
- Do not set `stubColumns`. It hides differences, and the point of this walkthrough is to see
  them.

If the domain file already exists (a re-run), add new names to `logical.models` and new
relationships to `logical.relationships`, and never touch `viewConfig.positions` — that is the
user's layout.

## Worked example

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
description: One row per order (draft)
grain: One row per order
modelRole: transaction-fact
rationale:
  design: Kimball transaction fact, per .erd-studio/modelling-approach.md
columns:
  - name: order_id
    dataType: INT
    description: Order identifier
    isPrimaryKey: true
  - name: customer_id
    dataType: INT
    description: The customer who placed the order (draft)
    isForeignKey: true
  - name: product_id
    dataType: INT
    description: The product ordered (draft)
    isForeignKey: true
  - name: order_total
    dataType: DECIMAL(18,2)
    description: Order value (draft)
    additiveType: additive
```

`dim_customer.yml` gets `customer_id` with both `isPrimaryKey: true` and `isNaturalKey: true` —
it is the source system's business key, and doubles as the primary key because the dimension has
no surrogate key (a gap the Stage 5 review raises if the approach wants surrogate keys) —
`modelRole: conformed-dim` and `grain: One row per customer`. `email` is left unflagged, since the
approach does not name it a business key. `segment` is written as
`STRING` (no cast in the SQL) and added to "types to confirm". The model is not built from a dbt
snapshot and has no validity dates, so its attributes get `scdType: 1` — if the approach wants
history, that gap goes in the Stage 5 review, not into a `scdType: 2` dbt does not deliver.
`dim_product.yml` follows the same pattern. Then the domain JSON above.

## Names ERD Studio cannot use

Model names must match `^[a-z][a-z0-9_]*$` — lowercase, starting with a letter. The inventory
already lists dbt models that do not as `skipped` with reason `invalid-name`. Do not rename or
include them; tell the user in one line which were skipped and why.

## Shared dimensions

Lines are drawn only between models in the **same** domain. When a dimension such as
`dim_customer` belongs to several business areas, add its name to each domain's
`logical.models`. There is still only one `dim_customer.yml`, shared by all of them — editing it
from any domain changes it everywhere.
