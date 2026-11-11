<!-- dbt-only --># Setting up without dbt

This is the whole walkthrough for a project folder with **no `dbt_project.yml`** — SKILL.md's
"Without dbt" route. It replaces Stages 0–6 there; "How to talk", "Your AI assistant" and the
helper's exit-code rules in SKILL.md still apply. The user may never use dbt, and ERD Studio does
not need it: here it is a logical data modelling tool whose files live in their repo.

Rules for this route, on top of SKILL.md's:

- **Never tell the user to install dbt**, or imply they need it, and never run a `dbt` command.
- **Never run `diff`.** It compares the design with a dbt project, so here it only exits with an
  error. The helper commands for this route are `doctor` and `export` (below).
- In a folder without dbt the canvas has no **Physical** tab and no **Compare with dbt** button. Do not
  mention them, physical models, drift or sync plans — except the one "Using dbt?" line in
  step 6.
- Say "diagram", never "subject area".<!-- /dbt-only -->
<!-- no-dbt --># The guided setup

This is the whole walkthrough, from saying hello to opening the diagram. "How to talk", "Your AI
assistant" and the helper's exit-code rules in SKILL.md apply throughout. ERD Studio here is a
logical data modelling tool: the files in `.erd-studio/` are the whole design, and they live in
the user's repo.

Rules for this walkthrough, on top of SKILL.md's:

- The helper commands are `doctor` and `export` (below). Never run `diff`: there is nothing here
  for it to compare the design with, so it only exits with an error.
- Never suggest the user needs another tool, and never run one: the design is the files.
- Say "diagram", never "subject area".<!-- /no-dbt -->

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
  plain text files in `.erd-studio/` (DBML, an open format; YAML and JSON in a project from before
  ERD Studio 2.0), so it is reviewed and versioned like code.
- You will design one diagram with them, write its files, check them, and open it on the canvas.
  Nothing outside `.erd-studio/` changes.
- Want to see a finished one first? **ERD Studio: Open an Example…** (Command Palette) opens
  a small coffee-shop model to explore by hand.

Then look before asking. Say "Checking this folder," and run
`~/.erd-studio-cli/bin/erd-studio doctor --json --semantic-dir .erd-studio` — every time, even in
an empty folder, so a missing or stale helper shows up now rather than after the files are
written. Then:

- **The helper is missing or stale** (exit 127 or exit 5) → SKILL.md's exit-code rules. Without
  it, carry on: you re-read every file you write in step 5, and the user checks the diagram on
  the canvas. If the folder has no `.erd-studio/`, start fresh as below.
<!-- dbt-only -->- **Doctor reports `dbtProject: true`** → the helper found a dbt project after all (one level
  up, or a few folders down): this is the dbt route. Go back to SKILL.md, greet as Stage 0 says
  and carry on from Stage 1 with this doctor result.<!-- /dbt-only -->
<!-- no-dbt -->- **Doctor's `projectRoot` is not this folder** → the helper looked at another folder (one level
  up, or a few folders down). Pass `--project .` on this and every later helper command, and run doctor
  again.<!-- /no-dbt -->
