# ERD Studio — the DBML format

This is how an ERD Studio project stores its model as DBML (ERD Studio 2.0 and later). Every file lives under a layer folder: one file per table in `<layer>/tables/<schema>/`, Refs in `<layer>/relationships/`, and one file per diagram in `<layer>/diagrams/`, holding its positions in its `Project`. The files are a multi-file DBML project, so other DBML tools (DBML 9.1 and later) read them too — keep every rule below, or those tools fail where ERD Studio reads on. Read `SKILL.md` first: it says when this file applies.

## Table file: `<layer>/tables/<schema>/<name>.dbml`

**First rule: quote every custom value, even `'true'` and numbers** — `natural_key: 'true'`, `scd_type: '2'`, `grain: 'One row per order line'`. ERD Studio reads an unquoted `true` or `2`, but DBML 9 and 10 tools reject the whole file (and every diagram that imports it), and an unquoted word or phrase (`role: fact`, `grain: one row`) is an error everywhere, ERD Studio included. `erd-studio doctor` flags both (`unquotedValue`, or the parser's code with "Quote the value"). The same holds for the Project keys of a diagram (`erd_schema_version: '7'`).

```dbml
// Order lines from the shop. Comments like this one survive every save.
Table sales.fct_order [
  role: 'transaction-fact',
  grain: 'One row per order line',
  purpose: 'Revenue reporting by day, customer and region',
  decisions: 'Returns are negative lines, not a table of their own, so totals net off',
  owner: 'sales-data',
  meta_json: '{"tags":["finance"]}'
] {
  Note: 'Order lines'

  order_line_id  BIGINT          [pk, note: 'Line id from the shop']
  customer_key   INT             [foreign_key: 'true']
  order_date_key INT             [foreign_key: 'true']
  amount         "DECIMAL(18,2)" [additive_type: 'additive', note: 'Line total']
  order_number   VARCHAR         [
    natural_key: 'true',
    note: 'The order number the customer sees on the receipt, emails and the shop'
  ]
  email          VARCHAR         [pii: 'true', note: 'Where the receipt was sent']
  loaded_at      timestamp       [not null, default: `now()`]
}
```

Here `owner` and `pii` are fields of the team's own, from its `fields.yml` (below); `tags`, a list, is metadata in `meta_json`.

- **Exactly one `Table` per file**, declared `Table <schema>.<name>`: the schema spelled exactly as the schema folder and the name exactly as the file (`gold/tables/sales/fct_order.dbml` holds `Table sales.fct_order`). Double-quote a part that is not a plain identifier (`Table "SAP FI".afih`). Any number of `Enum`s and comments may sit beside it. No `Project`, `TableGroup`, top-level `Note`, `TablePartial` or `Records`.
- **The schema is the qualifier, never a setting.** Doctor warns about an unqualified `Table fct_order` (`unqualifiedTable`: other DBML tools read it as `public.fct_order`), a qualifier that differs from the folder (`schemaFolderMismatch`) and an old `[schema: '…']` setting (`schemaProperty`: remove it). To change a table's schema, move its file to the other schema folder and change the qualifier, every Ref end and every `use` line that names it, in one change.
- **No `use`, no `Ref`, and no inline `[ref: …]` in a table file**: relationships go in a relationships file (below). ERD Studio reads such a file but refuses to change it until the line is moved, and doctor gives the exact Ref line to write instead.
- **Spell names exactly**: the table and column names as they are, in their case (DBML is case-sensitive). A name that is not a plain identifier, or is a DBML keyword, is double-quoted (`"order"`); a type that is not a plain identifier is too (`"DECIMAL(18,2)"`).
- **A table needs at least one column.** A table with none yet holds the placeholder line `_erd_no_columns unknown [erd_placeholder: 'true', note: 'ERD Studio: this table has no columns yet, and DBML needs one']`; delete it when you add the first real column.
- **Primary key**: `pk` on the column; for two or more columns, an `indexes { (a, b) [pk] }` block instead, with no `pk` on the columns.
- The table's description is the `Note: '…'` line, first in the block and followed by a blank line. A text with a line break is triple-quoted (`'''…'''`); escape `'` as `\'` and `\` as `\\`.
- A flag is written only when it is set (`natural_key: 'true'`); to unset it, delete the setting. DBML's own settings ERD Studio does not model (`not null`, `unique`, `default`, `increment`, `note` on an index, `headercolor`, other indexes, Enums) are kept exactly as written; every other setting is a field ("Setting names" below), kept too.
- **Never write a `Metadata` block** (`Metadata Table x { … }`): put every property inline, on the Table or the column. A Metadata block silently overrides the inline value.

## Field names

| Meaning | In a table file | Example |
|---|---|---|
| table name | the name part of `Table <schema>.<name>` (the file stem) | `Table sales.dim_customer` |
| schema | the qualifier of `Table <schema>.<name>` (the schema folder) | `Table sales.dim_customer` |
| description | the body's `Note` (first line) | `Note: 'Customer master data'` |
| role (see "Table roles" in `SKILL.md`) | `role` | `role: 'conformed-dim'` |
| grain | `grain` | `grain: 'One row per customer'` |
| warehouse table name (dbt `alias`) | `alias` (never DBML's own `as`) | `alias: 'customer'` |
| a field (see "Fields" in `SKILL.md` and "fields.yml" below) | `<key>: '<value>'`, the key as fields.yml names it | `purpose: '…'`, `owner: 'crm-team'` |
| metadata that is not text (a list, a map, a number, or `true` / `false` for a key that is not a yes-no field) | one `meta_json` with those entries as JSON, where its first entry is (ERD Studio also keeps a text value inside it when it sits between two of its entries, so the metadata reads back in key order: leave such a `meta_json` as it is) | `meta_json: '{"tags":["finance"]}'` |
| a field in an older file | `rationale_<key>` or `meta_<key>` ("Setting names" below) | `rationale_purpose: '…'` |
| column type | the column's type | `email VARCHAR` |
| column description | `note` (column setting) | `[note: 'Email address']` |
| primary key | `pk`, or `indexes { (a, b) [pk] }` | `[pk]` |
| foreign key (intent) | `foreign_key: 'true'` | `[foreign_key: 'true']` |
| natural (business) key | `natural_key: 'true'` | `[natural_key: 'true']` |
| SCD type | `scd_type: '0'`, `'1'` or `'2'` | `[scd_type: '2']` |
| additive type | `additive_type` | `[additive_type: 'semi-additive']` |
| a column field | `<key>: '<value>'` on the column (`meta_json` for metadata that is not text) | `[pii: 'true']` |

Every custom value is a quoted string. `foreign_key` records the intent only: a Ref never sets it, so set it on a foreign-key column yourself. ERD Studio never compares a field with dbt (see "Fields" in `SKILL.md`); an imported table may carry a `meta_json` with a `dbml` entry (what an imported DBML file said that ERD Studio has no field for): keep it as it is.

## fields.yml: the fields a project records

`.erd-studio/fields.yml` (optional, beside `layers.json`; the same file in a YAML project) lists the fields this project records on tables and on columns, in the order the Detail panel shows them. ERD Studio reads it and never writes it; change it only when the user asks (the `/erd-studio-setup` guide writes it after a yes). Without it, a project records the starting set (below). An ERD Studio 2.0 pre-release from before fields reads only the old spellings and keeps the bare ones as written.

```yaml
version: 1
tables:
  - grain                          # a bare name: the built-in, as shipped
  - purpose
  - key: decisions                 # a built-in in the team's own words
    guidance: Choices finance signed off, and why.
  - open_questions
  - role
  - scd_strategy
  - measures
  - key: owner                     # the team's own fields from here
    label: Owner
    type: value
    guidance: The team that owns it, e.g. crm-team.
    filled_by: dbt
  - key: sensitivity
    label: Sensitivity
    type: choice
    values: [public, internal, confidential]
    filled_by: people
columns:
  - natural_key
  - scd_type
  - additive_type
  - key: pii
    label: Personal data
    type: yes-no
    filled_by: dbt
left_out: [dimension, metrics]     # dbt meta keys that are another tool's settings
```

- **key**: the setting's name in a table file: lower case letters, digits and `_` (DBML lower-cases setting names), never a reserved name ("Setting names" below), listed once. A bare name is a built-in as shipped; an entry with `key` is a built-in in the team's words (only `label`, `guidance` and `filled_by` change; its type, values and show_for are fixed) or a field of the team's own.
- **label**: what the canvas calls it (the exports keep their own labels). **guidance**: one sentence saying what to write; it is the canvas placeholder and your instruction.
- **type**: `text` (the default: a sentence or two), `value` (one short value), `choice` (one of its `values`, at least two, in dropdown order) or `yes-no` (`'true'` or `'false'`).
- **filled_by**: `anyone` (the default: people or you), `people` (you write only a value the user gives you) or `dbt` (copied from the dbt model's `meta:`, never typed in). **show_for**: `dimensions`, `facts` or `all` (the default), read from the table's role; a table with no role shows both, and a field with a value always shows.
- **left_out**: dbt `meta:` keys that are another tool's settings (Lightdash's `dimension`, `metrics`): never copied or offered.
- A missing `tables:` or `columns:` means the starting set's; `tables: []` means none. No `version:` means 1. Unknown keys are ignored. doctor reports a problem in the file under `erd.fields` (an error is the `fix-fields-file` step).

The built-in fields (starting = on without a fields.yml; optional = only when listed):

| key | on | type | default | guidance |
|---|---|---|---|---|
| `grain` | tables | text | starting | One row per ___. The one sentence that says what a row is. |
| `purpose` | tables | text | starting | Who uses this table and the question it answers. |
| `decisions` | tables | text | starting | A choice a later editor might undo, and why. |
| `open_questions` | tables | text | starting | What is still undecided. Assistants ask about these and never guess. |
| `role` | tables | choice (the "Table roles" in `SKILL.md`) | starting | Which kind of table this is: conformed-dim, transaction-fact, … |
| `scd_strategy` | dimensions | text | starting | How this dimension keeps history: which columns track changes and which overwrite. |
| `measures` | facts | text | starting | How the measures add up: which sum across every dimension and which do not. |
| `source_of_truth` | tables | value | optional | The system this data is mastered in. |
| `freshness` | tables | text | optional | How fresh it must be, and how often it loads. |
| `known_issues` | tables | text | optional | Data problems a consumer should know before trusting a number. |
| `retention` | tables, people only | text | optional | How long rows are kept, and why. |
| `natural_key` | columns | yes-no | starting | The business identifier, like an order number or a customer code. |
| `scd_type` | dimension columns | choice `0` / `1` / `2` | starting | 0 never changes, 1 overwrites, 2 keeps history. |
| `additive_type` | fact columns | choice | starting | Additive, semi-additive or non-additive. |
| `business_rule` | columns | text | optional | How the value is worked out, in business terms. |

**Retired** (still read and shown, never offered or written new): `design` (move it to `decisions`, or to `purpose`), `role_choice` and `grain_choice` (move them to `decisions`).

### Setting names

| On a Table or a column | Is |
|---|---|
| `<key>: '<value>'`, for a key that is not reserved (`purpose`, `owner`, `pii`) | that field, listed or not (an unlisted one shows under "Not in your list") |
| `erd_<key>` | the same field, and it wins over `<key>`: for a file where another DBML tool writes its own `<key>` |
| DBML's own: `note`, `headercolor`, `color`, `pk`, `primary key`, `primary_key`, `unique`, `ref`, `dep`, `not null`, `not_null`, `null`, `increment`, `default`, `name`, `type`, `check`, `update`, `delete`, `inactive`, `example` | reserved: never a field key; kept as written |
| ERD Studio's own: `schema`, `alias`, `role`, `grain`, `foreign_key`, `natural_key`, `scd_type`, `additive_type`, `meta_json`, `erd_placeholder`, `linked_table`, and `json`, `dbml`, `constructor`, `__proto__` | reserved: never a key of the team's own (`role` to `additive_type` are the built-ins above) |
| anything starting `erd_`, `rationale_` or `meta_` | never a field key: a spelling of one (below) |
| `meta_json` | metadata that is not text: lists, maps, numbers, and `true` / `false` for a key that is not a yes-no field. A text value is its own setting |
| old spellings: `rationale_<key>` (`rationale_purpose`), `meta_<key>` (`meta_owner`), an entry in `meta_json` | the same field. Change it where it is; never add a second copy. A table holding two spellings uses the bare one (doctor: `fieldSpelledTwice`) |

**Renaming old spellings** is the user's choice: only on a yes, all in one change, and only what doctor counts as `fieldOldSpellings`. A text entry in `meta_json` that doctor counts moves out of the JSON into its own `<key>: '<value>'` setting. Never rename `rationale_design`, `rationale_role_choice` or `rationale_grain_choice` (retired, so doctor does not count them: offer to move the text into `decisions`, showing the result first), a `meta_json` entry doctor does not count, or a `meta_<key>` whose key is reserved or a built-in that is not metadata (`meta_purpose`, `meta_role`, `meta_retention`): that is metadata of its own, shown as "purpose (metadata)", and `meta_<key>` is the same field only for a key of the team's own.

## Relationships file: `<layer>/relationships/<file>.dbml`

Each relationship is **one `Ref` line, stored once, in one relationships file**. Every layer has a default file, `<layer>/relationships/<layer>.dbml`; a team may split Refs across more files in `relationships/` (flat, no subfolders) however it likes. Every diagram that shows both tables and imports the file draws the Ref.

```dbml
// ERD Studio relationships: Refs only, split across relationships/ files however you like. Every table a Ref names has a use line here.
use { table finance.dim_date }   from '../../silver/tables/finance/dim_date.dbml'
use { table sales.dim_customer } from '../tables/sales/dim_customer.dbml'
use { table sales.dim_region }   from '../tables/sales/dim_region.dbml'
use { table sales.fct_order }    from '../tables/sales/fct_order.dbml'

Ref parent: sales.dim_customer.parent_customer_key >? sales.dim_customer.customer_key

Ref: sales.fct_order.customer_key >? sales.dim_customer.customer_key
Ref "order date": sales.fct_order.order_date_key >? finance.dim_date.date_key
Ref "ship date": sales.fct_order.ship_date_key >? finance.dim_date.date_key
Ref: sales.fct_order.(region_code, country_code) >? sales.dim_region.(region_code, country_code)
```

- **Only `use` lines, Refs, comments and pending lines.** A diagram imports the whole file, so a `Table`, `Enum` or `TableGroup` here reaches every importing diagram in other DBML tools (doctor: `relationshipsFileHoldsOther`).
- **`use` lines: one for every table any Ref in the file names**, `use { table <schema>.<name> } from '<path from this file, with .dbml>'`, sorted by path, in one block under the header comment: `../tables/<schema>/<name>.dbml` within the layer, `../../<other layer>/tables/<schema>/<name>.dbml` across layers. Spell the table and the path exactly as the table's file does. Without the line every DBML tool fails the file (`use` is not transitive); ERD Studio reads the Ref anyway and doctor reports `missingUse` with the line to add.
- **Ends are qualified** exactly as the table declares itself: `sales.fct_order.customer_key`.
- **Where a new Ref goes**: the file that already holds the most Refs of its foreign-key table, in any layer (ties: the first path); else its schema's own file `<layer>/relationships/<schema>.dbml` when that file already exists (a team creates it to keep a schema's Refs apart; never create one yourself); else that table's layer default file, created when missing with the header comment above. An existing Ref stays in the file that holds it: change it there, never move it.
- **Operators**, with the foreign-key end marked possibly null by `?`:

  | Cardinality | Write | Notes |
  |---|---|---|
  | many-to-one | `Ref: fct.fk >? dim.pk` | the foreign key first |
  | one-to-one | `Ref: dim.pk ?- fct.fk` | **the key end first, the foreign key second**, marked by `?` |
  | many-to-many | `Ref: a.x <>? b.y` | |

  Never write `<` (one-to-many): turn it round and write `>?` from the other end. **Warning:** a one-to-one written foreign key first (`Ref: fct.fk - dim.pk`, no `?`) is read by its keys and may be read the wrong way round; always write `Ref: dim.pk ?- fct.fk`.
- **A role** (what the link means, e.g. `order date` and `ship date` for two columns pointing at one date table) is the Ref's name: `Ref "ship date": …`. **Name a Ref only to give it a role; the name is shown on the line.** Two Refs may share a role.
- **Composite foreign keys** are one Ref with both column lists in the same order: `Ref: dv.pit.(customer_hk, as_of_date) >? dv.sat.(customer_hk, load_date)`.
- **One Ref per pair of column sets, in one file only.** The same two column sets joined twice — in two files, twice in one, or once each way round — fails every DBML tool (`[5001]`), and doctor reports it as `duplicateRef`. ERD Studio refuses to add a relationship any relationships file already holds.
- **Spell every end exactly** as its table and column are named; a Ref whose other table has no file is not drawn. A self-reference (`hr.employee.manager_id >? hr.employee.employee_id`) is fine; a column never points at itself.
- **Pending relationships** are whole-line comments, `// erd-studio pending: Ref: gold.fct_order.risk_key >? gld_fct_risk.risk_key`, after the Refs: a relationship ERD Studio keeps and draws, but cannot write as a live Ref yet, because an end has no `.dbml` table file (or no such column), or is a table still in YAML. A live Ref there would break the whole file in every DBML tool. **Keep these lines exactly as they are**, never write a new one by hand, and never turn one into a live Ref yourself: ERD Studio does that, with its `use` line, once both ends have table files (Add from dbt, or Convert Project to DBML). To delete such a relationship, delete its line. Doctor reports each as `pendingRelationship`.
- Keep the Refs sorted (by from table, to table, then columns), with one blank line between the Refs of each foreign-key table. Settings on a Ref (`[delete: cascade]`, `[color: …]`) are kept as written.
- ERD Studio never deletes a relationships file, even an empty one.
- **Mark the keys.** Direction comes from keys: mark the referenced column `pk` (or `natural_key: 'true'`) on the table it points at, and `foreign_key: 'true'` on the foreign-key column. Keys win: the many side is never its table's whole primary or natural key while the other end is a column of a table with a different key — such a Ref is drawn backwards, flagged with a ⚠ and reported by doctor as `turn-round-relationships`; offer to rewrite it as `>?` from the column that is not a key to the key, in the file that holds it.

## Diagram: `<layer>/diagrams/<name>.dbml`

```dbml
use { table sales.fct_order }    from '../tables/sales/fct_order.dbml'
use { table sales.dim_customer } from '../tables/sales/dim_customer.dbml'
use { table finance.dim_date }   from '../../silver/tables/finance/dim_date.dbml'
use * from '../relationships/gold.dbml'

Note "3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c" [color: #f59e0b, linked_table: 'fct_order'] {
  'Check the grain with finance'
}

Project sales {
  Note: 'Sales star schema'
  erd_schema_version: '7'
  erd_show_fk_edges: 'false'
  erd_layout: '''
    dim_customer 40 60
    dim_date 40 360
    fct_order 400 200
    note/3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c 720 40 220 120
  '''
}
```

- **The diagram's tables are its table `use` lines**, in order, `use { table <schema>.<name> } from '…'` with paths **relative to the diagram file**, not to `.erd-studio` (`../tables/sales/fct_order.dbml` in the same layer, `../../silver/tables/finance/dim_date.dbml` from another). Doctor reports a path that does not point at the table's file (`usePathMismatch`) with the corrected line.
- **Then one `use * from '…'` for each relationships file that holds a Ref between two of the diagram's tables** (or a pending line between two tables it draws), and no other, sorted by path. Without it no DBML tool draws the Refs from that file, ERD Studio included (doctor: `missingRelationshipsUse`; the canvas warns); ERD Studio adds the line on its next edit to the diagram other than a move. An import that holds nothing between the diagram's tables is `extraRelationshipsUse`. Keep any other `use *` line the user wrote as it is.
- **The diagram's own pending relationships** are `// erd-studio pending: Ref: …` lines after the `use` lines: relationships the diagram held whose foreign-key table has no table file. Keep them as they are; Convert Project to DBML moves each to the library once that table has a file.
- **Sticky notes** are `Note "<id>" [color: <hex>, linked_table: '<table>'] { '<text>' }` after the `use` lines, each with its own id (a UUID; two Notes with one name fail every DBML tool). Colours: `#f59e0b` yellow, `#3b82f6` blue, `#22c55e` green, `#ec4899` pink, `#f97316` orange. `linked_table` is optional and draws a dashed line to that table.
- **`Project <name>` comes last** in a new diagram (an existing file keeps its Project where it is): the diagram's name, its file stem for a new one; double-quote it when it is not a plain identifier or is a DBML keyword, as `Project "customer-360"`, or every DBML tool rejects the file. Its description is `Note`, and `erd_schema_version: '7'` is always there (`'8'` while it shows two tables of one name, below). Optional quoted keys, in this order: `erd_model_folder` (the dbt `models/` path filter), `erd_show_fk_edges` (`'true'` / `'false'`), `erd_layout_options` (JSON text), `erd_stub_columns` (a JSON array of table names whose physical-only columns are not compared — for conformed dimensions included only to anchor relationships), `erd_unlinked_tables` (below), then `erd_layout` last. Keep any other Project key as it is.
- **`erd_unlinked_tables`** (`erd_unlinked_tables: 'gld_fct_risk_child, gld_fct_risk_parent'`, one quoted, comma-separated string) lists tables that are on the diagram but have no `.dbml` file to `use` (none yet, or one still in YAML). ERD Studio draws each one as missing, at its position in `erd_layout`; other DBML tools do not show them. **Keep the key as it is**: never add a `use` line for a name in it (a `use` line to a file that does not exist breaks the diagram for every DBML tool), and never write it empty. When the table gets its file, ERD Studio moves the name to a `use` line itself. To take a table off the diagram, remove its name (and drop the key when it is the last). Doctor reports each as `unlinkedTable`.
- **No Tables, Refs or TableGroups in a diagram**: they belong in the library. A file that declares its own Tables and imports none is a single-file DBML (a dbdiagram.io download): run **ERD Studio: Import DBML…** on it (doctor: `import-dbml-file`).

### Positions: `erd_layout`

The table and sticky-note positions are the Project's `erd_layout`, one triple-quoted string with a line per table, `<name> <x> <y>` (`<schema>.<name> <x> <y>` for two tables of one name, below), sorted by name, then a line per sticky note, `note/<id> <x> <y> <width> <height>` (or `note/<id> <x> <y>` when it has no size), sorted by id. Numbers have at most two decimals. A name may hold spaces: the numbers are read from the end of the line.

- **Omit it, or leave a table out of it, for auto layout**: ERD Studio places what has no position the first time the diagram opens. Never clear positions the user arranged.
- When you add a table to a diagram you may add its line; when you remove one, remove its line. Keep the lines sorted, each two spaces further in than `erd_layout`, with the closing `'''` level with the key.
- **Never end a line inside `erd_layout` with `\`**: DBML joins it with the next line. Write a `\` or `'` in a name as `\\` or `\'`.
- **Never hand-merge `erd_layout`.** When git leaves conflict markers inside it, only positions differ: keep either side whole and delete the markers. ERD Studio reads the first copy of each line until then, and saves no position while the markers are there (doctor: `layoutMergeConflict`).
- Write `erd_layout` once. A second `erd_layout` key is ignored (doctor: `layoutDuplicateKey`), a value that is not a string makes other DBML tools reject the file (`layoutBadValue`), and a line that is not `<name> <x> <y>` is skipped and that table placed automatically (`layoutBadLine`).

## Two tables of one name

A table is its schema folder and its name, compared without case: `bronze/tables/bqs/addresse.dbml` (`Table bqs.addresse`) and `bronze/tables/ccc/addresse.dbml` (`Table ccc.addresse`) are two tables, each with its own columns and Refs. Keep the warehouse's names as they are; never rename a table only to tell it apart from one in another schema.

- **Not allowed:** one schema and name in two layers (`silver/tables/sales/orders.dbml` and `gold/tables/sales/orders.dbml`), or in two schema folders that differ only in case. No Ref can say which is meant, so ERD Studio uses the first and doctor reports `duplicateTableName`: give one its own name (the warehouse name in `alias`), or move it to its own schema folder. Two files of different folders that declare one `schema.name` are `duplicateDeclaredTable`. A YAML table's name is still unique across the whole project (`LEGACY.md`).
- **Ref ends** are qualified, as always (`ccc.kunde.addresse_id >? ccc.addresse.addresse_id`), with a `use` line for each table. A Ref between the two (`ccc.addresse.id >? bqs.addresse.id`) is an ordinary Ref, not a self-join. An unqualified end naming a table two schema folders hold is not drawn (doctor: `ambiguousTableReference`), unless one of them is in `tables/public/`.
- **A diagram that shows one of them** names it by its bare name everywhere, like any table: `addresse 40 60` in `erd_layout`, `linked_table: 'addresse'`.
- **A diagram that shows both** names each of the two `<schema>.<name>`, the schema spelled as the folder in its `use` path: in `erd_layout` (`bqs.addresse 40 60` and `ccc.addresse 400 60`), `linked_table` and `erd_stub_columns`. Its Project says `erd_schema_version: '8'`. Every other table on it keeps its bare name. ERD Studio does this on the edit that adds the second table, and goes back to bare lines and `'7'` on the edit that leaves one. Write a diagram you make by hand the same way: older ERD Studio versions refuse an `'8'` diagram with an update message, rather than drawing one table twice.
- **A JSON diagram** (a project half-way to DBML) names tables by name alone and shows the first of two; show the other on a DBML diagram. A new table's name never holds a dot.
- **The CLI's JSON** keeps `model` and `name` bare and adds `schema` where two schema folders share a name; on a diagram that shows both, its table names and relationship ends read `<schema>.<name>`. Never split such a name at its dot: find the table by the diagram's `use` lines.

## Layout

ERD Studio writes every new `.dbml` in one layout. An edit of an existing file changes only the lines it touches: in a file in the layout those lines are in it too, and a file laid out any other way (by hand) keeps its layout. **Format Document** (Shift+Alt+F, ⇧⌥F on a Mac, or right-click → Format Document) puts a file into the layout, except the blank lines between foreign-key tables' Refs (below). Write in this layout, so the next save by ERD Studio changes only what was meant to change:

- **Two-space indents.** At most one blank line in a row, and none straight after `{` or before `}`.
- **A table's `Note` comes first** in its body, then one blank line, then the columns, then `indexes`.
- **Columns line up**: on consecutive lines, the names are padded to the group's longest name (a name over 32 characters does not widen it); the types are padded to the longest type **of a column that has settings** (a type over 24 characters does not widen it), then one space and the settings. A column with no settings ends at its type, so a long settings-less type such as `"VARCHAR(4000)"` does not push the other columns' settings out. A blank line or an own-line comment between columns starts a new group with its own alignment, so use one to group related columns.
- **Column settings in this order**: `pk`; DBML's own (`not null`, `unique`, `increment`, `default`); ERD Studio's (`natural_key`, `scd_type`, `additive_type`, `foreign_key`); the fields (`pii: 'true'`, any `meta_json`); then `note` last. Written `[a, b: c]`: no space inside the brackets, `, ` between settings, `: ` after a name.
- **Long settings go one per line**: when a column's line would pass 100 characters, `[` ends the column line, each setting sits on its own line two spaces further in with a comma after all but the last, and `]` is alone on the column's indent (as `order_number` above). A Table with two or more settings lists them the same way.
- **Relationships**: single spaces around the operator. When ERD Studio writes a new relationships file, or adds a Ref to one, it sets the Refs of each foreign-key table apart with one blank line; it never adds one between Refs a file already has, and Format Document keeps blank lines that are there but does not add these, so keep a table's Refs together and leave a blank line before the next table's.
- **`use` lines** next to each other line up their `from` (a `use { … }` part over 48 characters does not widen the run).
- Spacing only: text in quotes (a `'''` note or `erd_layout` included) is never changed, and neither is the order of an existing file's lines or settings — ERD Studio keeps the order a file has, so do not reorder one just to match.

## DBML: import and export

The project's own files are DBML; these commands bring other DBML in and send diagrams out.

- **A DBML file in** — from dbdiagram.io, dbdocs, another tool, or an ERD Studio export: point the user at **ERD Studio: Import DBML…** (Command Palette, or the **ERD Studio** view's **…** menu). It needs no dbt and no AI. It reads one self-contained file (no `use` lines), creates a **new** diagram, splits the tables into the library (a `Table s.x` goes into schema folder `s`, under its own name even when another schema has one of that name; a table the library already has in that schema folder is used as it is, never overwritten), places them from the file's own `erd_layout` when it has one, and shows what it will create before writing anything. Prefer it to converting the file yourself; if the user asks you to do it by hand anyway, follow "Building Models from External Sources" in `SKILL.md`.
- **Diagrams out** — **ERD Studio: Export Diagram…** (one diagram) or **ERD Studio: Export All Diagrams…** (every one, into a folder outside `.erd-studio`), with the choice **Rich DBML**: one self-contained `<name>.dbml` with ERD Studio's fields as DBML custom properties (`role`, `grain`, `scd_type`, `natural_key`, `meta_*`, …) and the positions in its Project's `erd_layout`. That single file is the route to dbdiagram.io. The plain **DBML** choice is the portable, notes-only form any DBML tool opens.
- **From the CLI** (stdout only; it never writes a file): `erd-studio export --domain <path> --format dbml-rich` prints the single-file `.dbml`, and `--all` in place of `--domain` prints every diagram as a JSON list of `{ fileName, content }`. When the user asks you to save them, write each `content` to its `fileName` (outside `.erd-studio`) with your own file tools, so the writes stay visible.
- **dbdiagram.io** — `dbdiagram push <name>.dbml --name "<Name>"` (dbdiagram's own CLI: `npm install -g dbdiagram`, then `dbdiagram auth login`) uploads an exported diagram's tables and Refs; dbdiagram.io lays them out itself and ignores `erd_layout`. It sends the data model to dbdiagram.io under the user's account: run it only when the user asks, and show the command first. ERD Studio itself never contacts dbdiagram.io.
- **`meta.dbml`** — an imported table or column may carry a `dbml` entry in its metadata (`meta_json` in DBML, `meta.dbml` in YAML): what the DBML file said that ERD Studio has no field for (`not_null`, `unique`, `default`, `increment`, `checks`, `enum`, `indexes`, `header_color`, the original `name` when it had to change, another tool's own `properties`). In a `.dbml` table a column's `not null`, `unique`, `increment` and `default` are written as DBML's own settings and read back into `meta.dbml` (an older import kept them in `meta_json`: leave that as it is). Keep it exactly as it is — the next DBML export carries it back out — and write or change it only when the user asks.

<!-- erd-studio-harness: 49 -->
