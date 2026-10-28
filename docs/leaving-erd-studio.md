# Leaving ERD Studio (and coming back)

Your data model is never stuck in ERD Studio. **Its files are already [DBML](https://dbml.dbdiagram.io/docs)**, the open format that [dbdiagram.io](https://dbdiagram.io), dbdocs and many other tools read, in your own repository: one `.dbml` file per table in `.erd-studio/tables/`, the relationships in `_relationships.dbml` files, and one `.dbml` file per diagram that lists its tables with `use` lines. Any DBML parser from 9.1 on (the one dbdiagram.io's own tools use) reads them as a multi-file project. (A project created before ERD Studio 2.0 is YAML and JSON until you run **ERD Studio: Convert Project to DBML**.)

dbdiagram.io itself takes one self-contained file per diagram, not a folder of files that `use` each other. For that, **export** each diagram: the export keeps ERD Studio's modelling fields and your table positions, and ERD Studio can import it back.

This page shows how to move every diagram to dbdiagram.io, what goes with it, and how to bring a DBML file into ERD Studio.

## Your files, or an export?

| | Your project's own `.dbml` files | An export (**DBML for dbdiagram.io**) |
|---|---|---|
| Shape | split: one file per table, per folder's relationships and per diagram, joined by `use` lines | one file per diagram, every table and relationship in it |
| Read by | DBML parsers 9.1 and 11+ (10.x too, unless a folder in the path has a space), as a multi-file project | dbdiagram.io (`dbdiagram push`), dbdocs and any DBML 9.1+ tool |
| Positions | the `.dbdiagram` file beside each diagram | the `.dbdiagram` file beside the export |
| Edited by ERD Studio | yes: your hand edits and comments are kept | no: it is a copy |

## Move every diagram to dbdiagram.io

1. In VS Code, run **ERD Studio: Export All Diagrams…** from the Command Palette.
2. Choose **DBML for dbdiagram.io**.
3. Pick a folder and click **Export Here**. If any of the files are already there, ERD Studio asks once before replacing them.

You get two files for each subject area (diagram), side by side:

| File | What it holds |
|---|---|
| `sales.dbml` | the tables, columns, keys and relationships, with ERD Studio's fields as DBML properties |
| `sales.dbdiagram` | where each table sits on the canvas, in dbdiagram.io's own layout format |

Each file is named after its subject area. When two layers have a subject area with the same name, the layer goes in front (`gold-sales.dbml`). Save the export outside `.erd-studio/`: ERD Studio refuses a folder inside it, where the files are your diagrams' own storage.

Then upload them with dbdiagram.io's own command-line tool, under your own dbdiagram.io account:

```sh
npm install -g dbdiagram
dbdiagram auth login
dbdiagram push sales.dbml --name "Sales"
```

`dbdiagram push` reads `sales.dbdiagram` from the same folder, so the diagram opens with the tables where you left them. Run one `push` per subject area.

ERD Studio never connects to dbdiagram.io itself. It only writes the files; you choose what to upload.

### Just one diagram

**ERD Studio: Export Diagram…** (also in a subject area's right-click menu, and the canvas toolbar's **Export** button) exports the diagram you are looking at. Choose **DBML for dbdiagram.io**, then **Save As…**: ERD Studio saves the `.dbml` and, beside it, the `.dbdiagram` with the same name. **Copy to Clipboard** and **Open in Editor** give the DBML on its own, without positions.

The plain **DBML** choice is for older DBML tools: it opens anywhere, but ERD Studio's fields go into notes, and it has no positions. Use **DBML for dbdiagram.io** whenever the tool reads DBML 9.1 or later, as dbdiagram.io and dbdocs do.

### Without VS Code

The read-only `erd-studio` helper (installed in `~/.erd-studio-cli` by **Set Up My AI Helper**) prints the same files:

```sh
~/.erd-studio-cli/bin/erd-studio export --domain .erd-studio/silver/sales.dbml --format dbml-rich   > sales.dbml
~/.erd-studio-cli/bin/erd-studio export --domain .erd-studio/silver/sales.dbml --format dbml-layout > sales.dbdiagram
```

`--all` in place of `--domain` prints every subject area as a JSON list of `{ "fileName", "content" }`, the same files and names **Export All Diagrams…** writes. The helper only ever prints; it never writes a file.

## What goes with it

| In ERD Studio | In the DBML |
|---|---|
| Subject area name and description | `Project` and its note |
| Layer, and its colour | a `TableGroup` holding every table |
| Table, schema, description | `Table schema.name` and its note |
| Role, grain, warehouse name (alias) | `role`, `grain`, `alias` |
| Design rationale | `rationale_purpose`, `rationale_grain_choice`, … |
| Metadata (`meta`) | `meta_<key>` for a text value; everything else (numbers, lists, nested maps, …) in one `meta_json` |
| Column type, description, primary key (also composite) | the column's type, note and `pk` |
| Natural key, SCD type, additive type, foreign key | `natural_key`, `scd_type`, `additive_type`, `foreign_key` |
| Relationships, with their names and composite keys | `Ref` lines, written from the foreign key |
| Sticky notes, their colour and linked table | `Note` blocks |
| Table positions | the `.dbdiagram` file |

dbdiagram.io and dbdocs show the properties on each table and column, rather than burying them in notes.

## What doesn't

- **The Physical view.** It is worked out from your dbt project each time and was never saved, so there is nothing to export. Your dbt project still has it all.
- **Sticky-note positions and sizes.** The notes go, with their text and colour, but not where they sat. On import they are placed in a row above the tables.
- **Some diagram settings**: the dbt folder filter for adding tables (`modelFolder`), which tables show only their key columns (`stubColumns`), and the canvas's display options.
- **Whether a foreign key can be empty.** ERD Studio doesn't record it, so every relationship is written as possibly empty (the `?` in `>?`), and import ignores the `?`.
- **The files' own formatting**: comments, the order of settings and DBML settings ERD Studio does not use stay in your project's own files, but an export is written fresh. The values all come back.

A few things come back written a little differently but mean the same: a one-to-many relationship comes back as the many-to-one it is, stored from the other table; a composite key's label is regenerated; and positions are rounded to two decimal places.

## Coming back: Import DBML…

**ERD Studio: Import DBML…** (in the Command Palette, the Subject Areas view's **…** menu, and the empty sidebar) turns a DBML file into a new diagram. It reads ERD Studio's own exports and DBML from dbdiagram.io or any other tool. It doesn't need dbt or an AI assistant.

1. Pick the `.dbml` file. If a `.dbdiagram` file with the same name sits beside it (`dbdiagram pull` writes one), the tables go where it says; otherwise ERD Studio lays them out the first time the diagram opens.
2. Pick the layer. The one the file's `TableGroup` or schema names is suggested first.
3. Name the diagram. The `Project` name, or the file's name, is suggested.
4. Read the summary of what will be created, kept and left out, and click **Import**.

Nothing is written until you click **Import**, and if anything fails part-way every file is put back. A file that isn't valid DBML gets a message naming its first problems by line, and **Open File** takes you to the first one.

What to expect:

- **A new diagram every time.** Import never changes an existing diagram. In a DBML project (2.0) it writes the new tables as `.dbml` files in `tables/`, their relationships into the `_relationships.dbml` of their folder, and the diagram as a `.dbml` with its `.dbdiagram`; in a project from before 2.0 it writes YAML and JSON, as before.
- **One self-contained file.** A `.dbml` that `use`s other files is part of a multi-file project (another ERD Studio 2.0 project, say) and is refused: export a single-file DBML from it (in ERD Studio, **Export Diagram…** → **DBML for dbdiagram.io**) and import that.
- **Tables already in your Table Library are used as they are**, never overwritten, matching names regardless of case. So if you changed one of those tables in dbdiagram.io, import into a project that doesn't have that table yet, or delete it from the Table Library first, to take the dbdiagram.io version.
- **Names ERD Studio can't use are fixed.** A table called `Order Items` becomes `Order_Items`, and two tables called `date` in the `silver` and `gold` schemas become `silver_date` and `gold_date`. The original name is kept as the table's warehouse name (`alias`) when it is a valid one, as `date` is here; otherwise, as for `Order Items`, it is kept under `dbml` in the table's metadata (`meta.dbml.name`). The summary lists each change.
- **DBML settings ERD Studio has no field for are kept.** Not null, unique, defaults, increments, checks, enum values, indexes, header colours and another tool's own properties are saved under `dbml` in the table's or column's metadata (`meta`, a `meta_json` property in a `.dbml` table), so the next export carries them back out.
- **Some things are left out**, and the summary lists them: sample rows (`Records`), a relationship's `delete` / `update` actions, colour and `inactive` flag, the project's database type, table groups other than the layer, and diagram views.

Property names are read with or without an `erd_` prefix (`erd_grain` as well as `grain`), for teams whose own DBML already uses the plain name for something else.