- **`erd.semanticDirExists: false`** → there is nothing to check yet: say "This folder has no
  ERD Studio files yet, so we'll start fresh." Say nothing about the rest of the result (<!-- dbt-only -->no dbt
  project, <!-- /dbt-only -->no skills, empty `nextSteps` — all expected here). A new project writes **DBML**
  (doctor's `erd.storage` says `dbml`): `.erd-studio/layers.json` first, then everything under a
  layer folder (`<layer>/tables/<schema>/`, `<layer>/relationships/`, `<layer>/diagrams/`), as the schema skill's `DBML.md` says. But if the user says they already
  have diagrams (the ERD Studio sidebar lists them), their ERD Studio folder has another name —
  the `erdStudio.semanticDir` setting changed after **Set Up My AI Helper** ran. Ask them to run
  **ERD Studio: Set Up My AI Helper** again (it writes the new folder name into these files), or
  ask for the setting and pass it with `--semantic-dir`; do not start fresh beside their
  diagrams.
- **`erd.semanticDirExists: true`** → say "Checking your ERD Studio files." <!-- dbt-only -->Doctor reports
  `dbtProject: false` and `skippedChecks` with reason `not-dbt-project`: the dbt checks were
  skipped on purpose — say nothing about them. (Its `project.found` is `false` here too, for the
  same reason; do not ask which folder holds a dbt project.)<!-- /dbt-only --><!-- no-dbt -->Doctor's `skippedChecks`,
  `project.found: false` and the empty blocks beside them are expected here — say nothing about
  them, and do not ask about another project folder.<!-- /no-dbt --> Read:
  - `erd.storage` — which format to write (the schema skill's "What to write": `dbml`, `yaml` or `mixed`);
  - `erd.domains` and `erd.logicalModels` — whether diagrams and tables exist already;
  - `nextSteps` — handle `fix-model-yaml`, `fix-dbml-file`, `fix-fields-file`, `resolve-merge-conflicts`,
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
   **ERD Studio: Import DBML…** (Command Palette, or the **+** menu of the ERD Studio sidebar's
   Diagrams view). It needs no AI, shows what it will create before writing anything, and places
   the tables from the file's own `erd_layout` positions when it has them. DBML is an
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

**The modelling style.** <!-- dbt-only -->There is no dbt project to detect it from, so:<!-- /dbt-only --><!-- no-dbt -->Nothing in the folder says it yet, so:<!-- /no-dbt -->

- `.erd-studio/modelling-approach.md` describes a style → confirm it in one line<!-- dbt-only -->, as SKILL.md
  Stage 3b says,<!-- /dbt-only --><!-- no-dbt --> ("I'll follow your saved approach: Kimball dimensional modelling — say
  'change it' to update."),<!-- /no-dbt --> and follow it.
- Existing table names show one (`dim_` / `fct_`, `hub_` / `sat_` / `link_`) → offer it as a
  guess with the evidence, in one question.
- Otherwise propose one that fits what they described, with a yes default: for reporting and
  analytics, "I'll shape it as a star schema (Kimball): a fact table for each business event, such
  as an order, joined to dimension tables that describe it, such as customer and product. Sound
  right? Or describe how your team models data." For an application's own database, propose a
  normalised design (3NF) the same way. "Not sure" means your proposal.
- On a yes, or a style in their own words: <!-- dbt-only -->look it up, play it back and agree it exactly as
  SKILL.md Stage 3b and `references/modelling-approaches.md` sections 1 and 3 say, then save<!-- /dbt-only --><!-- no-dbt -->look up its standard as
  `references/modelling-approaches.md` sections 1 and 3 say (narrate it, say whether you used the
  web or the bundled summary, and never block on the lookup), ask at most one clarifying
  question, then play it back as 3–6 short, concrete bullets and ask "Sound right?" (default
  yes), defining each term the first time. Then save<!-- /no-dbt -->
  `.erd-studio/modelling-approach.md` in step 4 (section 5's shape<!-- dbt-only -->; write
  `**Chosen:** proposed for a new design, agreed <date>` in place of the "Detected from" line<!-- /dbt-only -->).

**Draft the design**, at most eight tables for a first diagram, and show it as one compact list —
per table: its name, role, grain ("One row per …"), primary key, a handful of important columns
with types, and what it connects to. Then ask "Shall I write these?" (default yes). Take changes
one round at a time. This is the one place you invent columns rather than copying them, so:

- **Names** match `^[A-Za-z][A-Za-z0-9_]*$`: lowercase snake_case, each used once (in DBML, once per schema folder).
  Use the style's prefixes (`dim_`, `fct_`) only when the agreed style uses them.
- **Every table has a primary key** (`pk` in DBML, `isPrimaryKey: true` in YAML) — a surrogate key
  when the style wants one, plus a natural key (`natural_key: 'true'`, `isNaturalKey: true` in YAML)
  on the business identifier (customer code, SKU).
- **Every foreign key** is named after the key it points at (`customer_id` →
  `customer.customer_id`), marked `foreign_key: 'true'` (`isForeignKey: true` in YAML), and has a
  `many-to-one` relationship owned by the table that holds it (a `>?` Ref in a
  `<layer>/relationships/` file; in YAML, in its own file).
- **Types** are plain SQL (`INTEGER`, `VARCHAR`, `DECIMAL(18,2)`, `DATE`, `TIMESTAMP`, `BOOLEAN`),
  or the warehouse's own spelling when the user names one.
- **Design fields** — `grain` on every table; the role (`role` in DBML; `tableRole`, or `modelRole`
  in v5 YAML) only from the values in `references/modelling-approaches.md` section 2; the SCD and
  additive types (`scd_type` / `additive_type`, `scdType` / `additiveType` in YAML) where the style
  makes them clear; a one-line purpose (`purpose`, `rationale.purpose` in YAML), `decisions`
  (`rationale.decisions`) citing the approach, and any other field `.erd-studio/fields.yml`
  lists, as its guidance says. <!-- dbt-only -->Without dbt these record the intended design, so the
  dbt route's "describe what dbt does today" rule and its Target-design backlog do not apply.<!-- /dbt-only --><!-- no-dbt -->They record the intended design.<!-- /no-dbt -->
- **Descriptions**: one plain line per table and column. Leave out audit columns
  (`created_at`, `loaded_at`) unless the style asks for them.
- **The team's own fields** (owner, source system…): only fields `.erd-studio/fields.yml` lists
  or the user asks for, with values they gave; never invent one, and fill a `filled_by: people`
  field only with a value the user gives. When the user wants a field recorded on every table,
  offer once to add it to fields.yml, showing the entry first (`key`, `label`, a `type` — `text`,
  `value`, `choice` with its `values`, or `yes-no` — one sentence of `guidance`, and
  `filled_by: people` when only people fill it in; the format is the schema skill's `DBML.md` →
  "fields.yml"). With no file yet, list the starting set's names first (`grain`, `purpose`,
  `decisions`, `open_questions`, `role`, `scd_strategy`, `measures`; columns `natural_key`,
  `scd_type`, `additive_type`), so nothing else changes. An old `## Metadata` table in
  `.erd-studio/modelling-approach.md` names the team's fields until it moves: offer once to move
  it into fields.yml (show the result; remove the old section on a yes).<!-- dbt-only --> More:
  `references/metadata.md` sections 4 and 7.<!-- /dbt-only -->
- Anything you are unsure of (a type, a role, a cardinality) goes on a "to confirm" list for
  step 6.

## Enriching existing tables

The tables are someone's design (perhaps an Import DBML or a canvas draft): add what is missing,
never rebuild them.

1. Glob the diagram files (`.erd-studio/*/diagrams/*.dbml` and `.erd-studio/*/*.json`) and propose one (the one named, else the
   largest): "You have the **sales** diagram (6 tables). I'll add what's missing — keys, grain,
   roles, descriptions and the connections the columns suggest — and leave the rest alone. OK?"
2. Read the diagram and each of its table files.
3. Draft, per table, only what is missing: a primary key, the foreign-key flag on columns that point at
   another table's key, the relationships those columns imply (between tables in this diagram),
   the grain, the role (section 2's values), natural keys, descriptions and the purpose.
   With an agreed approach, follow it. Never rename a table or column, change a type, or remove
   anything without asking.
4. Show the drafts as one short list per table, ask "Add these?" once, and write them on a yes —
   then steps 5 and 6.

## 4. Write the files

1. Load ERD Studio's format rules and prepare the user for approval prompts — <!-- dbt-only -->SKILL.md Stage 4
   steps 1 and 2<!-- /dbt-only --><!-- no-dbt -->as your row in
   SKILL.md's "Your AI assistant" says (Claude Code has two extra lines to say)<!-- /no-dbt -->.
2. Save the modelling approach, when one was agreed (step 3).
3. Write the files following `references/building-the-model.md` — "Which files to write", "Where
   a new model file goes", "layers.json", "Quote every text value" and "Diagram file" — in the
   format from step 1 (`erd.storage`; a new project is DBML).<!-- dbt-only --> Without dbt:<!-- /dbt-only --><!-- no-dbt --> Then:<!-- /no-dbt -->
   - **Layer**: the one the user named, else the one their existing diagrams use, else `gold` for
     a reporting design and `silver` for anything else. A new project writes `.erd-studio/layers.json`
     first (building-the-model.md, "layers.json"). Tell them layers are only folders for organising diagrams.
   - **Diagram file**: in DBML, `.erd-studio/<layer>/diagrams/<name>.dbml` with one `use` line per
     table and its `Project` last, and no `erd_layout`, so the canvas arranges it the first
     time it opens; in a YAML project, `.erd-studio/<layer>/<name>.json` listing the tables, with
     no `modelFolder`<!-- dbt-only --> (that is dbt's folder filter)<!-- /dbt-only --> and `"viewConfig": {}`.
   - **Relationships** go in the table library: in DBML, a Ref line in the relationships file
     that already holds the foreign-key table's Refs, else `<layer>/relationships/<schema>.dbml`
     when that file already exists, else `<layer>/relationships/<layer>.dbml`; in YAML, in the table file holding the foreign key —
     unless the project's existing diagrams keep theirs in the diagram file
     (building-the-model.md, "Where they go").
   - A table that already has a file is **referenced by name, never rewritten**.
4. Keep a list of every file you wrote, and tell the user in one line ("Wrote 6 table files and
   the `sales` diagram"), not file by file.

## 5. Check the files

Say "Checking the files ERD Studio will read," then run doctor (as in step 1). Fix each
`fix-model-yaml`, `fix-dbml-file` and `fix-fields-file` it lists (the file and line, usually a value to quote) — except a merge conflict — and
each `fix-subject-area-naming`, and offer `turn-round-relationships` fixes. Then check the
diagram loads end to end: say "Checking the whole diagram loads," and run
`~/.erd-studio-cli/bin/erd-studio export --domain .erd-studio/<layer>/diagrams/<name>.dbml --format dbml --semantic-dir .erd-studio`
(the `.json` file in a YAML project).
Exit 3 means the diagram file itself cannot be read: the message names the problem; fix it
and run it again. Exit 0 means the diagram file loaded — not yet that every table did. Read
the output (do not paste it) for lines starting `// Table … is not exported` (a table with no
file and a table with no columns both read "has no columns" — check which; a file that does not
parse names its line) and for `// Not exported:`
lines after the opening comments (a table or relationship ERD Studio could not write; the
header's own "Not exported: canvas positions and sizes…" line is always there and is fine). Fix
each and run it again; the check passes only when exit 0 comes with none of those lines.

Then your own silent cross-check, reporting only problems: every table in the diagram has a
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
    or any DBML tool) or Mermaid<!-- dbt-only -->;
  - the one dbt line, said once: "Using dbt? Open its folder to compare your design with what dbt
    built."<!-- /dbt-only --><!-- no-dbt -->.<!-- /no-dbt -->
