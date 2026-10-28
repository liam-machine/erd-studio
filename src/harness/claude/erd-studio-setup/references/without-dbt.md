# Setting up without dbt

This is the whole walkthrough for a project folder with **no `dbt_project.yml`** — SKILL.md's
"Without dbt" route. It replaces Stages 0–6 there; "How to talk", "Your AI assistant" and the
helper's exit-code rules in SKILL.md still apply. The user may never use dbt, and ERD Studio does
not need it: here it is a logical data modelling tool whose files live in their repo.

Rules for this route, on top of SKILL.md's:

- **Never tell the user to install dbt**, or imply they need it, and never run a `dbt` command.
- **Never run `diff`.** It compares the design with a dbt project, so here it only exits with an
  error. The helper commands for this route are `doctor` and `export` (below).
- In a folder without dbt the canvas has no **Physical** tab and no **⊕ Diff** button. Do not
  mention them, physical models, drift or sync plans — except the one "Using dbt?" line in
  step 6.
- Say "diagram". The first time, add once: "the commands call a diagram a *subject area*".

Checklist for this route (show it at each step boundary, as SKILL.md's "Show progress" says):

```
→ 1. Check the project
  2. Choose a starting point
  3. Design the tables
  4. Write the files
  5. Check the files
  6. Open it in ERD Studio
```

## 1. Say hello and check the project

Greet the user in about four short lines:

- ERD Studio keeps a *logical data model* — the tables, their keys and how they connect — as
  plain YAML and JSON files in `.erd-studio/`, so it is reviewed and versioned like code.
- You will design one diagram with them, write its files, check them, and open it on the canvas.
  Nothing outside `.erd-studio/` changes.
- Want to see a finished one first? **ERD Studio: Open Example Diagram** (Command Palette) opens
  a small coffee-shop model — no AI needed.

Then look before asking. Say "Checking this folder," and run
`~/.erd-studio-cli/bin/erd-studio doctor --json --semantic-dir .erd-studio` — every time, even in
an empty folder, so a missing or stale helper shows up now rather than after the files are
written. Then:

- **The helper is missing or stale** (exit 127 or exit 5) → SKILL.md's exit-code rules. Without
  it, carry on: you re-read every file you write in step 5, and the user checks the diagram on
  the canvas. If the folder has no `.erd-studio/`, start fresh as below.
- **Doctor reports `dbtProject: true`** → the helper found a dbt project after all (one level
  up, or a few folders down): this is the dbt route. Go back to SKILL.md, greet as Stage 0 says
  and carry on from Stage 1 with this doctor result.
- **`erd.semanticDirExists: false`** → there is nothing to check yet: say "This folder has no
  ERD Studio files yet, so we'll start fresh." Say nothing about the rest of the result (no dbt
  project, no skills, empty `nextSteps` — all expected here). A new project writes **DBML**
  (doctor's `erd.storage` says `dbml`): `.erd-studio/layers.json` first, tables in `tables/`,
  diagrams in a layer folder, as the schema skill's `DBML.md` says. But if the user says they already
  have diagrams (the ERD Studio sidebar lists them), their ERD Studio folder has another name —
  the `erdStudio.semanticDir` setting changed after **Set Up My AI Helper** ran. Ask them to run
  **ERD Studio: Set Up My AI Helper** again (it writes the new folder name into these files), or
  ask for the setting and pass it with `--semantic-dir`; do not start fresh beside their
  diagrams.
- **`erd.semanticDirExists: true`** → say "Checking your ERD Studio files." Doctor reports
  `dbtProject: false` and `skippedChecks` with reason `not-dbt-project`: the dbt checks were
  skipped on purpose — say nothing about them. (Its `project.found` is `false` here too, for the
  same reason; do not ask which folder holds a dbt project.) Read:
  - `erd.storage` — which format to write (the schema skill's "What to write": `dbml`, `yaml` or `mixed`);
  - `erd.domains` and `erd.logicalModels` — whether diagrams and tables exist already;
  - `nextSteps` — handle `fix-model-yaml`, `fix-dbml-file`, `resolve-merge-conflicts`,
    `resolve-format-conflicts`, `finish-dbml-conversion`, `import-dbml-file` and
    `turn-round-relationships` as SKILL.md and `references/troubleshooting.md` say;
    `fix-subject-area-naming` by using one set of key names in each file it lists, as its `why`
    says; `resolve-naming-conflicts` by showing the user both files and asking which to keep. A
    merge conflict or a naming conflict is always the user's to settle.

## 2. Choose a starting point

Pick it yourself when the evidence is clear, say it in one line, and carry on:

1. **Enrich what is there** — doctor reports diagrams or tables and the user did not name a new
   area: follow "Enriching existing tables" below.
2. **From a DBML file** — the user mentions DBML, dbdiagram.io or a `.dbml` file, or Glob finds
   one (`**/*.dbml`, skipping `node_modules` and the ERD Studio folder itself, `.erd-studio/`,
   whose own files are DBML too). Do not convert it yourself: ask them to run
   **ERD Studio: Import DBML…** (Command Palette, or the **…** menu of the ERD Studio sidebar's
   diagram list). It needs no AI, shows what it will create before writing anything, and places
   the tables from a `.dbdiagram` layout file beside the `.dbml` when there is one. DBML is an
   open format (the schema language behind dbdiagram.io); ERD Studio reads it in and writes it
   out, and ERD Studio stores its own model as DBML too, split into one file per table. When they say "done", re-run doctor and
   enrich the new diagram (route 1). Convert by hand only if they ask; then follow the schema
   skill's "Building Models from External Sources".
3. **From a description** — everyone else, the default.

When nothing decides it, ask one question with a default: "Shall I design a first diagram from a
description of your business? Say yes and tell me what it does — or point me at a DBML file."

## 3. Design the tables (from a description)

**What to model.** If the user has not said, ask one question: "What does the business do, and
which part should the first diagram cover? For example: 'a coffee shop — orders, customers,
products and stores'." If they named an area when they started, use it.

**The modelling style.** There is no dbt project to detect it from, so:

- `.erd-studio/modelling-approach.md` describes a style → confirm it in one line, as SKILL.md
  Stage 3b says, and follow it.
- Existing table names show one (`dim_` / `fct_`, `hub_` / `sat_` / `link_`) → offer it as a
  guess with the evidence, in one question.
- Otherwise propose one that fits what they described, with a yes default: for reporting and
  analytics, "I'll shape it as a star schema (Kimball): a fact table for each business event, such
  as an order, joined to dimension tables that describe it, such as customer and product. Sound
  right? Or describe how your team models data." For an application's own database, propose a
  normalised design (3NF) the same way. "Not sure" means your proposal.
- On a yes, or a style in their own words: look it up, play it back and agree it exactly as
  SKILL.md Stage 3b and `references/modelling-approaches.md` sections 1 and 3 say, then save
  `.erd-studio/modelling-approach.md` in step 4 (section 5's shape; write
  `**Chosen:** proposed for a new design, agreed <date>` in place of the "Detected from" line).

**Draft the design**, at most eight tables for a first diagram, and show it as one compact list —
per table: its name, role, grain ("One row per …"), primary key, a handful of important columns
with types, and what it connects to. Then ask "Shall I write these?" (default yes). Take changes
one round at a time. This is the one place you invent columns rather than copying them, so:

- **Names** match `^[A-Za-z][A-Za-z0-9_]*$`: lowercase snake_case, unique across the library.
  Use the style's prefixes (`dim_`, `fct_`) only when the agreed style uses them.
- **Every table has a primary key** (`pk` in DBML, `isPrimaryKey: true` in YAML) — a surrogate key
  when the style wants one, plus a natural key (`natural_key: 'true'`, `isNaturalKey: true` in YAML)
  on the business identifier (customer code, SKU).
- **Every foreign key** is named after the key it points at (`customer_id` →
  `customer.customer_id`), marked `foreign_key: 'true'` (`isForeignKey: true` in YAML), and has a
  `many-to-one` relationship owned by the table that holds it (a `>?` Ref in its folder's
  `_relationships.dbml`; in YAML, in its own file).
- **Types** are plain SQL (`INTEGER`, `VARCHAR`, `DECIMAL(18,2)`, `DATE`, `TIMESTAMP`, `BOOLEAN`),
  or the warehouse's own spelling when the user names one.
- **Design fields** — `grain` on every table; the role (`role` in DBML; `tableRole`, or `modelRole`
  in v5 YAML) only from the values in `references/modelling-approaches.md` section 2; the SCD and
  additive types (`scd_type` / `additive_type`, `scdType` / `additiveType` in YAML) where the style
  makes them clear; a one-line purpose (`rationale_purpose`, `rationale.purpose` in YAML), and
  the design rationale (`rationale_design`) citing the approach. Without dbt these record the intended design, so the
  dbt route's "describe what dbt does today" rule and its Target-design backlog do not apply.
- **Descriptions**: one plain line per table and column. Leave out audit columns
  (`created_at`, `loaded_at`) unless the style asks for them.
- **Metadata** (`meta`): only keys the team's metadata list names (Source `the team`) or the user
  gives, with values they gave — `references/metadata.md`; never invent one.
- Anything you are unsure of (a type, a role, a cardinality) goes on a "to confirm" list for
  step 6.

## Enriching existing tables

The tables are someone's design (perhaps an Import DBML or a canvas draft): add what is missing,
never rebuild them.

1. Glob the subject area files (`.erd-studio/*/*.{dbml,json}`) and propose one (the one named, else the
   largest): "You have the **sales** diagram (6 tables). I'll add what's missing — keys, grain,
   roles, descriptions and the connections the columns suggest — and leave the rest alone. OK?"
2. Read the subject area and each of its table files.
3. Draft, per table, only what is missing: a primary key, the foreign-key flag on columns that point at
   another table's key, the relationships those columns imply (between tables in this diagram),
   the grain, the role (section 2's values), natural keys, descriptions and the rationale's purpose.
   With an agreed approach, follow it. Never rename a table or column, change a type, or remove
   anything without asking.
4. Show the drafts as one short list per table, ask "Add these?" once, and write them on a yes —
   then steps 5 and 6.

## 4. Write the files

1. Load ERD Studio's format rules and prepare the user for approval prompts — SKILL.md Stage 4
   steps 1 and 2.
2. Save the modelling approach, when one was agreed (step 3).
3. Write the files following `references/building-the-model.md` — "Which files to write", "Where
   a new model file goes", "layers.json", "Quote every text value" and "Diagram file" — in the
   format from step 1 (`erd.storage`; a new project is DBML). Without dbt:
   - **Layer**: the one the user named, else the one their existing diagrams use, else `gold` for
     a reporting design and `silver` for anything else. A new project writes `.erd-studio/layers.json`
     first (building-the-model.md, "layers.json"). Tell them layers are only folders for organising diagrams.
   - **Diagram file**: in DBML, `.erd-studio/<layer>/<name>.dbml` with its `Project` and one
     `use` line per table, and no `.dbdiagram` layout file, so the canvas arranges it the first
     time it opens; in a YAML project, `.erd-studio/<layer>/<name>.json` listing the tables, with
     no `modelFolder` (that is dbt's folder filter) and `"viewConfig": {}`.
   - **Relationships** go in the table library: in DBML, a Ref line in the `_relationships.dbml`
     of the folder holding the foreign-key table; in YAML, in the table file holding the foreign key —
     unless the project's existing diagrams keep theirs in the subject area file
     (building-the-model.md, "Where they go").
   - A table that already has a file is **referenced by name, never rewritten**.
4. Keep a list of every file you wrote, and tell the user in one line ("Wrote 6 table files and
   the `sales` diagram"), not file by file.

## 5. Check the files

Say "Checking the files ERD Studio will read," then run doctor (as in step 1). Fix each
`fix-model-yaml` and `fix-dbml-file` it lists (the file and line, usually a value to quote) — except a merge conflict — and
each `fix-subject-area-naming`, and offer `turn-round-relationships` fixes. Then check the
diagram loads end to end: say "Checking the whole diagram loads," and run
`~/.erd-studio-cli/bin/erd-studio export --domain .erd-studio/<layer>/<name>.dbml --format dbml --semantic-dir .erd-studio`
(the `.json` file in a YAML project).
Exit 3 means the subject area file itself cannot be read: the message names the problem; fix it
and run it again. Exit 0 means the subject area file loaded — not yet that every table did. Read
the output (do not paste it) for lines starting `// Table … is not exported` (a table with no
file and a table with no columns both read "has no columns" — check which; a file that does not
parse names its line) and for `// Not exported:`
lines after the opening comments (a table or relationship ERD Studio could not write; the
header's own "Not exported: canvas positions and sizes…" line is always there and is fine). Fix
each and run it again; the check passes only when exit 0 comes with none of those lines.

Then your own silent cross-check, reporting only problems: every table in the subject area has a
file; every relationship's columns exist on both tables; every foreign-key column has a
relationship; no key or setting is written twice in one block; in DBML, doctor's `dbmlProblems`
lists no warning about a `use` line you wrote. Stop after three rounds of fixes and list
what remains.

Without the helper, re-read every file you wrote for these same checks, and tell the user a
table drawn with no columns on the canvas means its file did not parse.

## 6. Open it in ERD Studio

- Tell them how to see it: the **ERD Studio** sidebar in VS Code, expand the layer, click the
  diagram. It is arranged automatically the first time (re-run with **Layout** or Shift+L).
- Summarise what you wrote, the approach you applied, and the "to confirm" list.
- Suggest next steps:
  - more tables, or another diagram: ask you, or run `/erd-studio-setup` again (their own
    assistant's form of it) — existing tables are kept and shared;
  - review the files in a pull request like any other change;
  - share or take it elsewhere: **ERD Studio: Export Diagram…** writes DBML (for dbdiagram.io
    or any DBML tool) or Mermaid;
  - the one dbt line, said once: "Using dbt? Open its folder to compare your design with what dbt
    built."
