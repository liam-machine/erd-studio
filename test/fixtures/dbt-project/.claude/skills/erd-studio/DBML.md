# ERD Studio — the DBML format

This is how an ERD Studio project stores its model as DBML (ERD Studio 2.0 and later): one file per table in `.erd-studio/tables/`, one `_relationships.dbml` per library folder, and one `.dbml` per diagram in a layer folder, with its layout beside it. The files are a multi-file DBML project, so other DBML tools (DBML 9.1 and later) read them too — keep every rule below, or those tools fail where ERD Studio reads on. Read `SKILL.md` first: it says when this file applies.

## Table file: `tables/[<folder>/]<name>.dbml`

**First rule: quote every custom value, even `'true'` and numbers** — `natural_key: 'true'`, `scd_type: '2'`, `grain: 'One row per order line'`. ERD Studio reads an unquoted `true` or `2`, but DBML 9 and 10 tools reject the whole file (and every diagram that imports it), and an unquoted word or phrase (`role: fact`, `grain: one row`) is an error everywhere, ERD Studio included. `erd-studio doctor` flags both (`unquotedValue`, or the parser's code with "Quote the value"). The same holds for the Project keys of a diagram (`erd_schema_version: '7'`).

```dbml
// Order lines from the shop. Comments like this one survive every save.
Table fct_order [
  schema: 'gold',
  role: 'transaction-fact',
  grain: 'One row per order line',
  rationale_purpose: 'Revenue reporting by day, customer and region',
  meta_owner: 'sales-data',
  meta_json: '{"pii":false,"tags":["finance"]}'
] {
  order_line_id BIGINT [pk, note: 'Line id from the shop']
  customer_key INT [foreign_key: 'true']
  order_date_key INT [foreign_key: 'true']
  amount "DECIMAL(18,2)" [additive_type: 'additive', note: 'Line total']
  order_number VARCHAR [natural_key: 'true']
  loaded_at timestamp [not null, default: `now()`]
  Note: 'Order lines'
}
```

- **Exactly one `Table` per file**, named exactly as the file (`tables/gold/fct_order.dbml` holds `Table fct_order`), unqualified: the schema is the `schema` setting, never `Table gold.fct_order`. Any number of `Enum`s and comments may sit beside it. No `Project`, `TableGroup`, top-level `Note`, `TablePartial` or `Records`.
- **No `use`, no `Ref`, and no inline `[ref: …]` in a table file**: relationships go in the folder's `_relationships.dbml` (below). ERD Studio reads such a file but refuses to change it until the line is moved, and doctor gives the exact Ref line to write instead.
- **Spell names exactly**: the table and column names as they are, in their case (DBML is case-sensitive). A name that is not a plain identifier, or is a DBML keyword, is double-quoted (`"order"`); a type that is not a plain identifier is too (`"DECIMAL(18,2)"`).
- **A table needs at least one column.** A table with none yet holds the placeholder line `_erd_no_columns unknown [erd_placeholder: 'true', note: 'ERD Studio: this table has no columns yet, and DBML needs one']`; delete it when you add the first real column.
- **Primary key**: `pk` on the column; for two or more columns, an `indexes { (a, b) [pk] }` block instead, with no `pk` on the columns.
- The table's description is the `Note: '…'` line, last in the block. A text with a line break is triple-quoted (`'''…'''`); escape `'` as `\'` and `\` as `\\`.
- A flag is written only when it is set (`natural_key: 'true'`); to unset it, delete the setting. Settings ERD Studio does not model (`not null`, `unique`, `default`, `increment`, `note` on an index, `headercolor`, other indexes, Enums, your own custom settings) are kept exactly as written.
- **Never write a `Metadata` block** (`Metadata Table x { … }`): put every property inline, on the Table or the column. A Metadata block silently overrides the inline value.

## Field names

| Meaning | In a table file | Example |
|---|---|---|
| table name | `Table <name>` (the file stem) | `Table dim_customer` |
| schema | `schema` (table setting) | `schema: 'gold'` |
| description | the body's `Note` (last line) | `Note: 'Customer master data'` |
| role (see "Table roles" in `SKILL.md`) | `role` | `role: 'conformed-dim'` |
| grain | `grain` | `grain: 'One row per customer'` |
| warehouse table name (dbt `alias`) | `alias` (never DBML's own `as`) | `alias: 'customer'` |
| design rationale | `rationale_<field>` | `rationale_grain_choice: '…'` |
| metadata, text values | `meta_<key>` (key matching `[a-z_][a-z0-9_]*`) | `meta_owner: 'crm-team'` |
| metadata, anything else | one `meta_json` with those entries as JSON, where its first entry is (ERD Studio also keeps a text value inside it when it sits between two of its entries, so the metadata reads back in key order: leave such a `meta_json` as it is) | `meta_json: '{"pii":true}'` |
| column type | the column's type | `email VARCHAR` |
| column description | `note` (column setting) | `[note: 'Email address']` |
| primary key | `pk`, or `indexes { (a, b) [pk] }` | `[pk]` |
| foreign key (intent) | `foreign_key: 'true'` | `[foreign_key: 'true']` |
| natural (business) key | `natural_key: 'true'` | `[natural_key: 'true']` |
| SCD type | `scd_type: '0'`, `'1'` or `'2'` | `[scd_type: '2']` |
| additive type | `additive_type` | `[additive_type: 'semi-additive']` |
| column metadata | `meta_<key>` / `meta_json` on the column | `[meta_pii: 'yes']` |

Every custom value is a quoted string. `foreign_key` records the intent only: a Ref never sets it, so set it on a foreign-key column yourself. ERD Studio never compares `meta_*` with dbt (see "The team's metadata list" in `SKILL.md`); an imported table may carry a `meta_json` with a `dbml` entry (what an imported DBML file said that ERD Studio has no field for): keep it as it is.

## Relationships file: `tables/[<folder>/]_relationships.dbml`

Each relationship is **one `Ref` line, in the `_relationships.dbml` of the folder that holds its foreign-key table** (the "many" side). Every diagram that shows both tables draws it; one that lacks either does not.

```dbml
// ERD Studio relationships. Each Ref belongs to its foreign-key table, which lives in this folder; every table a Ref names has a use line here.
use { table dim_date } from '../dim_date.dbml'
use { table customer_profile } from './customer_profile.dbml'
use { table dim_customer } from './dim_customer.dbml'
use { table fct_order } from './fct_order.dbml'

Ref: dim_customer.customer_key ?- customer_profile.customer_key
Ref parent: dim_customer.parent_customer_key >? dim_customer.customer_key
Ref: fct_order.customer_key >? dim_customer.customer_key
Ref "order date": fct_order.order_date_key >? dim_date.date_key
Ref "ship date": fct_order.ship_date_key >? dim_date.date_key
Ref: fct_order.(region_code, country_code) >? dim_region.(region_code, country_code)
```

- **`use` lines: one for every table any Ref in the file names**, `use { table <name> } from '<path from this file, with .dbml>'`, sorted by path, in one block under the header comment. Without it every DBML tool fails the file (`use` is not transitive); ERD Studio reads the Ref anyway and doctor reports `missingUse` with the line to add.
- **Operators**, with the foreign-key end marked possibly null by `?`:

  | Cardinality | Write | Notes |
  |---|---|---|
  | many-to-one | `Ref: fct.fk >? dim.pk` | the foreign key first |
  | one-to-one | `Ref: dim.pk ?- fct.fk` | **the key end first, the foreign key second**, marked by `?` |
  | many-to-many | `Ref: a.x <>? b.y` | |

  Never write `<` (one-to-many): turn it round and write `>?` from the other end. **Warning:** a one-to-one written foreign key first (`Ref: fct.fk - dim.pk`, no `?`) is read by its keys and may be read the wrong way round; always write `Ref: dim.pk ?- fct.fk`.
- **A role** (what the link means, e.g. `order date` and `ship date` for two columns pointing at one date table) is the Ref's name: `Ref "ship date": …`. **Name a Ref only to give it a role; the name is shown on the line.** Two Refs may share a role.
- **Composite foreign keys** are one Ref with both column lists in the same order: `Ref: pit.(customer_hk, as_of_date) >? sat.(customer_hk, load_date)`.
- **One Ref per pair of column sets, in one file only.** The same two column sets joined twice — in two files, twice in one, or once each way round — fails every DBML tool (`[5001]`), and doctor reports it as `duplicateRef`.
- **Spell every end exactly** as its table and column are named; a Ref whose other table has no file is not drawn. A self-reference (`employee.manager_id >? employee.employee_id`) is fine; a column never points at itself.
- **Pending relationships** are whole-line comments, `// erd-studio pending: Ref: fct_order.risk_key >? gld_fct_risk.risk_key`, after the Refs: a relationship ERD Studio keeps and draws, but cannot write as a live Ref yet, because an end has no `.dbml` table file (or no such column), or is a table still in YAML. A live Ref there would break the whole file in every DBML tool. **Keep these lines exactly as they are**, never write a new one by hand, and never turn one into a live Ref yourself: ERD Studio does that, with its `use` line, once both ends have table files (Add from dbt, or Convert Project to DBML). To delete such a relationship, delete its line. Doctor reports each as `pendingRelationship`.
- Keep the Refs sorted (by from table, to table, then columns). Settings on a Ref (`[delete: cascade]`, `[color: …]`) are kept as written.
- **Mark the keys.** Direction comes from keys: mark the referenced column `pk` (or `natural_key: 'true'`) on the table it points at, and `foreign_key: 'true'` on the foreign-key column. Keys win: the many side is never its table's whole primary or natural key while the other end is a column of a table with a different key — such a Ref is drawn backwards, flagged with a ⚠ and reported by doctor as `turn-round-relationships`; offer to rewrite it as `>?` from the column that is not a key to the key, in the relationships file of that column's table.

## Diagram: `<layer>/<name>.dbml`

```dbml
Project sales {
  Note: 'Sales star schema'
  erd_schema_version: '7'
  erd_show_fk_edges: 'false'
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

- **`Project <name>`** (the diagram's name, its file stem for a new one; double-quote it when it is not a plain identifier or is a DBML keyword, as `Project "customer-360"`, or every DBML tool rejects the file) with its description as `Note`, and `erd_schema_version: '7'` always. Optional quoted keys: `erd_model_folder` (the dbt `models/` path filter), `erd_show_fk_edges` (`'true'` / `'false'`), `erd_layout_options` (JSON text) and `erd_stub_columns` (a JSON array of table names whose physical-only columns are not compared — for conformed dimensions included only to anchor relationships). Keep any other Project key as it is.
- **The diagram's tables are its table `use` lines**, in order, with paths **relative to the diagram file**, not to `.erd-studio` (`../tables/gold/fct_order.dbml`). Doctor reports a path that does not point at the table's file (`usePathMismatch`) with the corrected line.
- **`erd_unlinked_tables`** on the Project (`erd_unlinked_tables: 'gld_fct_risk_child, gld_fct_risk_parent'`, one quoted, comma-separated string) lists tables that are on the diagram but have no `.dbml` file to `use` (none yet, or one still in YAML). ERD Studio draws each one as missing, at its position in the layout file, exactly as before; other DBML tools do not show them. **Keep the key as it is**: never add a `use` line for a name in it (a `use` line to a file that does not exist breaks the diagram for every DBML tool), and never write it empty. When the table gets its file, ERD Studio moves the name to a `use` line itself. To take a table off the diagram, remove its name (and drop the key when it is the last). Doctor reports each as `unlinkedTable`.
- **The diagram's own pending relationships** are `// erd-studio pending: Ref: …` lines after the `use` lines: relationships the diagram held whose foreign-key table has no table file. Keep them as they are; Convert Project to DBML moves each to the library once that table has a file.
- **Then one `use * from '…'` for the `_relationships.dbml` of every library folder that holds one of the diagram's tables**, when that file exists, sorted by path. Without it other DBML tools draw no Refs (doctor: `missingRelationshipsUse`); ERD Studio draws them anyway.
- **No Tables, Refs or TableGroups in a diagram**: they belong in the library. A file that declares its own Tables and imports none is a single-file DBML (a dbdiagram.io download): run **ERD Studio: Import DBML…** on it (doctor: `import-dbml-file`).
- **Sticky notes** are `Note "<id>" [color: <hex>, linked_table: '<table>'] { '<text>' }` at the end, each with its own id (a UUID; two Notes with one name fail every DBML tool). Colours: `#f59e0b` yellow, `#3b82f6` blue, `#22c55e` green, `#ec4899` pink, `#f97316` orange. `linked_table` is optional and draws a dashed line to that table.
- **The layout file** `<name>.dbdiagram` beside the diagram is JSON holding the positions (`defaultView.tablePositions`, `[{ "name": "fct_order", "schemaName": "public", "x": 400, "y": 200 }]`, and `stickyNoteLayouts`). **Omit it, or leave a table out of it, for auto layout**: ERD Studio places what has no position the first time the diagram opens. Never clear positions the user arranged.

## DBML: import and export

The project's own files are DBML; these commands bring other DBML in and send diagrams out.

- **A DBML file in** — from dbdiagram.io, dbdocs, another tool, or an ERD Studio export: point the user at **ERD Studio: Import DBML…** (Command Palette, or the Subject Areas view's **…** menu). It needs no dbt and no AI. It reads one self-contained file (no `use` lines), creates a **new** diagram, splits the tables into the library (using tables the library already has as they are, never overwriting them), places them from the `<name>.dbdiagram` layout file beside the `.dbml` when there is one, and shows what it will create before writing anything. Prefer it to converting the file yourself; if the user asks you to do it by hand anyway, follow "Building Models from External Sources" in `SKILL.md`.
- **Diagrams out** — **ERD Studio: Export Diagram…** (one diagram) or **ERD Studio: Export All Diagrams…** (every one, into a folder outside `.erd-studio`), with the choice **DBML for dbdiagram.io**: one self-contained `<name>.dbml` with ERD Studio's fields as DBML custom properties (`role`, `grain`, `scd_type`, `natural_key`, `meta_*`, …), plus `<name>.dbdiagram` beside it holding the table positions. That single file is the route to dbdiagram.io. The plain **DBML** choice is the portable, notes-only form any DBML tool opens.
- **From the CLI** (stdout only; it never writes a file): `erd-studio export --domain <path> --format dbml-rich` prints the single-file `.dbml`, `--format dbml-layout` its `.dbdiagram`, and `--all` in place of `--domain` prints every diagram as a JSON list of `{ fileName, content }`. When the user asks you to save them, write each `content` to its `fileName` (outside `.erd-studio`) with your own file tools, so the writes stay visible.
- **dbdiagram.io** — `dbdiagram push <name>.dbml --name "<Name>"` (dbdiagram's own CLI: `npm install -g dbdiagram`, then `dbdiagram auth login`) uploads an exported diagram with the `.dbdiagram` positions next to it. It sends the data model to dbdiagram.io under the user's account: run it only when the user asks, and show the command first. ERD Studio itself never contacts dbdiagram.io.
- **`meta.dbml`** — an imported table or column may carry a `dbml` entry in its metadata (`meta_json` in DBML, `meta.dbml` in YAML): what the DBML file said that ERD Studio has no field for (`not_null`, `unique`, `default`, `increment`, `checks`, `enum`, `indexes`, `header_color`, the original `name` when it had to change, another tool's own `properties`). Keep it exactly as it is — the next DBML export carries it back out — and write or change it only when the user asks.

<!-- erd-studio-harness: 37 -->
