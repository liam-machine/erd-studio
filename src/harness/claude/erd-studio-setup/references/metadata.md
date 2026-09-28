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
schema `.yml` wins over the manifest). Never read dbt's files for them when the helper works; in
canvas-fallback mode read the model's schema `.yml` (`meta:` and `config: meta:`) instead.

Choose the keys to offer:

- Every key of kind `text`, `yes-no` or `list`.
- A `map` key only when it reads as the team's own information (`lineage: {upstream: …}`). Leave
  out keys that hold another tool's settings — for example Lightdash's `dimension`, `metrics` and
  `joins` — and name them in a few words so the user knows ("I'll leave out `dimension` and
  `metrics`, which are Lightdash settings").
- More than eight keys: offer the eight most used and add "…and N more — say 'all' to include
  them".

## 3. Offering it

**When.** Just before you first write model files — Stage 4 of a quick start or a full setup, or
with the drafts when enriching. Never earlier: the first diagram comes first.

- **The saved file already has a `## Metadata` section** → do not ask. Say in one line: "I'll copy
  your team's metadata — `owner`, `pii` — as your saved list says." If dbt now records an
  offerable key that is not on the list, ask once, at the end: "dbt also records `sla_hours` now.
  Add it to your metadata list?"
- **`modelsWithMeta` is 0** → say nothing now (section 6).
- **Otherwise** → one sentence with the evidence and a yes default, alone in its message:

  > "Your dbt models also record some metadata — `owner` on 42 of 50 models, and `pii` on 18
  > columns. I'll copy it onto your diagram, where it shows when you hover a table or column, and
  > save these keys as your team's metadata list so later edits keep them the same. OK?"

  Use the real counts and at most three keys by name ("and 4 more"). Then:

  - **yes** → save the list (section 4) and copy the values (section 5);
  - **a subset** ("just owner") → the same, with only those keys;
  - **no** → copy and save nothing, and do not bring it up again this session.

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
```

- **On** — `models`, `columns`, or `models, columns` when dbt has it on both.
- **Values** — `true` / `false` for `yes-no`; for `text`, a short description with one of the
  `examples`; a fixed set only when the user names one ("`public`, `internal`, `confidential`").
- **Source** — `dbt` for every key detected in dbt: copied from dbt, never typed in. `the team`
  for a key people fill in (the user asked for it and dbt does not have it): an AI never fills it.

Tell the user in one line: "Saved your metadata list to `.erd-studio/modelling-approach.md` — edit
it any time; later AI edits follow it."

## 5. Copying the values

Take them from `inventory --models` for the models you are writing (`models[].meta`,
`columns[].meta`) — only the keys on the list whose source is `dbt`, each on the model or column
where dbt has it.

- **Exact values.** Copy the value as dbt has it: `true` stays unquoted, a list stays a list, a
  number stays as written. Nothing is reworded, merged or summarised.
- **No value in dbt, no key.** Never guess one and never write an empty placeholder.
- **Models written this session** get the values as you write them.
- **Models that already existed** are someone's design: list what would change in plain words
  ("add `owner` to 6 models, update `pii` on 1 column") and ask once, default yes — when
  enriching, as part of its single "Add these?".
- **Never remove** a key a model file already has, even when dbt no longer records it or it is
  not on the list. Mention a value that dbt no longer has in one line instead.
- **Keys the team fills in** (source `the team`): leave them to people. After writing, say in one
  line which models still have them empty, and that they can be filled in on the canvas's Detail
  panel or by telling you.
- **The diff ignores metadata.** A clean `erd-studio diff` says nothing about it, so do not use
  the diff to check it — re-read the model files you wrote instead, silently.

## 6. When dbt records none

Do not raise metadata during setup. In Stage 6, add one optional next step: "Want to record
things like an owner or source system on your tables? Tell me which, and I'll save them as your
team's metadata list, so every edit fills them in the same way." On a yes, ask which keys ("For
example `owner`, `source_system`, `pii`?"), save them with the source `the team` (section 4), and
fill in only values the user gives you.
