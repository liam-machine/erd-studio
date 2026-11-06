# Fields — the team's field list, and the metadata dbt records

This is the reference for fields: the facts a team records about each table and column — its
grain, purpose and decisions, and its own metadata, such as who owns a table, which system it
comes from, or whether a column holds personal data. `.erd-studio/fields.yml` lists them, in the
order the canvas shows them (the format: the schema skill's `DBML.md` → "fields.yml"). Each table
file holds only the values: in a `.dbml` table one `<key>: '<value>'` setting per field (anything
that is not text in one `meta_json`); a `.yml` table keeps them in its `rationale:` and `meta:`
maps. dbt keeps metadata under `meta:`. The canvas shows every field in the Detail panel, and the
metadata when you hover a table's name or a column.

The aim: propose **one** list — the starting set, fitted to the modelling style, plus the metadata
dbt already records — confirm it with one yes, save it as `.erd-studio/fields.yml`, and copy dbt's
values. The list is what makes every later AI edit, in any assistant, fill in the same fields the
same way.

## Contents
1. Explaining it
2. Detecting it — the inventory's `conventions.meta`
3. Offering the list
4. Saving it
5. Copying the values
6. When dbt records none
7. An old `## Metadata` list

---

## 1. Explaining it

The first time fields come up, define them in one line, in these words: "Fields are the facts
your team records about each table and column — its grain and purpose, who owns it, whether it
holds personal data." Never explain the YAML.

## 2. Detecting it — the inventory's `conventions.meta`

Every `inventory` run reports it project-wide (also under `--summary` and `--models`):

- `totalModels`, `modelsWithMeta` — how widespread it is;
- `models[]` / `columns[]` — one entry per key, most used first: `key`, `count` (models, or
  columns), `models` (column keys: how many models), `kind` (`text`, `yes-no`, `list`, `map`,
  `empty`) and up to three `examples`.

`inventory --models a,b` gives the values themselves: `models[].meta` and `columns[].meta`,
already merged the way dbt merges them (a `config: meta:` entry wins over a plain `meta:` one; a
schema `.yml` wins over the manifest, which also carries project-wide `+meta` from
`dbt_project.yml`). Never read dbt's files for them when the helper works; in canvas-fallback mode
read the model's schema `.yml` (`meta:` and `config: meta:`) and the `+meta` entries in
`dbt_project.yml`.

Choose the keys to offer:

- Every key of kind `text` or `yes-no`. A `list` or `map` key is not offered as a field: its
  values are copied only when the user asks, and the canvas shows them read-only.
- Whatever its kind, leave out a key that holds another tool's settings — Lightdash
  (`dimension`, `metrics`, `joins`), dbt-metabase (`metabase.*`) and the like — and name them in
  a few words so the user knows ("I'll leave out `dimension` and `metrics`, which are Lightdash
  settings"). Keys fields.yml lists under `left_out` (or an old list's "Left out" line) are never
  offered.
- More than eight keys: offer the eight most used and add "…and N more — say 'all' to include
  them".

## 3. Offering the list

**When.** After `inventory --models` for the chosen models (Stage 4 step 4, or enrich step 2)
and before you write any model file, on every route. Never earlier: the first diagram comes
first.

**What you propose:**

- **The built-ins.** On tables `grain`, `purpose`, `decisions` and `open_questions`; on columns
  `natural_key`. Plus the **dimensional** fields — `role`, `scd_strategy` (shown on dimensions),
  `measures` (on facts), and on columns `scd_type` and `additive_type` — for a Kimball-style
  approach, One Big Table or Activity Schema (their mappings use roles), and when no style is
  agreed yet (so nothing the canvas shows today disappears). For Data Vault or Inmon / 3NF, leave
  the dimensional fields out and say why in a few words ("table role and SCD type are Kimball's
  vocabulary, so I'll leave them out"); "keep them" puts them back. Never offer the optional
  built-ins (`source_of_truth`, `freshness`, `known_issues`, `retention`, `business_rule`)
  unprompted; add one when the user asks for what it records.
- **dbt's metadata.** Every key section 2 chose, as a field of the team's own with
  `filled_by: dbt`. A dbt key that is a built-in's name (`freshness`) is that built-in, listed
  with `filled_by: dbt`. A dbt key that is a reserved name (`role`, `grain`, `note`, …; the schema
  skill's `DBML.md` → "Setting names") cannot be a field: leave it off the list, and its value
  stays metadata of its own.
- **left_out**: the other tools' keys section 2 left out.

Then:

- **The project already has `.erd-studio/fields.yml`** → do not ask. Say in one line: "I'll fill
  in your team's fields as `.erd-studio/fields.yml` lists them, copying `owner` and `pii` from
  dbt." If dbt records an offerable key that is neither listed nor left out, add one Stage 6 next
  step: "dbt also records `sla_hours`. Add it to your fields?"
- **No fields.yml, but `.erd-studio/modelling-approach.md` has a `## Metadata` section** →
  section 7.
- **A quick start with no style, and none of the chosen models or their columns has `meta`** →
  say nothing and write no file: the starting set applies as it is.
- **Otherwise, when not enriching** → one message with the evidence, a plain definition and a yes
  default, alone:

  > "Your tables are named `dim_` and `fct_`, so I'll record the dimensional fields too. Each
  > table gets Grain, Purpose, Decisions and Open questions, plus Table role, History on
  > dimensions and Measures on facts. Your dbt models also record `owner` on 7 of 9 models and
  > `pii` on 3 columns, so I'll copy those as well. I'll save the list in
  > `.erd-studio/fields.yml` so every assistant fills in the same fields. Change any?"

  Use the real counts and at most three dbt names ("and 4 more"). With no metadata in dbt, drop
  that sentence; with no agreed style, say "Each table gets …" without the first sentence. Then:

  - **yes**, or no changes → save the list (section 4) and copy the values (section 5);
  - **changes** ("we don't use Open questions"; "add a sensitivity level: public, internal or
    confidential — we fill that in ourselves") → apply them (a fixed set of values is a
    `choice`; "we fill that in" is `filled_by: people`), say the result in one line ("Added
    Sensitivity as a dropdown with those three values, filled in by people only."), and save;
  - **no** → save and copy nothing; the starting set applies. Do not bring it up again this
    session.
- **When enriching**, send no separate offer: add each model's dbt values to its draft line
  ("owner: crm-team"), end the list with "and save the field list, with `owner` and `pii` from
  dbt, in `.erd-studio/fields.yml`", and ask the route's single "Add these?". "Not the fields"
  declines only that part.

**A style agreed later** (the Stage 6 style offer after a quick start): when the list you saved
has the dimensional fields and the style is Data Vault or Inmon / 3NF, offer once, in the
style's play-back, to take them out of fields.yml.

## 4. Saving it

Write `.erd-studio/fields.yml`, beside `layers.json`: the built-ins as bare names in the order
above, then the team's fields.

```yaml
version: 1
tables:
  - grain
  - purpose
  - decisions
  - open_questions
  - role
  - scd_strategy
  - measures
  - key: owner
    label: Owner
    type: value
    guidance: The team that owns it, e.g. crm-team.
    filled_by: dbt
  - key: source_system
    label: Source system
    type: value
    guidance: The system the data comes from, e.g. salesforce.
    filled_by: people
columns:
  - natural_key
  - scd_type
  - additive_type
  - key: pii
    label: Personal data
    type: yes-no
    filled_by: dbt
left_out: [dimension, metrics]       # Lightdash settings in dbt's meta
```

- **Which list** — `tables` for a key dbt has on models, `columns` for one on columns, both when
  dbt has it on both.
- **key** — the dbt key exactly (lower case letters, digits and `_`). **label** — the key in
  plain words. **guidance** — one sentence saying what to write, with one of the `examples`.
- **type** — `yes-no` for kind `yes-no`; `value` for one short value (a team, a system name);
  `text` for a sentence; `choice` with `values` only when the user names a fixed set
  ("`public`, `internal`, `confidential`").
- **filled_by** — `dbt` for every key detected in dbt: copied, typed in only when the user gives
  the value. `people` for a key people fill in (the user asked for it and dbt does not have it):
  an AI fills it only with a value the user gives. Leave it out (`anyone`) for a field you may
  draft.
- **left_out** — the keys you left out as another tool's settings, so no later run offers them
  again. Omit the line when there are none.

Then run `doctor`: a `fix-fields-file` step means the file has an error, and `erd.fields` names
its line — fix it before writing any table.

Tell the user in one line, naming every field of their own: "Saved your fields in
`.erd-studio/fields.yml`, with `owner` and `pii` copied from dbt — edit it any time, or open it
with **ERD Studio: Customise Fields…**; later AI edits follow it."

## 5. Copying the values

Take them from `inventory --models` for the models you are writing (`models[].meta`,
`columns[].meta`) — only the fields `filled_by: dbt` (with an old `## Metadata` list still in use,
its `dbt` keys), each on the model or column where dbt has it.

- **Exact values.** In a DBML table, a text value is one `<key>: '<text>'` setting named as the
  field (`owner: 'crm-team'`), and a yes-no field is `'true'` or `'false'` (`pii: 'true'`). Every
  other value (a number, a list, a map, or `true` / `false` for a key that is not a yes-no field)
  goes into the one `meta_json` setting as JSON (`meta_json: '{"tags":["finance"]}'`), merged
  with what is already there. In a YAML table the key goes in `meta:`: `true` / `false` stay
  unquoted and a list stays a list; numbers arrive as text (`"24"`); write them quoted or not —
  ERD Studio reads `24` and `"24"` the same — but keep the quotes when leaving them off would
  change the digits (`"1.10"`, `"007"`). Nothing is reworded, merged or summarised.
- **No value in dbt, no setting.** A key dbt has as empty (`null`) counts as no value. Never guess
  one and never write an empty placeholder.
- **Models written this session** get the values as you write them.
- **Models that already existed** are someone's design. When enriching, their values are part of
  the single "Add these?". In a quick start or a full setup they are only referenced (Stage 4),
  so leave them untouched and add one Stage 6 next step: "N of your existing models could also
  get dbt's metadata — want that?"
- **An old spelling** (`meta_owner`, an entry in `meta_json`) is the same field: change it where it
  is, never add a second copy.
- **Never remove** a setting a table file already has — even when dbt no longer records it, it is
  not on the list, or the user typed the value in. Mention a value dbt no longer has in one line.
- **Fields people fill in** (`filled_by: people`): leave them to people. After writing, say in one
  line which models still lack them, and that they can be filled in on the canvas's Detail panel
  or by telling you.
- **The diff ignores fields.** A clean `erd-studio diff` says nothing about them, so do not use
  the diff to check them — re-read the model files you wrote instead, silently.

## 6. When dbt records none

Do not raise metadata during setup beyond section 3. In Stage 6 — only when dbt records none at
all (`conventions.meta.modelsWithMeta` is 0) — add one optional next step: "Want to record things
like an owner or source system on your tables? Tell me which, and I'll add them to your fields,
so every edit fills them in the same way." On a yes, ask which ("For example `owner`,
`source_system`, `pii`?"), add them to `.erd-studio/fields.yml` with `filled_by: people` (section
4; with no file yet, write the list section 3 proposes plus these), and fill in only values the
user gives you.

## 7. An old `## Metadata` list

A project set up before fields.yml may keep its list as a `## Metadata` table in
`.erd-studio/modelling-approach.md` (**Key**, **On**, **Values**, **Source**, and a "Left out:"
line). Until it moves, it names the team's fields: follow it as the schema skill's "Fields" says.

Offer once, in place of section 3's offer (when enriching, as part of the "Add these?"): "Your
team's metadata list in `modelling-approach.md` — `owner`, `pii` — can move into
`.erd-studio/fields.yml`, beside the fields every table records, so the canvas shows each one
with its label and the right box or dropdown. Move it?" On a yes, show the file you will write
(the list section 3 proposes, plus one entry per row: **Key** → `key`; **On** → `tables`,
`columns` or both; **Values** → a `choice`'s `values`, `yes-no` for `true` / `false`, otherwise a
`value` with the description as `guidance`; **Source** `dbt` → `filled_by: dbt`, `the team` →
`filled_by: people`; "Left out" → `left_out`), write it, and remove the `## Metadata` section
from `modelling-approach.md`, keeping the rest of that file as it is (when only its title is
left, delete the file too, and say so in the preview). On a no, keep following the old list and
do not ask again this session.
