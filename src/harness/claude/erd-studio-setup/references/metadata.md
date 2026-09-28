# Metadata — carrying the team's `meta:` onto the diagram

This is the reference for metadata: the extra facts a team records about a table or a column,
such as who owns it, which system it comes from, or whether it holds personal data. dbt keeps them
under `meta:`; ERD Studio keeps them in the same shape in each logical model file, and shows them
in the Detail panel and when you hover a table's name or a column on the canvas.

The aim: detect what dbt already records, confirm it with **one** yes, save the agreed keys as the
team's **metadata list**, and copy the values. The list is what makes every later AI edit, in any
assistant, fill in the same keys the same way.

## Contents
1. Explaining it
2. Detecting it — the inventory's `conventions.meta`
3. Offering it
4. Saving the list
5. Copying the values
6. When dbt records none

---

## 1. Explaining it

The first time metadata comes up, define it in one line, in these words: "Metadata is the extra
facts your team records about a table or column — who owns it, where it comes from, whether it
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

- Every key of kind `text`, `yes-no` or `list`, and a `map` only when it reads as the team's own
  information (`lineage: {upstream: …}`).
- Whatever its kind, leave out a key that holds another tool's settings — Lightdash
  (`dimension`, `metrics`, `joins`), dbt-metabase (`metabase.*`) and the like — and name them in
  a few words so the user knows ("I'll leave out `dimension` and `metrics`, which are Lightdash
  settings"). Keys the saved list already leaves out (its "Left out" line) are never offered.
- More than eight keys: offer the eight most used and add "…and N more — say 'all' to include
  them".

## 3. Offering it

**When.** After `inventory --models` for the chosen models (Stage 4 step 4) and before you write
any model file, on every route, with or without a modelling style. Never earlier: the first
diagram comes first.

- **The saved file already has a `## Metadata` section** → do not ask. Say in one line: "I'll copy
  your team's metadata — `owner`, `pii` — where dbt has it." If dbt records an offerable key that
  is neither on the list nor left out, add one Stage 6 next step: "dbt also records `sla_hours`.
  Add it to your metadata list?"
- **None of the chosen models or their columns has `meta`** in `inventory --models` → say nothing
  now (section 6 covers a project with none at all).
- **Otherwise** → one sentence with the evidence for the chosen models, a plain definition and a
  yes default, alone in its message:

  > "Your dbt models also record some metadata — extra facts like who owns a table or whether a
  > column holds personal data: `owner` on 7 of your 9 models, and `pii` on 3 columns. I'll copy
  > it onto your diagram (hover a table or column to see it) and save these names as your team's
  > metadata list, so later edits fill them in the same way. OK?"

  Use the real counts and at most three names ("and 4 more"). Then:

  - **yes** → save the list (section 4) and copy the values (section 5);
  - **a subset** ("just owner") → the same, with only those keys;
  - **no** → copy and save nothing, and do not bring it up again this session.
- **When enriching**, send no separate offer: add each model's dbt values to its draft line
  ("owner: crm-team"), end the list with "and save `owner`, `pii` as your team's metadata list",
  and ask the route's single "Add these?". "Not the metadata" declines only that part.

## 4. Saving the list

Write it into `.erd-studio/modelling-approach.md` as a `## Metadata` section, after "How ERD
Studio records it" and before "Sources". With no saved file yet — a quick start agrees no style —
create the file with only a title and this section, and **no** "Technique" line: that is what
tells a later run the style is still to be agreed.

```markdown
# Modelling approach

## Metadata

The `meta:` keys this team records. AI edits use these names and fill a key only from its source.

| Key | On | Values | Source |
|---|---|---|---|
| `owner` | models | team name, e.g. `crm-team` | dbt |
| `pii` | columns | `true` / `false` | dbt |
| `source_system` | models | text | the team |

Left out: `dimension`, `metrics` (Lightdash settings).
```

- **On** — `models`, `columns`, or `models, columns` when dbt has it on both.
- **Values** — `true` / `false` for `yes-no`; for `text`, a short description with one of the
  `examples`; a fixed set only when the user names one ("`public`, `internal`, `confidential`").
- **Source** — `dbt` for every key detected in dbt: copied from dbt, never typed in. `the team`
  for a key people fill in (the user asked for it and dbt does not have it): an AI fills it only
  with a value the user gives.
- **Left out** — one line naming the keys you left out as another tool's settings, so no later
  run offers them again. Omit the line when there are none.

Tell the user in one line, naming every saved key: "Saved `owner` and `pii` as your metadata list
in `.erd-studio/modelling-approach.md` — edit it any time; later AI edits follow it."

## 5. Copying the values

Take them from `inventory --models` for the models you are writing (`models[].meta`,
`columns[].meta`) — only the keys on the list whose source is `dbt`, each on the model or column
where dbt has it.

- **Exact values.** `true` / `false` stay unquoted and a list stays a list. Numbers arrive as
  text (`"24"`); write them either way — ERD Studio reads `24` and `"24"` the same. Nothing is
  reworded, merged or summarised.
- **No value in dbt, no key.** A key dbt has as empty (`null`) counts as no value. Never guess one
  and never write an empty placeholder.
- **Models written this session** get the values as you write them.
- **Models that already existed** are someone's design. When enriching, their values are part of
  the single "Add these?". In a quick start or a full setup they are only referenced (Stage 4),
  so leave them untouched and add one Stage 6 next step: "N of your existing models could also
  get dbt's metadata — want that?"
- **Never remove** a key a model file already has — even when dbt no longer records it, it is not
  on the list, or the user typed the value in. Mention a value dbt no longer has in one line.
- **Keys the team fills in** (source `the team`): leave them to people. After writing, say in one
  line which models still lack them, and that they can be filled in on the canvas's Detail panel
  or by telling you.
- **The diff ignores metadata.** A clean `erd-studio diff` says nothing about it, so do not use
  the diff to check it — re-read the model files you wrote instead, silently.

## 6. When dbt records none

Do not raise metadata during setup. In Stage 6 — only when dbt records none at all
(`conventions.meta.modelsWithMeta` is 0) and there is no saved list — add one optional next step:
"Want to record things like an owner or source system on your tables? Tell me which, and I'll save
them as your team's metadata list, so every edit fills them in the same way." On a yes, ask which
keys ("For example `owner`, `source_system`, `pii`?"), save them with the source `the team`
(section 4), and fill in only values the user gives you.
